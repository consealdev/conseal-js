// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { CollectionDefinition } from './collections.js';
import { SyncConfigError } from './errors.js';

/** What a merge policy gets: one record as this device holds it and as the server holds it, both in plaintext. */
export interface MergeInput<T>
{
    /** This device's value; undefined when it deleted the record and hasn't pushed the delete yet. */
    local: T | undefined;
    /** The server's value; undefined when the server holds a tombstone, or no record. */
    remote: T | undefined;
    /**
     * Whether `local` has a change the server doesn't have yet. When false, `local` is an earlier server state, and a
     * policy that can tell versions apart, such as a field-level clock, can keep it against a stale `remote`.
     */
    pending: boolean;
}

/**
 * Combines a record's local and remote values into the value this device keeps; undefined deletes the record. It
 * runs on plaintext and touches no keys: whatever it returns is sealed afresh before it's pushed. It must be a pure
 * function of its input.
 */
export type MergePolicy<T = object> = (input: MergeInput<T>) => T | undefined;

/** Makes a merge policy from the `args` of a collection's `merge` descriptor. */
export type MergePolicyFactory = (args: readonly unknown[]) => MergePolicy;

/**
 * The write that reaches the server last wins. A change this device hasn't pushed yet will reach it after the remote
 * one, so it wins, a delete included; with nothing pending, the remote value wins. It compares no clocks, so it can't
 * tell a stale remote value from a new one.
 */
export const lastWriteWins: MergePolicyFactory = () => ({ local, remote, pending }) => (pending ? local : remote);

const BUILT_IN: Readonly<Record<string, MergePolicyFactory>> = { lastWriteWins };

/** An immutable collection's records never change, so the server's copy is the record. */
export const takeRemote: MergePolicy = ({ remote }) => remote;

/**
 * The built-in policies and the app's own, by name.
 *
 * @throws SyncConfigError when the app registers a built-in name.
 */
export function mergePolicyTable(
    registered: Readonly<Record<string, MergePolicyFactory>>,
): ReadonlyMap<string, MergePolicyFactory>
{
    const table = new Map(Object.entries(BUILT_IN));
    for (const [fn, factory] of Object.entries(registered))
    {
        if (table.has(fn)) throw new SyncConfigError(`Merge policy ${fn} is built in and can't be registered again.`);
        table.set(fn, factory);
    }
    return table;
}

/**
 * Makes a collection's merge policy from its descriptor.
 *
 * @throws SyncConfigError when the descriptor names a policy the table doesn't hold.
 */
export function resolveMergePolicy(
    name: string,
    definition: CollectionDefinition,
    table: ReadonlyMap<string, MergePolicyFactory>,
): MergePolicy
{
    if (definition.immutable) return takeRemote;

    const descriptor = definition.merge ?? { fn: 'lastWriteWins' };
    const factory = table.get(descriptor.fn);
    if (factory === undefined)
    {
        throw new SyncConfigError(`Collection ${name} uses merge policy ${descriptor.fn}, which isn't registered.`);
    }
    return factory(descriptor.args ?? []);
}
