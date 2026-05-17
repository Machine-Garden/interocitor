/**
 * Bounded-progress helper for cloud-side work performed during connect().
 *
 * Antifragility contract (mirrors the local-store wrapper):
 *   - the application must not get stuck because a remote call hung.
 *   - every stage that runs inside connect() must settle in bounded time
 *     or fail its stage explicitly, so the engine can degrade to an
 *     offline-ready state instead of hanging init.
 *
 * This helper does not cancel the underlying work — we cannot reliably
 * cancel a fetch from outside in all runtimes. It only ensures the
 * caller observes a deterministic failure when the deadline elapses.
 */
export class ConnectStageTimeoutError extends Error {
  readonly stage: string;
  readonly timeoutMs: number;
  constructor(stage: string, timeoutMs: number) {
    super(`Connect stage "${stage}" exceeded ${timeoutMs}ms deadline`);
    this.name = 'ConnectStageTimeoutError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export function withDeadline<T>(stage: string, op: Promise<T> | (() => Promise<T>), timeoutMs: number): Promise<T> {
  const work = typeof op === 'function' ? (op as () => Promise<T>)() : op;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ConnectStageTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export const DEFAULT_CONNECT_STAGE_TIMEOUT_MS = 15_000;
