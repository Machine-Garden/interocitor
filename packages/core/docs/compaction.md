# Compaction

Compaction publishes a full-state snapshot, bumps the manifest generation, and
attempts to delete the exact change files merged into that snapshot. It also
deletes every superseded mainline snapshot, so a healthy remote has exactly
one `mainline/snapshot-*.json`: the file named by the current manifest. A finite
retention policy bounds normal-operation eligibility and schedules cleanup;
storage failures can delay physical deletion. Tombstones remain in the
snapshot. Because storage adapters provide no CAS or distributed lease,
deployments must ensure that only one compactor publishes at a time.

Use the protocol details below when operating, debugging, or tuning
auto-compaction in production. For first setup and the package's API map, see
the [Core package overview](../README.md).

## Mental model

```
changes/   ─┐
            ├─►  rehydrate()  ─►  identical local state
mainline/   ─┘                    on every device
```

A snapshot carries the exact filenames of the change files merged into its row
state. After publishing it, the engine deletes only that captured set. Devices
that rejoin the mesh restore the snapshot and its exact receipts first, then
apply every remaining filename absent from the receipt set. The snapshot
`watermarkHlc` orders state and acknowledgements; it does not prove coverage.

If you know log-structured merge trees, the shape is familiar. `changes/` is
the append-only level zero: every write lands as a new immutable segment, and a
reader has to visit every segment it has not already absorbed. The mainline
snapshot is the merged level below it. A database runs that merge on a
background thread inside the server, invisibly. Interocitor cannot: the server
holds ciphertext it cannot read, so the merge has to run wherever the mesh key
is, which means on a client. Compaction is that background merge, moved to the
edge and made an explicit responsibility of whoever operates the mesh.

## Who compacts, and when

Compaction is performed by an Interocitor engine that holds the mesh key. It
reconstructs the complete row state from its own local store, so nothing that
cannot decrypt the mesh can do it: not the storage service, not the Cloudflare
Worker, not the Durable Object relay. A mesh runs in one of two modes, fixed
when its manifest is first created:

| Mode                            | Who may call `compact()`                                                  | Automatic compaction                                                                        | Default retention behaviour                                                                     |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Peer (`serverManaged: false`)   | Any endpoint, one at a time                                               | **None.** Every automatic path skips with reason `peer-mode`, whatever `autoCompact` says.  | `changes/` grows without bound until something calls `compact()`.                               |
| Managed (`serverManaged: true`) | Only the endpoint whose device id equals `serverId`; everyone else throws | Sampled, delayed, and retention-deadline paths all run, on that one writer, while connected | The writer compacts once the oldest uploaded change is `retention.compactAfterMs` old (7 days). |

Peer mode is the default, and it is what both shipped example applications
use: they expose a "Compact" button and nothing compacts unless it is pressed.
If your deployment has no process that calls `compact()`, the change log never
shrinks, every new or returning device replays the whole tail, and the only
bound is the storage bill.

Managed mode exists so one always-available, key-holding process can own
checkpoints. That process is an ordinary TypeScript engine, in a browser tab
or a Node process, whose `deviceId` is the manifest's `serverId` (the Python
and Swift packages can call `compact()` manually but have no automatic paths).
The flag is a protocol rule, not a storage feature, and any adapter supports
it.

Managed mode cannot be turned on for an existing mesh: the manifest records
the flag at bootstrap and later clients inherit it, so passing
`serverManaged: true` against a peer mesh changes nothing. Every endpoint of a
managed mesh must be configured with the mesh's `serverId`, or its manifest is
rejected as an unauthorized writer; the writer itself additionally runs with
that value as its `deviceId`.

Whichever mode you pick, the operational rule is the same: one compactor
identity, one process holding it.

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
8. Best-effort delete every filename in `coveredChangeFiles`. Files omitted
   from the captured set remain available for catch-up, even when their HLC is
   below the snapshot watermark.
