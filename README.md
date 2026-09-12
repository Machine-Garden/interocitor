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
records, interpret protected contents, or resolve conflicts. A deployment may
add a separate server-readable control plane for routing and access policy;
that policy does not merge or query protected application records.

With a non-null key source, clients encrypt payloads before the remote receives
them. The storage provider can make data available without receiving plaintext.

## What you can build with it

Interocitor is a small set of guarantees: every trusted device holds a full
local copy of the rows, files stay byte-exact and digest-verified, and the
remote stores what it cannot read. Those guarantees are enough for a family of
products that people already trust today:

| Build something like | Because                                                                                                                                                                                                                                                                      | Where it stands                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear               | Speed. Every row is already on the device, so lists, filters, and keyboard-driven edits never wait on a round trip. Scale by giving each team or project its own mesh and keeping its credentials as a connected store in the parent, so a session opens only what it needs. | Behind Linear on workspace-wide search, reporting, and per-issue permissions, which need a server that reads the data. Ahead on offline work and on a vendor that cannot read your issues.                                                                       |
| Obsidian             | The folder tree is rows that merge; note bodies are durable files named by a digest, so structure converges and content stays exact.                                                                                                                                         | Obsidian Sync also encrypts end to end. Here the storage is yours and the vault is a library you embed; note bodies still replace as whole files rather than merging.                                                                                            |
| Signal               | The mailbox stores and returns encrypted artifacts. With a mesh key it never receives message plaintext, and object names are keyed hashes.                                                                                                                                  | Less secure than Signal: private chat is more than encryption, and there is no ratchet, no sealed sender, and no safety numbers, so a copied key opens the whole history. More secure than XChat: your secrets never rest anywhere the operator could open them. |
| Cryptomator          | Files are encrypted before the WebDAV, Google Drive, or iCloud folder adapter sees them, on storage the user already pays for and owns.                                                                                                                                      | Equal at the boundary, since both encrypt before the folder adapter sees a byte and both leave sizes visible. Behind Cryptomator as a drop-in virtual drive; ahead when the files belong to an application with rows that need to merge.                         |
| Bitwarden            | A portable key, device pairing, and recovery phrases are built in, so a vault syncs across devices without a custodial server.                                                                                                                                               | Bitwarden's server also never sees the vault. It offers emergency access and organization administration that Interocitor leaves to the host to build; in exchange there is no custodial account or server at all.                                               |
| A field-data app     | Inspections and surveys are written offline and merged field by field later; two workers on one report keep both sets of edits.                                                                                                                                              | Behind a hosted form platform on server-side dashboards and exports, which need plaintext. Ahead on two workers merging one report and on a remote that never sees the survey.                                                                                   |
| Trusted automation   | A worker or agent is just another trusted endpoint. It holds the key, reads task rows, does the work, and writes results back, from a browser, a server process, or a script.                                                                                                | An agent holding the key is as trusted as a person holding it; there is no narrower server-enforced view for it. Behind a server-mediated integration on least privilege, ahead on no server code and no plaintext passing through one.                          |
| A case-file system   | A file sealed under an extra key lives inside a shared mesh: the rows stay shared, only the key holders open the bytes, and the seal guards the object against overwrite or deletion.                                                                                        | Behind a document-management system on server-enforced per-document permissions and read audit. Ahead on a server that cannot read the sealed file and cannot overwrite or delete it without the key.                                                            |

The common thread: the users can each hold a full copy, the server should not
be able to read it, and there is no server code to write, host, or defend.

It is the wrong tool when the product needs server-side queries or reporting
over plaintext, per-row access control inside one dataset, or central
transactions. Every endpoint holds the entire mesh it opens, so large or
many-audience datasets are split into meshes rather than filtered per row, and
the remote can still see sizes, timing, and request identity. See [data boundaries](docs/site/content/data-boundaries.md) before
deciding.

## Roles it can play

