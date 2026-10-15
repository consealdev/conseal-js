import { fromBase64, generateAesKey, toBase64 } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { UnreadableRecordError } from '../../src/sync/errors.js';
import { openRecord, sealRecord } from '../../src/sync/record-envelope.js';

const COLLECTION = '7f3a9c21';
const RECORD = '3b2f6c1e-8d4a-4f0b-9c7e-5a1d2e3f4b6c';
const OTHER_RECORD = '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a';

describe('record envelope', () => {
    it('opens what it seals', async () => {
        const aek = await generateAesKey(false);
        const { sealed } = await sealRecord(aek, COLLECTION, RECORD, { title: 'groceries', schemaVersion: 1 });

        expect(await openRecord(aek, COLLECTION, RECORD, sealed)).toEqual({ title: 'groceries', schemaVersion: 1 });
    });

    it('wraps the DEK in 60 bytes and seals the record with a 12-byte IV', async () => {
        const aek = await generateAesKey(false);
        const { sealed, ciphertextBytes } = await sealRecord(aek, COLLECTION, RECORD, { title: 'groceries' });

        expect(fromBase64(sealed.wrappedDek)).toHaveLength(60);
        expect(fromBase64(sealed.iv)).toHaveLength(12);
        expect(fromBase64(sealed.ciphertext)).toHaveLength(ciphertextBytes);
    });

    it('opens a record sealed by hand to the contract', async () => {
        // The contract's envelope, built from WebCrypto alone, so a client in another language can follow it.
        const aek = await generateAesKey(false);
        const aad = new TextEncoder().encode(`conseal-sync:v1:${COLLECTION}:${RECORD}`);
        const rawDek = crypto.getRandomValues(new Uint8Array(32));
        const dek = await crypto.subtle.importKey('raw', rawDek, 'AES-GCM', false, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode('{"title":"groceries","schemaVersion":1}');
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, plaintext);
        const dekIv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dekIv, additionalData: aad }, aek, rawDek);
        const wrappedDek = new Uint8Array([...dekIv, ...new Uint8Array(wrapped)]);

        const opened = await openRecord(aek, COLLECTION, RECORD, {
            ciphertext: toBase64(ciphertext),
            iv: toBase64(iv),
            wrappedDek: toBase64(wrappedDek),
        });

        expect(opened).toEqual({ title: 'groceries', schemaVersion: 1 });
    });

    it.each([
        ['another record', COLLECTION, OTHER_RECORD],
        ['another collection', 'b4e70118', RECORD],
    ])('refuses a record moved to %s', async (_, collectionId, recordId) => {
        const aek = await generateAesKey(false);
        const { sealed } = await sealRecord(aek, COLLECTION, RECORD, { title: 'groceries' });

        await expect(openRecord(aek, collectionId, recordId, sealed)).rejects.toThrow(UnreadableRecordError);
    });

    it('refuses a record sealed under another AEK', async () => {
        const { sealed } = await sealRecord(await generateAesKey(false), COLLECTION, RECORD, { title: 'groceries' });

        await expect(openRecord(await generateAesKey(false), COLLECTION, RECORD, sealed)).rejects.toThrow(UnreadableRecordError);
    });

    it('refuses a record whose ciphertext was altered', async () => {
        const aek = await generateAesKey(false);
        const { sealed } = await sealRecord(aek, COLLECTION, RECORD, { title: 'groceries' });
        const bytes = fromBase64(sealed.ciphertext);
        bytes[0] = (bytes[0] ?? 0) ^ 1;

        await expect(openRecord(aek, COLLECTION, RECORD, { ...sealed, ciphertext: toBase64(bytes) }))
            .rejects.toThrow(UnreadableRecordError);
    });
});
