// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export { CircleClient } from './circle-client.js';
export type {
    CircleClientOptions,
    CircleDevice,
    DeviceStatus,
    PendingJoin,
    RecoverOptions,
    SetupResult,
} from './circle-client.js';

export { JoinSession } from './join-session.js';
export type { JoinState } from './join-session.js';

export type {
    CircleTransport,
    DeviceInfo,
    DeviceMeta,
    JoinStatus,
    NewCircle,
    PendingJoinRequest,
} from './circle-transport.js';

export { IndexedDbCircleStore, MemoryCircleStore } from './circle-store.js';
export type { CircleStore, CircleStoreKey } from './circle-store.js';

export type { EncodedSealed, EncodedWrappedAek } from './encoding.js';

export { SyncEngine } from './sync-engine.js';
export type { Keyring, SyncEngineOptions, SyncEvent, SyncReport } from './sync-engine.js';

export type { BlobRef } from './blob-envelope.js';

export { KEYRING_COLLECTION } from './identity.js';
export type { Identity } from './identity.js';

export { defineCollections, isRecordId, newRecordId } from './collections.js';
export type { CollectionDefinition, CollectionDefinitions, MergeDescriptor } from './collections.js';

export { lastWriteWins } from './merge-policy.js';
export type { MergeInput, MergePolicy, MergePolicyFactory } from './merge-policy.js';

export { archiveKind } from './archive.js';
export type { ArchiveKind, ExportOptions, ImportOptions, ImportReport } from './archive.js';

export { MemoryRecordStore } from './record-store.js';
export type { LocalRecord, PendingBlob, RecordStore, RejectionCode } from './record-store.js';

export type {
    BlobUrl,
    CollectionLimits,
    PushItem,
    PushResult,
    RecordDelete,
    RecordWrite,
    SyncConfig,
    SyncErrorBody,
    SyncPage,
    SyncRecord,
    SyncTransport,
} from './sync-transport.js';

export { FetchCircleTransport } from './fetch-circle-transport.js';
export { FetchSyncTransport } from './fetch-sync-transport.js';
export type { FetchSyncTransportOptions } from './fetch-sync-transport.js';
export type { FetchFunction, FetchTransportOptions } from './fetch-client.js';

export {
    ArchiveError,
    BlobNotFoundError,
    CircleError,
    CommitmentMismatchError,
    DeviceNotRegisteredError,
    ImmutableRecordError,
    InvalidRecordError,
    JoinExpiredError,
    JoinStateError,
    KeyringError,
    LockedError,
    SyncConfigError,
    SyncError,
    SyncProtocolError,
    SyncTransportError,
    UnreadableRecordError,
    UnverifiedKeyError,
    WrongPasscodeError,
    WrongPassphraseError,
} from './errors.js';
export type { SyncTransportErrorOptions } from './errors.js';

export type { JoinRequest } from '../core/index.js';