9. Best-effort list `mainline/` and delete every snapshot except the one named
   by the new manifest. A connected managed writer retries interrupted cleanup
   during its retention checks; another successful compaction retries too.

Every successful call writes a new snapshot even when there are no new change
files. The write-new, publish-pointer, delete-old order is the commit protocol:
overwriting the current payload in place would expose partial data to readers.
Callers that do not need a new explicit checkpoint should avoid redundant
manual calls; automatic compaction does not run without eligible changes.

## Snapshot lifecycle and storage bounds

| State      | Meaning                                                                        | Retention rule                                                                                                     |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Candidate  | Snapshot payload was written, but the manifest pointer does not name it yet.   | Keep during publication; a later retention check, compaction, or operator recovery removes an abandoned candidate. |
| Current    | `manifest.json` resolves to a generation whose `snapshotPath` names this file. | Keep exactly one. Never delete it during cleanup.                                                                  |
| Superseded | A newer manifest pointer was committed.                                        | Delete best effort after publication; retry on later managed retention checks and compactions.                     |

The normal-operation physical bounds for protocol data are:

- `mainline/`: exactly one current snapshot;
- `changes/`: only changes not yet covered by the current snapshot, subject to
  the finite `retention.compactAfterMs` deadline;
- `manifest-<generation>.json`: immutable publication lineage, retained by this
  protocol and normally much smaller than snapshots or changes;
- `files/`: application-owned durable files, never compacted.

Delete or listing failures may temporarily exceed the one-snapshot bound. The
`compact:snapshot-cleanup` event reports attempted, deleted, and failed paths.
If strict storage accounting is required, alert on that event and on more than
one mainline snapshot. Historical backups belong in storage-level backup or
versioning, not in `mainline/`.

A client can race cleanup after reading an old manifest but before reading its
snapshot. On a missing or unreadable cached path, rehydration force-refreshes
the manifest and retries once if `snapshotPath` changed. Failure of the current
path still poisons the remote. Adapters and gateways must therefore make
snapshot deletion authoritative; a cache must not continue serving a deleted
superseded snapshot or a stale `mainline/` listing.

## Triggers

Manual checkpoints are available in both modes. Automatic compaction runs only
in server-managed mode:

| Path               | Trigger                                                                                                               | Cost                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Manual             | App calls `db.compact()`                                                                                              | Direct                                                           |
| Immediate sampled  | After a flush of ≥ `compactAutoThreshold` ops, with probability `compactAutoSampleNumerator / compactAutoDeviceCount` | Cheap roll on every flush                                        |
| Delayed two‑phase  | Per‑write timer, then a remote‑file‑count check, then a second timer                                                  | Two `setTimeout`s                                                |
| Retention deadline | Oldest uploaded change reaches `retention.compactAfterMs`                                                             | One non-resetting deadline owned by the connected managed writer |

All paths are deduped by a single in‑flight guard (`compactInFlight`),
so a manual call and an automatic one will not overlap.

The retention deadline is independent of `autoCompact`. Disabling the two
churn-based paths does not make retention infinite. It runs only in
server-managed mode, where one continuously available key-holding writer can
decrypt and publish the snapshot. Peer meshes must call `compact()` from an
externally serialized maintenance process.

## Finite retention defaults

This partial configuration fragment shows only the retention fields; use it
inside the complete constructor setup from the package README.

```ts
const db = new Interocitor(adapter, {
  // ...mesh and local-store configuration...
  retention: {
    compactAfterMs: 7 * 24 * 60 * 60 * 1_000,
    maxOfflineDurationMs: 30 * 24 * 60 * 60 * 1_000,
  },
});
```

Both durations are user-controlled but must be positive and finite. `0`, a
negative value, `NaN`, or `Infinity` throws during construction. The defaults
leave a week before uploaded changes require compaction and a month before an
absent writer loses automatic publication eligibility.

