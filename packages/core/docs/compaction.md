# Compaction

Compaction publishes a full-state snapshot and bumps the manifest generation.
Peer meshes retain immutable change files because storage adapters provide no
CAS or lease that could make concurrent deletion safe. Server-managed meshes
have one authorized compactor identity and enable automatic checkpointing, but
they retain immutable change files and tombstones too.

This document covers the protocol details. The README has a one‑page
summary; everything below is for operators, debugging, or anyone tuning
auto‑compaction in production.

## Mental model

```
changes/   ─┐
            ├─►  rehydrate()  ─►  identical local state
mainline/   ─┘                    on every device
```

A snapshot carries the exact filenames of the change files merged into its row
state. After publishing it, the engine deletes only that captured set. Devices
that rejoin the mesh restore the snapshot and its exact receipts first, then
apply every retained filename absent from the receipt set. The snapshot
`watermarkHlc` orders state and acknowledgements; it does not prove coverage.

## What `compact()` does

1. Acquire the local sync-state lock, promote the completed pending batch, and
   flush every durable outbox entry. A publication failure aborts compaction.
2. `pull()` — merge newer remote changes while new local writes remain behind
   the same lock.
3. Capture the exact observed change filenames.
4. Build a full snapshot from the local store (not the in‑memory cache — the
   cache is partial), including tombstones.
5. Write `mainline/snapshot-<epoch>-<serverId>.json` (encrypted if the
   mesh is encrypted).
6. Write `manifest-<generation+1>.json` and overwrite `manifest.json`
   (the pointer) to reference it.
7. Set `local.epoch = nextEpoch`.
8. Retain every immutable change file. `coveredChangeFiles` initializes exact
   receipts during restore; it is not deletion authorization.

## Triggers

Manual checkpoints are available in both modes. Automatic compaction runs only
in server-managed mode:

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

| Reason                   | Meaning                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `disabled`               | `autoCompact: false`                                                  |
| `not-connected`          | Engine not connected to remote                                        |
| `missing-remote`         | No adapter or no `remotePath`                                         |
| `peer-mode`              | Peer mode retains immutable history; automatic compaction is disabled |
| `poisoned`               | Remote in poisoned state (decode error earlier)                       |
| `already-running`        | Another compaction is in flight                                       |
| `sampling`               | Immediate path lost the sampling roll                                 |
| `below-remote-threshold` | Delayed path saw too few remote change files                          |
| `superseded`             | A newer write replaced this delayed schedule                          |

## Coordination & locking

> **The adapter contract has no CAS/ETag write.** Peer snapshot pointers may
> race, so peer mode never makes destructive retention decisions.

What the engine does:

- A single in‑flight guard (`compactInFlight`) deduplicates calls *within
  one engine instance*.
- Inside `compact()` the engine pulls before snapshotting, so the snapshot
  reflects the latest remote state observable at that moment.
- Peer mode retains every immutable change file.
  Whichever snapshot pointer wins, exact catch-up can recover every file absent
  from that snapshot.
- Server-managed mode admits one authorized compactor identity and enables
  automatic checkpoints, but does not assume identity implies mutual exclusion.

What the engine does **not** do:

- Take a remote lease (`mainline/compact-lock.json` or similar).
- Use conditional writes when overwriting `manifest.json` (the pointer)
  or the `manifest-<gen>.json` file.
- Select one peer snapshot deterministically when concurrent pointer writes
  occur. This can leave an orphan snapshot, but retained change files preserve
  the complete catch-up path.

### Server‑managed mode

When the manifest is bootstrapped with `server.managed = true`, only the
device whose `deviceId` matches `serverId` may compact. Every other
device's `compact()` throws:

```
Compaction is allowed only for the authorized server writer
```

Use this to nominate the canonical checkpoint writer and enable automatic
compaction. Both modes deliberately keep immutable change files indefinitely.

## Retention safety: exact snapshot coverage

Compaction makes no prune decision. The new snapshot's `coveredChangeFiles`
records concrete observation and becomes the restored client's initial receipt
set. It does not authorize deletion. A lower HLC alone never proves that a file
was observed, and an authorized server identity can still run concurrently in
multiple processes.

This is the safety boundary imposed by adapters without CAS or leases:
concurrent snapshots may race for the pointer, but all immutable files remain
available for exact catch-up.

Tombstones are not garbage-collected. A device acknowledgement contains a
scalar watermark, and that scalar cannot prove that the device has no older
durable batch left to publish. Using it as a cutoff recreates the late-file
loss bug at the retention boundary.

The retention invariant is:

> Every immutable change file remains retained and every unseen filename remains
> eligible for pull, regardless of whether its HLC is below a watermark.

### What can still go wrong

- **Concurrent peer checkpoints.** Without CAS, one peer's manifest pointer may
  overwrite another's. Peer mode retains all immutable files, so a reader loads
  the selected snapshot and catches up by exact filename. The losing snapshot
  is an orphan, not lost history.
- **Incomplete adapter listing.** An omitted file is not added to
  `coveredChangeFiles`. Because it remains retained, a later pull can still
  observe it.

## Rehydrate flow

`rehydrate()` is the inverse of `compact()` from a reader's perspective.
The engine calls it automatically when local `epoch < remote epoch`, but
you can call it manually as a recovery path.

On automatic reconnect, an old client first promotes and publishes any durable
pending/outbox work. Only then may snapshot replacement clear local state. A
new client has no such work and can restore immediately. Catch-up applies every
retained filename not named by the snapshot receipts.

```
manifest.snapshotPath  ──►  download  ──►  decrypt  ──►  clearAll
                                                          │
                                                          ▼
                                             putRows + exact receipts
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
- **Privacy‑sensitive deletes.** Tombstones carry no user payload, but their
  metadata is retained. Do not rely on compaction for hard deletion until a
  contiguous publication protocol is implemented.
