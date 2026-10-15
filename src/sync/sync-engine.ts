import {
    archiveRecords,
    exportArchive,
    openArchive,
    readArchive,
    type ExportOptions,
    type ImportOptions,
    type ImportReport,
} from './archive.js';
import { sealBackup } from './backup.js';
import { blobRefs, isBlobRef, newBlob, openBlob as openSealedBlob, sealBlob, type BlobRef } from './blob-envelope.js';
import { isRecordId, validateCollections, type CollectionDefinition, type CollectionDefinitions } from './collections.js';
import {
    BlobNotFoundError,
    ImmutableRecordError,
    InvalidRecordError,
    KeyringError,
    SyncConfigError,
    SyncError,
    SyncProtocolError,
    SyncTransportError,
    UnreadableRecordError,
} from './errors.js';
import {
    KEYRING_COLLECTION,
    KEYRING_RECORD_ID,
    KEYRING_SCHEMA_VERSION,
    newKeyring,
    openKeyring,
    type Identity,
} from './identity.js';
import { mergePolicyTable, resolveMergePolicy, takeRemote, type MergePolicy, type MergePolicyFactory } from './merge-policy.js';
import { openRecord, sealRecord } from './record-envelope.js';
import type { LocalRecord, PendingBlob, RecordStore, RejectionCode } from './record-store.js';
import type { CollectionLimits, PushItem, PushResult, SyncConfig, SyncPage, SyncRecord, SyncTransport } from './sync-transport.js';
import { isPlainObject, jsonEqual, withLocalOnly, withoutLocalOnly } from './values.js';
import { readZipEntry } from './zip.js';

/** How many times one sync pushes a collection again after conflicts, before leaving the rest to the next sync. */
const MAX_PUSH_ROUNDS = 3;

/** How many times a write to one record is tried again when the record changed between reading and writing. */
const MAX_WRITE_ATTEMPTS = 10;

/** Where the engine gets the AEK. `CircleClient` is one. */
export interface Keyring
{
    /** The AEK, or a throw when the device is locked. */
    aek(): Promise<CryptoKey>;
}

export interface SyncEngineOptions<Values extends Record<string, object>>
{
    collections: CollectionDefinitions<Values>;
    transport: SyncTransport;
    store: RecordStore;
    keyring: Keyring;
    /** Merge policies the registry names, by name, beyond the built-in `lastWriteWins`. */
    mergePolicies?: Readonly<Record<string, MergePolicyFactory>> | undefined;
}

/** What a sync did to this device's records, as it happens. */
export type SyncEvent<Values extends Record<string, object>> =
    /** A record changed or was deleted (`value` undefined) by another device's write, or by a merge. */
    | { [K in keyof Values & string]: { type: 'changed'; collection: K; id: string; value: Values[K] | undefined } }[keyof Values & string]
    /** The engine stopped retrying a record's pending change. The next local change to it tries again. */
    | { type: 'rejected'; collection: keyof Values & string; id: string; code: RejectionCode }
    /** A record from the server doesn't open, so it was skipped. */
    | { type: 'unreadable'; collection: keyof Values & string; id: string };

export interface SyncReport
{
    /** Writes and deletes the server accepted. */
    pushed: number;
    /** Records pulled, this device's own writes coming back included. */
    pulled: number;
    /** Pushes the server answered with a conflict, merged and pushed again. */
    merged: number;
    /**
     * The collections that didn't finish, and why. They pick up where they stopped on the next sync. `keyring` is the
     * engine's own, which carries the user's identity.
     */
    failed: { collection: string; error: unknown }[];
}

interface Collection
{
    name: string;
    definition: CollectionDefinition;
    merge: MergePolicy;
    localOnly: readonly string[];
}

/**
 * The keyring's collection: synced like the app's, written once like an immutable one, and kept out of what the app
 * sees, its exports, its events and the report's counts.
 */
const KEYRING: Collection = {
    name: KEYRING_COLLECTION,
    definition: { id: KEYRING_COLLECTION, immutable: true, schemaVersion: KEYRING_SCHEMA_VERSION },
    merge: takeRemote,
    localOnly: [],
};

interface PushCounts
{
    pushed: number;
    merged: number;
}

/** A record's state on the server, opened. */
interface RemoteState
{
    /** Undefined for a tombstone, or when the server holds no record. */
    value: object | undefined;
    /** Undefined when the server holds no record. */
    version: string | undefined;
    schemaVersion: number | undefined;
}

type RecordChange = Omit<LocalRecord, 'rev'>;

