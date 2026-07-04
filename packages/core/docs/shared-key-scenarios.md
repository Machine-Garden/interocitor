# Shared key scenarios

This document describes the shared-key encryption scenarios Interocitor supports
or is expected to support. It is written for implementers and security/SOC
reviewers: it states which keys exist, where they may be stored, what the remote
can observe, and what isolation each scenario provides.

The scenarios can coexist. A product may use the current portable shared key for
one mesh, a bound shared key for another mesh, or both during migration. The
transport used to obtain a key component can also differ by client runtime: a web
client may use WebAuthn, a native client may use an OS keychain, and a managed
client may use a backend-issued session secret.

## Definitions

| Term | Meaning |
| --- | --- |
| Remote / database dump | The mailbox contents: manifests, change files, snapshots, durable files, and any access-control metadata stored remotely. |
| Mesh key | The final AES-GCM key used by the engine to decrypt encrypted changes, snapshots, and durable files. |
| Portable key component | Copyable high-entropy key material that can be transferred between users/devices. |
| Bound secret | A less-portable secret obtained from a device, passkey, OS keychain, backend session, native app integration, or app-controlled provider. |
| Key transport | The mechanism used to deliver or obtain a portable component or bound secret. Examples: QR pairing, backend API, passkey PRF, WebAuthn largeBlob, native keychain, manual key entry. |

Interocitor encryption protects payload contents from the remote storage
operator. It does not make a malicious authorized client safe: a client that can
read plaintext can copy plaintext.

## Scenario 1: portable shared key

Status: current implemented model.

In this scenario, possession of the portable key component is possession of the
mesh capability.

```text
portable key component -> mesh key
mesh key -> AES-GCM decrypts mesh data
```

### Data and key placement

| Item | Stored in database dump? | Stored locally? | Notes |
| --- | --- | --- | --- |
| Encrypted rows/files | Yes | Optional cache | Remote sees ciphertext and metadata. |
| Portable key component | No | Depends on credential store | Browser default may persist the credential record locally unless configured otherwise. |
| Access-control metadata | Not required | App-specific | The shared key itself is the read capability. |

### Isolation properties

| Attacker has | Can decrypt? | Reason |
| --- | --- | --- |
| Database dump only | No | Payloads are AES-GCM encrypted. |
| Database dump + copied portable key component | Yes | The portable key component derives the decrypting mesh key in this scenario. |
| Local device compromise | Usually yes | Local stores may contain plaintext cache or loaded keys. |
| Authorized client runtime | Yes | Authorized clients can read plaintext. |

### Operational notes for auditors

- Encryption boundary: before data leaves the client, change payloads,
  snapshots, and durable files are AES-GCM encrypted with the mesh key.
- The remote stores no mesh key or portable key component by protocol.
- Remote-visible metadata remains visible: paths, file names, sizes, timestamps,
  manifest fields, and device ids. See the security model for the full metadata
  list.
- Revocation requires creating a new mesh/key and migrating data. Removing a
  copied key from an untrusted party is not possible cryptographically.

## Scenario 2: bound shared key

Status: target design / use case. Same shared-key semantics, but the final mesh
key is one step less shared.

The database is still encrypted by one shared mesh key. The difference is that
clients do not normally store or transfer the final mesh key. They derive it from
a portable key component plus a bound secret.

```text
portable key component + bound secret + mesh context -> mesh key
mesh key -> AES-GCM decrypts mesh data
```

A database dump plus the portable key component is not enough. The attacker also
needs the bound secret or a live client that can obtain it.

### Data and key placement

| Item | Stored in database dump? | Stored locally / by client? | Notes |
| --- | --- | --- | --- |
| Encrypted rows/files | Yes | Optional cache | Same AES-GCM payload encryption as Scenario 1. |
| Portable key component | No, unless the app stores an encrypted envelope remotely | Depends on app transport | Can be delivered by pairing, backend, manual entry, or recipient wrapping. |
| Bound secret | No | Runtime-specific | Examples: passkey PRF output, WebAuthn largeBlob secret, OS keychain secret, backend session secret, memory-only provider. |
| Final mesh key | No | In memory while engine is open | Should be treated as non-exportable by application policy where possible. |
| Derivation metadata | Yes | Also local | Non-secret metadata: version, mode, algorithm, salt id, mesh id, epoch, provider hints. |

### Key derivation shape

The protocol shape should be explicit and versioned:

```text
meshKey = KDF(
  portableKeyComponent,
  boundSecret,
  context = {
    purpose: "interocitor.mesh-key",
    version,
    meshId,
    derivationEpoch,
    clientBindingMode
  }
)
```

The exact KDF/API can evolve, but the security requirement is stable: the final
mesh key must not be recoverable from the database dump plus the portable key
component alone.

### Client-specific key transport

Different clients can implement the bound-secret transport differently while
producing the same final mesh key for the same mesh and derivation epoch.

