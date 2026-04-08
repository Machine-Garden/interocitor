/**
 * interocitor/crypto/keys
 *
 * Key generation and management for encrypted meshes.
 *
 * Keys are 256-bit AES-GCM and never leave the device unless
 * the user explicitly exports them to share with other mesh members.
 *
 * @example
 * ```ts
 * import { generateKey, keyToPassphrase, passphraseToKey } from 'interocitor/crypto/keys';
 *
 * // Host: generate and share
 * const key = await generateKey();
 * const passphrase = await keyToPassphrase(key);
 * console.log('Share this with your mesh:', passphrase);
 *
 * // Guest: join with passphrase
 * const key = await passphraseToKey(passphrase);
 * engine.setEncryptionKey(key);
 *
 * // Persist across sessions
 * await storeKeyLocally(key);
 * const restored = await loadKeyLocally();
 * ```
 */

export {
  // ── Key generation ────────────────────────────────────────────────
  generateKey,

  // ── Human-transferable formats ────────────────────────────────────
  /** Export key as a base58 passphrase (~43 chars, copy-pasteable). */
  keyToPassphrase,
  /** Import key from a base58 passphrase produced by keyToPassphrase. */
  passphraseToKey,

  // ── URL-fragment sharing (key never hits the server) ─────────────
  /** Build a share URL with the key embedded in the fragment (#key=...). */
  keyToShareUrl,
  /** Extract raw key bytes from a URL fragment produced by keyToShareUrl. */
  keyFromFragment,

  // ── Verification ─────────────────────────────────────────────────
  /** Confirm a key can decrypt a known ciphertext (sanity-check on join). */
  verifyKey,

  // ── Local persistence ─────────────────────────────────────────────
  /** Persist key in localStorage for the current origin. */
  storeKeyLocally,
  /** Restore key from localStorage, or null if not present. */
  loadKeyLocally,
  /** Remove the persisted key from localStorage. */
  clearKeyLocally,

  // ── Low-level (advanced: custom key transport) ────────────────────
  /** Export key to raw bytes for custom out-of-band transfer. */
  exportKeyRaw,
  /** Import key from raw bytes produced by exportKeyRaw. */
  importKeyRaw,
} from './encryption.ts';

