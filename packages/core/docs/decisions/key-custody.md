# Device key custody

A device must be able to use its mesh key on every session and to hand it to a
new device when asked. It must not leave the key lying where a generic attack
can pick it up and leave with it. Interocitor keeps the usable key and the
shareable key in different forms, and only the first is ever handed out.

Status: decided, not yet implemented. Current behaviour is documented in
[Credential store](../credential-store.md).

## Threat model

| Attacker                                                                                                              | In scope | What custody can deny                                    |
| --------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------- |
| Generic script in the app origin: storage and token harvesters, generic malicious extensions, pasted console snippets | Yes      | Carrying the key away for use after the script stops     |
| Script written against Interocitor's internals                                                                        | No       | Nothing. It can call the same code the application calls |
| A copy of the browser profile taken from disk                                                                         | No       | Out of scope; local rows are plaintext there regardless  |

Any script in the origin is an authorized runtime: while it runs, it can use
the key and read every row. Custody cannot change that. What custody can
change is duration. A key read as a string from `localStorage` is permanent
access from anywhere. A key held only as a non-extractable `CryptoKey` is
access through the victim's page, for as long as the script keeps running
there.

## Decision

1. **Usable key.** A device persists the mesh key only as a non-extractable
   AES-GCM `CryptoKey`, together with its non-extractable HKDF twin, in
   IndexedDB. Both are stored in one record.
2. **No raw key in browser storage.** No credential mode that this decision
   governs writes the portable key, in any encoding, to `localStorage`,
   `sessionStorage`, or a readable IndexedDB field.
3. **Local escrow.** The portable key is kept on the device encrypted under a
   **device wrap key**: a random, non-extractable AES-GCM key generated on the
   device, never derived from the mesh key, stored in the same IndexedDB
   database. The escrow is
   `AES-GCM(deviceWrapKey, portableKey, aad = "interocitor:key-escrow:" + meshId)`.
   Reading the mesh and reading the escrow therefore require two different
   keys.
4. **One reveal path.** The engine reveals the portable key only through
   `keySource.revealPortableKey({ purpose })`, where `purpose` is `pair`,
   `recovery`, or `export`. It returns a `Promise<string | null>`. The
   application may install `onRevealPortableKey(purpose)`, which can show a
   confirmation, require a passkey gesture, or refuse. The engine does not keep
   the revealed string after the call returns.
5. **Session memory.** During a session the engine holds the `CryptoKey`, never
   the portable key string. The string exists only inside a reveal, inside a
   join, and inside a bound source's `derive()` call.
6. **Join.** Pairing and recovery keep their current wire formats. The joining
   device decrypts the envelope, imports the key as non-extractable, writes
   the usable record and the escrow, and drops the string in the same call.
7. **Bound sources.** `BoundSharedKeySource` escrows its portable component the
   same way and still calls `derive()` on every connect, unwrapping the escrow
   for the duration of that call. Persisting the derived key in place of
   calling `derive()` is opt-in per source, because it bypasses the
   application's binding policy.
8. **Mesh anchor.** The `meshId` anchor and the `deviceId` stay in the same
   IndexedDB record as plaintext metadata. They are not secrets.
9. **Fail closed.** If IndexedDB is blocked, unreadable, or was cleared by the
   browser, the store reports `unavailable` or `unreadable`, never `absent`.
   Only an explicit `clear()` or a store that never held a record may report
   `absent`.
10. **Remote escrow is not the primary copy.** An encrypted escrow published in
    the mesh may be added later as a backup, republished by refill from the
    local escrow. It never replaces the local escrow.

## Why the decision is correct

**The two keys answer two different questions.** The usable key answers "may
this page read the mesh now?", and every call in a session needs it. The
portable key answers "may another device join?", which happens a few times in
a mesh's life. Holding both in one string, as the default store does today,
gives every harvester the rarer, more powerful capability at the price of the
common one.

**A generic dump yields nothing portable.** A script that serializes storage
gets `CryptoKey` handles it cannot export, a ciphertext, and a wrap key it
cannot export. To get the portable key it must call `unwrap` against
Interocitor's escrow format with the right AAD, which is the definition of an
attack written against Interocitor.

**The wrap key must be independent of the mesh key.** If the escrow were
encrypted under a key derived from the mesh key, then anything able to read the
mesh could open it: access to the mesh would already be access to the
portable key. A second, random key is what makes "can read rows" and "can
reveal the key" different capabilities.

**The escrow belongs on the device.** A device that has only the non-extractable
key cannot recreate the portable key from it. If the only escrow lived in the
mailbox, an eviction or a move to another backend would remove it, and no
surviving device could rebuild it: invites and new recovery phrases would be
gone for good. Local escrow survives eviction, works offline, and needs no
mailbox or adapter change.

**Wire formats stay.** `unwrapKey` would let a joining device import without a
JS string, but it requires new pairing and recovery formats, and JS strings
cannot be zeroed anyway. Decrypt, import, and drop gives the same practical
result.