| Client/runtime | Possible bound-secret source | Notes |
| --- | --- | --- |
| Browser | WebAuthn PRF | Preferred passkey-style derivation when available; no raw bound secret needs to be stored as a blob. |
| Browser | WebAuthn largeBlob | Practical fallback; stores or retrieves a secret associated with a platform credential. |
| Browser | Memory/session provider | Useful for tests, demos, or apps that obtain the secret from an external session. |
| iOS/macOS | Keychain / Secure Enclave-backed key | Native package can provide the bound secret without WebAuthn. |
| Android | Android Keystore-backed key | Native package can provide the bound secret without WebAuthn. |
| Managed web app | Backend session secret | Database dump and copied portable component are insufficient without live backend authorization; less offline. |

The transport is not the encrypted-data format. It is a way to obtain one input
to mesh-key derivation.

### Coexistence and migration

Scenario 1 and Scenario 2 can coexist by versioning key derivation metadata.

```text
keyMode: "portable-shared-key" | "bound-shared-key"
derivationVersion: 1
meshId: ...
derivationEpoch: ...
bindingMode: "none" | "webauthn-prf" | "webauthn-largeblob" | "native-keychain" | "backend-session" | ...
```

A product can support:

- old meshes using Scenario 1;
- new meshes using Scenario 2;
- migration meshes where an authorized client decrypts with Scenario 1 and
  writes into a new Scenario 2 mesh;
- multiple client runtimes using different transports, provided they agree on
  the same derivation contract for the mesh.

### Isolation properties

| Attacker has | Can decrypt? | Reason |
| --- | --- | --- |
| Database dump only | No | Payloads are AES-GCM encrypted. |
| Database dump + portable key component | No | Missing bound secret. |
| Database dump + bound secret only | No | Missing portable key component. |
| Database dump + portable component + bound secret | Yes | Together they derive the mesh key. |
| Authorized client runtime | Yes | Authorized clients can derive/read plaintext. |
| User intentionally exports plaintext | Yes | Cryptography cannot prevent plaintext sharing by an authorized user. |
| User intentionally exports final mesh key | Yes | Application policy should avoid exposing/exporting the final mesh key. |

### What this scenario improves

Scenario 2 makes copied/delegated key material less useful offline. A user who
shares only the portable component has not shared the final decrypting key. A
database dump plus that component is insufficient without the bound-secret
transport.

### What this scenario does not solve

- It does not prevent an authorized user from copying plaintext.
- It does not protect against malware or injected code running in the authorized
  client after key derivation.
- It does not provide per-file or per-row access control by itself. The mesh is
  still shared-key encrypted.
- It does not provide revocation without re-keying/migration once the final mesh
  key or plaintext has been exposed.

## Algorithm placement

Core owns portable, interoperable encryption and derivation formats:

- AES-GCM payload encryption;
- versioned envelope formats;
- KDF/derivation inputs and outputs;
- ECDH or other protocol-level key wrapping if a transport uses public keys;
- scenario metadata and validation.

Runtime packages own key custody and transport:

- browser `localStorage`, `sessionStorage`, IndexedDB, WebAuthn PRF, and
  WebAuthn largeBlob live in `@interocitor/web`;
- native keychain/Secure Enclave/Keystore integration should live in the native
  runtime package;
- backend session secret retrieval belongs to the app/backend integration.

## Auditor framing

For SOC or security review, evaluate each deployment against four questions:

1. **Where is ciphertext produced?** Interocitor encrypts row and durable-file payloads on the client before upload.
2. **Who can derive the final mesh key?** In Scenario 1, anyone with the portable shared key. In Scenario 2, only a client that has both the portable key component and the bound secret.
3. **What does a database dump reveal by itself?** It reveals metadata in the manifest and path layout, but not row or file plaintext. In Scenario 2, a dump plus the portable key component is still insufficient without the bound secret.
4. **What remains outside the encryption boundary?** Manifest metadata, device identifiers in paths, timing, sizes, local plaintext cache, and any plaintext a legitimate client exports.

## Auditor checklist

For a SOC/security review, document these controls per deployment:

1. **Encryption enabled:** the mesh is configured with a non-null `keySource`.
2. **Payload cipher:** AES-GCM with 256-bit mesh key for changes, snapshots, and
   durable files.
3. **Remote key absence:** the database/remote stores ciphertext and non-secret
   derivation metadata, not the mesh key or raw bound secret.
4. **Credential custody:** identify the credential store or bound-secret provider
   used by each client runtime.
5. **Key mode:** state whether the mesh uses Scenario 1 portable shared key or
   Scenario 2 bound shared key.
6. **Transport variance:** list which clients use passkey PRF, largeBlob,
   keychain, backend session, memory, or another provider.
7. **Metadata exposure:** acknowledge visible remote metadata: paths, object
   names, sizes, timestamps, manifests, and device identifiers.
8. **Revocation model:** explain that revocation of exposed shared keys requires
   re-keying/migration; authorized users can still copy plaintext.
9. **Local compromise boundary:** local caches and in-memory derived keys are in
   the trusted client boundary.
10. **Migration plan:** if both scenarios coexist, document key-mode versioning
    and how clients select the correct derivation path.