When an expired device reconnects, the engine checks retention before any
outbox upload. It promotes the completed pending batch, moves the exact queued
entries into local quarantine, restores the current snapshot, and emits
`offline:retention-expired`. The application can inspect the quarantine with
`getQuarantinedOfflineChanges()`. Quarantined entries never publish
automatically; export, discard, or deliberately reapply them as fresh edits.

This is a trusted-client protocol fence. A generic writable object store cannot
stop software that bypasses the Interocitor engine and writes arbitrary files.
Cloudflare supplies server-recorded file modification times for the compaction
deadline, but the key-holding engine still performs the encrypted merge.

### Manual compaction policy (recommendation)

If you call `db.compact()` from app code (e.g. a "Sync now" button or a
periodic job in your shell), the recommended gate is:

- device idle **> 1 min**
- last successful pull **< 30 min** ago
- remote churn **> 20 changes** since last compaction
- engine connected and healthy
- no compaction already in progress

This is just a recommendation. The engine does not enforce it. A connected
managed writer still runs the churn paths below and the independent finite
retention deadline.

### Auto-compaction defaults

The engine ships with `autoCompact: true`, but the switch only has an effect
on the managed writer of a managed mesh; on every other endpoint, and on every
peer-mode endpoint, the automatic paths skip. The defaults assume that one
writer sees light traffic. Override them only after measuring.

