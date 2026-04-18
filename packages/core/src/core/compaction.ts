/**
 * Compaction — snapshot + manifest rotation + change file pruning.
 *
 * Extracted from SyncEngine. Not part of the public API.
 */

import type {
  StorageAdapter,
  LocalStoreAdapter,
  Manifest,
  ManifestPointer,
  Snapshot,
  Row,
  SyncEvent,
} from './types.ts';
import type { HLC } from './types.ts';
import { hlcSerialize, hlcCompareStr } from './hlc.ts';
import { paths, textEncoder, textDecoder, generateId, computeContentHash, log } from './internals.ts';
import { encodeSnapshotPayload, decodeSnapshotPayload } from './codec.ts';
import type { CodecState } from './codec.ts';
import { writeJson } from './manifest.ts';
import { hlcParse } from './hlc.ts';

export interface CompactContext {
  adapter: StorageAdapter;
  local: LocalStoreAdapter;
  remotePath: string;
  manifest: Manifest;
  codecState: CodecState;
  hlc: HLC;
  deviceId: string;
  serverId: string;
  emit: (event: SyncEvent) => void;
  pull: () => Promise<void>;
}

export async function compact(ctx: CompactContext): Promise<Manifest> {
  const { adapter, local, remotePath, manifest, codecState, deviceId, serverId } = ctx;

  if (manifest.server.managed && deviceId !== serverId) {
    throw new Error('Compaction is allowed only for the authorized server writer');
  }

  // Ensure the compactor has merged latest remote changes before snapshotting.
  await ctx.pull();

  const p = paths(remotePath);
  const now = new Date().toISOString();
  const nextEpoch = manifest.epoch + 1;
  const nextGeneration = manifest.generation + 1;
  const snapshotPath = `${p.mainlineFolder}/snapshot-${nextEpoch}-${serverId}.json`;

  // Build a full snapshot from IDB — the in-memory cache is partial.
  const allRows = await local.getAllRows();
  const snapshotTables: Record<string, Record<string, Row>> = {};
  for (const row of allRows) {
    if (!snapshotTables[row._table]) snapshotTables[row._table] = {};
    snapshotTables[row._table][row._rowId] = row;
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
  local: LocalStoreAdapter;
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

    // Write snapshot rows to IDB
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
    const poisoned = await ctx.poisonRemote(err, snapshotPath);
    ctx.emit({ type: 'sync:error', error: poisoned });
    throw poisoned;
  }

  // Pull any changes since the snapshot
  await ctx.pull();
  return hlc;
}
