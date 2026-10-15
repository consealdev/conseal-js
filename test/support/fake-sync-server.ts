import { fromBase64 } from '../../src/core/index.js';
import { SyncTransportError } from '../../src/sync/errors.js';
import { KEYRING_COLLECTION } from '../../src/sync/identity.js';
import type { PushItem, PushResult, SyncConfig, SyncPage, SyncRecord, SyncTransport } from '../../src/sync/sync-transport.js';

export interface FakeSyncServerOptions
{
    /**
     * The app's collections. The server accepts `keyring` too, as the contract has it. A collection has blobs when it
     * sets `maxBlobBytes`.
     */
    collections: { id: string; maxRecordBytes?: number; maxBlobBytes?: number }[];
    maxBatchItems?: number;
    maxPageItems?: number;
}

/**
 * One user's sync data as an honest server keeps it, in memory, following the contract: `seq` rises in commit order,
 * pulls are ascending and never skip a write, every write is checked against `baseVersion`, and a delete leaves a
 * tombstone, which deletes the record's blobs too.
 */
export class FakeSyncServer
{
    /** Each collection's records by id, as the server stores them. */
    public readonly records = new Map<string, Map<string, SyncRecord>>();
    /** Every push the server received, to count requests. */
    public readonly pushes: { collectionId: string; items: PushItem[] }[] = [];
    /** Each sealed blob the storage holds, by `<collectionId>/<recordId>/<blobId>`. */
    public readonly blobs = new Map<string, Uint8Array>();
    private readonly _config: SyncConfig;
    private _seq = 0;

    constructor(options: FakeSyncServerOptions)
    {
        const collections: FakeSyncServerOptions['collections'] = [{ id: KEYRING_COLLECTION }, ...options.collections];
        this._config = {
            collections: collections.map(c => ({ id: c.id, maxRecordBytes: c.maxRecordBytes ?? 291_000, maxBlobBytes: c.maxBlobBytes ?? null })),
            maxBatchItems: options.maxBatchItems ?? 100,
            maxPageItems: options.maxPageItems ?? 1000,
        };
        for (const c of collections)
        {
            this.records.set(c.id, new Map());
        }
    }

    public transport(): SyncTransport
    {
        return {
            getConfig: async () => structuredClone(this._config),
            pull: async (collectionId, cursor, limit) => this._pull(collectionId, cursor, limit),
            push: async (collectionId, items) => this._push(collectionId, items),
            putBlob: async (collectionId, recordId, blobId, sealed) => {
                const limit = this._blobLimit(collectionId);
                if (sealed.byteLength < 28) throw new SyncTransportError(400, { code: 'invalid_request' });
                if (sealed.byteLength > limit) throw new SyncTransportError(413, { code: 'blob_too_large' });
                this.blobs.set(`${collectionId}/${recordId}/${blobId}`, sealed.slice());
            },
            getBlob: async (collectionId, recordId, blobId) => {
                this._blobLimit(collectionId);
                return this.blobs.get(`${collectionId}/${recordId}/${blobId}`)?.slice();
            },
            deleteBlob: async (collectionId, recordId, blobId) => {
                this._blobLimit(collectionId);
                this.blobs.delete(`${collectionId}/${recordId}/${blobId}`);
            },
        };
    }

    private _pull(collectionId: string, cursor: string | undefined, limit: number): SyncPage
    {
        const records = this._collection(collectionId);
        const after = cursor === undefined ? 0 : this._decodeCursor(collectionId, cursor);
        const waiting = [...records.values()].filter(r => r.seq > after).sort((a, b) => a.seq - b.seq);
        const items = waiting.slice(0, Math.min(limit, this._config.maxPageItems));
        const last = items.at(-1)?.seq ?? after;
        return { items: structuredClone(items), cursor: `${collectionId}:${last}`, hasMore: waiting.length > items.length };
    }

    private _push(collectionId: string, items: PushItem[]): PushResult[]
    {
        const records = this._collection(collectionId);
        const limits = this._config.collections.find(c => c.id === collectionId);
        if (items.length === 0) throw new SyncTransportError(400, { code: 'invalid_request' });
        if (items.length > this._config.maxBatchItems) throw new SyncTransportError(413, { code: 'too_many_items' });
        if (new Set(items.map(item => item.id)).size !== items.length) throw new SyncTransportError(400, { code: 'duplicate_id' });
        this.pushes.push({ collectionId, items: structuredClone(items) });

        return items.map(item => {
            const existing = records.get(item.id);
            if (item.baseVersion !== (existing?.version ?? null))
            {
                return { id: item.id, status: 409, current: existing ? structuredClone(existing) : null };
            }
            if (!item.deleted && fromBase64(item.ciphertext).length > (limits?.maxRecordBytes ?? 0))
            {
                return { id: item.id, status: 413, error: { code: 'record_too_large', message: 'Over maxRecordBytes.' } };
            }

            const record: SyncRecord = item.deleted
                ? { id: item.id, ciphertext: null, iv: null, wrappedDek: null, version: crypto.randomUUID(), seq: ++this._seq, deletedAt: new Date().toISOString() }
                : { id: item.id, ciphertext: item.ciphertext, iv: item.iv, wrappedDek: item.wrappedDek, version: crypto.randomUUID(), seq: ++this._seq, deletedAt: null };
            records.set(item.id, record);
            if (item.deleted) this._deleteBlobsOf(collectionId, item.id);
            return { id: item.id, status: 200, version: record.version, seq: record.seq };
        });
    }

    /** The collection's `maxBlobBytes`, or the contract's `404` when it has no blobs. */
    private _blobLimit(collectionId: string): number
    {
        this._collection(collectionId);
        const limit = this._config.collections.find(c => c.id === collectionId)?.maxBlobBytes;
        if (limit === null || limit === undefined) throw new SyncTransportError(404, { code: 'blobs_disabled' });
        return limit;
    }

    private _deleteBlobsOf(collectionId: string, recordId: string): void
    {
        for (const key of [...this.blobs.keys()])
        {
            if (key.startsWith(`${collectionId}/${recordId}/`)) this.blobs.delete(key);
        }
    }

    private _collection(collectionId: string): Map<string, SyncRecord>
    {
        const records = this.records.get(collectionId);
        if (!records) throw new SyncTransportError(404, { code: 'unknown_collection' });
        return records;
    }

    /** A real cursor is signed; this one is only checked for the collection it was issued for. */
    private _decodeCursor(collectionId: string, cursor: string): number
    {
        const match = /^(.+):(\d+)$/.exec(cursor);
        if (!match || match[1] !== collectionId) throw new SyncTransportError(400, { code: 'invalid_cursor' });
        return Number(match[2]);
    }
}
