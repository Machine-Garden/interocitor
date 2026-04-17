import { expect, test } from '@playwright/test';
function hexFrom(b: ArrayBuffer): string {
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}


test.beforeEach(async ({ page }) => {
  await page.goto('/packages/interocitor/tests/e2e/fixtures/harness.html');
});

// ─── QR payload ──────────────────────────────────────────────────────

test.describe('QR payload encoding', () => {
  test('round-trip encodes share intent', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encodeQRPayload, decodeQRPayload } = await import('/packages/interocitor/dist/handshake/index.js');
      const payload = { intent: 'share', handshakeId: 'abc123', generatorPub: 'pubkey==' };
      const decoded = decodeQRPayload(encodeQRPayload(payload));
      return { match: JSON.stringify(payload) === JSON.stringify(decoded) };
    });
    expect(result.match).toBe(true);
  });

  test('round-trip encodes join intent', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encodeQRPayload, decodeQRPayload } = await import('/packages/interocitor/dist/handshake/index.js');
      const payload = { intent: 'join', handshakeId: 'xyz', generatorPub: 'pk' };
      const decoded = decodeQRPayload(encodeQRPayload(payload));
      return { intent: decoded.intent };
    });
    expect(result.intent).toBe('join');
  });

  test('encoded string is URL-safe base64 (no +/= chars)', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encodeQRPayload } = await import('/packages/interocitor/dist/handshake/index.js');
      return encodeQRPayload({ intent: 'share', handshakeId: 'abc', generatorPub: 'pk' });
    });
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('buildPairUrl embeds payload in URL fragment', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { buildPairUrl, parseQRFromUrl } = await import('/packages/interocitor/dist/index.js');
      const payload = { intent: 'share', handshakeId: 'hs1', generatorPub: 'pk' };
      const url = buildPairUrl('https://app.example.com/pair', payload);
      const parsed = parseQRFromUrl(url.replace(/^[^#]*/, ''));
      return { url, intent: parsed?.intent, handshakeId: parsed?.handshakeId };
    });
    expect(result.url).toContain('#hs=');
    expect(result.url).not.toContain('?');
    expect(result.intent).toBe('share');
    expect(result.handshakeId).toBe('hs1');
  });

  test('parseQRFromUrl returns null for missing fragment', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { parseQRFromUrl } = await import('/packages/interocitor/dist/index.js');
      return parseQRFromUrl('#unrelated=123');
    });
    expect(result).toBeNull();
  });

  test('decodeQRPayload throws on invalid intent', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { decodeQRPayload } = await import('/packages/interocitor/dist/handshake/index.js');
      try {
        const bad = btoa(JSON.stringify({ intent: 'hack', handshakeId: 'x', generatorPub: 'y' }))
          .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        decodeQRPayload(bad);
        return 'no-error';
      } catch (e) { return (e as Error).message; }
    });
    expect(result).toContain('Invalid');
  });

  test('QR payload does NOT contain remotePath or passphrase', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/interocitor/dist/crypto/keys.js');
      const passphrase = await keyToPassphrase(await generateKey());
      const { qrPayload, qrEncoded } = await generateShareQR({
        adapter: new MemoryAdapter(),
        relayBase: '/',
        remotePath: '/secret-path',
        passphrase,
      });
      return {
        hasRemotePath: 'remotePath' in qrPayload,
        hasPassphrase: 'passphrase' in qrPayload,
        encodedContainsPath: qrEncoded.includes('secret'),
        keys: Object.keys(qrPayload),
      };
    });
    expect(result.hasRemotePath).toBe(false);
    expect(result.hasPassphrase).toBe(false);
    expect(result.encodedContainsPath).toBe(false);
    // adapterConfig may also be present (from MemoryAdapter.getHandshakeConfig)
    expect(result.keys).toEqual(expect.arrayContaining(['generatorPub', 'handshakeId', 'intent']));
    expect(result.keys.every((k: string) => ['intent', 'handshakeId', 'generatorPub', 'adapterConfig'].includes(k))).toBe(true);
  });
});

