import { expect, test } from "@playwright/test";

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/core/tests/e2e/fixtures/harness.html");
});

// ─── QR payload ──────────────────────────────────────────────────────

test.describe("QR payload encoding", () => {
  test("round-trip encodes share intent", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encodeQRPayload, decodeQRPayload } =
        await import("/packages/core/dist/handshake/index.js");
      const payload = { intent: "share", handshakeId: "abc123", generatorPub: "pubkey==" };
      const decoded = decodeQRPayload(encodeQRPayload(payload));
      return { match: JSON.stringify(payload) === JSON.stringify(decoded) };
    });
    expect(result.match).toBe(true);
  });

  test("round-trip encodes join intent", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encodeQRPayload, decodeQRPayload } =
        await import("/packages/core/dist/handshake/index.js");
      const payload = { intent: "join", handshakeId: "xyz", generatorPub: "pk" };
      const decoded = decodeQRPayload(encodeQRPayload(payload));
      return { intent: decoded.intent };
    });
    expect(result.intent).toBe("join");
  });

  test("encoded string is URL-safe base64 (no +/= chars)", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encodeQRPayload } = await import("/packages/core/dist/handshake/index.js");
      return encodeQRPayload({ intent: "share", handshakeId: "abc", generatorPub: "pk" });
    });
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("buildPairUrl embeds payload in URL fragment", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { buildPairUrl, parseQRFromUrl } = await import("/packages/core/dist/index.js");
      const payload = { intent: "share", handshakeId: "hs1", generatorPub: "pk" };
      const url = buildPairUrl("https://app.example.com/pair", payload);
      const parsed = parseQRFromUrl(url.replace(/^[^#]*/, ""));
      return { url, intent: parsed?.intent, handshakeId: parsed?.handshakeId };
    });
    expect(result.url).toContain("#hs=");
    expect(result.url).not.toContain("?");
    expect(result.intent).toBe("share");
    expect(result.handshakeId).toBe("hs1");
  });

  test("parseQRFromUrl returns null for missing fragment", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { parseQRFromUrl } = await import("/packages/core/dist/index.js");
      return parseQRFromUrl("#unrelated=123");
    });
    expect(result).toBeNull();
  });

  test("decodeQRPayload throws on invalid intent", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { decodeQRPayload } = await import("/packages/core/dist/handshake/index.js");
      try {
        const bad = btoa(JSON.stringify({ intent: "hack", handshakeId: "x", generatorPub: "y" }))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
        decodeQRPayload(bad);
        return "no-error";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(result).toContain("Invalid");
  });

  test("unsafe handshake ids are rejected before relay I/O", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createGeneratorSession, decodeQRPayload, encodeQRPayload, runScannerHandshake } =
        await import("/packages/core/dist/handshake/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const payload = {
        intent: "share" as const,
        handshakeId: "../../important.json?ignored=",
        generatorPub: "not-used",
      };

      let decodeError = "";
      try {
        decodeQRPayload(encodeQRPayload(payload));
      } catch (error) {
        decodeError = (error as Error).message;
      }

      const scannerAdapter = new MemoryAdapter();
      let scannerError = "";
      try {
        await runScannerHandshake(scannerAdapter, payload, null, "/relay");
      } catch (error) {
        scannerError = (error as Error).message;
      }

      const generatorAdapter = new MemoryAdapter();
      const generator = await createGeneratorSession();
      let generatorError = "";
      try {
        await generator.complete(generatorAdapter, payload.handshakeId, "/relay", "share", {
          remotePath: "/mesh",
          passphrase: null,
        });
      } catch (error) {
        generatorError = (error as Error).message;
      }

      return {
        decodeError,
        scannerError,
        generatorError,
        scannerFiles: Object.keys(scannerAdapter.dump()),
        generatorFiles: Object.keys(generatorAdapter.dump()),
      };
    });

    expect(result.decodeError).toContain("Invalid handshake QR payload");
    expect(result.scannerError).toContain("Invalid handshake id");
    expect(result.generatorError).toContain("Invalid handshake id");
    expect(result.scannerFiles).toEqual([]);
    expect(result.generatorFiles).toEqual([]);
  });

  test("runtime intents are validated and snapshotted before relay I/O", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createGeneratorSession, handleScannedQR, runScannerHandshake } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const credentials = {
        remotePath: "/must-not-send",
        passphrase: null,
      };

      const lowLevelAdapter = new MemoryAdapter();
      const lowLevelGenerator = await createGeneratorSession();
      let scannerError = "";
      try {
        await runScannerHandshake(
          lowLevelAdapter,
          {
            intent: "invalid",
            handshakeId: "invalid-intent",
            generatorPub: lowLevelGenerator.generatorPub,
          } as any,
          credentials,
          "/relay",
        );
      } catch (error) {
        scannerError = (error as Error).message;
      }

      const generatorAdapter = new MemoryAdapter();
      let generatorError = "";
      try {
        await lowLevelGenerator.complete(
          generatorAdapter,
          "invalid-intent",
          "/relay",
          "invalid" as any,
          credentials,
        );
      } catch (error) {
        generatorError = (error as Error).message;
      }

      const highLevelAdapter = new MemoryAdapter();
      const highLevelGenerator = await createGeneratorSession();
      let capabilityStarted!: () => void;
      let resumeCapabilities!: () => void;
      const capabilitiesStarted = new Promise<void>((resolve) => {
        capabilityStarted = resolve;
      });
      const capabilityPause = new Promise<void>((resolve) => {
        resumeCapabilities = resolve;
      });
      (highLevelAdapter as any).getPairingCapabilities = async () => {
        capabilityStarted();
        await capabilityPause;
        return null;
      };
      const payload = {
        intent: "share" as "share" | "join",
        handshakeId: "stable-intent",
        generatorPub: highLevelGenerator.generatorPub,
      };
      const handling = handleScannedQR({
        adapter: highLevelAdapter,
        relayBase: "/relay",
        payload,
        ownCredentials: credentials,
        pollIntervalMs: 1,
        timeoutMs: 20,
      });
      await capabilitiesStarted;
      payload.intent = "join";
      resumeCapabilities();

      let highLevelError = "";
      try {
        await handling;
      } catch (error) {
        highLevelError = (error as Error).message;
      }

      return {
        scannerError,
        scannerFiles: Object.keys(lowLevelAdapter.dump()),
        generatorError,
        generatorFiles: Object.keys(generatorAdapter.dump()),
        highLevelError,
        highLevelFiles: Object.keys(highLevelAdapter.dump()),
      };
    });

    expect(result.scannerError).toContain("Invalid handshake intent");
    expect(result.scannerFiles).toEqual([]);
    expect(result.generatorError).toContain("Invalid handshake intent");
    expect(result.generatorFiles).toEqual([]);
    expect(result.highLevelError).toContain("Handshake timed out");
    expect(result.highLevelFiles.some((path: string) => path.endsWith("credentials.json"))).toBe(
      false,
    );
  });

  test("malformed local credentials are rejected before QR or relay output", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createGeneratorSession, generateShareQR, runScannerHandshake } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const invalidCredentials = { remotePath: "/protected", passphrase: undefined } as any;

      const highLevelAdapter = new MemoryAdapter();
      let highLevelError = "";
      try {
        await generateShareQR({
          adapter: highLevelAdapter,
          relayBase: "/relay",
          ...invalidCredentials,
        });
      } catch (error) {
        highLevelError = (error as Error).message;
      }

      const generator = await createGeneratorSession();
      const generatorAdapter = new MemoryAdapter();
      let generatorError = "";
      try {
        await generator.complete(
          generatorAdapter,
          "invalid-generator-credentials",
          "/relay",
          "share",
          invalidCredentials,
        );
      } catch (error) {
        generatorError = (error as Error).message;
      }

      const scannerAdapter = new MemoryAdapter();
      let scannerError = "";
      try {
        await runScannerHandshake(
          scannerAdapter,
          {
            intent: "join",
            handshakeId: "invalid-scanner-credentials",
            generatorPub: generator.generatorPub,
          },
          invalidCredentials,
          "/relay",
        );
      } catch (error) {
        scannerError = (error as Error).message;
      }

      return {
        highLevelError,
        highLevelFiles: Object.keys(highLevelAdapter.dump()),
        generatorError,
        generatorFiles: Object.keys(generatorAdapter.dump()),
        scannerError,
        scannerFiles: Object.keys(scannerAdapter.dump()),
      };
    });

    expect(result).toEqual({
      highLevelError: "Invalid handshake credentials",
      highLevelFiles: [],
      generatorError: "Invalid handshake credentials",
      generatorFiles: [],
      scannerError: "Invalid handshake credentials",
      scannerFiles: [],
    });
  });

  test("join credentials are snapshotted before an async adapter factory", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createGeneratorSession, handleScannedQR } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const adapter = new MemoryAdapter();
      const generator = await createGeneratorSession();
      const payload = {
        intent: "join" as const,
        handshakeId: "stable-join-credentials",
        generatorPub: generator.generatorPub,
        adapterConfig: "bootstrap",
      };
      const received = generator.complete(adapter, payload.handshakeId, "/relay", "join", null, {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      });

      let factoryStarted!: () => void;
      let resumeFactory!: () => void;
      const started = new Promise<void>((resolve) => {
        factoryStarted = resolve;
      });
      const pause = new Promise<void>((resolve) => {
        resumeFactory = resolve;
      });
      const ownCredentials = {
        remotePath: "/intended",
        passphrase: null,
        connectionConfig: "intended-config",
      };
      const handling = handleScannedQR({
        adapterFromConfig: async () => {
          factoryStarted();
          await pause;
          return adapter;
        },
        relayBase: "/relay",
        payload,
        ownCredentials,
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      });
      await started;
      ownCredentials.remotePath = "/mutated";
      ownCredentials.connectionConfig = "mutated-config";
      resumeFactory();
      await handling;
      return received;
    });

    expect(result).toEqual({
      remotePath: "/intended",
      passphrase: null,
      connectionConfig: "intended-config",
    });
  });

  test("QR encoding admits only public invitation fields", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { buildPairUrl, encodeQRPayload, generateShareQR } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const passphrase = await keyToPassphrase(await generateKey());
      const { qrPayload, qrEncoded } = await generateShareQR({
        adapter: new MemoryAdapter(),
        relayBase: "/",
        remotePath: "/secret-path",
        passphrase,
        connectionConfig: "recipient-bearer-secret",
      });
      const rawPayload = (encoded: string) => {
        const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
        return JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))) as Record<
          string,
          unknown
        >;
      };
      const highLevelWire = rawPayload(qrEncoded);
      const lowLevelPayload = {
        intent: "share",
        handshakeId: "public-fields-only",
        generatorPub: "public-key",
        remotePath: "/secret-path",
        passphrase,
        connectionConfig: "recipient-bearer-secret",
      } as any;
      const lowLevelWire = rawPayload(encodeQRPayload(lowLevelPayload));
      const pairUrl = buildPairUrl("https://app.example.test/pair", lowLevelPayload);
      const pairUrlWire = rawPayload(pairUrl.split("#hs=")[1]!);
      return {
        highLevelKeys: Object.keys(highLevelWire),
        lowLevelKeys: Object.keys(lowLevelWire),
        pairUrlKeys: Object.keys(pairUrlWire),
        keys: Object.keys(qrPayload),
      };
    });
    for (const keys of [result.highLevelKeys, result.lowLevelKeys, result.pairUrlKeys]) {
      expect(keys).not.toContain("remotePath");
      expect(keys).not.toContain("passphrase");
      expect(keys).not.toContain("connectionConfig");
    }
    // adapterConfig may also be present (from MemoryAdapter.getHandshakeConfig)
    expect(result.keys).toEqual(expect.arrayContaining(["generatorPub", "handshakeId", "intent"]));
    expect(
      result.keys.every((k: string) =>
        ["intent", "handshakeId", "generatorPub", "adapterConfig"].includes(k),
      ),
    ).toBe(true);
  });
});

