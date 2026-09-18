# Maintenance and system operations

Use TTL maintenance when a deployment must reclaim D1 sync objects belonging
to remote roots that have been inactive for a defined number of hours.

Maintenance is destructive. For each eligible remote root it deletes matching
rows from the D1 `files` and `folders` tables, clears its counters, and marks
the `mesh_paths` row deleted. It does not delete bodies from the configured
durable file-body store.

The `mesh_paths` row itself survives. The mesh address stays routable, every
device can still connect, and the host reports what happened through the
eviction record described below. Devices that still hold the mesh key refill
the rows they observed on their next write.

Do not use the Worker path TTL as row-history compaction. The Worker does not
hold the mesh key and cannot merge encrypted changes into a snapshot. A
connected server-managed Interocitor writer uses D1's server-recorded
`modifiedTime` and the manifest's finite `retention.compactAfterMs` policy to
run compaction; the safe default is seven days. The separate Worker path TTL
removes an entire inactive mesh and must therefore be longer than the mesh's
supported offline lifetime and backup policy.

Change files, mainline snapshots, and the listings of their two folders
deliberately bypass Cloudflare's per-colo Cache API. Every read of those
deletable payloads and lifecycle listings consults D1, so post-compaction
deletion is authoritative in every colo. Immutable manifest generation files
remain cacheable.

The snippets are partial deployment fragments. Supply the host Worker,
bindings, application policy, and Wrangler database identifiers. Use the
[runnable Cloudflare example](../../../examples/todo-cloudflare-do/README.md)
for complete wiring.

## Run from a Cloudflare cron trigger

Configure a cron trigger in `wrangler.toml`, then opt the wrapped Worker into
scheduled maintenance:

```toml
[triggers]
crons = ["0 3 * * *"]
```

```ts
import { withInterocitor } from "@interocitor/workers";

export default withInterocitor(appWorker, {
  db: (env) => env.DB,
  runtime: {
    meshIntegrityGates: [({ address }) => address === "main"],
    enableScheduledMaintenance: () => true,
    pathTtlHours: (env) => env.INTEROCITOR_PATH_TTL_HOURS,
  },
});
```

`withInterocitor(...).scheduled()` awaits the wrapped application's scheduled
handler, then awaits one all-mesh TTL sweep. `createInterocitorMount(...)` does
not install a scheduled handler.

`pathTtlHours` is measured in writes, not operations. The clock runs from
`mesh_paths.last_write_at`, or from `created_at` for a mesh that has never
been written. Reads do not hold a mesh alive: a mesh that is polled every hour
but never written is idle, because no device has produced a record the host is
the only holder of. A positive finite number enables deletion. Omitted,
invalid, zero, and negative values disable it.

The recommended value is `8760`, one year. Whatever you choose must be longer
than the mesh's `retention.maxOfflineDurationMs`, or a device can return from
an offline period into a mesh that was evicted while it was away and that it
is already fenced out of.

A mesh whose only readers never write can therefore expire. If a deployment
has meshes that are published once and read for years, either disable the TTL
for that prefix or have the publisher write a heartbeat within the window.

## Read the eviction record

An evicted mesh serves a JSON eviction record at `<remoteRoot>/evicted.json`:

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

The record is synthesized from the surviving `mesh_paths` row on every read.
It is never stored as an object, never cached, and never separately cleared,
so serving it is not a write and does not reset the clock it reports. `reason`
is `idle` for the TTL sweep and `operator` for any other host-initiated
reclamation. A mesh that has not been evicted returns `404`; writes and
deletes to the path return `405`.

The next write to the mesh clears the flag, and the record disappears with it.
Reads do not clear it, so a device can detect eviction across as many polls as
it needs before it decides to refill.

## Expose host-triggered operations

Create the separate system handler only when the host needs mesh-ID,
metric-reconciliation, or maintenance operations. Compaction is initiated by
an Interocitor client through the normal IO route:

```ts
import { checksummedMeshIntegrityGate, createInterocitorSystemHandler } from "@interocitor/workers";

const system = createInterocitorSystemHandler({
  mountPrefix: "/sync",
  db: (env) => env.DB,
  runtime: {
    meshIntegrityGates: [checksummedMeshIntegrityGate],
    meshSecret: (env) => env.INTEROCITOR_MESH_SECRET,
    pathTtlHours: (env) => env.INTEROCITOR_PATH_TTL_HOURS,
  },
});

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (system.matches(pathname)) {
      if (!(await env.adminPolicy.allows(request))) {
        return new Response("Forbidden", { status: 403 });
      }
      return system.fetch(request, env, ctx);
    }
    return meshMount.fetch(request, env, ctx);
  },
};
```

Send JSON POST requests to
`/<mountPrefix>/__interocitor/system/<route-address>`. The route address and
body `op` are both required; a missing value returns `400`. An unknown `op`
returns `404`.

| Operation            | Body fields and defaults                                                                         | Result                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `issue-mesh-id`      | No additional fields. The non-empty route address is only a routing anchor, such as `provision`. | Issues a checksummed UUIDv7 `{ meshId }`.                               |
| `validate-mesh-id`   | Required `meshId`; missing returns `400`. The route address is only a routing anchor.            | `{ valid: boolean }`; malformed or wrong-authority IDs return `false`.  |
| `reconcile-metrics`  | `remotePath` defaults to `/`.                                                                    | Recalculates stored metrics for the route-address mesh and remote root. |
| `run-maintenance`    | No additional fields.                                                                            | Runs the configured TTL sweep for the route-address mesh.               |
| `maintenance-status` | `remotePath` defaults to `/`.                                                                    | Returns maintenance state for the route-address mesh and remote root.   |

Operations targeting an existing mesh pass `meshIntegrityGates`. ID issue and
validation do not target an existing mesh. System operations use the host
policy shown above; they do not pass `meshMiddleware`. A rejected integrity
gate normally returns `404`; a gate error or non-boolean result returns `503`.
