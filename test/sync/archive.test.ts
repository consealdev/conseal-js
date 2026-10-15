import { importAesKey, toBase64 } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { archiveKind, exportArchive } from '../../src/sync/archive.js';
import { openBackup } from '../../src/sync/backup.js';
import type { BlobRef } from '../../src/sync/blob-envelope.js';
import { defineCollections, newRecordId, type CollectionDefinitions } from '../../src/sync/collections.js';
import { ArchiveError, WrongPasscodeError } from '../../src/sync/errors.js';
import { KEYRING_COLLECTION, KEYRING_RECORD_ID, newKeyring, type KeyringValue } from '../../src/sync/identity.js';
import { MemoryRecordStore } from '../../src/sync/record-store.js';
import { SyncEngine } from '../../src/sync/sync-engine.js';
import { FakeSyncServer } from '../support/fake-sync-server.js';
import { blobSource, readZipDirectory, readZipEntry, type ByteSource } from '../../src/sync/zip.js';

interface Note
{
    title: string;
    /** Whether this device holds the note's attachments: a fact about the device, not the note. */
    cached?: boolean;
    attachments?: BlobRef[];
}

interface Play
{
    track: string;
}

type Collections = { notes: Note; plays: Play };

const NOTES = '7f3a9c21';
const PLAYS = 'b4e70118';
const PASSCODE = 'tiger moon 7 river';

const collections = defineCollections<Collections>({
    notes: { id: NOTES, localOnly: ['cached'], schemaVersion: 1 },
    plays: { id: PLAYS, immutable: true, schemaVersion: 1 },
});

interface Account
{
    server: FakeSyncServer;
    aekBytes: Uint8Array;
    aek: CryptoKey;
}

/** One user: their sync server and the AEK their devices share, with its bytes, to look for in exports. */
async function account(): Promise<Account>
{
    const aekBytes = crypto.getRandomValues(new Uint8Array(32));
    return {
        server: new FakeSyncServer({ collections: [{ id: NOTES, maxBlobBytes: 1_000_000 }, { id: PLAYS }] }),
        aekBytes,
        aek: await importAesKey(aekBytes),
    };
}

function device<C extends Record<string, object> = Collections>(
    { server, aek }: Account,
    registry: CollectionDefinitions<C> = collections as unknown as CollectionDefinitions<C>,
): SyncEngine<C>
{
    return new SyncEngine<C>({ collections: registry, transport: server.transport(), store: new MemoryRecordStore(), keyring: { aek: async () => aek } });
}

/** An export written out as a file, the way an app saves the chunks. */
async function toFile(chunks: AsyncIterable<Uint8Array>): Promise<Blob>
{
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks)
    {
        parts.push(chunk);
    }
    return new Blob(parts as BlobPart[]);
}

async function bytesOf(source: ByteSource): Promise<Uint8Array>
{
    return source.read(0, source.size);
}

/** The ZIP's files, by name, as text. */
async function filesOf(source: ByteSource): Promise<Map<string, string>>
{
    const files = new Map<string, string>();
    for (const [name, entry] of await readZipDirectory(source))
    {
        files.set(name, new TextDecoder().decode(await readZipEntry(source, entry)));
    }
    return files;
}

function contains(haystack: Uint8Array, needle: Uint8Array | string): boolean
{
    const bytes = typeof needle === 'string' ? new TextEncoder().encode(needle) : needle;
    outer: for (let at = 0; at + bytes.byteLength <= haystack.byteLength; at++)
    {
        for (let k = 0; k < bytes.byteLength; k++)
        {
            if (haystack[at + k] !== bytes[k]) continue outer;
        }
        return true;
    }
    return false;
}