test.describe("Pairing capability negotiation", () => {
  test("recognized capabilities are exported through root and QR subpath", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const root = await import("/packages/core/dist/index.js");
      const qr = await import("/packages/core/dist/handshake/qr-public.js");
      const payload = {
        intent: "share" as const,
        handshakeId: "capabilities",
        generatorPub: "pub",
        capabilities: {
          supported: [root.INDIRECT_MESH_ROUTING_V1, root.MESH_GRANT_AUTHORIZATION_V1],
          required: [root.INDIRECT_MESH_ROUTING_V1],
        },
      };
      const decoded = qr.decodeQRPayload(qr.encodeQRPayload(payload));
      return {
        indirect: root.INDIRECT_MESH_ROUTING_V1,
        grant: qr.MESH_GRANT_AUTHORIZATION_V1,
        decodedCapabilities: decoded.capabilities,
      };
    });

    expect(result.indirect).toBe("mesh-routing:indirect:v1");
    expect(result.grant).toBe("mesh-authorization:grant:v1");
    expect(result.decodedCapabilities).toEqual({
      supported: ["mesh-routing:indirect:v1", "mesh-authorization:grant:v1"],
      required: ["mesh-routing:indirect:v1"],
    });
  });

  test("decode rejects malformed capability profiles", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encodeQRPayload, decodeQRPayload } =
        await import("/packages/core/dist/handshake/index.js");
      const malformedProfiles = [
        { supported: "not-an-array" },
        Object.assign([], { supported: [] }),
      ];
      return malformedProfiles.map((capabilities) => {
        try {
          const malformed = {
            intent: "share" as const,
            handshakeId: "bad-capabilities",
            generatorPub: "pub",
            capabilities,
          };
          decodeQRPayload(encodeQRPayload(malformed as any));
          return "no-error";
        } catch (error) {
          return (error as Error).message;
        }
      });
    });

    expect(result).toEqual(["Invalid handshake QR payload", "Invalid handshake QR payload"]);
  });

  test("a participant cannot require a capability it does not support", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const {
        createGeneratorSession,
        generateShareQR,
        runScannerHandshake,
        UnsupportedPairingCapabilityError,
      } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const capabilities = { supported: [], required: ["application:required:v1"] };

      const highLevelAdapter = new MemoryAdapter();
      let highLevel = "";
      try {
        await generateShareQR({
          adapter: highLevelAdapter,
          relayBase: "/relay",
          remotePath: "/mesh",
          passphrase: null,
          capabilities,
        });
      } catch (error) {
        highLevel =
          error instanceof UnsupportedPairingCapabilityError ? error.code : "unexpected-error";
      }

      const generator = await createGeneratorSession();
      const generatorAdapter = new MemoryAdapter();
      let lowLevelGenerator = "";
      try {
        await generator.complete(
          generatorAdapter,
          "unsupported-generator-profile",
          "/relay",
          "join",
          null,
          { capabilities },
        );
      } catch (error) {
        lowLevelGenerator =
          error instanceof UnsupportedPairingCapabilityError ? error.code : "unexpected-error";
      }

      const scannerAdapter = new MemoryAdapter();
      let lowLevelScanner = "";
      try {
        await runScannerHandshake(
          scannerAdapter,
          {
            intent: "share",
            handshakeId: "unsupported-scanner-profile",
            generatorPub: generator.generatorPub,
          },
          null,
          "/relay",
          { capabilities },
        );
      } catch (error) {
        lowLevelScanner =
          error instanceof UnsupportedPairingCapabilityError ? error.code : "unexpected-error";
      }

      return {
        highLevel,
        highLevelFiles: Object.keys(highLevelAdapter.dump()),
        lowLevelGenerator,
        generatorFiles: Object.keys(generatorAdapter.dump()),
        lowLevelScanner,
        scannerFiles: Object.keys(scannerAdapter.dump()),
      };
    });

    expect(result).toEqual({
      highLevel: "UNSUPPORTED_PAIRING_CAPABILITY",
      highLevelFiles: [],
      lowLevelGenerator: "UNSUPPORTED_PAIRING_CAPABILITY",
      generatorFiles: [],
      lowLevelScanner: "UNSUPPORTED_PAIRING_CAPABILITY",
      scannerFiles: [],
    });
  });

  test("explicit capabilities are snapshotted before adapter metadata resolves", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, INDIRECT_MESH_ROUTING_V1 } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      let adapterStarted!: () => void;
      let resumeAdapter!: () => void;
      const started = new Promise<void>((resolve) => {
        adapterStarted = resolve;
      });
      const pause = new Promise<void>((resolve) => {
        resumeAdapter = resolve;
      });
      class PausedAdapter extends MemoryAdapter {
        async getPairingCapabilities() {
          adapterStarted();
          await pause;
          return null;
        }
      }

      const capabilities = {
        supported: [INDIRECT_MESH_ROUTING_V1],
        required: [INDIRECT_MESH_ROUTING_V1],
      };
      const pending = generateShareQR({
        adapter: new PausedAdapter(),
        relayBase: "/relay",
        remotePath: "/mesh",
        passphrase: null,
        capabilities,
      });
      await started;
      capabilities.required.length = 0;
      resumeAdapter();
      return (await pending).qrPayload.capabilities;
    });

    expect(result).toEqual({
      supported: ["mesh-routing:indirect:v1"],
      required: ["mesh-routing:indirect:v1"],
    });
  });

  test("direct pairing keeps v1 wire while connectionConfig stays encrypted", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, handleScannedQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class CapturingAdapter extends MemoryAdapter {
        credentialEnvelope: string | null = null;

        async writeFile(path: string, data: Uint8Array | string): Promise<void> {
          if (path.endsWith("/credentials.json")) {
            this.credentialEnvelope =
              typeof data === "string" ? data : new TextDecoder().decode(data);
          }
          await super.writeFile(path, data);
        }
      }

      const adapter = new CapturingAdapter();
      const connectionConfig = '{"baseUrl":"https://worker/io/device-only"}';
      const share = await generateShareQR({
        adapter,
        relayBase: "/relay",
        remotePath: "/mesh",
        passphrase: null,
        connectionConfig,
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });
      const [, received] = await Promise.all([
        share.complete(),
        handleScannedQR({
          adapter,
          relayBase: "/relay",
          payload: share.qrPayload,
          pollIntervalMs: 10,
          timeoutMs: 5_000,
        }),
      ]);
      const envelope = JSON.parse(adapter.credentialEnvelope!) as { v: number };
      return {
        envelopeVersion: envelope.v,
        qrKeys: Object.keys(share.qrPayload),
        qrContainsConfig: JSON.stringify(share.qrPayload).includes(connectionConfig),
        envelopeContainsConfig: adapter.credentialEnvelope!.includes(connectionConfig),
        receivedConfig: received?.connectionConfig,
      };
    });

    expect(result.envelopeVersion).toBe(1);
    expect(result.qrKeys).not.toContain("connectionConfig");
    expect(result.qrKeys).not.toContain("capabilities");
    expect(result.qrContainsConfig).toBe(false);
    expect(result.envelopeContainsConfig).toBe(false);
    expect(result.receivedConfig).toBe('{"baseUrl":"https://worker/io/device-only"}');
  });

  test("unsupported required capability fails before scanner relay writes", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const {
        generateShareQR,
        handleScannedQR,
        INDIRECT_MESH_ROUTING_V1,
        UnsupportedPairingCapabilityError,
      } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const adapter = new MemoryAdapter();
      const share = await generateShareQR({
        adapter,
        relayBase: "/relay",
        remotePath: "/mesh",
        passphrase: null,
        capabilities: {
          supported: [INDIRECT_MESH_ROUTING_V1],
          required: [INDIRECT_MESH_ROUTING_V1],
        },
      });

      try {
        await handleScannedQR({
          adapter,
          relayBase: "/relay",
          payload: share.qrPayload,
          capabilities: { supported: [] },
        });
        return { error: "no-error", relayPaths: Object.keys(adapter.dump()) };
      } catch (error) {
        return {
          error: (error as Error).name,
          code:
            error instanceof UnsupportedPairingCapabilityError ? error.code : "unexpected-error",
          missing:
            error instanceof UnsupportedPairingCapabilityError ? error.missingCapabilities : [],
          relayPaths: Object.keys(adapter.dump()),
        };
      }
    });

    expect(result.error).toBe("UnsupportedPairingCapabilityError");
    expect(result.code).toBe("UNSUPPORTED_PAIRING_CAPABILITY");
    expect(result.missing).toEqual(["mesh-routing:indirect:v1"]);
    expect(result.relayPaths).toEqual([]);
  });

  test("mutating the returned QR payload cannot weaken generator requirements", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const {
        generateShareQR,
        handleScannedQR,
        INDIRECT_MESH_ROUTING_V1,
        UnsupportedPairingCapabilityError,
      } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const adapter = new MemoryAdapter();
      const share = await generateShareQR({
        adapter,
        relayBase: "/relay",
        remotePath: "/mesh",
        passphrase: null,
        capabilities: {
          supported: [INDIRECT_MESH_ROUTING_V1],
          required: [INDIRECT_MESH_ROUTING_V1],
        },
        pollIntervalMs: 10,
        timeoutMs: 250,
      });
      const originalProfile = share.qrPayload.capabilities!;
      try {
        (originalProfile as any).required = [];
      } catch {}
      const nestedMutationApplied = originalProfile.required?.length === 0;
      (share.qrPayload as any).capabilities = { supported: [], required: [] };

      const [generator, scanner] = await Promise.allSettled([
        share.complete(),
        handleScannedQR({
          adapter,
          relayBase: "/relay",
          payload: share.qrPayload,
          capabilities: { supported: [] },
          pollIntervalMs: 10,
          timeoutMs: 250,
        }),
      ]);
      return {
        profileFrozen: Object.isFrozen(originalProfile),
        arraysFrozen:
          Object.isFrozen(originalProfile.supported) && Object.isFrozen(originalProfile.required),
        nestedMutationApplied,
        generatorError:
          generator.status === "rejected" &&
          generator.reason instanceof UnsupportedPairingCapabilityError
            ? generator.reason.code
            : generator.status,
        scannerStatus: scanner.status,
        wroteCredentials: Object.keys(adapter.dump()).some((path) =>
          path.endsWith("/credentials.json"),
        ),
      };
    });

    expect(result).toEqual({
      profileFrozen: true,
      arraysFrozen: true,
      nestedMutationApplied: false,
      generatorError: "UNSUPPORTED_PAIRING_CAPABILITY",
      scannerStatus: "rejected",
      wroteCredentials: false,
    });
  });

  test("capability profile fields and indexed arrays are snapshotted exactly once", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, INDIRECT_MESH_ROUTING_V1 } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      let requiredReads = 0;
      const supported = [INDIRECT_MESH_ROUTING_V1];
      const required = [INDIRECT_MESH_ROUTING_V1];
      supported[Symbol.iterator] = function* () {};
      required[Symbol.iterator] = function* () {};
      const capabilities = {
        supported,
        get required() {
          requiredReads += 1;
          return requiredReads === 1 ? required : [];
        },
      };
      const share = await generateShareQR({
        adapter: new MemoryAdapter(),
        relayBase: "/relay",
        remotePath: "/mesh",
        passphrase: null,
        capabilities,
      });
      return { requiredReads, capabilities: share.qrPayload.capabilities };
    });

    expect(result).toEqual({
      requiredReads: 1,
      capabilities: {
        supported: ["mesh-routing:indirect:v1"],
        required: ["mesh-routing:indirect:v1"],
      },
    });
  });

  test("adapter and per-call capabilities union into a v2 share handshake", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const {
        generateShareQR,
        handleScannedQR,
        INDIRECT_MESH_ROUTING_V1,
        MESH_GRANT_AUTHORIZATION_V1,
      } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class CapabilityAdapter extends MemoryAdapter {
        envelopeVersion: number | null = null;

        getPairingCapabilities() {
          return {
            supported: [INDIRECT_MESH_ROUTING_V1],
            required: [INDIRECT_MESH_ROUTING_V1, MESH_GRANT_AUTHORIZATION_V1],
          };
        }

        async writeFile(path: string, data: Uint8Array | string): Promise<void> {
          if (path.endsWith("/credentials.json")) {
            const text = typeof data === "string" ? data : new TextDecoder().decode(data);
            this.envelopeVersion = (JSON.parse(text) as { v: number }).v;
          }
          await super.writeFile(path, data);
        }
      }

      const adapter = new CapabilityAdapter();
      const perCall = { supported: [MESH_GRANT_AUTHORIZATION_V1], required: [] };
      const share = await generateShareQR({
        adapter,
        relayBase: "/relay",
        remotePath: "/mesh",
        passphrase: null,
        connectionConfig: '{"baseUrl":"https://worker/io/recipient-route"}',
        capabilities: perCall,
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });

      const [, received] = await Promise.all([
        share.complete(),
        handleScannedQR({
          adapter,
          relayBase: "/relay",
          payload: share.qrPayload,
          capabilities: perCall,
          pollIntervalMs: 10,
          timeoutMs: 5_000,
        }),
      ]);

      return {
        envelopeVersion: adapter.envelopeVersion,
        capabilities: share.qrPayload.capabilities,
        connectionConfig: received?.connectionConfig,
      };
    });

    expect(result.envelopeVersion).toBe(2);
    expect(result.capabilities).toEqual({
      supported: ["mesh-authorization:grant:v1", "mesh-routing:indirect:v1"],
      required: ["mesh-authorization:grant:v1", "mesh-routing:indirect:v1"],
    });
    expect(result.connectionConfig).toBe('{"baseUrl":"https://worker/io/recipient-route"}');
  });

  test("adapter and per-call capability union cannot exceed the wire limit", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class CapabilityAdapter extends MemoryAdapter {
        getPairingCapabilities() {
          return {
            supported: Array.from({ length: 32 }, (_, index) => `adapter:${index}`),
          };
        }
      }

      try {
        await generateShareQR({
          adapter: new CapabilityAdapter(),
          relayBase: "/relay",
          remotePath: "/mesh",
          passphrase: null,
          capabilities: { supported: ["explicit:extra"] },
        });
        return "no-error";
      } catch (error) {
        return (error as Error).message;
      }
    });

    expect(result).toContain("Invalid pairing capabilities: supported must contain at most 32 ids");
  });

  test("v2 rejects a capability profile changed after the invitation was issued", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, handleScannedQR, INDIRECT_MESH_ROUTING_V1 } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const adapter = new MemoryAdapter();
      const capabilities = {
        supported: [INDIRECT_MESH_ROUTING_V1],
        required: [INDIRECT_MESH_ROUTING_V1],
      };
      const share = await generateShareQR({
        adapter,
        relayBase: "/relay",
        remotePath: "/mesh",
        passphrase: null,
        capabilities,
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });
      const tamperedPayload = {
        ...share.qrPayload,
        capabilities: {
          supported: [INDIRECT_MESH_ROUTING_V1, "application:injected:v1"],
          required: [INDIRECT_MESH_ROUTING_V1],
        },
      };

      const [generator, scanner] = await Promise.allSettled([
        share.complete(),
        handleScannedQR({
          adapter,
          relayBase: "/relay",
          payload: tamperedPayload,
          capabilities,
          pollIntervalMs: 10,
          timeoutMs: 5_000,
        }),
      ]);
      return {
        generator: generator.status,
        scanner: scanner.status,
      };
    });

    expect(result).toEqual({ generator: "fulfilled", scanner: "rejected" });
  });

  test("matching required capabilities complete a v2 join handshake", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const {
        generateJoinQR,
        handleScannedQR,
        INDIRECT_MESH_ROUTING_V1,
        MESH_GRANT_AUTHORIZATION_V1,
      } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class CapturingAdapter extends MemoryAdapter {
        envelopeVersion: number | null = null;

        async writeFile(path: string, data: Uint8Array | string): Promise<void> {
          if (path.endsWith("/credentials.json")) {
            const text = typeof data === "string" ? data : new TextDecoder().decode(data);
            this.envelopeVersion = (JSON.parse(text) as { v: number }).v;
          }
          await super.writeFile(path, data);
        }
      }

      const capabilities = {
        supported: [INDIRECT_MESH_ROUTING_V1, MESH_GRANT_AUTHORIZATION_V1],
        required: [INDIRECT_MESH_ROUTING_V1, MESH_GRANT_AUTHORIZATION_V1],
      };
      const adapter = new CapturingAdapter();
      const join = await generateJoinQR({
        adapter,
        relayBase: "/relay",
        capabilities,
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });
      await handleScannedQR({
        adapter,
        relayBase: "/relay",
        payload: join.qrPayload,
        ownCredentials: {
          remotePath: "/mesh",
          passphrase: null,
          connectionConfig: '{"baseUrl":"https://worker/io/joiner-route"}',
        },
        capabilities,
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });
      const received = await join.credentials;
      return {
        envelopeVersion: adapter.envelopeVersion,
        remotePath: received.remotePath,
        connectionConfig: received.connectionConfig,
      };
    });

    expect(result).toEqual({
      envelopeVersion: 2,
      remotePath: "/mesh",
      connectionConfig: '{"baseUrl":"https://worker/io/joiner-route"}',
    });
  });

  test("required generator rejects a capability-free scanner hello before sharing credentials", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, INDIRECT_MESH_ROUTING_V1 } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const adapter = new MemoryAdapter();
      const share = await generateShareQR({
        adapter,
        relayBase: "/relay",
        remotePath: "/mesh",
        passphrase: null,
        capabilities: {
          supported: [INDIRECT_MESH_ROUTING_V1],
          required: [INDIRECT_MESH_ROUTING_V1],
        },
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });

      const completion = share.complete().then(
        () => "no-error",
        (error: Error) => error.name,
      );
      await adapter.writeFile(
        `/relay/handshake/${share.qrPayload.handshakeId}/scanner-pub.json`,
        JSON.stringify({ pub: "capability-free-scanner" }),
      );
      const error = await completion;
      const paths = Object.keys(adapter.dump());
      return {
        error,
        wroteCredentials: paths.some((path) => path.endsWith("/credentials.json")),
      };
    });

    expect(result.error).toBe("UnsupportedPairingCapabilityError");
    expect(result.wroteCredentials).toBe(false);
  });

  test("required join generator rejects a capability-free scanner session", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR, runScannerHandshake, INDIRECT_MESH_ROUTING_V1 } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const adapter = new MemoryAdapter();
      const join = await generateJoinQR({
        adapter,
        relayBase: "/relay",
        capabilities: {
          supported: [INDIRECT_MESH_ROUTING_V1],
          required: [INDIRECT_MESH_ROUTING_V1],
        },
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });
      const capabilityFreePayload = {
        intent: join.qrPayload.intent,
        handshakeId: join.qrPayload.handshakeId,
        generatorPub: join.qrPayload.generatorPub,
      };

      const [generator, scanner] = await Promise.allSettled([
        join.credentials,
        runScannerHandshake(
          adapter,
          capabilityFreePayload,
          { remotePath: "/mesh", passphrase: null },
          "/relay",
          { pollIntervalMs: 10, timeoutMs: 5_000 },
        ),
      ]);
      return {
        generatorStatus: generator.status,
        generatorError: generator.status === "rejected" ? (generator.reason as Error).name : "none",
        scannerStatus: scanner.status,
      };
    });

    expect(result.generatorStatus).toBe("rejected");
    expect(result.generatorError).toBe("UnsupportedPairingCapabilityError");
    expect(result.scannerStatus).toBe("fulfilled");
  });

  test("Cloudflare adapter exposes configured capabilities without putting them in QR config", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { INDIRECT_MESH_ROUTING_V1 } = await import("/packages/core/dist/index.js");
      const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
      const adapter = new CloudflareAdapter({
        baseUrl: "/io/bootstrap",
        pairingCapabilities: {
          supported: [INDIRECT_MESH_ROUTING_V1],
          required: [INDIRECT_MESH_ROUTING_V1],
        },
      });
      return {
        pairingCapabilities: adapter.getPairingCapabilities(),
        handshakeConfig: JSON.parse(adapter.getHandshakeConfig()),
      };
    });

    expect(result.pairingCapabilities).toEqual({
      supported: ["mesh-routing:indirect:v1"],
      required: ["mesh-routing:indirect:v1"],
    });
    expect(result.handshakeConfig).toEqual({ baseUrl: "/io/bootstrap" });
  });
});

