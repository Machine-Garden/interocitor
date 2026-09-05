---
title: What belongs in Interocitor rows, files, and meshes?
description: Classify local mergeable rows, directly remote files, separate trust domains, and data that needs another system.
kicker: Data · Scope and availability
heading: Rows, durable files, and meshes carry different guarantees.
lede: Put structured working state in rows, exact byte objects in durable files, and different row audiences in different meshes.
---

## Classify data by behavior {#map}

Consider a field-response application with map markers, team status, photos, and drone video. Storing all of it as replicated rows would force every endpoint to carry the entire media archive.

Classify it instead:

- **Rows:** marker positions, captions, status, and file references. They are structured state that should remain useful offline and merge across endpoints.
- **Durable files:** photos, PDFs, audio, and video, and any structured result that is produced once and read by one screen. Their exact bytes stay remote and are fetched when needed.
- **Meshes:** separate full-copy row databases for groups with different readers, keys, retention, or failure boundaries, or for units of work an endpoint opens one at a time.
- **Another system:** data that needs server-side plaintext queries, strict central transactions, or another guarantee Interocitor does not provide.

## Compare availability and update semantics {#offline}

| Operation               | Row                               | Durable file                                          |
| ----------------------- | --------------------------------- | ----------------------------------------------------- |
| Read                    | From the endpoint’s local store   | Fetch from remote storage                             |
| Change                  | Commit locally and publish later  | Upload directly to remote storage                     |
| Work offline            | Yes, after local initialization   | Only with an application-owned cache                  |
| Resolve concurrent work | Apply the field’s CRDT merge rule | A same-path write replaces bytes by adapter semantics |

A row can retain a file reference and enough metadata to render the interface while offline. The file bytes remain unavailable until transport returns unless the application implements a cache.

## Point a row at a file {#file-ref}

Declare the pointer as a column, and the row becomes the index for content that loads on demand:

```ts
const schema = {
  tables: {
    reports: { fields: { title: types.string, body: types.file } },
  },
} satisfies DatabaseSchemaDefinition;

const meta = await db.putFile("reports/r1/body.json", JSON.stringify(result), "application/json");
await db.table("reports").add({ title: "Q4", body: toFileRef("reports/r1/body.json", meta) });

const report = await db.table("reports").row(id);
const body = JSON.parse(new TextDecoder().decode(await db.getFile(report.body)));
```

The reference is `{ path, digest, size, contentType?, taint? }`. The digest is the SHA-256 of the plaintext, which makes the reference immutable even though the path is not. Overwriting the path produces a new digest; a screen holding the old reference is refused with `FileIntegrityError` rather than shown the wrong bytes.

Immutable references are what make local copies safe. Bytes keyed by digest never go stale, so an application can keep them in memory, in IndexedDB, or in the browser’s Cache API and serve them before asking the network, with no invalidation logic and no service worker. The row database stays small because every endpoint replicates the pointer, not the content.

Use this shape for anything produced once by one writer and read by the screen that asked for it: a converted document, an extraction result, a rendered export. Use rows for what several parties edit or what must answer before the network does. A big thing of the first kind, pointed at by a small thing of the second kind, is the normal case.

## Use a mesh as a trust and failure boundary {#mesh}

A mesh combines three decisions: who eventually receives the complete row database, who can derive its key, and which remote history is backed up, retained, or lost together.

Split a mesh when readers, ownership, retention, or failure impact genuinely differ, or when the product has natural units of work that nobody needs all at once. Do not split merely to speed up one query inside a set everyone loads anyway. Once split, the application must own any trusted process that moves information across the boundary.

If rows may remain shared but one attachment needs fewer readers, keep the mesh and [seal that durable file with a tainted-file key](/tainted-files).

## Measure the full-copy constraint {#scale}

Every endpoint opening a mesh must hold its complete row database. Capacity therefore depends on the weakest supported endpoint and the actual shape of the data, not a universal row limit.

Measure:

- one realistic complete snapshot;
- startup and catch-up time on the weakest supported device;
- local storage limits;
- peak changes between snapshots;
- memory and query behavior under the expected schema.

Move large byte payloads to durable files first. Split the mesh only when the product can also own the resulting trust and workflow boundary.

## Open meshes on demand {#many-meshes}

A product with many projects, boards, or cases rarely needs all of them on one device at once. Give each unit of work its own mesh and open only the ones a session needs. Each open mesh is still a complete local copy, but of that unit alone.

Interocitor supplies the primitives and leaves the assembly to the application:

- **One key, many meshes.** A portable key is not tied to a mesh, so one secret can open every mesh at every remote path. The bound key source receives the remote path and mesh ID when it derives, so one organisation secret can also yield a distinct key per mesh.
- **A directory.** `db.connectedStores` keeps credentials for related meshes inside a parent mesh: remote path, key, local namespace, and an adapter pointer. It stores records and nothing else. The application reads a record and constructs a second engine from it.
- **An index.** Summary rows in the parent mesh play the role a file reference plays for bytes: a small thing that always travels, pointing at a large thing loaded when asked for.

The application owns the rest: which meshes to open, when to close them, moving a record between two meshes, and any search across meshes. Whoever can read the parent mesh can read every credential it holds, so the directory is a trust boundary in its own right.

## Write the first data map {#pack}

Create four lists: local rows, directly remote files, separate-reader meshes, and data that belongs elsewhere. For each list, state its offline, privacy, and recovery guarantee in one sentence.

Then follow [the data flows](/flows) and [how snapshots bound catch-up](/compaction).

## Decision summary {#summary}

|            |                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Rows**   | Full local, mergeable working state.                                                                                                      |
| **Files**  | Directly remote bytes, named from rows by `types.file`, cacheable by digest.                                                              |
| **Meshes** | Whole-database reader, key, retention, and failure boundaries; opened on demand per unit of work, with credentials kept in a parent mesh. |