function hex(bytes: Uint8Array): string
{
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function serverCount(a: Account, collectionId: string): number
{
    return a.server.records.get(collectionId)?.size ?? 0;
}

/** A phone with notes and plays, synced, and one more note saved since. */
async function phoneWithRecords(a: Account)
{
    const phone = device(a);
    const notes = [newRecordId(), newRecordId(), newRecordId()];
    await phone.save('notes', notes[0] as string, { title: 'groceries', cached: true });
    await phone.save('notes', notes[1] as string, { title: 'ideas' });
    await phone.save('notes', notes[2] as string, { title: 'deleted later' });
    await phone.save('plays', newRecordId(), { track: 'first song' });
    await phone.sync();
    await phone.remove('notes', notes[2] as string);
    const pending = newRecordId();
    await phone.save('notes', pending, { title: 'not synced yet' });
    return { phone, notes, pending };
}

describe('exportAll', () => {
    it('writes a ZIP of JSON parts per collection, and a manifest last', async () => {
        const a = await account();
        const { phone, notes, pending } = await phoneWithRecords(a);

        const file = await toFile(phone.exportAll());
        const directory = await readZipDirectory(blobSource(file));
        expect([...directory.keys()]).toEqual(['notes/0001.json', 'plays/0001.json', 'manifest.json']);

        const files = await filesOf(blobSource(file));
        const manifest = JSON.parse(files.get('manifest.json') as string);
        expect(manifest).toMatchObject({
            format: 'conseal-sync-export',
            version: 1,
            collections: [
                { name: 'notes', id: NOTES, schemaVersion: 1, records: 3, parts: ['notes/0001.json'] },
                { name: 'plays', id: PLAYS, schemaVersion: 1, records: 1, parts: ['plays/0001.json'] },
            ],
        });
        expect(Date.parse(manifest.exportedAt)).not.toBeNaN();

        const exported = JSON.parse(files.get('notes/0001.json') as string) as { id: string; schemaVersion: number; value: object }[];
        expect(exported.map(record => record.id).sort()).toEqual([notes[0], notes[1], pending].sort());
        expect(exported.find(record => record.id === notes[0])).toEqual({ id: notes[0], schemaVersion: 1, value: { title: 'groceries' } });
        expect(files.get('notes/0001.json')?.split('\n')).toHaveLength(6);
        expect(await archiveKind(file)).toBe('export');
    });

    it('holds no key material, sync state or local-only fields, plain or sealed', async () => {
        const a = await account();
        const { phone } = await phoneWithRecords(a);
        const versions = [...a.server.records.get(NOTES)?.values() ?? []].map(record => record.version);
        const wrappedDeks = [...a.server.records.get(NOTES)?.values() ?? []].flatMap(record => (record.wrappedDek ? [record.wrappedDek] : []));

        const plain = await bytesOf(blobSource(await toFile(phone.exportAll())));
        const backup = await toFile(phone.exportAll({ passcode: PASSCODE }));
        const sealed = new Uint8Array(await backup.arrayBuffer());
        const opened = await bytesOf(await openBackup(backup, PASSCODE));

        for (const bytes of [plain, sealed, opened])
        {
            expect(contains(bytes, a.aekBytes)).toBe(false);
            expect(contains(bytes, toBase64(a.aekBytes))).toBe(false);
            expect(contains(bytes, hex(a.aekBytes))).toBe(false);
            for (const text of ['cached', 'pending', 'rejected', '"rev"', ...versions, ...wrappedDeks])
            {
                expect(contains(bytes, text)).toBe(false);
            }
        }
        expect(contains(plain, 'groceries')).toBe(true);
        expect(contains(sealed, 'groceries')).toBe(false);
        expect(contains(opened, 'groceries')).toBe(true);
    });

    it('leaves the keyring out, plain or sealed', async () => {
        const a = await account();
        const store = new MemoryRecordStore();
        const phone = new SyncEngine<Collections>({ collections, transport: a.server.transport(), store, keyring: { aek: async () => a.aek } });
        await phone.save('notes', newRecordId(), { title: 'groceries' });
        await phone.sync();
        const keyring = (await store.get(KEYRING_COLLECTION, KEYRING_RECORD_ID))?.value as KeyringValue;

        const plain = await bytesOf(blobSource(await toFile(phone.exportAll())));
        const opened = await bytesOf(await openBackup(await toFile(phone.exportAll({ passcode: PASSCODE })), PASSCODE));

        for (const bytes of [plain, opened])
        {
            for (const text of [KEYRING_COLLECTION, keyring.ecdh.d as string, keyring.ecdsa.d as string])
            {
                expect(contains(bytes, text)).toBe(false);
            }
            expect(contains(bytes, 'groceries')).toBe(true);
        }
    });

    it('streams a large collection in parts, without holding it whole', async () => {
        const a = await account();
        const phone = device(a);
        // Two bytes each in UTF-8: parts are measured in bytes, not characters.
        const text = 'é'.repeat(5_000);
        for (let n = 0; n < 900; n++)
        {
            await phone.save('notes', newRecordId(), { title: `${n} ${text}` });
        }

        const chunks: Uint8Array[] = [];
        for await (const chunk of phone.exportAll())
        {
            chunks.push(chunk);
        }
        expect(Math.max(...chunks.map(chunk => chunk.byteLength))).toBeLessThan(4.2 * 1024 * 1024);

        const manifest = JSON.parse((await filesOf(blobSource(new Blob(chunks as BlobPart[])))).get('manifest.json') as string);
        expect(manifest.collections[0]).toMatchObject({ records: 900, parts: ['notes/0001.json', 'notes/0002.json', 'notes/0003.json'] });
    });

    it('writes a manifest alone when there are no records', async () => {
        const file = await toFile(device(await account()).exportAll());
        expect([...(await readZipDirectory(blobSource(file))).keys()]).toEqual(['manifest.json']);
    });

    it('refuses an empty passcode', () => {
        return account().then(a => expect(() => device(a).exportAll({ passcode: '' })).toThrow(TypeError));
    });
});

describe('importAll', () => {
    it('restores an export on a new device of the same account, which adds nothing twice to the server', async () => {
        const a = await account();
        const { phone, notes, pending } = await phoneWithRecords(a);
        await phone.sync();
        const file = await toFile(phone.exportAll());
        const before = { notes: serverCount(a, NOTES), plays: serverCount(a, PLAYS) };

        const laptop = device(a);
        expect(await laptop.importAll(file)).toEqual({ added: 4, replaced: 0, unchanged: 0, kept: 0, skipped: [], blobs: 0 });
        expect(await laptop.get('notes', notes[0] as string)).toEqual({ title: 'groceries' });
        expect(await laptop.get('notes', pending)).toEqual({ title: 'not synced yet' });

        const report = await laptop.sync();
        expect(report.failed).toEqual([]);
        expect({ notes: serverCount(a, NOTES), plays: serverCount(a, PLAYS) }).toEqual(before);
        expect(await laptop.get('notes', notes[1] as string)).toEqual({ title: 'ideas' });

        expect(await laptop.importAll(file)).toEqual({ added: 0, replaced: 0, unchanged: 4, kept: 0, skipped: [], blobs: 0 });
    });

    it('moves an account\'s records to another account, keeping their ids', async () => {
        const a = await account();
        const { phone, notes } = await phoneWithRecords(a);
        const file = await toFile(phone.exportAll({ passcode: PASSCODE }));

        const other = await account();
        const elsewhere = device(other);
        await elsewhere.importAll(file, { passcode: PASSCODE });
        await elsewhere.sync();
        expect(serverCount(other, NOTES)).toBe(3);

        const fresh = device(other);
        await fresh.sync();
        expect(await fresh.get('notes', notes[0] as string)).toEqual({ title: 'groceries' });
    });

    it('keeps this device\'s other values unless asked to replace them, and an immutable collection\'s always', async () => {
        const a = await account();
        const { phone, notes } = await phoneWithRecords(a);
        const file = await toFile(phone.exportAll());

        await phone.save('notes', notes[0] as string, { title: 'groceries and milk', cached: true });
        await phone.remove('notes', notes[1] as string);
        expect(await phone.importAll(file)).toEqual({ added: 1, replaced: 0, unchanged: 2, kept: 1, skipped: [], blobs: 0 });
        expect(await phone.get('notes', notes[0] as string)).toEqual({ title: 'groceries and milk', cached: true });
        // The note deleted after the export came back.
        expect(await phone.get('notes', notes[1] as string)).toEqual({ title: 'ideas' });

        expect(await phone.importAll(file, { replace: true })).toEqual({ added: 0, replaced: 1, unchanged: 3, kept: 0, skipped: [], blobs: 0 });
        // The export's value, with this device's local-only field.
        expect(await phone.get('notes', notes[0] as string)).toEqual({ title: 'groceries', cached: true });
    });

    it('leaves an immutable record as it is, even with replace', async () => {
        const a = await account();
        const phone = device(a);
        const play = newRecordId();
        await phone.save('plays', play, { track: 'first song' });
        const file = await toFile(phone.exportAll());

        const other = device(a);
        await other.save('plays', play, { track: 'another song' });
        expect(await other.importAll(file, { replace: true })).toMatchObject({ replaced: 0, kept: 1 });
        expect(await other.get('plays', play)).toEqual({ track: 'another song' });
    });

    it('skips collections this registry doesn\'t have', async () => {
        const a = await account();
        const { phone } = await phoneWithRecords(a);
        const file = await toFile(phone.exportAll());

        const notesOnly = device<{ notes: Note }>(a, defineCollections<{ notes: Note }>({ notes: { id: NOTES, localOnly: ['cached'], schemaVersion: 1 } }));
        expect(await notesOnly.importAll(file)).toEqual({
            added: 3,
            replaced: 0,
            unchanged: 0,
            kept: 0,
            skipped: [{ id: PLAYS, name: 'plays', records: 1 }],
            blobs: 0,
        });
    });

    it('skips a keyring in the file, so a file can\'t plant an identity', async () => {
        const a = await account();
        const phone = device(a);
        await phone.sync();
        const before = await crypto.subtle.exportKey('jwk', (await phone.identity()).ecdh.publicKey);
        const planted = new MemoryRecordStore();
        const record = { id: KEYRING_RECORD_ID, value: await newKeyring(), version: undefined, schemaVersion: 1, pending: false, rejected: undefined, rev: 1 };
        await planted.put(KEYRING_COLLECTION, KEYRING_RECORD_ID, record, undefined);
        const keyring = { name: KEYRING_COLLECTION, definition: { id: KEYRING_COLLECTION, schemaVersion: 1 }, localOnly: [] };
        const file = await toFile(exportArchive([keyring], planted, new Date(), async () => undefined));

        const report = await phone.importAll(file);

        expect(report.skipped).toEqual([{ id: KEYRING_COLLECTION, name: KEYRING_COLLECTION, records: 1 }]);
        expect(await crypto.subtle.exportKey('jwk', (await phone.identity()).ecdh.publicKey)).toEqual(before);
    });

    it('restores a sealed backup with its passcode, and refuses it without', async () => {
        const a = await account();
        const { phone } = await phoneWithRecords(a);
        const file = await toFile(phone.exportAll({ passcode: PASSCODE }));
        expect(await archiveKind(file)).toBe('backup');

        await expect(device(a).importAll(file)).rejects.toBeInstanceOf(WrongPasscodeError);
        await expect(device(a).importAll(file, { passcode: 'not the passcode' })).rejects.toBeInstanceOf(WrongPasscodeError);
        expect(await device(a).importAll(file, { passcode: PASSCODE })).toMatchObject({ added: 4 });
    });

    it('refuses what isn\'t an export, or one a newer version made', async () => {
        const a = await account();
        await expect(device(a).importAll(new Blob(['just some text\n']))).rejects.toBeInstanceOf(ArchiveError);
        expect(await archiveKind(new Blob(['just some text\n']))).toBeUndefined();

        const { phone } = await phoneWithRecords(a);
        const files = await filesOf(blobSource(await toFile(phone.exportAll())));
        const manifest = JSON.parse(files.get('manifest.json') as string);
        const { ZipWriter } = await import('../../src/sync/zip.js');
        const zip = new ZipWriter(new Date());
        const newer = [
            zip.file('notes/0001.json', new TextEncoder().encode(files.get('notes/0001.json'))),
            zip.file('manifest.json', new TextEncoder().encode(JSON.stringify({ ...manifest, version: 2 }))),
            zip.end(),
        ];
        await expect(device(a).importAll(new Blob(newer as BlobPart[]))).rejects.toThrow(/version 2/);
    });
});

describe('blobs in an export', () => {
    /** A phone with a note whose two blobs are on the server, and one more saved since, still waiting to upload. */
    async function phoneWithBlobs(a: Account)
    {
        const phone = device(a);
        const id = newRecordId();
        const beach = await phone.attachBlob('notes', id, new TextEncoder().encode('a photo of the beach'));
        const map = await phone.attachBlob('notes', id, new TextEncoder().encode('a map of the coast'));
        await phone.save('notes', id, { title: 'holiday', attachments: [beach, map] });
        await phone.sync();
        const waiting = await phone.attachBlob('notes', id, new TextEncoder().encode('a ticket stub'));
        await phone.save('notes', id, { title: 'holiday', attachments: [beach, map, waiting] });
        return { phone, id, refs: [beach, map, waiting] };
    }

    it('carries each blob as a file of its own, listed in the manifest, uploaded or waiting', async () => {
        const a = await account();
        const { phone, id, refs } = await phoneWithBlobs(a);
        const paths = refs.map(ref => `blobs/notes/${id}/${ref.id}`);

        const plain = blobSource(await toFile(phone.exportAll()));
        const sealed = await openBackup(await toFile(phone.exportAll({ passcode: PASSCODE })), PASSCODE);
        for (const source of [plain, sealed])
        {
            const files = await filesOf(source);
            expect(paths.map(p => files.get(p))).toEqual(['a photo of the beach', 'a map of the coast', 'a ticket stub']);
            expect(JSON.parse(files.get('manifest.json') as string).collections[0].blobs).toEqual(paths);
        }
    });

    it('moves blobs to another account: they wait on the device and upload with their records', async () => {
        const a = await account();
        const { phone, id, refs } = await phoneWithBlobs(a);
        const file = await toFile(phone.exportAll({ passcode: PASSCODE }));
        const b = await account();
        const laptop = device(b);

        const report = await laptop.importAll(file, { passcode: PASSCODE });
        expect(report).toMatchObject({ added: 1, blobs: 3 });
        expect(b.server.blobs.size).toBe(0);
        await laptop.sync();

        expect(b.server.blobs.size).toBe(3);
        const tablet = device(b);
        await tablet.sync();
        const opened = await Promise.all(refs.map(ref => tablet.openBlob('notes', id, ref)));
        expect(opened.map(bytes => new TextDecoder().decode(bytes))).toEqual(['a photo of the beach', 'a map of the coast', 'a ticket stub']);
    });

    it('leaves out a blob the server no longer holds, or that doesn\'t open', async () => {
        const a = await account();
        const { phone, id, refs } = await phoneWithBlobs(a);
        const [beach, map] = refs as [BlobRef, BlobRef, BlobRef];
        a.server.blobs.delete(`${NOTES}/${id}/${beach.id}`);
        const stored = a.server.blobs.get(`${NOTES}/${id}/${map.id}`) as Uint8Array;
        stored[20] = (stored[20] as number) ^ 1;

        const file = await toFile(phone.exportAll());
        const names = [...(await readZipDirectory(blobSource(file))).keys()];

        expect(names.filter(name => name.startsWith('blobs/'))).toEqual([`blobs/notes/${id}/${(refs[2] as BlobRef).id}`]);
        expect(await device(await account()).importAll(file)).toMatchObject({ added: 1, blobs: 1 });
    });

    it('refuses a file whose blob was changed, and writes nothing', async () => {
        const a = await account();
        const { phone } = await phoneWithBlobs(a);
        const bytes = new Uint8Array(await (await toFile(phone.exportAll())).arrayBuffer());
        const at = new TextDecoder('latin1').decode(bytes).indexOf('a map of the coast');
        const changed = bytes.slice();
        changed[at] = (changed[at] as number) ^ 1;
        const laptop = device(a);

        await expect(laptop.importAll(new Blob([changed]))).rejects.toThrow(/checksum/);
        expect(await toFile(laptop.exportAll()).then(blob => readZipDirectory(blobSource(blob))).then(entries => [...entries.keys()]))
            .toEqual(['manifest.json']);
    });
});

describe('a damaged file changes nothing', () => {
    async function exported()
    {
        const a = await account();
        const phone = device(a);
        const text = 'y'.repeat(8_000);
        for (let n = 0; n < 600; n++)
        {
            await phone.save('notes', newRecordId(), { title: `${n} ${text}` });
        }
        return { a, plain: await toFile(phone.exportAll()), backup: await toFile(phone.exportAll({ passcode: PASSCODE })) };
    }

    async function refused(a: Account, file: Blob, passcode?: string, reason?: RegExp): Promise<void>
    {
        const laptop = device(a);
        const importing = laptop.importAll(file, { passcode });
        await expect(importing).rejects.toBeInstanceOf(ArchiveError);
        if (reason) await expect(importing).rejects.toThrow(reason);
        expect(await toFile(laptop.exportAll()).then(blob => readZipDirectory(blobSource(blob))).then(entries => [...entries.keys()]))
            .toEqual(['manifest.json']);
    }

    function flip(bytes: Uint8Array, at: number): Blob
    {
        const copy = bytes.slice();
        copy[at] = (copy[at] as number) ^ 0x01;
        return new Blob([copy]);
    }

    it('refuses a plain export with a changed byte in a later part, or cut short', async () => {
        const { a, plain } = await exported();
        const bytes = new Uint8Array(await plain.arrayBuffer());
        const second = (await readZipDirectory(blobSource(plain))).get('notes/0002.json')!;
        await refused(a, flip(bytes, second.offset + 1000), undefined, /checksum/);
        await refused(a, new Blob([bytes.slice(0, bytes.byteLength - 1000)]));
    });

    it('refuses a sealed backup with a changed byte, a chunk dropped, moved or cut, or another backup\'s header', async () => {
        const { a, backup } = await exported();
        const bytes = new Uint8Array(await backup.arrayBuffer());
        const headerBytes = bytes.indexOf(0x0a) + 1;
        const stride = 1024 * 1024 + 28;
        expect(bytes.byteLength - headerBytes).toBeGreaterThan(2 * stride);
        const chunk = (index: number) => bytes.slice(headerBytes + index * stride, headerBytes + (index + 1) * stride);
        const header = bytes.slice(0, headerBytes);
        const rest = bytes.slice(headerBytes + 2 * stride);

        // Each is caught where it's sealed, before the export inside is read.
        const unopened = /part of it doesn't open/;
        await refused(a, flip(bytes, headerBytes + stride + 100), PASSCODE, unopened);
        await refused(a, new Blob([header, chunk(1), rest]), PASSCODE, unopened);
        await refused(a, new Blob([header, chunk(1), chunk(0), rest]), PASSCODE, unopened);
        await refused(a, new Blob([header, chunk(0), chunk(1)]), PASSCODE, unopened);

        const other = new Uint8Array(await (await exported()).backup.arrayBuffer());
        const otherHeader = other.slice(0, other.indexOf(0x0a) + 1);
        await expect(device(a).importAll(new Blob([otherHeader, bytes.slice(headerBytes)]), { passcode: PASSCODE }))
            .rejects.toBeInstanceOf(ArchiveError);
    });
});
