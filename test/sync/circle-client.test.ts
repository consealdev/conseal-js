import { digest, generateMnemonic, importPublicKeyFromJwk, seal, sealMessage, toBase64, unseal } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { CircleClient, type PendingJoin } from '../../src/sync/circle-client.js';
import { MemoryCircleStore, type CircleStore } from '../../src/sync/circle-store.js';
import type { CircleTransport, JoinStatus } from '../../src/sync/circle-transport.js';
import { encodeSealed, type EncodedSealed } from '../../src/sync/encoding.js';
import {
    CommitmentMismatchError,
    DeviceNotRegisteredError,
    JoinExpiredError,
    JoinStateError,
    LockedError,
    UnverifiedKeyError,
    WrongPassphraseError,
} from '../../src/sync/errors.js';
import { sealPassphraseCheck } from '../../src/sync/passphrase-check.js';
import { FakeCircleServer } from '../support/fake-circle-server.js';

const PASSPHRASE = 'correct horse battery staple';

function device(server: FakeCircleServer, store: CircleStore = new MemoryCircleStore()): CircleClient
{
    return new CircleClient({ transport: server.transport(), store });
}

async function onlyPendingJoin(approver: CircleClient): Promise<PendingJoin>
{
    const pending = await approver.pendingJoins();
    expect(pending).toHaveLength(1);
    const [join] = pending;
    if (!join) throw new Error('No pending join.');
    return join;
}

/** The fake server's transport with some answers rewritten, the way a dishonest server could answer them. */
function rewritten(server: FakeCircleServer, answers: Partial<CircleTransport>): CircleTransport
{
    const honest = server.transport();
    return {
        createCircle: circle => honest.createCircle(circle),
        getCommitment: () => honest.getCommitment(),
        getWrappedAek: deviceId => honest.getWrappedAek(deviceId),
        saveWrappedAek: (deviceId, wrappedAek, deviceMeta, challengeId) =>
            honest.saveWrappedAek(deviceId, wrappedAek, deviceMeta, challengeId),
        createJoin: request => honest.createJoin(request),
        getJoinStatus: challengeId => honest.getJoinStatus(challengeId),
        listPendingJoins: () => honest.listPendingJoins(),
        authorizeJoin: (challengeId, sealedAek, passphraseCheck) => honest.authorizeJoin(challengeId, sealedAek, passphraseCheck),
        denyJoin: challengeId => honest.denyJoin(challengeId),
        listDevices: () => honest.listDevices(),
        revokeDevice: deviceId => honest.revokeDevice(deviceId),
        ...answers,
    };
}

/**
 * A server that keeps a key of its own for joining devices: it tells them that key's commitment, and seals the key
 * to each request's ephemeral public key, which it relays and so knows.
 */
async function serverKey()
{
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const requests = new Map<string, JsonWebKey>();
    return {
        raw,
        commitment: toBase64(await digest(raw)),
        requests,
        sealFor: async (challengeId: string): Promise<EncodedSealed> =>
        {
            const recipient = await importPublicKeyFromJwk(requests.get(challengeId)!, 'ECDH');
            return encodeSealed(await sealMessage(recipient, raw.buffer as ArrayBuffer));
        },
    };
}

/** Whether two AES keys are the same key: what one seals, the other opens. */
async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean>
{
    const message = new TextEncoder().encode('the same circle');
    const { ciphertext, iv } = await seal(a, message.buffer as ArrayBuffer);
    const opened = await unseal(b, ciphertext, iv).catch(() => undefined);
    return opened !== undefined && new TextDecoder().decode(opened) === 'the same circle';
}

