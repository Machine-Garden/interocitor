/**
 * Pull — download remote changes and merge into local state.
 *
 * Extracted from Interocitor. Not part of the public API.
 */

import type {
  StorageAdapter,
  LocalStoreAdapter,
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

export interface PullContext {
  adapter: StorageAdapter;
  local: LocalStoreAdapter;
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

/** Returns the updated HLC after pull. */
export async function pull(ctx: PullContext): Promise<HLC> {
  const { adapter, local, remotePath, codecState, tables, knownTables, emit } = ctx;
  let hlc = ctx.hlc;

  log('debug', 'pull() — start');
  emit({ type: 'sync:start' });

  try {
    await ctx.loadOrCreateManifest();
    const p = paths(remotePath);

    const cursorRaw = await local.getMeta('cursor');
    const cursor = typeof cursorRaw === 'string' ? cursorRaw : '';

    // Fast path: if global head hasn't advanced past cursor, skip listing.
    const head = await readJsonIfExists<ChangesHead>(adapter, p.changesHead);
    emit({
      type: 'trace:head',
      op: 'read',
      reason: 'pull-fast-path',
      path: p.changesHead,
      priorHlc: head?.latestHlc ?? null,
    });
    if (head?.latestHlc && cursor && hlcCompareStr(head.latestHlc, cursor) <= 0) {
      log('debug', 'pull() — head unchanged, skipping');
      emit({
        type: 'trace:head',
        op: 'skip-no-change',
        reason: 'pull-fast-path',
        path: p.changesHead,
        priorHlc: head.latestHlc,
        nextHlc: cursor,
      });
      emit({ type: 'sync:complete', entriesMerged: 0 });
      return hlc;
    }

    // List the flat changes folder once.
    let files;
    try {
      files = await adapter.listFiles(p.changesFolder);
    } catch {
      log('debug', 'pull() — changes folder not found, nothing to merge');
      emit({ type: 'sync:complete', entriesMerged: 0 });
      return hlc;
    }
    files.sort((a, b) => a.name.localeCompare(b.name));

    let totalMerged = 0;
    let latestMergedHlc = cursor;

    for (const file of files) {
      if (file.name === 'head.json') continue;

      try {
        const chgIdx = file.name.lastIndexOf('-chg_');
        if (chgIdx === -1) continue;
        const fileHlc = file.name.slice(0, chgIdx);
        if (cursor && hlcCompareStr(fileHlc, cursor) <= 0) continue;

        const raw = textDecoder.decode(await adapter.readFile(file.path));
        const entry = await decodeChangePayload(codecState, local, raw, file.path);
        if (cursor && hlcCompareStr(entry.hlc, cursor) <= 0) continue;

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
      } catch (err) {
        emit({ type: 'decode:error', error: err instanceof Error ? err : new Error(String(err)), path: file.path, context: { stage: 'pull', name: file.name } });
        throw await ctx.poisonRemote(err, file.path);
      }
    }

    if (latestMergedHlc && latestMergedHlc !== cursor) {
      await local.setMeta('cursor', latestMergedHlc);
    }

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
