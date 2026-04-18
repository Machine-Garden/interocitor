/**
 * Hybrid Logical Clock
 *
 * Combines wall-clock time with a logical counter to produce
 * a total order across distributed devices without coordination.
 *
 * Format when serialized: "{ts}-{counter:04x}-{nodeId}"
 * Example: "1711785600000-0000-dev_x1"
 */

import type { HLC } from './types.ts';

// Guard against poisoned/misconfigured peers that report far-future clocks.
export const HLC_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function hlcInit(nodeId: string): HLC {
  return { ts: Date.now(), counter: 0, nodeId };
}

/** Tick the local clock forward for a new local event. */
export function hlcNow(local: HLC): HLC {
  const wall = Date.now();
  if (wall > local.ts) {
    return { ts: wall, counter: 0, nodeId: local.nodeId };
  }
  return { ts: local.ts, counter: local.counter + 1, nodeId: local.nodeId };
}

/** Merge a remote HLC into the local clock (called on receive). */
export function hlcReceive(local: HLC, remote: HLC): HLC {
  const wall = Date.now();
  const safeRemoteTs = Math.min(remote.ts, wall + HLC_MAX_FUTURE_SKEW_MS);
  const maxTs = Math.max(wall, local.ts, safeRemoteTs);

  let counter: number;
  if (maxTs === local.ts && maxTs === remote.ts) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (maxTs === local.ts) {
    counter = local.counter + 1;
  } else if (maxTs === safeRemoteTs) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }

  return { ts: maxTs, counter, nodeId: local.nodeId };
}

/** Total ordering: -1 if a < b, 0 if equal, 1 if a > b */
export function hlcCompare(a: HLC, b: HLC): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.nodeId < b.nodeId) return -1;
  if (a.nodeId > b.nodeId) return 1;
  return 0;
}

/** Compare two serialized HLC strings without parsing (fast path). */
export function hlcCompareStr(a: string, b: string): number {
  return hlcCompare(hlcParse(a), hlcParse(b));
}

/** Serialize HLC to a string that sorts lexicographically. */
export function hlcSerialize(hlc: HLC): string {
  // Zero-pad ts to 15 digits (covers until year 2286)
  const ts = hlc.ts.toString().padStart(15, '0');
  const counter = hlc.counter.toString(16).padStart(4, '0');
  return `${ts}-${counter}-${hlc.nodeId}`;
}

/** Parse a serialized HLC string back to an HLC object. */
export function hlcParse(s: string): HLC {
  const firstDash = s.indexOf('-');
  const secondDash = s.indexOf('-', firstDash + 1);
  return {
    ts: parseInt(s.slice(0, firstDash), 10),
    counter: parseInt(s.slice(firstDash + 1, secondDash), 16),
    nodeId: s.slice(secondDash + 1),
  };
}
