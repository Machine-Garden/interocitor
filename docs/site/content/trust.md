---
title: Who is trusted inside an Interocitor mesh?
description: Decide which endpoints may derive the mesh key, where key material may persist, and how loss differs from compromise.
kicker: Trust · Key custody
heading: Possession of the mesh key defines the trust boundary.
lede: Any browser, phone, server, or agent that can derive the key can read the mesh. Runtime labels and query filters do not reduce that authority.
---

## Let the key define trust {#invitation}

A protected mesh is encrypted before remote storage receives it. The endpoints must hold or derive the mesh key because they perform the actual reads, writes, and merges.

That makes every key-bearing runtime a **trusted endpoint**. A background worker has the same decryption authority as a user’s phone: it can read the complete row database and any ordinary durable file it can fetch.

> Trust follows key material.

Use separate meshes and keys when two groups must not receive one another’s rows.

## Choose a custody model {#custody}

Key custody determines what survives a reload and what an attacker must compromise:

| Choice                               | Suitable when                                | Main cost                                                                    |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Persist on this device               | Low-friction return matters                  | Stolen device storage exposes more key material to attack.                   |
| Keep only for the session            | Shared or sensitive clients should forget it | The user must unlock, pair, or recover again.                                |
| Wrap with stronger device protection | Local key theft is a material threat         | The host must design passkey, biometric, native, or server-assisted release. |

Credential storage protects key material at rest. Endpoint security protects plaintext and usable keys while the application is running. No storage mode makes a key harmless after it has been resolved.

Custody is also separate from the row database. No built-in local store encrypts rows at rest, so every custody mode above leaves the mesh contents readable on a device an attacker can read — the choice changes what a thief must do to obtain the _key_, not what they can read from the _store_.

## Separate loss from compromise {#lost}

- **A device is lost, but its key is still trusted:** another paired endpoint or a recovery phrase prepared earlier can restore access.
- **The last usable key is lost:** protected data is unreadable. The remote has no master key.
- **A key may have been copied:** create a new mesh and key, migrate from an endpoint still trusted, and retire the old remote location.

Recovery must exist before the last key disappears. A 12-word recovery phrase can restore portable credentials; it does not revoke copied keys or restore application login. [Authentication and recovery are separate capabilities](/auth#recovery).

## Build other recovery designs above the key {#other-recovery}

Interocitor restores a key through another paired endpoint, a passkey the platform keeps, or a phrase the application generated at random. Each path carries as much entropy as the key it restores, and none of them asks a service to stand in for that entropy. That is the boundary.

Everything else can be built on top of it, and nothing inside Interocitor has to change for that. Two seams carry the load. `BoundSharedKeySource` derives the mesh key from a portable component plus whatever the application supplies, so any service, secret, or ceremony the product wants in the recovery path becomes an input to that derivation. The recovery wrapper is the general shape of a stored secret: a locator and a ciphertext, both derived on the client from something the user holds, stored on a remote that learns neither. A product can seal a key to a public identity, release it through a service of its own, or gate it behind a secret of its own choosing. Interocitor sees only the derived key.

What Interocitor does not provide, it also does not verify. The host owns the design, the parties it trusts, and the consequence that a failure there exposes the mesh.

## Record the endpoint trust policy {#circle}

Before launch, identify:

1. every device and service allowed to hold plaintext;
2. whether each credential is persistent, session-only, or wrapped;
3. who may pair or recover an endpoint;
4. how recovery is tested;
5. how the deployment migrates after key compromise;
6. which reader groups require separate meshes.

Then read [what a remote compromise reveals](/security) and [how authentication fits around the mesh](/auth).

## Decision summary {#summary}

|                    |                                                          |
| ------------------ | -------------------------------------------------------- |
| **Trust boundary** | Every endpoint that can resolve the mesh key.            |
| **Isolation**      | Separate meshes and keys for separate row audiences.     |
| **Preparedness**   | Test recovery for loss and migration for key compromise. |
