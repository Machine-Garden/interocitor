---
title: Choose an Interocitor authorization model
description: Choose between host-owned resource authorization and specialized application-managed grants without confusing mailbox access with key revocation.
kicker: Architecture decision 04 · Access and identity
heading: Keep access decisions with the authority that owns them.
lede: Most multi-user applications should keep stable mesh addresses and authorize each Worker request with their existing identity and resource policy. Add protected mesh control only when the application must issue and delegate grants of its own.
---

## Decision summary {#summary}

|                   |                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| **Decision**      | Choose which authority decides whether the current subject may use each mesh.                           |
| **Core boundary** | Mailbox authorization can stop future remote access; it cannot erase plaintext or a key already copied. |
| **Complete when** | Identity, policy freshness, route ownership, revocation latency, and key-compromise response are named. |

## Start with the host application’s policy {#host-policy}

When several people should share the same confidentiality boundary, give that mesh a stable application address and keep identity outside Interocitor. The host authenticates a person as a stable, server-verified subject, checks its current resource policy, and lets the Worker enforce the result for that request.

```text
person → host login or session → current resource decision → stable mesh
```

This is the recommended path for applications that already know whether a subject may use a repository, tenant, workspace, or project. Removing that permission denies subsequent IO requests and new notify connections without changing the mesh address or introducing an Interocitor grant chain.

The responsibilities stay separate:

| Owner              | Responsibility                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Host application   | Provider login, sessions, stable subject identity, resource policy, and authorization freshness |
| Interocitor Worker | Enforce the host’s authorization decision for each admitted mesh request                        |
| Trusted endpoint   | Protect its session, mesh key, and any plaintext already stored locally                         |

Use separate meshes when groups must not receive one another’s complete row database. Authorization controls whether a caller may reach a mesh; it does not turn one mesh into selective per-row sharing.

## Keep addresses and identity out of the credential story {#credentials}

A stable address such as `main` names storage. It is not a password, even when the address is difficult to guess. Require application authentication and explicit authorization unless the mesh is intentionally public.

Do not accept a subject or application author claimed by the client. Verify the subject at the server, then derive current resource access from that identity. If an external provider authenticates the person, exchange its credential for a host session; do not place provider tokens in mesh passphrases, QR payloads, or pairing configuration.

Interocitor’s authorization helper maps the host’s result to an admitted or denied request. The host still owns authentication and any interactive `401` challenge, sign-in redirect, approval UI, or session refresh.

## Add protected mesh control for application-owned grants {#grants}

Protected mesh control serves a narrower need: the application must issue, attenuate, delegate, expire, or revoke its own mesh grants independently of an existing identity provider’s resource permissions. It can also give each subject a replaceable presented route while keeping the canonical storage namespace stable.

| Question             | Host-owned authorization                                       | Protected mesh control                                                         |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Who owns the policy? | Existing application identity and resource system              | Application-managed grant roots and control store                              |
| Typical route        | Stable application address                                     | Stable address, or replaceable subject route mapped to a canonical address     |
| Revocation action    | Stop granting the subject current resource access              | Revoke the leaf or an ancestor grant; remove its route binding when one exists |
| Choose it when       | Membership or entitlement already answers who may use the mesh | The application itself needs bounded grant delegation or independent routes    |

The specialized control plane is server-readable and authoritative for current grants and route bindings. With a non-null key source, protected application rows and ordinary file bodies remain client encrypted. The control plane still relies on host authentication to map a request to a stable subject, and it needs protected management endpoints, persistence, and audit policy supplied by the application.

Do not add per-subject routes merely to make ordinary sign-in work. They introduce route issuance, persistence, distribution, rotation, and revocation obligations without replacing authentication or changing who can decrypt a shared mesh.

## Plan revocation as two different events {#revocation}

Access revocation and key compromise have different remedies.

- A policy or grant change can deny later IO requests and new notify connections.
- An already admitted notify socket stays open unless the deployment adds bounded connection lifetimes or a subject-aware relay.
- A client may retain plaintext and key material it received before revocation.
- If that key is no longer trusted, create a new mesh and key, move data from a still-trusted endpoint, and retire the old location.
- `readonly` is a raw Worker permission, not a complete read-only Core client mode; normal connected clients write device metadata and heartbeats.
- `full` permits Worker writes, not every application action. Derive the actor from server authentication and enforce semantic roles separately.

Neither authorization model changes the encryption boundary: anyone with usable mesh key material remains able to read protected contents they can obtain.

## Record the access contract {#checklist}

- Name the system that authenticates people and the stable subject identifier it produces.
- Map each mesh to the resource decision that grants `readonly`, `full`, or denied access.
- Define how fresh membership, entitlement, route, and grant decisions must be.
- Choose stable application addresses unless independently replaceable subject routes are required.
- Keep provider credentials out of pairing and mesh-key material.
- Set the acceptable revocation delay for active notify connections and cached policy decisions.
- Separate network-access removal from the new-mesh procedure used after key compromise.
- Audit denied and privileged requests without logging credentials or protected payloads.

## Continue with the exact contract {#continue}

- [Mesh addresses and access](https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/mesh-access.md) — stable addresses, host authorization, middleware results, and denial behavior.
- [Protected mesh control](https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/mesh-control.md) — application-owned grant chains, subject routes, pairing, and revocation.
- [Trust and keys](/trust) — decide which endpoints may hold plaintext and how key compromise is handled.
- [Mailbox operations](/mailbox) — own availability, quotas, audit evidence, backup, and restore.
