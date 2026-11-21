// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import {
    authorizeJoin,
    createJoinRequest,
    deriveVerificationCode,
    digest,
    fromBase64,
    generateMnemonic,
    generateSecretKey,
    initCircle,
    recoverWithMnemonic,
    toBase64,
    unwrapKey,
    wrapKey,
    type SealedAEK,
    type WrappedAEK,
} from '../core/index.js';
import { IndexedDbCircleStore, type CircleStore } from './circle-store.js';
import type { CircleTransport, DeviceInfo, DeviceMeta, PendingJoinRequest } from './circle-transport.js';
import { decodeWrappedAek, encodeSealed, encodeWrappedAek, type EncodedWrappedAek } from './encoding.js';
import {
    CommitmentMismatchError,
    DeviceNotRegisteredError,
    JoinExpiredError,
    LockedError,
    WrongPassphraseError,
} from './errors.js';
import { JoinSession } from './join-session.js';
import { sealPassphraseCheck } from './passphrase-check.js';

/** How long a join request can wait for approval, by the server's clock. conseal's `authorizeJoin` enforces the same. */
const JOIN_TTL_MS = 5 * 60 * 1000;

export interface CircleClientOptions
{
    transport: CircleTransport;
    /** Where this device keeps its keys. Defaults to IndexedDB, which needs a browser; pass a store in Node. */
    store?: CircleStore | undefined;
}

/**
 * Where this device stands with the circle:
 *
 * - `unlocked`: it holds the AEK
 * - `locked`: it holds its keys and needs the passphrase
 * - `unregistered`: it holds no keys, so it has to join or recover
 */
export type DeviceStatus = 'unlocked' | 'locked' | 'unregistered';

export interface SetupResult
{
    /** The 24-word recovery phrase. Show it to the user once; never store or send it. */
    mnemonic: string;
    deviceId: string;
    aekCommitment: string;
}

export interface RecoverOptions
{
    deviceMeta?: DeviceMeta | undefined;
    /** Revoke every other device once this one is recovered, for when the others may be lost or compromised. */
    revokeOtherDevices?: boolean | undefined;
}

/** A join request waiting for this device's approval, with the code the user must compare. */
export interface PendingJoin extends PendingJoinRequest
{
    verificationCode: string;
}

export interface CircleDevice extends DeviceInfo
{
    /** Whether this is the device the client runs on. */
    current: boolean;
}

/**
 * The circle ceremony without a UI: creating the circle, unlocking, joining a device, approving one, recovering
 * from the mnemonic, and managing devices. It holds the state machine and every cryptographic step; the app
 * supplies HTTP through a `CircleTransport` and renders what the client reports.
 */
export class CircleClient
{
    private readonly _transport: CircleTransport;
    private readonly _store: CircleStore;

    constructor(options: CircleClientOptions)
    {
        this._transport = options.transport;
        this._store = options.store ?? new IndexedDbCircleStore();
    }

    /** This device's id, once it has created, joined or recovered the circle. */
    public deviceId(): Promise<string | undefined>
    {
        return this._store.get<string>('deviceId');
    }

    /** Where this device stands, from what it holds locally. `isRegistered` asks the server. */
    public async status(): Promise<DeviceStatus>
    {
        // A device unlocked before it kept its commitment reads as locked, so its next unlock works the commitment out.
        if (await this._store.get<CryptoKey>('aek') && await this._store.get<string>('aekCommitment')) return 'unlocked';
        const deviceId = await this._store.get<string>('deviceId');
        const secretKey = await this._store.get<Uint8Array>('secretKey');
        return deviceId && secretKey ? 'locked' : 'unregistered';
    }

    /** Whether the server still knows this device: false when it never registered or was revoked. */
    public async isRegistered(): Promise<boolean>
    {
        const deviceId = await this.deviceId();
        return deviceId !== undefined && await this._transport.getWrappedAek(deviceId) !== undefined;
    }

