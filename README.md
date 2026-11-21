# Conseal for JavaScript

The browser side of [Conseal](https://github.com/consealdev/conseal), end-to-end encryption for web apps. It seals data on
the user's device before it leaves it, shares the user's key between their devices only when they approve a new device on
one that already holds it, and shares a key between users in channels. It syncs the user's records between their devices,
and has the circle's screens as Lit components. The server stores and orders ciphertext it can't open.

The server is [Conseal for ASP.NET Core](https://github.com/consealdev/conseal-dotnet), or any backend built to the same
[contract](https://github.com/consealdev/conseal/tree/main/spec).

## Installation

```bash
npm install @consealdev/conseal
```

The package has three entry points:

| Import | Holds |
|---|---|
| `@consealdev/conseal` | The crypto core: sealing, passphrase key wrapping, ECDH and ECDSA, the recovery phrase, and the circle and channels that share keys |
| `@consealdev/conseal/sync` | `CircleClient`, which joins a device to the user's circle, and `SyncEngine`, which syncs their records between devices, with the transports and stores they use |
| `@consealdev/conseal/ui` | The circle's screens, as Lit components. Needs `lit` |

It is ESM only. It runs in browsers and in Node.js 20 or newer, anything with `crypto.subtle`. Key storage needs IndexedDB.

## Sealing data

```ts
import { generateAesKey, seal, unseal } from '@consealdev/conseal';

const key = await generateAesKey();
const { ciphertext, iv } = await seal(key, plaintext);

const opened = await unseal(key, ciphertext, iv);   // throws on a wrong key or altered data
```

The core makes no network calls: the app owns the transport and the storage of every payload.

## Syncing a user's devices

The first device creates the circle, and every record the app saves is sealed before it leaves the device:

```ts
import {
    CircleClient, FetchCircleTransport, FetchSyncTransport, MemoryRecordStore,
    SyncEngine, defineCollections, newRecordId,
} from '@consealdev/conseal/sync';

type Notes = { notes: { title: string } };

const circle = new CircleClient({ transport: new FetchCircleTransport({ baseUrl: '/api/circle' }) });
const { mnemonic } = await circle.setup(passphrase);   // show the mnemonic once, and never store it

const sync = new SyncEngine<Notes>({
    collections: defineCollections<Notes>({ notes: { id: '7f3a9c21', schemaVersion: 1 } }),
    transport: new FetchSyncTransport({ baseUrl: '/api/sync' }),
    store: new MemoryRecordStore(),   // the app's own RecordStore in production
    keyring: circle,
});

await sync.save('notes', newRecordId(), { title: 'groceries' });
await sync.sync();
```

A new device asks to join, and a device that is already in the circle approves it. Each shows a verification code, and the
user approves only when the two match:

```ts
const session = await newDevice.startJoin({ name: 'Laptop' });   // show session.verificationCode

const [join] = await trustedDevice.pendingJoins();               // show join.verificationCode
await trustedDevice.approveJoin(join, passphrase, true);         // only once the user confirms the codes match

await session.check();                                           // poll until the state is 'authorized'
await session.finish(passphrase);                                // the new device is in the circle and unlocked
```

## The circle's screens

```ts
import '@consealdev/conseal/ui';   // registers the elements

html`
    <conseal-setup
        app-name="My app"
        .circle=${circle}
        @setup-done=${(event: CustomEvent) => showPhrase(event.detail.mnemonic)}
    ></conseal-setup>
`;
```

`<conseal-setup>`, `<conseal-phrase>`, `<conseal-unlock>`, `<conseal-join>`, `<conseal-approve-join>` and
`<conseal-devices>` call only `CircleClient`, and fire a DOM event when a step is done: `setup-done`, `phrase-confirmed`,
`unlock-done`, `join-done`, `approve-done` or `device-revoked`. The app decides which screen comes next.

## Docs

[conseal.dev/docs](https://conseal.dev/docs/) has every call of the crypto core with its signature, the sync pages, each
element, and the [threat model](https://conseal.dev/docs/security/threat-model/), which says what Conseal protects, against
whom, and what it relies on.

---

Licensed under the GNU Affero General Public License v3.0 or the Conseal Commercial License. See
[LICENSE](https://github.com/consealdev/conseal-js/blob/main/LICENSE) and
[COMMERCIAL-LICENSE.md](https://github.com/consealdev/conseal-js/blob/main/COMMERCIAL-LICENSE.md) for full terms.
