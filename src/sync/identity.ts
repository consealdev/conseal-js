// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { generateECDHKeyPair, generateECDSAKeyPair, importPublicKeyFromJwk } from '../core/index.js';
import { KeyringError } from './errors.js';
import { isPlainObject } from './values.js';

/**
 * The collection the contract reserves for the user's identity, and the engine's own: it holds one record, the
 * keyring, which carries the identity's key pairs to every device in the circle. It is both the collection's name on
 * the device and its id on the wire, so no app collection may use it as either.
 */
export const KEYRING_COLLECTION = 'keyring';

/** The keyring's fixed id: two devices that create it at once write the same record, so one push conflicts. */
export const KEYRING_RECORD_ID = '00000000-0000-4000-8000-000000000000';

export const KEYRING_SCHEMA_VERSION = 1;

/** The user's identity: the same key pairs on every device in their circle. The private keys can't be exported. */
export interface Identity
{
    /** Messages to the user are sealed to `publicKey` with conseal's `sealMessage`, and opened with `unsealMessage`. */
    ecdh: CryptoKeyPair;
    /** Signs as the user with conseal's `sign`; `publicKey` checks a signature with `verify`. */
    ecdsa: CryptoKeyPair;
}

/** The keyring record's value: each key pair as its private JWK, which carries the public key too. */
export interface KeyringValue
{
    ecdh: JsonWebKey;
    ecdsa: JsonWebKey;
}

/** A new identity, as the keyring record's value. */
export async function newKeyring(): Promise<KeyringValue>
{
    const [ecdh, ecdsa] = await Promise.all([generateECDHKeyPair(), generateECDSAKeyPair()]);
    return { ecdh: await privateJwk(ecdh.privateKey), ecdsa: await privateJwk(ecdsa.privateKey) };
}

/**
 * The identity a keyring record's value holds.
 *
 * @throws KeyringError when the value doesn't hold a P-256 key pair for each.
 */
export async function openKeyring(value: object): Promise<Identity>
{
    const { ecdh, ecdsa } = value as Partial<KeyringValue>;
    try
    {
        return { ecdh: await keyPair(ecdh, 'ECDH', ['deriveKey']), ecdsa: await keyPair(ecdsa, 'ECDSA', ['sign']) };
    }
    catch (error)
    {
        throw new KeyringError('The keyring doesn\'t hold the identity\'s key pairs.', { cause: error });
    }
}

/** A private key as the contract's JWK: the curve, the public point and the private scalar, nothing else. */
async function privateJwk(key: CryptoKey): Promise<JsonWebKey>
{
    const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', key);
    return { kty, crv, x, y, d };
}

async function keyPair(jwk: JsonWebKey | undefined, algorithm: 'ECDH' | 'ECDSA', usages: KeyUsage[]): Promise<CryptoKeyPair>
{
    if (!isPlainObject(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string')
    {
        throw new TypeError(`The keyring's ${algorithm} key isn't a P-256 private key.`);
    }
    const { kty, crv, x, y, d } = jwk;
    return {
        privateKey: await crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, { name: algorithm, namedCurve: 'P-256' }, false, usages),
        publicKey: await importPublicKeyFromJwk({ kty, crv, x, y }, algorithm),
    };
}
