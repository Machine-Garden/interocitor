# Compaction

Compaction collapses the remote change log into a single snapshot, prunes
the old change files, and bumps the manifest generation. It is purely a
maintenance operation: sync still works without it, but the remote folder
grows unbounded until *some* device compacts.

This document covers the protocol details. The README has a one‑page
summary; everything below is for operators, debugging, or anyone tuning
auto‑compaction in production.

## Mental model

```
changes/   ─┐
            ├─►  rehydrate()  ─►  identical local state
mainline/   ─┘                    on every device
```

A snapshot at HLC watermark `W` captures every row whose latest write was
at HLC ≤ `W`. After compaction the engine deletes every change file with
HLC ≤ `W`. Devices that re‑join the mesh load the snapshot first, then
catch up on any change files newer than `W`.

## What `compact()` does

1. `pull()` — merge any newer remote changes into local state so the
   snapshot is not stale.
2. Build a full snapshot from the local store (not the in‑memory cache —
   the cache is partial).
3. Write `mainline/snapshot-<epoch>-<serverId>.json` (encrypted if the
   mesh is encrypted).
4. Write `manifest-<generation+1>.json` and overwrite `manifest.json`
   (the pointer) to reference it.
5. Compute `gcFloorHlc` from active device acknowledgements.
6. Omit tombstones whose `deletedHlc <= gcFloorHlc` from the snapshot.
7. Set `local.epoch = nextEpoch`.
8. List `changes/` and delete every entry whose HLC ≤ `watermarkHlc`.
   Failure here is logged but non‑fatal — the snapshot is still valid.

## Triggers

There are three ways `compact()` runs:

| Path | Trigger | Cost |
| --- | --- | --- |
| Manual | App calls `db.compact()` | Direct |
| Immediate sampled | After a flush of ≥ `compactAutoThreshold` ops, with probability `compactAutoSampleNumerator / compactAutoDeviceCount` | Cheap roll on every flush |
| Delayed two‑phase | Per‑write timer, then a remote‑file‑count check, then a second timer | Two `setTimeout`s |

Both auto‑paths are deduped by a single in‑flight guard (`compactInFlight`),
so a manual call and an automatic one will not overlap.

### Manual compaction policy (recommendation)

If you call `db.compact()` from app code (e.g. a "Sync now" button or a
periodic job in your shell), the recommended gate is:

- device idle **> 1 min**
- last successful pull **< 30 min** ago
- remote churn **> 20 changes** since last compaction
- engine connected and healthy
- no compaction already in progress

This is just a recommendation. The engine does not enforce it. If you
never call `compact()`, the auto‑compaction defaults below will eventually
run.

### Auto-compaction defaults

The engine ships with `autoCompact: true`. The defaults are tuned for a
small mesh (1–2 devices) doing light writes. Override them only if you
have measured the actual mesh size.

| Config | Default | Meaning |
| --- | --- | --- |
| `autoCompact` | `true` | Master switch for both auto paths |
| `compactAutoThreshold` | `50` | Minimum changes processed by a flush before the immediate sampled path may fire |
| `compactAutoSampleNumerator` | `10` | Numerator of the per‑flush probability |
| `compactAutoDeviceCount` | `1` | Estimated mesh size; chance ≈ `numerator / deviceCount` |
| `firstCompactDelayMs` | `10 * 60_000` (10m) | Base delay before the delayed‑path check |
| `firstCompactDelayJitterMs` | `5 * 60_000` (±5m) | Jitter on the first delay |
| `secondCompactDelayMs` | `15 * 60_000` (15m) | Base delay between the check and the actual compact |
| `secondCompactDelayJitterMs` | `5 * 60_000` (±5m) | Jitter on the second delay |
| `compactRemoteChangeThreshold` | `2` | Delayed path skips while remote change-file count is at or below this value; the second timer is armed only above it |
| `compactWarnThreshold` | `50` | Outbox size that triggers a single `compact:warning` event |
| `offlineGraceMs` | `7 * 24 * 60 * 60_000` | How long an unseen device remains in GC consensus before it must realign from snapshot |

