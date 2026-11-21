// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { fromBase64, generateAesKey, importAesKey, seal, toBase64, unseal } from '../core/index.js';
import { toArrayBuffer } from './encoding.js';
import { UnreadableRecordError } from './errors.js';

const IV_BYTES = 12;
/** A 12-byte IV, the 32-byte DEK and the 16-byte tag. */
const WRAPPED_DEK_BYTES = 60;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

/** A record sealed for the wire: the contract's three envelope fields, base64. */
export interface SealedRecord
{
    ciphertext: string;
    iv: string;
    wrappedDek: string;
}

/** The AAD that binds a sealed record to its collection and id. */
export function recordAad(collectionId: string, recordId: string): Uint8Array
{
    return ENCODER.encode(`conseal-sync:v1:${collectionId}:${recordId}`);
}

/**
 * Seals a record's plaintext as the contract defines it: under a fresh DEK, with the DEK sealed under the AEK, both
 * with the record's AAD. Returns the envelope and the ciphertext's length in bytes, which the server's
 * `maxRecordBytes` limits.
 */
export async function sealRecord(
    aek: CryptoKey,
    collectionId: string,
    recordId: string,
    plaintext: object,
): Promise<{ sealed: SealedRecord; ciphertextBytes: number }>
{
    const aad = recordAad(collectionId, recordId);
    const dek = await generateAesKey(true);
    const body = await seal(dek, toArrayBuffer(ENCODER.encode(JSON.stringify(plaintext))), aad);
    const wrapped = await seal(aek, await crypto.subtle.exportKey('raw', dek), aad);

    const wrappedDek = new Uint8Array(IV_BYTES + wrapped.ciphertext.byteLength);
    wrappedDek.set(wrapped.iv, 0);
    wrappedDek.set(new Uint8Array(wrapped.ciphertext), IV_BYTES);

    return {
        sealed: { ciphertext: toBase64(body.ciphertext), iv: toBase64(body.iv), wrappedDek: toBase64(wrappedDek) },
        ciphertextBytes: body.ciphertext.byteLength,
    };
}

/**
 * Opens a record sealed by `sealRecord`, or by any client that follows the contract.
 *
 * @throws UnreadableRecordError when the envelope is malformed, was altered, belongs to another record or
 * collection, was sealed under another AEK, or doesn't hold a JSON object.
 */
export async function openRecord(
    aek: CryptoKey,
    collectionId: string,
    recordId: string,
    sealed: SealedRecord,
): Promise<Record<string, unknown>>
{
    const aad = recordAad(collectionId, recordId);
    let plaintext: string;
    try
    {
        const iv = fromBase64(sealed.iv);
        const wrappedDek = fromBase64(sealed.wrappedDek);
        if (iv.length !== IV_BYTES || wrappedDek.length !== WRAPPED_DEK_BYTES)
        {
            throw new UnreadableRecordError(`Record ${recordId} has an IV or wrapped DEK of the wrong length.`);
        }

        const rawDek = await unseal(aek, toArrayBuffer(wrappedDek.subarray(IV_BYTES)), wrappedDek.slice(0, IV_BYTES), aad);
        const dek = await importAesKey(rawDek);
        plaintext = DECODER.decode(await unseal(dek, toArrayBuffer(fromBase64(sealed.ciphertext)), iv, aad));
    }
    catch (error)
    {
        if (error instanceof UnreadableRecordError) throw error;
        // Bad base64, a failed tag check or invalid UTF-8: whichever it is, the record can't be trusted.
        throw new UnreadableRecordError(`Record ${recordId} doesn't open under this AEK and its AAD.`, { cause: error });
    }

    let value: unknown;
    try
    {
        value = JSON.parse(plaintext);
    }
    catch (error)
    {
        throw new UnreadableRecordError(`Record ${recordId} doesn't hold JSON.`, { cause: error });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
    {
        throw new UnreadableRecordError(`Record ${recordId} doesn't hold a JSON object.`);
    }
    return value as Record<string, unknown>;
}
