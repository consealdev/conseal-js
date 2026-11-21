// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export function isPlainObject(value: unknown): value is object
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value without its local-only fields: what gets sealed and compared. */
export function withoutLocalOnly(value: object | undefined, localOnly: readonly string[]): object | undefined
{
    if (value === undefined || localOnly.length === 0) return value;
    const copy: Record<string, unknown> = { ...value };
    for (const field of localOnly)
    {
        delete copy[field];
    }
    return copy;
}

/** A merged value with this device's local-only fields, which never travel and so never merge. */
export function withLocalOnly(merged: object, local: object | undefined, localOnly: readonly string[]): object
{
    if (localOnly.length === 0) return merged;
    const copy: Record<string, unknown> = { ...withoutLocalOnly(merged, localOnly) };
    for (const field of localOnly)
    {
        if (local !== undefined && Object.hasOwn(local, field)) copy[field] = (local as Record<string, unknown>)[field];
    }
    return copy;
}

/** Whether two JSON values are equal, ignoring key order and fields set to undefined. */
export function jsonEqual(a: unknown, b: unknown): boolean
{
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b))
    {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
    }

    const entries = Object.entries(a).filter(([, value]) => value !== undefined);
    const other = b as Record<string, unknown>;
    return entries.length === Object.values(other).filter(value => value !== undefined).length
        && entries.every(([key, value]) => jsonEqual(value, other[key]));
}
