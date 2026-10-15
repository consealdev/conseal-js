# Sync and the ceremony screens

`@consealdev/conseal/sync` is encrypted sync for a user's own devices, built on the crypto core at
`@consealdev/conseal`.

It holds two parts, neither with a DOM or HTTP of its own, so they run in a browser, in Node, or behind any UI
framework:

- **`CircleClient`, the circle ceremony:** creating the circle, unlocking, joining a device, approving one, recovering
  from the mnemonic, and managing devices. The app supplies HTTP through a `CircleTransport` and renders what the
  client reports.
- **`SyncEngine`, the data plane:** the app saves and deletes records in plaintext; a sync seals what changed, pushes
  it, pulls what the other devices wrote, and merges it in. Content too large for a record, such as a file, goes in a
  blob, sealed on the device and moved straight to and from object storage. `exportAll` and `importAll` move the
  user's records to and from a file they keep, and `identity` gives every device the user's identity key pairs. The
  app supplies HTTP through a `SyncTransport`, which follows the
  [sync contract](https://github.com/consealdev/conseal/tree/main/spec), and local storage through a `RecordStore`.

`FetchSyncTransport` and `FetchCircleTransport` are those transports for a backend that serves the contract's routes,
such as `ConsealDev.Conseal`, over the app's own `fetch`. A second entry point, `@consealdev/conseal/ui`,
has the ceremony's screens as Lit components over `CircleClient` (see [The ceremony screens](#the-ceremony-screens)).

## The backend

The sync routes are the contract's `openapi.yaml`, the circle routes its `circle.yaml`. Give each transport the URL
where the backend maps its route group, and a `fetch` that signs the request in:

```ts
import { FetchCircleTransport, FetchSyncTransport, type FetchFunction } from '@consealdev/conseal/sync';

// The app's sign-in: here a bearer token, refreshed once when the server says it has expired.
const signedIn: FetchFunction = async (url, init) => {
    const send = async (): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${await auth.token()}`);
        return fetch(url, { ...init, headers });
    };
    const response = await send();
    if (response.status !== 401) return response;
    await auth.refresh();
    return send();
};

const syncTransport = new FetchSyncTransport({ baseUrl: 'https://api.example.com/sync', fetch: signedIn });
const circleTransport = new FetchCircleTransport({ baseUrl: 'https://api.example.com/circle', fetch: signedIn });
```

Without `fetch`, the global one is used, which sends cookies to its own origin. For a cookie sign-in on another origin,
pass `(url, init) => fetch(url, { ...init, credentials: 'include' })`.

A blob's bytes go to and from object storage directly, through URLs the server presigns. Those carry their own
signature, so `FetchSyncTransport` sends them through `blobFetch`, the global `fetch` by default, never through the
app's sign-in: storage refuses a request signed twice. The bucket's CORS rules have to let the app's origin `PUT` and
`GET`.

Every answer that isn't a success throws `SyncTransportError`, with the `status`, the body's `code`, and `retryAfter`
from the `Retry-After` header, in seconds. A `401` from either transport means the same: the user has to sign in. The
reads that can find nothing return undefined instead: `getCommitment` for an account with no circle, and
`getWrappedAek` for a device the server doesn't know or has revoked. A success the contract doesn't allow throws
`SyncProtocolError`, and a network failure comes through as `fetch` threw it.

A backend with routes of its own needs a `SyncTransport` and a `CircleTransport` written for them.

## The circle

```ts
import { CircleClient, IndexedDbCircleStore } from '@consealdev/conseal/sync';

const circle = new CircleClient({
    transport: circleTransport,                  // see The backend
    store: new IndexedDbCircleStore('my-app'),   // the default in a browser; MemoryCircleStore in Node
});

// First device
const { mnemonic } = await circle.setup(passphrase, { name: 'Phone' });   // show the mnemonic once

// Every later visit
switch (await circle.status())
{
    case 'unlocked': break;
    case 'locked': await circle.unlock(passphrase); break;
    case 'unregistered': /* join or recover */ break;
}

