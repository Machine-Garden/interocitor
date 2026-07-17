# How to use multiple biometric-protected keys

This guide shows how to map app security labels onto browser custody primitives:

- stored security: `browserStorage`;
- protected security: `webauthnPlatform`;
- enforced security: `webauthnCrossPlatform` plus the hybrid hint/transport.

The same app can use different levels for different secrets.

## 1. Stored security as browser storage

Use stored security when the app only needs durable browser persistence:

```ts
import { createWebSecretStore } from '@interocitor/web';

const draftKeyStore = createWebSecretStore('case-vault:draft-key');
await draftKeyStore.save(draftKeyBytes);
```

This is the default. It stores bytes in localStorage and does not prompt for
biometric confirmation.

## 2. Protected security as platform WebAuthn

Use protected security when the app wants device-local biometric/passkey custody:

```ts
const recordSealKeyStore = createWebSecretStore('case-vault:record-seal-key', {
  custody: 'webauthnPlatform',
  displayName: 'Case Vault',
});

await recordSealKeyStore.save(recordSealKeyBytes);
```

This provisions or reads a platform authenticator such as Touch ID, Face ID, or
Windows Hello.

## 3. Enforced security as cross-platform WebAuthn

Use enforced security when the app requires a phone / roaming authenticator:

```ts
const signerStore = createWebSecretStore('case-vault:jwt-signer', {
  custody: 'webauthnCrossPlatform',
  displayName: 'Case Vault',
});

await signerStore.save(signingKeyBundleBytes);
```

This provisions or reads only a cross-platform WebAuthn credential. If no phone
or hybrid credential has been enrolled yet, `load()` returns `null`.

## 4. Add phone

Adding a phone is an app-level name for enrolling another cross-platform
authenticator:

```ts
await signerStore.enrollAuthenticator(signingKeyBundleBytes, {
  authenticatorAttachment: 'cross-platform',
  hints: ['hybrid'],
  transports: ['hybrid'],
  label: 'Anton phone',
});

const authenticators = signerStore.listAuthenticators();
```

The browser owns the actual ceremony. Interocitor requests
`authenticatorAttachment: 'cross-platform'`, `hints: ['hybrid']`, and
`transports: ['hybrid']`; on supported browsers this is where a phone-mediated
passkey flow should appear.

## 5. Keep mesh credential custody separate

Use `createWebCredentialStore(...)` for Interocitor mesh credentials:

```ts
import { createWebCredentialStore } from '@interocitor/web';

const credentialStore = createWebCredentialStore('case-vault', {
  storage: 'passkey',
  displayName: 'Case Vault',
  authenticatorAttachment: 'platform',
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
} from '@interocitor/core';

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
  await signerStore.save(new TextEncoder().encode(JSON.stringify({
    privateKeyPkcs8: await exportPrivateKey(privateKey),
    publicKeySpki: await exportPublicKey(publicKey),
  })));
}

const token = await signToken(privateKey, {
  sub: 'device-42',
  scope: 'records:seal',
});
```

## Example

See the runnable browser page in
[examples/biometric-keys/index.html](/Users/akorzunov/dev/github/interocitor/examples/biometric-keys/index.html).
