// compass: interocitor.trust.encryption

/**
 * @interocitor/core/crypto/keys
 *
 * Key generation and management for encrypted meshes.
 *
 * Keys are 256-bit AES-GCM and never leave the device unless
 * the user explicitly exports them to share with other mesh members.
 *
 * @example
 * ```ts
 * import {
 *   generateKey,
 *   keyToPassphrase,
 *   passphraseToKey,
 * } from '@interocitor/core/crypto/keys';
 *
 * // Host: generate and share
 * const key = await generateKey();
 * const passphrase = await keyToPassphrase(key);
 * displayForExplicitTransfer(passphrase); // treat as capability-bearing secret
 *
 * // Import for low-level crypto work.
 * const importedKey = await passphraseToKey(passphrase);
 *
 * // To configure an Interocitor mesh, pass the base58 value to a
 * // PortablePassphraseKeySource rather than mutating an initialized engine.
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

  // ── Low-level (advanced: custom key transport) ────────────────────
  /** Export key to raw bytes for custom out-of-band transfer. */
  exportKeyRaw,
  /** Import key from raw bytes produced by exportKeyRaw. */
  importKeyRaw,
} from "./encryption.ts";