describe('CircleClient', () => {
    it('joins a second device, which ends up holding the same AEK', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        const laptop = device(server);
        await phone.setup(PASSPHRASE, { name: 'phone' });

        const session = await laptop.startJoin({ name: 'laptop' });
        const scenes: string[] = [];
        session.subscribe(state => scenes.push(state.scene));

        const join = await onlyPendingJoin(phone);
        expect(join.verificationCode).toBe(session.verificationCode);
        await phone.approveJoin(join, PASSPHRASE, true);

        expect((await session.check()).scene).toBe('authorized');
        await session.finish(PASSPHRASE);

        expect(session.state).toEqual({ scene: 'done', deviceId: session.deviceId });
        expect(scenes).toEqual(['waiting', 'authorized', 'finalizing', 'done']);
        expect(await laptop.status()).toBe('unlocked');
        expect(await sameKey(await phone.aek(), await laptop.aek())).toBe(true);
        expect((await phone.devices()).map(listed => listed.name).sort()).toEqual(['laptop', 'phone']);
        expect(server.challenges.size).toBe(0);
    });

    it('relays the passphrase check only as ciphertext sealed to the joining device', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);
        const session = await device(server).startJoin();
        await phone.approveJoin(await onlyPendingJoin(phone), PASSPHRASE, true);

        const held = server.challenges.get(session.challengeId)?.passphraseCheck;
        expect(held && Object.keys(held).sort()).toEqual(['ciphertext', 'ephemeralPublicKey', 'iv']);
        expect(JSON.stringify(held)).not.toContain('hash');
    });

    it('asks the joining device for the approving device\'s passphrase, and lets the user try again', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);
        const session = await device(server).startJoin();
        await phone.approveJoin(await onlyPendingJoin(phone), PASSPHRASE, true);
        await session.check();

        await expect(session.finish('a different passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
        expect(session.state.scene).toBe('authorized');

        await session.finish(PASSPHRASE);
        expect(session.state.scene).toBe('done');
    });

    it('fails the join when the key doesn\'t match the account\'s commitment', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);
        server.commitment = toBase64(crypto.getRandomValues(new Uint8Array(32)));

        const laptop = device(server);
        const session = await laptop.startJoin();
        await phone.approveJoin(await onlyPendingJoin(phone), PASSPHRASE, true);
        await session.check();

        await expect(session.finish(PASSPHRASE)).rejects.toBeInstanceOf(CommitmentMismatchError);
        expect(session.state.scene).toBe('failed');
        expect(await laptop.status()).toBe('unregistered');
        await expect(session.finish(PASSPHRASE)).rejects.toBeInstanceOf(JoinStateError);
    });

    it('shows the approving device a code from its own commitment, not the server\'s', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);
        server.commitment = toBase64(crypto.getRandomValues(new Uint8Array(32)));

        const session = await device(server).startJoin();
        expect((await onlyPendingJoin(phone)).verificationCode).not.toBe(session.verificationCode);
    });

    it('works out the commitment of a device that didn\'t keep one, at its next unlock', async () => {
        const server = new FakeCircleServer();
        const store = new MemoryCircleStore();
        const phone = device(server, store);
        await phone.setup(PASSPHRASE);
        await store.delete('aekCommitment');

        expect(await phone.status()).toBe('locked');
        await expect(phone.pendingJoins()).rejects.toBeInstanceOf(LockedError);

        await phone.unlock(PASSPHRASE);
        expect(await phone.status()).toBe('unlocked');
        const session = await device(server).startJoin();
        expect((await onlyPendingJoin(phone)).verificationCode).toBe(session.verificationCode);
    });

    it('refuses to start a join on an account with no circle', async () => {
        const server = new FakeCircleServer();
        await expect(device(server).startJoin()).rejects.toBeInstanceOf(CommitmentMismatchError);
        expect(server.challenges.size).toBe(0);
    });

    it('reports a denied join, which can\'t be finished', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);
        const session = await device(server).startJoin();

        await phone.denyJoin((await onlyPendingJoin(phone)).challengeId);

        expect((await session.check()).scene).toBe('denied');
        await expect(session.finish(PASSPHRASE)).rejects.toBeInstanceOf(JoinStateError);
    });

    it('refuses to approve a request older than the ceremony allows, by the server\'s clock', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);
        server.now = () => Date.now() - 6 * 60 * 1000;
        await device(server).startJoin();

        const join = await onlyPendingJoin(phone);
        await expect(phone.approveJoin(join, PASSPHRASE, true)).rejects.toBeInstanceOf(JoinExpiredError);
    });

    it('refuses to approve with the wrong passphrase', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);
        await device(server).startJoin();

        const join = await onlyPendingJoin(phone);
        await expect(phone.approveJoin(join, 'not the passphrase', true)).rejects.toBeInstanceOf(WrongPassphraseError);
    });

    it('locks and unlocks with the passphrase', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);

        await phone.lock();
        expect(await phone.status()).toBe('locked');
        await expect(phone.aek()).rejects.toBeInstanceOf(LockedError);
        await expect(phone.unlock('not the passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);

        await phone.unlock(PASSPHRASE);
        expect(await phone.status()).toBe('unlocked');
    });

    it('fetches its wrapped AEK from the server when it lost the local copy', async () => {
        const server = new FakeCircleServer();
        const store = new MemoryCircleStore();
        const phone = device(server, store);
        await phone.setup(PASSPHRASE);
        await phone.lock();
        await store.delete('wrappedAek');

        await phone.unlock(PASSPHRASE);
        expect(await phone.status()).toBe('unlocked');
    });

    it('sends a device with no keys to join or recover', async () => {
        const server = new FakeCircleServer();
        await device(server).setup(PASSPHRASE);
        const tablet = device(server);

        expect(await tablet.status()).toBe('unregistered');
        expect(await tablet.isRegistered()).toBe(false);
        await expect(tablet.unlock(PASSPHRASE)).rejects.toBeInstanceOf(DeviceNotRegisteredError);
    });

    it('recovers the circle\'s own key from the mnemonic, and can revoke the other devices', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        const { mnemonic } = await phone.setup(PASSPHRASE);
        const tablet = device(server);

        const { deviceId } = await tablet.recover(mnemonic, 'a new passphrase for the tablet', { revokeOtherDevices: true });

        expect(await sameKey(await phone.aek(), await tablet.aek())).toBe(true);
        expect((await tablet.devices()).map(listed => listed.deviceId)).toEqual([deviceId]);
        expect(await phone.isRegistered()).toBe(false);
    });

    it('refuses a recovery phrase from another circle, before registering anything', async () => {
        const server = new FakeCircleServer();
        await device(server).setup(PASSPHRASE);
        const tablet = device(server);

        await expect(tablet.recover(generateMnemonic(), 'a new passphrase')).rejects.toBeInstanceOf(CommitmentMismatchError);
        expect(server.devices.size).toBe(1);
        expect(await tablet.status()).toBe('unregistered');
    });
});

