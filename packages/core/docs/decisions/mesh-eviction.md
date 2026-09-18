# Mesh eviction and refill

A mailbox may reclaim the storage a mesh occupies. It may not end the mesh.
Interocitor treats reclamation and deletion as different acts with different
consequences, and requires that a device learn which one happened rather than
inferring it from an empty room.

## Decision

1. Reclaiming a mesh's storage is **eviction**. The mesh identity, its address,
   and its host-side record survive; only payload objects are removed.
2. The mailbox idle clock measures **writes**, not operations. A read extends
   nothing, because every trusted device already holds what a reader reads.
3. The idle clock runs from the last write, or from the path's creation when it
   has never been written. Deletion is disabled by default; one year is the
   recommended enabled value and must exceed the mesh's
   `retention.maxOfflineDurationMs`.
4. A host that can attest to its own eviction publishes an **eviction record**
   at `<remotePath>/evicted.json`. It is synthesized from the host's mesh record
   at read time, never stored as an object, never cached, and never separately
   cleared: it exists exactly while the host-side record is in the evicted
   state.
5. A client detects eviction two ways, and both are authoritative:
   - **Missing manifest.** No manifest pointer exists while the local store
     already binds a mesh ID for this database.
   - **Lineage change.** A validated manifest carries a lineage different from
     the one this client last observed. An advance is a rebirth; a regression is
     a restored backup. Both are repaired by the same act, so both count.
6. The manifest carries `lineage`: an integer, absent meaning `1`, incremented
   only by a client that bootstraps a manifest for a mesh ID it already knew.
   A newly created mesh has lineage `1`.
7. **Every** device that detects eviction republishes its complete local row
   state with each row's original clocks, not only the device that recreated
   the manifest.
8. Core emits `mesh:evicted` on detection, carrying how it was detected, the
   host's attestation when one exists, and the local row and queued-change
   counts.
9. `evictedMeshPolicy` decides what follows detection: `refill` republishes
   immediately and is the default; `manual` completes the connect without
   recreating or repopulating the mesh and waits for
   `refillEvictedMesh()`.
10. Durable file bodies are outside refill and outside the mesh idle sweep. A
    refilled row may name a file whose bytes are gone.
11. Eviction is not erasure. Deleting data that devices still hold requires
    revoking the mesh address and rotating to a new mesh.

## Why the decision is correct

**Writes are the only signal that means anything.** The mailbox is a medium
between devices that each hold a complete copy. A mesh being read and never
written is a mesh whose readers already have everything in it; the copy on the
disk is redundant with the copies doing the reading. An operation clock would
keep such a mesh alive forever at the exact moment it has become least worth
storing. It would also make idleness untestable for an operator, because
polling — an activity no user performs — resets it.

**Rule 7 is a correctness requirement, not a courtesy.** It is tempting to let
the first device to return rebuild the mesh and treat the others as ordinary
catch-up clients. That loses data. Devices hold complete copies of what they
have _observed_, and those sets are not equal: a device that published after
another's last sync holds rows the other never saw. No single device is
guaranteed to hold the union, so the union is only restored when each device
contributes its own state. Republishing is safe to repeat because the original
per-column clocks travel with it and the built-in merge is last-writer-wins: a
row another device already restored merges to the identical value.

**One rule covers rebirth and rollback.** A lineage that moves in either
direction means the mailbox no longer holds the history this client last agreed
with, and the repair is identical in both cases: contribute the complete local
copy and let last-writer-wins settle it. Treating a regression as corruption and
refusing to connect would turn a recoverable rollback — an operator restoring a
backup — into an outage, while the devices that could repair it sit idle holding
the missing rows. The client remembers the highest lineage it has seen, so a
rollback is detected once rather than on every reconnect.

**Lineage is what makes rule 7 reachable.** A refilled mesh restarts at
generation 1 and epoch 0, which is indistinguishable from a mesh created
moments ago. A device arriving after the refill finds a valid manifest, a
normal pull, and no evidence at all that anything was lost — and would
therefore never republish the rows only it holds. Lineage is the durable,
backend-independent record that a rebirth happened, and it is carried in the
one object every client already reads before anything else.

**The eviction record is a projection, not a state.** Storing a marker object
would introduce a second source of truth that can disagree with the host's
record, must be deleted by some later write, and would itself be a write that
resets the very clock that produced it. Synthesizing it on read removes every
one of those problems: it is true whenever it answers, absent whenever the mesh
is live, and costs no storage and no schema change.

**Inference must remain sufficient.** Most deployments are a bucket, a WebDAV
server, or somebody's NAS, where no code exists to attest to anything. A client
that required attestation would be unable to detect eviction on the majority of
backends. The missing-manifest rule works everywhere; attestation upgrades it
from a correct inference to a dated, explained fact.

