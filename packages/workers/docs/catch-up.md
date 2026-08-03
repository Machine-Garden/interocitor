# Catch-up after absence

Catch-up is defined by exact immutable change-file identity. HLC values order
CRDT operations deterministically; they do not prove which files a device has
observed.

## Exact receipts are authoritative

Every change has one canonical filename, `<HLC>-<change-id>.json`. On pull, a
client lists `changes/`, sorts filenames bytewise for deterministic processing,
and merges every valid filename absent from its exact receipt set. It persists
the receipt only with the merged rows. A file remains eligible even when its
HLC sorts below `head.json`, the snapshot watermark, or the client's diagnostic
cursor.

`changes/head.json` and the scalar cursor are observability hints only. They
cannot suppress listing or authorize skipping an unseen filename because
independent devices can publish in a different order from HLC order.

## Snapshot rehydration

Compaction publishes a snapshot with `coveredChangeFiles`, the exact filenames
whose effects are represented in that snapshot, and advances the manifest
epoch. A client seeing a newer epoch first publishes its durable local outbox,
then replaces local rows from the snapshot, restores those exact receipts, and
pulls every other retained filename.

Immutable change files and tombstones are retained. The storage API provides no
mesh-wide lease or compare-and-swap primitive that could prove deletion safe,
so neither a watermark nor an authorized writer identity permits pruning.

## Worker role

The Worker stores and serves immutable changes, snapshots, manifests, and
device metadata. It does not decide that a change is covered from scalar HLC
state and exposes no compacted-change pruning operation. The engine owns exact
receipt tracking, epoch comparison, rehydration, and deterministic CRDT merge.