    /**
     * Creates the circle with this as its first device, and unlocks it. The returned mnemonic is the circle's
     * root of trust: show it to the user once, and never store it.
     */
    public async setup(passphrase: string, deviceMeta: DeviceMeta = {}): Promise<SetupResult>
    {
        const mnemonic = generateMnemonic();
        const secretKey = generateSecretKey();
        const { wrappedAEK, aekCommitment, deviceId } = await initCircle(mnemonic, passphrase, secretKey);
        const commitment = toBase64(aekCommitment);

        await this._transport.createCircle({
            deviceId,
            aekCommitment: commitment,
            wrappedAek: encodeWrappedAek(wrappedAEK),
            deviceMeta,
        });
        await this._keep(deviceId, secretKey, wrappedAEK, passphrase, commitment);
        return { mnemonic, deviceId, aekCommitment: commitment };
    }

    /**
     * Unlocks this device with its passphrase. Throws `WrongPassphraseError` when it doesn't open the key, and
     * `DeviceNotRegisteredError` when the device has to join or recover instead.
     */
    public async unlock(passphrase: string): Promise<void>
    {
        const { secretKey, wrapped } = await this._ownKeys();
        if (await this._store.get<string>('aekCommitment') === undefined)
        {
            // A device from before it kept its commitment works it out once, from the AEK it holds.
            const aek = await unwrapAek(passphrase, wrapped, secretKey, true);
            await this._store.put('aekCommitment', toBase64(await digest(await crypto.subtle.exportKey('raw', aek))));
        }
        await this._store.put('aek', await unwrapAek(passphrase, wrapped, secretKey));
    }

