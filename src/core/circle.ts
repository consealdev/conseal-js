// SPDX-License-Identifier: AGPL-3.0-or-later OR Commercial
// Copyright (c) 2026 Codesense

/**
 * conseal/circle — Multi-device private communication.
 *
 * Establishes a bounded group of trusted devices that all hold the same
 * Account Encryption Key (AEK). Encrypted data written on any device can be
 * decrypted on any other device in the circle.
 *
 * Four exported functions cover the full device-registration ceremony:
 *
 *   initCircle()        — founding device derives the shared AEK from the mnemonic
 *   createJoinRequest() — new device takes the commitment and generates an ephemeral ECDH key pair
 *   authorizeJoin()     — trusted device seals the AEK for the new device
 *   finalizeJoin()      — new device unseals and re-wraps the AEK
 *
 * Both devices show a verification code that covers the AEK commitment and the
 * new device's ephemeral public key (deriveVerificationCode). The new device
 * takes the commitment from the backend before its key pair exists, and the
 * trusted device uses its own, so a key or a commitment substituted on the way
 * changes one of the codes, and comparing them catches it.
 *
 * secretKey (Uint8Array) is required for all four functions — passphrase-only
 * wrapping does not meet the security bar for multi-device sync. Each device
 * must hold a Secret Key via one of the three SK strategies (OS keychain,
 * IndexedDB non-extractable, or WebAuthn PRF).
 *
 * Composes: aes.ts, pbkdf2.ts, ecdh.ts, jwk.ts, digest.ts
 * No custom cryptography — correct composition of audited primitives only.
 */

import { importAesKey } from './aes.js';
import { wrapKey, unwrapKey } from './pbkdf2.js';
import { generateECDHKeyPair, sealMessage, unsealMessage } from './ecdh.js';
import { importPublicKeyFromJwk, exportPublicKeyAsJwk } from './jwk.js';
import { digest } from './digest.js';
import { recoverWithMnemonic } from './mnemonic.js';
import { buffersEqual } from './compare.js';

/** Maximum age of a join request before it is considered stale (5 minutes). */
export const JOIN_TTL_MS = 5 * 60 * 1000;

const CODE_BYTES = 10; // 80 bits, 16 base32 characters
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O or U
const CODE_LABEL = 'conseal-circle-join:v1';
const COMMITMENT_LENGTH = 32;

// ---------- Types ----------

/** Wrapped AEK — opaque blob stored server-side per device. */
export interface WrappedAEK
{
    wrappedKey: ArrayBuffer;
    salt: Uint8Array;
}

/** Serializable join request payload sent by a new device to the backend. */
export interface JoinRequest
{
    deviceId: string;
    ephemeralPublicKey: JsonWebKey;
    /**
     * ISO 8601 timestamp set by the joining device, for display only. The device
     * can forge it, so `authorizeJoin` doesn't read it: it checks freshness
     * against `serverReceivedAt`, the time the backend first received the request.
     */
    createdAt: string;
    deviceMeta?: { name?: string; platform?: string };
}

/** AEK sealed for a specific device's ephemeral public key via ECDH. */
export interface SealedAEK
{
    ciphertext: ArrayBuffer;
    iv: Uint8Array;
    ephemeralPublicKey: JsonWebKey; // sealMessage's ephemeral key — not the joining device's
}

// ---------- Exported helpers ----------

/**
 * Derives a join's human-readable verification code from the circle's AEK
 * commitment and the new device's ephemeral public key JWK.
 *
 * SHA-256 hashes a label, the 32-byte commitment and the key's uncompressed
 * point (65 bytes for P-256), and formats the first 80 bits as 16 Crockford
 * base32 characters in groups of four: e.g. "7KQ2-M9XD-4RTF-B8NW". Every field
 * has a fixed length, so the input splits only one way.
 *
 * The new device gets its code from createJoinRequest, which covers the
 * commitment it took. The authorizing device calls this with the request's
 * key and its own commitment: the one initCircle returned, or the one its own
 * join or recovery checked, never one the server supplies with the request.
 * The user confirms the codes match out-of-band before approval proceeds.
 *
 * The codes then match only when both devices hold the same commitment and
 * key. A server that relays the join can put a key pair of its own in place of
 * the new device's, or give the new device the commitment of a key of its own,
 * and either changes one device's code. It needs a match by chance: about 2^80
 * tries. That is out of reach within the 5-minute TTL, and so is a table built
 * in advance for an account's commitment. At 32 bits, one GPU finds a match in
 * under a minute.
 */
