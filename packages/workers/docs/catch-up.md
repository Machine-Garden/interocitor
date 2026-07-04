# Catch-up after absence

Incremental catch-up is native to the sync model: a device only ever fetches
what it has not already merged.

## The cursor is the HLC watermark

Every change file is named `<HLC>-chg_<id>.json`. The HLC is a monotonic "last operation" timestamp embedded in the file name, so the change folder is implicitly ordered by it.

Each device persists its own cursor: the highest HLC it has fully merged. On pull, the engine lists the change folder and merges only files whose HLC is greater than the cursor. "Give me everything after my cursor" is therefore a direct consequence of the data structure, not an extra protocol.

A device that has been offline for a long time pulls only the change files newer than its cursor. It does not re-download the database. There is also a fast path: if `changes/head.json` has not advanced past the cursor, the engine skips listing entirely.

## When a full snapshot is still needed

The only case that forces a snapshot rehydrate is when the change files newer than a device's cursor have already been pruned by compaction. That is a retention decision, not a missing mechanism: keep enough change-file tail for the longest expected absence, or accept that very stale devices rehydrate from the latest snapshot.

## Worker role

The HLC-named change files in the mesh folder already provide the ordered,
cursor-filterable history that `pull()` consumes. The worker stores and serves
those files; the ordering and the cursor filter live in the data model itself.