// ─── ECDH helpers ────────────────────────────────────────────────────

test.describe("ECDH keypair helpers", () => {
  test("generateECDHKeypair produces extractable P-256 keypair", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateECDHKeypair } = await import("/packages/core/dist/handshake/index.js");
      const { publicKey, privateKey } = await generateECDHKeypair();
      return {
        pubAlgo: publicKey.algorithm.name,
        privAlgo: privateKey.algorithm.name,
        privUsages: privateKey.usages,
      };
    });
    expect(result.pubAlgo).toBe("ECDH");
    expect(result.privAlgo).toBe("ECDH");
    expect(result.privUsages).toContain("deriveKey");
  });

  test("exportECDHPublicKey / importECDHPublicKey round-trip", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateECDHKeypair, exportECDHPublicKey, importECDHPublicKey } =
        await import("/packages/core/dist/handshake/index.js");
      const { publicKey } = await generateECDHKeypair();
      const exported = await exportECDHPublicKey(publicKey);
      const reExported = await exportECDHPublicKey(await importECDHPublicKey(exported));
      return { match: exported === reExported };
    });
    expect(result.match).toBe(true);
  });

  test("two keypairs produce different public keys", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateECDHKeypair, exportECDHPublicKey } =
        await import("/packages/core/dist/handshake/index.js");
      const a = await exportECDHPublicKey((await generateECDHKeypair()).publicKey);
      const b = await exportECDHPublicKey((await generateECDHKeypair()).publicKey);
      return a === b;
    });
    expect(result).toBe(false);
  });

  test("ECDH shared secret is symmetric", async ({ page }) => {
    const result = await page.evaluate(async () => {
      function hexFrom(b: ArrayBuffer): string {
        return Array.from(new Uint8Array(b))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
      }
      const { generateECDHKeypair, exportECDHPublicKey, importECDHPublicKey } =
        await import("/packages/core/dist/handshake/index.js");
      const kpA = await generateECDHKeypair();
      const kpB = await generateECDHKeypair();
      const pubA = await importECDHPublicKey(await exportECDHPublicKey(kpA.publicKey));
      const pubB = await importECDHPublicKey(await exportECDHPublicKey(kpB.publicKey));
      const bitsAB = await crypto.subtle.deriveBits(
        { name: "ECDH", public: pubB },
        kpA.privateKey,
        256,
      );
      const bitsBA = await crypto.subtle.deriveBits(
        { name: "ECDH", public: pubA },
        kpB.privateKey,
        256,
      );
      return hexFrom(bitsAB) === hexFrom(bitsBA);
    });
    expect(result).toBe(true);
  });
});