| Config                         | Default             | Meaning                                                                                                              |
| ------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `autoCompact`                  | `true`              | Master switch for both auto paths                                                                                    |
| `compactAutoThreshold`         | `50`                | Minimum changes processed by a flush before the immediate sampled path may fire                                      |
| `compactAutoSampleNumerator`   | `10`                | Numerator of the per‑flush probability                                                                               |
| `compactAutoDeviceCount`       | `1`                 | Estimated mesh size; chance ≈ `numerator / deviceCount`                                                              |
| `firstCompactDelayMs`          | `10 * 60_000` (10m) | Base delay before the delayed‑path check                                                                             |
| `firstCompactDelayJitterMs`    | `5 * 60_000` (±5m)  | Jitter on the first delay                                                                                            |
| `secondCompactDelayMs`         | `15 * 60_000` (15m) | Base delay between the check and the actual compact                                                                  |
| `secondCompactDelayJitterMs`   | `5 * 60_000` (±5m)  | Jitter on the second delay                                                                                           |
| `compactRemoteChangeThreshold` | `2`                 | Delayed path skips while remote change-file count is at or below this value; the second timer is armed only above it |
| `compactWarnThreshold`         | `50`                | Outbox size that triggers a single `compact:warning` event                                                           |

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
the managed writer rolls a die. The chance of running is roughly
`numerator / deviceCount`. With the default `numerator = 10` and
`deviceCount = 1` that means "always", so the writer compacts on every
qualifying flush. Because only the writer ever rolls, `compactAutoDeviceCount`
does not spread work across a fleet; raising it only makes the writer compact
less often after its own large flushes. Leave it at `1` unless the writer's
own churn is the problem.

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
db.on((event) => {
  switch (event.type) {
    case "compact:warning":
      /* outbox ≥ compactWarnThreshold */ break;
    case "compact:delayed:scheduled":
      /* phase: 'check' or 'compact' */ break;
    case "compact:delayed:check":
      /* listed remote change files */ break;
    case "compact:auto:start":
      /* trigger: 'immediate' | 'delayed' */ break;
    case "compact:auto:complete":
      /* same trigger field */ break;
    case "compact:auto:skip":
      /* reason explains why */ break;
    case "compact:auto:error":
      /* error on the auto path */ break;
    case "compact:retention:scheduled":
      /* finite deadline and dueAt */ break;
    case "compact:retention:start":
      /* oldest change reached its limit */ break;
    case "compact:retention:complete":
      /* snapshot published and cleanup attempted */ break;
    case "compact:retention:error":
      /* deadline check or compact failed */ break;
    case "compact:snapshot-cleanup":
      /* superseded snapshot delete counts and failedPaths */ break;
    case "offline:retention-expired":
      /* stale outbox moved to local quarantine */ break;
  }
});
```

The finite deadline emits `compact:retention:scheduled`, `:start`, `:complete`,
or `:error`. Offline expiry emits `offline:retention-expired` with the number
of quarantined change entries.

`compact:auto:skip` reasons:

| Reason                   | Meaning                                                 |
| ------------------------ | ------------------------------------------------------- |
| `disabled`               | `autoCompact: false`                                    |
| `not-connected`          | Engine not connected to remote                          |
| `missing-remote`         | No adapter or no `remotePath`                           |
| `peer-mode`              | Automatic compaction requires a nominated server writer |
| `poisoned`               | Remote in poisoned state (decode error earlier)         |
| `already-running`        | Another compaction is in flight                         |
| `sampling`               | Immediate path lost the sampling roll                   |
| `below-remote-threshold` | Delayed path saw too few remote change files            |
| `superseded`             | A newer write replaced this delayed schedule            |

## Coordination & locking

> **The adapter contract has no CAS/ETag write.** Concurrent compactors can
> race the manifest pointer and deletion set. Run one compactor at a time.

What the engine does:

- A single in‑flight guard (`compactInFlight`) deduplicates calls _within
  one engine instance_.
- Inside `compact()` the engine pulls before snapshotting, so the snapshot
  reflects the latest remote state observable at that moment.
- Manual peer compaction uses the same exact covered-file deletion as managed
  compaction. The application is responsible for serializing callers.
- Server-managed mode admits one authorized compactor identity and enables
  automatic checkpoints. Deployments must still avoid running that identity in
  multiple concurrent processes.

What the engine does **not** do:

- Take a remote lease (`mainline/compact-lock.json` or similar).
- Use conditional writes when overwriting `manifest.json` (the pointer)
  or the `manifest-<gen>.json` file.
- Select one peer snapshot deterministically when concurrent pointer writes
  occur. A losing compactor can otherwise delete a file absent from the winning
  snapshot.

### Server‑managed mode

When the manifest is bootstrapped with `server.managed = true`, only the
device whose `deviceId` matches `serverId` may compact. Every other
device's `compact()` throws:

```
Compaction is allowed only for the authorized server writer
```

Use this to nominate the canonical checkpoint writer and enable automatic
compaction. Ensure only one process owns that identity at a time.

## Deletion safety: exact snapshot coverage

The new snapshot's `coveredChangeFiles` records concrete observation, becomes
the restored client's initial receipt set, and is the exact post-publication
deletion set. A lower HLC alone never proves that a file was observed.

Snapshot and manifest publication complete before cleanup starts. Cleanup is
best effort: a failed delete leaves a redundant file that restored receipts
will skip. A file published after receipt capture is not named and remains for
the next pull or compaction.

Superseded snapshot cleanup follows the same publication boundary but not the
change-file coverage rule: after the pointer commits, every other recognized
`mainline/snapshot-*.json` is redundant. This cleanup is safe only while the
whole compaction sequence is externally serialized.

Tombstones are not garbage-collected. A device acknowledgement contains a
scalar watermark, and that scalar cannot prove that the device has no older
durable batch left to publish. Using it as a cutoff recreates the late-file
loss bug at the deletion boundary.

The deletion invariant is:

> Only exact filenames represented in the published snapshot may be deleted;
> every unseen filename remains eligible for pull regardless of its HLC.

### What can still go wrong

- **Concurrent checkpoints.** Without CAS, one manifest pointer may overwrite
  another while the losing compactor deletes its covered set. If the winning
  snapshot did not cover the same files, history can be lost. Serialize
  compaction outside the engine.
- **Incomplete adapter listing.** An omitted file is not added to
  `coveredChangeFiles`, so cleanup leaves it available for a later pull.
- **Persistent delete/list failure.** The current snapshot remains usable, but
  redundant snapshots may exceed the physical bound until storage recovers.

## Rehydrate flow

`rehydrate()` is the inverse of `compact()` from a reader's perspective.
The engine calls it automatically when local `epoch < remote epoch`, but
you can call it manually as a recovery path.

On automatic reconnect, an old client still within
`retention.maxOfflineDurationMs` first promotes and publishes its durable
pending/outbox work. Only then may snapshot replacement clear local state. An
expired client instead moves that work into local quarantine before restoring;
a new client has no such work and can restore immediately. Catch-up applies
every remaining filename not named by the snapshot receipts.

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
- a forced manifest refresh and one transparent retry when a superseded
  snapshot disappeared during a read race
- `decode:error` + `remote:poisoned` if the snapshot file fails to decode
  (corrupt, wrong key, or still unavailable after the retry)

## Tuning checklist

- **Any mesh with no managed writer.** Nothing compacts automatically. Call
  `db.compact()` from one place: a maintenance job, a nominated device, or a
  user action gated by the manual policy above. Alert on the size of
  `changes/` so you notice when that place stops running.
- **One long-lived key-holding process is available.** Bootstrap the mesh
  with `serverManaged: true` and give that process the `serverId`. Leave the
  auto defaults alone; the retention deadline guarantees a checkpoint at
  least every `compactAfterMs` even if the churn paths never fire.
- **Many devices, no server process.** Nominate one device and make its
  owner responsible, or accept manual compaction. Do not try to spread
  compaction across peers with `compactAutoDeviceCount`; peers never
  auto-compact, and concurrent manual calls race the pointer.
- **Read‑heavy app, very few writes.** A manual `compact()` from a cron is
  enough in either mode.
- **Privacy‑sensitive deletes.** Tombstones carry no user payload, but their
  metadata is retained. Do not rely on compaction for hard deletion until a
  contiguous publication protocol is implemented.

## Cloudflare Worker and the Durable Object relay

The Cloudflare backend changes how cheaply a growing change log is served and
how reliably it is measured. It does not change who compacts or whether
compaction is needed.

- **Neither the Worker nor the Durable Object compacts.** They never hold the
  mesh key, so they cannot merge encrypted changes into a snapshot. The
  Worker stores immutable change objects in D1, serves them, and deletes the
  exact paths an engine names after publishing a snapshot. See
  [Catch-up after absence](../../workers/docs/catch-up.md).
- **The Durable Object relay changes when a client pulls, not what a pull
  costs.** Its message is a bare "pull now" signal, batched per second and
  carrying no filenames. Every pull it triggers is an ordinary pull: list all
  of `changes/`, merge the files absent from the receipt set. A connected
  client already merges only what arrived since its last pull, whether that
  pull came from a timer or from the relay, so the relay buys latency and
  fewer empty polls, not less catch-up work. The listing still grows with the
  log, a client that was away still replays every unseen file, and a new
  device still starts from the snapshot plus the whole uncovered tail. In the
  LSM picture the relay tells readers that level zero gained a segment; it
  never merges one.
- **D1 supplies the clock the retention deadline trusts.** The managed
  writer's `compactAfterMs` check reads each change file's `modifiedTime`
  from the listing. Cloudflare records that time server-side in D1, so the
  deadline cannot be skewed by a client clock. WebDAV and S3 also return
  server times; an adapter that returns none makes the writer compact
  conservatively.
- **Post-compaction deletion is authoritative in every colo.** Change files,
  mainline snapshots, and the listings of both folders bypass the per-colo
  Cache API and always consult D1, so a rehydrating client cannot be served a
  deleted snapshot or a stale listing. Immutable manifest generation files
  remain cacheable.
- **The Worker path TTL is not compaction.** `pathTtlHours` deletes an
  entire inactive mesh from D1. Set it longer than the longest legitimate
  offline period plus your backup window, and keep it separate from
  `retention.compactAfterMs`. See
  [Maintenance and system operations](../../workers/docs/maintenance.md).
- **The shipped Cloudflare example runs in peer mode.** It compacts only
  when its "Compact" button is pressed. A production deployment behind the
  Worker still needs either a managed writer or a scheduled caller.
