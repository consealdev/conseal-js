import { describe, expect, it } from 'vitest';
import { defineCollections, isRecordId, newRecordId, type CollectionDefinition } from '../../src/sync/collections.js';
import { SyncConfigError } from '../../src/sync/errors.js';

describe('defineCollections', () => {
    it('accepts a valid registry', () => {
        const collections = defineCollections<{ notes: object; events: object }>({
            notes: { id: '7f3a9c21', localOnly: ['cached'], schemaVersion: 1 },
            events: { id: 'b4e70118', immutable: true, schemaVersion: 2 },
        });

        expect(Object.keys(collections)).toEqual(['notes', 'events']);
    });

    it.each<[string, Record<string, CollectionDefinition>]>([
        ['no collections', {}],
        ['an id with a space', { notes: { id: '7f3a 9c21', schemaVersion: 1 } }],
        ['a repeated id', { notes: { id: '7f3a9c21', schemaVersion: 1 }, todos: { id: '7f3a9c21', schemaVersion: 1 } }],
        ['a schemaVersion of 0', { notes: { id: '7f3a9c21', schemaVersion: 0 } }],
        ['a fractional schemaVersion', { notes: { id: '7f3a9c21', schemaVersion: 1.5 } }],
        ['schemaVersion as a local-only field', { notes: { id: '7f3a9c21', localOnly: ['schemaVersion'], schemaVersion: 1 } }],
        ['an immutable collection with a merge policy', { notes: { id: '7f3a9c21', immutable: true, merge: { fn: 'lastWriteWins' }, schemaVersion: 1 } }],
        ['a collection named keyring', { keyring: { id: '7f3a9c21', schemaVersion: 1 } }],
        ['a collection with the id keyring', { notes: { id: 'keyring', schemaVersion: 1 } }],
    ])('refuses a registry with %s', (_, definitions) => {
        expect(() => defineCollections(definitions)).toThrow(SyncConfigError);
    });
});

describe('record ids', () => {
    it('mints lowercase version 4 UUIDs', () => {
        const id = newRecordId();

        expect(isRecordId(id)).toBe(true);
        expect(id).toBe(id.toLowerCase());
    });

    it.each([
        ['an uppercase UUID', '3B2F6C1E-8D4A-4F0B-9C7E-5A1D2E3F4B6C'],
        ['a version 7 UUID', '01890a5d-ac96-774b-bcce-b302099a8057'],
        ['a provider file id', 'id:a4ayc_80_OEAAAAAAAAAXw'],
    ])('refuses %s', (_, id) => {
        expect(isRecordId(id)).toBe(false);
    });
});
