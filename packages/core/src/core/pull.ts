// compass: interocitor.mailbox-sync.change-transfer

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
  ChangeObservation,
} from "./types.ts";
import type { HLC } from "./types.ts";
import { hlcParse, hlcReceive, hlcSerialize } from "./hlc.ts";
import { applyChangeEntry } from "./crdt.ts";
import { paths, textDecoder, log } from "./internals.ts";
import { decodeChangePayload } from "./codec.ts";
import type { CodecState } from "./codec.ts";
import { readJsonIfExists } from "./manifest.ts";
import { isRemoteAccessError } from "./errors.ts";
import {
  ChangeObservationLedger,
  changeFileHlc,
  compareChangeFiles,
} from "./change-observation.ts";
import { captureRowsForOps, cloneChangeEntry, effectsFromCapturedRows } from "./change-effects.ts";

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
  observeChange?: (observation: ChangeObservation) => void;
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
      emit({ type: "delete", table: row._meta.table, rowId: row._meta.rowId });
    } else {
      emit({ type: "change", table: row._meta.table, rowId: row._meta.rowId, row });
    }
  }
}

/** Returns the updated HLC after pull. */
/** How many change-file bodies to keep in flight ahead of the one being applied. */
const PULL_PREFETCH_WINDOW = 4;

export async function pull(ctx: PullContext): Promise<HLC> {
  const { adapter, local, remotePath, codecState, tables, knownTables, emit } = ctx;
  let hlc = ctx.hlc;

  log("debug", "pull() — start");
  emit({ type: "sync:start" });

  try {
    await ctx.loadOrCreateManifest();
    const p = paths(remotePath);

    const observation = await ChangeObservationLedger.load(local);

    // head.json remains a cheap invalidation hint for adapters with push
    // support, but it is not an authoritative pull cursor. HLCs are globally
    // ordered while publication is not: a device may flush an older queued
    // HLC after another device has advanced the global head. The folder list
    // is therefore required for correctness.
    const head = await readJsonIfExists<ChangesHead>(adapter, p.changesHead);
    emit({
      type: "trace:head",
      op: "read",
      reason: "pull-fast-path",
      path: p.changesHead,
      priorHlc: head?.latestHlc ?? null,
    });
    // List the flat changes folder once.
    let files;
    try {
      files = await adapter.listFiles(p.changesFolder);
    } catch (err) {
      // An access decision from the remote must reach the application with
      // its status intact; only a genuinely missing folder is "nothing to
      // merge".
      if (isRemoteAccessError(err)) throw err;
      log("debug", "pull() — changes folder not found, nothing to merge");
      emit({ type: "sync:complete", entriesMerged: 0 });
      return hlc;
    }
    files.sort(compareChangeFiles);

    // Change files are applied strictly in order, but their bodies can be
    // fetched ahead of time. Keep a few reads in flight so remote latency is
    // paid once per group instead of once per file. A listing may repeat a
    // name; each file is read and applied once.
    const seenNames = new Set<string>();
    const unseen = files.filter((file) => {
      if (file.name === "head.json" || seenNames.has(file.name)) return false;
      seenNames.add(file.name);
      return changeFileHlc(file.name) !== null && observation.isUnseenChange(file.name);
    });
    const reads: (Promise<Uint8Array> | undefined)[] = [];
    const prefetch = (index: number): void => {
      if (index >= unseen.length || reads[index]) return;
      const read = adapter.readFile(unseen[index]!.path);
      // Failures surface when the file's turn comes; never as an unhandled rejection.
      read.catch(() => {});
      reads[index] = read;
    };
    for (let i = 0; i < PULL_PREFETCH_WINDOW; i++) prefetch(i);

    let totalMerged = 0;
    for (let index = 0; index < unseen.length; index++) {
      const file = unseen[index]!;
      prefetch(index + PULL_PREFETCH_WINDOW);

      try {
        const raw = textDecoder.decode(await reads[index]!);
        reads[index] = undefined;
        const entry = await decodeChangePayload(codecState, local, raw, file.path);

        const remoteHlc = hlcParse(entry.hlc);
        hlc = hlcReceive(hlc, remoteHlc);

        await ctx.ensureRowsCached(entry.ops);
        const captured = ctx.observeChange ? captureRowsForOps(tables, entry.ops) : null;
        const affected = applyChangeEntry(
          tables,
          entry,
          codecState.manifest?.schema ?? 1,
          ctx.schema,
        );
        if (affected.length > 0) {
          await local.putRows(affected);
          totalMerged += affected.length;
          emitAffectedRows(affected, knownTables, emit);
        }
        if (ctx.observeChange && captured) {
          ctx.observeChange({
            source: "remote",
            observedAt: Date.now(),
            fileName: file.name,
            change: cloneChangeEntry(entry),
            effects: effectsFromCapturedRows(tables, captured),
          });
        }

        const lateChange = observation.observe(file.name, entry.hlc);
        if (lateChange) {
          emit({
            type: "sync:late-change",
            ...lateChange,
          });
        }
      } catch (err) {
        emit({
          type: "decode:error",
          error: err instanceof Error ? err : new Error(String(err)),
          path: file.path,
          context: { stage: "pull", name: file.name },
        });
        throw await ctx.poisonRemote(err, file.path);
      }
    }

    // A listing is explicitly allowed to be non-monotonic, so absence from
    // this response cannot retire proof that a file was already observed.
    await observation.persist(local);

    await local.setMeta("hlc", hlcSerialize(hlc));
    log("debug", "pull() — complete", { totalMerged });
    emit({ type: "sync:complete", entriesMerged: totalMerged });
    return hlc;
  } catch (err) {
    log("error", "pull() — failed", err);
    emit({ type: "sync:error", error: err as Error });
    throw err;
  }
}
