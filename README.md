<p align="center">
  <img src="docs/assets/hero.svg" alt="Interocitor" width="560" />
</p>

<p align="center">
  <strong>Local-first rows and durable remote files, encrypted on the client.</strong>
</p>

Interocitor is an application data layer for software that needs structured
state to work offline and converge across devices without giving the storage
provider plaintext access.

> **Public release:** the packages in this checkout are one matched
> `0.1.0` set. The supported distribution for this documentation is
> the source-checkout workflow below, not independently selected registry tags.

## Try the two-tab demo

From a clean checkout:

```bash
git clone https://github.com/TheUiTeam/interocitor.git
cd interocitor
corepack enable
yarn install
yarn demo:todo
```

Open
`http://127.0.0.1:4173/examples/todo-webdav/index.html` in two tabs. In tab A,
choose **New session**, then **Copy token**. Paste the token into tab B, choose
**Apply token**, and connect both tabs. A task added in either tab should appear
in both. The encrypted mailbox artifacts are available for inspection under
`examples/todo-webdav/webdav-data/`.

The [complete demo guide](examples/todo-webdav/README.md) explains credential
storage modes and the durable-file pattern.

## Data surfaces

Interocitor exposes two related surfaces with different availability
guarantees:

| Surface | Behavior | Remote storage |
| --- | --- | --- |
| CRDT rows | Reads and writes use a caller-supplied local store. An outbox carries encrypted changes when transport is available. | Encrypted changes and snapshots are merged and compacted by clients. |
| Durable files | `putFile`, `getFile`, `openFile`, and `deleteFile` call the remote adapter directly. There is no core file cache or offline queue. | Encrypted bytes remain at their app path until overwritten or deleted. |

With a non-null key source, row payloads and file bytes are encrypted before
upload. Storage still observes transport metadata such as object names, sizes,
timing, and request identity. See the
[security model](packages/core/docs/security-model.md) for the complete trust
boundary.

## Package map

| Package | Start here |
| --- | --- |
| `@interocitor/core` | [Engine, schemas, adapters, pairing, recovery, and file APIs](packages/core/README.md) |
| `@interocitor/web` | [Browser local stores, credential custody, and image helpers](packages/web/README.md) |
| `@interocitor/react` | [Context and reactive row/image hooks](packages/react/README.md) |
| `@interocitor/workers` | [Cloudflare D1/R2 runtime, policy, operations, and optional relay](packages/workers/README.md) |
| `@interocitor/webdav` | [Loopback development and test server](packages/webdav/README.md) |
| InterocitorSwift | [Swift source package](packages/interocitor-swift/README.md) |

The browser package is the recommended entry point for browser applications;
it supplies the local-store and credential-store implementations used with the
core engine.

## Guides and reference

- [Public-offering page source](docs/index.html)
- [Terminology](docs/dictionary.md)
- [Protocol flows](docs/flows.md)
- [Core adapter contract](packages/core/docs/adapter-contract.md)
- [Pair a device](packages/core/docs/pairing.md)
- [Publish and use a recovery phrase](packages/core/docs/recovery.md)
- [Recovery API reference](packages/core/docs/recovery-reference.md)
- [Compaction](packages/core/docs/compaction.md)
- [Cloudflare runtime options](packages/workers/docs/runtime-options.md)
- [Cloudflare security guardrails](packages/workers/docs/security-guardrails.md)
- [Cloudflare operations and maintenance](packages/workers/docs/maintenance.md)

## Runnable examples

- [`examples/todo-webdav`](examples/todo-webdav/README.md) — smallest two-tab
  row-sync demo with an inspectable local mailbox.
- [`examples/biometric-keys`](examples/biometric-keys/README.md) — browser
  credential custody with WebAuthn.
- [`examples/todo-cloudflare-do`](examples/todo-cloudflare-do/README.md) —
  Cloudflare Worker, D1, R2, and optional realtime invalidation.

## Validate this checkout

```bash
yarn check:types
yarn workspace @interocitor/core test:unit
yarn test:e2e:todo
```

Package-specific commands and environmental prerequisites live with each
package or example.

## License

MIT
