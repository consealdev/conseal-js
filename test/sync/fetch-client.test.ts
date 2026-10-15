import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncProtocolError, SyncTransportError } from '../../src/sync/errors.js';
import { FetchClient } from '../../src/sync/fetch-client.js';
import { errorAnswer, stubFetch, type StubAnswer } from '../support/stub-fetch.js';

const BASE = 'https://api.test/sync';

function client(answer: StubAnswer): FetchClient
{
    return new FetchClient({ baseUrl: BASE, fetch: stubFetch(() => answer).fetch });
}

describe('FetchClient', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a body as JSON, and asks for JSON back', async () => {
        const stub = stubFetch(() => ({ status: 200, body: { ok: true } }));
        const fetchClient = new FetchClient({ baseUrl: BASE, fetch: stub.fetch });

        expect(await fetchClient.send('POST', '/7f3a9c21', { items: [] })).toEqual({ ok: true });
        expect(stub.sent).toEqual([{
            method: 'POST',
            url: `${BASE}/7f3a9c21`,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: { items: [] },
        }]);
    });

    it('sends no body or Content-Type when there is nothing to send', async () => {
        const stub = stubFetch(() => ({ status: 204 }));

        expect(await new FetchClient({ baseUrl: BASE, fetch: stub.fetch }).send('DELETE', '/devices/a')).toBeUndefined();
        expect(stub.sent[0]?.headers).toEqual({ Accept: 'application/json' });
        expect(stub.sent[0]?.body).toBeUndefined();
    });

    it('ignores trailing slashes on the base URL', async () => {
        const stub = stubFetch(() => ({ status: 200, body: {} }));

        await new FetchClient({ baseUrl: `${BASE}//`, fetch: stub.fetch }).send('GET', '');
        await new FetchClient({ baseUrl: `${BASE}/`, fetch: stub.fetch }).send('GET', '/7f3a9c21');

        expect(stub.sent.map(request => request.url)).toEqual([BASE, `${BASE}/7f3a9c21`]);
    });

    it('throws an error answer as a SyncTransportError with its status and code', async () => {
        const error = await client(errorAnswer(409, 'last_device')).send('DELETE', '/devices/a').catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SyncTransportError);
        expect(error).toMatchObject({ status: 409, code: 'last_device', retryAfter: undefined });
    });

    it.each<[string, number | undefined]>([
        ['7', 7],
        [' 30 ', 30],
        ['0', 0],
        ['Wed, 21 Oct 2026 07:28:00 GMT', undefined],
        ['-1', undefined],
        ['1.5', undefined],
    ])('reads Retry-After "%s" as %s seconds', async (header, seconds) => {
        const error = await client(errorAnswer(429, 'rate_limited', { 'Retry-After': header })).send('GET', '').catch((e: unknown) => e);

        expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: seconds });
    });

    it('keeps the status of an error answer without the contract\'s body, such as a proxy\'s page', async () => {
        const error = await client({ status: 502, body: '<html>Bad gateway</html>' }).send('GET', '').catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SyncTransportError);
        expect(error).toMatchObject({ status: 502, code: undefined });
    });

    it('leaves the code unset when the error body\'s code isn\'t a string', async () => {
        const error = await client({ status: 400, body: { code: 7 } }).send('GET', '').catch((e: unknown) => e);

        expect(error).toMatchObject({ status: 400, code: undefined });
    });

    it('throws a SyncProtocolError for a success whose body isn\'t JSON', async () => {
        await expect(client({ status: 200, body: '<html>Sign in</html>' }).send('GET', '')).rejects.toThrow(SyncProtocolError);
    });

    it('lets a network failure through as fetch threw it', async () => {
        const offline = new TypeError('Failed to fetch');
        const fetchClient = new FetchClient({ baseUrl: BASE, fetch: () => Promise.reject(offline) });

        await expect(fetchClient.send('GET', '')).rejects.toBe(offline);
    });

    it('uses the global fetch when the app passes none', async () => {
        const browserFetch = vi.fn(browserLikeFetch);
        vi.stubGlobal('fetch', browserFetch);

        expect(await new FetchClient({ baseUrl: BASE }).send('GET', '')).toEqual({ ok: true });
        expect(browserFetch).toHaveBeenCalledWith(BASE, expect.objectContaining({ method: 'GET' }));
    });

    it('calls the app\'s fetch on its own, so the app can pass the browser\'s fetch itself', async () => {
        expect(await new FetchClient({ baseUrl: BASE, fetch: browserLikeFetch }).send('GET', '')).toEqual({ ok: true });
    });
});

/** Throws as a browser's fetch does when it's called as a method of anything but the window. */
function browserLikeFetch(this: unknown): Promise<Response>
{
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}
