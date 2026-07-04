# Cloudflare security guardrails

This document explains the current security model of the Cloudflare Workers implementation in plain language, with emphasis on what Cloudflare stores, what Interocitor encrypts itself, and what the current implementation does **not** provide.

## Scope

This document applies to the Cloudflare Workers backend in `@interocitor/workers`:

- row/change storage in **D1**;
- durable file/image storage metadata in **D1**;
- durable file/image bytes in **R2**;
- optional realtime relay via Durable Objects.

It describes the implementation as it exists today. It is not a roadmap and not a promise of future access-control features.

## Executive summary

- **Interocitor encrypts application data on the client before upload** when the mesh is configured with a non-null `keySource`.
- **Cloudflare D1** stores row/change payloads and file metadata. D1 itself provides encryption at rest managed by Cloudflare, but Interocitor treats that as infrastructure protection, not as application confidentiality. citeturn1search0
- **Cloudflare R2** stores durable file/image objects. R2 encrypts objects and object metadata at rest with Cloudflare-managed keys, and Interocitor can store already-encrypted bytes there on top of that. citeturn0view1
- **The server cannot read protected application payloads** without the mesh key. That includes encrypted row data in D1 and encrypted file bytes in R2.
- **The current implementation does not provide fine-grained server-enforced data access control.** Access is controlled at the mesh/prefix level by possession of the right mesh secret material and any Worker-side access token checks.
- **Simple key protection exists, but it is not document-level or row-level ACL.** The main protection is that data is useless without the client-held mesh key (or bound key components in the bound-shared-key scenario).

## What is stored where

### D1

D1 stores the backend's sync index and mailbox state. At a security-boundary
level, that means two classes of information:

1. **Application payload objects**
   - row/change/mainline/manifest payloads for the mesh;
   - protected meshes store encrypted payloads, not plaintext business data.

2. **Operational metadata**
   - routing and lookup information needed to find mesh objects;
   - durable-file metadata needed to locate objects in R2;
   - counters, timestamps, sizes, and maintenance bookkeeping.

Do not document the D1 schema field-by-field in this guardrails document. The
schema may change, but the security boundary should remain stable: D1 is a
**ciphertext plus metadata store** for protected meshes.

### R2

R2 stores durable file/image object bytes. For protected meshes, treat those
objects as Interocitor-encrypted application payloads stored inside R2. R2 still
applies Cloudflare-managed encryption at rest underneath. citeturn0view1turn1search0

## Encryption layers

### Layer 1: Cloudflare infrastructure encryption

Cloudflare documents that:

- **D1** provides encryption at rest and TLS-secured transport inside the Cloudflare environment. citeturn1search0
- **R2** encrypts stored objects and object metadata at rest with Cloudflare-managed AES-256-GCM keys, and uses TLS for transport. citeturn0view1

This protects against infrastructure-level storage exposure, disk theft, and similar classes of risk. It does **not** mean Cloudflare or Worker code cannot access plaintext that your application sends unencrypted.

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
- whether a request was allowed or denied by Worker-side access checks.

### The server cannot read

For an encrypted mesh, the Worker cannot read:

- row field names and values inside encrypted payloads;
- encrypted change contents;
- encrypted mainline/manifests where protected by mesh encryption;
- encrypted durable file/image bytes;
- the final mesh key.

That statement assumes the mesh key is never sent to the server and the Worker is not modified to exfiltrate client key material.

## Access control: what exists today

The current Workers implementation has **access checks**, but not rich data ACLs.

### What exists

The Worker has request-level access gates such as:

- prefix validation based on mesh id / mesh secret derivation;
- optional bearer-token style checks through runtime hooks like `hasAccess` / `hasSystemAccess`;
- upload authorization hooks for stored files.

These controls decide whether a request may operate on a mesh/prefix or system endpoint.

### What does not exist

The current implementation does **not** provide:

- per-row ACLs;
- per-document ACLs enforced by the Worker;
- per-file recipient lists enforced by the Worker;
- server-side plaintext inspection for policy enforcement;
- revocation that can make already-exported plaintext unreadable.

So the right description is:

> The current server model is mesh-level access gating plus client-side key protection, not fine-grained server-enforced data access control.

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
**key distribution and recipient identity**, not as changing what D1/R2 can see.
D1/R2 still store ciphertext plus metadata; clients still hold or derive the
material required to decrypt protected data.

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

The main protection today is that possession of storage alone is insufficient.

A database dump of D1 and R2 does **not** reveal protected application data without the client-held mesh key material.

Depending on configuration:

- in the **portable shared key** scenario, a copied portable key plus dump is sufficient to read the mesh;
- in the **bound shared key** scenario, a copied portable component plus dump is still insufficient without the bound secret.

See [Shared key scenarios](../packages/core/docs/shared-key-scenarios.md) for the exact distinction.

This is key protection. It is useful and real. But it is **not** the same thing as document-level authorization.

## Guardrails for product and compliance language

Use language like this:

- **Correct:** "Cloudflare stores encrypted application payloads in D1 and R2. Interocitor encrypts protected application data on the client before upload."
- **Correct:** "The server cannot read protected row/file contents without client-held mesh key material."
- **Correct:** "The current implementation provides mesh-level access gating, not fine-grained server-enforced ACL."
- **Incorrect:** "The server has no access to any data."
- **Incorrect:** "Cloudflare cannot see any metadata."
- **Incorrect:** "Interocitor currently enforces per-document access control on the backend."
- **Incorrect:** "R2 encryption at rest means application administrators cannot access object contents."

## Auditor notes

For SOC or similar review, the important statements are:

1. **Application confidentiality boundary**
   - Protected business payloads are encrypted by the client before storage in D1/R2.

2. **Platform encryption boundary**
   - D1 and R2 also apply Cloudflare-managed encryption at rest and TLS in transit. citeturn1search0turn0view1

3. **Metadata exposure**
   - The backend still sees operational metadata: routing, lookup, size, timing, file classification, device bookkeeping, and maintenance signals.

4. **Server access-control scope**
   - Current enforcement is request/prefix/mesh scoped, not record/document scoped.

5. **Residual risk**
   - A legitimate client with the right key material can decrypt and export plaintext.
   - In the portable shared key scenario, copied portable key material plus stored ciphertext is enough for offline read access.

## Recommended product guardrails

If you deploy the Cloudflare backend today:

- treat D1 and R2 as **ciphertext + metadata stores**, not as trusted confidentiality boundaries by themselves;
- do not claim document-level or row-level backend ACL unless you actually add it;
- do not store plaintext business data in D1/R2 for meshes that are supposed to be confidential;
- document whether you use the portable shared key or bound shared key scenario for each product surface;
- review whether routing, lookup, size, timing, file classification, and device-bookkeeping metadata are acceptable leakage for your compliance posture.

## References

- Root security model: [packages/core/docs/security-model.md](../../core/docs/security-model.md)
- Shared key scenarios: [packages/core/docs/shared-key-scenarios.md](../../core/docs/shared-key-scenarios.md)
- Cloudflare Workers runtime: [README.md](../README.md)
