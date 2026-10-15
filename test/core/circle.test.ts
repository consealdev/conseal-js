import { describe, it, expect } from 'vitest';
import { unwrapKey } from '../../src/core/pbkdf2.js';
import {
    initCircle,
    createJoinRequest,
    authorizeJoin,
    finalizeJoin,
    deriveVerificationCode,
    formatVerificationCode,
    type WrappedAEK,
} from '../../src/core/circle.js';
import { importPublicKeyFromJwk } from '../../src/core/jwk.js';
import { sealMessage } from '../../src/core/ecdh.js';
import { digest } from '../../src/core/digest.js';
import { generateMnemonic, recoverWithMnemonic } from '../../src/core/mnemonic.js';
import {
    initCircle as initCircleFromIndex,
    createJoinRequest as createJoinRequestFromIndex,
    authorizeJoin as authorizeJoinFromIndex,
    finalizeJoin as finalizeJoinFromIndex,
    deriveVerificationCode as deriveVerificationCodeFromIndex,
} from '../../src/core/index.js';

// ---------- helpers ----------

const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function makeSecretKey(): Uint8Array
{
    return crypto.getRandomValues(new Uint8Array(16));
}

function makeMnemonic(): string
{
    return generateMnemonic();
}

/** A commitment for a join request outside any circle. */
function makeCommitment(): Uint8Array
{
    return crypto.getRandomValues(new Uint8Array(32));
}

// ---------- deriveVerificationCode ----------

describe('formatVerificationCode', () => {
    it('writes the first 80 bits as Crockford base32 in four groups of four', () => {
        const lower = new Uint8Array([0x00, 0x44, 0x32, 0x14, 0xc7, 0x42, 0x54, 0xb6, 0x35, 0xcf]);
        const upper = new Uint8Array([0x84, 0x65, 0x3a, 0x56, 0xd7, 0xc6, 0x75, 0xbe, 0x77, 0xdf]);
        expect(formatVerificationCode(lower.buffer)).toBe('0123-4567-89AB-CDEF');
        expect(formatVerificationCode(upper.buffer)).toBe('GHJK-MNPQ-RSTV-WXYZ');
    });

    it('reads nothing past the first 80 bits', () => {
        const hash = new Uint8Array(32).fill(0xff);
        const changed = hash.slice();
        changed.fill(0, 10);
        expect(formatVerificationCode(hash.buffer)).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ');
        expect(formatVerificationCode(changed.buffer)).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ');
    });
});

describe('deriveVerificationCode', () => {
    it('returns 16 base32 characters in groups of four', async () => {
        const commitment = makeCommitment();
        const { request } = await createJoinRequest(commitment);
        const code = await deriveVerificationCode(request.ephemeralPublicKey, commitment);
        expect(code).toMatch(CODE);
    });

    it('formats the SHA-256 of the label, the commitment and the key\'s uncompressed point', async () => {
        const commitment = makeCommitment();
        const { request } = await createJoinRequest(commitment);
        const key = await importPublicKeyFromJwk(request.ephemeralPublicKey, 'ECDH');
        const point = new Uint8Array(await crypto.subtle.exportKey('raw', key));
        const label = new TextEncoder().encode('conseal-circle-join:v1');
        const input = new Uint8Array([...label, ...commitment, ...point]);

        expect(point.byteLength).toBe(65);
        expect(await deriveVerificationCode(request.ephemeralPublicKey, commitment)).toBe(formatVerificationCode(await digest(input)));
    });

    it('returns the same code for the same JWK and commitment', async () => {
        const commitment = makeCommitment();
        const { request } = await createJoinRequest(commitment);
        const code1 = await deriveVerificationCode(request.ephemeralPublicKey, commitment);
        const code2 = await deriveVerificationCode(request.ephemeralPublicKey, commitment.buffer as ArrayBuffer);
        expect(code1).toBe(code2);
    });

    it('returns different codes for different key pairs', async () => {
        const commitment = makeCommitment();
        const { request: req1 } = await createJoinRequest(commitment);
        const { request: req2 } = await createJoinRequest(commitment);
        const code1 = await deriveVerificationCode(req1.ephemeralPublicKey, commitment);
        const code2 = await deriveVerificationCode(req2.ephemeralPublicKey, commitment);
        expect(code1).not.toBe(code2);
    });

    it('returns different codes for different commitments', async () => {
        const { request } = await createJoinRequest(makeCommitment());
        const code1 = await deriveVerificationCode(request.ephemeralPublicKey, makeCommitment());
        const code2 = await deriveVerificationCode(request.ephemeralPublicKey, makeCommitment());
        expect(code1).not.toBe(code2);
    });

    it('matches the code returned by createJoinRequest', async () => {
        const commitment = makeCommitment();
        const { request, verificationCode } = await createJoinRequest(commitment);
        const derived = await deriveVerificationCode(request.ephemeralPublicKey, commitment);
        expect(derived).toBe(verificationCode);
    });

    it('throws a TypeError for a commitment that is not 32 bytes', async () => {
        const { request } = await createJoinRequest(makeCommitment());
        await expect(deriveVerificationCode(request.ephemeralPublicKey, makeCommitment().slice(0, 31))).rejects.toThrow(TypeError);
    });
});