// Sealing data
const aek = await circle.aek();
```

### Joining a device

On the new device:

```ts
const session = await circle.startJoin({ name: 'Laptop' });
session.subscribe(state => render(state));   // show state.verificationCode while it's 'waiting'
await session.check();                       // poll until 'authorized'
await session.finish(passphrase);            // 'done': the device is in the circle and unlocked
```

On a trusted device:

```ts
const [join] = await circle.pendingJoins();
// Show join.verificationCode. Only once the user confirms it matches the new device's code:
await circle.approveJoin(join, passphrase, true);
```

### The transport

`CircleTransport` has one method per circle route: create the circle, read the commitment, store and read a device's
wrapped AEK, post and poll a join request, approve or deny it, list and revoke devices. Every value it moves is
already encoded for JSON. `FetchCircleTransport` is one, for the routes of the contract's `circle.yaml`.

### Errors

`WrongPassphraseError`, `DeviceNotRegisteredError` (join or recover), `LockedError`, `CommitmentMismatchError`,
`UnverifiedKeyError` (a join's key that no passphrase check vouches for), `JoinExpiredError` and `JoinStateError`, all
extending `CircleError`. Show them in the app's own words. The server's answers come through as the transport throws
them: `SyncTransportError` from `FetchCircleTransport`.

## The ceremony screens

`@consealdev/conseal/ui` has the circle ceremony as Lit components, each a card in its own shadow root. They
call only `CircleClient`, with no crypto or HTTP of their own, and tell the app what happened by DOM events; which
screen comes next is the app's to decide. `lit` is an optional peer dependency: an app that doesn't import `/ui`
doesn't need it.

```ts
import type { SetupDoneDetail } from '@consealdev/conseal/ui';
import '@consealdev/conseal/ui';   // registers the elements

html`
    <conseal-setup
        app-name="Pinner"
        .circle=${circle}
        .deviceMeta=${{ name: 'Laptop' }}
        @setup-done=${(event: CustomEvent<SetupDoneDetail>) => this.showPhrase(event.detail.mnemonic)}
    ></conseal-setup>
`;
```

| Element | Shows | Events |
|---|---|---|
| `<conseal-setup>` | Creating the circle: a new passphrase, confirmed and rated | `setup-done`, with `{ mnemonic, deviceId, aekCommitment }` |
| `<conseal-phrase>` | The recovery phrase, until the user confirms they wrote it down; then it forgets the phrase | `phrase-confirmed` |
| `<conseal-unlock>` | The passphrase. A device the circle doesn't know gets the choice to join or recover; recovery removes the other devices | `unlock-done`, with `{ recovered }`; `needs-join` |
| `<conseal-join>` | A new device's request and its verification code, then the passphrase once approved | `join-done`, with `{ deviceId }` |
| `<conseal-approve-join>` | A waiting request and its code. Approve works only once the user confirms the codes match | `approve-done`, with `{ deviceId }`; `deny-done` |
| `<conseal-devices>` | The circle's devices, and removing any but this one. Optional: no key material passes through it | `device-revoked`, with `{ deviceId }` |

Every element takes `circle`, as a property, and `app-name`, the name its text uses (`this app` by default).
`<conseal-setup>` and `<conseal-unlock>` take `min-passphrase-length` (12); `<conseal-setup>`, `<conseal-unlock>`
and `<conseal-join>` take `deviceMeta`, what the device calls itself; `<conseal-join>` asks whether it's approved
every `poll-interval` milliseconds (3000). `<conseal-approve-join>` and `<conseal-devices>` have `reload()`. The
recovery phrase goes to `<conseal-phrase>` as the `mnemonic` property, never an attribute, so it stays out of the
page's markup.

### Theming

The components are fully styled with no setup. To restyle them, set these custom properties on the page or on any
ancestor of an element. They are the whole theming surface:

| Property | Colors or shapes | Default |
|---|---|---|
| `--color-text` | Text | `#1e293b` |
| `--color-muted` | Secondary text and labels | `#64748b` |
| `--color-surface` | The card and its fields | `#fff` |
| `--color-bg` | Behind the verification code | `#f8fafc` |
| `--color-border` | Borders, and the secondary buttons | `#e2e8f0` |
| `--color-border-hover` | A secondary button under the pointer | `#cbd5e1` |
| `--color-primary` | The main buttons, links, and the code's border | `#6366f1` |
| `--color-danger` | Deny, Remove, and errors | `#ef4444` |
| `--color-warning` | The recovery button | `#ea580c` |
| `--color-focus` | The focus ring | `#6366f1` |
| `--radius-lg` | The card's corners | `12px` |
| `--radius-sm` | Fields, buttons and the code | `6px` |
| `--space-8` | The card's padding | `32px` |

