/**
 * Compaction — snapshot publication and manifest rotation.
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

import type { StorageAdapter, LocalStore, Manifest, ManifestPointer, Snapshot, Row, SyncEvent, RetentionPolicy } from './types.ts';
import type { HLC } from './types.ts';
import { hlcSerialize } from './hlc.ts';
import { paths, textEncoder, textDecoder, generateId, computeContentHash } from './internals.ts';
import { encodeSnapshotPayload, decodeSnapshotPayload } from './codec.ts';
import type { CodecState } from './codec.ts';
import { writeJson } from './manifest.ts';
import { hlcParse } from './hlc.ts';
import { ChangeObservationLedger } from './change-observation.ts';

export interface CompactContext {
  adapter: StorageAdapter;
  local: LocalStore;
  remotePath: string;
  manifest: Manifest;
  codecState: CodecState;
  hlc: HLC;
  deviceId: string;
  serverId: string;
  retention: RetentionPolicy;
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
  const observation = await ChangeObservationLedger.load(local);
  const coveredChangeFiles = observation.capturedChangeFileNames();

  const p = paths(remotePath);
  const now = new Date().toISOString();
  const nextEpoch = manifest.epoch + 1;
  const nextGeneration = manifest.generation + 1;
  const snapshotPath = `${p.mainlineFolder}/snapshot-${nextEpoch}-${serverId}.json`;

  // Build a full snapshot from the local store; the in-memory merge cache is partial.
  const allRows = await local.getAllRows();
  const snapshotTables: Record<string, Record<string, Row>> = {};
  for (const row of allRows) {
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
    coveredChangeFiles,
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
    retention: ctx.retention,
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

  // Snapshot publication is authoritative even if cleanup is interrupted.
  // Delete only the exact files represented by this snapshot; a change that
  // appeared after capture remains available for the catch-up pull.
  await Promise.allSettled(coveredChangeFiles.map((fileName) => adapter.deleteFile(`${p.changesFolder}/${fileName}`)));
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
  /** Local-only records that snapshot replacement must not erase. */
  preservedMeta?: Readonly<Record<string, unknown>>;
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

    let rowCount = 0;
    await ChangeObservationLedger.restoreSnapshot(ctx.local, snapshot.hlc, snapshot.coveredChangeFiles ?? [], async () => {
      await ctx.local.clearAll();
      for (const [key, value] of Object.entries(ctx.preservedMeta ?? {})) {
        if (value !== undefined) await ctx.local.setMeta(key, value);
      }
      ctx.tables = {};
      ctx.knownTables.clear();

      for (const [tableName, rows] of Object.entries(snapshot.tables)) {
        ctx.knownTables.add(tableName);
        for (const row of Object.values(rows)) {
          await ctx.local.putRow(row);
          rowCount++;
        }
      }
    });

    // Restore HLC
    if (snapshot.hlc) {
      hlc = hlcParse(snapshot.hlc);
      hlc.nodeId = ctx.deviceId;
    }

    await ctx.local.setMeta('epoch', snapshot.epoch);
    ctx.emit({ type: 'rehydrate:complete', rowCount });
  } catch (err) {
    ctx.emit({
      type: 'decode:error',
      error: err instanceof Error ? err : new Error(String(err)),
      path: snapshotPath,
      context: { stage: 'rehydrate' },
    });
    const poisoned = await ctx.poisonRemote(err, snapshotPath);
    ctx.emit({ type: 'sync:error', error: poisoned });
    throw poisoned;
  }

  // Pull any changes since the snapshot
  await ctx.pull();
  return hlc;
}