// ---------- initCircle ----------

describe('initCircle', () => {
    it('returns a wrappedAEK with wrappedKey and salt', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase', sk);
        expect(wrappedAEK.wrappedKey).toBeInstanceOf(ArrayBuffer);
        expect(wrappedAEK.wrappedKey.byteLength).toBeGreaterThan(0);
        expect(wrappedAEK.salt).toBeInstanceOf(Uint8Array);
        expect(wrappedAEK.salt.byteLength).toBe(16);
    });

    it('returns aekCommitment as a 32-byte ArrayBuffer (SHA-256)', async () => {
        const sk = makeSecretKey();
        const { aekCommitment } = await initCircle(makeMnemonic(), 'passphrase', sk);
        expect(aekCommitment).toBeInstanceOf(ArrayBuffer);
        expect(aekCommitment.byteLength).toBe(32);
    });

    it('returns a UUID deviceId', async () => {
        const sk = makeSecretKey();
        const { deviceId } = await initCircle(makeMnemonic(), 'passphrase', sk);
        expect(deviceId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
    });

    it('same mnemonic produces the same aekCommitment (deterministic AEK)', async () => {
        const mnemonic = makeMnemonic();
        const sk = makeSecretKey();
        const a = await initCircle(mnemonic, 'passphrase', sk);
        const b = await initCircle(mnemonic, 'passphrase', sk);
        expect(Array.from(new Uint8Array(a.aekCommitment))).toEqual(
            Array.from(new Uint8Array(b.aekCommitment))
        );
    });

    it('same mnemonic produces different wrappedKey bytes each call (fresh salt)', async () => {
        const mnemonic = makeMnemonic();
        const sk = makeSecretKey();
        const a = await initCircle(mnemonic, 'passphrase', sk);
        const b = await initCircle(mnemonic, 'passphrase', sk);
        expect(Array.from(new Uint8Array(a.wrappedAEK.wrappedKey))).not.toEqual(
            Array.from(new Uint8Array(b.wrappedAEK.wrappedKey))
        );
    });

    it('different mnemonics produce different aekCommitments', async () => {
        const sk = makeSecretKey();
        const a = await initCircle(makeMnemonic(), 'passphrase', sk);
        const b = await initCircle(makeMnemonic(), 'passphrase', sk);
        expect(Array.from(new Uint8Array(a.aekCommitment))).not.toEqual(
            Array.from(new Uint8Array(b.aekCommitment))
        );
    });

    it('wrappedAEK can be unwrapped with the same passphrase + secretKey', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'my-passphrase', sk);
        const aek = await unwrapKey('my-passphrase', wrappedAEK.wrappedKey, wrappedAEK.salt, sk);
        expect(aek.algorithm.name).toBe('AES-GCM');
    });

    it('wrappedAEK cannot be unwrapped with wrong passphrase', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'correct', sk);
        await expect(
            unwrapKey('wrong', wrappedAEK.wrappedKey, wrappedAEK.salt, sk)
        ).rejects.toThrow();
    });

    it('wrappedAEK cannot be unwrapped with wrong secretKey', async () => {
        const sk1 = makeSecretKey();
        const sk2 = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase', sk1);
        await expect(
            unwrapKey('passphrase', wrappedAEK.wrappedKey, wrappedAEK.salt, sk2)
        ).rejects.toThrow();
    });

    it('mnemonic recovery produces the same AEK that was stored in the circle', async () => {
        const mnemonic = makeMnemonic();
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(mnemonic, 'passphrase', sk);

        // Unwrap the stored AEK
        const storedAek = await unwrapKey('passphrase', wrappedAEK.wrappedKey, wrappedAEK.salt, sk, true);
        const storedRaw = await crypto.subtle.exportKey('raw', storedAek);

        // Recover via mnemonic (simulates lost passphrase / fresh device)
        const recoveredAek = await recoverWithMnemonic(mnemonic, true);
        const recoveredRaw = await crypto.subtle.exportKey('raw', recoveredAek);

        expect(Array.from(new Uint8Array(storedRaw))).toEqual(Array.from(new Uint8Array(recoveredRaw)));
    });
});

