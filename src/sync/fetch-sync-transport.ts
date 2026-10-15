import { toArrayBuffer } from './encoding.js';
import { SyncProtocolError, SyncTransportError } from './errors.js';
import { FetchClient, field, isArray, isBoolean, isObject, isString, type FetchFunction, type FetchTransportOptions } from './fetch-client.js';
import type { BlobUrl, PushItem, PushResult, SyncConfig, SyncPage, SyncRecord, SyncTransport } from './sync-transport.js';

export interface FetchSyncTransportOptions extends FetchTransportOptions
{
    /**
     * The `fetch` for the storage URLs the server presigns. It must not add the app's sign-in: a presigned URL carries
     * its own, and object storage refuses a request that carries two. Defaults to the global one.
     */
    blobFetch?: FetchFunction | undefined;
}

/**
 * A `SyncTransport` over `fetch`, for the sync routes of conseal-sync-spec (`openapi.yaml`), which a backend such as
 * `ConsealDev.ConsealSync` serves. The app's `fetch` carries its sign-in; a blob's bytes go to and from object storage
 * directly, through the URLs the server presigns.
 *
 * Every method throws `SyncTransportError` for an answer that isn't a success, with the status, the body's `code` and
 * `Retry-After`, and `SyncProtocolError` for a success the contract doesn't allow. A network failure comes through as
 * `fetch` threw it.
 */
export class FetchSyncTransport implements SyncTransport
{
    private readonly _client: FetchClient;
    private readonly _blobFetch: FetchFunction;

    constructor(options: FetchSyncTransportOptions)
    {
        this._client = new FetchClient(options);
        // Called as a plain function, as FetchClient calls the app's fetch, so `window.fetch` itself works here too.
        const blobFetch = options.blobFetch;
        this._blobFetch = blobFetch === undefined
            ? (url, init) => globalThis.fetch(url, init)
            : (url, init) => blobFetch(url, init);
    }

    public async getConfig(): Promise<SyncConfig>
    {
        const body = await this._client.send('GET', '');
        // The engine checks the limits it uses.
        field(body, 'collections', isArray);
        return body as SyncConfig;
    }

    public async pull(collectionId: string, cursor: string | undefined, limit: number): Promise<SyncPage>
    {
        const query = new URLSearchParams({ limit: String(limit) });
        if (cursor !== undefined) query.set('cursor', cursor);
        const body = await this._client.send('GET', `/${encodeURIComponent(collectionId)}?${query}`);
        return {
            items: field(body, 'items', isArray) as SyncRecord[],
            cursor: field(body, 'cursor', isString),
            hasMore: field(body, 'hasMore', isBoolean),
        };
    }

    public async push(collectionId: string, items: PushItem[]): Promise<PushResult[]>
    {
        const body = await this._client.send('POST', `/${encodeURIComponent(collectionId)}`, { items });
        return field(body, 'results', isArray) as PushResult[];
    }

    public async putBlob(collectionId: string, recordId: string, blobId: string, sealed: Uint8Array): Promise<void>
    {
        const target = blobUrl(await this._client.send('POST', blobPath(collectionId, recordId, blobId), { size: sealed.byteLength }), 'PUT');
        const response = await this._blobFetch(target.url, { method: 'PUT', headers: target.headers, body: toArrayBuffer(sealed) });
        if (!response.ok) throw storageError(response, 'upload');
    }

    public async getBlob(collectionId: string, recordId: string, blobId: string): Promise<Uint8Array | undefined>
    {
        const target = blobUrl(await this._client.send('GET', blobPath(collectionId, recordId, blobId)), 'GET');
        const response = await this._blobFetch(target.url, { method: 'GET', headers: target.headers });
        if (response.status === 404) return undefined;
        if (!response.ok) throw storageError(response, 'download');
        return new Uint8Array(await response.arrayBuffer());
    }

    public async deleteBlob(collectionId: string, recordId: string, blobId: string): Promise<void>
    {
        await this._client.send('DELETE', blobPath(collectionId, recordId, blobId));
    }
}

function blobPath(collectionId: string, recordId: string, blobId: string): string
{
    return `/${encodeURIComponent(collectionId)}/${encodeURIComponent(recordId)}/blobs/${encodeURIComponent(blobId)}`;
}

/** A presigned URL from the server, checked, so a server that breaks the contract can't send the blob elsewhere unnoticed. */
function blobUrl(body: unknown, method: BlobUrl['method']): BlobUrl
{
    const headers = field(body, 'headers', isObject) as Record<string, unknown>;
    if (!Object.values(headers).every(isString)) throw new SyncProtocolError('The server\'s blob URL has a header that isn\'t a string.');
    if (field(body, 'method', isString) !== method) throw new SyncProtocolError(`The server's blob URL isn't for a ${method}.`);
    return {
        url: field(body, 'url', isString),
        method,
        headers: headers as Record<string, string>,
        expiresAt: field(body, 'expiresAt', isString),
    };
}

/** Object storage answers in its own format, not the contract's, so only the status is kept. */
function storageError(response: Response, transfer: 'upload' | 'download'): SyncTransportError
{
    return new SyncTransportError(response.status, { message: `The storage answered the blob ${transfer} with ${response.status}.` });
}
