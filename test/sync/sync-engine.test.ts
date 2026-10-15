import { generateAesKey } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { defineCollections, newRecordId } from '../../src/sync/collections.js';
import { ImmutableRecordError, LockedError, SyncConfigError, SyncProtocolError, SyncTransportError } from '../../src/sync/errors.js';
import type { MergePolicyFactory } from '../../src/sync/merge-policy.js';
import { openRecord } from '../../src/sync/record-envelope.js';
import { MemoryRecordStore } from '../../src/sync/record-store.js';
import { SyncEngine, type SyncEngineOptions, type SyncEvent } from '../../src/sync/sync-engine.js';
import { FakeSyncServer, type FakeSyncServerOptions } from '../support/fake-sync-server.js';

interface Note
{
    title: string;
    /** Whether this device holds the note's attachments: a fact about the device, not the note. */
    cached?: boolean;
}

interface List
{
    name: string;
    items: string[];
}

interface Play
{
    track: string;
}

interface Draft
{
    /** Counts the draft's edits, inside the ciphertext, where the server can't change it. */
    edits: number;
    text: string;
}

type Collections = { notes: Note; lists: List; plays: Play; drafts: Draft };

const NOTES = '7f3a9c21';
const LISTS = '2d81ff04';
const PLAYS = 'b4e70118';
const DRAFTS = 'c3a1e9d7';

const collections = defineCollections<Collections>({
    notes: { id: NOTES, localOnly: ['cached'], schemaVersion: 1 },
    lists: { id: LISTS, merge: { fn: 'test.unionItems' }, schemaVersion: 1 },
    plays: { id: PLAYS, immutable: true, schemaVersion: 1 },
    drafts: { id: DRAFTS, merge: { fn: 'test.mostEdits' }, schemaVersion: 1 },
});

/** Keeps every item either device added. */
const unionItems: MergePolicyFactory = () => ({ local, remote }) => {
    const [mine, theirs] = [local as List | undefined, remote as List | undefined];
    if (mine === undefined || theirs === undefined) return mine ?? theirs;
    return { ...theirs, items: [...new Set([...mine.items, ...theirs.items])].sort() };
};

/** Keeps whichever value has more edits, so a stale value can't replace a newer one. */
const mostEdits: MergePolicyFactory = () => ({ local, remote }) => {
    const [mine, theirs] = [local as Draft | undefined, remote as Draft | undefined];
    return (mine?.edits ?? -1) > (theirs?.edits ?? -1) ? mine : theirs;
};

interface Circle
{
    server: FakeSyncServer;
    aek: CryptoKey;
}

/** One user: their sync server and the AEK their devices share. */
async function circle(options: Partial<FakeSyncServerOptions> = {}): Promise<Circle>
{
    const server = new FakeSyncServer({ collections: [{ id: NOTES }, { id: LISTS }, { id: PLAYS }, { id: DRAFTS }], ...options });
    return { server, aek: await generateAesKey(false) };
}

function device({ server, aek }: Circle, overrides: Partial<SyncEngineOptions<Collections>> = {}): SyncEngine<Collections>
{
    return new SyncEngine<Collections>({
        collections,
        transport: server.transport(),
        store: new MemoryRecordStore(),
        keyring: { aek: async () => aek },
        mergePolicies: { 'test.unionItems': unionItems, 'test.mostEdits': mostEdits },
        ...overrides,
    });
}

/** The pushes the server got for one collection: the keyring's first sync pushes one of its own. */
function pushesTo({ server }: Circle, collectionId: string): FakeSyncServer['pushes']
{
    return server.pushes.filter(push => push.collectionId === collectionId);
}

function eventsOf(engine: SyncEngine<Collections>): SyncEvent<Collections>[]
{
    const events: SyncEvent<Collections>[] = [];
    engine.subscribe(event => events.push(event));
    return events;
}

/** A phone and a laptop that both hold the same note, synced. */
async function noteOnTwoDevices(c: Circle): Promise<{ phone: SyncEngine<Collections>; laptop: SyncEngine<Collections>; id: string }>
{
    const phone = device(c);
    const laptop = device(c);
    const id = newRecordId();
    await phone.save('notes', id, { title: 'groceries' });
    await phone.sync();
    await laptop.sync();
    return { phone, laptop, id };
}

