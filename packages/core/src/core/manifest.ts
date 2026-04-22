/**
 * Manifest — reading, writing, creating, and validating cloud manifests.
 *
 * Extracted from Interocitor. Not part of the public API.
 */

import type {
  StorageAdapter,
  Manifest,
  ManifestPointer,
  DeviceMetadata,
  DatabaseSchemaDefinition,
  SyncEvent,
} from './types.ts';
import { paths, textEncoder, textDecoder, generateId, computeContentHash } from './internals.ts';
import { assertExpectedMeshId } from './codec.ts';
import type { CodecState } from './codec.ts';
import { MeshEncryptionMismatchError } from './errors.ts';

export interface ManifestContext {
  adapter: StorageAdapter;
  remotePath: string;
  serverId: string;
  serverManaged: boolean;
  deviceId: string;
  encrypted: boolean;
  schema?: DatabaseSchemaDefinition;
  emit: (event: SyncEvent) => void;
}

export async function readJson<T>(adapter: StorageAdapter, path: string): Promise<T> {
  const data = await adapter.readFile(path);
  return JSON.parse(textDecoder.decode(data)) as T;
}

export async function readJsonIfExists<T>(adapter: StorageAdapter, path: string): Promise<T | null> {
  try {
    return await readJson<T>(adapter, path);
  } catch {
    return null;
  }
}

export function assertServerAuth(manifest: { writtenBy: string }, serverId: string): void {
  if (manifest.writtenBy !== serverId) {
    throw new Error(`Unauthorized manifest writer: ${manifest.writtenBy}`);
  }
}

export async function validateManifestHash(
  manifest: { contentHash: string; [key: string]: unknown },
): Promise<void> {
  const { contentHash, ...payload } = manifest;
  const expected = await computeContentHash(payload);
  if (contentHash !== expected) {
    throw new Error('Manifest content hash mismatch');
  }
}

export async function writeJson(adapter: StorageAdapter, path: string, value: unknown): Promise<void> {
  await adapter.writeFile(path, textEncoder.encode(JSON.stringify(value, null, 2)));
}

export async function createBootstrapManifest(
  ctx: ManifestContext,
): Promise<{ pointer: ManifestPointer; manifest: Manifest }> {
  const p = paths(ctx.remotePath);
  const now = new Date().toISOString();

  const payload = {
    generation: 1,
    parentGeneration: 0,
    writtenBy: ctx.serverId,
    writtenAt: now,
    version: 3,
    meshId: generateId('mesh'),
    schema: ctx.schema?.version ?? 1,
    encrypted: ctx.encrypted,
    server: {
      managed: ctx.serverManaged,
      relayUrl: null,
      serverId: ctx.serverId,
    },
    createdAt: now,
    epoch: 0,
    watermarkHlc: '',
    snapshotPath: null,
    deltaPath: null,
  };

  const manifest: Manifest = {
    ...payload,
    contentHash: await computeContentHash(payload),
  };

  const manifestFile = `manifest-${manifest.generation}.json`;
  const pointer: ManifestPointer = {
    currentGeneration: manifest.generation,
    file: manifestFile,
  };

  await writeJson(ctx.adapter, p.manifestFile(manifest.generation), manifest);
  ctx.emit({
    type: 'trace:manifest',
    op: 'write',
    reason: 'bootstrap',
    generation: manifest.generation,
    path: p.manifestFile(manifest.generation),
  });
  await writeJson(ctx.adapter, p.manifestPointer, pointer);
  ctx.emit({
    type: 'trace:manifest',
    op: 'write',
    reason: 'bootstrap-pointer',
    generation: manifest.generation,
    path: p.manifestPointer,
  });

  return { pointer, manifest };
}

export async function loadOrCreateManifest(
  ctx: ManifestContext,
  codecState: CodecState,
  local: import('./types.ts').LocalStoreAdapter,
  poisonRemote: (error: unknown, path?: string) => Promise<Error>,
  reason: string = 'unknown',
): Promise<Manifest> {
  const p = paths(ctx.remotePath);

  ctx.emit({ type: 'trace:manifest', op: 'read', reason, path: p.manifestPointer });
  const globalPointer = await readJsonIfExists<ManifestPointer>(ctx.adapter, p.manifestPointer);

  let pointer: ManifestPointer;
  let manifest: Manifest;
  if (!globalPointer) {
    ctx.emit({ type: 'trace:manifest', op: 'bootstrap-create', reason, path: p.manifestPointer });
    const bootstrap = await createBootstrapManifest(ctx);
    // Skip the read-after-write — we just minted both files in this process,
    // they are exactly what's on disk. No GETs needed.
    pointer = bootstrap.pointer;
    manifest = bootstrap.manifest;
  } else {
    pointer = globalPointer;
    const manifestPath = `${ctx.remotePath}/${pointer.file}`;
    ctx.emit({ type: 'trace:manifest', op: 'read', reason, path: manifestPath, generation: pointer.currentGeneration });
    manifest = await readJson<Manifest>(ctx.adapter, manifestPath);
  }
  const manifestPath = `${ctx.remotePath}/${pointer.file}`;
  await validateManifestHash(manifest as unknown as { contentHash: string; [key: string]: unknown });
  try {
    await assertExpectedMeshId(local, codecState.manifest, manifest.meshId);
  } catch (err) {
    throw await poisonRemote(err, manifestPath);
  }

  if (manifest.version !== 3) {
    throw new Error(`Unsupported manifest version ${manifest.version} (expected 3).`);
  }
  if (ctx.schema && manifest.schema !== ctx.schema.version) {
    ctx.emit({ type: 'schema:mismatch', local: ctx.schema.version, remote: manifest.schema });
    throw new Error(`Schema version mismatch: local=${ctx.schema.version}, remote=${manifest.schema}`);
  }
  if (manifest.server.managed) {
    assertServerAuth(manifest, ctx.serverId);
  }

  // Encryption-mode parity check.
  //
  // The remote manifest pins the mesh's encryption mode at bootstrap.
  // If the engine reconnects with a different `encrypted` flag (typical
  // app bug: passphrase loaded asynchronously, so the first session
  // wrote plaintext and the next session derives a key and tries to
  // decrypt), every change file would fail decode and poison the remote.
  //
  // Surface this as an actionable error *before* any decode runs and
  // *without* poisoning. The remote is not corrupt — the local config
  // is wrong.
  if (typeof manifest.encrypted === 'boolean' && manifest.encrypted !== ctx.encrypted) {
    throw new MeshEncryptionMismatchError(manifest.encrypted, ctx.encrypted);
  }

  return manifest;
}

export async function upsertDeviceMetadata(
  adapter: StorageAdapter,
  remotePath: string,
  deviceId: string,
  opts?: { displayName?: string; deviceType?: import('./types.ts').DeviceType },
): Promise<void> {
  const p = paths(remotePath);
  const now = new Date().toISOString();
  const existing = await readJsonIfExists<DeviceMetadata>(adapter, p.deviceFile(deviceId));
  const next: DeviceMetadata = {
    deviceId,
    registeredAt: existing?.registeredAt ?? now,
    lastSeenAt: now,
    userId: existing?.userId,
    name: existing?.name,
    displayName: opts?.displayName ?? existing?.displayName,
    deviceType: opts?.deviceType ?? existing?.deviceType,
    retired: existing?.retired,
  };
  await writeJson(adapter, p.deviceFile(deviceId), next);
}