// ─── Share flow: generator has credentials, scanner joins ────────────

test.describe("generateShareQR + handleScannedQR (share flow)", () => {
  test("scanner receives correct remotePath and passphrase", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, handleScannedQR } = await import("/packages/core/dist/index.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const passphrase = await keyToPassphrase(await generateKey());

      const share = await generateShareQR({
        adapter,
        relayBase: "/",
        remotePath: "/team-alpha",
        passphrase,
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });

      const [, received] = await Promise.all([
        share.complete(),
        handleScannedQR({
          adapter,
          relayBase: "/",
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

    expect(result.remotePath).toBe("/team-alpha");
    expect(result.passphraseMatch).toBe(true);
    expect(result.intent).toBe("share");
  });

  test("unencrypted mesh — scanner receives remotePath, passphrase is null", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, handleScannedQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const share = await generateShareQR({
        adapter,
        relayBase: "/",
        remotePath: "/plain-team",
        passphrase: null,
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });

      const [, received] = await Promise.all([
        share.complete(),
        handleScannedQR({
          adapter,
          relayBase: "/",
          payload: share.qrPayload,
          pollIntervalMs: 50,
          timeoutMs: 10_000,
        }),
      ]);

      return { remotePath: received!.remotePath, hasPassphrase: received!.passphrase !== null };
    });

    expect(result.remotePath).toBe("/plain-team");
    expect(result.hasPassphrase).toBe(false);
  });

  test("relay files are cleaned up after share handshake", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR, handleScannedQR } = await import("/packages/core/dist/index.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const passphrase = await keyToPassphrase(await generateKey());
      const share = await generateShareQR({
        adapter,
        relayBase: "/",
        remotePath: "/cleanup-test",
        passphrase,
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });
      const { handshakeId } = share.qrPayload;

      await Promise.all([
        share.complete(),
        handleScannedQR({
          adapter,
          relayBase: "/",
          payload: share.qrPayload,
          pollIntervalMs: 50,
          timeoutMs: 10_000,
        }),
      ]);

      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      const files = adapter.dump();
      const relayFiles = Object.keys(files).filter((k) => k.includes(`handshake/${handshakeId}`));
      return { relayFiles };
    });

    expect(result.relayFiles).toHaveLength(0);
  });

  test("share times out if scanner never appears", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR } = await import("/packages/core/dist/index.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const share = await generateShareQR({
        adapter: new MemoryAdapter(),
        relayBase: "/",
        remotePath: "/timeout",
        passphrase: await keyToPassphrase(await generateKey()),
        pollIntervalMs: 50,
        timeoutMs: 200,
      });
      try {
        await share.complete();
        return "no-error";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(result).toContain("timed out");
  });
});

