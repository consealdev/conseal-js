// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { SyncProtocolError, SyncTransportError } from './errors.js';

/**
 * The app's `fetch`: the global one, or a wrapper that adds the app's sign-in, such as a bearer token it refreshes
 * when it expires.
 */
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

/** Where a fetch transport sends its requests, and through what. */
export interface FetchTransportOptions
{
    /**
     * The URL of the route group, as the backend maps it, such as `https://api.example.com/sync`. A path such as
     * `/api/sync` works wherever `fetch` resolves one, as in a browser.
     */
    baseUrl: string;

    /** The app's `fetch`. Defaults to the global one, which sends same-origin cookies. */
    fetch?: FetchFunction | undefined;
}

/**
 * The HTTP the fetch transports share: JSON in and out, and every answer that isn't a success thrown as a
 * `SyncTransportError` with the body's `code` and the `Retry-After` header. A network failure comes through as `fetch`
 * threw it.
 */
export class FetchClient
{
    private readonly _baseUrl: string;
    private readonly _fetch: FetchFunction;

    constructor(options: FetchTransportOptions)
    {
        this._baseUrl = options.baseUrl.replace(/\/+$/, '');
        // Never called as a method of this object: a browser's fetch throws when `this` is anything but the window, and
        // an app may pass `window.fetch` itself.
        const appFetch = options.fetch;
        this._fetch = appFetch === undefined
            ? (url, init) => globalThis.fetch(url, init)
            : (url, init) => appFetch(url, init);
    }

    /**
     * Sends a request to `path` under the base URL, with `body` as JSON when given.
     *
     * @returns the answer's JSON, or undefined when it has no body, as a `204` doesn't.
     * @throws SyncTransportError for an answer that isn't a success.
     * @throws SyncProtocolError for a success whose body isn't JSON.
     */
    public async send(method: string, path: string, body?: unknown): Promise<unknown>
    {
        const headers: Record<string, string> = { Accept: 'application/json' };
        const init: RequestInit = { method, headers };
        if (body !== undefined)
        {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        const response = await this._fetch(this._baseUrl + path, init);
        const text = await response.text();
        if (!response.ok) throw transportError(response, text);
        if (text === '') return undefined;

        const json = parseJson(text);
        if (json === undefined)
        {
            throw new SyncProtocolError(`The server answered ${method} ${path.split('?')[0]} with a body that isn't JSON.`);
        }
        return json;
    }
}

/**
 * A field of an answer, checked, so a server that breaks the contract gets a `SyncProtocolError` here rather than a
 * `TypeError` wherever the value is used.
 */
export function field<T>(body: unknown, name: string, check: (value: unknown) => value is T): T
{
    const value = isObject(body) ? (body as Record<string, unknown>)[name] : undefined;
    if (!check(value)) throw new SyncProtocolError(`The server's answer has no valid \`${name}\`.`);
    return value;
}

/** Like `field`, for a field the answer may leave out or set to null. */
export function optionalField<T>(body: unknown, name: string, check: (value: unknown) => value is T): T | undefined
{
    const value = isObject(body) ? (body as Record<string, unknown>)[name] : undefined;
    return value === undefined || value === null ? undefined : field(body, name, check);
}

/** Whether a value is a JSON object, not an array or null. */
export function isObject(value: unknown): value is object
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArray(value: unknown): value is unknown[]
{
    return Array.isArray(value);
}

export function isString(value: unknown): value is string
{
    return typeof value === 'string';
}

export function isBoolean(value: unknown): value is boolean
{
    return typeof value === 'boolean';
}

/**
 * The error for an answer that isn't a success. A body that isn't the contract's, such as a proxy's error page, leaves
 * `code` unset.
 */
function transportError(response: Response, text: string): SyncTransportError
{
    const body = parseJson(text);
    const code = isObject(body) ? (body as Record<string, unknown>)['code'] : undefined;
    return new SyncTransportError(response.status, {
        code: isString(code) ? code : undefined,
        retryAfter: retryAfterSeconds(response.headers.get('Retry-After')),
    });
}

/** `Retry-After` in whole seconds, the form the contract sends; undefined when it's absent or in another form. */
function retryAfterSeconds(header: string | null): number | undefined
{
    const value = header?.trim();
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** The text as JSON, or undefined when it isn't JSON. */
function parseJson(text: string): unknown
{
    try
    {
        return JSON.parse(text);
    }
    catch (error)
    {
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }
}