## Implementation ownership

| Concern                                                    | Owner                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| Idle clock, sweep eligibility, eviction record synthesis   | `packages/workers/src/maintenance.ts`, `packages/workers/src/worker.ts` |
| Eviction record path classification and cache exclusion    | `packages/workers/src/paths.ts`                                         |
| Manifest `lineage` read, default, and increment on rebirth | `packages/core/src/core/manifest.ts`                                    |
| Detection, `mesh:evicted`, policy, republish               | `packages/core/src/core/sync-engine.ts`                                 |
| Remembered lineage                                         | Local store meta                                                        |

## Object and event contract

The eviction record is a plain JSON object, readable by any adapter that can
fetch a path:

```json
{
  "evicted": true,
  "meshAddress": "main",
  "remotePath": "/main",
  "evictedAt": "2026-09-18T03:00:00.000Z",
  "reason": "idle",
  "idleSince": "2025-09-17T11:42:05.000Z",
  "fileBodiesRetained": true
}
```

`reason` is `idle` for the scheduled sweep and `operator` for a host-triggered
run. `fileBodiesRetained` reports whether durable file bodies survived; the
Cloudflare sweep retains them, so it reports `true`. A host that cannot attest
serves nothing and the path returns not-found, which is not evidence that the
mesh is alive — it is the absence of evidence either way.

`mesh:evicted` carries:

| Field               | Meaning                                                         |
| ------------------- | --------------------------------------------------------------- |
| `detectedBy`        | `missing-manifest` or `lineage-change`                          |
| `attestation`       | The parsed eviction record, or `null` when the host serves none |
| `previousLineage`   | The lineage this client last observed                           |
| `localRowCount`     | Rows this client can contribute                                 |
| `queuedChangeCount` | Unpublished changes already queued                              |
| `policy`            | The `evictedMeshPolicy` that will be applied                    |

## Invalid substitutions

- **Deleting the host record instead of flagging it.** A removed record makes
  the next connect look like a first connect, discards the mesh's age, and
  destroys the only host-side evidence that anything was reclaimed.
- **Letting only the refilling client republish.** Loses every row held by
  exactly one absent device. See rule 7.
- **Treating a missing manifest as a new mesh when local state names a mesh
  ID.** This is today's silent behaviour and it is the bug: it refills by
  accident, tells nobody, and resets lineage.
- **Using `last_operation_at` as the idle clock.** Polling and reads keep dead
  meshes alive indefinitely.
- **Storing the eviction record as an object.** A second source of truth, and a
  write that resets the idle clock it documents.
- **Calling eviction a deletion.** The data is on the devices, and the devices
  will restore it on their next write.
- **Sweeping durable file bodies on the mesh idle clock.** File bodies have no
  refill path, so their loss is unrecoverable where a row's is not. If they are
  ever swept it must be on their own stated clock and their own decision.

## Consequences

- An operator can reclaim storage from abandoned meshes without destroying the
  live ones, because the live ones repair themselves on the next write.
- Every device pays one full re-upload of its local state per eviction. This is
  bounded by the mesh size and happens at most once per lineage.
- A mesh whose remaining devices are all readers cannot be refilled, and will
  be evicted on schedule and stay evicted. Read-only participation does not
  preserve a mesh.
- A device that returns past `retention.maxOfflineDurationMs` to an evicted
  mesh is fenced by the offline rule first: it rebuilds from the remote and its
  queue goes to quarantine. It contributes nothing to the refill. This is why
  the idle clock must be much longer than the offline limit.
- Rows can outlive the files they name. Applications holding durable files must
  be prepared for a refilled row whose bytes are missing, exactly as they must
  be for a file the provider lost.
- Adding `lineage` does not invalidate existing manifests. It is resolved after
  hash validation, defaults to `1`, and is written into the next generation.

## Failure modes

| Condition                               | Behaviour                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Two devices refill concurrently         | Both bootstrap; one manifest wins the pointer, both row sets merge under LWW        |
| Eviction record unreadable or malformed | Detection proceeds on the missing-manifest rule; `attestation` is `null`            |
| Refill interrupted part way             | Published entries stand; the next connect detects nothing and the outbox retries    |
| Host evicts while a device is mid-flush | The flush fails against missing objects; reconnect detects eviction and republishes |
| Lineage lower than remembered           | Read as a restored backup: republish local state to repair the rollback             |
| Local store never held a mesh ID        | Not an eviction. A first connect to an empty mailbox creates a mesh at lineage 1    |
