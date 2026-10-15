import { generateAesKey } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { defineCollections, newRecordId } from '../../src/sync/collections.js';
import { SyncProtocolError, SyncTransportError } from '../../src/sync/errors.js';
import { FetchSyncTransport } from '../../src/sync/fetch-sync-transport.js';
import { MemoryRecordStore } from '../../src/sync/record-store.js';
import { SyncEngine } from '../../src/sync/sync-engine.js';
import type { PushItem, SyncConfig, SyncTransport } from '../../src/sync/sync-transport.js';
import { errorAnswer, stubFetch, type SentRequest, type StubAnswer, type StubFetch } from '../support/stub-fetch.js';

const BASE = 'https://api.test/sync';
const NOTES = '7f3a9c21';

const CONFIG: SyncConfig = {
    collections: [
        { id: 'keyring', maxRecordBytes: 202_752, maxBlobBytes: null },
        { id: NOTES, maxRecordBytes: 202_752, maxBlobBytes: null },
    ],
    maxBatchItems: 100,
    maxPageItems: 1000,
};

const ITEM: PushItem = {
    id: '0f9e4b1c-7d2a-4e8f-9b3c-5a6d7e8f9a0b',
    baseVersion: null,
    deleted: false,
    ciphertext: 'AA==',
    iv: 'AA==',
    wrappedDek: 'AA==',
};

function transport(answer: (request: SentRequest) => StubAnswer): { transport: FetchSyncTransport; stub: StubFetch }
{
    const stub = stubFetch(answer);
    return { transport: new FetchSyncTransport({ baseUrl: BASE, fetch: stub.fetch }), stub };
}

/** The routes of the sync contract, by the transport method that calls them. */
const ROUTES: Record<string, (t: SyncTransport) => Promise<unknown>> = {
    getConfig: t => t.getConfig(),
    pull: t => t.pull(NOTES, 'c1', 50),
    push: t => t.push(NOTES, [ITEM]),
};

describe('FetchSyncTransport', () => {
    it('reads the config from the base URL', async () => {
        const { transport: t, stub } = transport(() => ({ status: 200, body: CONFIG }));

        expect(await t.getConfig()).toEqual(CONFIG);
        expect(stub.sent.map(r => `${r.method} ${r.url}`)).toEqual([`GET ${BASE}`]);
    });

    it('pulls a page with the limit and the cursor in the query', async () => {
        const page = { items: [], cursor: 'c2', hasMore: false };
        const { transport: t, stub } = transport(() => ({ status: 200, body: page }));

        expect(await t.pull(NOTES, 'c1.signed', 50)).toEqual(page);
        expect(stub.sent[0]?.url).toBe(`${BASE}/${NOTES}?limit=50&cursor=c1.signed`);
    });

    it('leaves the cursor out of a first pull', async () => {
        const { transport: t, stub } = transport(() => ({ status: 200, body: { items: [], cursor: 'c1', hasMore: false } }));

        await t.pull(NOTES, undefined, 50);

        expect(stub.sent[0]?.url).toBe(`${BASE}/${NOTES}?limit=50`);
    });

    it('pushes the items and returns every result, rejected items included', async () => {
        const results = [
            { id: ITEM.id, status: 200, version: 'v1', seq: 1 },
            { id: 'b', status: 400, error: { code: 'invalid_record', message: 'No iv.' } },
            { id: 'c', status: 413, error: { code: 'record_too_large', message: 'Over 202752 bytes.' } },
        ];
        const { transport: t, stub } = transport(() => ({ status: 200, body: { results } }));

        expect(await t.push(NOTES, [ITEM])).toEqual(results);
        expect(stub.sent[0]).toMatchObject({ method: 'POST', url: `${BASE}/${NOTES}`, body: { items: [ITEM] } });
    });

    it.each<[string, number, string]>([
        ['getConfig', 401, 'unauthenticated'],
        ['getConfig', 429, 'rate_limited'],
        ['pull', 400, 'invalid_request'],
        ['pull', 400, 'invalid_cursor'],
        ['pull', 401, 'unauthenticated'],
        ['pull', 404, 'unknown_collection'],
        ['pull', 429, 'rate_limited'],
        ['push', 400, 'invalid_request'],
        ['push', 400, 'duplicate_id'],
        ['push', 401, 'unauthenticated'],
        ['push', 404, 'unknown_collection'],
        ['push', 413, 'too_many_items'],
        ['push', 413, 'request_too_large'],
        ['push', 429, 'rate_limited'],
    ])('throws %s answering %i %s as a SyncTransportError', async (route, status, code) => {
        const { transport: t } = transport(() => errorAnswer(status, code));

        const error = await ROUTES[route]?.(t).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SyncTransportError);
        expect(error).toMatchObject({ status, code });
    });

    it.each(Object.keys(ROUTES))('carries Retry-After from a busy server on %s', async route => {
        // ConsealDev.ConsealSync answers a store that stays busy with a bare 503.
        const { transport: t } = transport(() => ({ status: 503, headers: { 'Retry-After': '1' } }));

        await expect(ROUTES[route]?.(t)).rejects.toMatchObject({ status: 503, code: undefined, retryAfter: 1 });
    });

    it.each<[string, string, unknown]>([
        ['a config without collections', 'getConfig', { maxBatchItems: 100 }],
        ['a page without items', 'pull', { cursor: 'c1', hasMore: false }],
        ['a page without a cursor', 'pull', { items: [], hasMore: false }],
        ['a page whose hasMore isn\'t a boolean', 'pull', { items: [], cursor: 'c1', hasMore: 'no' }],
        ['a push answer without results', 'push', { items: [] }],
    ])('throws a SyncProtocolError for %s', async (_, route, body) => {
        const { transport: t } = transport(() => ({ status: 200, body }));

        await expect(ROUTES[route]?.(t)).rejects.toThrow(SyncProtocolError);
    });
});

