// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { SyncConfigError } from './errors.js';
import { KEYRING_COLLECTION } from './identity.js';

const COLLECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A merge policy by name, with the arguments its factory takes. Plain data, so a registry stays serializable. */
export interface MergeDescriptor
{
    fn: string;
    args?: readonly unknown[] | undefined;
}

/** One collection: a kind of record the app syncs. */
export interface CollectionDefinition
{
    /**
     * The collection's identity on the wire and in storage: an id the app assigns, such as `7f3a9c21`, never its
     * name, so the server, its logs and its metrics never hold the app's vocabulary. Matches `[A-Za-z0-9_-]{1,64}`.
     */
    id: string;
    /** How a remote change combines with this device's copy. `lastWriteWins` when absent; none when immutable. */
    merge?: MergeDescriptor | undefined;
    /** Top-level fields that stay on this device: never sealed or sent, and kept from the local copy on a merge. */
    localOnly?: readonly string[] | undefined;
    /** Append-only: a record is created once and never changed or deleted, so it never conflicts. */
    immutable?: boolean | undefined;
    /** The version of the record's shape, a whole number from 1, sealed into every record as `schemaVersion`. */
    schemaVersion: number;
}

/** The app's collections by name. The name is the app's own word for them, and never leaves the device. */
export type CollectionDefinitions<Values extends Record<string, object>> = {
    readonly [K in keyof Values & string]: CollectionDefinition;
};

/**
 * Declares the collections an app syncs, typed by the value each one holds, and checks them. A table the registry
 * doesn't name stays on the device: leaving it out is how an app keeps it local.
 *
 * @throws SyncConfigError when an id is invalid or repeated, a name or id is `keyring`, which the engine reserves, a
 * `schemaVersion` isn't a whole number from 1, a local-only field is `schemaVersion`, or an immutable collection names a
 * merge policy.
 */
export function defineCollections<Values extends Record<string, object>>(
    definitions: CollectionDefinitions<Values>,
): CollectionDefinitions<Values>
{
    validateCollections(definitions);
    return Object.freeze({ ...definitions });
}

export function validateCollections(definitions: Readonly<Record<string, CollectionDefinition>>): void
{
    const entries = Object.entries(definitions);
    if (entries.length === 0) throw new SyncConfigError('The registry declares no collections.');

    const names = new Map<string, string>();
    for (const [name, definition] of entries)
    {
        if (!COLLECTION_ID.test(definition.id))
        {
            throw new SyncConfigError(`Collection ${name} has id "${definition.id}", which isn't 1 to 64 of A-Z, a-z, 0-9, _ and -.`);
        }
        const other = names.get(definition.id);
        if (other !== undefined) throw new SyncConfigError(`Collections ${other} and ${name} share id ${definition.id}.`);
        names.set(definition.id, name);
        if (name === KEYRING_COLLECTION || definition.id === KEYRING_COLLECTION)
        {
            throw new SyncConfigError(`Collection ${name} uses ${KEYRING_COLLECTION}, which the engine keeps for the user's identity.`);
        }

        if (!Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1)
        {
            throw new SyncConfigError(`Collection ${name} has schemaVersion ${definition.schemaVersion}; it's a whole number from 1.`);
        }
        if (definition.localOnly?.includes('schemaVersion'))
        {
            throw new SyncConfigError(`Collection ${name} lists schemaVersion as local-only, but every sealed record carries it.`);
        }
        if (definition.immutable && definition.merge !== undefined)
        {
            throw new SyncConfigError(`Collection ${name} is immutable, so it never merges and names no merge policy.`);
        }
    }
}

/** A new record id: a random (version 4) UUID in lowercase, as the contract requires. */
export function newRecordId(): string
{
    return crypto.randomUUID();
}

/** Whether `id` is a record id the contract accepts. */
export function isRecordId(id: string): boolean
{
    return RECORD_ID.test(id);
}
