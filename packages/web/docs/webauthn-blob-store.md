# WebAuthn blob store reference

`@interocitor/web` exposes `WebAuthnBlobStore` for browser-managed custody of
arbitrary application blobs behind a WebAuthn ceremony.

Import from the package root:

```ts
import { WebAuthnBlobStore } from '@interocitor/web';
```

This is the low-level browser primitive to use when the app needs more than the
mesh credential record, for example:

- a record-seal key;
- a JWT signing key bundle;
- a wrapped group key;
- a per-device application secret.

It is not the authenticator's own private key. The browser/platform owns that
key and only exposes a read/write ceremony for the stored blob.

## Constructor

```ts
const store = new WebAuthnBlobStore(namespace, {
  rpId,
  displayName,
  authenticatorAttachment,
  userVerification,
});
```

## Options

| Option | Meaning |
| --- | --- |
| `rpId` | WebAuthn relying-party id. Defaults to the current hostname. |
| `displayName` | Human-readable app name shown in passkey / biometric prompts. Defaults to `Interocitor`. |
| `authenticatorAttachment` | Browser preference: `platform`, `cross-platform`, or `auto`. Defaults to `platform`. |
| `userVerification` | WebAuthn verification requirement. Default: `required`. |
| `hints` | Browser UI hints. `['hybrid']` asks for a phone-mediated flow when supported. |
| `transports` | Credential transport hints. `['hybrid']` narrows read/write ceremonies to hybrid-capable credentials. |

## Attachment preferences

| Preference | Use when |
| --- | --- |
| `platform` | The app wants same-device UX such as Touch ID / Face ID / Windows Hello. |
| `cross-platform` | The app wants a roaming or hybrid authenticator path, for example a security key or phone-mediated flow when supported. |
| `auto` | The app does not care which class the browser uses. |

`authenticatorAttachment` is a preference, not a guarantee. The browser owns the
final authenticator-selection UX.

## API

```ts
await store.save(bytes);
const bytes = await store.load();
const platformBytes = await store.load({ authenticatorAttachment: 'platform' });
const authenticator = await store.enrollAuthenticator(bytes, options);
const refs = store.listAuthenticators();
const hasPhoneHint = store.hasAuthenticator({
  authenticatorAttachment: 'cross-platform',
});
await store.clear();
```

- `save(bytes)` updates the first matching locally remembered credential, or
  enrolls a new one when none is remembered.
- `load()` runs a WebAuthn read ceremony and returns the stored bytes, or
  `null` when the assertion is cancelled by returning no credential or its
  extension result contains no blob. The browser may also reject the promise.
- `load({ authenticatorAttachment })` filters locally remembered credential
  references before the ceremony. With no matching references, the browser is
  still allowed to discover a resident credential.
- `enrollAuthenticator(bytes, options)` creates a new WebAuthn credential and
  writes the supplied blob into it. Cancellation and missing `largeBlob`
  support reject.
- `listAuthenticators()` returns the local credential-id registry for this
  namespace. The registry is a hint, not secret key material.
- `hasAuthenticator(options)` reports whether that local registry contains a
  matching hint; it does not query an authenticator.
- `clear()` removes the browser-side credential-id hint. It does not remotely
  wipe an authenticator-managed credential.

## Namespace model

One `WebAuthnBlobStore` instance corresponds to one protected namespace.
Create separate namespaces for separate application secrets:

```ts
const recordSealKey = new WebAuthnBlobStore('case-vault:record-seal-key', {
  authenticatorAttachment: 'platform',
});

const jwtSigner = new WebAuthnBlobStore('case-vault:jwt-signer', {
  authenticatorAttachment: 'cross-platform',
});
```

That is the supported pattern when the application wants to request different
biometric confirmations for different secrets.

## Cross-platform authenticator enrollment

Adding a phone in app UX usually means enrolling another cross-platform
WebAuthn credential for the same logical blob namespace:

```ts
const signer = new WebAuthnBlobStore('case-vault:jwt-signer', {
  displayName: 'Case Vault',
  authenticatorAttachment: 'cross-platform',
  hints: ['hybrid'],
  transports: ['hybrid'],
});

await signer.enrollAuthenticator(signingKeyBundleBytes, {
  authenticatorAttachment: 'cross-platform',
  hints: ['hybrid'],
  transports: ['hybrid'],
  label: 'Anton phone',
});
```

The app controls the namespace and blob contents. `hints: ['hybrid']` and
`transports: ['hybrid']` ask for the phone-mediated WebAuthn path. The browser
still controls the final ceremony and support matrix.

## Security and failure boundary

`WebAuthnBlobStore` stores application-supplied bytes in the `largeBlob`
extension. The authenticator's private WebAuthn credential key is not exposed
and does not become an application signing or encryption key. After a
successful read, the blob bytes enter JavaScript; same-origin malicious code
or XSS can access them while they are loaded.

The API requires a secure WebAuthn relying-party context (HTTPS, with localhost
development exceptions), browser `largeBlob` support, a compatible
authenticator, and successful user verification. Creation/assertion
cancellation, browser rejection, unsupported extensions, and a `written:
false` extension result are normal failure paths that applications must
surface or recover from.

All code blocks on this page are API fragments. The
[biometric-keys example](../../../examples/biometric-keys/README.md) supplies a
runnable browser page and setup commands.
