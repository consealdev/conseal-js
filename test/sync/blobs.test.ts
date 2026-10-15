import { generateAesKey } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import type { BlobRef } from '../../src/sync/blob-envelope.js';
import { defineCollections, newRecordId } from '../../src/sync/collections.js';
import { BlobNotFoundError, InvalidRecordError, SyncConfigError, UnreadableRecordError } from '../../src/sync/errors.js';
import { MemoryRecordStore } from '../../src/sync/record-store.js';
import { SyncEngine, type SyncEvent } from '../../src/sync/sync-engine.js';
import type { SyncTransport } from '../../src/sync/sync-transport.js';
import { FakeSyncServer } from '../support/fake-sync-server.js';

interface Note
{
    title: string;
    attachments?: (BlobRef & { name: string })[];
}

interface List
{
    name: string;
    cover?: BlobRef;
}

type Collections = { notes: Note; lists: List };

const NOTES = '7f3a9c21';
const LISTS = '2d81ff04';

const collections = defineCollections<Collections>({
    notes: { id: NOTES, schemaVersion: 1 },
    lists: { id: LISTS, schemaVersion: 1 },
});

/** A transport the test can take offline, which logs each call, so the order of uploads and pushes shows. */
interface Link
{
    transport: SyncTransport;
    calls: string[];
    offline: boolean;
}

function link(server: FakeSyncServer): Link
{
    const inner = server.transport();
    const state: Link = { transport: inner, calls: [], offline: false };
    const call = async <T>(name: string, run: () => Promise<T>): Promise<T> =>
    {
        if (state.offline) throw new TypeError('Failed to fetch');
        state.calls.push(name);
        return run();
    };
    state.transport = {
        getConfig: () => call('getConfig', () => inner.getConfig()),
        pull: (collectionId, cursor, limit) => call(`pull ${collectionId}`, () => inner.pull(collectionId, cursor, limit)),
        push: (collectionId, items) => call(`push ${collectionId}`, () => inner.push(collectionId, items)),
        putBlob: (collectionId, recordId, blobId, sealed) => call(`putBlob ${blobId}`, () => inner.putBlob(collectionId, recordId, blobId, sealed)),
        getBlob: (collectionId, recordId, blobId) => call(`getBlob ${blobId}`, () => inner.getBlob(collectionId, recordId, blobId)),
        deleteBlob: (collectionId, recordId, blobId) => call(`deleteBlob ${blobId}`, () => inner.deleteBlob(collectionId, recordId, blobId)),
    };
    return state;
}

interface Account
{
    server: FakeSyncServer;
    aek: CryptoKey;
}

/** One user, whose server takes blobs of up to `maxBlobBytes` for notes, and none for lists. */
async function account(maxBlobBytes = 10_000): Promise<Account>
{
    return {
        server: new FakeSyncServer({ collections: [{ id: NOTES, maxBlobBytes }, { id: LISTS }] }),
        aek: await generateAesKey(false),
    };
}

function device({ server, aek }: Account, transport: SyncTransport = server.transport()): { engine: SyncEngine<Collections>; store: MemoryRecordStore }
{
    const store = new MemoryRecordStore();
    return { engine: new SyncEngine<Collections>({ collections, transport, store, keyring: { aek: async () => aek } }), store };
}

function bytes(text: string): Uint8Array
{
    return new TextEncoder().encode(text);
}

function eventsOf(engine: SyncEngine<Collections>): SyncEvent<Collections>[]
{
    const events: SyncEvent<Collections>[] = [];
    engine.subscribe(event => events.push(event));
    return events;
}

