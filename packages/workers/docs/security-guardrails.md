# Cloudflare security guardrails

The Cloudflare Worker backend stores sync state and durable-file metadata in D1
and file bodies in its configured `FileBodyStore`. Built-in adapters support R2
and regional AWS S3.
Protected meshes reach both stores as client-encrypted payloads; routing and
operational metadata remain visible. Applications keep mesh keys on clients and
must supply request authentication and authorization.

## Scope

This document applies to the Cloudflare Workers backend in `@interocitor/workers`:

- row/change storage in **D1**;
- durable file/image storage metadata in **D1**;
- durable file/image bytes in the configured **`FileBodyStore`**, selected per
  mesh; the built-in implementations target R2 and regional AWS S3;
- optional realtime relay via Durable Objects.

It defines the package's storage, encryption, metadata, and access-control
boundaries.

## Executive summary

- **Interocitor encrypts application data on the client before upload** when the mesh is configured with a non-null `keySource`.
- **Cloudflare D1** stores row/change payloads, routing metadata, and durable-file metadata. Interocitor's application confidentiality does not depend on the platform storage layer.
- **The configured file-body store** holds durable file/image bodies. [R2 encrypts objects and object metadata at rest with Cloudflare-managed keys](https://developers.cloudflare.com/r2/reference/data-security/); AWS S3 encrypts new objects at rest and can use a configured customer-managed KMS key. Protected Interocitor files arrive at either built-in store as application ciphertext. A custom store owns its provider-level encryption contract.
- **The server cannot read protected application payloads** without the mesh key. That includes encrypted row data in D1 and encrypted file bytes in the configured file-body store.
- **Request access is application policy.** The host supplies AuthN/AuthZ through `meshMiddleware`, at the mesh-address level.
- **Simple key protection exists, but it is not document-level or row-level ACL.** The main protection is that data is useless without the client-held mesh key (or bound key components in the bound-shared-key scenario).

## What is stored where

### D1

D1 stores the backend's sync index and mailbox state. At a security-boundary
level, that means two classes of information:

1. **Application payload objects**
   - change objects and mainline snapshots;
   - protected meshes store those payloads as ciphertext, not plaintext business data.

2. **Operational metadata**
   - plaintext manifest contents such as mesh ID, schema version, epoch,
     watermark, writer, and encryption mode;
   - routing and lookup information needed to find mesh objects;
   - durable-file metadata needed to locate objects in the configured store;
   - counters, timestamps, sizes, and maintenance bookkeeping.

At the security boundary, D1 is a **ciphertext plus metadata store** for
protected meshes.

### Durable file-body store

The configured `FileBodyStore` stores durable file/image bytes. For protected
meshes, those objects are Interocitor-encrypted application payloads. The
built-in platforms also apply encryption at rest: R2 uses
[platform-managed encryption](https://developers.cloudflare.com/r2/reference/data-security/),
and S3 applies its bucket encryption configuration plus an optional
customer-managed KMS key supplied by the Worker.

The host constructs the store from trusted deployment configuration. Browser
input, request headers, file metadata, and `taint` do not select an endpoint or
supply shared provider credentials.

S3 selection changes only the durable body location. File paths, sizes,
classification, uploader, timestamps, access counters, and object keys remain
in D1. See [AWS S3 durable-file storage](s3-file-storage.md).

## Encryption layers

### Layer 1: storage infrastructure encryption

Cloudflare documents automatic encryption at rest for R2 objects and metadata,
using Cloudflare-managed AES-256 keys with GCM as the preferred mode, plus TLS
for transport. See [R2 data security](https://developers.cloudflare.com/r2/reference/data-security/).

[AWS documents automatic encryption at rest for S3
objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/serv-side-encryption.html).
When the `S3FileBodyStore` `kmsKeyId` option is configured, every PUT
explicitly requests SSE-KMS with that customer-managed key. The Worker sends S3
requests over TLS and authenticates them with Signature Version 4.

Platform encryption protects the storage service. It does not prevent Worker
code or an authorized storage principal from reading plaintext that an
application uploads as plaintext.

### Layer 2: Interocitor application encryption

Interocitor’s confidentiality model is application-level:

- the client derives the final mesh key from its configured `keySource`;
- rows/change payloads are encrypted before upload;
- durable file/image bytes can be encrypted before upload;
- the Worker stores ciphertext and metadata, not plaintext business data.

For security review, treat Cloudflare EAR/EIT as **baseline platform security** and Interocitor encryption as the **actual application confidentiality boundary**.

## What the server can and cannot read

### The server can read

The Worker and platform can read:

- request routing information and HTTP metadata;
- mesh lookup information;
- storage layout and object-location metadata;
- size, timing, and maintenance signals;
- file classification metadata when supplied by the client;
- client/device identifiers used for sync bookkeeping;
- plaintext manifest contents;
- whether a request was allowed or denied by Worker-side access checks.

### The server cannot read

For an encrypted mesh, the Worker cannot read:

- row field names and values inside encrypted payloads;
- encrypted change contents;
- encrypted mainline snapshots;
- encrypted durable file/image bytes;
- the final mesh key.

That statement assumes the mesh key is never sent to the server and the Worker is not modified to exfiltrate client key material.

## Access-control boundary

The Workers implementation supports application-defined mesh-level access.

### What exists

Two layers answer different questions:

- `meshIntegrityGates` decides whether an address designates a mesh;
- `meshMiddleware` decides what the current request may do with that mesh.

`createMeshAuthorizationMiddleware` applies `'none'`, `'readonly'`, `'full'`,
or `'deny'` decisions to both `/io/<address>` and `/notify/<address>`.

An integrity gate is not authorization. A named address such as `main` is
predictable and should have application-owned authorization middleware unless
it is intentionally public. A checksummed mesh ID rejects arbitrary or
unissued IDs, but anyone who learns a valid ID still needs authorization when
the mesh is protected. Verify credentials with your AuthN provider and make
the per-address permission decision in mesh middleware.

### What the package does not provide

The package does **not** provide:

- per-row ACLs;
- per-document ACLs enforced by the Worker;
- per-file recipient lists enforced by the Worker;
- server-side plaintext inspection for policy enforcement;
- revocation that can make already-exported plaintext unreadable.

So the right description is:

> The server model is mesh-level access gating plus client-side key
> protection, not fine-grained server-enforced data access control.

## Complementary controls: asymmetric keys and Cloudflare WARP

These controls can improve the deployment posture, but they play different roles.
They should not be described as replacements for application encryption.

### Asymmetric keys

Asymmetric keys are an **identity and key-distribution tool**.

Their role is to help answer questions like:

- who is this client or device;
- which client should receive key material;
- whether access was issued to a known public identity;
- whether a portable key component can be delivered without exposing it to every participant.

Their impact:

- they can reduce accidental broad sharing of key material;
- they can make grants more auditable because access is issued to named public identities;
- they can support future recipient-specific or device-specific access models;
- they do **not** by themselves make the Worker able to enforce document-level ACL without a corresponding access model;
- they do **not** prevent an authorized client from decrypting and exporting plaintext.

For this Cloudflare deployment, asymmetric keys should be described as improving
**key distribution and recipient identity**, not as changing what D1 or the
file-body store can see. Those stores still hold ciphertext plus metadata; clients
still hold or derive the material required to decrypt protected data.

### Cloudflare WARP / Zero Trust access

Cloudflare WARP and Zero Trust controls are **network and device-access controls**.

Their role is to help answer questions like:

- is the request coming from an enrolled device;
- is the user/device allowed to reach this Worker endpoint;
- should this network path be available outside a managed environment;
- can access be limited by organization policy before the Worker handles the request.

Their impact:

- they can reduce public exposure of the Worker endpoint;
- they can add device posture, identity-provider, and organization-policy gates;
- they can make abuse and anonymous access less likely;
- they do **not** decrypt or re-encrypt Interocitor payloads;
- they do **not** create row/document/file ACL inside the encrypted mesh;
- they do **not** change the database-dump analysis: a dump is still protected by client-held key material, not by WARP.

For this Cloudflare deployment, WARP should be described as improving
**who can reach the backend**, not **who can read data after they have ciphertext
and key material**.

## "Simple key protection" — what it means

Mesh-key protection makes possession of storage alone insufficient.

A copy of D1 plus the selected file-body-store objects does **not** reveal protected
application data without the client-held mesh key material.

Depending on configuration:

- in the **portable shared key** scenario, a copied portable key plus dump is sufficient to read the mesh;
- in the **bound shared key** scenario, a copied portable component plus dump is still insufficient without the bound secret.

See [Shared key scenarios](../../core/docs/shared-key-scenarios.md) for the exact distinction.

This is key protection. It is useful and real. But it is **not** the same thing as document-level authorization.

## Guardrails for product and compliance language

Use language like this:

- **Correct:** "The Worker stores encrypted application payloads in D1 and the configured file-body store. Interocitor encrypts protected application data on the client before upload."
- **Correct:** "The server cannot read protected row/file contents without client-held mesh key material."
- **Correct:** "The implementation provides mesh-level access gating, not fine-grained server-enforced ACL."
- **Incorrect:** "The server has no access to any data."
- **Incorrect:** "Cloudflare cannot see any metadata."
- **Incorrect:** "Interocitor enforces per-document access control on the backend."
- **Incorrect:** "Provider encryption at rest means application administrators cannot access object contents."

## Auditor notes

For SOC or similar review, the important statements are:

1. **Application confidentiality boundary**
   - Protected business payloads are encrypted by the client before storage in D1 and the selected file-body store.

2. **Platform encryption boundary**
   - Platform storage controls complement application encryption; they do not replace client-held mesh keys.

3. **Metadata exposure**
   - The backend still sees operational metadata: routing, lookup, size, timing, file classification, device bookkeeping, and maintenance signals.

4. **Server access-control scope**
   - Application middleware enforcement is request/mesh-address scoped, not record/document scoped.

5. **Residual risk**
   - A legitimate client with the right key material can decrypt and export plaintext.
   - In the portable shared key scenario, copied portable key material plus stored ciphertext is enough for offline read access.

## Recommended product guardrails

For a Cloudflare backend deployment:

- treat D1 and the selected file-body store as **ciphertext + metadata stores**, not as trusted confidentiality boundaries by themselves;
- do not claim document-level or row-level backend ACL unless you actually add it;
- do not store plaintext business data in D1 or the file-body store for meshes that are supposed to be confidential;
- keep the file-body-store selection stable for each mesh and migrate bodies before changing it;
- do not describe S3 body placement as whole-mesh residency while D1 metadata and sync objects remain on Cloudflare;
- document whether you use the portable shared key or bound shared key scenario for each product surface;
- review whether routing, lookup, size, timing, file classification, and device-bookkeeping metadata are acceptable leakage for your compliance posture.

## References

- Root security model: [packages/core/docs/security-model.md](../../core/docs/security-model.md)
- Shared key scenarios: [packages/core/docs/shared-key-scenarios.md](../../core/docs/shared-key-scenarios.md)
- Cloudflare Workers runtime: [README.md](../README.md)
- Cloudflare R2 platform encryption: [R2 data security](https://developers.cloudflare.com/r2/reference/data-security/)
- AWS S3 server-side encryption: [Protecting data with server-side encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/serv-side-encryption.html)
- AWS S3 file-body setup: [Store durable file bodies in AWS S3](s3-file-storage.md)
