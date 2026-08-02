/**
 * Pull — download remote changes and merge into local state.
 *
 * Extracted from Interocitor. Not part of the public API.
 */

import type {
  StorageAdapter,
  LocalStore,
  Row,
  Op,
  ChangesHead,
  SyncEvent,
  DatabaseSchemaDefinition,
} from './types.ts';
import type { HLC } from './types.ts';
import { hlcParse, hlcReceive, hlcCompareStr, hlcSerialize } from './hlc.ts';
import { applyChangeEntry } from './crdt.ts';
import { paths, textDecoder, log } from './internals.ts';
import { decodeChangePayload } from './codec.ts';
import type { CodecState } from './codec.ts';
import { readJsonIfExists } from './manifest.ts';

const SEEN_CHANGE_FILES_META_KEY = 'seenChangeFiles';
const WRITER_FRONTIERS_META_KEY = 'writerFrontiers';

export type SeenChangeFiles = Set<string>;
export type WriterFrontiers = Record<string, string>;

export function parseSeenChangeFiles(value: unknown): SeenChangeFiles | null {
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) return null;
  return new Set(value);
}

export function parseWriterFrontiers(value: unknown): WriterFrontiers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const frontiers: WriterFrontiers = {};
  for (const [writerId, hlc] of Object.entries(value)) {
    if (typeof hlc === 'string' && hlc) frontiers[writerId] = hlc;
  }
  return frontiers;
}

export interface PullContext {
  adapter: StorageAdapter;
  local: LocalStore;
  remotePath: string;
  codecState: CodecState;
  hlc: HLC;
  deviceId: string;
  tables: Record<string, Record<string, Row>>;
  knownTables: Set<string>;
  schema?: DatabaseSchemaDefinition;
  emit: (event: SyncEvent) => void;
  ensureRowsCached: (ops: Op[]) => Promise<void>;
  poisonRemote: (error: unknown, path?: string) => Promise<Error>;
  loadOrCreateManifest: () => Promise<void>;
}

function emitAffectedRows(
  affected: Row[],
  knownTables: Set<string>,
  emit: (event: SyncEvent) => void,
): void {
  for (const row of affected) {
    knownTables.add(row._meta.table);
    if (row._meta.deleted) {
      emit({ type: 'delete', table: row._meta.table, rowId: row._meta.rowId });
    } else {
      emit({ type: 'change', table: row._meta.table, rowId: row._meta.rowId, row });
    }
  }
}

export function changeFileHlc(name: string): string | null {
  const marker = name.lastIndexOf('-chg_');
  return marker === -1 ? null : name.slice(0, marker);
}

export function changeFileIsUnseen(name: string, seenChangeFiles: SeenChangeFiles): boolean {
  return changeFileHlc(name) !== null && !seenChangeFiles.has(name);
}

