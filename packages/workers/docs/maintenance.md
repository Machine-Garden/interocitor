# Maintenance and system operations

Use TTL maintenance when a deployment must reclaim D1 sync objects belonging
to remote roots that have been inactive for a defined number of hours.

Maintenance is destructive. For each eligible remote root it deletes matching
rows from the D1 `files` and `folders` tables, clears its counters, and marks
the `mesh_paths` row deleted. It does not delete R2- or S3-backed durable file
bodies.

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

`pathTtlHours` is measured from `mesh_paths.last_operation_at`. A positive
finite number enables deletion. Omitted, invalid, zero, and negative values
disable it. Choose a value longer than the maximum period in which a remote
root may legitimately remain idle.

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
gate normally returns `404`; a gate error returns `503`.
