---
title: How Interocitor handles independent operators
description: Follow one row change from a local write through an encrypted mailbox, merge, compaction, and recovery.
kicker: How Interocitor syncs
heading: Independent operators can converge without a central editor.
lede: Each endpoint changes its own local rows. The network carries uniquely named artifacts; trusted endpoints interpret and merge them. Snapshots keep later catch-up bounded.
---

## Two operators, one mesh, no coordination {#evolution}

Imagine Device A changes a document title while Device B, offline elsewhere, approves the same document. A shared `state.json` file would force one device to overwrite the other or require the server to understand the document. Interocitor records the two edits as independent operations instead.

| Device A                   | Device B              | Result after exchange   |
| -------------------------- | --------------------- | ----------------------- |
| `title = "Q3 field notes"` | `status = "approved"` | Both fields are present |

For concurrent writes to the same field, the schema’s CRDT policy and hybrid logical clocks determine a stable result. The mailbox never chooses a winner.

> Storage preserves artifacts. Trusted endpoints resolve intent.

## One change crosses the mesh {#journey}

### 1. Write locally

The application writes through its local table API. The local store updates immediately and records a durable outbox entry. Once that store has opened, row work does not wait for remote storage.

### 2. Encode and protect

On `flush()`, Core turns the outbox entry into a uniquely named change artifact. With a non-null key source, the row payload is encrypted before the storage adapter receives it.

```text
device_a local row
  → outbox entry
  → encrypted change file
  → remote changes/ path
```

### 3. Store without interpreting

The mailbox retains the change file and the device’s small control records. It can list, read, write, and delete objects. It does not query rows, run application policy, or merge concurrent edits.

### 4. Pull and merge at the receiver

Device B lists change filenames after its cursor, downloads unseen artifacts, decrypts them, and applies CRDT operations to its own local store. It advances observation state only after the change is accepted.

The routine loop is deliberately small:

1. change local state;
2. queue and encrypt an artifact;
3. store it in the mailbox;
4. pull and merge on another trusted endpoint.

## Fold history into a baseline {#compaction}

An append-only change history becomes expensive for a new or returning endpoint. Compaction publishes the current merged row state as a snapshot and points the mesh manifest at it.

The safe publication sequence is:

1. pull the latest visible changes;
2. capture the exact filenames covered by the candidate snapshot;
3. write the encrypted snapshot;
4. write its generation manifest;
5. switch `manifest.json` to that complete generation;
6. remove only the captured change files.

Snapshot first and pointer last means a reader sees either the previous complete generation or the new complete generation. It is never directed to a baseline that has not been written.

### Deletion must remain visible

A deleted row becomes a tombstone operation. Removing that operation before every relevant endpoint has incorporated it could let an old value reappear. Compaction therefore carries tombstones into the snapshot and retires only change files with exact coverage.

The adapter contract does not promise compare-and-swap writes. Two clients can publish valid compactions that race, so strict deployments should use a server-managed single compactor. See the [compaction contract](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/compaction.md).

## Keys and plaintext stay at the ends {#boundary}

With a non-null key source, protected payloads cross the adapter boundary as ciphertext.

| Trusted endpoint                                         | Remote mailbox                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Mesh key, plaintext rows, application policy, CRDT merge | Ciphertext payloads, paths, sizes, timing, manifests, device records |

A raw mailbox or database dump does not reveal protected row values or ordinary durable-file contents. A malicious or failed remote can still withhold, delete, reorder, or roll back artifacts. Client-side encryption provides confidentiality and per-object integrity; it does not provide availability or a monotonic storage history.

This merge story applies to structured rows. Durable files use the same encryption boundary but a simpler lifecycle: direct remote put, get, overwrite, and delete, with no CRDT merge or core offline queue.

## Encryption and authorization answer different questions {#protection}

The mesh key protects payload contents. A protocol-aware Worker’s request policy decides whether a request may reach the mesh at all.

- **Mesh key:** enables a trusted endpoint to decrypt rows and ordinary files.
- **Mesh authorization:** can grant read-only, full, or denied access to a mailbox namespace.
- **Application policy:** may add narrower, time-limited operations around a specific workflow.

Authorization does not give the Worker plaintext, and encryption does not prove that a caller should be admitted. Neither layer becomes a per-row or per-file ACL.

## Same artifacts, different backend guardrails {#adapter-boundary}

WebDAV exposes portable file operations. A Cloudflare Worker carries the same protected artifacts but can recognize protocol paths and reject some invalid states.

| Pressure             | Generic WebDAV contract                         | Cloudflare Worker mitigation                                     |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Stale control write  | Same-path PUT follows host overwrite semantics  | Lower manifest generations and clocks can be rejected            |
| Immutable history    | A client convention unless the host adds policy | Change files, manifests, and snapshots use insert-once semantics |
| Mesh admission       | Usually follows account or directory access     | Address gates and middleware can grant explicit mesh access      |
| Abuse and operations | Provider-specific                               | Typed body limits, quotas, audit events, and TTL maintenance     |

These controls reduce accidental overwrite, unauthorized use, and unbounded uploads through the normal API. They do not make a compromised host trustworthy or serialize equal-generation compaction races.

## The repeatable loop {#recap}

Operators change local state without waiting for one another. Each publication is a uniquely named protected change; ordinary storage carries it; trusted endpoints merge it. Cursors make routine pulls incremental, and snapshots bound the work of joining later.

Continue with the [core adapter contract](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/adapter-contract.md) or choose an [architecture decision](/trust).
