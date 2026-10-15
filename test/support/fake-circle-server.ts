import type { JoinRequest } from '../../src/core/index.js';
import type {
    CircleTransport,
    DeviceInfo,
    DeviceMeta,
    JoinStatus,
    NewCircle,
    PendingJoinRequest,
} from '../../src/sync/circle-transport.js';
import type { EncodedSealed, EncodedWrappedAek } from '../../src/sync/encoding.js';

const JOIN_TTL_MS = 5 * 60 * 1000;

interface Device extends DeviceInfo
{
    wrappedAek: EncodedWrappedAek;
    revoked: boolean;
}

interface Challenge
{
    deviceId: string;
    request: JoinRequest;
    receivedAt: number;
    status: 'pending' | 'authorized' | 'completed' | 'expired' | 'denied';
    sealedAek?: EncodedSealed;
    passphraseCheck?: EncodedSealed;
}

/**
 * One user's circle as an honest server keeps it, in memory, following conseal's circle API rules: the commitment
 * is written once, a challenge is authorized once and consumed once, requests expire by the server's clock, and
 * the last device can't be revoked.
 */
export class FakeCircleServer
{
    public commitment: string | undefined;
    public readonly devices = new Map<string, Device>();
    public readonly challenges = new Map<string, Challenge>();
    /** Moves the server's clock, to expire requests. */
    public now = (): number => Date.now();

    /** A transport for one device of this server's user. */
    public transport(): CircleTransport
    {
        return new FakeCircleTransport(this);
    }
}

class FakeCircleTransport implements CircleTransport
{
    private readonly _server: FakeCircleServer;

    constructor(server: FakeCircleServer)
    {
        this._server = server;
    }

    public async createCircle(circle: NewCircle): Promise<void>
    {
        if (this._server.commitment !== undefined) throw new Error('409: the circle exists.');
        this._server.commitment = circle.aekCommitment;
        this._register(circle.deviceId, circle.wrappedAek, circle.deviceMeta);
    }

    public async getCommitment(): Promise<string | undefined>
    {
        return this._server.commitment;
    }

    public async getWrappedAek(deviceId: string): Promise<EncodedWrappedAek | undefined>
    {
        const device = this._server.devices.get(deviceId);
        return device && !device.revoked ? device.wrappedAek : undefined;
    }

    public async saveWrappedAek(
        deviceId: string,
        wrappedAek: EncodedWrappedAek,
        deviceMeta: DeviceMeta,
        challengeId?: string,
    ): Promise<void>
    {
        if (challengeId !== undefined)
        {
            const challenge = this._server.challenges.get(challengeId);
            if (!challenge || challenge.status !== 'authorized' || challenge.deviceId !== deviceId)
            {
                throw new Error('403: the challenge doesn\'t authorize this device.');
            }
            challenge.status = 'completed';
            this._server.challenges.delete(challengeId);
        }
        if (this._server.devices.get(deviceId)?.revoked) throw new Error('403: the device is revoked.');
        this._register(deviceId, wrappedAek, deviceMeta);
    }

    public async createJoin(request: JoinRequest): Promise<{ challengeId: string; aekCommitment: string }>
    {
        if (this._server.commitment === undefined) throw new Error('400: the account has no circle.');
        const challengeId = crypto.randomUUID();
        this._server.challenges.set(challengeId, {
            deviceId: request.deviceId,
            request,
            receivedAt: this._server.now(),
            status: 'pending',
        });
        return { challengeId, aekCommitment: this._server.commitment };
    }

    public async getJoinStatus(challengeId: string): Promise<JoinStatus>
    {
        const challenge = this._challenge(challengeId);
        this._expire(challenge);
        switch (challenge.status)
        {
            case 'authorized':
                return {
                    status: 'authorized',
                    // authorizeJoin sets both in the same step that makes a challenge authorized.
                    sealedAek: challenge.sealedAek!,
                    passphraseCheck: challenge.passphraseCheck!,
                };
            case 'expired':
            case 'denied':
                return { status: challenge.status };
            default:
                return { status: 'pending' };
        }
    }

    public async listPendingJoins(): Promise<PendingJoinRequest[]>
    {
        const pending: PendingJoinRequest[] = [];
        for (const [challengeId, challenge] of this._server.challenges)
        {
            this._expire(challenge);
            if (challenge.status === 'pending')
            {
                pending.push({ challengeId, request: challenge.request, receivedAt: challenge.receivedAt });
            }
        }
        return pending;
    }

    public async authorizeJoin(challengeId: string, sealedAek: EncodedSealed, passphraseCheck: EncodedSealed): Promise<void>
    {
        const challenge = this._challenge(challengeId);
        this._expire(challenge);
        if (challenge.status !== 'pending') throw new Error(`410: the challenge is ${challenge.status}.`);
        challenge.status = 'authorized';
        challenge.sealedAek = sealedAek;
        challenge.passphraseCheck = passphraseCheck;
    }

    public async denyJoin(challengeId: string): Promise<void>
    {
        const challenge = this._challenge(challengeId);
        if (challenge.status === 'pending') challenge.status = 'denied';
    }

    public async listDevices(): Promise<DeviceInfo[]>
    {
        return [...this._server.devices.values()]
            .filter(device => !device.revoked)
            .map(({ deviceId, name, platform, registeredAt }) => ({ deviceId, name, platform, registeredAt }));
    }

    public async revokeDevice(deviceId: string): Promise<void>
    {
        const device = this._server.devices.get(deviceId);
        if (!device) throw new Error('404: no such device.');
        const active = [...this._server.devices.values()].filter(candidate => !candidate.revoked);
        if (active.length === 1 && !device.revoked) throw new Error('400: the last active device can\'t be revoked.');
        device.revoked = true;
    }

    private _register(deviceId: string, wrappedAek: EncodedWrappedAek, deviceMeta: DeviceMeta): void
    {
        const existing = this._server.devices.get(deviceId);
        this._server.devices.set(deviceId, {
            deviceId,
            ...deviceMeta,
            registeredAt: existing?.registeredAt ?? new Date(this._server.now()).toISOString(),
            wrappedAek,
            revoked: false,
        });
    }

    private _challenge(challengeId: string): Challenge
    {
        const challenge = this._server.challenges.get(challengeId);
        if (!challenge) throw new Error('404: no such challenge.');
        return challenge;
    }

    private _expire(challenge: Challenge): void
    {
        if (challenge.status === 'pending' && this._server.now() - challenge.receivedAt > JOIN_TTL_MS)
        {
            challenge.status = 'expired';
        }
    }
}