The layout, the flow between steps, and the security-critical text aren't configurable: the verification code, the
warnings about the phrase and the code, and the mismatch errors. The shadow root keeps the page's own CSS from
reaching them, so a page can't hide or shrink the code the user has to compare.

## Syncing records

```ts
import { SyncEngine, defineCollections, newRecordId, type MergePolicyFactory } from '@consealdev/conseal/sync';

// The app's collections. The names stay on the device; the server only ever sees the ids.
const collections = defineCollections<{ notes: Note; plays: Play }>({
    notes: { id: '7f3a9c21', merge: { fn: 'myapp.notes' }, localOnly: ['downloaded'], schemaVersion: 1 },
    plays: { id: 'b4e70118', immutable: true, schemaVersion: 1 },
});

const sync = new SyncEngine<{ notes: Note; plays: Play }>({
    collections,
    transport: syncTransport,         // see The backend
    store: myRecordStore,             // the app's local storage; MemoryRecordStore in tests
    keyring: circle,                  // anything with aek(): a CircleClient
    mergePolicies: { 'myapp.notes': notesPolicy },
});

const id = newRecordId();
await sync.save('notes', id, { title: 'groceries' });
await sync.remove('notes', otherId);

sync.subscribe(event => {
    // 'changed': another device's write, or a merge, changed a record here (value undefined: deleted)
    // 'rejected': the server refused a record for good, until it changes again
    // 'unreadable': a record from the server doesn't open, and was skipped
});
const report = await sync.sync();     // { pushed, pulled, merged, failed }
```

When and how often to sync is the app's: on start, on focus, after a save, on a timer. A collection that fails,
offline or on a server error, is listed in `failed` and picks up where it stopped on the next sync.

### Collections

Each collection has an `id`, which the app assigns and never changes, and a `schemaVersion`, sealed into every record.
Its records are JSON objects keyed by random lowercase UUIDs. A table the registry doesn't name stays on the device.
`keyring` is the engine's own, so no collection takes it as its name or id (see [The identity](#the-identity)).

- **`merge`** names the policy that combines a remote change with this device's copy. It's `lastWriteWins` when
  absent: the write that reaches the server last wins.
- **`localOnly`** lists top-level fields that never leave the device, such as whether a file is downloaded here.
- **`immutable`** makes an append-only collection: records are created once, never changed or deleted, and never
  conflict.

### Merge policies

A policy gets the local and remote values, in plaintext, and whether the local one has a change the server doesn't;
it returns the value to keep, or undefined to delete. It runs for every remote change to a record the device holds,
and for every conflict on push. The engine seals the result afresh and pushes it when it differs from the server's.

```ts
const notesPolicy: MergePolicyFactory = () => ({ local, remote, pending }) => {
    if (local === undefined || remote === undefined) return pending ? local : remote;
    return mergeFieldByField(local as Note, remote as Note);
};
```

### Blobs

Content too large for a record, such as a photo or a PDF, goes in a blob: sealed on the device under a DEK of its own,
and moved between the device and object storage through URLs the server presigns, so its bytes never pass through the
API. A collection has blobs when the backend gives it a `maxBlobBytes` (`WithBlobs` in `ConsealDev.Conseal`).

```ts
const ref = await sync.attachBlob('notes', id, new Uint8Array(await file.arrayBuffer()));   // offline too
await sync.save('notes', id, { title: 'receipts', attachments: [{ ...ref, name: file.name, type: file.type }] });
await sync.sync();                                    // uploads the blob, then pushes the note

const bytes = await sync.openBlob('notes', id, note.attachments[0]);   // on any of the user's devices

await sync.save('notes', id, { title: 'receipts', attachments: [] });
await sync.detachBlob('notes', id, ref.id);           // the next sync deletes it from the server
```

