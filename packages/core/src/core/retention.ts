// compass: interocitor.mailbox-sync.compaction

import type { RetentionPolicy, RetentionPolicyInput } from "./types.ts";

export const DAY_MS: number = 24 * 60 * 60 * 1_000;
export const DEFAULT_COMPACT_AFTER_MS: number = 7 * DAY_MS;
export const DEFAULT_MAX_OFFLINE_DURATION_MS: number = 30 * DAY_MS;

function finitePositiveDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite duration in milliseconds`);
  }
  return value;
}

/** Resolve explicit input or omitted manifest fields to the finite retention contract. */
export function resolveRetentionPolicy(input?: RetentionPolicyInput | null): RetentionPolicy {
  return {
    compactAfterMs: finitePositiveDuration(
      "retention.compactAfterMs",
      input?.compactAfterMs ?? DEFAULT_COMPACT_AFTER_MS,
    ),
    maxOfflineDurationMs: finitePositiveDuration(
      "retention.maxOfflineDurationMs",
      input?.maxOfflineDurationMs ?? DEFAULT_MAX_OFFLINE_DURATION_MS,
    ),
  };
}
