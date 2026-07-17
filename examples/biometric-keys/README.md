# Biometric-protected keys

Focused browser example for `@interocitor/web` application key custody.

It demonstrates three app security labels mapped to `createWebSecretStore`
custody primitives:

- stored security: key bytes in localStorage;
- protected security: a platform passkey/biometric key used to seal and unseal
  a record;
- enforced security: a phone/cross-platform credential used to hold a
  signing-key bundle for JWT-shaped tokens.

The enforced flow includes an explicit `Add phone` action backed by
`enrollAuthenticator(...)` with cross-platform WebAuthn and hybrid hints.

Open:

- `http://127.0.0.1:4173/examples/biometric-keys/index.html`

The page imports from the built local package outputs:

- `/packages/web/dist/index.js`
- `/packages/core/dist/index.js`

So build the packages before opening the example.
