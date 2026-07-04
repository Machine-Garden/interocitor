# @interocitor/web

Browser runtime helpers for Interocitor apps.

Most browser applications should start here. `@interocitor/core` is the engine
underneath; `@interocitor/web` provides the browser pieces you normally wire into
that engine: IndexedDB local storage, browser credential storage, image helpers,
local reset helpers, and the optional React image hook.

## Install

```bash
yarn add @interocitor/core @interocitor/web
```

Add `@interocitor/react` only if you want the React database hooks. The image
hook in this package is available from `@interocitor/web/react` and has an
optional React peer dependency.

## What this package owns

| Need | Use |
| --- | --- |
| Browser local cache / outbox | `IndexedDbLocalStore` |
| Safer IndexedDB open fallback | `createResilientLocalStore` |
| Rotatable local DB names for reset/recovery flows | `createNamedLocalStore`, `getActiveLocalDatabaseName` |
| Local IndexedDB deletion | `resetLocalDatabase`, `resetLocalDatabaseWithDeadline` |
| Browser credential persistence | `createWebCredentialStore` and concrete credential stores |
| Browser image upload/display helpers | `putImage`, `getImage`, `getImageBlobUrl` |
| React image display hook | `useImage` from `@interocitor/web/react` |

Mailbox adapters such as WebDAV, Google Drive, and Cloudflare live in
`@interocitor/core`. Browser runtime choices live here.

## Runtime boundary

`@interocitor/core` owns the runtime-neutral engine, sync protocol, mailbox
adapters, storage contracts, key-source contracts, and byte file APIs.
`@interocitor/web` owns browser local storage, browser credential stores,
browser image helpers, reset helpers, and the `@interocitor/web/react` image
hook.

## Basic browser setup

```ts
import { Interocitor, PortablePassphraseKeySource, WebDAVAdapter } from '@interocitor/core';
import { IndexedDbLocalStore, createWebCredentialStore } from '@interocitor/web';

const dbName = 'meal-planner';

const adapter = new WebDAVAdapter({
  baseUrl: '/webdav',
  auth: { token: webdavToken },
});

const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore(dbName, {
    storage: 'sessionStorage',
  }),
});

const db = new Interocitor(adapter, {
  dbName,
  remotePath: '/MealPlanner',
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
import { IndexedDbLocalStore } from '@interocitor/web';

const localStore = new IndexedDbLocalStore('meal-planner');
```

`IndexedDbLocalStore` stores local rows, indexes, outbox entries, cursors, and
metadata. It is the normal browser local store.

### Resilient open fallback

```ts
import { createResilientLocalStore } from '@interocitor/web';

const localStore = createResilientLocalStore({
  dbName: 'meal-planner',
  onDegraded(info) {
    console.warn('Local store degraded', info.reason, info.error);
  },
});
```

Use this when the app must keep opening even if IndexedDB is blocked, wedged, or
slow. It can fall back to memory and report degradation to the UI.

### Named stores for reset/recovery flows

```ts
import { createNamedLocalStore, getActiveLocalDatabaseName } from '@interocitor/web';

const localStore = createNamedLocalStore({
  baseName: 'meal-planner',
});

console.log(getActiveLocalDatabaseName('meal-planner'));
```

Named stores let an app rotate the actual IndexedDB database name after a local
reset or blocked delete while keeping a stable logical app name.

### Local reset

```ts
import { resetLocalDatabaseWithDeadline } from '@interocitor/web';

const outcome = await resetLocalDatabaseWithDeadline('meal-planner', 1500);
if (outcome !== 'deleted') {
  // another tab may be holding the database open; rotate via createNamedLocalStore
}
```

Call reset only after disconnecting the engine and clearing credentials.

## Credential storage choices

Browser apps choose where sync credentials live by building a `keySource` for
the engine. In the browser, `createWebCredentialStore(...)` is usually one input
to that key source.

### Tab-session credentials

```ts
import { PortablePassphraseKeySource } from '@interocitor/core';
import { createWebCredentialStore } from '@interocitor/web';

const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore('meal-planner', {
    storage: 'sessionStorage',
  }),
});
```

Good default for examples and apps that can re-acquire portable key material
after the tab session ends.

### Memory-only credentials

```ts
const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore('meal-planner', {
    storage: 'memory',
  }),
});
```

No key material is persisted. Reloading the page requires portable key material
from somewhere else: a join token, backend session, native app integration, or another device.

### Local browser persistence

```ts
const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore('meal-planner', {
    storage: 'localStorage',
  }),
});
```

Persists the credential record in `localStorage`.

### Passkey / biometric-only credentials

```ts
const keySource = new PortablePassphraseKeySource({
  portableKey,
  credentialStore: createWebCredentialStore('meal-planner', {
    storage: 'passkey',
    displayName: 'Meal Planner',
  }),
});
```

Stores the credential record in WebAuthn `largeBlob`. Browser storage may hold a
credential-id hint, but not the credential payload itself.

### Enveloped credentials from backend, memory, or browser storage

```ts
import { BoundSharedKeySource } from '@interocitor/core';
import { WebAuthnEnvelopeKeyProvider, createWebCredentialStore } from '@interocitor/web';

const keySource = new BoundSharedKeySource({
  portableKey,
  credentialStore: createWebCredentialStore('meal-planner', {
    envelope: {
      store: backendEnvelopeStore,
      keyProvider: new WebAuthnEnvelopeKeyProvider('meal-planner'),
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

For the full contract and security notes, see the
[credential store contract](../core/docs/credential-store.md). For shared-key deployment modes, coexistence, and SOC review language, see
[shared key scenarios](../core/docs/shared-key-scenarios.md).

## Images

Images are stored through the core file API and encrypted like other remote
content. The web package adds browser input/output helpers.

```ts
import { getImageBlobUrl, putImage } from '@interocitor/web';

await putImage(db, `users/${userId}/avatar.png`, file);

const image = await getImageBlobUrl(db, `users/${userId}/avatar.png`);
img.src = image.url;

// Revoke when the URL is no longer displayed.
image.revoke();
```

`putImage` accepts `Blob`, `File`, `ArrayBuffer`, `Uint8Array`, data URLs, and
SVG strings. Use core `db.putFile` / `db.getFile` for non-image attachments.

## React image hook

```tsx
import { useImage } from '@interocitor/web/react';

function Avatar({ db, path }) {
  const image = useImage(db, path);
  if (image.loading) return <span>Loading…</span>;
  if (image.error || !image.url) return null;
  return <img src={image.url} alt="" />;
}
```

`useImage` creates and revokes browser `blob:` URLs for display. General React
database hooks live in `@interocitor/react`.

## Example apps

- `examples/todo-webdav` — browser tabs syncing through a local WebDAV mailbox.
- `examples/todo-cloudflare-do` — browser tabs syncing through the Cloudflare
  Workers/Durable Object backend.

Both examples wire `credentialStore` explicitly and support query-param modes:

```text
?credentials=session
?credentials=memory
?credentials=local
?credentials=passkey
?credentials=memory-envelope
```

## Tests

```bash
yarn workspace @interocitor/web check
yarn workspace @interocitor/web build
yarn workspace @interocitor/web test:e2e
```

## More detail

- [Core engine](../core/README.md)
- [Credential store contract](../core/docs/credential-store.md)
- [Security model](../core/docs/security-model.md)

## License

MIT