- **The reference holds the key.** `attachBlob` returns `{ id, dek, size }`. Put it in the record's value, alone or
  among fields of the app's own: the blob's DEK travels only there, sealed inside the record, so the blob opens only
  through its record. The engine finds references anywhere in a value by their shape.
- **Offline first.** `attachBlob` seals the blob and keeps it in the `RecordStore` until a sync uploads it, and
  `openBlob` reads it from there meanwhile. A sync uploads a collection's waiting blobs before it pushes the
  collection's records, so no device pulls a reference to a blob that isn't on the server. An upload that fails
  offline stops that collection's sync, and the next sync tries again.
- **Sealed to its place.** A blob's AAD names its collection, record and blob id: one the server moves to another
  record or id doesn't open, and `openBlob` throws `UnreadableRecordError`.
- **Too large is final.** A blob over the collection's `maxBlobBytes` won't upload: the sync drops it and stops the
  record, reported as `rejected` with `blob_too_large`, until the app saves the record without it. Once the engine
  knows the server's limits, after a first sync, `attachBlob` refuses such a blob, and any blob of a collection
  without blobs, with `InvalidRecordError`. A collection without blobs fails its sync while a blob of it waits.
- **Deleting.** `detachBlob` deletes a blob the record no longer refers to, once the record is pushed without it; a
  blob still waiting never uploads. Deleting a record deletes its blobs on the server, with no `detachBlob`. A merge
  that brings a reference back, from another device's change, finds the blob gone: detach only what the merge policy
  won't keep.
- **Nothing cached.** Once a blob has uploaded, `openBlob` downloads it on every call. Keeping the bytes, and where,
  is the app's.

### The transport and the store

`SyncTransport` has six methods: `getConfig`, `pull` and `push`, one per route of the sync contract, and `putBlob`,
`getBlob` and `deleteBlob`, which also carry a blob's bytes to and from the storage URL its route returns. It throws
`SyncTransportError` with the status and the body's `code` for every answer that isn't a success, and lets network
errors through; `getBlob` returns undefined when storage holds no such blob. `FetchSyncTransport` is one.

`RecordStore` keeps each record's plaintext and sync state, and the pull cursor of each collection. Its `put` is a
compare-and-set on the record's `rev`, in one step, such as one IndexedDB transaction. Its `list` pages through a
collection in id order, for export. It keeps each collection's blob changes waiting for a sync too: blobs sealed to
upload, and blobs to delete. Beside the registry's collections it keeps `KEYRING_COLLECTION`, the engine's own: a
store that sets up a place per collection, such as an IndexedDB object store, sets up that one too.

### Export and import

The user's records, as a file they can keep or take elsewhere. The engine makes it from this device's records, so it
includes changes not yet synced: sync first for a file that matches the server. It works offline, unless records refer
to blobs that have uploaded: those it downloads as it goes.

```ts
// A plain export: a ZIP that anything opens. It is NOT encrypted, so tell the user.
const parts: Uint8Array[] = [];
for await (const chunk of sync.exportAll()) parts.push(chunk);
download(new Blob(parts, { type: 'application/zip' }), 'notes-export.zip');

// A sealed backup: only the passcode opens it.
for await (const chunk of sync.exportAll({ passcode })) await writable.write(chunk);   // a file handle, as it comes

// Import either kind, from the file the user picks
if (await archiveKind(file) === 'backup') passcode = await askForPasscode();
await sync.sync();                                           // so the device holds the server's records first
const report = await sync.importAll(file, { passcode });   // { added, replaced, unchanged, kept, skipped, blobs }
await sync.sync();                                           // pushes what the import added
```

- **The plain export** is a ZIP with `manifest.json` and each collection's records as JSON parts of up to about 4 MB,
  `notes/0001.json` and on: a list of `{ id, schemaVersion, value }`, one record per line. A collection whose name
  isn't a safe file name goes under `collection-<id>`. Each blob a record refers to is a file of its own,
  `blobs/notes/<recordId>/<blobId>`; one the server no longer holds, or that doesn't open, is left out. The manifest
  lists each collection's name, id, `schemaVersion`, record count, parts and blobs. A ZIP without ZIP64 holds at most
  65,535 files and 4 GiB, which blobs reach first. It is unencrypted plaintext: say so where the user saves it.
