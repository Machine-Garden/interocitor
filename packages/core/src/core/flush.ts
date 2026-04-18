/**
 * Flush — push queued local outbox entries to remote cloud.
 *
 * Extracted from SyncEngine. Not part of the public API.
 */

import type {
  StorageAdapter,
  ChangeEntry,
  ChangesHead,
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
  const readHeadIfExists = async (): Promise<ChangesHead | null> => {
    try {
      const data = await adapter.readFile(p.changesHead);
      return JSON.parse(textDecoder.decode(data)) as ChangesHead;
    } catch {
      return null;
    }
  };

  const priorHead = await readHeadIfExists();
  const bestHlc = (priorHead?.latestHlc && hlcCompareStr(priorHead.latestHlc, lastWrittenHlc) > 0)
    ? priorHead.latestHlc
    : lastWrittenHlc;
  await adapter.writeFile(
    p.changesHead,
    textEncoder.encode(JSON.stringify({ latestHlc: bestHlc } satisfies ChangesHead, null, 2)),
  );

  if (isPrimary) {
    await upsertDeviceMetadata(adapter, remotePath, deviceId);
  }
}
