# Catch-up after absence

Incremental catch-up is native within one compaction epoch. Epoch changes are
the explicit signal to rehydrate from a snapshot.

## The cursor is the HLC watermark

Every change file is named `<HLC>-chg_<id>.json`. The HLC is a monotonic "last operation" timestamp embedded in the file name, so the change folder is implicitly ordered by it.

Each device persists its own cursor: the highest HLC it has fully merged. On pull, the engine lists the change folder and merges only files whose HLC is greater than the cursor. "Give me everything after my cursor" is therefore a direct consequence of the data structure, not an extra protocol.

A device whose local epoch matches the remote manifest epoch pulls only the
change files newer than its cursor. There is also a fast path: if
`changes/head.json` has not advanced past the cursor, the engine skips listing
entirely.

## When snapshot rehydration happens

Compaction publishes a new snapshot and advances the manifest epoch. On
connect, a client with `localEpoch < remoteEpoch` rehydrates from that snapshot
and then pulls changes written after it. This happens because the epoch
advanced, even if some older change files still exist.

Pruning is a separate retention action. Change files through the compaction
watermark can be removed after the snapshot becomes authoritative. A client
must not infer snapshot need by looking for a missing tail; it follows the
manifest epoch.

## Worker role

The HLC-named change files provide the ordered, cursor-filterable history that
`pull()` consumes. The Worker stores and serves those files and snapshots; the
engine owns cursor filtering, epoch comparison, rehydration, and CRDT merge.
