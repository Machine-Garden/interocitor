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

export async function createBootstrapManifest(ctx: ManifestContext): Promise<void> {
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

  await writeJson(ctx.adapter, p.manifestFile(manifest.generation), manifest);
  await writeJson(ctx.adapter, p.manifestPointer, {
    currentGeneration: manifest.generation,
    file: manifestFile,
  } satisfies ManifestPointer);
}

export async function loadOrCreateManifest(
  ctx: ManifestContext,
  codecState: CodecState,
  local: import('./types.ts').LocalStoreAdapter,
  poisonRemote: (error: unknown, path?: string) => Promise<Error>,
): Promise<Manifest> {
  const p = paths(ctx.remotePath);

  const globalPointer = await readJsonIfExists<ManifestPointer>(ctx.adapter, p.manifestPointer);
  if (!globalPointer) {
    await createBootstrapManifest(ctx);
  }

  const pointer = await readJson<ManifestPointer>(ctx.adapter, p.manifestPointer);
  const manifestPath = `${ctx.remotePath}/${pointer.file}`;
  const manifest = await readJson<Manifest>(ctx.adapter, manifestPath);
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
