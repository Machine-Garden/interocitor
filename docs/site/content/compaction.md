---
title: Why does Interocitor compact old changes?
description: Understand how exact snapshot coverage bounds catch-up without deleting unseen changes.
kicker: Sync · Bounded history
heading: A returning endpoint should not replay an unbounded change log.
lede: Interocitor retains published row changes for offline endpoints. A trusted compactor periodically publishes a complete encrypted snapshot and deletes only the exact changes that snapshot covers.
---

## Explain why the change log grows {#journal}

Each endpoint publishes immutable row-change artifacts so other endpoints can catch up after working offline. Retaining every artifact preserves that history, but the cost of joining or returning grows with it.

**Compaction** creates a new baseline: the complete current row state in one encrypted snapshot, followed by only changes published after that snapshot’s exact coverage was captured.

```mermaid
flowchart LR
    A[Accumulated change artifacts] --> B[One trusted compactor]
    B --> C[Complete encrypted snapshot]
    C --> D[Remaining uncovered changes]
    D --> E[Bounded catch-up]
```

Compaction improves catch-up and bounds normal retained change history. It does not guarantee that deletion metadata disappears; tombstones remain in the snapshot so an old row value cannot be resurrected.

## Publish before deleting {#safe}

The safe sequence is:

1. publish the compactor’s pending local changes;
2. pull every remote change currently visible;
3. capture the exact filenames included in the candidate snapshot;
4. write the complete encrypted snapshot;
5. publish it as the current baseline;
6. delete only the captured filenames.

A change arriving after coverage capture is absent from the deletion set and remains available for the next pull. Failed cleanup leaves redundant history, which costs space but preserves data.

## Run one compactor at a time {#one-packer}

Concurrent compactors can each publish a different current snapshot and then delete a different covered set. Ordinary object storage does not serialize that race.

Choose one compaction owner per mesh. A small deployment may nominate one controlled endpoint; a larger deployment should use one always-available trusted worker. Do not run multiple processes under the same compactor identity.

The compactor needs the mesh key because it reconstructs the complete row state before encrypting the new snapshot. The mailbox cannot compact protected rows by itself.

## Define the maximum offline window {#offline}

Retention requires an explicit promise about how long an endpoint may remain away while holding unpublished work.

An endpoint returning within that window publishes its pending changes before restoring a newer snapshot. After the window expires, Interocitor quarantines those local changes instead of publishing them automatically, restores the current snapshot, and lets the application inspect, export, discard, or deliberately reapply the quarantined work.

This prevents very old edits from entering current state silently while preserving them for an explicit decision.

## Monitor observable outcomes {#healthy}

Verify that:

- new and returning endpoints reach current state within the expected time;
- only one compactor publishes for a mesh;
- failed cleanup remains visible and retries;
- quarantined offline work can be inspected and recovered;
- an invalid snapshot stops synchronization and raises an actionable error.

Durable files are outside row compaction. Compaction neither deletes nor rewrites application file objects.

See [the core flows](/flows) or [choose between rows and durable files](/data-boundaries).

## Decision summary {#summary}

|                    |                                                                     |
| ------------------ | ------------------------------------------------------------------- |
| **Purpose**        | Bound catch-up with a complete row snapshot and shorter change log. |
| **Safety rule**    | One compactor; publish first; delete only exact covered filenames.  |
| **Offline policy** | Define when old unpublished work is quarantined for review.         |
