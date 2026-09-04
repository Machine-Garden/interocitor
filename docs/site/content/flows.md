---
title: Interocitor core flows
description: Trace row synchronization, concurrent edits, compaction, durable files, and authorization through the system.
kicker: Visual guide · Five core flows
heading: Follow data and authorization through Interocitor.
lede: These diagrams show where state lives, where encryption occurs, which component merges rows, why snapshots are ordered, and how host policy reaches the mailbox.
---

## Synchronize one row change {#edit}

The first endpoint commits a row change to its local store and outbox. When connected, it encrypts and publishes a change artifact. The second endpoint downloads the unseen artifact, decrypts it, and merges the operation into its own local store.

```mermaid
sequenceDiagram
    participant A as Endpoint A
    participant M as Remote mailbox
    participant B as Endpoint B
    A->>A: Commit local row and outbox
    A->>A: Encrypt change artifact
    A->>M: Publish artifact
    B->>M: List unseen artifacts
    M-->>B: Return encrypted change
    B->>B: Verify, decrypt, and merge
```

The mailbox never queries the row or selects a conflict winner. Trusted endpoints apply the schema’s merge rules.

## Merge two offline edits {#offline}

Two endpoints can change different fields of the same row while disconnected. After both artifacts are visible, each endpoint applies the same CRDT rules and reaches the same row state.

```mermaid
flowchart LR
    A[Endpoint A offline<br/>changes title] --> C[Encrypted change A]
    B[Endpoint B offline<br/>changes status] --> D[Encrypted change B]
    C --> E[Remote mailbox]
    D --> E
    E --> F[Each endpoint receives both]
    F --> G[Same merged row]
```

If both endpoints change the same field, the schema’s configured merge rule settles the conflict. Local-first operation does not imply arrival-order conflict resolution.

## Compact row history {#snapshot}

One trusted compactor reconstructs the complete known row state, records the exact change artifacts it covers, and publishes an encrypted snapshot before deleting anything.

```mermaid
flowchart TD
    A[Pull all visible changes] --> B[Build complete row state]
    B --> C[Capture exact covered filenames]
    C --> D[Encrypt and publish snapshot]
    D --> E[Publish current baseline]
    E --> F[Delete only covered changes]
    G[Later change arrives] --> H[Retain for next catch-up]
```

This ordering is the core [compaction](/compaction) guarantee. Coverage is based on exact artifact identity, not a timestamp guess.

## Transfer a durable file directly {#file}

Durable files do not use the local row outbox. A trusted endpoint encrypts a file, sends it directly to the remote adapter, and fetches it directly when needed.

```mermaid
flowchart LR
    A[Application selects file] --> B[Encrypt on trusted endpoint]
    B --> C[Remote file object]
    C --> D[Fetch with live transport]
    D --> E[Verify and decrypt on trusted endpoint]
```

A row can retain the file path and metadata offline. The file bytes require transport unless the application adds its own cache.

## Authorize a mesh request {#access}

Authentication and encryption are separate. The host verifies a stable subject and evaluates current resource access; mesh middleware enforces that decision before Interocitor handles the request.

```mermaid
flowchart LR
    A[Application session or token] --> B[Host authenticates subject]
    B --> C[Host checks current resource policy]
    C -- allowed --> D[Mesh middleware admits request]
    C -- denied --> E[Mesh middleware rejects request]
    D --> F[Interocitor mailbox route]
```

The mesh address selects storage and the mesh key decrypts protected data. Neither authenticates the requester. [The authentication guide connects recovery, grants, and tainted-file keys](/auth).

Continue with [the complete system model](/how-it-works) or [the security boundary](/security).
