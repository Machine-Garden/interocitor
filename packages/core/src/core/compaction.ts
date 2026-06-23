/**
 * Compaction — snapshot + manifest rotation + change file pruning.
 *
 * Concurrency note:
 * - No built-in lock or CAS on manifest pointer.
 * - Concurrent compaction can race and overwrite the pointer.
 * - Recommended: acquire a remote lease (e.g. mainline/compact-lock.json)
 *   and abort if another compactor is active, or if manifest generation
 *   changes after the lease is acquired.
 *
 * Extracted from Interocitor. Not part of the public API.
 */

import type {
  StorageAdapter,
  LocalStore,
  Manifest,
  ManifestPointer,
  Snapshot,
  Row,
  SyncEvent,
  DeviceMetadata,
} from './types.ts';
import type { HLC } from './types.ts';
import { hlcSerialize, hlcCompareStr } from './hlc.ts';
import { paths, textEncoder, textDecoder, generateId, computeContentHash, log } from './internals.ts';
import { encodeSnapshotPayload, decodeSnapshotPayload } from './codec.ts';
import type { CodecState } from './codec.ts';
import { readJsonIfExists, writeJson } from './manifest.ts';
import { hlcParse } from './hlc.ts';

export interface CompactContext {
  adapter: StorageAdapter;
  local: LocalStore;
  remotePath: string;
  manifest: Manifest;
  codecState: CodecState;
  hlc: HLC;
  deviceId: string;
  serverId: string;
  emit: (event: SyncEvent) => void;
  pull: () => Promise<void>;
  offlineGraceMs?: number;
}

async function computeGcFloor(ctx: CompactContext, nowMs: number): Promise<string> {
  const p = paths(ctx.remotePath);
  const graceMs = ctx.offlineGraceMs ?? 7 * 24 * 60 * 60_000;
  const cutoffMs = nowMs - graceMs;
  const floors: string[] = [];

  try {
    const files = await ctx.adapter.listFiles(p.devicesFolder);
    for (const file of files) {
      if (!file.name.endsWith('.json')) continue;
      const deviceId = file.name.slice(0, -'.json'.length);
      const meta = await readJsonIfExists<DeviceMetadata>(ctx.adapter, p.deviceFile(deviceId));
      if (!meta || meta.retired) continue;
      const lastSeen = Date.parse(meta.lastSeenAt || '');
      if (Number.isFinite(lastSeen) && lastSeen < cutoffMs) continue;
      // Active devices that have not yet acknowledged a watermark block
      // advancement. They are still inside the offline grace period.
      if (!meta.observedWatermarkHlc) return ctx.manifest.gcFloorHlc ?? '';
      floors.push(meta.observedWatermarkHlc);
    }
  } catch {
    return ctx.manifest.gcFloorHlc ?? '';
  }

  if (floors.length === 0) return ctx.manifest.gcFloorHlc ?? '';
  floors.sort(hlcCompareStr);
  const candidate = floors[0];
  const existing = ctx.manifest.gcFloorHlc ?? '';
  if (existing && hlcCompareStr(existing, candidate) > 0) return existing;
  return candidate;
}