describe('A join the server answers itself', () => {
    /** A circle on the phone, and a laptop joining it through a server that rewrites `answers`. */
    async function joinThrough(server: FakeCircleServer, answers: Partial<CircleTransport>)
    {
        const phone = device(server);
        await phone.setup(PASSPHRASE, { name: 'phone' });
        const laptop = new CircleClient({ transport: rewritten(server, answers), store: new MemoryCircleStore() });
        const session = await laptop.startJoin({ name: 'laptop' });
        return { phone, laptop, session };
    }

    it('shows codes that differ when it gives the joining device the commitment of a key of its own', async () => {
        const server = new FakeCircleServer();
        const own = await serverKey();
        const { phone, session } = await joinThrough(server, { getCommitment: async () => own.commitment });

        expect((await onlyPendingJoin(phone)).verificationCode).not.toBe(session.verificationCode);
    });

    it('refuses a key the server sealed itself, with no passphrase check', async () => {
        const server = new FakeCircleServer();
        const own = await serverKey();
        const { laptop, session } = await joinThrough(server, {
            getCommitment: async () => own.commitment,
            createJoin: async request =>
            {
                const answer = await server.transport().createJoin(request);
                own.requests.set(answer.challengeId, request.ephemeralPublicKey);
                return answer;
            },
            getJoinStatus: async challengeId => ({ status: 'authorized', sealedAek: await own.sealFor(challengeId) }) as unknown as JoinStatus,
        });

        expect((await session.check()).scene).toBe('authorized');
        await expect(session.finish('any passphrase at all')).rejects.toBeInstanceOf(UnverifiedKeyError);

        expect(session.state.scene).toBe('failed');
        expect(await laptop.status()).toBe('unregistered');
        expect(server.devices.size).toBe(1);
    });

    it('refuses a passphrase check the server made, which only its own guess passes', async () => {
        const server = new FakeCircleServer();
        const own = await serverKey();
        const { laptop, session } = await joinThrough(server, {
            getCommitment: async () => own.commitment,
            createJoin: async request =>
            {
                const answer = await server.transport().createJoin(request);
                own.requests.set(answer.challengeId, request.ephemeralPublicKey);
                return answer;
            },
            getJoinStatus: async challengeId =>
            {
                const sealedAek = await own.sealFor(challengeId);
                const passphraseCheck = await sealPassphraseCheck('the server\'s guess', sealedAek, own.requests.get(challengeId)!);
                return { status: 'authorized', sealedAek, passphraseCheck };
            },
        });

        await session.check();
        await expect(session.finish(PASSPHRASE)).rejects.toBeInstanceOf(WrongPassphraseError);

        expect(session.state.scene).toBe('authorized');
        expect(await laptop.status()).toBe('unregistered');
        expect(server.devices.size).toBe(1);
    });

    it('refuses a real approval\'s check on a key the server swapped in', async () => {
        const server = new FakeCircleServer();
        const own = await serverKey();
        const { phone, laptop, session } = await joinThrough(server, {
            createJoin: async request =>
            {
                const answer = await server.transport().createJoin(request);
                own.requests.set(answer.challengeId, request.ephemeralPublicKey);
                return answer;
            },
            getJoinStatus: async challengeId =>
            {
                const real = await server.transport().getJoinStatus(challengeId);
                if (real.status !== 'authorized') return real;
                return { ...real, sealedAek: await own.sealFor(challengeId) };
            },
        });

        // The user compares the codes and approves on the phone, as they should.
        const join = await onlyPendingJoin(phone);
        expect(join.verificationCode).toBe(session.verificationCode);
        await phone.approveJoin(join, PASSPHRASE, true);

        await session.check();
        await expect(session.finish(PASSPHRASE)).rejects.toBeInstanceOf(UnverifiedKeyError);

        expect(session.state.scene).toBe('failed');
        expect(await laptop.status()).toBe('unregistered');
        expect(server.devices.size).toBe(1);
    });

    it('refuses a passphrase check that doesn\'t open with the joining device\'s key', async () => {
        const server = new FakeCircleServer();
        const phone = device(server);
        await phone.setup(PASSPHRASE);
        const other = await device(server).startJoin();
        await phone.approveJoin(await onlyPendingJoin(phone), PASSPHRASE, true);
        const otherCheck = server.challenges.get(other.challengeId)!.passphraseCheck!;

        const laptop = new CircleClient({
            transport: rewritten(server, {
                getJoinStatus: async challengeId =>
                {
                    const real = await server.transport().getJoinStatus(challengeId);
                    return real.status === 'authorized' ? { ...real, passphraseCheck: otherCheck } : real;
                },
            }),
            store: new MemoryCircleStore(),
        });
        const session = await laptop.startJoin();
        const pending = (await phone.pendingJoins()).find(join => join.challengeId === session.challengeId)!;
        await phone.approveJoin(pending, PASSPHRASE, true);

        await session.check();
        await expect(session.finish(PASSPHRASE)).rejects.toBeInstanceOf(UnverifiedKeyError);
        expect(session.state.scene).toBe('failed');
    });
});
