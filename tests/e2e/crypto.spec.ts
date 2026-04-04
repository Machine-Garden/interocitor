import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/harness.html');
  await page.evaluate(() => {
    localStorage.removeItem('interocitor-key');
  });
});

// ─── Key generation ──────────────────────────────────────────────────

test.describe('generateKey', () => {
  test('produces a 256-bit AES-GCM CryptoKey', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, exportKeyRaw } = await import('/dist/crypto/keys.js');
      const key = await generateKey();
      const raw = await exportKeyRaw(key);
      return { byteLength: raw.byteLength, algorithm: key.algorithm.name };
    });

    expect(result.byteLength).toBe(32); // 256 bits
    expect(result.algorithm).toBe('AES-GCM');
  });

  test('generates unique keys each time', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, exportKeyRaw } = await import('/dist/crypto/keys.js');
      const a = await exportKeyRaw(await generateKey());
      const b = await exportKeyRaw(await generateKey());
      // Compare as hex strings
      const toHex = (bytes: Uint8Array) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      return { same: toHex(a) === toHex(b) };
    });

    expect(result.same).toBe(false);
  });
});

// ─── Passphrase round-trip ───────────────────────────────────────────

test.describe('keyToPassphrase / passphraseToKey', () => {
  test('round-trips a key through base58 passphrase', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, keyToPassphrase, passphraseToKey, exportKeyRaw } = await import('/dist/crypto/keys.js');
      const original = await generateKey();
      const passphrase = await keyToPassphrase(original);
      const restored = await passphraseToKey(passphrase);

      const rawOrig = await exportKeyRaw(original);
      const rawRestored = await exportKeyRaw(restored);
      const toHex = (bytes: Uint8Array) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

      return {
        passphraseLength: passphrase.length,
        match: toHex(rawOrig) === toHex(rawRestored),
        passphrase,
      };
    });

    expect(result.match).toBe(true);
    expect(result.passphraseLength).toBeGreaterThan(30); // ~43 chars for 256 bits
    // Should only contain base58 characters
    expect(result.passphrase).toMatch(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/);
  });

  test('passphraseToKey trims whitespace', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, keyToPassphrase, passphraseToKey, exportKeyRaw } = await import('/dist/crypto/keys.js');
      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);
      const padded = `  ${passphrase}  `;
      const restored = await passphraseToKey(padded);
      const toHex = (bytes: Uint8Array) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      return { match: toHex(await exportKeyRaw(key)) === toHex(await exportKeyRaw(restored)) };
    });

    expect(result.match).toBe(true);
  });
});

// ─── URL fragment round-trip ─────────────────────────────────────────

test.describe('keyToShareUrl / keyFromFragment', () => {
  test('embeds key in URL fragment and extracts it', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, exportKeyRaw, importKeyRaw, keyToShareUrl, keyFromFragment } = await import('/dist/crypto/keys.js');
      const key = await generateKey();
      const raw = await exportKeyRaw(key);
      const url = keyToShareUrl(raw, 'https://app.example.com/join');
      const extractedRaw = keyFromFragment(url.split('#')[1]);
      if (!extractedRaw) return { match: false, url };

      const restored = await importKeyRaw(extractedRaw);
      const rawRestored = await exportKeyRaw(restored);
      const toHex = (bytes: Uint8Array) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

      return {
        url,
        match: toHex(raw) === toHex(rawRestored),
        urlContainsFragment: url.includes('#key='),
      };
    });

    expect(result.match).toBe(true);
    expect(result.urlContainsFragment).toBe(true);
  });

  test('keyFromFragment returns null for missing key param', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { keyFromFragment } = await import('/dist/crypto/keys.js');
      return keyFromFragment('nope=123');
    });

    expect(result).toBeNull();
  });
});

// ─── Encrypt / Decrypt ───────────────────────────────────────────────

