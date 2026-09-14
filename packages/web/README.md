<p align="center">
  <a href="https://github.com/Machine-Garden/interocitor">
    <img src="https://raw.githubusercontent.com/Machine-Garden/interocitor/main/docs/assets/hero.svg" alt="Interocitor" width="560" />
  </a>
</p>

# @interocitor/web

Browser runtime helpers for Interocitor apps.

Most browser applications should start here. `@interocitor/core` is the engine
underneath; `@interocitor/web` provides the browser pieces you normally wire into
that engine: IndexedDB local storage, browser credential storage, image helpers,
and local reset helpers.

## Build the public release

```bash
yarn install
yarn workspace @interocitor/core build
yarn workspace @interocitor/web build
```

The `0.1.0` release uses matching monorepo workspaces. Build it
from the public repository with the commands above. Add the React workspace
build if you want hooks such as `useLiveQuery`, `useRow`, or `useImage`.

The shell commands above are runnable from the repository root. TypeScript
blocks below are partial browser integration fragments; they assume
application-owned schema, credentials, DOM values, and lifecycle/error
handling.

## What this package owns

| Need                                              | Use                                                       |
| ------------------------------------------------- | --------------------------------------------------------- |
| Browser local cache / outbox                      | `IndexedDbLocalStore`                                     |
| Safer IndexedDB open fallback                     | `createResilientLocalStore`                               |
| Rotatable local DB names for reset/recovery flows | `createNamedLocalStore`, `getActiveLocalDatabaseName`     |
| Local IndexedDB deletion                          | `resetLocalDatabase`, `resetLocalDatabaseWithDeadline`    |
| Browser credential persistence                    | `createWebCredentialStore` and concrete credential stores |
| Additional app key material                       | `createWebSecretStore`                                    |
| Browser image upload/display helpers              | `putImage`, `getImage`, `getImageBlobUrl`                 |

Mailbox adapters such as WebDAV, Google Drive, and Cloudflare live in
`@interocitor/core`. Browser runtime choices live here.

## Build a display-only reader

Use core's `InterocitorReader` with an IndexedDB store for a browser or TV
surface that must stay current without joining the mesh as a device. IndexedDB
retains the same row cache and exact change-file ledger used by a read/write
client, so reloads fetch only unseen remote changes.

```ts
import { InterocitorReader, PortablePassphraseKeySource } from "@interocitor/core";
import { IndexedDbLocalStore } from "@interocitor/web";

const dbName = "taska-family-view-reader";
const reader = new InterocitorReader(adapter, {
  dbName,
  remotePath: "/TaskaFamily",
  localStore: new IndexedDbLocalStore(dbName),
  keySource: new PortablePassphraseKeySource({ portableKey, generateIfMissing: false }),
});

await reader.connect();
```

Use a local database dedicated to the reader. It never generates a device UUID
or writes to the mailbox, and it refuses a local store containing queued
read/write work. `getImage` and `getImageBlobUrl` accept either an
`InterocitorReader` or the ordinary read/write engine. See the
[reader guide](../core/docs/reader.md) for the complete boundary.

## Public API

Documented entrypoints in this package:

| API                                                                                                                        | Use when                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `IndexedDbLocalStore`                                                                                                      | Browser tabs should persist local rows, outbox, and metadata in IndexedDB                                    |
| `createResilientLocalStore`                                                                                                | IndexedDB may be blocked or unstable and the app must keep opening                                           |
| `createNamedLocalStore`, `getActiveLocalDatabaseName`                                                                      | The app needs reset/recovery flows that rotate the physical IndexedDB name                                   |
| `resetLocalDatabase`, `resetLocalDatabaseWithDeadline`                                                                     | The app needs explicit local-cache deletion UX                                                               |
| `createWebCredentialStore`                                                                                                 | The app needs a browser credential custody choice for mesh credentials                                       |
| `createWebSecretStore`                                                                                                     | The app needs browser storage, platform WebAuthn, or cross-platform WebAuthn custody for an app-owned secret |
| `WebAuthnBlobStore`                                                                                                        | The app needs a separate WebAuthn-protected blob such as a record-seal key or JWT signer                     |
| `WebAuthnCredentialStore`                                                                                                  | The whole credential record should live behind WebAuthn `largeBlob`                                          |
| `WebAuthnEnvelopeKeyProvider`                                                                                              | The credential record may live elsewhere, but envelope unwrap should require WebAuthn confirmation           |
| `putImage`, `getImage`, `getImageBlobUrl`                                                                                  | The app stores encrypted image files and needs browser upload/display helpers                                |
| `LocalStorageCredentialStore`, `SessionStorageCredentialStore`, `MemoryCredentialStore`                                    | The app wants a concrete mesh-credential store instead of the factory                                        |
| `BrowserCredentialEnvelopeStore`, `MemoryCredentialEnvelopeStore`, `EnvelopedCredentialStore`, `StaticEnvelopeKeyProvider` | The app composes encrypted credential-envelope custody directly                                              |
| `BrowserStorageSecretStore`, `WebAuthnPlatformSecretStore`, `WebAuthnCrossPlatformSecretStore`                             | The app wants a concrete arbitrary-secret store instead of `createWebSecretStore`                            |
| `DEFAULT_LOCAL_OPEN_TIMEOUT_MS`                                                                                            | The app needs the resilient-store default (`300` ms without an IndexedDB progress signal)                    |

The package root also exports the option, result, hook, and store-contract
types associated with these values. Import from `@interocitor/web`; the
documented subpath exports exist for storage and credential-store modules but
are not required for the recommended path.

## Runtime boundary

`@interocitor/core` owns the runtime-neutral engine, sync protocol, mailbox
adapters, storage contracts, key-source contracts, and byte file APIs.
`@interocitor/web` owns browser local storage, browser credential stores,
browser image helpers, and reset helpers. React hooks live in
`@interocitor/react`.

## Basic browser setup

This partial fragment shows the browser-first composition point:

```ts
import { Interocitor, PortablePassphraseKeySource } from "@interocitor/core";
import { WebDAVAdapter } from "@interocitor/core/adapters/webdav";
import { IndexedDbLocalStore, createWebCredentialStore } from "@interocitor/web";

const dbName = "case-vault";

const adapter = new WebDAVAdapter({
  baseUrl: "/webdav",
  auth: { token: webdavToken },
});

const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore(dbName, {
    storage: "sessionStorage",
  }),
});

const db = new Interocitor(adapter, {
  dbName,
  remotePath: "/CaseVault",
  localStore: new IndexedDbLocalStore(dbName),
  keySource,
});

await db.init();
await db.connect();
```

The engine API is still `@interocitor/core`; this package supplies the browser
storage and credential implementations that make that setup practical in a web
app.

## Local stores

### IndexedDB cache

```ts
import { IndexedDbLocalStore } from "@interocitor/web";

const localStore = new IndexedDbLocalStore("case-vault");
```

`IndexedDbLocalStore` stores local rows, indexes, outbox entries, cursors, and
metadata. It is the normal browser local store.

### Resilient open fallback

```ts
import { createResilientLocalStore } from "@interocitor/web";

const localStore = createResilientLocalStore({
  dbName: "case-vault",
  onDegraded(info) {
    console.warn("Local store degraded", info.reason, info.error);
  },
});
```

Use this when the app must keep opening even if IndexedDB is unavailable,
blocked, wedged, or its handle becomes unusable. The default open deadline is
300 ms **without a progress signal**; an IndexedDB upgrade/progress callback
disarms the timer, so a legitimately slow upgrade is allowed to finish. On
degradation, all later operations use memory and local durability is lost for
that process. `onDegraded` runs synchronously; exceptions from the hook are
swallowed so the engine can keep opening.

### Named stores for reset/recovery flows

```ts
import { createNamedLocalStore, getActiveLocalDatabaseName } from "@interocitor/web";

const localStore = createNamedLocalStore({
  baseName: "case-vault",
});

console.log(getActiveLocalDatabaseName("case-vault"));
```

