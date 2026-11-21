// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { finalizeJoin, fromBase64, generateSecretKey, type WrappedAEK } from '../core/index.js';
import type { CircleTransport, JoinStatus } from './circle-transport.js';
import { decodeSealed, toArrayBuffer } from './encoding.js';
import { CommitmentMismatchError, JoinStateError, UnverifiedKeyError } from './errors.js';
import { verifyApproval } from './passphrase-check.js';

/**
 * Where a join stands on the joining device:
 *
 * - `waiting`: the request is posted; show `verificationCode` and ask the user to approve on a trusted device
 * - `authorized`: approved; ask for the passphrase and call `finish`
 * - `finalizing`: the device is taking the key and registering
 * - `done`: the device is in the circle and unlocked
 * - `expired`, `denied`, `failed`: the join is over; start a new one to try again
 */
export type JoinState =
    | { scene: 'waiting'; verificationCode: string }
    | { scene: 'authorized'; verificationCode: string }
    | { scene: 'finalizing' }
    | { scene: 'done'; deviceId: string }
    | { scene: 'expired' }
    | { scene: 'denied' }
    | { scene: 'failed'; error: Error };

/** Registers a device that has its AEK re-wrapped, and keeps its keys. Supplied by `CircleClient`. */
export type CompleteJoin = (wrapped: WrappedAEK, secretKey: Uint8Array, passphrase: string) => Promise<void>;

export interface JoinSessionInit
{
    transport: CircleTransport;
    challengeId: string;
    deviceId: string;
    verificationCode: string;
    aekCommitment: string;
    ephemeralPrivateKey: CryptoKey;
    complete: CompleteJoin;
}

type Authorization = Extract<JoinStatus, { status: 'authorized' }>;

/**
 * One device's attempt to join a circle, from posting the request to holding the AEK. Render the current `state`;
 * call `check` to poll for approval, then `finish` with the passphrase.
 */
export class JoinSession
{
    public readonly challengeId: string;
    public readonly deviceId: string;
    public readonly verificationCode: string;

    private readonly _transport: CircleTransport;
    private readonly _aekCommitment: string;
    private readonly _complete: CompleteJoin;
    private readonly _listeners = new Set<(state: JoinState) => void>();
    private _ephemeralPrivateKey: CryptoKey | undefined;
    private _authorization: Authorization | undefined;
    private _state: JoinState;

    constructor(init: JoinSessionInit)
    {
        this.challengeId = init.challengeId;
        this.deviceId = init.deviceId;
        this.verificationCode = init.verificationCode;
        this._transport = init.transport;
        this._aekCommitment = init.aekCommitment;
        this._complete = init.complete;
        this._ephemeralPrivateKey = init.ephemeralPrivateKey;
        this._state = { scene: 'waiting', verificationCode: init.verificationCode };
    }

    public get state(): JoinState
    {
        return this._state;
    }

    /** Calls `listener` with the current state now and on every change. Returns a function that stops it. */
    public subscribe(listener: (state: JoinState) => void): () => void
    {
        this._listeners.add(listener);
        listener(this._state);
        return () => {
            this._listeners.delete(listener);
        };
    }

    /** Asks the server once whether the request was approved. Outside `waiting` it only returns the state. */
    public async check(): Promise<JoinState>
    {
        if (this._state.scene !== 'waiting') return this._state;

        const status = await this._transport.getJoinStatus(this.challengeId);
        switch (status.status)
        {
            case 'authorized':
                this._authorization = status;
                this._set({ scene: 'authorized', verificationCode: this.verificationCode });
                break;
            case 'expired':
            case 'denied':
                this._end({ scene: status.status });
                break;
            case 'pending':
                break;
        }
        return this._state;
    }

    /**
     * Finishes joining with the passphrase this device will unlock with, which must be the approving device's: a
     * mismatch throws `WrongPassphraseError` and the session stays `authorized`, so the user can try again. The key
     * is taken only with the approving device's passphrase check, which vouches for it. An approval without one, or
     * whose check vouches for another key, ends the session as `failed` with `UnverifiedKeyError`; a key that doesn't
     * match the account's commitment, with `CommitmentMismatchError`. Any other failure returns it to `authorized`.
     */
    public async finish(passphrase: string): Promise<void>
    {
        const authorization = this._authorization;
        const ephemeralPrivateKey = this._ephemeralPrivateKey;
        if (this._state.scene !== 'authorized' || !authorization || !ephemeralPrivateKey)
        {
            throw new JoinStateError(`A join that is ${this._state.scene} can't be finished.`);
        }

        try
        {
            await verifyApproval(authorization.passphraseCheck, authorization.sealedAek, ephemeralPrivateKey, passphrase);
        }
        catch (error)
        {
            if (error instanceof UnverifiedKeyError) this._end({ scene: 'failed', error });
            throw error;
        }

        this._set({ scene: 'finalizing' });
        try
        {
            const secretKey = generateSecretKey();
            const { wrappedAEK } = await finalizeJoin(
                decodeSealed(authorization.sealedAek),
                ephemeralPrivateKey,
                passphrase,
                secretKey,
                toArrayBuffer(fromBase64(this._aekCommitment)),
            );
            await this._complete(wrappedAEK, secretKey, passphrase);
            this._end({ scene: 'done', deviceId: this.deviceId });
        }
        catch (error)
        {
            if (isCommitmentMismatch(error))
            {
                const mismatch = new CommitmentMismatchError(
                    'The key from the approving device doesn\'t match the account\'s commitment: it may have been substituted.',
                );
                this._end({ scene: 'failed', error: mismatch });
                throw mismatch;
            }
            this._set({ scene: 'authorized', verificationCode: this.verificationCode });
            throw error;
        }
    }

    private _set(state: JoinState): void
    {
        this._state = state;
        for (const listener of this._listeners)
        {
            listener(state);
        }
    }

    /** Moves to a final state and drops the key material the ceremony held. */
    private _end(state: JoinState): void
    {
        this._ephemeralPrivateKey = undefined;
        this._authorization = undefined;
        this._set(state);
    }
}

// conseal's finalizeJoin reports a substituted key with this message; the join tests pin it.
function isCommitmentMismatch(error: unknown): boolean
{
    return error instanceof Error && error.message.includes('commitment mismatch');
}