> **Manual policy ≠ auto defaults.** The manual recommendation above
> ("> 20 changes, idle > 1 min") is what to gate a button on. The auto
> defaults use two independent paths: an immediate sample after a flush of at
> least 50 operations, and a per-write delayed check that proceeds only when
> the remote contains more than 2 change files. They solve different
> problems: the manual gate is "don't compact the active session"; the auto
> paths are "compact after large local churn" and "eventually compact after
> any write when remote history has accumulated".

### Immediate sampled path

After every flush that processed at least `compactAutoThreshold` ops,
the engine rolls a die. The chance of running is roughly
`numerator / deviceCount`. With the default `numerator = 10` and
`deviceCount = 1` that means "always roll a 0", so a single‑device mesh
will compact on every qualifying flush. Bumping `deviceCount` to your
actual fleet size makes one device per fleet compact on average.

### Delayed two‑phase path

Each write arms a check timer. When it fires:

1. List `<remotePath>/changes/`.
2. If file count ≤ `compactRemoteChangeThreshold`, skip with reason
   `below-remote-threshold`.
3. Otherwise arm a second timer.
4. When that fires, run `compact()`.

`compactAutoThreshold` does not gate this delayed path. Even one local write
arms the first timer; only connection/health checks and the remote file-count
threshold decide whether it reaches the second timer.

Each new write bumps `compactScheduleVersion`, so a chatty client never
piles up overlapping schedules — the older one short‑circuits with reason
`superseded` when its callback finally fires.

## Events

```ts
db.on(event => {
  switch (event.type) {
    case 'compact:warning':            /* outbox ≥ compactWarnThreshold */ break;
    case 'compact:delayed:scheduled':  /* phase: 'check' or 'compact' */ break;
    case 'compact:delayed:check':      /* listed remote change files */ break;
    case 'compact:auto:start':         /* trigger: 'immediate' | 'delayed' */ break;
    case 'compact:auto:complete':      /* same trigger field */ break;
    case 'compact:auto:skip':          /* reason explains why */ break;
    case 'compact:auto:error':         /* error on the auto path */ break;
  }
});
```

`compact:auto:skip` reasons:

| Reason | Meaning |
| --- | --- |
| `disabled` | `autoCompact: false` |
| `not-connected` | Engine not connected to remote |
| `missing-remote` | No adapter or no `remotePath` |
| `poisoned` | Remote in poisoned state (decode error earlier) |
| `already-running` | Another compaction is in flight |
| `sampling` | Immediate path lost the sampling roll |
| `below-remote-threshold` | Delayed path saw too few remote change files |
| `superseded` | A newer write replaced this delayed schedule |

## Coordination & locking

> **The current adapter contract has no CAS/ETag write.** Compaction is
> therefore *not* race‑safe in the strict sense.

What the engine does:

- A single in‑flight guard (`compactInFlight`) deduplicates calls *within
  one engine instance*.
- Inside `compact()` the engine pulls before snapshotting, so the snapshot
  reflects the latest remote state observable at that moment.

What the engine does **not** do:

- Take a remote lease (`mainline/compact-lock.json` or similar).
- Use conditional writes when overwriting `manifest.json` (the pointer)
  or the `manifest-<gen>.json` file.
- Detect a concurrent compactor that started between this device's
  `pull()` and its `writeFile(manifest.json)`.

In practice two devices rarely race because:

- The sampling path makes simultaneous fires statistically unlikely
  (each device rolls independently).
- The delayed path's first‑then‑second timer gives a wide jitter window.
- Most meshes are small (1–3 devices).