export async function compact(ctx: CompactContext): Promise<Manifest> {
  const { adapter, local, remotePath, manifest, codecState, deviceId, serverId } = ctx;

  if (manifest.server.managed && deviceId !== serverId) {
    throw new Error('Compaction is allowed only for the authorized server writer');
  }

  // Ensure the compactor has merged latest remote changes before snapshotting.
  await ctx.pull();

  const p = paths(remotePath);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const gcFloorHlc = await computeGcFloor(ctx, nowDate.getTime());
  const nextEpoch = manifest.epoch + 1;
  const nextGeneration = manifest.generation + 1;
  const snapshotPath = `${p.mainlineFolder}/snapshot-${nextEpoch}-${serverId}.json`;

  // Build a full snapshot from the local store; the in-memory merge cache is partial.
  const allRows = await local.getAllRows();
  const snapshotTables: Record<string, Record<string, Row>> = {};
  for (const row of allRows) {
    if (
      gcFloorHlc
      && row._meta.deleted
      && row._meta.deletedHlc
      && hlcCompareStr(row._meta.deletedHlc, gcFloorHlc) <= 0
    ) {
      continue;
    }
    const t = row._meta.table;
    if (!snapshotTables[t]) snapshotTables[t] = {};
    snapshotTables[t][row._meta.rowId] = row;
  }

  const snapshot: Snapshot = {
    snapshotId: generateId('snap'),
    timestamp: now,
    hlc: hlcSerialize(ctx.hlc),
    epoch: nextEpoch,
    schemaVersion: manifest.schema,
    tables: snapshotTables,
  };

  const snapshotPayload = await encodeSnapshotPayload(codecState, snapshot);
  await adapter.writeFile(snapshotPath, textEncoder.encode(snapshotPayload));

  const manifestPayload = {
    generation: nextGeneration,
    parentGeneration: manifest.generation,
    writtenBy: serverId,
    writtenAt: now,
    version: 3,
    meshId: manifest.meshId,
    schema: manifest.schema,
    encrypted: manifest.encrypted,
    server: manifest.server,
    createdAt: manifest.createdAt,
    epoch: nextEpoch,
    watermarkHlc: hlcSerialize(ctx.hlc),
    snapshotPath,
    deltaPath: null,
    gcFloorHlc,
    gcEpoch: gcFloorHlc ? nextEpoch : manifest.gcEpoch,
    gcCreatedAt: gcFloorHlc ? now : manifest.gcCreatedAt,
    offlineGraceMs: ctx.offlineGraceMs,
  };

  const nextManifest: Manifest = {
    ...manifestPayload,
    contentHash: await computeContentHash(manifestPayload),
  };

  const manifestFile = `manifest-${nextGeneration}.json`;
  await writeJson(adapter, p.manifestFile(nextGeneration), nextManifest);
  await writeJson(adapter, p.manifestPointer, {
    currentGeneration: nextGeneration,
    file: manifestFile,
  } satisfies ManifestPointer);

  await local.setMeta('epoch', nextEpoch);

  // Prune all change files captured in the snapshot.
  const watermarkHlc = nextManifest.watermarkHlc;
  log('debug', 'compact() — pruning change files ≤ watermark', { watermarkHlc });
  try {
    const files = await adapter.listFiles(p.changesFolder);
    for (const file of files) {
      if (file.name === 'head.json') continue;
      const chgIdx = file.name.lastIndexOf('-chg_');
      if (chgIdx === -1) continue;
      const fileHlc = file.name.slice(0, chgIdx);
      if (hlcCompareStr(fileHlc, watermarkHlc) <= 0) {
        await adapter.deleteFile(file.path);
      }
    }
    log('debug', 'compact() — pruning complete');
  } catch (err) {
    log('warn', 'compact() — pruning failed (non-fatal, snapshot is still valid)', err);
  }

  return nextManifest;
}

export interface RehydrateContext {
  adapter: StorageAdapter;
  local: LocalStore;
  codecState: CodecState;
  manifest: Manifest | null;
  hlc: HLC;
  deviceId: string;
  tables: Record<string, Record<string, Row>>;
  knownTables: Set<string>;
  emit: (event: SyncEvent) => void;
  poisonRemote: (error: unknown, path?: string) => Promise<Error>;
  pull: () => Promise<void>;
}

/** Returns the updated HLC after rehydration. */
export async function rehydrate(ctx: RehydrateContext): Promise<HLC> {
  let hlc = ctx.hlc;

  ctx.emit({ type: 'rehydrate:start' });

  const snapshotPath = ctx.manifest?.snapshotPath;
  if (!snapshotPath) {
    ctx.emit({ type: 'rehydrate:complete', rowCount: 0 });
    await ctx.pull();
    return hlc;
  }

  try {
    const data = await ctx.adapter.readFile(snapshotPath);
    const snapshot = await decodeSnapshotPayload(ctx.codecState, ctx.local, textDecoder.decode(data), snapshotPath);

    // Clear local state
    await ctx.local.clearAll();
    ctx.tables = {};
    ctx.knownTables.clear();

    // Write snapshot rows to the local store.
    let rowCount = 0;
    for (const [tableName, rows] of Object.entries(snapshot.tables)) {
      ctx.knownTables.add(tableName);
      for (const row of Object.values(rows)) {
        await ctx.local.putRow(row);
        rowCount++;
      }
    }

    // Restore HLC
    if (snapshot.hlc) {
      hlc = hlcParse(snapshot.hlc);
      hlc.nodeId = ctx.deviceId;
    }

    await ctx.local.setMeta('epoch', snapshot.epoch);
    ctx.emit({ type: 'rehydrate:complete', rowCount });
  } catch (err) {
    ctx.emit({ type: 'decode:error', error: err instanceof Error ? err : new Error(String(err)), path: snapshotPath, context: { stage: 'rehydrate' } });
    const poisoned = await ctx.poisonRemote(err, snapshotPath);
    ctx.emit({ type: 'sync:error', error: poisoned });
    throw poisoned;
  }

  // Pull any changes since the snapshot
  await ctx.pull();
  return hlc;
}
