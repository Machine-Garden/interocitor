<p align="center">
  <img src="docs/assets/hero.svg" alt="Interocitor" width="560" />
</p>

<p align="center">
  <strong>A protocol for trusted clients over storage that does not need to understand their data.</strong>
</p>

Interocitor is a protocol and client library for trusted endpoints, not a
database server. Each endpoint owns its local row state, applies application
policy, and merges row changes. The remote mailbox behaves like a hard drive:
it stores and returns row artifacts and durable files, but it does not query
records, resolve conflicts, or run application logic.

With a non-null key source, clients encrypt payloads before the remote receives
them. The storage provider can make data available without receiving plaintext.

## Data surfaces

Interocitor exposes two related surfaces with different availability
guarantees:

| Surface       | Behavior                                                                                                                           | Remote storage                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| CRDT rows     | Reads and writes use a caller-supplied local store. An outbox carries encrypted changes when transport is available.               | Encrypted changes and snapshots are merged and compacted by clients.   |
| Durable files | `putFile`, `getFile`, `openFile`, and `deleteFile` call the remote adapter directly. There is no core file cache or offline queue. | Encrypted bytes remain at their app path until overwritten or deleted. |

With a non-null key source, row payloads and file bytes are encrypted before
upload. Storage still observes transport metadata such as object names, sizes,
timing, and request identity. See the
[security model](packages/core/docs/security-model.md) for the complete trust
boundary.

## Package map

| Package                | Start here                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@interocitor/core`    | [Engine, schemas, adapters, pairing, recovery, and file APIs](packages/core/README.md)                      |
| `@interocitor/web`     | [Browser local stores, credential custody, and image helpers](packages/web/README.md)                       |
| `@interocitor/react`   | [Context and reactive row/image hooks](packages/react/README.md)                                            |
| `@interocitor/workers` | [Cloudflare Worker runtime with D1 plus configurable durable file-body storage](packages/workers/README.md) |
| `@interocitor/webdav`  | [Loopback development and test server](packages/webdav/README.md)                                           |
| InterocitorSwift       | [Swift source package](packages/interocitor-swift/README.md)                                                |
| `interocitor`          | [Python core for headless workers and protocol integrations](packages/interocitor-python/README.md)         |

The browser package is the recommended entry point for browser applications;
it supplies the local-store and credential-store implementations used with the
core engine.

## Guides and reference

- [Plain-language questions and answers](docs/QA.md)
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

## Bring your own cloud

Niki Tonsky’s [“Local, first, forever”](https://tonsky.me/blog/crdt-filesync/)
independently explored the same broad idea: let CRDT data travel through
commodity file-sync storage—“just bring your own cloud.” Interocitor was
developed independently and turns that pattern into an application data layer
with structured rows, durable files, pairing, recovery, and compaction.

Run the mailbox backend on Cloudflare, let users connect Google Drive, or point
WebDAV at a home NAS. Each backend carries the same artifacts; with a non-null
key source, protected payloads are encrypted before the storage adapter receives
them.

## License

MIT
