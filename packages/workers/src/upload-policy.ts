// compass: interocitor.mailbox-host.access-control

import { meshInfo } from "./mesh-info.ts";
import type { FileUploadAuthorizationRequest, FileUploadAuthorizationResult } from "./types.ts";

/** Milliseconds a mesh must have existed before it accepts durable files. */
const DEFAULT_MIN_MESH_AGE_MS = 60_000;

/** Devices that must have announced themselves before uploads are accepted. */
const DEFAULT_MIN_DEVICE_COUNT = 2;

/** How a policy treats a mesh whose age cannot be determined. */
export type UnknownMeshAgeDecision = "reject" | "allow";

/**
 * Tuning for {@link standardUploadPolicy}. Every field has a default; an
 * omitted field takes it, and `0` disables that check outright.
 */
export interface StandardUploadPolicyOptions {
  /**
   * Milliseconds a mesh must have existed before it accepts durable files.
   * Default 60000. `0` disables the check.
   *
   * This is the crudest of the bot defenses and the one most likely to catch a
   * real person: a new mesh and a scripted one look alike for exactly as long
   * as this window lasts. Shorten it for applications whose first-run flow
   * uploads immediately.
   */
  minMeshAgeMs?: number;
  /**
   * Devices that must have announced themselves before uploads are accepted.
   * Default 2 — an upload has somewhere to go. `0` or `1` disables the check.
   *
   * Heartbeats are ordinary mesh writes, so this stops a bot that only uploads,
   * not one that announces devices it invented.
   */
  minDeviceCount?: number;
  /**
   * Whether a mesh holding no sync root yet may upload. Default `"reject"`,
   * which treats an undetermined age as too new.
   *
   * Applications that write durable files before their first sync flush must
   * set `"allow"`, or every first upload is refused.
   */
  onUnknownMeshAge?: UnknownMeshAgeDecision;
  /**
   * Stored-byte ceiling for this mesh, replacing the deployment quota for the
   * purpose of this policy. Omitted leaves `maxMeshStoredBytes` in force.
   *
   * Only ever tightens: the deployment quota is checked before policy runs and
   * a larger number here cannot lift it.
   */
  maxMeshStoredBytes?: number;
  /**
   * Single-upload ceiling, replacing the deployment limit for the purpose of
   * this policy. Omitted leaves `maxStoredFileBytes` in force. Only tightens.
   */
  maxStoredFileBytes?: number;
}

function reject(status: number, reason: string): FileUploadAuthorizationResult {
  return { allowed: false, status, reason };
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Build a durable-file upload policy from documented defaults.
 *
 * The defaults express one judgment: a mesh that was created moments ago and
 * has told nobody about itself has nothing worth sharing, and is the cheapest
 * thing for a script to manufacture. A mesh that has existed for a minute and
 * holds a second device has passed both.
 *
 * ```ts
 * runtime: { authorizeFileUpload: standardUploadPolicy() }
 * ```
 *
 * Nothing applies it for you. Omitting `authorizeFileUpload` leaves durable
 * uploads governed by the built-in size, device-header, and quota checks
 * alone, exactly as before this policy existed.
 *
 * Compose rather than fork when only part of the judgment is yours:
 *
 * ```ts
 * const standard = standardUploadPolicy({ minMeshAgeMs: 30_000 });
 *
 * runtime: {
 *   authorizeFileUpload: async (request, env) => {
 *     if (await isPremiumAccount(request.request, env)) return true;
 *     return standard(request, env);
 *   },
 * }
 * ```
 *
 * Supplying your own function instead replaces this one completely; there is
 * no layer underneath it but the built-in gate, which never yields.
 *
 * @param options - Tuning; see {@link StandardUploadPolicyOptions}.
 * @returns A callback for `authorizeFileUpload`.
 * @see {@link ../docs/upload-policy.md | Decide who may upload durable files}
 *   — when to reach for this policy, how to tune it per plan, and the two
 *   defaults worth deciding rather than accepting.
 */
export function standardUploadPolicy(
  options: StandardUploadPolicyOptions = {},
): (request: FileUploadAuthorizationRequest) => Promise<FileUploadAuthorizationResult> {
  const minMeshAgeMs = positive(options.minMeshAgeMs, DEFAULT_MIN_MESH_AGE_MS);
  const minDeviceCount = positive(options.minDeviceCount, DEFAULT_MIN_DEVICE_COUNT);
  const onUnknownMeshAge = options.onUnknownMeshAge ?? "reject";
  const maxStoredFileBytes = options.maxStoredFileBytes;
  const maxMeshStoredBytes = options.maxMeshStoredBytes;

  return async (request: FileUploadAuthorizationRequest) => {
    if (maxStoredFileBytes !== undefined && request.size > maxStoredFileBytes) {
      return reject(413, "File too large");
    }

    const needsMeshFacts =
      minMeshAgeMs > 0 || minDeviceCount > 1 || maxMeshStoredBytes !== undefined;
    if (!needsMeshFacts) return true;

    const mesh = await meshInfo(request);

    if (maxMeshStoredBytes !== undefined) {
      const next = mesh.storedBytes - request.replacedBytes + request.size;
      if (next > maxMeshStoredBytes) return reject(413, "Mesh storage limit reached");
    }

    if (minMeshAgeMs > 0) {
      if (mesh.ageMs === null) {
        if (onUnknownMeshAge === "reject") return reject(429, "Mesh is too new for uploads");
      } else if (mesh.ageMs < minMeshAgeMs) {
        return reject(429, "Mesh is too new for uploads");
      }
    }

    if (minDeviceCount > 1 && mesh.deviceCount < minDeviceCount) {
      return reject(403, "Mesh has no other device to share with");
    }

    return true;
  };
}