- **The sealed backup** is the same export, sealed under the passcode in 1 MiB chunks: a random key wrapped under the
  passcode with PBKDF2 (conseal's `wrapKey`), AES-GCM on each chunk, and each chunk bound to its backup, its place and
  whether it's the last. Pick the passcode rules: a backup in cloud storage is open to offline guessing.
- **Never in either:** local-only fields, sync state (server versions, pending changes, cursors), and keys, the
  identity's included. A file that held the AEK would make every backup a way into the account. A blob's DEK is the
  one key that goes in, as part of the reference in its record's value: it opens only that blob, which is in the file
  beside it.
- **Both stream.** Export reads the store a page at a time and yields each part as it fills; import reads the file in
  slices. Neither holds more than about one part.
- **Import keeps record ids,** so importing a file twice, or into the account it came from, adds nothing twice.
  Records this device lacks, or deleted, are added; ones it holds with another value are kept, unless `replace` is
  set; an immutable collection's are always kept. What it adds is pending, as after `save`, and the next sync merges
  it with the server like any change. Sync before importing: under `lastWriteWins`, a record the device hasn't pulled
  yet would be replaced by the file's older value. A collection the registry doesn't have is skipped and reported.
  The blobs of the records it adds or replaces are sealed again under the DEKs their references carry, and wait on the
  device to upload with them.
- **A damaged file changes nothing.** Import checks the whole file first: the ZIP's checksums, every record, and each
  collection's count against the manifest, and every blob's checksum and size against its reference; for a backup,
  every chunk. Only then does it write. It reads only what
  `exportAll` writes: a ZIP that was unzipped and zipped again, or compressed, is refused.

### The identity

`identity()` returns the user's identity: an ECDH key pair that messages to the user are sealed to, and an ECDSA key
pair that signs as the user, the same on every device in the circle. A message sealed to the user opens on any of
their devices, including one that joined after it was sent.

```ts
import { exportPublicKeyAsJwk, sign, unsealMessage } from '@consealdev/conseal';

const { ecdh, ecdsa } = await sync.identity();
await publishPublicKey(await exportPublicKeyAsJwk(ecdh.publicKey));   // where others find it is the app's
const plaintext = await unsealMessage(ecdh.privateKey, ciphertext, iv, ephemeralPublicKey);
const signature = await sign(ecdsa.privateKey, data);
```

- **It travels in the keyring,** a record in the contract's reserved `keyring` collection, sealed under the AEK like
  any other. Every sync pulls it, so a device that joins the circle, or recovers it from the mnemonic, has it after
  its first sync. On a device that doesn't hold it yet, `identity()` syncs first.
- **It is made once.** The first sync that finds no keyring on the server creates one. When two devices create one at
  once, the one whose push conflicts takes the other's, and `identity()` hands out only key pairs the server has
  taken.
- **It is never exported.** Exports and backups leave the keyring out, and the private keys `identity()` returns
  can't be exported. On the device the keyring sits in the `RecordStore` in plaintext, like every record.
- **It stays out of the app's view.** Sync events and the report's counts leave the keyring out. A keyring that
  didn't sync is listed in `failed` as `keyring`.
- **It needs contract 0.2.0 or later** on the backend, which accepts `keyring` without being configured with it.
  Against an older backend, every sync lists the keyring in `failed`, and `identity()` throws `KeyringError`.

### Errors

`SyncConfigError` (the registry), `InvalidRecordError` and `ImmutableRecordError` (a save or delete), and, from a
sync, whatever the `Keyring` throws while locked and a `SyncTransportError` with status 401 when the user isn't signed
in. From `openBlob`, `BlobNotFoundError` when neither the device nor the server holds the blob, and
`UnreadableRecordError` when it doesn't open. From an import, `ArchiveError` (not an export this version reads, or
damaged) and `WrongPasscodeError`. From `identity`, `KeyringError` when the identity isn't on the device after a
sync. All extend `SyncError`, except the
`Keyring`'s.

## Security

The [threat model](https://github.com/consealdev/conseal/blob/main/threat-model.md) says what the ceremony and the
data plane protect and what they rely on. Read it before building a UI on this package: the verification-code
comparison is the app's to show, and the choice of merge policy decides whether a stale record from the server can
replace a newer one.
