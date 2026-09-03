---
title: Designing a trusted Interocitor mesh
description: Decide which endpoints may read a mesh, where its key may exist, and how access, recovery, and compromise will be handled.
kicker: Architecture decision 01 · Trust and keys
heading: Design the mesh around who may read it.
lede: Encryption can keep protected payloads away from the remote mailbox. It cannot keep plaintext away from an endpoint that holds the mesh key. Decide endpoint authority, key custody, recovery, and compromise response together.
---

## Decision summary {#summary}

|                   |                                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| **Decision**      | Define the confidentiality boundary, not merely whether encryption is enabled.    |
| **Core boundary** | Every authorized runtime that resolves the mesh key can read the row database.    |
| **Complete when** | Trusted endpoints, key sources, recovery owners, and the rotation path are named. |

## A key is a read capability {#authority}

A phone, browser tab, native app, worker, or agent becomes a trusted endpoint when it receives usable mesh key material. Runtime labels do not narrow that authority. Separate meshes and keys create the meaningful isolation boundary.

### Trusted endpoint

May decrypt rows and files, apply application policy, and publish changes. Device security and application isolation protect the local plaintext copy.

### Remote mailbox

Stores and returns protected artifacts without the final key. It still observes routing and operational metadata and can affect availability.

### Deployment owner

Controls admission, storage access, retention, backup, and restore. Those controls complement payload encryption; they do not replace it.

## Choose how an endpoint earns the key {#custody}

| Choice                   | Useful when                                                                                    | Boundary to preserve                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Portable key             | Trusted clients must open the mesh offline and the capability can be transferred intentionally | Anyone who copies it can read the mesh                      |
| Application-bound source | The application can reliably supply additional material or policy                              | Isolation depends on the actual derivation and input owners |
| Separate mesh and key    | A runtime must not read another group’s complete row state                                     | Moving data later is an explicit cross-boundary operation   |

Credential storage changes where a portable key rests; it does not make that capability less powerful after an endpoint opens it.

> Removing storage access does not erase a copied key. After compromise, create a new mesh and key, move data from a still-trusted endpoint, and retire the old location.

## Prepare failure paths before launch {#lifecycle}

- Name every runtime allowed to receive plaintext and mesh key material.
- Choose portable or application-bound derivation and record every input owner.
- Protect local plaintext with platform storage, device locks, and application isolation.
- Prepare recovery on another trusted device or publish a recovery wrapper before loss.
- Use opaque durable-file paths when filenames are sensitive.
- Document the new-mesh migration used after key compromise.

## Continue with the exact contract {#continue}

- [Security model](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/security-model.md) — threat model, integrity, and metadata exposure.
- [Shared-key scenarios](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/shared-key-scenarios.md) — portable and bound source comparison.
- [Recovery guide](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/recovery.md) — prepare and use a recovery phrase.
- [Browser credential custody](https://github.com/Machine-Garden/interocitor/tree/main/packages/web#credential-storage-choices) — choose where browser keys rest.
