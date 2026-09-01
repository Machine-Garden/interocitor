# How to use multiple browser-custodied keys

This guide shows how to map app custody labels onto browser custody primitives:

- stored: `browserStorage`;
- protected: `webauthnPlatform`;
- enforced: `webauthnCrossPlatform` plus the hybrid hint/transport.

The same app can request different custody preferences for different secrets.

## 1. Stored label: browser storage

Use the stored label when the app only needs durable browser persistence:

```ts
import { createWebSecretStore } from "@interocitor/web";

const draftKeyStore = createWebSecretStore("case-vault:draft-key");
await draftKeyStore.save(draftKeyBytes);
```

This is the default. It stores bytes in localStorage and does not prompt for
biometric confirmation.

## 2. Protected label: platform WebAuthn preference

Use the protected label when the app wants device-local biometric/passkey custody:

```ts
const recordSealKeyStore = createWebSecretStore("case-vault:record-seal-key", {
  custody: "webauthnPlatform",
  displayName: "Case Vault",
});

await recordSealKeyStore.save(recordSealKeyBytes);
```

This asks the browser to provision or read a platform authenticator such as
Touch ID, Face ID, or Windows Hello. The browser may satisfy required user
verification with another platform-approved method.

## 3. Enforced label: cross-platform WebAuthn preference

Use the enforced label when the app wants the browser to prefer a phone or
roaming authenticator:

```ts
const signerStore = createWebSecretStore("case-vault:jwt-signer", {
  custody: "webauthnCrossPlatform",
  displayName: "Case Vault",
});

await signerStore.save(signingKeyBundleBytes);
```

This requests a cross-platform WebAuthn credential. If no local credential
reference matches, `load()` omits `allowCredentials` and lets the browser run a
discoverable-credential ceremony. It may prompt, reject, return a blob, or
return `null` when the assertion or `largeBlob` result contains no blob; `null`
is not a reliable “no phone enrolled” signal.

## 4. Request another authenticator

Adding a phone is an app-level name for enrolling another cross-platform
authenticator:

```ts
await signerStore.enrollAuthenticator(signingKeyBundleBytes, {
  authenticatorAttachment: "cross-platform",
  hints: ["hybrid"],
  transports: ["hybrid"],
  label: "Anton phone",
});

const authenticators = signerStore.listAuthenticators();
```

The browser owns the actual ceremony. Interocitor requests
`authenticatorAttachment: 'cross-platform'`, `hints: ['hybrid']`, and
`transports: ['hybrid']`; on supported browsers this is where a phone-mediated
passkey flow should appear.

`listAuthenticators()` and `hasAuthenticator(...)` inspect only the
browser-side credential-reference registry. They do not enumerate or revoke
credentials held by an authenticator.

## 5. Keep mesh credential custody separate

Use `createWebCredentialStore(...)` for Interocitor mesh credentials:

```ts
import { createWebCredentialStore } from "@interocitor/web";

const credentialStore = createWebCredentialStore("case-vault", {
  storage: "passkey",
  displayName: "Case Vault",
  authenticatorAttachment: "platform",
});
```

That store protects the Interocitor credential record (`portableKey`,
`deviceId`, `meshId`). It is not a generic signing-key API.

## 6. JWT signing

Use a separate namespace for a signing-key bundle.

The stored blob can be a JSON bundle that contains:

- an exported PKCS#8 private key;
- the corresponding SPKI public key.

The application then loads the bundle only when it needs to sign:

```ts
import {
  exportPrivateKey,
  exportPublicKey,
  generateSigningKeypair,
  importPrivateKey,
  importPublicKey,
  signToken,
} from "@interocitor/core";

const stored = await signerStore.load();
let privateKey;
let publicKey;

if (stored) {
  const bundle = JSON.parse(new TextDecoder().decode(stored));
  privateKey = await importPrivateKey(bundle.privateKeyPkcs8);
  publicKey = await importPublicKey(bundle.publicKeySpki);
} else {
  const created = await generateSigningKeypair();
  privateKey = created.privateKey;
  publicKey = created.publicKey;
  await signerStore.save(
    new TextEncoder().encode(
      JSON.stringify({
        privateKeyPkcs8: await exportPrivateKey(privateKey),
        publicKeySpki: await exportPublicKey(publicKey),
      }),
    ),
  );
}

const token = await signToken(privateKey, {
  sub: "device-42",
  scope: "records:seal",
});
```

This is a partial application fragment: the app must define serialization,
rotation, JWT claims, verification policy, and failure handling. The exported
PKCS#8 bytes are the application signing key and enter JavaScript after the
WebAuthn ceremony; the authenticator's private WebAuthn credential key is not
used to sign this JWT.

## Security boundary

- `browserStorage` persists plaintext/base64 application bytes that same-origin
  script can read.
- WebAuthn `largeBlob` custody requires a supported browser, relying-party
  context, authenticator, and successful ceremony.
- WebAuthn protects retrieval at rest, but the loaded bytes exist in
  JavaScript. XSS or malicious same-origin code can use or export them while
  available.
- `clear()` removes local credential hints; it does not revoke a passkey or
  securely erase authenticator-managed storage.

## Example

See the [runnable biometric-keys example](../../../examples/biometric-keys/README.md).
