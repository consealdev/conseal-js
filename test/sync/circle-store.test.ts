import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbCircleStore } from '../../src/sync/circle-store.js';

describe('IndexedDbCircleStore', () => {
    it('keeps, returns and deletes entries', async () => {
        const store = new IndexedDbCircleStore('circle-store-test');
        const secretKey = crypto.getRandomValues(new Uint8Array(16));

        await store.put('deviceId', 'device-1');
        await store.put('secretKey', secretKey);
        await store.put('wrappedAek', { wrappedKey: 'AAAA', salt: 'BBBB' });

        expect(await store.get('deviceId')).toBe('device-1');
        expect(await store.get('secretKey')).toEqual(secretKey);
        expect(await store.get('wrappedAek')).toEqual({ wrappedKey: 'AAAA', salt: 'BBBB' });

        await store.delete('deviceId');
        expect(await store.get('deviceId')).toBeUndefined();
    });

    it('reads what another instance wrote to the same database', async () => {
        await new IndexedDbCircleStore('circle-store-shared').put('deviceId', 'device-2');

        expect(await new IndexedDbCircleStore('circle-store-shared').get('deviceId')).toBe('device-2');
    });
});
