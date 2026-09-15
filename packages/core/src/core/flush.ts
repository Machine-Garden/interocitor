// compass: interocitor.mailbox-sync.change-transfer

/**
 * Flush — push queued local outbox entries to remote cloud.
 *
 * Extracted from Interocitor. Not part of the public API.
 */

import type { StorageAdapter, LocalStore, ChangeEntry, ChangesHead, SyncEvent } from "./types.ts";
import { hlcCompareStr } from "./hlc.ts";
import { paths, textEncoder, textDecoder, type LogLevel } from "./internals.ts";
import { encodeChangePayload } from "./codec.ts";
import type { CodecState } from "./codec.ts";
import { upsertDeviceMetadata } from "./manifest.ts";
import { changeFileName, recordFlushedChanges } from "./change-observation.ts";

export interface FlushReplicaTarget {
  adapter: StorageAdapter;
  remotePath: string;
}

/**
 * Level-gated logger supplied by the engine.
 *
 * Flush runs as free functions with no engine handle, so tracing is injected
 * rather than written straight to the console: an unconditional `console.log`
 * here ignores the caller's `logLevel` and chatters on every write. Defaults
 * to a no-op so non-engine callers stay silent.
 */
export type FlushLogger = (level: LogLevel, ...args: unknown[]) => void;

const noopLog: FlushLogger = () => {};

async function flushToAdapter(
  adapter: StorageAdapter,
  remotePath: string,
  entries: ChangeEntry[],
  isPrimary: boolean,
  codecState: CodecState,
  deviceId: string,
  emit: (event: SyncEvent) => void = () => {},
  log: FlushLogger = noopLog,
): Promise<void> {
  const p = paths(remotePath);
  await adapter.ensureFolder(p.changesFolder);

  let lastWrittenHlc = "";

  for (const entry of entries) {
    const fileName = changeFileName(entry);
    const payload = await encodeChangePayload(codecState, entry);
    log("debug", "flush() — change file", {
      path: p.changeFile(fileName),
      deviceId,
      isPrimary,
      entryId: entry.id,
      hlc: entry.hlc,
    });
    await adapter.writeFile(p.changeFile(fileName), textEncoder.encode(payload));

    if (!lastWrittenHlc || hlcCompareStr(entry.hlc, lastWrittenHlc) > 0) {
      lastWrittenHlc = entry.hlc;
    }
  }

  // Update global head — monotonic diagnostic hint, never coverage proof.
  // Tracing rules (see SyncEvent `trace:head`):
  //  - read → emit { op: 'read', reason: 'flush', priorHlc }
  //  - write strictly forward → emit { op: 'write', priorHlc, nextHlc }
  //  - write where nextHlc <= priorHlc → emit
  //    { op: 'write', regressed: true } AND skip the writeFile
  //    (regression = bug signal; never let head go backwards on disk).
  //  - no entries to flush → emit { op: 'skip-no-change' } and don't touch head.
  if (!lastWrittenHlc) {
    emit({
      type: "trace:head",
      op: "skip-no-change",
      reason: "flush",
      path: p.changesHead,
      nextHlc: null,
    });
    if (isPrimary) {
      await upsertDeviceMetadata(adapter, remotePath, deviceId);
    }
    return;
  }

  const readHeadIfExists = async (): Promise<ChangesHead | null> => {
    try {
      const data = await adapter.readFile(p.changesHead);
      return JSON.parse(textDecoder.decode(data)) as ChangesHead;
    } catch {
      return null;
    }
  };

  const priorHead = await readHeadIfExists();
  const priorHlc = priorHead?.latestHlc ?? null;
  emit({
    type: "trace:head",
    op: "read",
    reason: "flush",
    path: p.changesHead,
    priorHlc,
  });

  // Already-current short-circuit. Nothing to write — head already at or
  // beyond what we just wrote (replica catching up, retried flush, etc.).
  if (priorHlc && hlcCompareStr(priorHlc, lastWrittenHlc) >= 0) {
    emit({
      type: "trace:head",
      op: "skip-no-change",
      reason: "flush",
      path: p.changesHead,
      priorHlc,
      nextHlc: lastWrittenHlc,
    });
    if (isPrimary) {
      await upsertDeviceMetadata(adapter, remotePath, deviceId);
    }
    return;
  }

  // Defensive: if priorHlc somehow > our lastWritten (shouldn't happen
  // after the >= short-circuit) flag as regression and don't write.
  const regressed = priorHlc !== null && hlcCompareStr(priorHlc, lastWrittenHlc) > 0;
  const bestHlc = regressed ? priorHlc : lastWrittenHlc;

  emit({
    type: "trace:head",
    op: "write",
    reason: "flush",
    path: p.changesHead,
    priorHlc,
    nextHlc: bestHlc,
    regressed,
  });

  if (!regressed) {
    log("debug", "flush() — head", {
      path: p.changesHead,
      deviceId,
      isPrimary,
      priorHlc,
      nextHlc: bestHlc,
    });
    await adapter.writeFile(
      p.changesHead,
      textEncoder.encode(JSON.stringify({ latestHlc: bestHlc } satisfies ChangesHead, null, 2)),
    );
  }

  if (isPrimary) {
    await upsertDeviceMetadata(adapter, remotePath, deviceId);
  }
}

/** Record exact local receipts, then publish to the authoritative remote. */
export async function flushPrimary(
  adapter: StorageAdapter,
  local: LocalStore,
  remotePath: string,
  entries: ChangeEntry[],
  codecState: CodecState,
  deviceId: string,
  emit: (event: SyncEvent) => void = () => {},
  replicas: readonly FlushReplicaTarget[] = [],
  onReplicaError: (adapterName: string, error: unknown) => void = () => {},
  log: FlushLogger = noopLog,
): Promise<void> {
  // A receipt failure prevents publication. A later remote failure is safe:
  // sync-engine requeues the same immutable identities for retry.
  await recordFlushedChanges(local, entries);
  await flushToAdapter(adapter, remotePath, entries, true, codecState, deviceId, emit, log);

  for (const replica of replicas) {
    try {
      if (!replica.adapter.isAuthenticated()) await replica.adapter.authenticate();
      await flushReplica(replica.adapter, replica.remotePath, entries, codecState, deviceId, log);
    } catch (error) {
      onReplicaError(replica.adapter.name, error);
    }
  }
}

/** Replicas mirror bytes but never advance authoritative local observation. */
async function flushReplica(
  adapter: StorageAdapter,
  remotePath: string,
  entries: ChangeEntry[],
  codecState: CodecState,
  deviceId: string,
  log: FlushLogger = noopLog,
): Promise<void> {
  await flushToAdapter(adapter, remotePath, entries, false, codecState, deviceId, () => {}, log);
}
