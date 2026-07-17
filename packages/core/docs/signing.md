# Signing (identity without identity)

Signing proves *who* produced a record and that it was *not altered* — without
accounts, login, or a central authority. A private key signs; the matching
public key verifies. Anyone can hold the public key and **check** a signature,
but only the private-key holder can **make** one.

That asymmetry is "identity without identity." In a shared chore list, a parent
signs the "allowance paid" record with their private key. Every device in the
mesh verifies it against the parent's published public key, yet a child cannot
forge a signed record — they do not hold the private key. Authority comes from a
key, not a server, so the mesh stays peer-to-peer and offline-first.

Signing is separate from the mesh key (symmetric AES-GCM, confidentiality) and
from the pairing channel (ECDH key agreement). Signed payloads are **not
secret** — they are *trustworthy*. Anyone holding the public key can read and
verify them.

- Algorithm: **ECDSA P-256 / SHA-256** (ES256), fixed. No algorithm
  negotiation, so a token cannot be downgraded.
- Import path: `@interocitor/core/crypto/signing` (also re-exported from the
  package root, `@interocitor/core`).

## Keys

```ts
import {
  generateSigningKeypair,
  exportPublicKey, importPublicKey,
  exportPrivateKey, importPrivateKey,
} from '@interocitor/core/crypto/signing';

const { privateKey, publicKey } = await generateSigningKeypair();

const pub = await exportPublicKey(publicKey);   // base64url SPKI — safe to publish
const priv = await exportPrivateKey(privateKey); // base64url PKCS#8 — keep secret
```

Public keys are SPKI; private keys are PKCS#8. Both round-trip through the
matching `import*` function. Treat the private key like the mesh passphrase:
custody is the caller's responsibility.

In browser apps, `@interocitor/web` can hold that exported private-key blob
behind a WebAuthn ceremony via `WebAuthnBlobStore` when signing should require
biometric or passkey confirmation.

## Raw bytes

```ts
import { sign, verify } from '@interocitor/core/crypto/signing';

const data = new TextEncoder().encode('chore-42:approved');
const signature = await sign(privateKey, data);     // base64url, P-1363 r||s
const ok = await verify(publicKey, data, signature); // boolean
```

`verify` returns `false` (never throws) on a bad signature or malformed input.

## Tokens (JWT-shaped, on our terms)

A compact token is `base64url(claims).base64url(signature)`. The signed bytes
are exactly the encoded-claims segment — there is no JOSE header to tamper
with, and the algorithm is never read from the token.

```ts
import { signToken, verifyToken } from '@interocitor/core/crypto/signing';

// Parent signs an approval record. Claims are any JSON your app controls.
const token = await signToken(privateKey, { task: 'chore-42', status: 'approved' });

const record = await verifyToken(publicKey, token);
// → { iat, task: 'chore-42', status: 'approved' }  or  null
```

- `signToken` always adds `iat` (epoch seconds) and adds `exp` when
  `expiresInSeconds` is set (use it for grants that should expire). Override the
  clock with `issuedAt`.
- `verifyToken` returns the claims object, or `null` if the signature is
  invalid, the token is malformed, or it has expired. Expiry checking is on by
  default; disable with `{ checkExpiry: false }` or allow skew with
  `{ toleranceSeconds }`.

## Where this fits

Use signing whenever some records must be **trusted to a specific author** even
though every device can write to the mesh: a parent approving a chore, a
moderator marking a post resolved, a device attesting "I produced this." The
verifier trusts the *key*, not a login.

Pick the right tool for the goal:

- **Trust who wrote public data** → sign it here. (Readable by all, forgeable by
  none.)
- **Hide data from some members** → seal it under an extra key
  ([Tainted files](tainted-files.md)).
- **Grant read access to encrypted data** → wrap a content key for a recipient
  with the pairing channel's ECDH primitives
  ([Shared key scenarios](shared-key-scenarios.md)).

Signing and sealing compose: a parent can sign a record *and* seal an
attachment, so it is both forgery-proof and readable only by the intended
group.