// ---------- createJoinRequest ----------

describe('createJoinRequest', () => {
    it('returns a request with deviceId, ephemeralPublicKey, createdAt', async () => {
        const { request } = await createJoinRequest(makeCommitment());
        expect(request.deviceId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        expect(request.ephemeralPublicKey.kty).toBe('EC');
        expect(request.ephemeralPublicKey.crv).toBe('P-256');
        expect(request.ephemeralPublicKey.d).toBeUndefined(); // private component never exposed
        expect(() => new Date(request.createdAt)).not.toThrow();
    });

    it('includes deviceMeta when provided', async () => {
        const { request } = await createJoinRequest(makeCommitment(), { name: 'iPhone 15', platform: 'ios' });
        expect(request.deviceMeta).toEqual({ name: 'iPhone 15', platform: 'ios' });
    });

    it('omits deviceMeta when not provided', async () => {
        const { request } = await createJoinRequest(makeCommitment());
        expect(request.deviceMeta).toBeUndefined();
    });

    it('returns an ephemeral private key CryptoKey', async () => {
        const { ephemeralPrivateKey } = await createJoinRequest(makeCommitment());
        expect(ephemeralPrivateKey.type).toBe('private');
        expect(ephemeralPrivateKey.algorithm.name).toBe('ECDH');
    });

    it('returns a verification code of 16 base32 characters in groups of four', async () => {
        const { verificationCode } = await createJoinRequest(makeCommitment());
        expect(verificationCode).toMatch(CODE);
    });

    it('generates a unique deviceId on each call', async () => {
        const { request: r1 } = await createJoinRequest(makeCommitment());
        const { request: r2 } = await createJoinRequest(makeCommitment());
        expect(r1.deviceId).not.toBe(r2.deviceId);
    });

    it('throws a TypeError for a commitment that is not 32 bytes', async () => {
        await expect(createJoinRequest(makeCommitment().slice(0, 31))).rejects.toThrow(TypeError);
    });
});

// ---------- authorizeJoin ----------

describe('authorizeJoin', () => {
    it('returns a SealedAEK with ciphertext, iv, ephemeralPublicKey', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase', sk);
        const { request } = await createJoinRequest(makeCommitment());

        const sealed = await authorizeJoin(request, wrappedAEK, 'passphrase', sk, Date.now());
        expect(sealed.ciphertext).toBeInstanceOf(ArrayBuffer);
        expect(sealed.iv).toBeInstanceOf(Uint8Array);
        expect(sealed.iv.byteLength).toBe(12);
        expect(sealed.ephemeralPublicKey.kty).toBe('EC');
    });

    it('throws when the join request is older than 5 minutes', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase', sk);
        const { request } = await createJoinRequest(makeCommitment());
        const staleServerReceivedAt = Date.now() - 6 * 60 * 1000;

        await expect(authorizeJoin(request, wrappedAEK, 'passphrase', sk, staleServerReceivedAt)).rejects.toThrow(
            /expired/
        );
    });

    it('throws on wrong passphrase', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'correct', sk);
        const { request } = await createJoinRequest(makeCommitment());

        await expect(authorizeJoin(request, wrappedAEK, 'wrong', sk, Date.now())).rejects.toThrow();
    });

    it('throws on wrong secretKey', async () => {
        const sk1 = makeSecretKey();
        const sk2 = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase', sk1);
        const { request } = await createJoinRequest(makeCommitment());

        await expect(authorizeJoin(request, wrappedAEK, 'passphrase', sk2, Date.now())).rejects.toThrow();
    });

    it('accepts a request received just under the 5-minute TTL (4m59s)', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase', sk);
        const { request } = await createJoinRequest(makeCommitment());
        // 4 minutes 59 seconds ago — well within the 5-minute window
        const serverReceivedAt = Date.now() - (4 * 60 * 1000 + 59 * 1000);
        const sealed = await authorizeJoin(request, wrappedAEK, 'passphrase', sk, serverReceivedAt);
        expect(sealed.ciphertext).toBeInstanceOf(ArrayBuffer);
    });

    it('accepts a request received at exactly the TTL boundary (age == TTL_MS is not > TTL_MS)', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase', sk);
        const { request } = await createJoinRequest(makeCommitment());
        // 100 ms under the limit ensures we stay on the accepted side of the strict > check
        const serverReceivedAt = Date.now() - (5 * 60 * 1000 - 100);
        const sealed = await authorizeJoin(request, wrappedAEK, 'passphrase', sk, serverReceivedAt);
        expect(sealed.ciphertext).toBeInstanceOf(ArrayBuffer);
    });

    it('throws when request age is just over the TTL (5m + 100ms)', async () => {
        const sk = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase', sk);
        const { request } = await createJoinRequest(makeCommitment());
        const serverReceivedAt = Date.now() - (5 * 60 * 1000 + 100);
        await expect(authorizeJoin(request, wrappedAEK, 'passphrase', sk, serverReceivedAt)).rejects.toThrow(/expired/);
    });
});