Named stores persist the active physical database name in `localStorage` when
available. When their own resilient store degrades because opening stalled or
the handle became unusable, they advance the pointer to `baseName-v2`,
`baseName-v3`, and so on for the next open. Calling a reset helper by itself
does not rotate that pointer.

### Local reset

```ts
import { resetLocalDatabaseWithDeadline } from "@interocitor/web";

const outcome = await resetLocalDatabaseWithDeadline("case-vault", 1500);
if (outcome !== "deleted") {
  // Show recovery UX; another tab may still hold the database open.
}
```

Call reset only after disconnecting the engine and clearing credentials. The
deadline helper returns `'deleted'`, `'blocked'`, `'timed-out'`, or `'errored'`
and never throws; its default deadline is 1500 ms. If the app uses a named
store, recovery should create/open that store and let its degradation path
manage pointer rotation rather than assuming the reset call rotated it.

## Credential storage choices

Browser apps choose where sync credentials live by building a `keySource` for
the engine. In the browser, `createWebCredentialStore(...)` is usually one input
to that key source. With no options, the factory uses `localStorage`; examples
select a mode explicitly so their credential-custody boundary is unambiguous.

### Tab-session credentials

```ts
import { PortablePassphraseKeySource } from "@interocitor/core";
import { createWebCredentialStore } from "@interocitor/web";

const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore("case-vault", {
    storage: "sessionStorage",
  }),
});
```

Good default for examples and apps that can re-acquire portable key material
after the tab session ends.

### Memory-only credentials

```ts
const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore("case-vault", {
    storage: "memory",
  }),
});
```

No key material is persisted. Reloading the page requires portable key material
from somewhere else: a join token, backend session, native app integration, or another device.

### Local browser persistence

```ts
const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore("case-vault", {
    storage: "localStorage",
  }),
});
```

Persists the credential record as plaintext JSON in `localStorage`. The
portable key and device identifiers are readable by same-origin JavaScript,
browser extensions with access, and successful XSS. Use this only when that
origin-level custody boundary is acceptable.

### Passkey / biometric-only credentials

```ts
const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore("case-vault", {
    storage: "passkey",
    displayName: "Case Vault",
  }),
});
```

Stores the credential record in WebAuthn `largeBlob`. Browser storage may hold a
credential-id hint, but not the credential payload itself.

This is custody for the Interocitor mesh credential record. It is not a general
application signing-key API and it does not expose the passkey private key to
your application code. The stored credential bytes do enter JavaScript after a
successful ceremony, so malicious same-origin code can read them at that time.
WebAuthn user verification may be a biometric, device PIN, or another
platform/browser-approved method.

### Additional WebAuthn-protected keys

When the app needs separate key material after login, use
`createWebSecretStore` with a distinct namespace per secret:

```ts
import { createWebCredentialStore, createWebSecretStore } from "@interocitor/web";

const credentialStore = createWebCredentialStore("case-vault", {
  storage: "passkey",
  displayName: "Case Vault",
  authenticatorAttachment: "platform",
});

const draftKeyStore = createWebSecretStore("case-vault:draft-key");

const recordSealKeyStore = createWebSecretStore("case-vault:record-seal-key", {
  custody: "webauthnPlatform",
  displayName: "Case Vault",
});

const signerStore = createWebSecretStore("case-vault:jwt-signer", {
  custody: "webauthnCrossPlatform",
  displayName: "Case Vault",
});

await signerStore.enrollAuthenticator(signingKeyBundleBytes, {
  authenticatorAttachment: "cross-platform",
  hints: ["hybrid"],
  transports: ["hybrid"],
  label: "Anton phone",
});
```

This is the package-level answer to "mesh credentials unlock the app, a
platform key seals case records, and a cross-platform key signs outbound
claims". The package API is phrased in browser custody primitives: local
browser storage, platform WebAuthn, and cross-platform WebAuthn with optional
hybrid transport hints.

