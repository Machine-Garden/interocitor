<p align="center">
  <a href="https://github.com/Machine-Garden/interocitor">
    <img src="docs/assets/hero.svg" alt="Interocitor" width="560" />
  </a>
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

| Surface       | Behavior                                                                                                                           | Remote storage                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| CRDT rows     | Reads and writes use a caller-supplied local store. An outbox carries encoded changes when transport is available.                 | Changes and snapshots are merged and compacted by clients.        |
| Durable files | `putFile`, `getFile`, `openFile`, and `deleteFile` call the remote adapter directly. There is no core file cache or offline queue. | File bytes remain at their app path until overwritten or deleted. |

With a non-null key source, row payloads and file bytes are encrypted before
upload. Storage still observes transport metadata such as object names, sizes,
timing, and request identity. See the
[security model](packages/core/docs/security-model.md) for the complete trust
boundary.

## Package map

| Package                | Start here                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@interocitor/core`    | [Engine, schemas, adapters, pairing, recovery, and file APIs](packages/core/README.md)                                           |
| `@interocitor/web`     | [Browser local stores, credential custody, and image helpers](packages/web/README.md)                                            |
| `@interocitor/react`   | [Context and reactive row/image hooks](packages/react/README.md)                                                                 |
| `@interocitor/workers` | [Cloudflare Worker runtime with D1 plus configurable durable file-body storage](packages/workers/README.md)                      |
| InterocitorSwift       | [Apple-platform runtime with local SQLite rows and Core-compatible encrypted mailbox sync](packages/interocitor-swift/README.md) |
| `interocitor`          | [Python core for headless workers and protocol integrations](packages/interocitor-python/README.md)                              |

The browser package is the recommended entry point for browser applications;
it supplies the local-store and credential-store implementations used with the
core engine.

## Validate a release

Use a macOS 14 or later release host with Xcode or Xcode Command Line Tools,
Swift 5.10 or later, Python 3.11 or later, and a Playwright-supported even
Node.js line: 22.12 or later in the 22.x line, 24.x, or 26.x. If the Node
installation does not include Corepack, install it before enabling the
repository's pinned Yarn version. Then prepare an isolated Python environment
and the Chromium binary used by the browser suites:

```bash
if ! command -v corepack >/dev/null 2>&1; then
  npm install --global corepack@latest
fi
corepack enable
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e "packages/interocitor-python[test]"
yarn install --immutable
yarn test:e2e:install
yarn preflight
```

`yarn preflight` owns the JavaScript static, build, unit, package, browser, and
example suites, followed by Python protocol tests and Swift integration plus
Core interoperability. Use `yarn validate` for the shorter JavaScript gate
while iterating; it still runs the Todo browser suite and therefore requires
the installed Chromium binary.

## Guides and reference

- [Plain-language questions and answers](docs/QA.md)
- [Public site architecture and content owners](docs/README.md)
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

- [`docs/examples/todomvc`](docs/examples/todomvc/index.html) — up to three
  local-first clients, inspectable mailbox files, compaction, and a best-effort
  endpoint diff journal.
- [`docs/examples/chat`](docs/examples/chat/index.html) — two-client encrypted
  chat with an inspectable in-page mailbox and a 15-message application limit.
- [`docs/examples/board`](docs/examples/board/index.html) — two local-first
  board clients make independent card changes, then exchange encrypted rows.
- [`docs/examples/family-locator`](docs/examples/family-locator/index.html) —
  protected latest-known location rows with explicit privacy, freshness, and
  safety limits.
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