/**
 * Syncs an app's records between the user's devices through a server that can't read them. The app saves and
 * deletes records here, in plaintext; `sync` seals what changed, pushes it, pulls what other devices wrote, opens it,
 * and merges it into this device's copy with the collection's merge policy. A conflict on push is a merge, never a
 * failure.
 *
 * It does no HTTP of its own and never holds the AEK: the AEK comes from a `Keyring`, the requests go through the app's
 * `SyncTransport`, and the records live in the app's `RecordStore`. Beside the app's collections it syncs one of its
 * own, the keyring, which carries the user's identity to every device in the circle (see `identity`).
 *
 * Content too large for a record goes in a blob (see `attachBlob`): sealed under a DEK of its own, which only the
 * record's value holds, and uploaded before the record that refers to it is pushed.
 */
export class SyncEngine<Values extends Record<string, object>>
{
    private readonly _collections: ReadonlyMap<string, Collection>;
    private readonly _transport: SyncTransport;
    private readonly _store: RecordStore;
    private readonly _keyring: Keyring;
    private readonly _listeners = new Set<(event: SyncEvent<Values>) => void>();
    private _config: SyncConfig | undefined;
    private _running: Promise<SyncReport> | undefined;

    /** @throws SyncConfigError when the registry isn't valid or names a merge policy that isn't registered. */
    constructor(options: SyncEngineOptions<Values>)
    {
        validateCollections(options.collections);
        const policies = mergePolicyTable(options.mergePolicies ?? {});
        this._collections = new Map(Object.entries<CollectionDefinition>(options.collections).map(([name, definition]) => [name, {
            name,
            definition,
            merge: resolveMergePolicy(name, definition, policies),
            localOnly: definition.localOnly ?? [],
        }]));
        this._transport = options.transport;
        this._store = options.store;
        this._keyring = options.keyring;
    }

    /** A record's value on this device; undefined when there is none, or it's deleted. */
    public async get<K extends keyof Values & string>(collection: K, id: string): Promise<Values[K] | undefined>
    {
        const record = await this._store.get(this._collection(collection).name, id);
        return record?.value as Values[K] | undefined;
    }

    /**
     * Saves a record on this device, creating it when `id` is new, and marks it for the next sync. Mint ids with
     * `newRecordId`. The value is JSON data: a plain object without a `schemaVersion` field, which the engine seals in.
     *
     * @throws InvalidRecordError when the id or value isn't one the engine can sync.
     * @throws ImmutableRecordError when the collection is immutable and the record exists.
     */
    public async save<K extends keyof Values & string>(collection: K, id: string, value: Values[K]): Promise<void>
    {
        const c = this._collection(collection);
        if (!isRecordId(id)) throw new InvalidRecordError(`Record id ${id} isn't a lowercase version 4 UUID.`);
        if (!isPlainObject(value)) throw new InvalidRecordError(`Record ${id}'s value isn't a plain object.`);
        if (Object.hasOwn(value, 'schemaVersion'))
        {
            throw new InvalidRecordError(`Record ${id} has a schemaVersion field, which the engine reserves.`);
        }

        await this._write(c, id, current => {
            if (current && c.definition.immutable)
            {
                throw new ImmutableRecordError(`Collection ${c.name} is immutable, and record ${id} exists.`);
            }
            return {
                id,
                value,
                version: current?.version,
                schemaVersion: Math.max(current?.schemaVersion ?? 0, c.definition.schemaVersion),
                pending: true,
                rejected: undefined,
            };
        });
    }

    /**
     * Deletes a record on this device. The next sync tells the server, which keeps a tombstone so the other devices
     * delete it too.
     *
     * @throws ImmutableRecordError when the collection is immutable.
     */
    public async remove<K extends keyof Values & string>(collection: K, id: string): Promise<void>
    {
        const c = this._collection(collection);
        if (c.definition.immutable) throw new ImmutableRecordError(`Collection ${c.name} is immutable: its records can't be deleted.`);

        await this._write(c, id, current => {
            if (current === undefined || current.value === undefined) return current;
            return { ...current, value: undefined, pending: true, rejected: undefined };
        });
        // The server deletes a record's blobs with its tombstone, so none of them need uploading or deleting.
        for (const blob of await this._store.pendingBlobs(c.name))
        {
            if (blob.recordId === id) await this._store.removeBlob(c.name, id, blob.blobId);
        }
    }

