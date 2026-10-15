/**
 * The wire types of the sync contract, `openapi.yaml` in conseal-sync-spec. Binary fields are standard base64 with
 * padding.
 */

/** A collection the server accepts, and its limits. */
export interface CollectionLimits
{
    id: string;
    /** The largest decoded `ciphertext` a record may have, in bytes. */
    maxRecordBytes: number;
    /** The largest sealed blob, in bytes; null when the collection has no blobs. */
    maxBlobBytes: number | null;
}

/** What `GET /` returns: the collections the server accepts and the limits a client keeps to. */
export interface SyncConfig
{
    collections: CollectionLimits[];
    maxBatchItems: number;
    maxPageItems: number;
}

/** A record as the server holds it. A tombstone has `deletedAt` set and no ciphertext. */
export interface SyncRecord
{
    id: string;
    ciphertext: string | null;
    iv: string | null;
    wrappedDek: string | null;
    version: string;
    seq: number;
    deletedAt: string | null;
}

/** One page of a pull. */
export interface SyncPage
{
    items: SyncRecord[];
    /** Where the next pull starts. */
    cursor: string;
    hasMore: boolean;
}

/** Creates a record, or replaces the version named by `baseVersion`. */
export interface RecordWrite
{
    id: string;
    /** Null to create the record. */
    baseVersion: string | null;
    deleted: false;
    ciphertext: string;
    iv: string;
    wrappedDek: string;
}

/** Tombstones the version named by `baseVersion`. */
export interface RecordDelete
{
    id: string;
    baseVersion: string;
    deleted: true;
}

export type PushItem = RecordWrite | RecordDelete;

/** The contract's error body. */
export interface SyncErrorBody
{
    code: string;
    message: string;
}

/** The outcome of one pushed item. */
export interface PushResult
{
    id: string;
    status: number;
    /** Set on a `200`. */
    version?: string | undefined;
    seq?: number | undefined;
    /** Set on a `409`: the server's record, null when it has none. */
    current?: SyncRecord | null | undefined;
    /** Set on a `400` or `413`. */
    error?: SyncErrorBody | undefined;
}

/** What `POST` and `GET /{collectionId}/{recordId}/blobs/{blobId}` return: a presigned storage URL and how to call it. */
export interface BlobUrl
{
    url: string;
    method: 'PUT' | 'GET';
    /** Headers to send with the request, exactly as given. */
    headers: Record<string, string>;
    expiresAt: string;
}

/**
 * The app's side of the sync routes: its HTTP client, sign-in and base URL. The engine holds every cryptographic
 * step and all the sync logic; a transport only carries the contract's requests and answers, and a blob's bytes to and
 * from the storage URLs the server presigns.
 *
 * Every method throws `SyncTransportError` for an answer that isn't a success, with the status and the body's
 * `code`, and lets network failures through as they are. `FetchSyncTransport` is one, for the sync routes of
 * conseal-sync-spec.
 */
export interface SyncTransport
{
    /** `GET /` */
    getConfig(): Promise<SyncConfig>;

    /** `GET /{collectionId}` */
    pull(collectionId: string, cursor: string | undefined, limit: number): Promise<SyncPage>;

    /** `POST /{collectionId}`. Returns the response's `results`. */
    push(collectionId: string, items: PushItem[]): Promise<PushResult[]>;

    /**
     * Uploads a sealed blob: `POST /{collectionId}/{recordId}/blobs/{blobId}` with its size, then the upload to the
     * storage URL that returns. A failed upload throws `SyncTransportError` with the storage's status.
     */
    putBlob(collectionId: string, recordId: string, blobId: string, sealed: Uint8Array): Promise<void>;

    /**
     * Downloads a sealed blob: `GET /{collectionId}/{recordId}/blobs/{blobId}`, then the download from the storage URL
     * that returns. Undefined when the storage holds no such blob.
     */
    getBlob(collectionId: string, recordId: string, blobId: string): Promise<Uint8Array | undefined>;

    /** `DELETE /{collectionId}/{recordId}/blobs/{blobId}`. Deleting a blob that isn't there succeeds. */
    deleteBlob(collectionId: string, recordId: string, blobId: string): Promise<void>;
}
