import type { FetchFunction } from '../../src/sync/fetch-client.js';

/** A request a stub `fetch` was sent. */
export interface SentRequest
{
    method: string;
    url: string;
    headers: Record<string, string>;
    /** The body parsed as JSON, or undefined when there was none or it was binary. */
    body: unknown;
    /** The body's bytes, when it was binary, as a blob upload's is. */
    bytes: Uint8Array | undefined;
}

/** How a stub `fetch` answers. A string or bytes go out as they are, anything else as JSON. */
export interface StubAnswer
{
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
}

export interface StubFetch
{
    fetch: FetchFunction;
    /** Every request so far, in order. */
    sent: SentRequest[];
}

/** A `fetch` that answers each request with what `answer` returns for it, and records what it was sent. */
export function stubFetch(answer: (request: SentRequest) => StubAnswer): StubFetch
{
    const sent: SentRequest[] = [];
    const fetch: FetchFunction = async (url, init) => {
        const request: SentRequest = {
            method: init.method ?? 'GET',
            url,
            headers: { ...init.headers as Record<string, string> },
            body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
            bytes: init.body instanceof ArrayBuffer ? new Uint8Array(init.body.slice(0)) : undefined,
        };
        sent.push(request);

        const { status, body, headers } = answer(request);
        const content = body === undefined ? null : body instanceof Uint8Array ? body.slice() : typeof body === 'string' ? body : JSON.stringify(body);
        return new Response(content, { status, headers });
    };
    return { fetch, sent };
}

/** An answer with the contract's error body. */
export function errorAnswer(status: number, code: string, headers?: Record<string, string>): StubAnswer
{
    return { status, body: { code, message: `A test answer: ${code}.` }, headers };
}
