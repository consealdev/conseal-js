import type { JoinRequest } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { CircleClient } from '../../src/sync/circle-client.js';
import { MemoryCircleStore } from '../../src/sync/circle-store.js';
import type { CircleTransport } from '../../src/sync/circle-transport.js';
import type { EncodedSealed, EncodedWrappedAek } from '../../src/sync/encoding.js';
import { SyncProtocolError, SyncTransportError } from '../../src/sync/errors.js';
import { FetchCircleTransport } from '../../src/sync/fetch-circle-transport.js';
import { errorAnswer, stubFetch, type SentRequest, type StubAnswer, type StubFetch } from '../support/stub-fetch.js';

const BASE = 'https://api.test/circle';
const DEVICE = '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c';
const CHALLENGE = '4c8e1a2b3d5f47a69b0c1d2e3f4a5b6c';
const COMMITMENT = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';

const WRAPPED: EncodedWrappedAek = { wrappedKey: 'd3JhcHBlZA==', salt: 'c2FsdA==' };
const PUBLIC_KEY: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' };
const SEALED: EncodedSealed = { ciphertext: 'c2VhbGVk', iv: 'aXY=', ephemeralPublicKey: PUBLIC_KEY };
const REQUEST: JoinRequest = { deviceId: DEVICE, ephemeralPublicKey: PUBLIC_KEY, createdAt: '2026-10-14T12:00:00.000Z' };

function transport(answer: (request: SentRequest) => StubAnswer): { transport: FetchCircleTransport; stub: StubFetch }
{
    const stub = stubFetch(answer);
    return { transport: new FetchCircleTransport({ baseUrl: BASE, fetch: stub.fetch }), stub };
}

/** Every method of the transport, with the request it sends and an answer the contract allows. */
const ROUTES: Record<string, { call: (t: CircleTransport) => Promise<unknown>; sends: string; body?: unknown; answer: StubAnswer }> = {
    createCircle: {
        call: t => t.createCircle({ deviceId: DEVICE, aekCommitment: COMMITMENT, wrappedAek: WRAPPED, deviceMeta: { name: 'Laptop' } }),
        sends: `POST ${BASE}`,
        body: { deviceId: DEVICE, aekCommitment: COMMITMENT, wrappedAek: WRAPPED, deviceMeta: { name: 'Laptop' } },
        answer: { status: 204 },
    },
    getCommitment: {
        call: t => t.getCommitment(),
        sends: `GET ${BASE}`,
        answer: { status: 200, body: { aekCommitment: COMMITMENT } },
    },
    getWrappedAek: {
        call: t => t.getWrappedAek(DEVICE),
        sends: `GET ${BASE}/devices/${DEVICE}/wrapped-aek`,
        answer: { status: 200, body: { wrappedAek: WRAPPED } },
    },
    saveWrappedAek: {
        call: t => t.saveWrappedAek(DEVICE, WRAPPED, { name: 'Phone', platform: 'iOS' }, CHALLENGE),
        sends: `PUT ${BASE}/devices/${DEVICE}/wrapped-aek`,
        body: { wrappedAek: WRAPPED, deviceMeta: { name: 'Phone', platform: 'iOS' }, challengeId: CHALLENGE },
        answer: { status: 204 },
    },
    createJoin: {
        call: t => t.createJoin(REQUEST),
        sends: `POST ${BASE}/joins`,
        body: REQUEST,
        answer: { status: 201, body: { challengeId: CHALLENGE, aekCommitment: COMMITMENT, expiresAt: '2026-10-14T12:05:00Z' } },
    },
    getJoinStatus: {
        call: t => t.getJoinStatus(CHALLENGE),
        sends: `GET ${BASE}/joins/${CHALLENGE}`,
        answer: { status: 200, body: { status: 'pending' } },
    },
    listPendingJoins: {
        call: t => t.listPendingJoins(),
        sends: `GET ${BASE}/joins`,
        answer: { status: 200, body: { joins: [] } },
    },
    authorizeJoin: {
        call: t => t.authorizeJoin(CHALLENGE, SEALED, SEALED),
        sends: `POST ${BASE}/joins/${CHALLENGE}/authorize`,
        body: { sealedAek: SEALED, passphraseCheck: SEALED },
        answer: { status: 204 },
    },
    denyJoin: {
        call: t => t.denyJoin(CHALLENGE),
        sends: `POST ${BASE}/joins/${CHALLENGE}/deny`,
        answer: { status: 204 },
    },
    listDevices: {
        call: t => t.listDevices(),
        sends: `GET ${BASE}/devices`,
        answer: { status: 200, body: { devices: [] } },
    },
    revokeDevice: {
        call: t => t.revokeDevice(DEVICE),
        sends: `DELETE ${BASE}/devices/${DEVICE}`,
        answer: { status: 204 },
    },
};