// ─── ECDH helpers ────────────────────────────────────────────────────

test.describe('ECDH keypair helpers', () => {
  test('generateECDHKeypair produces extractable P-256 keypair', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateECDHKeypair } = await import('/packages/interocitor/dist/handshake/index.js');
      const { publicKey, privateKey } = await generateECDHKeypair();
      return {
        pubAlgo: publicKey.algorithm.name,
        privAlgo: privateKey.algorithm.name,
        privUsages: privateKey.usages,
      };
    });
    expect(result.pubAlgo).toBe('ECDH');
    expect(result.privAlgo).toBe('ECDH');
    expect(result.privUsages).toContain('deriveKey');
  });

  test('exportECDHPublicKey / importECDHPublicKey round-trip', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateECDHKeypair, exportECDHPublicKey, importECDHPublicKey } = await import('/packages/interocitor/dist/handshake/index.js');
      const { publicKey } = await generateECDHKeypair();
      const exported = await exportECDHPublicKey(publicKey);
      const reExported = await exportECDHPublicKey(await importECDHPublicKey(exported));
      return { match: exported === reExported };
    });
    expect(result.match).toBe(true);
  });

  test('two keypairs produce different public keys', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateECDHKeypair, exportECDHPublicKey } = await import('/packages/interocitor/dist/handshake/index.js');
      const a = await exportECDHPublicKey((await generateECDHKeypair()).publicKey);
      const b = await exportECDHPublicKey((await generateECDHKeypair()).publicKey);
      return a === b;
    });
    expect(result).toBe(false);
  });

  test('ECDH shared secret is symmetric', async ({ page }) => {
    const result = await page.evaluate(async () => {
      function hexFrom(b: ArrayBuffer): string {
        return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
      }
      const { generateECDHKeypair, exportECDHPublicKey, importECDHPublicKey } = await import('/packages/interocitor/dist/handshake/index.js');
      const kpA = await generateECDHKeypair();
      const kpB = await generateECDHKeypair();
      const pubA = await importECDHPublicKey(await exportECDHPublicKey(kpA.publicKey));
      const pubB = await importECDHPublicKey(await exportECDHPublicKey(kpB.publicKey));
      const bitsAB = await crypto.subtle.deriveBits({ name: 'ECDH', public: pubB }, kpA.privateKey, 256);
      const bitsBA = await crypto.subtle.deriveBits({ name: 'ECDH', public: pubA }, kpB.privateKey, 256);
      return hexFrom(bitsAB) === hexFrom(bitsBA);
    });
    expect(result).toBe(true);
  });
});

// ─── Share flow: generator has credentials, scanner joins ────────────

