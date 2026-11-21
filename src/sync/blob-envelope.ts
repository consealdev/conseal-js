// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { fromBase64, generateAesKey, importAesKey, seal, toBase64, unseal } from '../core/index.js';
import { isRecordId, newRecordId } from './collections.js';
import { toArrayBuffer } from './encoding.js';
import { UnreadableRecordError } from './errors.js';
import { isPlainObject } from './values.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const DEK_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

const ENCODER = new TextEncoder();

/**
 * A blob as its record refers to it. The app puts it in the record's value, alone or with fields of its own such as a
 * file name, and the blob's DEK travels sealed inside the record, the only place it's kept.
 */
export interface BlobRef
{
    /** The blob's id: a random lowercase UUID, like a record id. */
    id: string;
    /** The blob's DEK, standard base64 of its 32 bytes. */
    dek: string;
    /** The blob's length in bytes, before sealing. */
    size: number;
}

/** The AAD that binds a sealed blob to its collection, record and id. */
export function blobAad(collectionId: string, recordId: string, blobId: string): Uint8Array
{
    return ENCODER.encode(`conseal-sync:v1:${collectionId}:${recordId}:${blobId}`);
}

/** Seals bytes as a new blob of a record, under a fresh DEK. Returns the record's reference and the sealed blob. */
export async function newBlob(collectionId: string, recordId: string, bytes: Uint8Array): Promise<{ ref: BlobRef; sealed: Uint8Array }>
{
    const dek = await generateAesKey(true);
    const ref: BlobRef = {
        id: newRecordId(),
        dek: toBase64(await crypto.subtle.exportKey('raw', dek)),
        size: bytes.byteLength,
    };
    return { ref, sealed: await sealBlob(collectionId, recordId, ref, bytes) };
}

/**
 * Seals a blob's bytes under the DEK its reference carries, as the contract defines it: a random 12-byte IV followed by
 * AES-GCM of the bytes with the blob's AAD, the tag appended.
 */
export async function sealBlob(collectionId: string, recordId: string, ref: BlobRef, bytes: Uint8Array): Promise<Uint8Array>
{
    const { ciphertext, iv } = await seal(await importDek(ref), toArrayBuffer(bytes), blobAad(collectionId, recordId, ref.id));
    const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
    sealed.set(iv, 0);
    sealed.set(new Uint8Array(ciphertext), IV_BYTES);
    return sealed;
}

/**
 * Opens a blob sealed by `sealBlob`, or by any client that follows the contract.
 *
 * @throws UnreadableRecordError when the blob was altered, was moved from another record, collection or blob id, or
 * doesn't match its reference.
 */
export async function openBlob(collectionId: string, recordId: string, ref: BlobRef, sealed: Uint8Array): Promise<Uint8Array>
{
    let bytes: Uint8Array;
    try
    {
        if (sealed.byteLength < IV_BYTES + TAG_BYTES) throw new UnreadableRecordError(`Blob ${ref.id} is shorter than an IV and a tag.`);
        bytes = new Uint8Array(await unseal(
            await importDek(ref),
            toArrayBuffer(sealed.subarray(IV_BYTES)),
            sealed.slice(0, IV_BYTES),
            blobAad(collectionId, recordId, ref.id),
        ));
    }
    catch (error)
    {
        if (error instanceof UnreadableRecordError) throw error;
        throw new UnreadableRecordError(`Blob ${ref.id} of record ${recordId} doesn't open under its DEK and AAD.`, { cause: error });
    }
    if (bytes.byteLength !== ref.size)
    {
        throw new UnreadableRecordError(`Blob ${ref.id} holds ${bytes.byteLength} bytes, and its reference says ${ref.size}.`);
    }
    return bytes;
}

/** Whether a value is a blob reference: an id, a DEK and a size, alone or among other fields. */
export function isBlobRef(value: unknown): value is BlobRef
{
    if (!isPlainObject(value)) return false;
    const { id, dek, size } = value as Partial<Record<keyof BlobRef, unknown>>;
    return typeof id === 'string' && isRecordId(id)
        && typeof dek === 'string' && DEK_BASE64.test(dek)
        && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0;
}

/** Every blob reference in a record's value, at any depth, once each. */
export function blobRefs(value: unknown): BlobRef[]
{
    const found = new Map<string, BlobRef>();
    const visit = (node: unknown): void =>
    {
        if (isBlobRef(node))
        {
            if (!found.has(node.id)) found.set(node.id, { id: node.id, dek: node.dek, size: node.size });
            return;
        }
        if (Array.isArray(node)) node.forEach(visit);
        else if (isPlainObject(node)) Object.values(node).forEach(visit);
    };
    visit(value);
    return [...found.values()];
}

async function importDek(ref: BlobRef): Promise<CryptoKey>
{
    const raw = fromBase64(ref.dek);
    if (raw.byteLength !== DEK_BYTES) throw new UnreadableRecordError(`Blob ${ref.id}'s DEK isn't ${DEK_BYTES} bytes.`);
    return importAesKey(toArrayBuffer(raw));
}
