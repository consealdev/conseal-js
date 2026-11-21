// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * What a device keeps for the circle:
 *
 * - `deviceId`: this device's id in the circle
 * - `secretKey`: its Secret Key, as raw bytes
 * - `wrappedAek`: its wrapped AEK, encoded (see `EncodedWrappedAek`)
 * - `aekCommitment`: the circle's AEK commitment, base64, as this device took it with the AEK. Its join codes cover it
 * - `aek`: the unlocked AEK, a non-extractable `CryptoKey`, while the device is unlocked
 */
export type CircleStoreKey = 'deviceId' | 'secretKey' | 'wrappedAek' | 'aekCommitment' | 'aek';

/** Where a device keeps its keys for the circle. Values must survive a structured clone. */
export interface CircleStore
{
    get<T>(key: CircleStoreKey): Promise<T | undefined>;
    put(key: CircleStoreKey, value: unknown): Promise<void>;
    delete(key: CircleStoreKey): Promise<void>;
}

/** Keeps the keys in memory only: for tests, and for processes that join, act and leave. */
export class MemoryCircleStore implements CircleStore
{
    private readonly _entries = new Map<CircleStoreKey, unknown>();

    public async get<T>(key: CircleStoreKey): Promise<T | undefined>
    {
        return this._entries.get(key) as T | undefined;
    }

    public async put(key: CircleStoreKey, value: unknown): Promise<void>
    {
        this._entries.set(key, value);
    }

    public async delete(key: CircleStoreKey): Promise<void>
    {
        this._entries.delete(key);
    }
}

const STORE_NAME = 'circle';

/**
 * Keeps the keys in IndexedDB, the default in a browser. The AEK is stored as a non-extractable `CryptoKey`, so
 * a script on the page can use it but can't read its bytes.
 */
export class IndexedDbCircleStore implements CircleStore
{
    private readonly _dbName: string;
    private _db: Promise<IDBDatabase> | undefined;

    constructor(dbName = 'conseal-circle')
    {
        this._dbName = dbName;
    }

    public async get<T>(key: CircleStoreKey): Promise<T | undefined>
    {
        return await this._request('readonly', store => store.get(key)) as T | undefined;
    }

    public async put(key: CircleStoreKey, value: unknown): Promise<void>
    {
        await this._request('readwrite', store => store.put(value, key));
    }

    public async delete(key: CircleStoreKey): Promise<void>
    {
        await this._request('readwrite', store => store.delete(key));
    }

    private _open(): Promise<IDBDatabase>
    {
        this._db ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(this._dbName, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                this._db = undefined;
                reject(request.error);
            };
        });
        return this._db;
    }

    private async _request(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<unknown>
    {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, mode);
            const request = run(transaction.objectStore(STORE_NAME));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }
}