test.describe('generateShareQR + handleScannedQR (share flow)', () => {
  test('scanner receives correct remotePath and passphrase', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, handleScannedQR } = await import('/packages/interocitor/dist/index.js');
      const { generateKey, keyToPassphrase } = await import('/packages/interocitor/dist/crypto/keys.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const passphrase = await keyToPassphrase(await generateKey());

      const share = await generateShareQR({
        adapter,
        relayBase: '/',
        remotePath: '/team-alpha',
        passphrase,
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });

      const [, received] = await Promise.all([
        share.complete(),
        handleScannedQR({
          adapter,
          relayBase: '/',
          payload: share.qrPayload,
          pollIntervalMs: 50,
          timeoutMs: 10_000,
        }),
      ]);

      return {
        remotePath: received!.remotePath,
        passphraseMatch: received!.passphrase === passphrase,
        intent: share.qrPayload.intent,
      };
    });

    expect(result.remotePath).toBe('/team-alpha');
    expect(result.passphraseMatch).toBe(true);
    expect(result.intent).toBe('share');
  });

  test('unencrypted mesh — scanner receives remotePath, passphrase is null', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, handleScannedQR } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const share = await generateShareQR({
        adapter, relayBase: '/', remotePath: '/plain-team',
        passphrase: null, pollIntervalMs: 50, timeoutMs: 10_000,
      });

      const [, received] = await Promise.all([
        share.complete(),
        handleScannedQR({ adapter, relayBase: '/', payload: share.qrPayload, pollIntervalMs: 50, timeoutMs: 10_000 }),
      ]);

      return { remotePath: received!.remotePath, hasPassphrase: received!.passphrase !== null };
    });

    expect(result.remotePath).toBe('/plain-team');
    expect(result.hasPassphrase).toBe(false);
  });

  test('relay files are cleaned up after share handshake', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, handleScannedQR } = await import('/packages/interocitor/dist/index.js');
      const { generateKey, keyToPassphrase } = await import('/packages/interocitor/dist/crypto/keys.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const passphrase = await keyToPassphrase(await generateKey());
      const share = await generateShareQR({
        adapter, relayBase: '/', remotePath: '/cleanup-test',
        passphrase, pollIntervalMs: 50, timeoutMs: 10_000,
      });
      const { handshakeId } = share.qrPayload;

      await Promise.all([
        share.complete(),
        handleScannedQR({ adapter, relayBase: '/', payload: share.qrPayload, pollIntervalMs: 50, timeoutMs: 10_000 }),
      ]);

      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      
      const files = adapter.dump();
      const relayFiles = Object.keys(files).filter(k => k.includes(`handshake/${handshakeId}`));
      return { relayFiles };
    });

    expect(result.relayFiles).toHaveLength(0);
  });

  test('share times out if scanner never appears', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR } = await import('/packages/interocitor/dist/index.js');
      const { generateKey, keyToPassphrase } = await import('/packages/interocitor/dist/crypto/keys.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const share = await generateShareQR({
        adapter: new MemoryAdapter(), relayBase: '/',
        remotePath: '/timeout', passphrase: await keyToPassphrase(await generateKey()),
        pollIntervalMs: 50, timeoutMs: 200,
      });
      try { await share.complete(); return 'no-error'; }
      catch (e) { return (e as Error).message; }
    });
    expect(result).toContain('timed out');
  });
});

// ─── Join flow: generator wants credentials, scanner pushes them ─────

test.describe('generateJoinQR + handleScannedQR (join flow)', () => {
  test('generator receives correct credentials pushed by scanner', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR, handleScannedQR } = await import('/packages/interocitor/dist/index.js');
      const { generateKey, keyToPassphrase } = await import('/packages/interocitor/dist/crypto/keys.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const passphrase = await keyToPassphrase(await generateKey());

      const join = await generateJoinQR({
        adapter, relayBase: '/',
        pollIntervalMs: 50, timeoutMs: 10_000,
      });

      // Scanner (has credentials) scans the join QR and pushes credentials
      await handleScannedQR({
        adapter,
        relayBase: '/',
        payload: join.qrPayload,
        ownCredentials: { remotePath: '/team-beta', passphrase },
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });

      // Generator receives
      const received = await join.credentials;

      return {
        remotePath: received.remotePath,
        passphraseMatch: received.passphrase === passphrase,
        intent: join.qrPayload.intent,
      };
    });

    expect(result.remotePath).toBe('/team-beta');
    expect(result.passphraseMatch).toBe(true);
    expect(result.intent).toBe('join');
  });

  test('join flow unencrypted mesh — generator receives remotePath, null passphrase', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR, handleScannedQR } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const join = await generateJoinQR({ adapter, relayBase: '/', pollIntervalMs: 50, timeoutMs: 10_000 });

      await handleScannedQR({
        adapter, relayBase: '/', payload: join.qrPayload,
        ownCredentials: { remotePath: '/open-team', passphrase: null },
        pollIntervalMs: 50, timeoutMs: 10_000,
      });

      const received = await join.credentials;
      return { remotePath: received.remotePath, hasPassphrase: received.passphrase !== null };
    });

    expect(result.remotePath).toBe('/open-team');
    expect(result.hasPassphrase).toBe(false);
  });

  test('join times out if scanner never appears', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const join = await generateJoinQR({
        adapter: new MemoryAdapter(), relayBase: '/',
        pollIntervalMs: 50, timeoutMs: 200,
      });
      try { await join.credentials; return 'no-error'; }
      catch (e) { return (e as Error).message; }
    });
    expect(result).toContain('timed out');
  });

  test('handleScannedQR throws if ownCredentials missing for join QR', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR, handleScannedQR } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const join = await generateJoinQR({ adapter: new MemoryAdapter(), relayBase: '/' });
      try {
        await handleScannedQR({ adapter: new MemoryAdapter(), relayBase: '/', payload: join.qrPayload });
        return 'no-error';
      } catch (e) { return (e as Error).message; }
    });
    expect(result).toContain('ownCredentials required');
  });
});

