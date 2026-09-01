/**
 * Stable client-side row ID generator.
 *
 * Use for synced rows. Do not use auto-increment IDs across devices.
 * Default output uses `crypto.randomUUID()` when available.
 */
export interface CreateRowIdOptions {
  /** Optional prefix like `task`, `meal`, `note`. */
  prefix?: string;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createRowId(options: CreateRowIdOptions = {}): string {
  const base =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
  return options.prefix ? `${options.prefix}_${base}` : base;
}
