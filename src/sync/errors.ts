// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Base class for the errors the circle ceremony raises. */
export class CircleError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = new.target.name;
    }
}

/** The passphrase doesn't open this device's key, or doesn't match the approving device's passphrase. */
export class WrongPassphraseError extends CircleError {}

/** This device holds no keys for the circle, or the server no longer knows it. It has to join or recover. */
export class DeviceNotRegisteredError extends CircleError {}

/** The AEK was asked for while the circle is locked on this device. */
export class LockedError extends CircleError {}

/** A key doesn't match the commitment the account published when the circle was created. */
export class CommitmentMismatchError extends CircleError {}

/**
 * A join's AEK can't be shown to come from a device that knows the passphrase: the approval has no passphrase check,
 * or its check vouches for another key. A dishonest server answering the join itself looks like this.
 */
export class UnverifiedKeyError extends CircleError {}

/** A join request is older than the ceremony allows. */
export class JoinExpiredError extends CircleError {}

/** A join session was asked for something its current state doesn't allow. */
export class JoinStateError extends CircleError {}

/** Base class for the errors the sync engine raises. */
export class SyncError extends Error
{
    constructor(message: string, options?: ErrorOptions)
    {
        super(message, options);
        this.name = new.target.name;
    }
}

/** The collection registry isn't valid, or names a merge policy that isn't registered. */
export class SyncConfigError extends SyncError {}

/** A record or id passed to the engine isn't one it can sync. */
export class InvalidRecordError extends SyncError {}

/** A record in an append-only collection was asked to change or be deleted. */
export class ImmutableRecordError extends SyncError {}

/**
 * A sealed record or blob doesn't open: it was altered, moved to another record or collection, or sealed under another
 * AEK, or a blob doesn't match its reference.
 */
export class UnreadableRecordError extends SyncError {}

/** A blob a record refers to isn't on this device or the server: it was deleted, or never uploaded. */
export class BlobNotFoundError extends SyncError {}

/** The server answered in a way the contract doesn't allow, such as results that don't match the items pushed. */
export class SyncProtocolError extends SyncError {}

/**
 * The user's identity isn't on this device: the keyring hasn't synced here, or the server's keyring doesn't open under
 * this circle's AEK, or doesn't hold the identity's keys.
 */
export class KeyringError extends SyncError {}

/**
 * A file given to import isn't an export or a sealed backup this version reads: another kind of file, one a newer
 * version made, or one that was damaged, cut short or altered.
 */
export class ArchiveError extends SyncError {}

/** A sealed backup's passcode is wrong, or a sealed backup was imported without one. */
export class WrongPasscodeError extends SyncError {}

export interface SyncTransportErrorOptions
{
    /** The contract's error `code` from the response body, when it has one. */
    code?: string | undefined;
    message?: string | undefined;
    /** The `Retry-After` header, in seconds. */
    retryAfter?: number | undefined;
}

/**
 * The server answered with an error status. A `SyncTransport` throws it for every answer that isn't a success, so the
 * engine can tell what to retry; a network failure is any other error. `FetchCircleTransport` throws it too, so an app
 * handles a `401` from the sync and the circle routes the same way.
 */
export class SyncTransportError extends SyncError
{
    public readonly status: number;
    public readonly code: string | undefined;
    public readonly retryAfter: number | undefined;

    constructor(status: number, options: SyncTransportErrorOptions = {})
    {
        super(options.message ?? `The sync server answered ${status}${options.code ? ` (${options.code})` : ''}.`);
        this.status = status;
        this.code = options.code;
        this.retryAfter = options.retryAfter;
    }
}
