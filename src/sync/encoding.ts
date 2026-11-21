// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { fromBase64, toBase64, type SealedAEK, type WrappedAEK } from '../core/index.js';

/** A wrapped AEK in a form JSON can carry. Both fields are standard base64. */
export interface EncodedWrappedAek
{
    wrappedKey: string;
    salt: string;
}

/** A payload sealed to an ECDH public key, in a form JSON can carry. Binary fields are standard base64. */
export interface EncodedSealed
{
    ciphertext: string;
    iv: string;
    ephemeralPublicKey: JsonWebKey;
}

export function encodeWrappedAek(wrapped: WrappedAEK): EncodedWrappedAek
{
    return { wrappedKey: toBase64(wrapped.wrappedKey), salt: toBase64(wrapped.salt) };
}

export function decodeWrappedAek(encoded: EncodedWrappedAek): WrappedAEK
{
    return { wrappedKey: toArrayBuffer(fromBase64(encoded.wrappedKey)), salt: fromBase64(encoded.salt) };
}

export function encodeSealed(sealed: SealedAEK): EncodedSealed
{
    return {
        ciphertext: toBase64(sealed.ciphertext),
        iv: toBase64(sealed.iv),
        ephemeralPublicKey: sealed.ephemeralPublicKey,
    };
}

export function decodeSealed(encoded: EncodedSealed): SealedAEK
{
    return {
        ciphertext: toArrayBuffer(fromBase64(encoded.ciphertext)),
        iv: fromBase64(encoded.iv),
        ephemeralPublicKey: encoded.ephemeralPublicKey,
    };
}

/** Copies a view's bytes into an ArrayBuffer of exactly their length, which is what SubtleCrypto takes. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer
{
    return bytes.slice().buffer as ArrayBuffer;
}
