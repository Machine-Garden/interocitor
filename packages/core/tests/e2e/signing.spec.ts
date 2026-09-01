import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/core/tests/e2e/fixtures/harness-plain.html");
});

test.describe("asymmetric signing", () => {
  test("sign/verify raw bytes and round-trip exported keys", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const {
        generateSigningKeypair,
        exportPublicKey,
        importPublicKey,
        exportPrivateKey,
        importPrivateKey,
        sign,
        verify,
      } = await import("/packages/core/dist/crypto/signing.js");

      const { privateKey, publicKey } = await generateSigningKeypair();
      const data = new TextEncoder().encode("attest this payload");
      const signature = await sign(privateKey, data);

      // Verify with the original public key.
      const okOriginal = await verify(publicKey, data, signature);

      // Verify after exporting/importing the public key (the publish/consume path).
      const pub = await importPublicKey(await exportPublicKey(publicKey));
      const okImported = await verify(pub, data, signature);

      // Tampered data fails.
      const tampered = await verify(
        pub,
        new TextEncoder().encode("attest this payloaX"),
        signature,
      );

      // A different keypair fails.
      const other = await generateSigningKeypair();
      const okOther = await verify(other.publicKey, data, signature);

      // Re-sign with an imported private key; original public key still verifies.
      const priv = await importPrivateKey(await exportPrivateKey(privateKey));
      const sig2 = await sign(priv, data);
      const okResigned = await verify(pub, data, sig2);

      return { okOriginal, okImported, tampered, okOther, okResigned };
    });

    expect(result.okOriginal).toBe(true);
    expect(result.okImported).toBe(true);
    expect(result.tampered).toBe(false);
    expect(result.okOther).toBe(false);
    expect(result.okResigned).toBe(true);
  });

  test("signToken/verifyToken carry claims, reject tampering, and honor expiry", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { generateSigningKeypair, exportPublicKey, importPublicKey, signToken, verifyToken } =
        await import("/packages/core/dist/crypto/signing.js");

      const { privateKey, publicKey } = await generateSigningKeypair();
      const pub = await importPublicKey(await exportPublicKey(publicKey));

      const token = await signToken(
        privateKey,
        { sub: "device-1", scope: "read" },
        { expiresInSeconds: 60 },
      );
      const claims = await verifyToken(pub, token);

      // Tamper the claims segment → verify returns null.
      const [head, sig] = token.split(".");
      const forgedClaims = btoa(JSON.stringify({ sub: "admin", scope: "write" }))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const forged = `${forgedClaims}.${sig}`;
      const forgedResult = await verifyToken(pub, forged);

      // Wrong key → null.
      const other = await generateSigningKeypair();
      const wrongKey = await verifyToken(other.publicKey, token);

      // Expired token → null when checked, claims when expiry check disabled.
      const expired = await signToken(
        privateKey,
        { sub: "device-1" },
        { issuedAt: 1000, expiresInSeconds: 1 },
      );
      const expiredChecked = await verifyToken(pub, expired);
      const expiredUnchecked = await verifyToken(pub, expired, { checkExpiry: false });

      return {
        sub: claims?.sub,
        scope: claims?.scope,
        hasIat: typeof claims?.iat === "number",
        hasExp: typeof claims?.exp === "number",
        forgedResult,
        wrongKey,
        expiredChecked,
        expiredUncheckedSub: expiredUnchecked?.sub,
        head,
      };
    });

    expect(result.sub).toBe("device-1");
    expect(result.scope).toBe("read");
    expect(result.hasIat).toBe(true);
    expect(result.hasExp).toBe(true);
    expect(result.forgedResult).toBeNull();
    expect(result.wrongKey).toBeNull();
    expect(result.expiredChecked).toBeNull();
    expect(result.expiredUncheckedSub).toBe("device-1");
  });
});