export async function deriveVerificationCode(
    ephemeralPublicKey: JsonWebKey,
    aekCommitment: ArrayBuffer | Uint8Array
): Promise<string>
{
    requireCommitment('deriveVerificationCode', aekCommitment);
    const label = new TextEncoder().encode(CODE_LABEL);
    const point = new Uint8Array(await exportRawPublicKey(ephemeralPublicKey));
    const input = new Uint8Array(label.byteLength + COMMITMENT_LENGTH + point.byteLength);
    input.set(label, 0);
    input.set(new Uint8Array(aekCommitment), label.byteLength);
    input.set(point, label.byteLength + COMMITMENT_LENGTH);
    return formatVerificationCode(await digest(input));
}

/** Exports an ECDH public key JWK as its uncompressed point bytes (65 bytes for P-256). */
export async function exportRawPublicKey(publicKey: JsonWebKey): Promise<ArrayBuffer>
{
    const key = await importPublicKeyFromJwk(publicKey, 'ECDH');
    return crypto.subtle.exportKey('raw', key);
}

/** Formats the first 80 bits of a hash as Crockford base32 in four groups of four: "7KQ2-M9XD-4RTF-B8NW". */
export function formatVerificationCode(hash: ArrayBuffer): string
{
    let chars = '';
    let value = 0;
    let bits = 0;
    for (const byte of new Uint8Array(hash, 0, CODE_BYTES))
    {
        value = ((value << 8) | byte) & 0xfff; // at most 4 bits carry over, plus this byte
        bits += 8;
        while (bits >= 5)
        {
            bits -= 5;
            chars += CODE_ALPHABET.charAt((value >> bits) & 31);
        }
    }
    return [0, 4, 8, 12].map(start => chars.slice(start, start + 4)).join('-');
}

// ---------- Ceremony API ----------

/**
 * Called once by the founding device when creating a new account.
 *
 * Derives the shared AEK from the mnemonic (so it can always be recovered),
 * publishes its SHA-256 commitment (so joining devices can verify the AEK was
 * not substituted), and wraps the AEK under the founding device's own
 * passphrase + secretKey.
 *
 * The mnemonic is the root of trust — it must be shown to the user at account
 * creation and never stored. The app stores wrappedAEK and aekCommitment on
 * the server.
 */
export async function initCircle(
    mnemonic: string,
    passphrase: string,
    secretKey: Uint8Array
): Promise<{ wrappedAEK: WrappedAEK; aekCommitment: ArrayBuffer; deviceId: string }>
{
    const aek = await recoverWithMnemonic(mnemonic, true); // extractable: true — must be wrappable
    const rawAEK = await crypto.subtle.exportKey('raw', aek);
    // Raw AEK bytes live briefly in memory here; JavaScript provides no reliable
    // way to zero them, but they are consumed immediately by digest() and wrapKey().
    const aekCommitment = await digest(rawAEK);
    const { wrappedKey, salt } = await wrapKey(passphrase, aek, secretKey);
    const deviceId = crypto.randomUUID();
    return { wrappedAEK: { wrappedKey, salt }, aekCommitment, deviceId };
}

/**
 * Called by a new device that wants to join the circle.
 *
 * Takes the circle's aekCommitment, from the backend, then generates an
 * ephemeral ECDH P-256 key pair for the one-time ceremony. The order matters:
 * the commitment is fixed before the key pair exists, so whoever supplied it
 * can't choose it after seeing the key. Hold the ephemeral private key in
 * memory only — never persisted — and the commitment with it, until
 * finalizeJoin completes.
 *
 * The verification code covers the commitment and the ephemeral public key.
 * Display it prominently: the user must confirm it matches the code on the
 * authorizing device before finalizing.
 */
export async function createJoinRequest(
    aekCommitment: ArrayBuffer | Uint8Array,
    deviceMeta?: { name?: string; platform?: string }
): Promise<{
    request: JoinRequest;
    ephemeralPrivateKey: CryptoKey;
    verificationCode: string;
}>
{
    requireCommitment('createJoinRequest', aekCommitment);
    const { publicKey, privateKey } = await generateECDHKeyPair();
    const ephemeralPublicKey = await exportPublicKeyAsJwk(publicKey);
    const verificationCode = await deriveVerificationCode(ephemeralPublicKey, aekCommitment);
    const deviceId = crypto.randomUUID();
    const request: JoinRequest = {
        deviceId,
        ephemeralPublicKey,
        createdAt: new Date().toISOString(),
        ...(deviceMeta ? { deviceMeta } : {}),
    };
    return { request, ephemeralPrivateKey: privateKey, verificationCode };
}