function route(name: string): (typeof ROUTES)[string]
{
    const found = ROUTES[name];
    if (!found) throw new Error(`No route ${name} in the test table.`);
    return found;
}

describe('FetchCircleTransport', () => {
    it.each(Object.keys(ROUTES))('sends %s to its route', async name => {
        const { call, sends, body, answer } = route(name);
        const { transport: t, stub } = transport(() => answer);

        await call(t);

        expect(stub.sent.map(r => `${r.method} ${r.url}`)).toEqual([sends]);
        expect(stub.sent[0]?.body).toEqual(body);
    });

    it('reads the commitment', async () => {
        const { transport: t } = transport(() => ({ status: 200, body: { aekCommitment: COMMITMENT } }));

        expect(await t.getCommitment()).toBe(COMMITMENT);
    });

    it('reads no commitment for an account with no circle', async () => {
        const { transport: t } = transport(() => errorAnswer(404, 'no_circle'));

        expect(await t.getCommitment()).toBeUndefined();
    });

    it('throws a 404 without no_circle, such as from a wrong base URL, rather than offering setup', async () => {
        const { transport: t } = transport(() => ({ status: 404, body: 'Not Found' }));

        await expect(t.getCommitment()).rejects.toMatchObject({ status: 404, code: undefined });
    });

    it('reads a device\'s wrapped AEK', async () => {
        const { transport: t } = transport(() => ({ status: 200, body: { wrappedAek: WRAPPED } }));

        expect(await t.getWrappedAek(DEVICE)).toEqual(WRAPPED);
    });

    it.each<[number, string]>([
        [404, 'unknown_device'],
        [403, 'device_revoked'],
    ])('reads no wrapped AEK for a device the server answers %i %s', async (status, code) => {
        const { transport: t } = transport(() => errorAnswer(status, code));

        expect(await t.getWrappedAek(DEVICE)).toBeUndefined();
    });

    it('leaves challengeId out of a save after a recovery', async () => {
        const { transport: t, stub } = transport(() => ({ status: 204 }));

        await t.saveWrappedAek(DEVICE, WRAPPED, {});

        expect(stub.sent[0]?.body).toEqual({ wrappedAek: WRAPPED, deviceMeta: {} });
    });

    it('returns the challenge and the commitment of a new join', async () => {
        const { transport: t } = transport(() => route('createJoin').answer);

        expect(await t.createJoin(REQUEST)).toEqual({ challengeId: CHALLENGE, aekCommitment: COMMITMENT });
    });

    it('reads an authorized join with the sealed AEK and the passphrase check', async () => {
        const { transport: t } = transport(() => ({ status: 200, body: { status: 'authorized', sealedAek: SEALED, passphraseCheck: SEALED } }));

        expect(await t.getJoinStatus(CHALLENGE)).toEqual({ status: 'authorized', sealedAek: SEALED, passphraseCheck: SEALED });
    });

    it.each(['pending', 'expired', 'denied'])('reads a %s join as its status alone', async status => {
        const { transport: t } = transport(() => ({ status: 200, body: { status, sealedAek: null, passphraseCheck: null } }));

        expect(await t.getJoinStatus(CHALLENGE)).toEqual({ status });
    });

    it.each<[string, unknown]>([
        ['a status the contract doesn\'t have', { status: 'approved' }],
        ['an authorized join without its sealed AEK', { status: 'authorized' }],
        ['an authorized join without its passphrase check', { status: 'authorized', sealedAek: SEALED }],
    ])('throws a SyncProtocolError for %s', async (_, body) => {
        const { transport: t } = transport(() => ({ status: 200, body }));

        await expect(t.getJoinStatus(CHALLENGE)).rejects.toThrow(SyncProtocolError);
    });

    it('lists the waiting joins with the server\'s receipt time in Unix milliseconds', async () => {
        const join = { challengeId: CHALLENGE, request: REQUEST, receivedAt: '2026-10-14T12:00:01Z', expiresAt: '2026-10-14T12:05:01Z' };
        const { transport: t } = transport(() => ({ status: 200, body: { joins: [join] } }));

        expect(await t.listPendingJoins()).toEqual([{ challengeId: CHALLENGE, request: REQUEST, receivedAt: Date.UTC(2026, 9, 14, 12, 0, 1) }]);
    });

    it('throws a SyncProtocolError for a join whose receipt time isn\'t a date', async () => {
        const join = { challengeId: CHALLENGE, request: REQUEST, receivedAt: 'soon' };
        const { transport: t } = transport(() => ({ status: 200, body: { joins: [join] } }));

        await expect(t.listPendingJoins()).rejects.toThrow(SyncProtocolError);
    });

    it('lists the devices, leaving out what a device didn\'t say about itself', async () => {
        const devices = [
            { deviceId: DEVICE, name: 'Laptop', platform: 'macOS', registeredAt: '2026-10-14T12:00:00Z' },
            { deviceId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: null, registeredAt: '2026-10-14T12:01:00Z' },
        ];
        const { transport: t } = transport(() => ({ status: 200, body: { devices } }));

        expect(await t.listDevices()).toEqual([
            { deviceId: DEVICE, name: 'Laptop', platform: 'macOS', registeredAt: '2026-10-14T12:00:00Z' },
            { deviceId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', registeredAt: '2026-10-14T12:01:00Z' },
        ]);
    });

    it.each<[string, number, string]>([
        ['createCircle', 400, 'invalid_request'],
        ['createCircle', 409, 'circle_exists'],
        ['getCommitment', 401, 'unauthenticated'],
        ['revokeDevice', 404, 'unknown_device'],
        ['revokeDevice', 409, 'last_device'],
        ['saveWrappedAek', 403, 'device_revoked'],
        ['saveWrappedAek', 403, 'join_mismatch'],
        ['saveWrappedAek', 404, 'unknown_join'],
        ['saveWrappedAek', 409, 'join_not_authorized'],
        ['saveWrappedAek', 410, 'join_expired'],
        ['createJoin', 404, 'no_circle'],
        ['createJoin', 409, 'device_registered'],
        ['getJoinStatus', 404, 'unknown_join'],
        ['authorizeJoin', 409, 'join_not_pending'],
        ['authorizeJoin', 410, 'join_expired'],
        ['denyJoin', 409, 'join_not_pending'],
        ['listDevices', 429, 'rate_limited'],
    ])('throws %s answering %i %s as a SyncTransportError', async (name, status, code) => {
        const { transport: t } = transport(() => errorAnswer(status, code));

        const error = await route(name).call(t).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SyncTransportError);
        expect(error).toMatchObject({ status, code });
    });

    it.each(Object.keys(ROUTES))('throws a rate-limited %s with its Retry-After', async name => {
        const { transport: t } = transport(() => errorAnswer(429, 'rate_limited', { 'Retry-After': '5' }));

        await expect(route(name).call(t)).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 5 });
    });
});

describe('CircleClient on FetchCircleTransport', () => {
    it('finds a device the server revoked no longer registered', async () => {
        const { transport: t, stub } = transport(() => errorAnswer(403, 'device_revoked'));
        const store = new MemoryCircleStore();
        await store.put('deviceId', DEVICE);
        const circle = new CircleClient({ transport: t, store });

        expect(await circle.isRegistered()).toBe(false);
        expect(stub.sent.map(r => r.url)).toEqual([`${BASE}/devices/${DEVICE}/wrapped-aek`]);
    });

    it('rejects revoking the last device with the server\'s last_device error', async () => {
        const { transport: t } = transport(() => errorAnswer(409, 'last_device'));
        const circle = new CircleClient({ transport: t, store: new MemoryCircleStore() });

        await expect(circle.revokeDevice(DEVICE)).rejects.toMatchObject({ status: 409, code: 'last_device' });
    });
});
