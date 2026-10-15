import { fromBase64, importAesKey, unseal } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { blobRefs, isBlobRef, newBlob, openBlob, sealBlob } from '../../src/sync/blob-envelope.js';
import { newRecordId } from '../../src/sync/collections.js';
import { toArrayBuffer } from '../../src/sync/encoding.js';
import { UnreadableRecordError } from '../../src/sync/errors.js';

const NOTES = '7f3a9c21';
const LISTS = '2d81ff04';

function bytes(text: string): Uint8Array
{
    return new TextEncoder().encode(text);
}

describe('newBlob', () => {
    it('seals as the contract defines: an IV, then AES-GCM under the blob DEK with the blob\'s AAD', async () => {
        const recordId = newRecordId();
        const { ref, sealed } = await newBlob(NOTES, recordId, bytes('a photo'));

        const aad = bytes(`conseal-sync:v1:${NOTES}:${recordId}:${ref.id}`);
        const dek = await importAesKey(toArrayBuffer(fromBase64(ref.dek)));
        const plaintext = await unseal(dek, toArrayBuffer(sealed.subarray(12)), sealed.slice(0, 12), aad);

        expect(new TextDecoder().decode(plaintext)).toBe('a photo');
        expect(sealed.byteLength).toBe(12 + 'a photo'.length + 16);
        expect(ref.size).toBe('a photo'.length);
    });

    it('gives each blob a fresh id and DEK', async () => {
        const recordId = newRecordId();
        const [a, b] = await Promise.all([newBlob(NOTES, recordId, bytes('same')), newBlob(NOTES, recordId, bytes('same'))]);

        expect(a.ref.id).not.toBe(b.ref.id);
        expect(a.ref.dek).not.toBe(b.ref.dek);
        expect(isBlobRef(a.ref)).toBe(true);
    });
});

describe('openBlob', () => {
    it('opens what newBlob sealed, and a blob sealed again under the same reference', async () => {
        const recordId = newRecordId();
        const { ref, sealed } = await newBlob(NOTES, recordId, bytes('a photo'));
        const again = await sealBlob(NOTES, recordId, ref, bytes('a photo'));

        expect(await openBlob(NOTES, recordId, ref, sealed)).toEqual(bytes('a photo'));
        expect(await openBlob(NOTES, recordId, ref, again)).toEqual(bytes('a photo'));
    });

    it('refuses a blob moved to another record, collection or blob id', async () => {
        const recordId = newRecordId();
        const { ref, sealed } = await newBlob(NOTES, recordId, bytes('a photo'));

        await expect(openBlob(NOTES, newRecordId(), ref, sealed)).rejects.toThrow(UnreadableRecordError);
        await expect(openBlob(LISTS, recordId, ref, sealed)).rejects.toThrow(UnreadableRecordError);
        await expect(openBlob(NOTES, recordId, { ...ref, id: newRecordId() }, sealed)).rejects.toThrow(UnreadableRecordError);
    });

    it('refuses a changed byte, another blob\'s DEK, a size its reference doesn\'t give, or a stub', async () => {
        const recordId = newRecordId();
        const { ref, sealed } = await newBlob(NOTES, recordId, bytes('a photo'));
        const other = await newBlob(NOTES, recordId, bytes('another'));
        const changed = sealed.slice();
        changed[20] = (changed[20] as number) ^ 1;

        await expect(openBlob(NOTES, recordId, ref, changed)).rejects.toThrow(UnreadableRecordError);
        await expect(openBlob(NOTES, recordId, { ...ref, dek: other.ref.dek }, sealed)).rejects.toThrow(UnreadableRecordError);
        await expect(openBlob(NOTES, recordId, { ...ref, size: ref.size + 1 }, sealed)).rejects.toThrow(UnreadableRecordError);
        await expect(openBlob(NOTES, recordId, ref, sealed.slice(0, 20))).rejects.toThrow(UnreadableRecordError);
    });
});

describe('blobRefs', () => {
    it('finds each reference once, at any depth and among the app\'s own fields', async () => {
        const recordId = newRecordId();
        const { ref: photo } = await newBlob(NOTES, recordId, bytes('a photo'));
        const { ref: scan } = await newBlob(NOTES, recordId, bytes('a scan'));
        const value = {
            title: 'receipts',
            cover: photo,
            attachments: { value: [{ ...photo, name: 'photo.jpg' }, { ...scan, name: 'scan.pdf', type: 'application/pdf' }] },
        };

        expect(blobRefs(value)).toEqual([photo, scan]);
    });

    it('passes over what only looks like a reference', async () => {
        const { ref } = await newBlob(NOTES, newRecordId(), bytes('a photo'));

        expect(blobRefs({
            upper: { ...ref, id: ref.id.toUpperCase() },
            shortKey: { ...ref, dek: ref.dek.slice(4) },
            negative: { ...ref, size: -1 },
            noSize: { id: ref.id, dek: ref.dek },
            text: JSON.stringify(ref),
        })).toEqual([]);
    });
});