// ─── Security: wrong private key cannot decrypt ───────────────────────

test.describe('Security', () => {
  test('attacker without generatorPriv cannot derive wrapping key', async ({ page }) => {
    const result = await page.evaluate(async () => {
      function hex(b: ArrayBuffer): string {
        return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
      }
      const { generateECDHKeypair, exportECDHPublicKey, importECDHPublicKey } = await import('/packages/interocitor/dist/handshake/index.js');

      const generator = await generateECDHKeypair();
      const scanner   = await generateECDHKeypair();
      const attacker  = await generateECDHKeypair();

      const generatorPub = await importECDHPublicKey(await exportECDHPublicKey(generator.publicKey));
      const scannerPub   = await importECDHPublicKey(await exportECDHPublicKey(scanner.publicKey));


      // Legitimate shared secret
      const legitBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: scannerPub }, generator.privateKey, 256);
      // Attacker tries with their own private key against scannerPub
      const attackBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: generatorPub }, attacker.privateKey, 256);

      return {
        legitimateHex: hex(legitBits).slice(0, 8),
        attackHex:     hex(attackBits).slice(0, 8),
        differ: hex(legitBits) !== hex(attackBits),
      };
    });

    expect(result.differ).toBe(true);
  });

  test('each handshake gets a unique handshakeId', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');
      const adapter = new MemoryAdapter();
      const base = { adapter, relayBase: '/', remotePath: '/m', passphrase: null };
      const a = await generateShareQR(base);
      const b = await generateShareQR(base);
      return { same: a.qrPayload.handshakeId === b.qrPayload.handshakeId };
    });
    expect(result.same).toBe(false);
  });
});

// ─── QR output shape ─────────────────────────────────────────────────

test.describe('QR output shape', () => {
  test('generateShareQR — payload contains required keys, no credentials', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');
      const { qrPayload } = await generateShareQR({
        adapter: new MemoryAdapter(), relayBase: '/', remotePath: '/m', passphrase: null,
      });
      return Object.keys(qrPayload);
    });
    expect(result).toEqual(expect.arrayContaining(['intent', 'handshakeId', 'generatorPub']));
    // No credentials, no passphrase
    expect(result).not.toContain('remotePath');
    expect(result).not.toContain('passphrase');
    // Only known keys present
    const allowed = ['intent', 'handshakeId', 'generatorPub', 'adapterConfig'];
    expect(result.every((k: string) => allowed.includes(k))).toBe(true);
  });

  test('generateJoinQR — pairUrl null without pairBaseUrl', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');
      const { pairUrl, qrEncoded, qrPayload } = await generateJoinQR({ adapter: new MemoryAdapter(), relayBase: '/' });
      return { pairUrl, intent: qrPayload.intent, encodedIsB64: /^[A-Za-z0-9_-]+$/.test(qrEncoded) };
    });
    expect(result.pairUrl).toBeNull();
    expect(result.intent).toBe('join');
    expect(result.encodedIsB64).toBe(true);
  });
});