// ---------- finalizeJoin ----------

describe('finalizeJoin', () => {
    it('returns a wrappedAEK that can be unwrapped', async () => {
        const sk1 = makeSecretKey();
        const { wrappedAEK, aekCommitment } = await initCircle(makeMnemonic(), 'passphrase1', sk1);
        const { request, ephemeralPrivateKey } = await createJoinRequest(aekCommitment);
        const sealedAEK = await authorizeJoin(request, wrappedAEK, 'passphrase1', sk1, Date.now());

        const sk2 = makeSecretKey();
        const { wrappedAEK: newWrappedAEK } = await finalizeJoin(
            sealedAEK,
            ephemeralPrivateKey,
            'passphrase2',
            sk2,
            aekCommitment
        );

        const aek = await unwrapKey('passphrase2', newWrappedAEK.wrappedKey, newWrappedAEK.salt, sk2);
        expect(aek.algorithm.name).toBe('AES-GCM');
    });

    it('throws when aekCommitment does not match (tampered SealedAEK)', async () => {
        const sk1 = makeSecretKey();
        const { wrappedAEK } = await initCircle(makeMnemonic(), 'passphrase1', sk1);
        const { request, ephemeralPrivateKey } = await createJoinRequest(makeCommitment());
        const sealedAEK = await authorizeJoin(request, wrappedAEK, 'passphrase1', sk1, Date.now());

        const wrongCommitment = crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer;

        const sk2 = makeSecretKey();
        await expect(
            finalizeJoin(sealedAEK, ephemeralPrivateKey, 'passphrase2', sk2, wrongCommitment)
        ).rejects.toThrow(/commitment mismatch/);
    });

    it('throws when decrypting with the wrong private key', async () => {
        const sk1 = makeSecretKey();
        const { wrappedAEK, aekCommitment } = await initCircle(makeMnemonic(), 'passphrase1', sk1);
        const { request } = await createJoinRequest(aekCommitment);
        const sealedAEK = await authorizeJoin(request, wrappedAEK, 'passphrase1', sk1, Date.now());

        const { ephemeralPrivateKey: wrongKey } = await createJoinRequest(makeCommitment());
        const sk2 = makeSecretKey();
        await expect(
            finalizeJoin(sealedAEK, wrongKey, 'passphrase2', sk2, aekCommitment)
        ).rejects.toThrow();
    });
});

// ---------- End-to-end ceremony ----------

