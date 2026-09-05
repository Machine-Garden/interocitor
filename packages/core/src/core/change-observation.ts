// compass: interocitor.mailbox-sync.change-transfer

/**
 * Exact change observation ledger.
 *
 * This module is the single owner of the sync-completeness invariant:
 * immutable change filenames prove observation; HLC values are diagnostics
 * and conflict order only. Pull, flush, and connect fast paths must delegate
 * receipt interpretation and persistence here.
 */

import type { ChangeEntry, LocalStore } from "./types.ts";
import { hlcCompareStr, hlcParse } from "./hlc.ts";

const OBSERVATION_META_KEY = "changeObservation";

type ObservationStore = Pick<LocalStore, "getMeta" | "setMeta" | "withLock">;
type ClearableObservationStore = ObservationStore & Pick<LocalStore, "clearAll">;
type WriterFrontiers = Record<string, string>;
interface StoredObservationState {
  generation: number;
  globalHighWaterHlc: string;
  seenChangeFiles: string[];
  writerFrontiers: WriterFrontiers;
}
const fallbackObservationWriteTails = new WeakMap<object, Promise<void>>();

async function withObservationWrite<T>(
  local: ObservationStore,
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof local.withLock === "function") return local.withLock("change-observation", operation);
  const store = local as object;
  const previous = fallbackObservationWriteTails.get(store) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  fallbackObservationWriteTails.set(store, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (fallbackObservationWriteTails.get(store) === current)
      fallbackObservationWriteTails.delete(store);
  }
}

export interface LateChangeObservation {
  writerId: string;
  changeHlc: string;
  fileName: string;
  relation: "behind-global-high-water" | "behind-writer-frontier";
  writerFrontierHlc?: string;
  legacyGlobalHighWaterHlc?: string;
}

function parseSeenChangeFiles(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) return null;
  return new Set(value);
}

function parseWriterFrontiers(value: unknown): WriterFrontiers {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const frontiers: WriterFrontiers = {};
  for (const [writerId, hlc] of Object.entries(value)) {
    if (typeof hlc === "string" && hlc) frontiers[writerId] = hlc;
  }
  return frontiers;
}

function parseObservationState(value: unknown): StoredObservationState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredObservationState>;
  const seenChangeFiles = parseSeenChangeFiles(candidate.seenChangeFiles);
  if (!seenChangeFiles) return null;
  return {
    generation:
      typeof candidate.generation === "number" && Number.isFinite(candidate.generation)
        ? candidate.generation
        : 0,
    globalHighWaterHlc:
      typeof candidate.globalHighWaterHlc === "string" ? candidate.globalHighWaterHlc : "",
    seenChangeFiles: [...seenChangeFiles],
    writerFrontiers: parseWriterFrontiers(candidate.writerFrontiers),
  };
}

async function readObservationState(
  local: ObservationStore,
): Promise<StoredObservationState | null> {
  return parseObservationState(await local.getMeta(OBSERVATION_META_KEY));
}

async function observationGeneration(local: ObservationStore): Promise<number> {
  return (await readObservationState(local))?.generation ?? 0;
}

export function changeFileName(entry: Pick<ChangeEntry, "hlc" | "id">): string {
  return `${entry.hlc}-${entry.id}.json`;
}

export function changeFileHlc(name: string): string | null {
  const marker = name.lastIndexOf("-chg_");
  return marker === -1 ? null : name.slice(0, marker);
}

