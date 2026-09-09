# Shared key scenarios

`@interocitor/core` supports portable and bound shared-key contracts. Both
produce the AES-GCM mesh key on the client, but they assign key custody and
database-dump exposure differently. Choose between them by deciding who may
hold each key component and which guarantees the application must enforce.

Both contracts protect row changes, snapshots, and durable files by producing
the AES-GCM mesh key on the client. Neither contract protects plaintext from
code running inside an authorized client, and neither provides per-row or
per-file authorization.

## Terms

| Term             | Meaning                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Database dump    | Remote manifests, change objects, snapshots, durable files, recovery wrappers, and server-visible metadata.             |
| Mesh key         | The AES-GCM key used to encrypt and decrypt mesh payloads.                                                              |
| Portable key     | Copyable, high-entropy base58 material stored or transferred between trusted clients.                                   |
| Bound secret     | Application-owned material obtained from a passkey, keychain, backend session, native integration, or another provider. |
| Credential store | Optional client store from which a key source loads and persists portable mesh credentials.                             |

## Portable shared key

Choose `PortablePassphraseKeySource` when every trusted client may hold the
same portable key. The source accepts a supplied portable key, can load one
from its credential store, and can generate one when the engine creates a new
encrypted mesh.

```text
portable key -> mesh key -> AES-GCM payload encryption
```

The portable key is the read capability. The engine maps its generated base58
value to 32 bytes; it is not a human password and is not strengthened with a
password KDF. Generate it with Interocitor or another cryptographically secure
source.

A portable key is not bound to a mesh. One key may open many meshes at many
remote paths, which suits a product that splits its work into meshes opened on
demand; the cost is that one leaked key opens all of them. The bound contract
below receives the remote path and mesh ID when it derives, so it can yield a
distinct key per mesh from one application secret.

| Attacker has                    | Can decrypt a protected dump? | Reason                                                                                                      |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Database dump only              | No                            | Payloads are encrypted and the portable key is absent.                                                      |
| Database dump plus portable key | Yes                           | The portable key supplies the mesh key in this contract.                                                    |
| Credential-store contents       | Depends                       | Browser storage may contain the portable key; an enveloped or WebAuthn store changes that custody boundary. |
| Authorized client runtime       | Yes                           | The client must be able to read plaintext to use the application.                                           |

An application can publish a recovery wrapper containing an encrypted copy of
the portable key and connection details. Recovery restores the same
capability; it does not add revocation. See [Recovery phrases](recovery.md).

## Application-bound shared key

Choose `BoundSharedKeySource` when the application must supply additional
key material or policy before a client can derive the mesh key. The source
loads the portable component, then calls the application-provided `derive`
function with:

- `dbName`, `remotePath`, `meshId`, and `deviceId` context;
- the portable key loaded from the constructor or credential store.

The application returns `MeshKeyMaterial`. It owns the bound-secret
provider, derivation algorithm, availability behavior, prompts, and any
versioning metadata. Interocitor does not standardize or persist a bound
secret, passkey mode, derivation epoch, or backend-session protocol.

This partial configuration illustrates the ownership boundary; the
`appKeyProvider` and `deriveAesGcmKey` functions belong to the host
application.

```ts
const keySource = new BoundSharedKeySource({
  portableKey,
  credentialStore,
  async derive({ portableKey, ...context }) {
    const boundSecret = await appKeyProvider.load(context);
    return {
      encrypted: true,
      key: await deriveAesGcmKey(portableKey, boundSecret, context),
      portableKey,
    };
  },
});
```

If the application derives the key from both a portable component and a bound
secret, possession of only one input is insufficient. That isolation is a
property of the supplied `derive` implementation, not an automatic
guarantee of `BoundSharedKeySource`: a callback that ignores the bound
secret provides no additional protection.

| Attacker has                     | Can decrypt a protected dump? | Condition                                                  |
| -------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Database dump only               | No                            | The returned mesh key is absent.                           |
| Dump plus portable component     | Application-defined           | No, only if `derive` requires unavailable bound material.  |
| Dump plus bound secret           | Application-defined           | No, only if `derive` also requires the portable component. |
| Every input accepted by `derive` | Yes                           | The callback can reproduce the mesh key.                   |
| Authorized client runtime        | Yes                           | The callback has returned usable mesh key material.        |

Failed or unavailable bound-secret retrieval rejects the application's
`derive` callback. The host must decide whether that should block opening,
retry, prompt the user, or fall back; silently returning an unencrypted result
would change the mesh encryption contract.

## Choosing between them

| Need                                                     | Key source                                       | Important boundary                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Offline-capable sharing with one transferable secret     | `PortablePassphraseKeySource`                    | Anyone who copies the portable key can decrypt the mesh.                                                             |
| App-controlled derivation that requires another provider | `BoundSharedKeySource`                           | Security and availability depend on the application's `derive` implementation.                                       |
| Restore a lost portable key from a recorded phrase       | Portable source plus recovery wrapper            | The remote wrapper permits offline phrase guesses and does not revoke recovered keys.                                |
| Any other recovery design                                | `BoundSharedKeySource` plus host-supplied inputs | The host's inputs and their custodians are the entire defense; Interocitor does not provide or verify them.          |
| Per-user, per-row, or per-file access enforcement        | Neither by itself                                | Use application policy and separate cryptographic/data models; one shared mesh key remains a shared read capability. |

The credential-store choice is separate from the key-source choice. Browser
memory, session storage, local storage, WebAuthn, and encrypted envelopes
change where portable material rests; they do not change what the remote
payload encryption protects. See [Credential store](credential-store.md).

## Auditor checklist

For each deployed mesh, record:

1. Which key source is configured and whether encryption can ever be disabled.
2. Where the portable key is generated, transferred, and persisted.
3. For `BoundSharedKeySource`, every input used by `derive` and which
   system owns each input.
4. Whether a database dump plus copied portable material is sufficient to
   reproduce the mesh key.
5. Which remote metadata remains visible; see the
   [security model](security-model.md).
6. How loss and compromise are handled. Exposed shared key material requires a
   new mesh and data migration; an authorized client can always export
   plaintext.