If you operate a larger mesh or need strict safety, run with
`serverManaged: true` and a single authorized writer (see "Server‑managed
mode" below).

### Server‑managed mode

When the manifest is bootstrapped with `server.managed = true`, only the
device whose `deviceId` matches `serverId` may compact. Every other
device's `compact()` throws:

```
Compaction is allowed only for the authorized server writer
```

Use this to delegate compaction to a single trusted worker and avoid the
race entirely.

## Pruning safety: device acknowledgements and GC floor

Compaction has two separate prune decisions:

1. **Change-file prune.** Delete remote change files whose HLC is ≤ the
   new snapshot `watermarkHlc`. Those entries are redundant because the
   snapshot captures the merged state.
2. **Tombstone GC.** Omit deleted rows from a snapshot only when their
   `deletedHlc <= manifest.gcFloorHlc`.

The GC floor is the mesh's point of no return. Devices acknowledge what
they have actually observed by updating `devices/<deviceId>.json` after
`pull()`, `rehydrate()`, `connect()` alignment, and `compact()`:

```ts
{
  observedManifestGeneration,
  observedEpoch,
  observedWatermarkHlc,
  observedGcFloorHlc,
  observedAt
}
```

During compaction the engine lists device metadata and computes:

```text
activeDevices = devices where retired != true
             and lastSeenAt >= now - offlineGraceMs

gcFloorHlc = min(activeDevices.observedWatermarkHlc)
```

`gcFloorHlc` is monotonic. It never moves backwards. Any active device
without `observedWatermarkHlc` blocks advancement because it is still
inside the offline grace period but has not acknowledged a canonical
watermark.

Devices not seen within `offlineGraceMs` are excluded from the active
set. They may return later, but they are no longer trusted to publish
old history directly. On `flush()`, the engine reloads the manifest and
refuses to publish any local outbox entry whose `entry.hlc <=
manifest.gcFloorHlc`. If a snapshot exists, it rehydrates from that
snapshot instead, clearing the stale outbox and aligning with the point
of no return.

Invariant the prune step relies on:

> Every active device has acknowledged a watermark ≥ `gcFloorHlc`, and no
> stale device may flush entries at or before `gcFloorHlc` without first
> rehydrating from the canonical snapshot.

### What can still go wrong

- **Concurrent compactor races.** Without CAS, the second compactor's
  manifest pointer may overwrite the first. Both snapshots are valid;
  only the manifest is wrong. The losing device's snapshot becomes an
  orphan file that no rehydrate will ever read.
- **Adapter that lies about list ordering.** The prune step trusts
  `listFiles()`. An adapter that omits files (eventual consistency) may
  leave change files older than the watermark on disk. They are
  redundant, not corrupting — the next compaction will catch them.
- **Adapter that fails mid‑prune.** Logged as a non‑fatal warning. The
  snapshot is still valid; leftover change files will be deleted by the
  next successful compaction.

## Rehydrate flow

`rehydrate()` is the inverse of `compact()` from a reader's perspective.
The engine calls it automatically when local `epoch < remote epoch`, but
you can call it manually as a recovery path.

```
manifest.snapshotPath  ──►  download  ──►  decrypt  ──►  clearAll
                                                          │
                                                          ▼
                                                       putRows
                                                          │
                                                          ▼
                                                  pull() catch‑up
```

Rehydrate emits:

- `rehydrate:start`
- `rehydrate:complete` with `rowCount`
- `decode:error` + `remote:poisoned` if the snapshot file fails to decode
  (corrupt or wrong key)

## Tuning checklist

- **Single device.** Defaults are fine.
- **2–10 devices.** Set `compactAutoDeviceCount` to your real fleet size.
  This keeps roughly one device compacting per flush on average.
- **> 10 devices.** Consider `serverManaged: true` and a single worker
  with `serverId = <worker device id>`. Disable auto‑compaction on
  clients (`autoCompact: false`).
- **Read‑heavy app, very few writes.** Manual `compact()` from a cron is
  fine; the auto paths will rarely fire.
- **Privacy‑sensitive deletes.** Tombstones carry no payload. They are
  retained only until compaction can advance `gcFloorHlc` past their
  `deletedHlc`, after all active devices have acknowledged the floor.