test.describe('encryptEntry / decryptEntry', () => {
  test('round-trips plaintext through encryption', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey } = await import('/dist/crypto/keys.js');
      const { encryptEntry, decryptEntry } = await import('/dist/crypto/encryption.js');
      const key = await generateKey();
      const plaintext = '{"id":"chg_1","ops":[]}';
      const encrypted = await encryptEntry(key, plaintext);
      const decrypted = await decryptEntry(key, encrypted);
      return { encrypted, decrypted, isJson: encrypted.startsWith('{') };
    });

    expect(result.decrypted).toBe('{"id":"chg_1","ops":[]}');
    expect(result.isJson).toBe(true); // envelope is JSON

    // Verify envelope structure
    const envelope = JSON.parse(result.encrypted);
    expect(envelope.v).toBe(1);
    expect(envelope.iv).toBeTruthy();
    expect(envelope.ct).toBeTruthy();
  });

  test('fails to decrypt with wrong key', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey } = await import('/dist/crypto/keys.js');
      const { encryptEntry, decryptEntry } = await import('/dist/crypto/encryption.js');
      const keyA = await generateKey();
      const keyB = await generateKey();
      const encrypted = await encryptEntry(keyA, 'secret data');
      try {
        await decryptEntry(keyB, encrypted);
        return { threw: false };
      } catch (e: any) {
        return { threw: true, message: e.message };
      }
    });

    expect(result.threw).toBe(true);
  });

  test('fails on corrupted ciphertext', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey } = await import('/dist/crypto/keys.js');
      const { decryptEntry } = await import('/dist/crypto/encryption.js');
      const key = await generateKey();
      const corrupt = JSON.stringify({ v: 1, iv: 'AAAA', ct: 'BBBB' });
      try {
        await decryptEntry(key, corrupt);
        return { threw: false };
      } catch {
        return { threw: true };
      }
    });

    expect(result.threw).toBe(true);
  });

  test('rejects unknown envelope version', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey } = await import('/dist/crypto/keys.js');
      const { decryptEntry } = await import('/dist/crypto/encryption.js');
      const key = await generateKey();
      try {
        await decryptEntry(key, JSON.stringify({ v: 99, iv: 'x', ct: 'y' }));
        return { threw: false };
      } catch (e: any) {
        return { threw: true, message: e.message };
      }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toContain('Unknown envelope version');
  });

  test('each encryption produces a different ciphertext (random IV)', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey } = await import('/dist/crypto/keys.js');
      const { encryptEntry } = await import('/dist/crypto/encryption.js');
      const key = await generateKey();
      const a = await encryptEntry(key, 'same input');
      const b = await encryptEntry(key, 'same input');
      return { different: a !== b };
    });

    expect(result.different).toBe(true);
  });
});

// ─── NDJSON multi-line encrypt/decrypt ───────────────────────────────

test.describe('encryptNdjson / decryptNdjson', () => {
  test('encrypts and decrypts multiple lines independently', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey } = await import('/dist/crypto/keys.js');
      const { encryptNdjson, decryptNdjson } = await import('/dist/crypto/encryption.js');
      const key = await generateKey();
      const lines = ['{"a":1}', '{"b":2}', '{"c":3}'];
      const encrypted = await encryptNdjson(key, lines);
      const decrypted = await decryptNdjson(key, encrypted);
      return { decrypted, lineCount: encrypted.split('\n').filter((l: string) => l.trim()).length };
    });

    expect(result.decrypted).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(result.lineCount).toBe(3);
  });

  test('decryptNdjson returns null for corrupt lines without throwing', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey } = await import('/dist/crypto/keys.js');
      const { encryptEntry, decryptNdjson } = await import('/dist/crypto/encryption.js');
      const key = await generateKey();
      const good = await encryptEntry(key, 'valid');
      const content = `${good}\n{totally broken}\n${good}`;
      const decrypted = await decryptNdjson(key, content);
      return decrypted;
    });

    expect(result).toEqual(['valid', null, 'valid']);
  });
});

// ─── verifyKey ───────────────────────────────────────────────────────

test.describe('verifyKey', () => {
  test('returns true for matching key', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, verifyKey } = await import('/dist/crypto/keys.js');
      const { encryptEntry } = await import('/dist/crypto/encryption.js');
      const key = await generateKey();
      const sample = await encryptEntry(key, 'test');
      return verifyKey(key, sample);
    });

    expect(result).toBe(true);
  });

  test('returns false for wrong key', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, verifyKey } = await import('/dist/crypto/keys.js');
      const { encryptEntry } = await import('/dist/crypto/encryption.js');
      const keyA = await generateKey();
      const keyB = await generateKey();
      const sample = await encryptEntry(keyA, 'test');
      return verifyKey(keyB, sample);
    });

    expect(result).toBe(false);
  });
});

// ─── Local key persistence ───────────────────────────────────────────

test.describe('storeKeyLocally / loadKeyLocally / clearKeyLocally', () => {
  test('persists and restores a key from localStorage', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, exportKeyRaw, storeKeyLocally, loadKeyLocally } = await import('/dist/crypto/keys.js');
      const key = await generateKey();
      await storeKeyLocally(key);
      const restored = await loadKeyLocally();
      if (!restored) return { match: false };
      const toHex = (bytes: Uint8Array) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      return { match: toHex(await exportKeyRaw(key)) === toHex(await exportKeyRaw(restored)) };
    });

    expect(result.match).toBe(true);
  });

  test('loadKeyLocally returns null when no key is stored', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { loadKeyLocally } = await import('/dist/crypto/keys.js');
      return loadKeyLocally();
    });

    expect(result).toBeNull();
  });

  test('clearKeyLocally removes the stored key', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, storeKeyLocally, loadKeyLocally, clearKeyLocally } = await import('/dist/crypto/keys.js');
      await storeKeyLocally(await generateKey());
      clearKeyLocally();
      return loadKeyLocally();
    });

    expect(result).toBeNull();
  });
});