describe('blobs', () => {
    it('opens on another device a blob attached on one, and the server holds it only sealed', async () => {
        const a = await account();
        const { engine: phone } = device(a);
        const { engine: laptop } = device(a);
        const id = newRecordId();

        const ref = await phone.attachBlob('notes', id, bytes('a photo of the receipt'));
        await phone.save('notes', id, { title: 'receipts', attachments: [{ ...ref, name: 'receipt.jpg' }] });
        await phone.sync();
        await laptop.sync();

        const note = await laptop.get('notes', id);
        const attachment = note?.attachments?.[0] as BlobRef & { name: string };
        expect(new TextDecoder().decode(await laptop.openBlob('notes', id, attachment))).toBe('a photo of the receipt');
        const stored = a.server.blobs.get(`${NOTES}/${id}/${ref.id}`) as Uint8Array;
        expect(new TextDecoder('latin1').decode(stored)).not.toContain('receipt');
    });

    it('attaches offline: the blob opens at once, and uploads on the next sync before its record', async () => {
        const a = await account();
        const l = link(a.server);
        const { engine: phone, store } = device(a, l.transport);
        const id = newRecordId();
        l.offline = true;

        const ref = await phone.attachBlob('notes', id, bytes('drawn on a plane'));
        await phone.save('notes', id, { title: 'sketch', attachments: [{ ...ref, name: 'sketch.png' }] });
        const opened = await phone.openBlob('notes', id, ref);
        const offline = await phone.sync();

        expect(new TextDecoder().decode(opened)).toBe('drawn on a plane');
        expect(offline.failed.map(failure => failure.collection)).toEqual(['keyring', 'notes', 'lists']);
        expect(await store.pendingBlobs('notes')).toEqual([{ recordId: id, blobId: ref.id }]);

        l.offline = false;
        await phone.sync();

        expect(l.calls.indexOf(`putBlob ${ref.id}`)).toBeLessThan(l.calls.indexOf(`push ${NOTES}`));
        expect(await store.pendingBlobs('notes')).toEqual([]);
        const { engine: laptop } = device(a);
        await laptop.sync();
        expect(new TextDecoder().decode(await laptop.openBlob('notes', id, ref))).toBe('drawn on a plane');
    });

    it('pushes no record while a blob it may refer to fails to upload', async () => {
        const a = await account();
        const l = link(a.server);
        const { engine: phone } = device(a, l.transport);
        await phone.sync();
        const id = newRecordId();
        const ref = await phone.attachBlob('notes', id, bytes('a photo'));
        await phone.save('notes', id, { title: 'trip', attachments: [{ ...ref, name: 'photo.jpg' }] });
        const putBlob = l.transport.putBlob;
        l.transport.putBlob = async () => { throw new TypeError('Failed to fetch'); };

        const report = await phone.sync();

        expect(report.failed.map(failure => failure.collection)).toEqual(['notes']);
        expect(a.server.records.get(NOTES)?.has(id)).toBe(false);
        l.transport.putBlob = putBlob;
        await phone.sync();
        expect(a.server.records.get(NOTES)?.has(id)).toBe(true);
    });

    it('refuses to open a blob the server moved to another record or blob id', async () => {
        const a = await account();
        const { engine: phone } = device(a);
        const [first, second] = [newRecordId(), newRecordId()];
        const ref = await phone.attachBlob('notes', first, bytes('a photo'));
        await phone.save('notes', first, { title: 'first', attachments: [{ ...ref, name: 'photo.jpg' }] });
        await phone.save('notes', second, { title: 'second' });
        await phone.sync();
        const sealed = a.server.blobs.get(`${NOTES}/${first}/${ref.id}`) as Uint8Array;
        const otherId = newRecordId();
        a.server.blobs.set(`${NOTES}/${second}/${ref.id}`, sealed);
        a.server.blobs.set(`${NOTES}/${first}/${otherId}`, sealed);

        await expect(phone.openBlob('notes', second, ref)).rejects.toThrow(UnreadableRecordError);
        await expect(phone.openBlob('notes', first, { ...ref, id: otherId })).rejects.toThrow(UnreadableRecordError);
    });

    it('stops a record whose blob is over maxBlobBytes, drops the blob and reports it', async () => {
        const a = await account(100);
        const { engine: phone, store } = device(a);
        const events = eventsOf(phone);
        const id = newRecordId();
        const ref = await phone.attachBlob('notes', id, new Uint8Array(200));
        await phone.save('notes', id, { title: 'video', attachments: [{ ...ref, name: 'clip.mp4' }] });

        await phone.sync();

        expect(events).toEqual([{ type: 'rejected', collection: 'notes', id, code: 'blob_too_large' }]);
        expect((await store.get('notes', id))?.rejected).toBe('blob_too_large');
        expect(a.server.records.get(NOTES)?.has(id)).toBe(false);
        expect(a.server.blobs.size).toBe(0);
        expect(await store.pendingBlobs('notes')).toEqual([]);
    });

    it('refuses to attach once the server is known to refuse the blob', async () => {
        const a = await account(100);
        const { engine: phone } = device(a);
        await phone.sync();

        await expect(phone.attachBlob('notes', newRecordId(), new Uint8Array(200))).rejects.toThrow(InvalidRecordError);
        await expect(phone.attachBlob('lists', newRecordId(), bytes('a cover'))).rejects.toThrow(InvalidRecordError);
        await expect(phone.attachBlob('notes', 'not-an-id', bytes('a photo'))).rejects.toThrow(InvalidRecordError);
    });

    it('refuses ids and references that aren\'t the contract\'s, before any request', async () => {
        const a = await account();
        const l = link(a.server);
        const { engine: phone } = device(a, l.transport);
        const id = newRecordId();
        const ref = await phone.attachBlob('notes', id, bytes('a photo'));

        await expect(phone.detachBlob('notes', id, ref.id.toUpperCase())).rejects.toThrow(InvalidRecordError);
        await expect(phone.detachBlob('notes', 'not-an-id', ref.id)).rejects.toThrow(InvalidRecordError);
        await expect(phone.openBlob('notes', id, { ...ref, dek: 'short' })).rejects.toThrow(InvalidRecordError);
        expect(l.calls).toEqual([]);
    });

    it('fails the sync of a collection without blobs while a blob of it waits, and only that one', async () => {
        const a = await account();
        const { engine: phone } = device(a);
        const [list, note] = [newRecordId(), newRecordId()];
        const cover = await phone.attachBlob('lists', list, bytes('a cover'));
        await phone.save('lists', list, { name: 'books', cover });
        await phone.save('notes', note, { title: 'plain' });

        const report = await phone.sync();

        expect(report.failed.map(failure => failure.collection)).toEqual(['lists']);
        expect(report.failed[0]?.error).toBeInstanceOf(SyncConfigError);
        expect(a.server.records.get(NOTES)?.has(note)).toBe(true);
    });

    it('deletes a detached blob from the server once its record is pushed without it', async () => {
        const a = await account();
        const l = link(a.server);
        const { engine: phone, store } = device(a, l.transport);
        const id = newRecordId();
        const ref = await phone.attachBlob('notes', id, bytes('a photo'));
        await phone.save('notes', id, { title: 'trip', attachments: [{ ...ref, name: 'photo.jpg' }] });
        await phone.sync();
        l.calls.length = 0;

        await phone.save('notes', id, { title: 'trip', attachments: [] });
        await phone.detachBlob('notes', id, ref.id);
        expect(a.server.blobs.size).toBe(1);
        await phone.sync();

        expect(a.server.blobs.size).toBe(0);
        expect(l.calls.indexOf(`push ${NOTES}`)).toBeLessThan(l.calls.indexOf(`deleteBlob ${ref.id}`));
        expect(await store.pendingBlobs('notes')).toEqual([]);
        await expect(phone.openBlob('notes', id, ref)).rejects.toThrow(BlobNotFoundError);
    });

    it('never uploads a blob detached before its sync', async () => {
        const a = await account();
        const l = link(a.server);
        const { engine: phone } = device(a, l.transport);
        const id = newRecordId();
        const ref = await phone.attachBlob('notes', id, bytes('a draft photo'));
        await phone.save('notes', id, { title: 'draft' });
        await phone.detachBlob('notes', id, ref.id);

        await phone.sync();

        expect(l.calls).not.toContain(`putBlob ${ref.id}`);
        expect(a.server.blobs.size).toBe(0);
    });

    it('deletes a record\'s blobs with it, uploaded or waiting', async () => {
        const a = await account();
        const l = link(a.server);
        const { engine: phone, store } = device(a, l.transport);
        const id = newRecordId();
        const first = await phone.attachBlob('notes', id, bytes('uploaded'));
        await phone.save('notes', id, { title: 'album', attachments: [{ ...first, name: 'one.jpg' }] });
        await phone.sync();
        const second = await phone.attachBlob('notes', id, bytes('waiting'));

        await phone.remove('notes', id);
        await phone.sync();

        expect(a.server.blobs.size).toBe(0);
        expect(l.calls).not.toContain(`putBlob ${second.id}`);
        expect(await store.pendingBlobs('notes')).toEqual([]);
    });

    it('throws BlobNotFoundError for a blob neither the device nor the server holds', async () => {
        const a = await account();
        const { engine: phone } = device(a);
        const id = newRecordId();
        const ref = await phone.attachBlob('notes', id, bytes('a photo'));
        await phone.save('notes', id, { title: 'trip', attachments: [{ ...ref, name: 'photo.jpg' }] });
        await phone.sync();
        a.server.blobs.clear();

        await expect(phone.openBlob('notes', id, ref)).rejects.toThrow(BlobNotFoundError);
    });
});
