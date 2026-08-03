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
pulls every other remaining filename.

After snapshot and manifest publication, the engine attempts to delete the exact filenames
in `coveredChangeFiles`; later or omitted files remain available for catch-up.
Tombstones remain inside the snapshot. Because the storage API provides no
mesh-wide lease or compare-and-swap primitive, deployments must ensure only one
compactor runs at a time.

## Worker role

The Worker stores and serves immutable changes, snapshots, manifests, and
device metadata. It deletes covered change objects only when the engine names
their exact paths through the normal storage operation; it never derives a
deletion set from scalar HLC state. The engine owns coverage, epoch comparison,
rehydration, and deterministic CRDT merge.