    /**
     * Seals bytes as a blob of a record, under a fresh DEK, and keeps the sealed blob on this device until a sync
     * uploads it, so it works offline. Put the returned reference in the record's value, alone or with fields of the
     * app's own, and save the record: the reference carries the blob's DEK, so the blob opens only through its record.
     * A sync uploads a record's blobs before it pushes the record, so no device sees a reference to a blob that isn't
     * on the server.
     *
     * @throws InvalidRecordError when the record id isn't one the engine can sync, or the server is known to refuse the
     * blob: the collection has no blobs, or the sealed blob is over its `maxBlobBytes`.
     */
    public async attachBlob<K extends keyof Values & string>(collection: K, recordId: string, bytes: Uint8Array | ArrayBuffer): Promise<BlobRef>
    {
        const c = this._collection(collection);
        if (!isRecordId(recordId)) throw new InvalidRecordError(`Record id ${recordId} isn't a lowercase version 4 UUID.`);

        const { ref, sealed } = await newBlob(c.definition.id, recordId, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        const limit = this._config?.collections.find(l => l.id === c.definition.id)?.maxBlobBytes;
        if (limit === null) throw new InvalidRecordError(`The server has no blobs for collection ${c.name}.`);
        if (limit !== undefined && sealed.byteLength > limit)
        {
            throw new InvalidRecordError(`The blob is ${sealed.byteLength} bytes sealed, over the server's ${limit} for collection ${c.name}.`);
        }
        await this._store.putBlob(c.name, { recordId, blobId: ref.id, sealed });
        return ref;
    }

    /**
     * A blob's bytes, by the reference in its record's value: from this device while it waits to upload, otherwise
     * downloaded from the server. Nothing is kept on the device after a download; caching the bytes is the app's.
     *
     * @throws InvalidRecordError when `ref` isn't a blob reference.
     * @throws BlobNotFoundError when neither this device nor the server holds the blob.
     * @throws UnreadableRecordError when the blob doesn't open: it was altered, moved from another record or blob id,
     * or doesn't match the reference.
     * @throws whatever the transport throws, offline or on a server error.
     */
    public async openBlob<K extends keyof Values & string>(collection: K, recordId: string, ref: BlobRef): Promise<Uint8Array>
    {
        const c = this._collection(collection);
        if (!isRecordId(recordId) || !isBlobRef(ref)) throw new InvalidRecordError(`Blob ${String(ref?.id)} of record ${recordId} isn't a blob reference.`);
        const sealed = await this._sealedBlob(c, recordId, ref.id);
        if (sealed === undefined) throw new BlobNotFoundError(`Blob ${ref.id} of record ${recordId} isn't on this device or the server.`);
        return openSealedBlob(c.definition.id, recordId, ref, sealed);
    }

    /**
     * Deletes a blob its record no longer refers to. Save the record without the reference first: the next sync deletes
     * the blob from the server once the record is pushed, so a device that pulls the record doesn't look for it. A blob
     * still waiting to upload is never uploaded. Deleting a record deletes its blobs, without this.
     *
     * A merge that brings the reference back, from another device's change, finds the blob gone: detach a blob only
     * once the app's merge policy can't keep it.
     *
     * @throws InvalidRecordError when an id isn't a lowercase version 4 UUID.
     */
    public async detachBlob<K extends keyof Values & string>(collection: K, recordId: string, blobId: string): Promise<void>
    {
        const c = this._collection(collection);
        if (!isRecordId(recordId) || !isRecordId(blobId)) throw new InvalidRecordError(`Blob ${blobId} of record ${recordId} has an id that isn't a lowercase version 4 UUID.`);
        // A blob still waiting may be on the server already, from an import: deleting one that isn't there succeeds.
        await this._store.putBlob(c.name, { recordId, blobId, sealed: undefined });
    }

    /**
     * The user's identity: an ECDH key pair that messages to the user are sealed to, with conseal's `sealMessage` and
     * `unsealMessage`, and an ECDSA key pair that signs as the user. Every device in the circle holds the same pairs:
     * they travel in the keyring, which every sync pulls, and the first sync that finds none on the server creates.
     * A device that joins the circle, or recovers it from the mnemonic, gets them on its first sync. The private keys
     * can't be exported.
     *
     * When this device doesn't hold the keyring yet, it syncs first. It never hands out key pairs the server hasn't
     * taken: when two devices create the keyring at once, the one whose push conflicts takes the other's.
     *
     * @throws KeyringError when the keyring still isn't on this device after that sync: the sync didn't finish, or the
     * server's keyring doesn't open under this circle's AEK.
     * @throws whatever `sync` throws.
     */
    public async identity(): Promise<Identity>
    {
        let record = await this._store.get(KEYRING.name, KEYRING_RECORD_ID);
        if (!isSettled(record))
        {
            const report = await this.sync();
            record = await this._store.get(KEYRING.name, KEYRING_RECORD_ID);
            if (!isSettled(record))
            {
                if (record?.rejected === 'unreadable_conflict')
                {
                    throw new KeyringError('The server\'s keyring doesn\'t open under this circle\'s AEK.');
                }
                const failure = report.failed.find(failed => failed.collection === KEYRING.name);
                throw new KeyringError('The keyring isn\'t on this device yet: its sync didn\'t finish.', { cause: failure?.error });
            }
        }
        return openKeyring(record.value);
    }

    /**
     * This device's records as a file to keep or take elsewhere, made as it's read: write the chunks to a file as they
     * come. Each collection's values go in as JSON, without their local-only fields, with a manifest of the collections,
     * their `schemaVersion`s and their counts, and the blobs the records refer to as files of their own. Sync state and
     * keys never go in, the keyring included; a blob's DEK goes in only as part of its reference, beside the blob.
     *
     * Without a passcode it's a plain export, a ZIP anything can read, and it isn't encrypted: tell the user so. With
     * one, it's a sealed backup, which only the passcode opens. Records still pending here are included; sync first
     * for an export that matches the server. Blobs that have uploaded are downloaded as the export goes, so an export
     * with blobs needs the server; one the server no longer holds, or that doesn't open, is left out.
     */
    public exportAll(options: ExportOptions = {}): AsyncIterable<Uint8Array>
    {
        if (options.passcode !== undefined && options.passcode.length === 0) throw new TypeError('A sealed backup needs a passcode.');
        const archive = exportArchive([...this._collections.values()], this._store, new Date(), async (c, recordId, ref) => {
            const sealed = await this._sealedBlob(c, recordId, ref.id);
            if (sealed === undefined) return undefined;
            try
            {
                return await openSealedBlob(c.definition.id, recordId, ref, sealed);
            }
            catch (error)
            {
                if (error instanceof UnreadableRecordError) return undefined;
                throw error;
            }
        });
        return options.passcode === undefined ? archive : sealBackup(archive, options.passcode);
    }

    /**
     * Saves an export's or a sealed backup's records on this device, keeping their ids, so importing a file again,
     * or into the account it came from, adds nothing twice. Records this device lacks are added; those it holds with
     * another value are kept, unless `replace` is set, and an immutable collection's are always kept. What changed
     * is pending, as after `save`: the next sync pushes it, merging with the server as any change would. Sync first,
     * so this device holds the server's records: under `lastWriteWins`, a record it hasn't pulled yet would lose to
     * the file's older value. The whole file is checked first, so a damaged or partial one changes nothing. The blobs
     * of the records it adds or replaces wait on this device, sealed afresh, and upload with them on the next sync.
     *
     * @throws ArchiveError when the file isn't an export or backup this version reads, or is damaged.
     * @throws WrongPasscodeError when a sealed backup's passcode is missing or wrong.
     */
    public async importAll(file: Blob, options: ImportOptions = {}): Promise<ImportReport>
    {
        const source = await openArchive(file, options.passcode);
        const plan = await readArchive(source, [...this._collections.values()]);
        const report: ImportReport = { added: 0, replaced: 0, unchanged: 0, kept: 0, skipped: plan.skipped, blobs: 0 };

        for await (const { collection: c, record, blobs } of archiveRecords(source, plan))
        {
            const value = withoutLocalOnly(record.value, c.localOnly) as object;
            let outcome = 'unchanged' as 'added' | 'replaced' | 'unchanged' | 'kept';
            await this._write(c, record.id, current => {
                const held = current?.value;
                if (current === undefined || held === undefined)
                {
                    outcome = 'added';
                    return { id: record.id, value, version: current?.version, schemaVersion: record.schemaVersion, pending: true, rejected: undefined };
                }
                if (current.schemaVersion === record.schemaVersion && jsonEqual(withoutLocalOnly(held, c.localOnly), value))
                {
                    outcome = 'unchanged';
                    return current;
                }
                if (!options.replace || c.definition.immutable)
                {
                    outcome = 'kept';
                    return current;
                }
                outcome = 'replaced';
                return {
                    ...current,
                    value: withLocalOnly(value, held, c.localOnly),
                    schemaVersion: record.schemaVersion,
                    pending: true,
                    rejected: undefined,
                };
            });
            report[outcome]++;
            if (outcome !== 'added' && outcome !== 'replaced') continue;

            for (const ref of blobRefs(value))
            {
                const entry = blobs.get(ref.id);
                if (entry === undefined) continue;
                const sealed = await sealBlob(c.definition.id, record.id, ref, await readZipEntry(source, entry));
                await this._store.putBlob(c.name, { recordId: record.id, blobId: ref.id, sealed });
                report.blobs++;
            }
        }
        return report;
    }

    /** Calls `listener` for every event of every sync, until the returned function is called. */
    public subscribe(listener: (event: SyncEvent<Values>) => void): () => void
    {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /**
     * Pushes this device's changes and pulls the other devices', collection by collection. One sync runs at a time:
     * a call while one runs gets that run's report.
     *
     * A collection that fails, offline or on a server error, is reported in `failed` and the others carry on; when
     * the server's config can't be read, every collection is. The app decides when to try again.
     *
     * @throws whatever the keyring throws when the device is locked, before anything is sent.
     * @throws SyncTransportError with status 401 when the user isn't signed in.
     */
    public sync(): Promise<SyncReport>
    {
        this._running ??= this._run().finally(() => {
            this._running = undefined;
        });
        return this._running;
    }

    private async _run(): Promise<SyncReport>
    {
        const aek = await this._keyring.aek();
        const report: SyncReport = { pushed: 0, pulled: 0, merged: 0, failed: [] };
        const collections = [KEYRING, ...this._collections.values()];

        let config: SyncConfig;
        try
        {
            config = this._config ??= checkedConfig(await this._transport.getConfig());
        }
        catch (error)
        {
            if (error instanceof SyncTransportError && error.status === 401) throw error;
            report.failed = collections.map(c => ({ collection: c.name, error }));
            return report;
        }

        for (const c of collections)
        {
            const limits = config.collections.find(l => l.id === c.definition.id);
            if (limits === undefined)
            {
                // Read the limits again next time, in case the server's configuration catches up.
                this._config = undefined;
                report.failed.push({ collection: c.name, error: new SyncConfigError(`The server doesn't accept collection ${c.definition.id}.`) });
                continue;
            }

            try
            {
                if (c === KEYRING)
                {
                    await this._syncKeyring(aek, limits, config);
                    continue;
                }
                await this._uploadBlobs(c, limits);
                const counts = await this._push(c, aek, limits, config.maxBatchItems);
                report.pushed += counts.pushed;
                report.merged += counts.merged;
                await this._deleteBlobs(c);
                report.pulled += await this._pull(c, aek, config.maxPageItems);
            }
            catch (error)
            {
                if (error instanceof SyncTransportError && error.status === 401) throw error;
                if (error instanceof SyncTransportError && error.status === 404) this._config = undefined;
                report.failed.push({ collection: c.name, error });
            }
        }
        return report;
    }

    /**
     * Syncs the keyring, and creates it when neither this device nor the server holds one. The new keyring goes up
     * with no base version, so when another device's got there first, the push conflicts and this device takes that
     * one in place of its own.
     */
    private async _syncKeyring(aek: CryptoKey, limits: CollectionLimits, config: SyncConfig): Promise<void>
    {
        await this._push(KEYRING, aek, limits, config.maxBatchItems);
        await this._pull(KEYRING, aek, config.maxPageItems);
        if (await this._store.get(KEYRING.name, KEYRING_RECORD_ID) !== undefined) return;

        const value = await newKeyring();
        await this._write(KEYRING, KEYRING_RECORD_ID, current => current ?? {
            id: KEYRING_RECORD_ID,
            value,
            version: undefined,
            schemaVersion: KEYRING_SCHEMA_VERSION,
            pending: true,
            rejected: undefined,
        });
        await this._push(KEYRING, aek, limits, config.maxBatchItems);
    }

    /**
     * Uploads the collection's blobs waiting on this device, before any record is pushed, so a pushed record never
     * refers to a blob that isn't on the server. An upload that fails offline stops the collection's sync, records and
     * all.
     */
    private async _uploadBlobs(c: Collection, limits: CollectionLimits): Promise<void>
    {
        for (const { recordId, blobId } of await this._store.pendingBlobs(c.name))
        {
            const blob = await this._store.getBlob(c.name, recordId, blobId);
            if (blob?.sealed === undefined) continue;
            if (limits.maxBlobBytes === null)
            {
                // Read the limits again next time, in case the server's configuration catches up.
                this._config = undefined;
                throw new SyncConfigError(`The server has no blobs for collection ${c.definition.id}.`);
            }
            if (blob.sealed.byteLength > limits.maxBlobBytes)
            {
                await this._rejectBlob(c, blob);
                continue;
            }

            try
            {
                await this._transport.putBlob(c.definition.id, recordId, blobId, blob.sealed);
            }
            catch (error)
            {
                if (!(error instanceof SyncTransportError) || error.status !== 413) throw error;
                await this._rejectBlob(c, blob);
                continue;
            }
            // Detached while it uploaded: keep the delete that took its place.
            if ((await this._store.getBlob(c.name, recordId, blobId))?.sealed !== undefined) await this._store.removeBlob(c.name, recordId, blobId);
        }
    }

    /** A blob the server won't take: dropped, and the record that refers to it stops until the app changes it. */
    private async _rejectBlob(c: Collection, blob: PendingBlob): Promise<void>
    {
        await this._store.removeBlob(c.name, blob.recordId, blob.blobId);
        await this._write(c, blob.recordId, current => (current?.pending ? { ...current, rejected: 'blob_too_large' } : current));
        this._emit({ type: 'rejected', collection: c.name, id: blob.recordId, code: 'blob_too_large' });
    }

    /** Deletes the blobs detached on this device from the server, once their records are pushed without them. */
    private async _deleteBlobs(c: Collection): Promise<void>
    {
        for (const { recordId, blobId } of await this._store.pendingBlobs(c.name))
        {
            const blob = await this._store.getBlob(c.name, recordId, blobId);
            if (blob === undefined || blob.sealed !== undefined) continue;
            if ((await this._store.get(c.name, recordId))?.pending) continue;
            await this._transport.deleteBlob(c.definition.id, recordId, blobId);
            await this._store.removeBlob(c.name, recordId, blobId);
        }
    }

    /** A blob as sealed: waiting on this device, or on the server. Undefined when it's neither, or detached. */
    private async _sealedBlob(c: { name: string; definition: CollectionDefinition }, recordId: string, blobId: string): Promise<Uint8Array | undefined>
    {
        const pending = await this._store.getBlob(c.name, recordId, blobId);
        if (pending !== undefined) return pending.sealed;
        return this._transport.getBlob(c.definition.id, recordId, blobId);
    }

    private async _push(c: Collection, aek: CryptoKey, limits: CollectionLimits, maxBatchItems: number): Promise<PushCounts>
    {
        const counts: PushCounts = { pushed: 0, merged: 0 };
        // A merge leaves the record pending, so it goes again in the next round.
        for (let round = 0; round < MAX_PUSH_ROUNDS; round++)
        {
            const records = (await this._store.pending(c.name)).filter(record => record.rejected === undefined);
            if (records.length === 0) break;

            let conflicts = 0;
            for (let start = 0; start < records.length; start += maxBatchItems)
            {
                conflicts += await this._pushBatch(c, aek, limits, records.slice(start, start + maxBatchItems), counts);
            }
            if (conflicts === 0) break;
        }
        return counts;
    }

    /** Pushes one batch and settles each result, adding to `counts`. Returns how many items conflicted. */
    private async _pushBatch(c: Collection, aek: CryptoKey, limits: CollectionLimits, records: LocalRecord[], counts: PushCounts): Promise<number>
    {
        const items: PushItem[] = [];
        const sent: LocalRecord[] = [];
        for (const record of records)
        {
            const item = await this._pushItem(c, aek, limits, record);
            if (item === undefined) continue;
            items.push(item);
            sent.push(record);
        }
        if (items.length === 0) return 0;

        const results = await this._send(c.definition.id, items);
        let conflicts = 0;
        for (const [index, record] of sent.entries())
        {
            // `_send` checked there is one result per item, in order.
            const result = results[index] as PushResult;
            switch (result.status)
            {
                case 200:
                    await this._settlePushed(c, record, result);
                    counts.pushed++;
                    break;
                case 409:
                    conflicts++;
                    if (await this._settleConflict(c, aek, record, result)) counts.merged++;
                    break;
                case 400:
                    await this._reject(c, record, 'invalid_record');
                    break;
                case 413:
                    await this._reject(c, record, 'record_too_large');
                    break;
                default:
                    throw new SyncProtocolError(`The server answered record ${record.id} with status ${result.status}.`);
            }
        }
        return conflicts;
    }

    /** The push item for a pending record, or undefined when it has nothing to send. */
    private async _pushItem(c: Collection, aek: CryptoKey, limits: CollectionLimits, record: LocalRecord): Promise<PushItem | undefined>
    {
        if (record.value === undefined)
        {
            if (record.version !== undefined) return { id: record.id, baseVersion: record.version, deleted: true };

            // Deleted before it ever reached the server: there is nothing to tell it.
            await this._write(c, record.id, current => (current?.rev === record.rev ? undefined : current));
            return undefined;
        }

        const plaintext = { ...withoutLocalOnly(record.value, c.localOnly), schemaVersion: record.schemaVersion };
        const { sealed, ciphertextBytes } = await sealRecord(aek, c.definition.id, record.id, plaintext);
        if (ciphertextBytes > limits.maxRecordBytes)
        {
            await this._reject(c, record, 'record_too_large');
            return undefined;
        }
        return { id: record.id, baseVersion: record.version ?? null, deleted: false, ...sealed };
    }

    /** Pushes items, halving the batch while the server finds the request too large. */
    private async _send(collectionId: string, items: PushItem[]): Promise<PushResult[]>
    {
        let results: PushResult[];
        try
        {
            results = await this._transport.push(collectionId, items);
        }
        catch (error)
        {
            if (!(error instanceof SyncTransportError) || error.status !== 413 || items.length === 1) throw error;
            const half = Math.ceil(items.length / 2);
            return [...await this._send(collectionId, items.slice(0, half)), ...await this._send(collectionId, items.slice(half))];
        }

        if (results.length !== items.length || results.some((result, index) => result.id !== items[index]?.id))
        {
            throw new SyncProtocolError('The server\'s push results don\'t match the items pushed.');
        }
        return results;
    }

    private async _settlePushed(c: Collection, record: LocalRecord, result: PushResult): Promise<void>
    {
        const version = result.version;
        if (version === undefined) throw new SyncProtocolError(`The server accepted record ${record.id} without a version.`);

        await this._write(c, record.id, current => {
            if (current === undefined) return current;
            // Changed since it was sealed: the new change builds on the version just written, and stays pending.
            if (current.rev !== record.rev) return { ...current, version };
            // The server holds the tombstone; this device needs nothing more.
            if (current.value === undefined) return undefined;
            return { ...current, version, pending: false };
        });
    }

    /** Merges the current record a conflict carries. Returns false when it doesn't open, and the record stops retrying. */
    private async _settleConflict(c: Collection, aek: CryptoKey, record: LocalRecord, result: PushResult): Promise<boolean>
    {
        const current = result.current;
        if (current === undefined) throw new SyncProtocolError(`The server's conflict on record ${record.id} carries no current record.`);
        if (current !== null && current.id !== record.id)
        {
            throw new SyncProtocolError(`The server's conflict on record ${record.id} carries record ${current.id}.`);
        }

        const remote = current === null
            ? { value: undefined, version: undefined, schemaVersion: undefined }
            : await this._openOrReport(c, aek, current);
        if (remote === undefined)
        {
            // Nothing to merge with. Overwriting it could destroy another device's data if the fault is this device's.
            await this._reject(c, record, 'unreadable_conflict');
            return false;
        }
        await this._integrate(c, record.id, remote);
        return true;
    }

    private async _reject(c: Collection, record: LocalRecord, code: RejectionCode): Promise<void>
    {
        const { before, after } = await this._write(c, record.id, current => (
            current?.rev === record.rev ? { ...current, rejected: code } : current
        ));
        if (before !== after) this._emit({ type: 'rejected', collection: c.name, id: record.id, code });
    }

    /** Pulls every page written since the collection's cursor. Returns how many records came. */
    private async _pull(c: Collection, aek: CryptoKey, maxPageItems: number): Promise<number>
    {
        let cursor = await this._store.getCursor(c.name);
        let pulled = 0;
        while (true)
        {
            let page: SyncPage;
            try
            {
                page = await this._transport.pull(c.definition.id, cursor, maxPageItems);
            }
            catch (error)
            {
                if (cursor === undefined || !isInvalidCursor(error)) throw error;
                // The server can't resume from this cursor: start again from the beginning, which merges idempotently.
                cursor = undefined;
                await this._store.setCursor(c.name, undefined);
                continue;
            }

            for (const item of page.items)
            {
                await this._pullItem(c, aek, item);
            }
            pulled += page.items.length;
            await this._store.setCursor(c.name, page.cursor);

            if (!page.hasMore) return pulled;
            if (page.items.length === 0) throw new SyncProtocolError('The server said more records wait, and sent none.');
            cursor = page.cursor;
        }
    }

    private async _pullItem(c: Collection, aek: CryptoKey, item: SyncRecord): Promise<void>
    {
        // This device's own write coming back, or a page pulled again: nothing new.
        const local = await this._store.get(c.name, item.id);
        if (local?.version === item.version) return;

        const remote = await this._openOrReport(c, aek, item);
        if (remote !== undefined) await this._integrate(c, item.id, remote);
    }

    /** Opens a server record, or reports it unreadable and returns undefined. */
    private async _openOrReport(c: Collection, aek: CryptoKey, record: SyncRecord): Promise<RemoteState | undefined>
    {
        if (record.deletedAt) return { value: undefined, version: record.version, schemaVersion: undefined };

        try
        {
            if (record.ciphertext === null || record.iv === null || record.wrappedDek === null)
            {
                throw new UnreadableRecordError(`Record ${record.id} is live but carries no ciphertext.`);
            }
            const sealed = { ciphertext: record.ciphertext, iv: record.iv, wrappedDek: record.wrappedDek };
            const { schemaVersion, ...value } = await openRecord(aek, c.definition.id, record.id, sealed);
            if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1)
            {
                throw new UnreadableRecordError(`Record ${record.id} carries no valid schemaVersion.`);
            }
            return { value, version: record.version, schemaVersion };
        }
        catch (error)
        {
            if (!(error instanceof UnreadableRecordError)) throw error;
            this._emit({ type: 'unreadable', collection: c.name, id: record.id });
            return undefined;
        }
    }

    /**
     * Brings a record's server state into this device's copy through the collection's merge policy. The result is in
     * step with the server when it equals the remote value; otherwise it stays pending, building on the remote version,
     * and the next push sends it.
     */
    private async _integrate(c: Collection, id: string, remote: RemoteState): Promise<void>
    {
        const { before, after } = await this._write(c, id, current => {
            if (current === undefined)
            {
                if (remote.value === undefined) return current;
                return {
                    id,
                    value: withoutLocalOnly(remote.value, c.localOnly),
                    version: remote.version,
                    schemaVersion: remote.schemaVersion ?? c.definition.schemaVersion,
                    pending: false,
                    rejected: undefined,
                };
            }

            const merged = c.merge({ local: current.value, remote: remote.value, pending: current.pending });
            const value = merged === undefined ? undefined : withLocalOnly(merged, current.value, c.localOnly);
            const inStep = jsonEqual(withoutLocalOnly(merged, c.localOnly), withoutLocalOnly(remote.value, c.localOnly));
            // Deleted on both sides: nothing left to keep.
            if (inStep && value === undefined) return undefined;

            return {
                ...current,
                value,
                version: remote.version,
                schemaVersion: Math.max(current.schemaVersion, remote.schemaVersion ?? 0),
                pending: !inStep,
                // A rejected change stays rejected only while the value is the one the server refused.
                rejected: !inStep && jsonEqual(value, current.value) ? current.rejected : undefined,
            };
        });

        if (!jsonEqual(before?.value, after?.value))
        {
            // The event's collection and value types match: `c` is the collection named `c.name`.
            this._emit({ type: 'changed', collection: c.name, id, value: after?.value } as SyncEvent<Values>);
        }
    }

    /**
     * Changes one stored record as a compare-and-set, so a write never overwrites a change it didn't see: `change`
     * gets the stored record and returns the next one, undefined to delete it, or the same one to leave it. It may
     * run more than once, so it must have no side effects.
     */
    private async _write(
        c: Collection,
        id: string,
        change: (current: LocalRecord | undefined) => RecordChange | undefined,
    ): Promise<{ before: LocalRecord | undefined; after: LocalRecord | undefined }>
    {
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++)
        {
            const current = await this._store.get(c.name, id);
            const next = change(current);
            if (next === current) return { before: current, after: current };

            const record = next && { ...next, rev: (current?.rev ?? 0) + 1 };
            if (await this._store.put(c.name, id, record, current?.rev)) return { before: current, after: record };
        }
        throw new SyncError(`Record ${id} kept changing while the engine wrote it.`);
    }

