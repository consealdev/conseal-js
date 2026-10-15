import type { JoinRequest } from '../core/index.js';
import type { EncodedSealed, EncodedWrappedAek } from './encoding.js';

/** What a device says about itself in the device list. */
export interface DeviceMeta
{
    name?: string | undefined;
    platform?: string | undefined;
}

/** A device in the circle, as the server lists it. */
export interface DeviceInfo extends DeviceMeta
{
    deviceId: string;
    registeredAt?: string | undefined;
}

/** What the founding device registers when it creates the circle. */
export interface NewCircle
{
    deviceId: string;
    /** SHA-256 of the raw AEK, base64. Written once: a server that lets it change allows key substitution. */
    aekCommitment: string;
    wrappedAek: EncodedWrappedAek;
    deviceMeta: DeviceMeta;
}

/** A join request waiting for approval, as the server holds it. */
export interface PendingJoinRequest
{
    challengeId: string;
    request: JoinRequest;
    /** When the server received the request, in Unix milliseconds: the server's clock, never the request's own `createdAt`. */
    receivedAt: number;
}

/** Where a join request stands, as the joining device polls it. */
export type JoinStatus =
    | { status: 'pending' }
    | { status: 'authorized'; sealedAek: EncodedSealed; passphraseCheck: EncodedSealed }
    | { status: 'expired' }
    | { status: 'denied' };

/**
 * The app's side of the circle: its HTTP client, sign-in and routes. `CircleClient` holds the ceremony and every
 * cryptographic step; a transport only moves the encoded values to the server and back. Every method acts for the
 * signed-in user, and throws for an answer that isn't a success, except where it says it returns undefined.
 * `FetchCircleTransport` is one, for the circle routes of conseal-sync-spec.
 */
export interface CircleTransport
{
    /** Registers the founding device and the AEK commitment. */
    createCircle(circle: NewCircle): Promise<void>;

    /** The account's AEK commitment, base64, or undefined when the account has no circle. */
    getCommitment(): Promise<string | undefined>;

    /** A device's wrapped AEK, or undefined when the server doesn't know the device or it was revoked. */
    getWrappedAek(deviceId: string): Promise<EncodedWrappedAek | undefined>;

    /**
     * Stores a device's wrapped AEK. `challengeId` is set when the device joined through the ceremony, and the
     * server consumes the challenge; it is absent after a recovery.
     */
    saveWrappedAek(deviceId: string, wrappedAek: EncodedWrappedAek, deviceMeta: DeviceMeta, challengeId?: string): Promise<void>;

    /** Posts a new device's join request. Returns its challenge and the account's AEK commitment. */
    createJoin(request: JoinRequest): Promise<{ challengeId: string; aekCommitment: string }>;

    getJoinStatus(challengeId: string): Promise<JoinStatus>;

    listPendingJoins(): Promise<PendingJoinRequest[]>;

    /** Hands the joining device its sealed AEK and the sealed check of the approver's passphrase. */
    authorizeJoin(challengeId: string, sealedAek: EncodedSealed, passphraseCheck: EncodedSealed): Promise<void>;

    denyJoin(challengeId: string): Promise<void>;

    listDevices(): Promise<DeviceInfo[]>;

    revokeDevice(deviceId: string): Promise<void>;
}
