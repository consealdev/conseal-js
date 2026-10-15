import { digest, fromBase64, importPublicKeyFromJwk, sealMessage, toBase64, unsealMessage } from '../core/index.js';
import { decodeSealed, encodeSealed, toArrayBuffer, type EncodedSealed } from './encoding.js';
import { UnverifiedKeyError, WrongPassphraseError } from './errors.js';

const CHECK_VERSION = 2;
const ITERATIONS = 200_000;
const SALT_BYTES = 16;

interface PassphraseCheck
{
    v: number;
    salt: string;
    hash: string;
    /** SHA-256 of the sealed AEK's IV and ciphertext: the one key this check vouches for. */
    sealedAek: string;
}

/**
 * Seals a check of the approving device's passphrase for the joining device, so the joining device can tell its
 * user to use the same passphrase, and can tell the AEK came from a device that knows it. The check is a salted
 * PBKDF2 hash and a digest of the sealed AEK it travels with, sealed to the joining device's ephemeral join key: the
 * server relays ciphertext, never holds anything it could guess the passphrase against, and can't make a check that
 * passes without the passphrase, or move a real one to a key of its own.
 */
export async function sealPassphraseCheck(
    passphrase: string,
    sealedAek: EncodedSealed,
    joinerPublicKey: JsonWebKey,
): Promise<EncodedSealed>
{
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const check: PassphraseCheck = {
        v: CHECK_VERSION,
        salt: toBase64(salt),
        hash: toBase64(await derive(passphrase, salt)),
        sealedAek: await sealedAekDigest(sealedAek),
    };
    const recipient = await importPublicKeyFromJwk(joinerPublicKey, 'ECDH');
    const plaintext = toArrayBuffer(new TextEncoder().encode(JSON.stringify(check)));
    return encodeSealed(await sealMessage(recipient, plaintext));
}

/**
 * Checks a join's approval on the joining device before it takes the AEK. Throws `UnverifiedKeyError` when the check
 * is missing, doesn't open, or vouches for another sealed AEK, and `WrongPassphraseError` when `passphrase` isn't the
 * approving device's.
 */
export async function verifyApproval(
    sealedCheck: EncodedSealed | undefined,
    sealedAek: EncodedSealed,
    ephemeralPrivateKey: CryptoKey,
    passphrase: string,
): Promise<void>
{
    if (!sealedCheck)
    {
        throw new UnverifiedKeyError('The approval came without a passphrase check, so its key can\'t be trusted.');
    }
    const check = await openCheck(sealedCheck, ephemeralPrivateKey);
    if (!check || check.sealedAek !== await sealedAekDigest(sealedAek))
    {
        throw new UnverifiedKeyError('The approval\'s passphrase check doesn\'t vouch for its key, so the key can\'t be trusted.');
    }
    if (toBase64(await derive(passphrase, fromBase64(check.salt))) !== check.hash)
    {
        throw new WrongPassphraseError('Use the same passphrase as on your other devices.');
    }
}

/** The check, or undefined when it doesn't open with this key or isn't a check this version reads. */
async function openCheck(sealed: EncodedSealed, ephemeralPrivateKey: CryptoKey): Promise<PassphraseCheck | undefined>
{
    try
    {
        const { ciphertext, iv, ephemeralPublicKey } = decodeSealed(sealed);
        const plaintext = await unsealMessage(ephemeralPrivateKey, ciphertext, iv, ephemeralPublicKey);
        const check = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<PassphraseCheck>;
        const valid = check.v === CHECK_VERSION
            && typeof check.salt === 'string'
            && typeof check.hash === 'string'
            && typeof check.sealedAek === 'string';
        return valid ? check as PassphraseCheck : undefined;
    }
    catch
    {
        return undefined;
    }
}

async function sealedAekDigest(sealedAek: EncodedSealed): Promise<string>
{
    const { ciphertext, iv } = decodeSealed(sealedAek);
    const bytes = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    bytes.set(iv, 0);
    bytes.set(new Uint8Array(ciphertext), iv.byteLength);
    return toBase64(await digest(bytes));
}

async function derive(passphrase: string, salt: Uint8Array): Promise<ArrayBuffer>
{
    const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        'PBKDF2',
        false,
        ['deriveBits'],
    );
    return crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS },
        material,
        256,
    );
}
