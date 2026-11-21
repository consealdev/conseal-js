// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { SyncTransportError } from '../sync/errors.js';

/**
 * What to tell the user about a failure a component doesn't name itself: signed out, too many tries, a server or
 * network problem, or else `fallback`. The server's own messages are for developers, so none is shown.
 */
export function errorText(error: unknown, fallback: string): string
{
    if (error instanceof SyncTransportError)
    {
        if (error.status === 401) return 'You\'re signed out. Sign in again, then try once more.';
        if (error.status === 429) return 'Too many tries. Wait a minute, then try again.';
        if (error.status >= 500) return 'The server had a problem. Try again in a moment.';
        return fallback;
    }
    // fetch reports a network failure, such as being offline, as a TypeError.
    if (error instanceof TypeError) return 'The server can\'t be reached. Check your connection and try again.';
    return fallback;
}

/** Whether the server refused with this error code. */
export function isServerCode(error: unknown, code: string): boolean
{
    return error instanceof SyncTransportError && error.code === code;
}