// ─── Join flow: generator wants credentials, scanner pushes them ─────

test.describe("generateJoinQR + handleScannedQR (join flow)", () => {
  test("generator receives correct credentials pushed by scanner", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR, handleScannedQR } = await import("/packages/core/dist/index.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const passphrase = await keyToPassphrase(await generateKey());

      const join = await generateJoinQR({
        adapter,
        relayBase: "/",
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });

      // Scanner (has credentials) scans the join QR and pushes credentials
      await handleScannedQR({
        adapter,
        relayBase: "/",
        payload: join.qrPayload,
        ownCredentials: { remotePath: "/team-bravo", passphrase },
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

    expect(result.remotePath).toBe("/team-bravo");
    expect(result.passphraseMatch).toBe(true);
    expect(result.intent).toBe("join");
  });

  test("join flow unencrypted mesh — generator receives remotePath, null passphrase", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR, handleScannedQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const join = await generateJoinQR({
        adapter,
        relayBase: "/",
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });

      await handleScannedQR({
        adapter,
        relayBase: "/",
        payload: join.qrPayload,
        ownCredentials: { remotePath: "/open-team", passphrase: null },
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });

      const received = await join.credentials;
      return { remotePath: received.remotePath, hasPassphrase: received.passphrase !== null };
    });

    expect(result.remotePath).toBe("/open-team");
    expect(result.hasPassphrase).toBe(false);
  });

  test("join times out if scanner never appears", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const join = await generateJoinQR({
        adapter: new MemoryAdapter(),
        relayBase: "/",
        pollIntervalMs: 50,
        timeoutMs: 200,
      });
      try {
        await join.credentials;
        return "no-error";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(result).toContain("timed out");
  });

  test("handleScannedQR throws if ownCredentials missing for join QR", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR, handleScannedQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const join = await generateJoinQR({ adapter: new MemoryAdapter(), relayBase: "/" });
      try {
        await handleScannedQR({
          adapter: new MemoryAdapter(),
          relayBase: "/",
          payload: join.qrPayload,
        });
        return "no-error";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(result).toContain("ownCredentials required");
  });
});

