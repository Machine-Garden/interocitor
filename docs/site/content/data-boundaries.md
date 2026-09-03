---
title: Plan Interocitor data scope and availability
description: Decide what belongs in convergent rows, directly remote files, and separate meshes before choosing an application topology.
kicker: Architecture decision 02 · Data scope
heading: Give each kind of data the promise it needs.
lede: Rows are complete local working state that converges. Durable files are exact remote objects fetched on demand. Separate meshes bound replication, trust, and failure together.
---

## Decision summary {#summary}

|                   |                                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| **Decision**      | Set database boundaries, offline expectations, and practical scale.               |
| **Core boundary** | Opening a row mesh means holding its complete row database locally.               |
| **Complete when** | Rows, files, and meshes are classified and representative snapshots are measured. |

## Rows, files, and meshes solve different problems {#placement}

### Rows: convergent working state

Use rows for structured application state that must remain readable and writable from the local store. Row changes queue durably and merge when transport returns.

### Files: exact remote objects

Use durable files for documents, media, and other path-addressed bytes that do not need CRDT merge. Core calls the remote adapter directly; it does not provide an offline file cache or upload queue.

### Meshes: replication and trust boundaries

Every endpoint in a mesh can receive its complete row database when it holds the key. Separate meshes when data needs different readers, keys, retention, ownership, or failure scope.

## Availability follows placement {#availability}

| Operation         | Rows                                       | Durable files                                                |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Read              | Local store                                | Remote adapter                                               |
| Write             | Local store plus outbox                    | Remote adapter                                               |
| Offline behavior  | Continues after local-store initialization | Fails unless the application supplies its own cache or queue |
| Conflict behavior | Schema-defined CRDT merge                  | Same-path overwrite semantics                                |
| Remote lifetime   | Changes may be compacted into snapshots    | Remains until overwritten or deleted                         |

Do not represent a file as a row merely to imply unlimited local scale. A row snapshot still contains the mesh’s full row state, while large binary values make compaction and new-device catch-up expensive.

## Bound the full-copy database deliberately {#scale}

There is no universal row-count limit. Practical capacity depends on serialized row size, local-store implementation, snapshot size, device memory, change rate, and how quickly new or returning endpoints must catch up.

Measure at least:

- a representative complete snapshot, including tombstones;
- the largest expected uncompacted change tail;
- initialization and rehydration on the weakest supported device;
- local storage quotas and fallback behavior;
- remote transfer time under expected network conditions.

> A mesh is an availability, replication, and confidentiality unit at the same time. Split it only when the product can own the resulting cross-mesh workflow.

## Classify the application’s data {#checklist}

- Put collaborative metadata, status, indexes, and coordination rows in the local database.
- Put large documents and media in durable files, with row references where needed.
- Give directly remote files an honest online requirement or add an application-owned cache.
- Use separate meshes for tenants or workflows that require different readers or keys.
- Keep sensitive meaning out of filenames and paths when remote metadata exposure matters.
- Test compaction and rehydration with production-shaped data.

## Continue with the exact contract {#continue}

- [Rows and files](https://github.com/Machine-Garden/interocitor/tree/main/packages/core#keep-rows-and-files-distinct) — API-level behavior and guarantees.
- [Sync completeness](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/sync-completeness.md) — what a completed pull establishes.
- [Compaction](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/compaction.md) — snapshot coverage, coordination, and retention.
- [Tainted files](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/tainted-files.md) — application-owned file-key scopes.
