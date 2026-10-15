/** Why the engine stopped retrying a record's pending change. The next local change to the record clears it. */
export type RejectionCode =
    /** The server refused the record as malformed (`400`). */
    | 'invalid_record'
    /** The sealed record is over the collection's `maxRecordBytes`: move content to a blob, or split the record. */
    | 'record_too_large'
    /** A blob the record refers to is over the collection's `maxBlobBytes`. It won't upload: detach it. */
    | 'blob_too_large'
    /** The server answered a push with a conflict whose current record doesn't open, so there is nothing to merge. */
    | 'unreadable_conflict';

/** One record as this device holds it: the plaintext and its sync state. */
export interface LocalRecord
{
    id: string;
    /** The plaintext, local-only fields included; undefined when this device deleted it and the delete isn't pushed. */
    value: object | undefined;
    /** The server version this copy builds on; undefined when the server has never held it. */
    version: string | undefined;
    /** The `schemaVersion` the value is written in. */
    schemaVersion: number;
    /** Whether the value has a change the server doesn't have yet. */
    pending: boolean;
    /** Set when the engine stopped retrying the pending change. */
    rejected: RejectionCode | undefined;
    /** Rises on every write to the record: the token `put` compares, so no write overwrites one it didn't see. */
    rev: number;
}

/** A blob change waiting for the next sync: a sealed blob to upload, or a blob to delete from the server. */
export interface PendingBlob
{
    recordId: string;
    blobId: string;
    /** The sealed blob to upload; undefined to delete the blob from the server. */
    sealed: Uint8Array | undefined;
}

/**
 * Where the app keeps its records on the device, in plaintext: IndexedDB, OPFS, or memory. Collections are named by
 * the registry's names, which never leave the device, and by `KEYRING_COLLECTION`, the engine's own, which holds the
 * user's identity: a store that sets up a place per collection, such as an IndexedDB object store, sets up that one
 * too. Beside the records it keeps each collection's blob changes waiting for a sync, which hold sealed blobs, so a
 * blob attached offline stays on the device until it uploads. The engine reads and writes only through these methods,
 * and keeps nothing else.
 */
export interface RecordStore
{
    get(collection: string, id: string): Promise<LocalRecord | undefined>;

    /**
     * Writes `record`, or deletes the stored record when it's undefined, only if the stored record's `rev` is still
     * `expectedRev` (undefined: no stored record). Returns whether it wrote. The check and the write are one atomic
     * step, such as one IndexedDB transaction.
     */
    put(collection: string, id: string, record: LocalRecord | undefined, expectedRev: number | undefined): Promise<boolean>;

    /** The records with `pending` set. */
    pending(collection: string): Promise<LocalRecord[]>;

    /**
     * Up to `limit` of the collection's records in id order, from the first id after `after`, or from the start when
     * it's undefined. Export pages through a collection with it, so a page needn't be one consistent snapshot.
     */
    list(collection: string, after: string | undefined, limit: number): Promise<LocalRecord[]>;

    /** Where the collection's next pull starts; undefined to start from the beginning. */
    getCursor(collection: string): Promise<string | undefined>;

    setCursor(collection: string, cursor: string | undefined): Promise<void>;

    /** A blob change waiting for a sync; undefined when there is none. */
    getBlob(collection: string, recordId: string, blobId: string): Promise<PendingBlob | undefined>;

    /** Stores a blob change, in place of any the blob has. */
    putBlob(collection: string, blob: PendingBlob): Promise<void>;

    /** Drops a blob change, once it's done or no longer needed. */
    removeBlob(collection: string, recordId: string, blobId: string): Promise<void>;

    /** The record and blob ids of the collection's blob changes, without their bytes. */
    pendingBlobs(collection: string): Promise<{ recordId: string; blobId: string }[]>;
}

/** A `RecordStore` in memory, for tests and for Node. Records are copied in and out, as IndexedDB copies them. */
export class MemoryRecordStore implements RecordStore
{
    private readonly _collections = new Map<string, Map<string, LocalRecord>>();
    private readonly _cursors = new Map<string, string>();
    private readonly _blobs = new Map<string, Map<string, PendingBlob>>();

    public async get(collection: string, id: string): Promise<LocalRecord | undefined>
    {
        const record = this._records(collection).get(id);
        return record && structuredClone(record);
    }

    public async put(collection: string, id: string, record: LocalRecord | undefined, expectedRev: number | undefined): Promise<boolean>
    {
        const records = this._records(collection);
        if (records.get(id)?.rev !== expectedRev) return false;

        if (record === undefined) records.delete(id);
        else records.set(id, structuredClone(record));
        return true;
    }

    public async pending(collection: string): Promise<LocalRecord[]>
    {
        return [...this._records(collection).values()].filter(record => record.pending).map(record => structuredClone(record));
    }

    public async list(collection: string, after: string | undefined, limit: number): Promise<LocalRecord[]>
    {
        return [...this._records(collection).values()]
            .filter(record => after === undefined || record.id > after)
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, limit)
            .map(record => structuredClone(record));
    }

    public async getCursor(collection: string): Promise<string | undefined>
    {
        return this._cursors.get(collection);
    }

    public async setCursor(collection: string, cursor: string | undefined): Promise<void>
    {
        if (cursor === undefined) this._cursors.delete(collection);
        else this._cursors.set(collection, cursor);
    }

    public async getBlob(collection: string, recordId: string, blobId: string): Promise<PendingBlob | undefined>
    {
        const blob = this._blobsOf(collection).get(`${recordId}/${blobId}`);
        return blob && structuredClone(blob);
    }

    public async putBlob(collection: string, blob: PendingBlob): Promise<void>
    {
        this._blobsOf(collection).set(`${blob.recordId}/${blob.blobId}`, structuredClone(blob));
    }

    public async removeBlob(collection: string, recordId: string, blobId: string): Promise<void>
    {
        this._blobsOf(collection).delete(`${recordId}/${blobId}`);
    }

    public async pendingBlobs(collection: string): Promise<{ recordId: string; blobId: string }[]>
    {
        return [...this._blobsOf(collection).values()].map(({ recordId, blobId }) => ({ recordId, blobId }));
    }

    private _blobsOf(collection: string): Map<string, PendingBlob>
    {
        let blobs = this._blobs.get(collection);
        if (!blobs)
        {
            blobs = new Map();
            this._blobs.set(collection, blobs);
        }
        return blobs;
    }

    private _records(collection: string): Map<string, LocalRecord>
    {
        let records = this._collections.get(collection);
        if (!records)
        {
            records = new Map();
            this._collections.set(collection, records);
        }
        return records;
    }
}
