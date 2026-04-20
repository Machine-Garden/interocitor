/**
 * UUIDv7 generator for worker-issued mesh IDs.
 * Standalone copy — workers package has no dependency on @interocitor/core.
 */
export function uuidv7(): string {
  const now = Date.now();
  const tsBytes = new Uint8Array(6);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    tsBytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  const randBytes = crypto.getRandomValues(new Uint8Array(10));
  const bytes = new Uint8Array(16);
  bytes.set(tsBytes, 0);
  bytes.set(randBytes, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
