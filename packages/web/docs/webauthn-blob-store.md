# WebAuthn blob store reference

`@interocitor/web` exposes `WebAuthnBlobStore` for browser-managed custody of
arbitrary application blobs behind a WebAuthn ceremony.

Import from the package root:

```ts
import { WebAuthnBlobStore } from "@interocitor/web";
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

| Option                    | Meaning                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `rpId`                    | WebAuthn relying-party id. Defaults to the current hostname.                                          |
| `displayName`             | Human-readable app name shown in passkey / biometric prompts. Defaults to `Interocitor`.              |
| `authenticatorAttachment` | Browser preference: `platform`, `cross-platform`, or `auto`. Defaults to `platform`.                  |
| `userVerification`        | WebAuthn verification requirement. Default: `required`.                                               |
| `hints`                   | Browser UI hints. `['hybrid']` asks for a phone-mediated flow when supported.                         |
| `transports`              | Credential transport hints. `['hybrid']` narrows read/write ceremonies to hybrid-capable credentials. |
| `upgradeLegacyBlobs`      | Re-frame an untagged blob with the current namespace header when one is read. Defaults to `true`.     |

## Attachment preferences

| Preference       | Use when                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `platform`       | The app wants same-device UX such as Touch ID / Face ID / Windows Hello.                                                |
| `cross-platform` | The app wants a roaming or hybrid authenticator path, for example a security key or phone-mediated flow when supported. |
| `auto`           | The app does not care which class the browser uses.                                                                     |

`authenticatorAttachment` is a preference, not a guarantee. The browser owns the
final authenticator-selection UX.

## API

```ts
await store.save(bytes);
const bytes = await store.load();
const platformBytes = await store.load({ authenticatorAttachment: "platform" });
const authenticator = await store.enrollAuthenticator(bytes, options);
const refs = store.listAuthenticators();
const hasPhoneHint = store.hasAuthenticator({
  authenticatorAttachment: "cross-platform",
});
const tagged = await store.loadTagged();
const report = await store.clear();
```

- `save(bytes)` updates the first matching locally remembered credential, or
  enrolls a new one when none is remembered. The payload is always written
  framed with this namespace's header (see [Blob framing](#blob-framing)).
- `load()` runs a WebAuthn read ceremony and returns the stored bytes. It
  returns `null` **only** for the absent case: the ceremony completed and the
  credential holds no blob for this namespace. A ceremony that could not
  complete — declined, cancelled, timed out, unsupported, or no credential
  offered — throws `CredentialUnavailableError`; bytes that cannot be
  interpreted as this namespace's blob throw `CredentialUnreadableError`. A
  caller must not treat either throw as "nothing stored".
- `loadTagged()` is `load()` plus the on-disk format: `format: "legacy"` means
  the blob predates namespace tagging.
- `load({ authenticatorAttachment })` filters locally remembered credential
  references before the ceremony. If the filter matches nothing but the
  namespace has any remembered reference, the unfiltered set is still sent as
  `allowCredentials`: the read is never widened to _any_ discoverable
  credential for the relying party while a reference is known. Only a namespace
  with no remembered reference at all (a cleared `localStorage`, say) falls back
  to discovery, and the namespace header then catches a mismatched credential.
- `enrollAuthenticator(bytes, options)` creates a new WebAuthn credential and
  writes the supplied blob into it. Cancellation and missing `largeBlob`
  support reject.
- `listAuthenticators()` returns the local credential-id registry for this
  namespace. The registry is a hint, not secret key material.
- `hasAuthenticator(options)` reports whether that local registry contains a
  matching hint; it does not query an authenticator.
- `clear()` destroys as much as the platform allows and resolves with a
  `WebAuthnClearResult`. See [Clearing](#clearing).

## Blob framing

Every blob this store writes is framed:

```
"IOCB" | version:u8 | namespaceLength:u16be | namespace | payload
```

`load()` verifies the namespace on the way out. Without the header a read that
fell back to discovery could be satisfied by any resident credential for the
relying party — including one enrolled by another namespace, such as the
`<dbName>:envelope-key` credential `WebAuthnEnvelopeKeyProvider` uses — and the
caller would receive another namespace's bytes where its own were expected.

A blob written before framing existed has no header. It is accepted rather than
rejected, so an existing deployment keeps working, and it is re-framed in place
during that same read (disable with `upgradeLegacyBlobs: false`). Because an
untagged blob cannot be proven to belong to the namespace that asked for it,
callers should still validate the payload they get back; both
`WebAuthnCredentialStore` and the v2 credential envelope do.

## Clearing

WebAuthn gives script no way to delete a credential, and no way to delete its
`largeBlob`. **`clear()` therefore cannot destroy the passkey.** What it does:

1. Runs a write ceremony per locally remembered credential that replaces the
   stored blob with an empty framed blob, after which `load()` reports absent.
   This prompts for user verification once per credential.
2. Removes the local credential-id hint and registry.

It resolves with a report rather than throwing:

| Field              | Meaning                                                      |
| ------------------ | ------------------------------------------------------------ |
| `overwritten`      | Credential ids whose blob was emptied.                       |
| `notOverwritten`   | Credential ids whose write ceremony failed.                  |
| `knownCredentials` | How many local references existed when `clear()` started.    |
| `hintsCleared`     | Whether the local hints were removed.                        |
| `residualRisk`     | `credential-only`, `blob-may-survive`, or `unknown` (below). |
| `message`          | A sentence suitable for showing the user.                    |

| `residualRisk`     | What survives                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential-only`  | Every known blob was emptied. An empty passkey shell remains in the OS keychain; only the user can remove it, in operating-system or browser passkey settings. |
| `blob-may-survive` | At least one write ceremony failed, so readable secret bytes may still sit in that credential.                                                                 |
| `unknown`          | No local reference existed, so nothing could be addressed. A passkey enrolled before `localStorage` was cleared may still hold a readable blob.                |

`WebAuthnCredentialStore.clear()` keeps core's `Promise<void>` signature and
throws `ResidualWebAuthnCredentialError` (carrying the same result) for
`blob-may-survive` only; use its `clearWithReport()` for the full report.

Tell the user to remove the passkey in OS or browser settings whenever the
residual risk is anything other than nothing — which, on this platform, is
always.

## Namespace model

One `WebAuthnBlobStore` instance corresponds to one protected namespace.
Create separate namespaces for separate application secrets:

```ts
const recordSealKey = new WebAuthnBlobStore("case-vault:record-seal-key", {
  authenticatorAttachment: "platform",
});

const jwtSigner = new WebAuthnBlobStore("case-vault:jwt-signer", {
  authenticatorAttachment: "cross-platform",
});
```

That is the supported pattern when the application wants to request different
biometric confirmations for different secrets.

## Cross-platform authenticator enrollment

Adding a phone in app UX usually means enrolling another cross-platform
WebAuthn credential for the same logical blob namespace:

```ts
const signer = new WebAuthnBlobStore("case-vault:jwt-signer", {
  displayName: "Case Vault",
  authenticatorAttachment: "cross-platform",
  hints: ["hybrid"],
  transports: ["hybrid"],
});

await signer.enrollAuthenticator(signingKeyBundleBytes, {
  authenticatorAttachment: "cross-platform",
  hints: ["hybrid"],
  transports: ["hybrid"],
  label: "Anton phone",
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