/**
 * Called by a trusted device to approve a new device joining the circle.
 *
 * Rejects stale join requests based on `serverReceivedAt` — the Unix-ms
 * timestamp recorded by the server when the join request first arrived.
 * Callers MUST pass the server-stamped time, not `joinRequest.createdAt`,
 * which is set by the joining device and can be forged.
 *
 * The caller must present the verification code from
 * joinRequest.ephemeralPublicKey and this device's own aekCommitment (see
 * deriveVerificationCode) and require explicit user confirmation that it
 * matches the code on the new device before calling this function — calling
 * without confirmation bypasses the primary MITM defence.
 *
 * Unwraps the AEK and seals its raw bytes for the new device's ephemeral
 * public key via ECDH. Only the ephemeral private key held by the new device
 * can open it.
 *
 * @param serverReceivedAt  Unix milliseconds — when the server first received
 *   this join request. Use `Date.now()` at receipt time on the server, NOT
 *   `new Date(joinRequest.createdAt).getTime()`. Passing the client-supplied
 *   timestamp defeats TTL enforcement.
 */
export async function authorizeJoin(
    joinRequest: JoinRequest,
    wrappedAEK: WrappedAEK,
    passphrase: string,
    secretKey: Uint8Array,
    serverReceivedAt: number
): Promise<SealedAEK>
{
    const age = Date.now() - serverReceivedAt;
    if (age > JOIN_TTL_MS)
    {
        throw new Error('authorizeJoin: join request has expired (older than 5 minutes)');
    }

    // Unwrap extractable so raw bytes can be transferred via ECDH
    const aek = await unwrapKey(passphrase, wrappedAEK.wrappedKey, wrappedAEK.salt, secretKey, true);
    const rawAEK = await crypto.subtle.exportKey('raw', aek);
    // Raw AEK bytes live briefly in memory here; JavaScript provides no reliable
    // way to zero them, but they are consumed immediately by sealMessage() and never returned.

    const recipientPublicKey = await importPublicKeyFromJwk(joinRequest.ephemeralPublicKey, 'ECDH');
    const { ciphertext, iv, ephemeralPublicKey } = await sealMessage(recipientPublicKey, rawAEK);
    return { ciphertext, iv, ephemeralPublicKey };
}

/**
 * Called by the new device after authorization.
 *
 * Unseals the AEK using the ephemeral private key generated in
 * createJoinRequest, verifies it against aekCommitment (SHA-256 of the raw
 * AEK published by initCircle), then re-wraps it under the new device's own
 * passphrase + secretKey. Pass the commitment the request was created with:
 * the verification code covers that one, so once the user has confirmed the
 * codes match, it is the authorizing device's. The ephemeral private key is
 * not needed after this call and should be discarded.
 *
 * Throws if the commitment check fails — the AEK was substituted or tampered
 * with in transit. Do not use the returned wrappedAEK if this throws.
 */
export async function finalizeJoin(
    sealedAEK: SealedAEK,
    ephemeralPrivateKey: CryptoKey,
    passphrase: string,
    secretKey: Uint8Array,
    aekCommitment: ArrayBuffer
): Promise<{ wrappedAEK: WrappedAEK }>
{
    const rawAEK = await unsealMessage(
        ephemeralPrivateKey,
        sealedAEK.ciphertext,
        sealedAEK.iv,
        sealedAEK.ephemeralPublicKey
    );
    // Raw AEK bytes live briefly in memory here; JavaScript provides no reliable
    // way to zero them, but they are consumed immediately by digest() and importAesKey().

    const actualCommitment = await digest(rawAEK);
    if (!buffersEqual(new Uint8Array(actualCommitment), new Uint8Array(aekCommitment)))
    {
        throw new Error('finalizeJoin: AEK commitment mismatch — key may have been tampered with');
    }

    const aek = await importAesKey(rawAEK, true); // extractable: true for wrapKey
    const { wrappedKey, salt } = await wrapKey(passphrase, aek, secretKey);
    return { wrappedAEK: { wrappedKey, salt } };
}

// ---------- Internal ----------

function requireCommitment(caller: string, aekCommitment: ArrayBuffer | Uint8Array): void
{
    if (aekCommitment.byteLength !== COMMITMENT_LENGTH)
    {
        throw new TypeError(`${caller}: aekCommitment must be ${COMMITMENT_LENGTH} bytes (SHA-256), got ${aekCommitment.byteLength}`);
    }
}