export function compareChangeFiles(left: { name: string }, right: { name: string }): number {
  const leftHlc = changeFileHlc(left.name);
  const rightHlc = changeFileHlc(right.name);
  if (leftHlc && rightHlc) {
    // Protocol order must not depend on runtime locale collation.
    const compared = hlcCompareStr(leftHlc, rightHlc);
    if (Number.isFinite(compared) && compared !== 0) return compared;
  }
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

/**
 * Mutable in-memory view of observation metadata for one atomic sync step.
 * Load once, record only successfully processed changes, then persist once.
 */
export class ChangeObservationLedger {
  private constructor(
    public globalHighWaterHlc: string,
    private readonly seenChangeFiles: Set<string>,
    private readonly writerFrontiers: WriterFrontiers,
    public readonly hasExactObservationHistory: boolean,
    private readonly generation: number,
  ) {}

  private static async loadUnlocked(local: ObservationStore): Promise<ChangeObservationLedger> {
    const stored = await readObservationState(local);
    return new ChangeObservationLedger(
      stored?.globalHighWaterHlc ?? "",
      new Set(stored?.seenChangeFiles ?? []),
      stored?.writerFrontiers ?? {},
      stored !== null,
      stored?.generation ?? 0,
    );
  }

  static async load(local: ObservationStore): Promise<ChangeObservationLedger> {
    return withObservationWrite(local, () => ChangeObservationLedger.loadUnlocked(local));
  }

  static async reset(local: ObservationStore): Promise<void> {
    await withObservationWrite(local, async () => {
      const generation = (await observationGeneration(local)) + 1;
      await local.setMeta(OBSERVATION_META_KEY, {
        generation,
        globalHighWaterHlc: "",
        seenChangeFiles: [],
        writerFrontiers: {},
      } satisfies StoredObservationState);
    });
  }

  static async clearAll(local: ClearableObservationStore): Promise<void> {
    await withObservationWrite(local, async () => {
      const generation = (await observationGeneration(local)) + 1;
      await local.clearAll();
      await local.setMeta(OBSERVATION_META_KEY, {
        generation,
        globalHighWaterHlc: "",
        seenChangeFiles: [],
        writerFrontiers: {},
      } satisfies StoredObservationState);
    });
  }

  hasSeen(fileName: string): boolean {
    return this.seenChangeFiles.has(fileName);
  }

  isUnseenChange(fileName: string): boolean {
    return changeFileHlc(fileName) !== null && !this.seenChangeFiles.has(fileName);
  }

  hasUnseenChange(files: readonly { name: string }[]): boolean {
    return files.some((file) => this.isUnseenChange(file.name));
  }

  capturedChangeFileNames(): string[] {
    const retained = [...this.seenChangeFiles];
    // Sorting a fresh copy is intentional; runtime support starts before ES2023.
    // eslint-disable-next-line unicorn/no-array-sort
    return retained.sort();
  }

  /**
   * Record one successfully processed immutable file and return its diagnostic
   * relation to prior HLC hints. The relation never controls completeness.
   */
  observe(fileName: string, changeHlc: string): LateChangeObservation | null {
    const fileHlc = changeFileHlc(fileName);
    if (fileHlc === null) throw new Error(`Invalid change filename: ${fileName}`);

    const writerId = hlcParse(fileHlc).nodeId;
    const writerFrontierHlc = this.writerFrontiers[writerId];
    const behindWriterFrontier = writerFrontierHlc
      ? hlcCompareStr(fileHlc, writerFrontierHlc) <= 0
      : false;
    const behindGlobalHighWater = this.globalHighWaterHlc
      ? hlcCompareStr(fileHlc, this.globalHighWaterHlc) <= 0
      : false;

    const lateChange =
      this.hasExactObservationHistory && (behindWriterFrontier || behindGlobalHighWater)
        ? {
            writerId,
            changeHlc: fileHlc,
            fileName,
            relation: behindWriterFrontier
              ? ("behind-writer-frontier" as const)
              : ("behind-global-high-water" as const),
            writerFrontierHlc,
            legacyGlobalHighWaterHlc: this.globalHighWaterHlc || undefined,
          }
        : null;

    if (!writerFrontierHlc || hlcCompareStr(fileHlc, writerFrontierHlc) > 0) {
      this.writerFrontiers[writerId] = fileHlc;
    }
    if (!this.globalHighWaterHlc || hlcCompareStr(changeHlc, this.globalHighWaterHlc) > 0) {
      this.globalHighWaterHlc = changeHlc;
    }
    this.seenChangeFiles.add(fileName);
    return lateChange;
  }

  async persist(local: ObservationStore): Promise<boolean> {
    return withObservationWrite(local, async () => {
      // A reset or snapshot restore supersedes ledgers loaded before it.
      if (this.generation !== (await observationGeneration(local))) return false;
      // Pull and flush may overlap. Merge the latest durable state while
      // holding the one per-store writer gate so neither can erase receipts
      // committed by the other.
      const durable = await ChangeObservationLedger.loadUnlocked(local);
      for (const fileName of durable.seenChangeFiles) this.seenChangeFiles.add(fileName);
      for (const [writerId, frontier] of Object.entries(durable.writerFrontiers)) {
        const candidate = this.writerFrontiers[writerId];
        if (!candidate || hlcCompareStr(frontier, candidate) > 0) {
          this.writerFrontiers[writerId] = frontier;
        }
      }
      if (
        durable.globalHighWaterHlc &&
        (!this.globalHighWaterHlc ||
          hlcCompareStr(durable.globalHighWaterHlc, this.globalHighWaterHlc) > 0)
      ) {
        this.globalHighWaterHlc = durable.globalHighWaterHlc;
      }

      await local.setMeta(OBSERVATION_META_KEY, {
        generation: this.generation,
        globalHighWaterHlc: this.globalHighWaterHlc,
        seenChangeFiles: this.capturedChangeFileNames(),
        writerFrontiers: this.writerFrontiers,
      } satisfies StoredObservationState);
      return true;
    });
  }

  static async restoreSnapshot(
    local: ObservationStore,
    snapshotHlc: string,
    coveredChangeFiles: readonly string[],
    replaceLocalState: () => Promise<void> = async () => {},
  ): Promise<void> {
    await withObservationWrite(local, async () => {
      const generation = (await observationGeneration(local)) + 1;
      await replaceLocalState();
      const ledger = new ChangeObservationLedger(snapshotHlc, new Set(), {}, true, generation);
      for (const fileName of coveredChangeFiles) {
        const fileHlc = changeFileHlc(fileName);
        if (fileHlc === null) throw new Error(`Invalid snapshot change filename: ${fileName}`);
        ledger.observe(fileName, fileHlc);
      }
      if (snapshotHlc && hlcCompareStr(snapshotHlc, ledger.globalHighWaterHlc) > 0) {
        ledger.globalHighWaterHlc = snapshotHlc;
      }
      await local.setMeta(OBSERVATION_META_KEY, {
        generation,
        globalHighWaterHlc: ledger.globalHighWaterHlc,
        seenChangeFiles: ledger.capturedChangeFileNames(),
        writerFrontiers: ledger.writerFrontiers,
      } satisfies StoredObservationState);
    });
  }
}

export async function recordFlushedChanges(
  local: ObservationStore,
  entries: readonly ChangeEntry[],
): Promise<void> {
  const ledger = await ChangeObservationLedger.load(local);
  for (const entry of entries) {
    if (!entry.hlc) continue;
    ledger.observe(changeFileName(entry), entry.hlc);
  }
  if (!(await ledger.persist(local))) {
    throw new Error("Observation state changed before publication; retry the flush");
  }
}