    /**
     * A key for sealing data of the app's own that only the passphrase opens: the AEK this device keeps unlocked for
     * syncing can't make it, since a script that uses that key can't read its bytes. The key is derived from the AEK, so
     * every device of the circle derives the same one from the same passphrase, and a different `purpose` gives an
     * unrelated key. It is non-extractable and nothing of it is kept: call again, with the passphrase, whenever it's
     * needed, and let go of it when the user's unlock is over.
     *
     * Throws `WrongPassphraseError` when the passphrase doesn't open the key, and `DeviceNotRegisteredError` when the
     * device has to join or recover instead.
     */
    public async deriveKey(passphrase: string, purpose: string): Promise<CryptoKey>
    {
        if (purpose === '') throw new TypeError('deriveKey: a purpose is required, so keys for different uses stay apart.');
        const { secretKey, wrapped } = await this._ownKeys();
        const aek = await unwrapAek(passphrase, wrapped, secretKey, true);
        // The AEK is uniformly random, so an empty salt will do; the label gives the domain separation.
        const material = await crypto.subtle.importKey('raw', await crypto.subtle.exportKey('raw', aek), 'HKDF', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`conseal-derived-key-v1:${purpose}`) },
            material,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt'],
        );
    }

    /** Forgets the unlocked AEK. The device keeps its keys and unlocks again with its passphrase. */
    public lock(): Promise<void>
    {
        return this._store.delete('aek');
    }

    /** The AEK, for sealing the user's data. Throws `LockedError` until the device is unlocked. */
    public async aek(): Promise<CryptoKey>
    {
        const aek = await this._store.get<CryptoKey>('aek');
        if (!aek) throw new LockedError('The circle is locked on this device. Unlock it first.');
        return aek;
    }

    /**
     * Recovers the circle on this device from the mnemonic, under a new passphrase. The recovered key is checked
     * against the account's commitment before anything is registered, so a mistyped phrase that still passes the
     * BIP-39 checksum is refused with `CommitmentMismatchError` rather than replacing the circle's key.
     */
    public async recover(mnemonic: string, newPassphrase: string, options: RecoverOptions = {}): Promise<{ deviceId: string; aekCommitment: string }>
    {
        const aek = await recoverWithMnemonic(mnemonic, true);
        const commitment = toBase64(await digest(await crypto.subtle.exportKey('raw', aek)));
        const published = await this._transport.getCommitment();
        if (published === undefined)
        {
            throw new CommitmentMismatchError('The account has no circle to recover.');
        }
        if (commitment !== published)
        {
            throw new CommitmentMismatchError('This recovery phrase belongs to a different circle.');
        }

        // Keep this device's id while the server still knows it, so a recovery doesn't leave a stale entry.
        const existing = await this.deviceId();
        const deviceId = existing !== undefined && await this._transport.getWrappedAek(existing) !== undefined
            ? existing
            : crypto.randomUUID();
        const secretKey = generateSecretKey();
        const wrapped = await wrapKey(newPassphrase, aek, secretKey);

        await this._transport.saveWrappedAek(deviceId, encodeWrappedAek(wrapped), options.deviceMeta ?? {});
        await this._keep(deviceId, secretKey, wrapped, newPassphrase, commitment);

        if (options.revokeOtherDevices)
        {
            for (const device of await this._transport.listDevices())
            {
                if (device.deviceId !== deviceId) await this._transport.revokeDevice(device.deviceId);
            }
        }
        return { deviceId, aekCommitment: commitment };
    }

    /**
     * Starts joining an existing circle from this device: posts a join request and returns the session that
     * carries it through. Show its `verificationCode` while the user approves on a trusted device.
     *
     * The code covers the account's commitment, which the device reads before its key pair exists, so whoever
     * supplies it can't choose it after seeing the key. The session checks the AEK against that same commitment.
     */
    public async startJoin(deviceMeta: DeviceMeta = {}): Promise<JoinSession>
    {
        const aekCommitment = await this._transport.getCommitment();
        if (aekCommitment === undefined)
        {
            throw new CommitmentMismatchError('The account has no circle to join.');
        }
        const { request, ephemeralPrivateKey, verificationCode } = await createJoinRequest(fromBase64(aekCommitment), deviceMeta);
        const { challengeId } = await this._transport.createJoin(request);

        return new JoinSession({
            transport: this._transport,
            challengeId,
            deviceId: request.deviceId,
            verificationCode,
            aekCommitment,
            ephemeralPrivateKey,
            complete: async (wrapped, secretKey, passphrase) => {
                await this._transport.saveWrappedAek(request.deviceId, encodeWrappedAek(wrapped), deviceMeta, challengeId);
                await this._keep(request.deviceId, secretKey, wrapped, passphrase, aekCommitment);
            },
        });
    }

    /**
     * The join requests waiting for approval, each with the code to compare with the joining device. The codes cover
     * this device's own commitment, never one the server supplies, so a joining device given another key's commitment
     * shows a code that differs. Throws `LockedError` on a device that hasn't unlocked since it began keeping its
     * commitment.
     */
    public async pendingJoins(): Promise<PendingJoin[]>
    {
        const commitment = await this._store.get<string>('aekCommitment');
        if (commitment === undefined)
        {
            throw new LockedError('Unlock the circle on this device to see its join requests.');
        }
        const aekCommitment = fromBase64(commitment);
        const pending = await this._transport.listPendingJoins();
        return Promise.all(pending.map(async join => ({
            ...join,
            verificationCode: await deriveVerificationCode(join.request.ephemeralPublicKey, aekCommitment),
        })));
    }

    /**
     * Approves a join request with this device's passphrase. It seals the AEK, and a check of the passphrase that
     * vouches for that sealed AEK, for the joining device's ephemeral key only.
     *
     * Call it only after the user has confirmed that `join.verificationCode` matches the code on the joining
     * device, and pass `codeConfirmed: true` to say so. That comparison is the ceremony's defence against a
     * substituted key: approving without it hands the AEK to whoever posted the request.
     */
    public async approveJoin(join: PendingJoin, passphrase: string, codeConfirmed: true): Promise<void>
    {
        if (codeConfirmed !== true)
        {
            throw new TypeError('approveJoin needs the user to have confirmed the verification code.');
        }
        if (Date.now() - join.receivedAt > JOIN_TTL_MS)
        {
            throw new JoinExpiredError('This join request has expired. Ask the other device to try again.');
        }

        const { secretKey, wrapped } = await this._ownKeys();
        let sealedAek: SealedAEK;
        try
        {
            sealedAek = await authorizeJoin(join.request, wrapped, passphrase, secretKey, join.receivedAt);
        }
        catch (error)
        {
            throw asWrongPassphrase(error);
        }
        const encoded = encodeSealed(sealedAek);
        const passphraseCheck = await sealPassphraseCheck(passphrase, encoded, join.request.ephemeralPublicKey);
        await this._transport.authorizeJoin(join.challengeId, encoded, passphraseCheck);
    }

    public denyJoin(challengeId: string): Promise<void>
    {
        return this._transport.denyJoin(challengeId);
    }

    /** The circle's devices, this one marked `current`. */
    public async devices(): Promise<CircleDevice[]>
    {
        const current = await this.deviceId();
        const devices = await this._transport.listDevices();
        return devices.map(device => ({ ...device, current: device.deviceId === current }));
    }

    /**
     * Revokes a device: it stops syncing. It keeps the AEK it already holds, so revoking isn't the same as taking
     * the key back.
     */
    public revokeDevice(deviceId: string): Promise<void>
    {
        return this._transport.revokeDevice(deviceId);
    }

    /** This device's Secret Key and wrapped AEK, fetching the wrapped AEK from the server when it isn't local. */
    private async _ownKeys(): Promise<{ secretKey: Uint8Array; wrapped: WrappedAEK }>
    {
        const deviceId = await this._store.get<string>('deviceId');
        const secretKey = await this._store.get<Uint8Array>('secretKey');
        if (!deviceId || !secretKey)
        {
            throw new DeviceNotRegisteredError('This device holds no keys for the circle. Join or recover.');
        }

        let encoded = await this._store.get<EncodedWrappedAek>('wrappedAek');
        if (!encoded)
        {
            encoded = await this._transport.getWrappedAek(deviceId);
            if (!encoded)
            {
                throw new DeviceNotRegisteredError('The server no longer knows this device. Join or recover.');
            }
            await this._store.put('wrappedAek', encoded);
        }
        return { secretKey, wrapped: decodeWrappedAek(encoded) };
    }

    /** Keeps a device's keys, and the commitment it took the AEK with, and unlocks it. */
    private async _keep(
        deviceId: string,
        secretKey: Uint8Array,
        wrapped: WrappedAEK,
        passphrase: string,
        aekCommitment: string,
    ): Promise<void>
    {
        const aek = await unwrapAek(passphrase, wrapped, secretKey);
        await this._store.put('deviceId', deviceId);
        await this._store.put('secretKey', secretKey);
        await this._store.put('wrappedAek', encodeWrappedAek(wrapped));
        await this._store.put('aekCommitment', aekCommitment);
        await this._store.put('aek', aek);
    }
}

/**
 * Unwraps the AEK, non-extractable unless asked: a script that can use it still can't read its bytes. Only `unlock`
 * asks, once, to work out the commitment of a device that didn't keep one.
 */
async function unwrapAek(passphrase: string, wrapped: WrappedAEK, secretKey: Uint8Array, extractable = false): Promise<CryptoKey>
{
    try
    {
        return await unwrapKey(passphrase, wrapped.wrappedKey, wrapped.salt, secretKey, extractable);
    }
    catch (error)
    {
        throw asWrongPassphrase(error);
    }
}

// SubtleCrypto reports a failed AES-GCM unwrap, which is what a wrong passphrase causes, as an OperationError.
function asWrongPassphrase(error: unknown): unknown
{
    if (error instanceof Error && error.name === 'OperationError')
    {
        return new WrongPassphraseError('The passphrase doesn\'t open this device\'s key.');
    }
    return error;
}