// ─── Security: wrong private key cannot decrypt ───────────────────────

test.describe("Security", () => {
  test("an unrelated private key cannot reproduce an existing scanner secret", async ({ page }) => {
    const result = await page.evaluate(async () => {
      function hex(b: ArrayBuffer): string {
        return Array.from(new Uint8Array(b))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
      }
      const { generateECDHKeypair, exportECDHPublicKey, importECDHPublicKey } =
        await import("/packages/core/dist/handshake/index.js");

      const generator = await generateECDHKeypair();
      const scanner = await generateECDHKeypair();
      const attacker = await generateECDHKeypair();

      const generatorPub = await importECDHPublicKey(
        await exportECDHPublicKey(generator.publicKey),
      );
      const scannerPub = await importECDHPublicKey(await exportECDHPublicKey(scanner.publicKey));

      // Legitimate shared secret
      const legitBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: scannerPub },
        generator.privateKey,
        256,
      );
      // A different scanner key creates a different ECDH session secret.
      const attackBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: generatorPub },
        attacker.privateKey,
        256,
      );

      return {
        legitimateHex: hex(legitBits).slice(0, 8),
        attackHex: hex(attackBits).slice(0, 8),
        differ: hex(legitBits) !== hex(attackBits),
      };
    });

    expect(result.differ).toBe(true);
  });

  test("each handshake gets a unique handshakeId", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const adapter = new MemoryAdapter();
      const base = { adapter, relayBase: "/", remotePath: "/m", passphrase: null };
      const a = await generateShareQR(base);
      const b = await generateShareQR(base);
      return { same: a.qrPayload.handshakeId === b.qrPayload.handshakeId };
    });
    expect(result.same).toBe(false);
  });
});