## Implementation ownership

| Concern                                                         | Owner                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| IndexedDB record: usable key, twin, wrap key, escrow, anchors   | `packages/web/src/credential-store.ts`                                 |
| Twin re-registration after load (`registerDerivationTwin`)      | `packages/core/src/crypto/encryption.ts`                               |
| Stored-credential record shape                                  | `packages/core/src/storage/credential-store.ts`                        |
| `revealPortableKey`, escrow unwrap, `derive()` input            | `packages/core/src/crypto/key-source.ts`                               |
| Session state without `passphrase`, conflict check, persistence | `packages/core/src/core/sync-engine.ts`                                |
| Pairing and recovery callers                                    | `packages/core/src/handshake/`, `packages/core/src/crypto/recovery.ts` |
| Sub-store credentials                                           | `packages/core/src/core/connected-stores.ts`                           |

## Record contract

One IndexedDB record per credential namespace:

| Field         | Type                                   | Meaning                                          |
| ------------- | -------------------------------------- | ------------------------------------------------ |
| `meshKey`     | `CryptoKey` (AES-GCM, non-extractable) | The usable key                                   |
| `meshKeyTwin` | `CryptoKey` (HKDF, non-extractable)    | Derivation base for file seals and paths         |
| `wrapKey`     | `CryptoKey` (AES-GCM, non-extractable) | Device wrap key, random per device               |
| `escrow`      | `{ iv, ciphertext }`                   | Portable key under `wrapKey`, AAD binds `meshId` |
| `keyId`       | `string`                               | Fingerprint for conflict checks (below)          |
| `deviceId`    | `string`                               | Device identity                                  |
| `meshId`      | `string \| undefined`                  | Mesh anchor, written once the manifest is known  |

`CryptoKey` objects round-trip through IndexedDB structured clone in Chromium,
Firefox, and WebKit and keep their non-extractable flag. A loaded key is a new
object, so the twin registry, which is keyed by object identity, must be told
about it: the store calls `registerDerivationTwin(meshKey, meshKeyTwin)` after
every load. The registry stays on its `globalThis` symbol, because several
copies of the package in one realm must see each other's twins.

`keyId` replaces today's string comparison of portable keys when the engine
checks an explicit key against a stored one. It is an HMAC-SHA-256 over the
fixed label `interocitor:key-id`, keyed by a key derived from the twin, so it
identifies the key without revealing it. An escrow whose AAD `meshId` differs
from the record's anchor is refused.

## Invalid substitutions

- **Encrypting the escrow under a key derived from the mesh key.** Read access
  to the mesh becomes reveal access. See "The wrap key must be independent".
- **Remote escrow as the only copy.** Eviction or a backend move destroys it,
  and no device can rebuild it.
- **Keeping `this.passphrase` for the session and wrapping only at rest.** A
  smaller change that leaves the portable key in engine memory, readable by any
  script holding the engine object.
- **Caching a bound source's derived key by default.** Skips the binding
  policy the application chose a bound source to enforce.
- **Moving the twin registry to module scope.** Breaks keys that cross copies
  of the package and hides nothing a designed attack needs.
- **Reporting `absent` when IndexedDB is unavailable.** The engine would mint
  a new key and split the device from its mesh.

## Consequences

- `keySource.getPortableKey()`, which returns the string synchronously, is
  replaced by `revealPortableKey({ purpose })`. Pairing and recovery examples
  call the reveal.
- Sub-store credentials, which `connected-stores.ts` keeps as plaintext JSON
  in local metadata, move to the same record shape. Otherwise a generic
  IndexedDB dump still yields portable keys.
- `localStorage`, `sessionStorage`, and `memory` modes remain for applications
  that choose them; the default `createWebCredentialStore` moves to IndexedDB
  custody. `passkey` and `envelope` modes keep their own gates and use the
  usable-key record for the session.
- Existing `localStorage` and envelope records are converted on first load:
  read, import, write the IndexedDB record, read it back, then delete the old
  record. The old record is deleted only after the new one reads back.
- Safari may clear IndexedDB for a site after seven days without interaction.
  That is the same exposure as `localStorage` today: the device must re-pair
  or recover.

## Failure modes

| Condition                                   | Behaviour                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| IndexedDB blocked or unavailable            | `unavailable`; connect fails closed, no key is minted                  |
| Record present, escrow fails to decrypt     | Usable key still works; reveal fails with `CredentialPersistenceError` |
| Escrow AAD `meshId` differs from the anchor | Reveal refused; the record is treated as conflicting                   |
| Twin missing after load                     | Derivation fails closed; the record is treated as `unreadable`         |
| `onRevealPortableKey` refuses               | Reveal resolves `null`; pairing and recovery creation stop             |
| Conversion interrupted before read-back     | Old record kept; conversion retries on next load                       |