    private _collection(name: string): Collection
    {
        const c = this._collections.get(name);
        if (c === undefined) throw new SyncConfigError(`The registry has no collection named ${name}.`);
        return c;
    }

    private _emit(event: SyncEvent<Values>): void
    {
        // The keyring isn't one of the app's collections, and its value is key material. `identity` reports its state.
        if (event.collection === KEYRING.name) return;
        for (const listener of this._listeners)
        {
            listener(event);
        }
    }
}

/** The server's config, once its limits are known to be usable: a zero batch size would never finish a push. */
function checkedConfig(config: SyncConfig): SyncConfig
{
    const limits = [config.maxBatchItems, config.maxPageItems, ...config.collections.map(c => c.maxRecordBytes)];
    if (!limits.every(limit => Number.isInteger(limit) && limit >= 1))
    {
        throw new SyncProtocolError('The server\'s config has a limit that isn\'t a whole number from 1.');
    }
    return config;
}

/** Whether this device holds the keyring as the server does: a pending one may yet lose to another device's. */
function isSettled(record: LocalRecord | undefined): record is LocalRecord & { value: object }
{
    return record !== undefined && record.value !== undefined && !record.pending;
}

function isInvalidCursor(error: unknown): boolean
{
    return error instanceof SyncTransportError && error.status === 400 && error.code === 'invalid_cursor';
}
