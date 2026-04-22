/**
 * Flush — push queued local outbox entries to remote cloud.
 *
 * Extracted from Interocitor. Not part of the public API.
 */

import type {
  StorageAdapter,
  ChangeEntry,
  ChangesHead,
  SyncEvent,
} from './types.ts';
import { hlcCompareStr } from './hlc.ts';
import { paths, textEncoder, textDecoder } from './internals.ts';
import { encodeChangePayload } from './codec.ts';
import type { CodecState } from './codec.ts';
import { upsertDeviceMetadata } from './manifest.ts';

export async function flushToAdapter(
  adapter: StorageAdapter,
  remotePath: string,
  entries: ChangeEntry[],
  isPrimary: boolean,
  codecState: CodecState,
  deviceId: string,
  emit: (event: SyncEvent) => void = () => {},
): Promise<void> {
  const p = paths(remotePath);
  await adapter.ensureFolder(p.changesFolder);

  let lastWrittenHlc = '';

  for (const entry of entries) {
    const fileName = `${entry.hlc}-${entry.id}.json`;
    const payload = await encodeChangePayload(codecState, entry);
    await adapter.writeFile(p.changeFile(fileName), textEncoder.encode(payload));

    if (!lastWrittenHlc || hlcCompareStr(entry.hlc, lastWrittenHlc) > 0) {
      lastWrittenHlc = entry.hlc;
    }
  }

  // Update global head — monotonic HLC hint for fast poll skipping.
  // Tracing rules (see SyncEvent `trace:head`):
  //  - read → emit { op: 'read', reason: 'flush', priorHlc }
  //  - write strictly forward → emit { op: 'write', priorHlc, nextHlc }
  //  - write where nextHlc <= priorHlc → emit
  //    { op: 'write', regressed: true } AND skip the writeFile
  //    (regression = bug signal; never let head go backwards on disk).
  //  - no entries to flush → emit { op: 'skip-no-change' } and don't touch head.
  if (!lastWrittenHlc) {
    emit({
      type: 'trace:head',
      op: 'skip-no-change',
      reason: 'flush',
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
    type: 'trace:head',
    op: 'read',
    reason: 'flush',
    path: p.changesHead,
    priorHlc,
  });

  // Already-current short-circuit. Nothing to write — head already at or
  // beyond what we just wrote (replica catching up, retried flush, etc.).
  if (priorHlc && hlcCompareStr(priorHlc, lastWrittenHlc) >= 0) {
    emit({
      type: 'trace:head',
      op: 'skip-no-change',
      reason: 'flush',
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
    type: 'trace:head',
    op: 'write',
    reason: 'flush',
    path: p.changesHead,
    priorHlc,
    nextHlc: bestHlc,
    regressed,
  });

  if (!regressed) {
    await adapter.writeFile(
      p.changesHead,
      textEncoder.encode(JSON.stringify({ latestHlc: bestHlc } satisfies ChangesHead, null, 2)),
    );
  }

  if (isPrimary) {
    await upsertDeviceMetadata(adapter, remotePath, deviceId);
  }
}