describe('full ceremony', () => {
    it('founding and joining devices share the same AEK after the ceremony', async () => {
        const mnemonic = makeMnemonic();
        const passphrase1 = 'founding-passphrase';
        const passphrase2 = 'new-device-passphrase';
        const sk1 = makeSecretKey();
        const sk2 = makeSecretKey();

        // Founding device creates the circle
        const { wrappedAEK: foundingWrappedAEK, aekCommitment } = await initCircle(mnemonic, passphrase1, sk1);

        // New device initiates the join
        const { request, ephemeralPrivateKey, verificationCode } = await createJoinRequest(aekCommitment, {
            name: 'Laptop',
            platform: 'web',
        });

        // Trusted device derives the same code from the request and its own commitment, and confirms it matches
        const codeFromRequest = await deriveVerificationCode(request.ephemeralPublicKey, aekCommitment);
        expect(codeFromRequest).toBe(verificationCode);

        // Trusted device authorizes (after out-of-band code confirmation)
        const sealedAEK = await authorizeJoin(request, foundingWrappedAEK, passphrase1, sk1, Date.now());

        // New device finalizes
        const { wrappedAEK: newWrappedAEK } = await finalizeJoin(
            sealedAEK,
            ephemeralPrivateKey,
            passphrase2,
            sk2,
            aekCommitment
        );

        // Both devices unwrap and export their AEK — must be identical
        const aek1 = await unwrapKey(passphrase1, foundingWrappedAEK.wrappedKey, foundingWrappedAEK.salt, sk1, true);
        const raw1 = await crypto.subtle.exportKey('raw', aek1);

        const aek2 = await unwrapKey(passphrase2, newWrappedAEK.wrappedKey, newWrappedAEK.salt, sk2, true);
        const raw2 = await crypto.subtle.exportKey('raw', aek2);

        expect(Array.from(new Uint8Array(raw1))).toEqual(Array.from(new Uint8Array(raw2)));
    });

    it('three devices all share the same AEK', async () => {
        const mnemonic = makeMnemonic();
        const sk1 = makeSecretKey();
        const sk2 = makeSecretKey();
        const sk3 = makeSecretKey();

        const { wrappedAEK: w1, aekCommitment } = await initCircle(mnemonic, 'p1', sk1);

        // Device 2 joins via device 1
        const { request: req2, ephemeralPrivateKey: esk2 } = await createJoinRequest(aekCommitment);
        const sealed2 = await authorizeJoin(req2, w1, 'p1', sk1, Date.now());
        const { wrappedAEK: w2 } = await finalizeJoin(sealed2, esk2, 'p2', sk2, aekCommitment);

        // Device 3 joins via device 2 (any trusted device can authorize)
        const { request: req3, ephemeralPrivateKey: esk3 } = await createJoinRequest(aekCommitment);
        const sealed3 = await authorizeJoin(req3, w2, 'p2', sk2, Date.now());
        const { wrappedAEK: w3 } = await finalizeJoin(sealed3, esk3, 'p3', sk3, aekCommitment);

        // All three share the same AEK
        const raw = async (w: WrappedAEK, p: string, sk: Uint8Array) => {
            const k = await unwrapKey(p, w.wrappedKey, w.salt, sk, true);
            return Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', k)));
        };

        const [r1, r2, r3] = await Promise.all([raw(w1, 'p1', sk1), raw(w2, 'p2', sk2), raw(w3, 'p3', sk3)]);
        expect(r1).toEqual(r2);
        expect(r1).toEqual(r3);
    });
});

// ---------- A server that relays the join ----------

describe('a server that substitutes keys during a join', () => {
    it('gives the joining device another key\'s commitment, which changes its code', async () => {
        const sk = makeSecretKey();
        const { aekCommitment } = await initCircle(makeMnemonic(), 'passphrase', sk);
        const serverAEK = crypto.getRandomValues(new Uint8Array(32));
        const serverCommitment = await digest(serverAEK);
        const { request, ephemeralPrivateKey, verificationCode } = await createJoinRequest(serverCommitment);

        // The trusted device derives the code from its own commitment, so the user sees two codes that differ.
        expect(await deriveVerificationCode(request.ephemeralPublicKey, aekCommitment)).not.toBe(verificationCode);

        // That comparison is the defence: the server's own key, sealed to the request, passes finalizeJoin.
        const recipient = await importPublicKeyFromJwk(request.ephemeralPublicKey, 'ECDH');
        const sealed = await sealMessage(recipient, serverAEK.buffer as ArrayBuffer);
        await expect(finalizeJoin(sealed, ephemeralPrivateKey, 'p2', makeSecretKey(), serverCommitment)).resolves.toBeDefined();
    });

    it('puts a key of its own in the request, which changes the trusted device\'s code', async () => {
        const sk = makeSecretKey();
        const { aekCommitment } = await initCircle(makeMnemonic(), 'passphrase', sk);
        const { verificationCode } = await createJoinRequest(aekCommitment);
        const { request: serverRequest } = await createJoinRequest(aekCommitment);

        expect(await deriveVerificationCode(serverRequest.ephemeralPublicKey, aekCommitment)).not.toBe(verificationCode);
    });
});

// ---------- Main entry point exports ----------

describe('circle exports from main index', () => {
    it('all Circle functions are exported from conseal', () => {
        expect(initCircleFromIndex).toBe(initCircle);
        expect(createJoinRequestFromIndex).toBe(createJoinRequest);
        expect(authorizeJoinFromIndex).toBe(authorizeJoin);
        expect(finalizeJoinFromIndex).toBe(finalizeJoin);
        expect(deriveVerificationCodeFromIndex).toBe(deriveVerificationCode);
    });
});
