// compass: interocitor.mailbox-host.access-control

import { sharedGlobalState } from "./shared-global-state.ts";
import type { DatabaseAdapter, FileUploadAuthorizationRequest } from "./types.ts";

/**
 * Server-authored facts about one mesh, for application upload policy.
 *
 * Every field is derived from the deployment's own row store, never from
 * client-supplied request metadata. Encrypted payloads stay opaque: these are
 * counts, sizes, and timestamps the row store already keeps in order to serve
 * the mesh at all.
 */
export interface MeshInfo {
  /**
   * Epoch milliseconds at which this address first held a sync root, or `null`
   * when it holds none yet.
   *
   * An address may carry several remote roots; this is the earliest of them,
   * counting roots maintenance has since retired. `null` is a real answer, not
   * a missing one — a durable file can be written before any sync root exists.
   * Decide what an unknown age means for your policy rather than coercing it.
   */
  createdAt: number | null;
  /** Milliseconds since {@link createdAt}, or `null` when that is `null`. */
  ageMs: number | null;
  /**
   * Device heartbeat objects held across this address's roots.
   *
   * Heartbeats are ordinary mesh writes, so this counts devices that have
   * announced themselves — not devices an operator has vouched for. One device
   * syncing two roots counts twice.
   */
  deviceCount: number;
  /** Durable file bodies stored for this address. */
  storedFileCount: number;
  /** Total stored bytes of those durable file bodies. */
  storedBytes: number;
}

interface MeshInfoSource {
  db: DatabaseAdapter;
  prefix: string;
  storedBytes: number;
  storedFileCount: number;
  resolved?: Promise<MeshInfo>;
}

/**
 * Requests carry no mesh handle of their own. The runtime registers one here
 * before invoking application policy, so {@link MeshInfo} stays a capability
 * the application reaches for rather than a payload every upload carries.
 *
 * Realm-wide rather than module-wide: the registration and the lookup sit on
 * opposite sides of the library boundary. The runtime attaches the source; the
 * application's own `authorizeFileUpload` calls {@link meshInfo}. A bundle that
 * resolved those two imports to different copies of this package would leave
 * every policy throwing `TypeError` on a request the runtime had registered
 * correctly.
 */
const sources = sharedGlobalState(
  "workers.mesh-info-sources.v1",
  () => new WeakMap<object, MeshInfoSource>(),
);

/**
 * Register the row-store handle backing {@link meshInfo} for one request.
 *
 * @internal Called by the runtime; not part of the public contract.
 */
export function attachMeshInfoSource(
  request: FileUploadAuthorizationRequest,
  source: Omit<MeshInfoSource, "resolved">,
): void {
  sources.set(request as object, { ...source });
}

/**
 * Seed {@link meshInfo} with a literal result for one request object.
 *
 * Intended for application tests, which construct a
 * {@link FileUploadAuthorizationRequest} by hand and so hold no row store for
 * the accessor to read. A seeded request never queries.
 */
export function provideMeshInfo(request: FileUploadAuthorizationRequest, info: MeshInfo): void {
  sources.set(request as object, {
    db: undefined as unknown as DatabaseAdapter,
    prefix: request.canonicalAddress,
    storedBytes: info.storedBytes,
    storedFileCount: info.storedFileCount,
    resolved: Promise.resolve({ ...info }),
  });
}

async function loadMeshInfo(source: MeshInfoSource): Promise<MeshInfo> {
  const { db, prefix } = source;
  const [createdRow, deviceRow] = await Promise.all([
    db.first<{ created_at?: string | null }>(
      "SELECT MIN(created_at) AS created_at FROM mesh_paths WHERE prefix=?1",
      prefix,
    ),
    db.first<{ count?: number }>(
      `SELECT COUNT(*) AS count FROM files
       WHERE prefix=?1 AND path LIKE '%/devices/%' AND path NOT LIKE '%/devices/%/%'`,
      prefix,
    ),
  ]);
  const raw = createdRow?.created_at;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  const createdAt = Number.isFinite(parsed) ? parsed : null;
  return {
    createdAt,
    ageMs: createdAt === null ? null : Math.max(0, Date.now() - createdAt),
    deviceCount: Number(deviceRow?.count ?? 0),
    storedFileCount: source.storedFileCount,
    storedBytes: source.storedBytes,
  };
}

/**
 * Read server-authored facts about the mesh receiving a durable-file upload.
 *
 * Call it from `authorizeFileUpload` to express policy in terms of mesh age,
 * announced devices, or stored volume:
 *
 * ```ts
 * authorizeFileUpload: async (request, env) => {
 *   if (await isPaidAccount(request.request, env)) return true;
 *   const mesh = await meshInfo(request);
 *   if (mesh.ageMs === null || mesh.ageMs < 60_000)
 *     return { allowed: false, status: 429, reason: "mesh too new" };
 *   return mesh.deviceCount >= 2;
 * }
 * ```
 *
 * Stored volume is already known when policy runs and costs nothing. Age and
 * device count are read on first call and memoized for the rest of the
 * request, so a policy that never asks never pays.
 *
 * @param request - The request handed to `authorizeFileUpload`.
 * @throws TypeError when `request` was not supplied by the runtime and has no
 *   result seeded by {@link provideMeshInfo}.
 * @see {@link ../docs/upload-policy.md | Decide who may upload durable files}
 *   — what these facts do and do not establish, and the policies worth
 *   building on them.
 */
export function meshInfo(request: FileUploadAuthorizationRequest): Promise<MeshInfo> {
  const source = sources.get(request as object);
  if (source === undefined) {
    throw new TypeError(
      "meshInfo() requires the request supplied by authorizeFileUpload; " +
        "seed a hand-built request with provideMeshInfo() in tests",
    );
  }
  source.resolved ??= loadMeshInfo(source);
  return source.resolved;
}