// ─── QR output shape ─────────────────────────────────────────────────

test.describe("QR output shape", () => {
  test("generateShareQR — payload contains required keys, no credentials", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateShareQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { qrPayload } = await generateShareQR({
        adapter: new MemoryAdapter(),
        relayBase: "/",
        remotePath: "/m",
        passphrase: null,
      });
      return Object.keys(qrPayload);
    });
    expect(result).toEqual(expect.arrayContaining(["intent", "handshakeId", "generatorPub"]));
    // No credentials, no passphrase
    expect(result).not.toContain("remotePath");
    expect(result).not.toContain("passphrase");
    // Only known keys present
    const allowed = ["intent", "handshakeId", "generatorPub", "adapterConfig"];
    expect(result.every((k: string) => allowed.includes(k))).toBe(true);
  });

  test("generateJoinQR — pairUrl null without pairBaseUrl", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateJoinQR } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { pairUrl, qrEncoded, qrPayload } = await generateJoinQR({
        adapter: new MemoryAdapter(),
        relayBase: "/",
      });
      return {
        pairUrl,
        intent: qrPayload.intent,
        encodedIsB64: /^[A-Za-z0-9_-]+$/.test(qrEncoded),
      };
    });
    expect(result.pairUrl).toBeNull();
    expect(result.intent).toBe("join");
    expect(result.encodedIsB64).toBe(true);
  });

  test("QR decoder is available through the public handshake subpath", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encodeQRPayload, decodeQRPayload } =
        await import("/packages/core/dist/handshake/qr-public.js");
      const payload = {
        intent: "share" as const,
        handshakeId: "hs_1",
        generatorPub: "pub_1",
        adapterConfig: "adapter",
      };
      return decodeQRPayload(encodeQRPayload(payload));
    });

    expect(result).toEqual({
      intent: "share",
      handshakeId: "hs_1",
      generatorPub: "pub_1",
      adapterConfig: "adapter",
    });
  });
});
