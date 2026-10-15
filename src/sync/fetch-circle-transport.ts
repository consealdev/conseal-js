import type { JoinRequest } from '../core/index.js';
import type {
    CircleTransport,
    DeviceInfo,
    DeviceMeta,
    JoinStatus,
    NewCircle,
    PendingJoinRequest,
} from './circle-transport.js';
import type { EncodedSealed, EncodedWrappedAek } from './encoding.js';
import { SyncProtocolError, SyncTransportError } from './errors.js';
import {
    FetchClient,
    field,
    isArray,
    isObject,
    isString,
    optionalField,
    type FetchTransportOptions,
} from './fetch-client.js';

/**
 * A `CircleTransport` over `fetch`, for the circle routes of conseal-sync-spec (`circle.yaml`), which a backend such as
 * `ConsealDev.ConsealSync` serves. The app's `fetch` carries its sign-in.
 *
 * The reads that can find nothing return undefined for the contract's answer that says so: `getCommitment` for
 * `no_circle`, and `getWrappedAek` for `unknown_device` and `device_revoked`. Otherwise every method throws
 * `SyncTransportError` for an answer that isn't a success, as `FetchSyncTransport` does, so the app handles a `401`
 * from either the same way.
 */
export class FetchCircleTransport implements CircleTransport
{
    private readonly _client: FetchClient;

    constructor(options: FetchTransportOptions)
    {
        this._client = new FetchClient(options);
    }

    public async createCircle(circle: NewCircle): Promise<void>
    {
        await this._client.send('POST', '', circle);
    }

    public getCommitment(): Promise<string | undefined>
    {
        return this._readUnlessAbsent('', ['no_circle'], body => field(body, 'aekCommitment', isString));
    }

    public getWrappedAek(deviceId: string): Promise<EncodedWrappedAek | undefined>
    {
        return this._readUnlessAbsent(
            `${devicePath(deviceId)}/wrapped-aek`,
            ['unknown_device', 'device_revoked'],
            body => field(body, 'wrappedAek', isObject) as EncodedWrappedAek);
    }

    public async saveWrappedAek(
        deviceId: string,
        wrappedAek: EncodedWrappedAek,
        deviceMeta: DeviceMeta,
        challengeId?: string,
    ): Promise<void>
    {
        await this._client.send('PUT', `${devicePath(deviceId)}/wrapped-aek`, { wrappedAek, deviceMeta, challengeId });
    }

    public async createJoin(request: JoinRequest): Promise<{ challengeId: string; aekCommitment: string }>
    {
        const body = await this._client.send('POST', '/joins', request);
        return { challengeId: field(body, 'challengeId', isString), aekCommitment: field(body, 'aekCommitment', isString) };
    }

    public async getJoinStatus(challengeId: string): Promise<JoinStatus>
    {
        const body = await this._client.send('GET', joinPath(challengeId));
        const status = field(body, 'status', isString);
        switch (status)
        {
            case 'pending':
            case 'expired':
            case 'denied':
                return { status };
            case 'authorized':
                return {
                    status,
                    sealedAek: field(body, 'sealedAek', isObject) as EncodedSealed,
                    passphraseCheck: field(body, 'passphraseCheck', isObject) as EncodedSealed,
                };
            default:
                throw new SyncProtocolError('The server answered a join request with a status the contract doesn\'t have.');
        }
    }

    public async listPendingJoins(): Promise<PendingJoinRequest[]>
    {
        const body = await this._client.send('GET', '/joins');
        return field(body, 'joins', isArray).map(join => ({
            challengeId: field(join, 'challengeId', isString),
            request: field(join, 'request', isObject) as JoinRequest,
            receivedAt: unixMilliseconds(field(join, 'receivedAt', isString)),
        }));
    }

    public async authorizeJoin(challengeId: string, sealedAek: EncodedSealed, passphraseCheck: EncodedSealed): Promise<void>
    {
        await this._client.send('POST', `${joinPath(challengeId)}/authorize`, { sealedAek, passphraseCheck });
    }

    public async denyJoin(challengeId: string): Promise<void>
    {
        await this._client.send('POST', `${joinPath(challengeId)}/deny`);
    }

    public async listDevices(): Promise<DeviceInfo[]>
    {
        const body = await this._client.send('GET', '/devices');
        return field(body, 'devices', isArray).map(device => ({
            deviceId: field(device, 'deviceId', isString),
            name: optionalField(device, 'name', isString),
            platform: optionalField(device, 'platform', isString),
            registeredAt: optionalField(device, 'registeredAt', isString),
        }));
    }

    public async revokeDevice(deviceId: string): Promise<void>
    {
        await this._client.send('DELETE', devicePath(deviceId));
    }

    /** Reads a route, or returns undefined when the server answers with one of the `absent` codes: nothing to read. */
    private async _readUnlessAbsent<T>(path: string, absent: readonly string[], read: (body: unknown) => T): Promise<T | undefined>
    {
        let body: unknown;
        try
        {
            body = await this._client.send('GET', path);
        }
        catch (error)
        {
            if (error instanceof SyncTransportError && error.code !== undefined && absent.includes(error.code)) return undefined;
            throw error;
        }
        return read(body);
    }
}

function devicePath(deviceId: string): string
{
    return `/devices/${encodeURIComponent(deviceId)}`;
}

function joinPath(challengeId: string): string
{
    return `/joins/${encodeURIComponent(challengeId)}`;
}

/** A server timestamp as `PendingJoinRequest` holds it, in Unix milliseconds. */
function unixMilliseconds(timestamp: string): number
{
    const milliseconds = Date.parse(timestamp);
    if (Number.isNaN(milliseconds))
    {
        throw new SyncProtocolError('The server answered a join request with a `receivedAt` that isn\'t a date.');
    }
    return milliseconds;
}
