/**
 * Codec — encryption/decryption of change and snapshot payloads.
 *
 * Extracted from SyncEngine to keep the orchestrator lean.
 * Not part of the public API.
 */

import type {
  ChangeEntry,
  Manifest,
  Snapshot,
  MeshChangePayload,
  MeshSnapshotPayload,
  LocalStoreAdapter,
} from './types.ts';
import { encryptEntry, decryptEntry } from '../crypto/encryption.ts';

export interface CodecState {
  encryptionKey: CryptoKey | null;
  encrypted: boolean;
  manifest: Manifest | null;
}

export async function encodeForCloud(state: CodecState, plaintext: string): Promise<string> {
  if (!state.encrypted || !state.encryptionKey) return plaintext;
  return encryptEntry(state.encryptionKey, plaintext);
}

export async function decodeFromCloud(state: CodecState, data: string): Promise<string> {
  if (!state.encrypted || !state.encryptionKey) return data;
  return decryptEntry(state.encryptionKey, data);
}

export async function assertExpectedMeshId(
  local: LocalStoreAdapter,
  manifest: Manifest | null,
  meshId: string,
): Promise<void> {
  if (!meshId) {
    throw new Error('Remote mesh is missing meshId');
  }

  const manifestMeshId = manifest?.meshId;
  if (manifestMeshId && manifestMeshId !== meshId) {
    throw new Error(`Remote mesh mismatch: expected ${manifestMeshId}, got ${meshId}`);
  }

  const storedMeshId = await local.getMeta('meshId');
  if (typeof storedMeshId === 'string' && storedMeshId && storedMeshId !== meshId) {
    throw new Error(`Remote mesh mismatch: expected ${storedMeshId}, got ${meshId}`);
  }

  await local.setMeta('meshId', meshId);
}

export async function encodeChangePayload(state: CodecState, entry: ChangeEntry): Promise<string> {
  const meshId = state.manifest?.meshId;
  if (!meshId) {
    throw new Error('Cannot encode change payload before manifest is loaded');
  }

  const payload: MeshChangePayload = { meshId, kind: 'change', entry };
  return encodeForCloud(state, JSON.stringify(payload));
}

export async function decodeChangePayload(
  state: CodecState,
  local: LocalStoreAdapter,
  data: string,
  path: string,
): Promise<ChangeEntry> {
  const decoded = await decodeFromCloud(state, data);
  const payload = JSON.parse(decoded) as MeshChangePayload;

  if (payload.kind !== 'change' || !payload.entry) {
    throw new Error(`Remote change payload has invalid shape: ${path}`);
  }

  await assertExpectedMeshId(local, state.manifest, String(payload.meshId || ''));
  return payload.entry;
}

export async function encodeSnapshotPayload(state: CodecState, snapshot: Snapshot): Promise<string> {
  const meshId = state.manifest?.meshId;
  if (!meshId) {
    throw new Error('Cannot encode snapshot payload before manifest is loaded');
  }

  const payload: MeshSnapshotPayload = { meshId, kind: 'snapshot', snapshot };
  return encodeForCloud(state, JSON.stringify(payload));
}

export async function decodeSnapshotPayload(
  state: CodecState,
  local: LocalStoreAdapter,
  data: string,
  path: string,
): Promise<Snapshot> {
  const decoded = await decodeFromCloud(state, data);
  const payload = JSON.parse(decoded) as MeshSnapshotPayload;

  if (payload.kind !== 'snapshot' || !payload.snapshot) {
    throw new Error(`Remote snapshot payload has invalid shape: ${path}`);
  }

  await assertExpectedMeshId(local, state.manifest, String(payload.meshId || ''));
  return payload.snapshot;
}
