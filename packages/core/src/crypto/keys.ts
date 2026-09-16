// compass: interocitor.trust.encryption

/**
 * @interocitor/core/crypto/keys
 *
 * Key generation and management for encrypted meshes.
 *
 * Keys are 256-bit AES-GCM and never leave the device unless
 * the user explicitly exports them to share with other mesh members.
 *
 * Imported keys are non-extractable: `crypto.subtle.exportKey` rejects for
 * them, so script that reaches the `CryptoKey` can use the mesh while the tab
 * is open but cannot walk off with the raw bytes. The base58 portable form is
 * the transferable representation; keep that, not an extractable key.
 *
 * @example
 * ```ts
 * import {
 *   generateMeshKeyMaterial,
 *   passphraseToKey,
 * } from '@interocitor/core/crypto/keys';
 *
 * // Host: generate and share
 * const { key, portableKey } = await generateMeshKeyMaterial();
 * displayForExplicitTransfer(portableKey); // treat as capability-bearing secret
 *
 * // Import for low-level crypto work.
 * const importedKey = await passphraseToKey(portableKey);
 *
 * // To configure an Interocitor mesh, pass the base58 value to a
 * // PortablePassphraseKeySource rather than mutating an initialized engine.
 * ```
 */

export type { MeshKeyImportOptions } from "./encryption.ts";

export {
  // ── Key generation ────────────────────────────────────────────────
  generateKey,
  /**
   * Mint a non-extractable mesh key together with its base58 portable form.
   * Preferred over `generateKey()` + `keyToPassphrase()`, which needs an
   * extractable key only to read back bytes it just generated.
   */
  generateMeshKeyMaterial,

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
  /**
   * Export key to raw bytes for custom out-of-band transfer. Requires a key
   * imported with `{ extractable: true }`; mesh keys are not, by default.
   */
  exportKeyRaw,
  /**
   * Import key from raw bytes produced by exportKeyRaw. Non-extractable
   * unless `{ extractable: true }` is passed.
   */
  importKeyRaw,
} from "./encryption.ts";