describe('FetchSyncTransport blobs', () => {
    const RECORD = '3c9d2e7a-1b4f-4a6e-8c5d-9f0e1a2b3c4d';
    const BLOB = '8e7f6a5b-4c3d-4e2f-9a1b-0c9d8e7f6a5b';
    const ROUTE = `${BASE}/${NOTES}/${RECORD}/blobs/${BLOB}`;
    const STORAGE = 'https://bucket.s3.test/u/7f3a9c21/blob?X-Amz-Signature=abc';
    const SEALED = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);

    function blobUrl(method: 'PUT' | 'GET', headers: Record<string, string> = {}): StubAnswer
    {
        return { status: 200, body: { url: STORAGE, method, headers, expiresAt: '2026-10-14T20:05:00Z' } };
    }

    /** The app's API on one stub, the storage on another, as a presigned URL must not carry the app's sign-in. */
    function transports(api: (request: SentRequest) => StubAnswer, storage: (request: SentRequest) => StubAnswer)
    {
        const apiStub = stubFetch(api);
        const storageStub = stubFetch(storage);
        return {
            transport: new FetchSyncTransport({ baseUrl: BASE, fetch: apiStub.fetch, blobFetch: storageStub.fetch }),
            api: apiStub,
            storage: storageStub,
        };
    }

    it('asks for an upload URL with the sealed size, then PUTs the bytes there with its headers', async () => {
        const { transport: t, api, storage } = transports(
            () => blobUrl('PUT', { 'Content-Length': '28', 'x-amz-checksum-sha256': 'abc=' }),
            () => ({ status: 200 }),
        );

        await t.putBlob(NOTES, RECORD, BLOB, SEALED);

        expect(api.sent).toMatchObject([{ method: 'POST', url: ROUTE, body: { size: 28 } }]);
        expect(storage.sent).toMatchObject([{ method: 'PUT', url: STORAGE, headers: { 'Content-Length': '28', 'x-amz-checksum-sha256': 'abc=' } }]);
        expect(storage.sent[0]?.bytes).toEqual(SEALED);
    });

    it('asks for a download URL, then GETs the bytes, and gives undefined for a blob the storage doesn\'t hold', async () => {
        const found = transports(() => blobUrl('GET'), () => ({ status: 200, body: SEALED }));
        const missing = transports(() => blobUrl('GET'), () => ({ status: 404, body: '<Error><Code>NoSuchKey</Code></Error>' }));

        expect(await found.transport.getBlob(NOTES, RECORD, BLOB)).toEqual(SEALED);
        expect(found.api.sent).toMatchObject([{ method: 'GET', url: ROUTE }]);
        expect(found.storage.sent).toMatchObject([{ method: 'GET', url: STORAGE }]);
        expect(await missing.transport.getBlob(NOTES, RECORD, BLOB)).toBeUndefined();
    });

    it('deletes through the blob route', async () => {
        const { transport: t, api, storage } = transports(() => ({ status: 204 }), () => ({ status: 500 }));

        await t.deleteBlob(NOTES, RECORD, BLOB);

        expect(api.sent).toMatchObject([{ method: 'DELETE', url: ROUTE }]);
        expect(storage.sent).toEqual([]);
    });

    it('throws the storage\'s status as a SyncTransportError, and the API\'s code as one', async () => {
        const refused = transports(() => blobUrl('PUT'), () => ({ status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' }));
        const disabled = transports(() => errorAnswer(404, 'blobs_disabled'), () => ({ status: 200 }));

        await expect(refused.transport.putBlob(NOTES, RECORD, BLOB, SEALED)).rejects.toMatchObject({ status: 403, code: undefined });
        await expect(disabled.transport.getBlob(NOTES, RECORD, BLOB)).rejects.toMatchObject({ status: 404, code: 'blobs_disabled' });
        expect(disabled.storage.sent).toEqual([]);
    });

    it.each<[string, StubAnswer]>([
        ['a URL for another method', blobUrl('GET')],
        ['a header that isn\'t a string', blobUrl('PUT', { 'Content-Length': 28 as unknown as string })],
        ['no URL', { status: 200, body: { method: 'PUT', headers: {}, expiresAt: '2026-10-14T20:05:00Z' } }],
    ])('throws a SyncProtocolError for %s, and sends nothing to storage', async (_, answer) => {
        const { transport: t, storage } = transports(() => answer, () => ({ status: 200 }));

        await expect(t.putBlob(NOTES, RECORD, BLOB, SEALED)).rejects.toThrow(SyncProtocolError);
        expect(storage.sent).toEqual([]);
    });
});

describe('SyncEngine on FetchSyncTransport', () => {
    const collections = defineCollections<{ notes: { title: string } }>({ notes: { id: NOTES, schemaVersion: 1 } });

    async function engine(answer: (request: SentRequest) => StubAnswer, store = new MemoryRecordStore()): Promise<SyncEngine<{ notes: { title: string } }>>
    {
        const aek = await generateAesKey(false);
        return new SyncEngine({ collections, transport: transport(answer).transport, store, keyring: { aek: async () => aek } });
    }

    /** The server writes every item of a push. */
    function accepted(request: SentRequest): StubAnswer
    {
        const { items } = request.body as { items: PushItem[] };
        return { status: 200, body: { results: items.map(item => ({ id: item.id, status: 200, version: 'v1', seq: 1 })) } };
    }

    it('reports a collection the server rate-limits, with the code and Retry-After', async () => {
        const sync = await engine(request => request.url === BASE
            ? { status: 200, body: CONFIG }
            : errorAnswer(429, 'rate_limited', { 'Retry-After': '30' }));

        const report = await sync.sync();

        expect(report.failed.map(failure => failure.collection)).toEqual(['keyring', 'notes']);
        for (const { error } of report.failed)
        {
            expect(error).toBeInstanceOf(SyncTransportError);
            expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 30 });
        }
    });

    it('throws a 401 from sync, for the app\'s sign-in', async () => {
        const sync = await engine(() => errorAnswer(401, 'unauthenticated'));

        await expect(sync.sync()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    });

    it('pulls from the start when the server answers invalid_cursor', async () => {
        const store = new MemoryRecordStore();
        await store.setCursor('notes', 'stale');
        const sync = await engine(request => {
            if (request.url === BASE) return { status: 200, body: CONFIG };
            if (request.method === 'POST') return accepted(request);
            return request.url.includes('cursor=stale')
                ? errorAnswer(400, 'invalid_cursor')
                : { status: 200, body: { items: [], cursor: 'fresh', hasMore: false } };
        }, store);

        expect((await sync.sync()).failed).toEqual([]);
        expect(await store.getCursor('notes')).toBe('fresh');
    });

    it('splits a push the server finds too large', async () => {
        const sync = await engine(request => {
            if (request.url === BASE) return { status: 200, body: CONFIG };
            if (request.method === 'GET') return { status: 200, body: { items: [], cursor: 'c1', hasMore: false } };
            const { items } = request.body as { items: PushItem[] };
            return items.length > 1 ? errorAnswer(413, 'request_too_large') : accepted(request);
        });
        await sync.save('notes', newRecordId(), { title: 'one' });
        await sync.save('notes', newRecordId(), { title: 'two' });

        const report = await sync.sync();

        expect(report).toMatchObject({ pushed: 2, failed: [] });
    });
});