function compareChangeFiles(left: { name: string }, right: { name: string }): number {
  const leftHlc = changeFileHlc(left.name);
  const rightHlc = changeFileHlc(right.name);
  if (leftHlc && rightHlc) {
    // Merge order is protocol data, not a display order. In particular,
    // ``localeCompare`` can place same-tick device IDs differently across
    // runtimes and make any order-sensitive custom merge produce different values.
    // Keep malformed names on the normal per-file error path below.
    const compared = hlcCompareStr(leftHlc, rightHlc);
    if (Number.isFinite(compared) && compared !== 0) return compared;
  }
  // JavaScript relational string comparison is a stable UTF-16 code-unit
  // tiebreaker, unlike localeCompare.
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

/** Returns the updated HLC after pull. */
export async function pull(ctx: PullContext): Promise<HLC> {
  const { adapter, local, remotePath, codecState, tables, knownTables, emit } = ctx;
  let hlc = ctx.hlc;

  log('debug', 'pull() — start');
  emit({ type: 'sync:start' });

  try {
    await ctx.loadOrCreateManifest();
    const p = paths(remotePath);

    const legacyGlobalHighWaterRaw = await local.getMeta('cursor');
    const legacyGlobalHighWaterHlc =
      typeof legacyGlobalHighWaterRaw === 'string' ? legacyGlobalHighWaterRaw : '';

    // head.json remains a cheap invalidation hint for adapters with push
    // support, but it is not an authoritative pull cursor. HLCs are globally
    // ordered while publication is not: a device may flush an older queued
    // HLC after another device has advanced the global head. The folder list
    // is therefore required for correctness.
    const head = await readJsonIfExists<ChangesHead>(adapter, p.changesHead);
    emit({
      type: 'trace:head',
      op: 'read',
      reason: 'pull-fast-path',
      path: p.changesHead,
      priorHlc: head?.latestHlc ?? null,
    });
    // List the flat changes folder once.
    let files;
    try {
      files = await adapter.listFiles(p.changesFolder);
    } catch {
      log('debug', 'pull() — changes folder not found, nothing to merge');
      emit({ type: 'sync:complete', entriesMerged: 0 });
      return hlc;
    }
    files.sort(compareChangeFiles);

    let totalMerged = 0;
    let latestMergedHlc = legacyGlobalHighWaterHlc;
    const storedSeenChangeFiles = parseSeenChangeFiles(
      await local.getMeta(SEEN_CHANGE_FILES_META_KEY),
    );
    // A scalar cursor from an older release cannot prove which concrete files
    // were observed. Start empty once after upgrade and safely replay retained
    // change files; CRDT application is idempotent.
    const seenChangeFiles: SeenChangeFiles = storedSeenChangeFiles ?? new Set();
    const hasExactObservationHistory = storedSeenChangeFiles !== null;
    const writerFrontiers = parseWriterFrontiers(await local.getMeta(WRITER_FRONTIERS_META_KEY));

    for (const file of files) {
      if (file.name === 'head.json') continue;

      try {
        const chgIdx = file.name.lastIndexOf('-chg_');
        if (chgIdx === -1) continue;
        const fileHlc = file.name.slice(0, chgIdx);
        const gcFloorHlc = codecState.manifest?.gcFloorHlc ?? '';
        if (gcFloorHlc && hlcCompareStr(fileHlc, gcFloorHlc) <= 0) continue;
        const writerId = hlcParse(fileHlc).nodeId;
        const writerFrontierHlc = writerFrontiers[writerId];
        if (seenChangeFiles.has(file.name)) continue;

        const raw = textDecoder.decode(await adapter.readFile(file.path));
        const entry = await decodeChangePayload(codecState, local, raw, file.path);

        const remoteHlc = hlcParse(entry.hlc);
        hlc = hlcReceive(hlc, remoteHlc);

        await ctx.ensureRowsCached(entry.ops);
        const affected = applyChangeEntry(tables, entry, codecState.manifest?.schema ?? 1, ctx.schema);
        if (affected.length > 0) {
          await local.putRows(affected);
          totalMerged += affected.length;
          emitAffectedRows(affected, knownTables, emit);
        }

        if (!latestMergedHlc || hlcCompareStr(entry.hlc, latestMergedHlc) > 0) {
          latestMergedHlc = entry.hlc;
        }
        const behindWriterFrontier = writerFrontierHlc
          ? hlcCompareStr(fileHlc, writerFrontierHlc) <= 0
          : false;
        const behindLegacyGlobalHighWater = legacyGlobalHighWaterHlc
          ? hlcCompareStr(fileHlc, legacyGlobalHighWaterHlc) <= 0
          : false;
        if (hasExactObservationHistory && (behindWriterFrontier || behindLegacyGlobalHighWater)) {
          emit({
            type: 'sync:late-change',
            writerId,
            changeHlc: fileHlc,
            fileName: file.name,
            relation: behindWriterFrontier ? 'behind-writer-frontier' : 'behind-global-high-water',
            writerFrontierHlc,
            legacyGlobalHighWaterHlc: legacyGlobalHighWaterHlc || undefined,
          });
        }
        if (!writerFrontierHlc || hlcCompareStr(fileHlc, writerFrontierHlc) > 0) {
          writerFrontiers[writerId] = fileHlc;
        }
        seenChangeFiles.add(file.name);
      } catch (err) {
        emit({ type: 'decode:error', error: err instanceof Error ? err : new Error(String(err)), path: file.path, context: { stage: 'pull', name: file.name } });
        throw await ctx.poisonRemote(err, file.path);
      }
    }

    if (latestMergedHlc && latestMergedHlc !== legacyGlobalHighWaterHlc) {
      await local.setMeta('cursor', latestMergedHlc);
    }
    // A listing is explicitly allowed to be non-monotonic, so absence from
    // this response cannot retire proof that a file was already observed.
    // Only the manifest GC floor is an authoritative retirement boundary.
    const observationGcFloorHlc = codecState.manifest?.gcFloorHlc ?? '';
    const retainedSeenChangeFiles = [...seenChangeFiles]
      .filter(name => {
        if (!observationGcFloorHlc) return true;
        const fileHlc = changeFileHlc(name);
        return fileHlc === null || hlcCompareStr(fileHlc, observationGcFloorHlc) > 0;
      })
      .sort();
    await local.setMeta(SEEN_CHANGE_FILES_META_KEY, retainedSeenChangeFiles);
    await local.setMeta(WRITER_FRONTIERS_META_KEY, writerFrontiers);

    await local.setMeta('hlc', hlcSerialize(hlc));
    log('debug', 'pull() — complete', { totalMerged });
    emit({ type: 'sync:complete', entriesMerged: totalMerged });
    return hlc;
  } catch (err) {
    log('error', 'pull() — failed', err);
    emit({ type: 'sync:error', error: err as Error });
    throw err;
  }
}