Interocitor is one library that can stand in for several tools, because each
of them is a local store plus some way to move data. Interocitor keeps the
local API you already know and takes the server out of the trust boundary.
That is the whole difference, and it cuts both ways.

| Play the role of       | How Interocitor plays it                                                                                       | What is different                                                                           | Reach for the original when                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Dexie                  | A typed table store over IndexedDB with `where`, `subscribe`, and `useLiveQuery`                               | Narrower queries; rows merge per field; sync and encryption come with it                    | You do not need to sync "own" data                   |
| TanStack DB            | Reactive collections and live queries feeding React, with sync built in                                        | No server that understands the schema; the remote is a mailbox; scale by splitting meshes   | A trusted backend already owns the data              |
| Firebase / Firestore   | A multi-device synced store with offline as the default and no backend to write                                | The remote holds ciphertext; access is per mesh; the worker only admits, meters, and audits | The server must read, query, or report on the data   |
| A distributed database | The core in a server process with a memory or custom local store, over WebDAV, S3-compatible storage, or a NAS | Storage cannot read it; clients merge and compact; no server-side queries                   | You need central transactions or plaintext reporting |

**As Dexie.** `table`, `where`, `subscribe`, and `useLiveQuery` will feel
familiar. Queries cover one indexed field with `equals`, ranges, `startsWith`,
`anyOf`, and `orderBy`. There are no compound or multi-entry indexes, no
collection chaining, no bulk operations, and no versioned migrations. In
exchange rows merge per field with hybrid logical clock ordering, and syncing
to a remote that holds only ciphertext is already there when you want it.

**As TanStack DB.** You get reactive collections and live queries without a
server that owns the canonical data. The client replica is canonical and the
remote is a mailbox. Filtering runs on the endpoint, and scale comes from
splitting meshes and keeping their credentials as connected stores. The merge
and a file surface are part of the library.

**As Firebase.** You get a store that syncs across devices, works offline by
default, and needs no backend code. The remote cannot read it, so there are no
server queries and the unit of access is the mesh, not the row. Realtime is an
optional invalidation signal that tells clients to pull. Auth is your host's
identity provider. The Cloudflare worker sits where rules sit in the request
path, but it decides only who may touch a mesh, how many bytes, and what gets
logged. It never decides which rows.

**As a distributed database.** Interocitor is not a browser library. The core
runs wherever you give it a local store: memory, or your own, in a server
process. Point it at WebDAV, an S3-compatible bucket, or a NAS,
and a mesh behaves much like a small distributed database whose storage cannot
read it. Trusted workers and agents join as endpoints and share the same rows
and files as the browsers.

**On complexity.** Interocitor is lower level than any of these, in the way
Rust is lower level than a garbage-collected language. You name the key
source, which endpoints hold the key, who compacts, which meshes a session
opens, and which files carry a seal. That is the price of no server code, no
plaintext rows on the remote, and deterministic convergence regardless of
arrival order. Most of these choices are deployment policy the runtime cannot
verify, with server-managed compaction as the one checked case.

Both sections live on the docs site as [Applications](docs/site/content/applications.md).

## Data surfaces

Interocitor exposes two related surfaces with different availability
guarantees:

| Surface       | Behavior                                                                                                                           | Remote storage                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| CRDT rows     | Reads and writes use a caller-supplied local store. An outbox carries encoded changes when transport is available.                 | Changes and snapshots are merged and compacted by clients.               |
| Durable files | `putFile`, `getFile`, `openFile`, and `deleteFile` call the remote adapter directly. There is no core file cache or offline queue. | File bytes stay under a hidden object name until overwritten or deleted. |

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
- [Use an S3 mailbox from a browser](packages/core/docs/s3-browser.md)
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

Run the mailbox backend on Cloudflare, let users connect Google Drive, point
WebDAV at a home NAS, or connect directly to an S3-compatible bucket. Each
whole-mailbox backend carries the same artifacts; with a non-null
key source, protected payloads are encrypted before the storage adapter receives
them.

## License

MIT