describe('SyncEngine', () => {
    it('syncs a record from one device to another', async () => {
        const c = await circle();
        const phone = device(c);
        const laptop = device(c);
        const id = newRecordId();

        await phone.save('notes', id, { title: 'groceries' });
        expect(await phone.sync()).toEqual({ pushed: 1, pulled: 1, merged: 0, failed: [] });
        await laptop.sync();

        expect(await laptop.get('notes', id)).toEqual({ title: 'groceries' });
    });

    it('gives the server only ciphertext, bound to the record', async () => {
        const c = await circle();
        const phone = device(c);
        const id = newRecordId();

        await phone.save('notes', id, { title: 'groceries', cached: true });
        await phone.sync();
        const stored = c.server.records.get(NOTES)?.get(id);

        expect(JSON.stringify(stored)).not.toContain('groceries');
        const sealed = { ciphertext: stored?.ciphertext ?? '', iv: stored?.iv ?? '', wrappedDek: stored?.wrappedDek ?? '' };
        expect(await openRecord(c.aek, NOTES, id, sealed)).toEqual({ title: 'groceries', schemaVersion: 1 });
    });

    it('merges a conflict and pushes again in the same sync, instead of failing', async () => {
        const c = await circle();
        const phone = device(c);
        const laptop = device(c);
        const laptopEvents = eventsOf(laptop);
        const id = newRecordId();
        await phone.save('lists', id, { name: 'shopping', items: ['milk'] });
        await phone.sync();
        await laptop.sync();

        await phone.save('lists', id, { name: 'shopping', items: ['eggs', 'milk'] });
        await laptop.save('lists', id, { name: 'shopping', items: ['bread', 'milk'] });
        await phone.sync();
        const report = await laptop.sync();
        await phone.sync();

        expect(report).toMatchObject({ pushed: 1, merged: 1, failed: [] });
        expect(laptopEvents.filter(event => event.type === 'rejected')).toEqual([]);
        for (const engine of [phone, laptop])
        {
            expect(await engine.get('lists', id)).toEqual({ name: 'shopping', items: ['bread', 'eggs', 'milk'] });
        }
    });

    it('lets the device that pushes last win, by default', async () => {
        const c = await circle();
        const { phone, laptop, id } = await noteOnTwoDevices(c);

        await phone.save('notes', id, { title: 'groceries for Monday' });
        await laptop.save('notes', id, { title: 'groceries for Tuesday' });
        await phone.sync();
        await laptop.sync();
        await phone.sync();

        expect(await phone.get('notes', id)).toEqual({ title: 'groceries for Tuesday' });
    });

    it('keeps a newer value against a stale one the server serves, when the merge policy can tell them apart', async () => {
        const c = await circle();
        const phone = device(c);
        const laptop = device(c);
        const id = newRecordId();
        await phone.save('drafts', id, { edits: 1, text: 'Dear' });
        await phone.sync();
        const first = structuredClone(c.server.records.get(DRAFTS)?.get(id));
        await phone.save('drafts', id, { edits: 2, text: 'Dear Sam' });
        await phone.sync();
        await laptop.sync();

        // A dishonest server serves the first ciphertext again, as the newest write.
        if (!first) throw new Error('The server lost the draft.');
        c.server.records.get(DRAFTS)?.set(id, { ...first, version: crypto.randomUUID(), seq: 1000 });
        await laptop.sync();
        await laptop.sync();

        expect(await laptop.get('drafts', id)).toEqual({ edits: 2, text: 'Dear Sam' });
        const stored = c.server.records.get(DRAFTS)?.get(id);
        const sealed = { ciphertext: stored?.ciphertext ?? '', iv: stored?.iv ?? '', wrappedDek: stored?.wrappedDek ?? '' };
        expect(await openRecord(c.aek, DRAFTS, id, sealed)).toEqual({ edits: 2, text: 'Dear Sam', schemaVersion: 1 });
    });

    it('brings back a record deleted on one device and edited on another', async () => {
        const c = await circle();
        const { phone, laptop, id } = await noteOnTwoDevices(c);

        await phone.remove('notes', id);
        await phone.sync();
        await laptop.save('notes', id, { title: 'groceries, still needed' });
        await laptop.sync();
        await phone.sync();

        expect(await phone.get('notes', id)).toEqual({ title: 'groceries, still needed' });
    });

    it('deletes a record on every device', async () => {
        const c = await circle();
        const { phone, laptop, id } = await noteOnTwoDevices(c);
        const laptopEvents = eventsOf(laptop);

        await phone.remove('notes', id);
        await phone.sync();
        await laptop.sync();

        expect(await laptop.get('notes', id)).toBeUndefined();
        expect(laptopEvents).toEqual([{ type: 'changed', collection: 'notes', id, value: undefined }]);
        expect(c.server.records.get(NOTES)?.get(id)).toMatchObject({ ciphertext: null, deletedAt: expect.any(String) });
    });

    it('never tells the server about a record deleted before it was pushed', async () => {
        const c = await circle();
        const phone = device(c);
        const id = newRecordId();

        await phone.save('notes', id, { title: 'typo' });
        await phone.remove('notes', id);
        await phone.sync();

        expect(pushesTo(c, NOTES)).toEqual([]);
        expect(await phone.get('notes', id)).toBeUndefined();
    });

    it('keeps local-only fields on the device, through other devices\' changes', async () => {
        const c = await circle();
        const phone = device(c);
        const laptop = device(c);
        const id = newRecordId();

        await phone.save('notes', id, { title: 'groceries', cached: true });
        await phone.sync();
        await laptop.sync();
        await laptop.save('notes', id, { title: 'groceries and eggs' });
        await laptop.sync();
        await phone.sync();

        expect(await laptop.get('notes', id)).toEqual({ title: 'groceries and eggs' });
        expect(await phone.get('notes', id)).toEqual({ title: 'groceries and eggs', cached: true });
    });

    it('keeps an edit made while the record\'s push was in flight', async () => {
        const c = await circle();
        const transport = c.server.transport();
        const id = newRecordId();
        let editDuringPush: (() => Promise<void>) | undefined;
        const phone = device(c, {
            transport: {
                ...transport,
                push: async (collectionId, items) => {
                    const edit = editDuringPush;
                    editDuringPush = undefined;
                    await edit?.();
                    return transport.push(collectionId, items);
                },
            },
        });
        const laptop = device(c);

        await phone.save('notes', id, { title: 'groceries' });
        editDuringPush = () => phone.save('notes', id, { title: 'groceries and eggs' });
        await phone.sync();
        await phone.sync();
        await laptop.sync();

        expect(await phone.get('notes', id)).toEqual({ title: 'groceries and eggs' });
        expect(await laptop.get('notes', id)).toEqual({ title: 'groceries and eggs' });
    });

    it('stops retrying a record over the size limit, until it changes', async () => {
        const c = await circle({ collections: [{ id: NOTES, maxRecordBytes: 100 }, { id: LISTS }, { id: PLAYS }, { id: DRAFTS }] });
        const phone = device(c);
        const events = eventsOf(phone);
        const id = newRecordId();

        await phone.save('notes', id, { title: 'x'.repeat(200) });
        await phone.sync();
        await phone.sync();

        expect(events).toEqual([{ type: 'rejected', collection: 'notes', id, code: 'record_too_large' }]);
        expect(pushesTo(c, NOTES)).toEqual([]);

        await phone.save('notes', id, { title: 'short' });
        expect(await phone.sync()).toMatchObject({ pushed: 1 });
    });

    it('pulls in pages and starts the next sync where the last one stopped', async () => {
        const c = await circle({ maxPageItems: 2 });
        const phone = device(c);
        const laptop = device(c);
        const ids = Array.from({ length: 5 }, () => newRecordId());
        for (const [index, id] of ids.entries())
        {
            await phone.save('notes', id, { title: `note ${index}` });
        }
        await phone.sync();

        expect(await laptop.sync()).toMatchObject({ pulled: 5 });
        expect(await laptop.sync()).toMatchObject({ pulled: 0 });
        expect(await laptop.get('notes', ids[4] ?? '')).toEqual({ title: 'note 4' });
    });

    it('pulls from the beginning when the server refuses the cursor', async () => {
        const c = await circle();
        const transport = c.server.transport();
        let refuseCursors = false;
        const phone = device(c);
        const laptop = device(c, {
            transport: {
                ...transport,
                pull: async (collectionId, cursor, limit) => {
                    if (refuseCursors && cursor !== undefined) throw new SyncTransportError(400, { code: 'invalid_cursor' });
                    return transport.pull(collectionId, cursor, limit);
                },
            },
        });
        await laptop.sync();
        const id = newRecordId();
        await phone.save('notes', id, { title: 'groceries' });
        await phone.sync();

        refuseCursors = true;
        const report = await laptop.sync();

        expect(report.failed).toEqual([]);
        expect(await laptop.get('notes', id)).toEqual({ title: 'groceries' });
    });

    it('skips a record whose ciphertext was moved from another record, and applies the rest', async () => {
        const c = await circle();
        const phone = device(c);
        const laptop = device(c);
        const events = eventsOf(laptop);
        const [kept, moved] = [newRecordId(), newRecordId()];
        await phone.save('notes', kept, { title: 'groceries' });
        await phone.save('notes', moved, { title: 'chores' });
        await phone.sync();

        const records = c.server.records.get(NOTES);
        const source = records?.get(kept);
        const target = records?.get(moved);
        if (!records || !source || !target) throw new Error('The server lost the records.');
        records.set(moved, { ...target, ciphertext: source.ciphertext, iv: source.iv, wrappedDek: source.wrappedDek });
        const report = await laptop.sync();

        expect(report.failed).toEqual([]);
        expect(events).toContainEqual({ type: 'unreadable', collection: 'notes', id: moved });
        expect(await laptop.get('notes', kept)).toEqual({ title: 'groceries' });
        expect(await laptop.get('notes', moved)).toBeUndefined();
    });

    it('carries on with the other collections when one fails', async () => {
        const c = await circle();
        const transport = c.server.transport();
        const phone = device(c);
        const laptop = device(c, {
            transport: {
                ...transport,
                pull: async (collectionId, cursor, limit) => {
                    if (collectionId === NOTES) throw new SyncTransportError(503);
                    return transport.pull(collectionId, cursor, limit);
                },
            },
        });
        const id = newRecordId();
        await phone.save('plays', id, { track: 'Blue in Green' });
        await phone.sync();

        const report = await laptop.sync();

        expect(report.failed).toEqual([{ collection: 'notes', error: expect.any(SyncTransportError) }]);
        expect(await laptop.get('plays', id)).toEqual({ track: 'Blue in Green' });
    });

    it('reports a collection the server doesn\'t accept, and syncs the others', async () => {
        const c = await circle({ collections: [{ id: NOTES }, { id: LISTS }, { id: DRAFTS }] });
        const phone = device(c);
        const id = newRecordId();
        await phone.save('notes', id, { title: 'groceries' });

        const report = await phone.sync();

        expect(report).toMatchObject({ pushed: 1, failed: [{ collection: 'plays', error: expect.any(SyncConfigError) }] });
    });

    it('reports every collection when the server can\'t be reached', async () => {
        const c = await circle();
        const transport = c.server.transport();
        const offline = new TypeError('fetch failed');
        const phone = device(c, { transport: { ...transport, getConfig: async () => { throw offline; } } });

        const report = await phone.sync();

        expect(report.failed.map(failure => failure.collection)).toEqual(['keyring', 'notes', 'lists', 'plays', 'drafts']);
        expect(report.failed.every(failure => failure.error === offline)).toBe(true);
    });

    it('refuses a server config whose limits can\'t be kept', async () => {
        const c = await circle({ maxBatchItems: 0 });
        const phone = device(c);
        await phone.save('notes', newRecordId(), { title: 'groceries' });

        const report = await phone.sync();

        expect(report.failed).toContainEqual({ collection: 'notes', error: expect.any(SyncProtocolError) });
        expect(c.server.pushes).toEqual([]);
    });

    it('sends fewer items when the server finds the request too large', async () => {
        const c = await circle();
        const transport = c.server.transport();
        const phone = device(c, {
            transport: {
                ...transport,
                push: async (collectionId, items) => {
                    if (items.length > 2) throw new SyncTransportError(413, { code: 'request_too_large' });
                    return transport.push(collectionId, items);
                },
            },
        });
        for (let index = 0; index < 5; index++)
        {
            await phone.save('notes', newRecordId(), { title: `note ${index}` });
        }

        expect(await phone.sync()).toMatchObject({ pushed: 5, failed: [] });
        expect(c.server.records.get(NOTES)?.size).toBe(5);
    });

    it('sends nothing while the device is locked', async () => {
        const c = await circle();
        const phone = device(c, { keyring: { aek: async () => { throw new LockedError('The circle is locked.'); } } });
        await phone.save('notes', newRecordId(), { title: 'groceries' });

        await expect(phone.sync()).rejects.toThrow(LockedError);
        expect(c.server.pushes).toEqual([]);
    });

    it('refuses to change or delete a record in an immutable collection', async () => {
        const c = await circle();
        const phone = device(c);
        const id = newRecordId();
        await phone.save('plays', id, { track: 'So What' });

        await expect(phone.save('plays', id, { track: 'Freddie Freeloader' })).rejects.toThrow(ImmutableRecordError);
        await expect(phone.remove('plays', id)).rejects.toThrow(ImmutableRecordError);
    });

    it('refuses a registry naming a merge policy that isn\'t registered', async () => {
        const c = await circle();

        expect(() => device(c, { mergePolicies: {} })).toThrow(SyncConfigError);
    });
});
