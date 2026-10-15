import { generateAesKey, sealMessage, sign, unsealMessage, verify } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { CircleClient } from '../../src/sync/circle-client.js';
import { MemoryCircleStore } from '../../src/sync/circle-store.js';
import { defineCollections } from '../../src/sync/collections.js';
import { KeyringError, SyncTransportError } from '../../src/sync/errors.js';
import { KEYRING_COLLECTION, KEYRING_RECORD_ID, type Identity } from '../../src/sync/identity.js';
import { MemoryRecordStore } from '../../src/sync/record-store.js';
import { SyncEngine, type Keyring, type SyncEvent } from '../../src/sync/sync-engine.js';
import type { SyncTransport } from '../../src/sync/sync-transport.js';
import { FakeCircleServer } from '../support/fake-circle-server.js';
import { FakeSyncServer } from '../support/fake-sync-server.js';

type Collections = { notes: { title: string } };

const NOTES = '7f3a9c21';
const PASSPHRASE = 'correct horse battery staple';
const MESSAGE = 'a share sent while the user was away';

const collections = defineCollections<Collections>({ notes: { id: NOTES, schemaVersion: 1 } });

function syncServer(): FakeSyncServer
{
    return new FakeSyncServer({ collections: [{ id: NOTES }] });
}

function engine(server: FakeSyncServer, keyring: Keyring, transport: SyncTransport = server.transport()): SyncEngine<Collections>
{
    return new SyncEngine<Collections>({ collections, transport, store: new MemoryRecordStore(), keyring });
}

/** The keyring of a device that holds `aek`, without the circle ceremony around it. */
async function holding(aek?: CryptoKey): Promise<Keyring>
{
    const key = aek ?? await generateAesKey(false);
    return { aek: async () => key };
}

function circleDevice(server: FakeCircleServer): CircleClient
{
    return new CircleClient({ transport: server.transport(), store: new MemoryCircleStore() });
}

