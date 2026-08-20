<p align="center">
  <a href="https://github.com/Machine-Garden/interocitor">
    <img src="../../docs/assets/hero.svg" alt="Interocitor" width="560" />
  </a>
</p>

# Biometric-protected keys

Runnable browser example for application-owned secret custody with
`@interocitor/web`.

It demonstrates three app labels mapped to concrete browser primitives:

- **stored:** exported key bytes encoded into `localStorage`;
- **protected:** an exported AES-GCM record key stored in a
  platform-preferred WebAuthn `largeBlob`;
- **enforced:** an exported signing-key bundle stored in a
  cross-platform-preferred `largeBlob`, with an explicit add-authenticator
  action and hybrid hints.

These labels belong to this example; they are not browser security levels or a
guarantee that a specific phone/biometric UX will appear.

## Run the public repository release

From the repository root:

```bash
yarn install
yarn build:int
yarn build:web
node tools/webdav-server/server.mjs --mode=memory
```

Open:

<http://127.0.0.1:4173/examples/biometric-keys/index.html>

The commands are complete and runnable. The loopback server is the repository's
unauthenticated development server; it also serves source files below the
repository root and must not be exposed or deployed.

The page imports the built workspace outputs:

- `/packages/web/dist/index.js`
- `/packages/core/dist/index.js`

Rebuild those packages after changing their source.

## Browser requirements

- a secure WebAuthn context (localhost is accepted for development);
- WebAuthn `largeBlob` support;
- a compatible platform or cross-platform authenticator;
- a browser/platform ceremony the user completes successfully.

Attachment and hybrid values are requests to the browser, not enforcement that
a phone, biometric sensor, or particular authenticator is used. Cancellation,
unsupported `largeBlob`, and a failed blob write are expected error paths.

## Try the flows

1. Provision the stored key and observe that no ceremony occurs.
2. Provision the platform-preferred seal key, seal the sample record, and
   unseal it through another ceremony.
3. Provision the cross-platform signer and sign/verify sample claims.
4. Choose **Add phone** to request another cross-platform authenticator for the
   same signing bundle.

## Security boundary

`localStorage` is not secret storage: the stored bytes are base64-encoded, not
encrypted, and same-origin JavaScript can read them.

WebAuthn stores the **exported application key bytes** in `largeBlob`. The
authenticator's private WebAuthn credential key is never exposed and is not the
AES or token-signing key. After a successful read ceremony, the exported
application key exists in JavaScript memory; XSS or malicious same-origin code
can use or export it then.

The local authenticator registry contains credential-ID hints, labels, and
timestamps. Clearing it does not revoke a passkey or prove secure erasure from
an authenticator.

This example is a custody demonstration, not a complete identity, key-rotation,
token-validation, recovery, or threat-response system.

## Validate the source

The example has a syntax check, not an automated cross-browser WebAuthn test:

```bash
node --check examples/biometric-keys/app.js
```

WebAuthn behavior still requires manual validation on each supported
browser/authenticator combination.