`BrowserStorageSecretStore` stores application bytes as base64 in
`localStorage`; base64 is encoding, not encryption. WebAuthn stores persist the
exported application bytes in `largeBlob`. The authenticator's private
credential key does not become the application's encryption or signing key.

### Enveloped credentials from backend, memory, or browser storage

```ts
import { BoundSharedKeySource } from "@interocitor/core";
import { WebAuthnEnvelopeKeyProvider, createWebCredentialStore } from "@interocitor/web";

const keySource = new BoundSharedKeySource({
  portableKey,
  credentialStore: createWebCredentialStore("case-vault", {
    envelope: {
      store: backendEnvelopeStore,
      keyProvider: new WebAuthnEnvelopeKeyProvider("case-vault"),
    },
  }),
  derive: async ({ portableKey }) => ({
    encrypted: true,
    key: await deriveBoundMeshKey(portableKey),
    portableKey,
  }),
});
```

Use this when the encrypted credential envelope should come from a backend,
app memory, native storage, or another custom source while the unwrap key comes
from passkey/biometrics or a key obtained by the app.

This is the shape to use when the app wants "biometric confirmation before
unlocking/sealing credentials" without pretending the browser is handing your
code a reusable private signing key.

For the full contract and security notes, see the
[credential store contract](../core/docs/credential-store.md). For shared-key deployment modes, coexistence, and SOC review language, see
[shared key scenarios](../core/docs/shared-key-scenarios.md).

## Images

Images are stored through the core file API. They are encrypted before remote
storage only when the `Interocitor` engine has an encrypted key source; an
unencrypted engine sends the image bytes as-is. The web package adds browser
input/output helpers.

```ts
import { getImageBlobUrl, putImage } from "@interocitor/web";

await putImage(db, `users/${userId}/avatar.png`, file);

const image = await getImageBlobUrl(db, `users/${userId}/avatar.png`);
img.src = image.url;

// Revoke when the URL is no longer displayed.
image.revoke();
```

`putImage` accepts `Blob`, `File`, `ArrayBuffer`, `Uint8Array`, data URLs, and
SVG strings. A plain string is treated as SVG, an unknown extension defaults
to `image/png`, and an explicit non-`image/*` content type throws. Revoke every
URL returned by `getImageBlobUrl` when it is no longer displayed. Use core
`db.putFile` / `db.getFile` for non-image attachments.

## React image hook

```tsx
import { useImage } from "@interocitor/react";

function Avatar({ db, path }) {
  const image = useImage(db, path);
  if (image.loading) return <span>Loading…</span>;
  if (image.error || !image.url) return null;
  return <img src={image.url} alt="" />;
}
```

`useImage` creates and revokes browser `blob:` URLs for display. It lives in
`@interocitor/react` with the other React hooks.

## Runnable example apps

- [WebDAV TODO](../../examples/todo-webdav/README.md) — browser tabs syncing
  through a local WebDAV mailbox.
- [Cloudflare TODO](../../examples/todo-cloudflare-do/README.md) — browser tabs syncing through the Cloudflare
  Workers/Durable Object backend.
- [Biometric keys](../../examples/biometric-keys/README.md) — stored, protected,
  and enforced app-key custody, including the explicit add-phone flow.

The todo examples wire `credentialStore` explicitly and support query-param modes:

```text
?credentials=session
?credentials=memory
?credentials=local
?credentials=passkey
?credentials=memory-envelope
```

## Validate the package

These commands are runnable from the repository root after `yarn install`:

```bash
yarn workspace @interocitor/web check
yarn workspace @interocitor/web build
yarn workspace @interocitor/web test:e2e
```

## More detail

- [Core engine](../core/README.md)
- [Credential store contract](../core/docs/credential-store.md)
- [Security model](../core/docs/security-model.md)
- [How to use multiple browser-custodied keys](docs/multiple-biometric-keys.md)
- [WebAuthn blob store reference](docs/webauthn-blob-store.md)

## License

MIT