/** The public point of a key pair, to tell identities apart. */
async function publicPoint(pair: CryptoKeyPair): Promise<string>
{
    const { x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return `${x}.${y}`;
}

function sealTo(identity: Identity, text: string): ReturnType<typeof sealMessage>
{
    return sealMessage(identity.ecdh.publicKey, new TextEncoder().encode(text).buffer as ArrayBuffer);
}

async function open(identity: Identity, sealed: Awaited<ReturnType<typeof sealMessage>>): Promise<string>
{
    const plaintext = await unsealMessage(identity.ecdh.privateKey, sealed.ciphertext, sealed.iv, sealed.ephemeralPublicKey);
    return new TextDecoder().decode(plaintext);
}

function keyringRecords(server: FakeSyncServer): number
{
    return server.records.get(KEYRING_COLLECTION)?.size ?? 0;
}

describe('SyncEngine.identity', () => {
    it('reaches a device that joins the circle, which opens a message sealed to the user before it joined', async () => {
        const circle = new FakeCircleServer();
        const sync = syncServer();
        const phone = circleDevice(circle);
        await phone.setup(PASSPHRASE, { name: 'phone' });
        const phoneSync = engine(sync, phone);
        await phoneSync.sync();
        const sealed = await sealTo(await phoneSync.identity(), MESSAGE);

        const laptop = circleDevice(circle);
        const session = await laptop.startJoin({ name: 'laptop' });
        const [join] = await phone.pendingJoins();
        if (!join) throw new Error('No pending join.');
        await phone.approveJoin(join, PASSPHRASE, true);
        await session.check();
        await session.finish(PASSPHRASE);

        expect(await open(await engine(sync, laptop).identity(), sealed)).toBe(MESSAGE);
    });

    it('comes back with a recovery from the mnemonic, and signs as the user there', async () => {
        const circle = new FakeCircleServer();
        const sync = syncServer();
        const phone = circleDevice(circle);
        const { mnemonic } = await phone.setup(PASSPHRASE);
        const phoneSync = engine(sync, phone);
        await phoneSync.sync();
        const phoneIdentity = await phoneSync.identity();
        const sealed = await sealTo(phoneIdentity, MESSAGE);

        const tablet = circleDevice(circle);
        await tablet.recover(mnemonic, 'a new passphrase for the tablet');
        const tabletIdentity = await engine(sync, tablet).identity();
        const data = new TextEncoder().encode('signed on the tablet').buffer as ArrayBuffer;

        expect(await open(tabletIdentity, sealed)).toBe(MESSAGE);
        expect(await verify(phoneIdentity.ecdsa.publicKey, await sign(tabletIdentity.ecdsa.privateKey, data), data)).toBe(true);
    });

    it('is made once, by the first device to sync, and is the same on every device', async () => {
        const sync = syncServer();
        const keyring = await holding();
        const phone = engine(sync, keyring);
        const laptop = engine(sync, keyring);

        await phone.sync();
        await laptop.sync();
        const [mine, theirs] = [await phone.identity(), await laptop.identity()];

        expect(keyringRecords(sync)).toBe(1);
        expect(await publicPoint(theirs.ecdh)).toBe(await publicPoint(mine.ecdh));
        expect(await publicPoint(theirs.ecdsa)).toBe(await publicPoint(mine.ecdsa));
        expect([mine.ecdh.privateKey.extractable, mine.ecdsa.privateKey.extractable]).toEqual([false, false]);
    });

    it('settles on one identity when two devices make one at once', async () => {
        const sync = syncServer();
        const keyring = await holding();
        const honest = sync.transport();
        let raced = false;
        const phone = engine(sync, keyring);
        const laptop = engine(sync, keyring, {
            ...honest,
            pull: async (collectionId, cursor, limit) => {
                // The laptop's first pull of the keyring comes just before the phone's push lands.
                if (collectionId !== KEYRING_COLLECTION || raced) return honest.pull(collectionId, cursor, limit);
                raced = true;
                return { items: [], cursor: `${KEYRING_COLLECTION}:0`, hasMore: false };
            },
        });

        await phone.sync();
        const written = sync.records.get(KEYRING_COLLECTION)?.get(KEYRING_RECORD_ID)?.version;
        await laptop.sync();

        expect(sync.pushes.filter(push => push.collectionId === KEYRING_COLLECTION)).toHaveLength(2);
        expect(sync.records.get(KEYRING_COLLECTION)?.get(KEYRING_RECORD_ID)?.version).toBe(written);
        expect(await publicPoint((await laptop.identity()).ecdh)).toBe(await publicPoint((await phone.identity()).ecdh));
    });

    it('hands out no key pairs the server hasn\'t taken', async () => {
        const sync = syncServer();
        const honest = sync.transport();
        let online = false;
        const phone = engine(sync, await holding(), {
            ...honest,
            push: async (collectionId, items) => {
                if (!online) throw new SyncTransportError(503);
                return honest.push(collectionId, items);
            },
        });

        await expect(phone.identity()).rejects.toThrow(KeyringError);
        expect(keyringRecords(sync)).toBe(0);

        online = true;
        await expect(phone.identity()).resolves.toBeDefined();
        expect(keyringRecords(sync)).toBe(1);
    });

    it('refuses a keyring sealed under another key, and leaves it on the server', async () => {
        const sync = syncServer();
        await engine(sync, await holding()).sync();
        const stored = structuredClone(sync.records.get(KEYRING_COLLECTION)?.get(KEYRING_RECORD_ID));

        const phone = engine(sync, await holding());

        await expect(phone.identity()).rejects.toThrow(KeyringError);
        expect(sync.records.get(KEYRING_COLLECTION)?.get(KEYRING_RECORD_ID)).toEqual(stored);
    });

    it('stays out of the app\'s events and the sync report\'s counts', async () => {
        const sync = syncServer();
        const keyring = await holding();
        await engine(sync, keyring).sync();
        const laptop = engine(sync, keyring);
        const events: SyncEvent<Collections>[] = [];
        laptop.subscribe(event => events.push(event));

        expect(await laptop.sync()).toEqual({ pushed: 0, pulled: 0, merged: 0, failed: [] });
        expect(events).toEqual([]);
        await expect(laptop.identity()).resolves.toBeDefined();
    });
});
