// compass: interocitor.mailbox-sync.change-transfer

/**
 * Codec — encryption/decryption of change and snapshot payloads.
 *
 * Extracted from Interocitor to keep the orchestrator lean.
 * Not part of the public API.
 */

import type {
  ChangeEntry,
  Manifest,
  Snapshot,
  MeshChangePayload,
  MeshSnapshotPayload,
  LocalStore,
} from "./types.ts";
import { encryptEntry, decryptEntry } from "../crypto/encryption.ts";

export interface CodecState {
  encryptionKey: CryptoKey | null;
  encrypted: boolean;
  manifest: Manifest | null;
}

async function encodeForCloud(state: CodecState, plaintext: string): Promise<string> {
  if (!state.encrypted || !state.encryptionKey) return plaintext;
  return encryptEntry(state.encryptionKey, plaintext);
}

async function decodeFromCloud(state: CodecState, data: string): Promise<string> {
  if (!state.encrypted || !state.encryptionKey) return data;
  try {
    return await decryptEntry(state.encryptionKey, data);
  } catch (err) {
    // Re-throw with explicit context. Decode errors at this layer mean the
    // active key cannot decrypt this payload — either the wrong key was
    // loaded, or the payload was written under a different key (mesh swap,
    // passphrase rotated, two devices bound to same dbName but different
    // passphrases). Caller wraps this in poisonRemote with the file path.
    const reason = err instanceof Error ? err.message : String(err);
    let keyFingerprint = "<unknown>";
    try {
      const raw = await crypto.subtle.exportKey("raw", state.encryptionKey);
      const hash = await crypto.subtle.digest("SHA-256", raw);
      const bytes = new Uint8Array(hash);
      const hex = Array.from(bytes.slice(0, 6))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      keyFingerprint = `sha256-${hex}`;
    } catch {
      /* ignore */
    }
    console.log("[interocitor:decode] decodeFromCloud() — DECRYPT FAIL", {
      keyFingerprint,
      meshId: state.manifest?.meshId,
      payloadFirst32: data.slice(0, 32),
      payloadLen: data.length,
      reason,
    });
    const e = new Error(
      `Decryption failed: payload not decryptable with the active mesh key (${reason}). The remote was likely written under a different key/mesh.`,
    );
    (e as any).cause = err;
    throw e;
  }
}

export async function assertExpectedMeshId(
  local: LocalStore,
  manifest: Manifest | null,
  meshId: string,
): Promise<void> {
  if (!meshId) {
    throw new Error("Remote mesh is missing meshId");
  }

  const manifestMeshId = manifest?.meshId;
  if (manifestMeshId && manifestMeshId !== meshId) {
    throw new Error(`Remote mesh mismatch: expected ${manifestMeshId}, got ${meshId}`);
  }

  const storedMeshId = await local.getMeta("meshId");
  if (typeof storedMeshId === "string" && storedMeshId && storedMeshId !== meshId) {
    throw new Error(`Remote mesh mismatch: expected ${storedMeshId}, got ${meshId}`);
  }

  await local.setMeta("meshId", meshId);
}

export async function encodeChangePayload(state: CodecState, entry: ChangeEntry): Promise<string> {
  const meshId = state.manifest?.meshId;
  if (!meshId) {
    throw new Error("Cannot encode change payload before manifest is loaded");
  }

  const payload: MeshChangePayload = { meshId, kind: "change", entry };
  return encodeForCloud(state, JSON.stringify(payload));
}

export async function decodeChangePayload(
  state: CodecState,
  local: LocalStore,
  data: string,
  path: string,
): Promise<ChangeEntry> {
  const decoded = await decodeFromCloud(state, data);
  const payload = JSON.parse(decoded) as MeshChangePayload;

  const payloadRecord = payload as unknown as Record<string, unknown>;
  if ("mesh" in payloadRecord && !("meshId" in payloadRecord)) {
    throw new Error(`Remote change payload has invalid shape: ${path}`);
  }

  if (payload.kind !== "change" || !payload.entry) {
    throw new Error(`Remote change payload has invalid shape: ${path}`);
  }

  await assertExpectedMeshId(local, state.manifest, String(payload.meshId || ""));
  return payload.entry;
}

export async function encodeSnapshotPayload(
  state: CodecState,
  snapshot: Snapshot,
): Promise<string> {
  const meshId = state.manifest?.meshId;
  if (!meshId) {
    throw new Error("Cannot encode snapshot payload before manifest is loaded");
  }

  const payload: MeshSnapshotPayload = { meshId, kind: "snapshot", snapshot };
  return encodeForCloud(state, JSON.stringify(payload));
}

export async function decodeSnapshotPayload(
  state: CodecState,
  local: LocalStore,
  data: string,
  path: string,
): Promise<Snapshot> {
  const decoded = await decodeFromCloud(state, data);
  const payload = JSON.parse(decoded) as MeshSnapshotPayload;

  const payloadRecord = payload as unknown as Record<string, unknown>;
  if ("mesh" in payloadRecord && !("meshId" in payloadRecord)) {
    throw new Error(`Remote snapshot payload has invalid shape: ${path}`);
  }

  if (payload.kind !== "snapshot" || !payload.snapshot) {
    throw new Error(`Remote snapshot payload has invalid shape: ${path}`);
  }

  await assertExpectedMeshId(local, state.manifest, String(payload.meshId || ""));
  return payload.snapshot;
}
