---
title: Choose and operate an Interocitor mailbox
description: Compare mailbox placements and name the owner of access, availability, limits, retention, backup, and recovery.
kicker: Architecture decision 03 · Mailbox operations
heading: Put the mailbox where its risks can be owned.
lede: A mailbox can remain blind to protected payloads and still determine whether devices can exchange them. Choose a backend by access policy, durability, limits, evidence, and recovery—not only by where bytes fit.
---

## Decision summary {#summary}

|                   |                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------- |
| **Decision**      | Select a remote adapter and accept its operational responsibility.                           |
| **Core boundary** | Client-side protection does not make the remote available, monotonic, or correctly retained. |
| **Complete when** | Admission, quotas, backups, restore tests, audit evidence, and incident owners are explicit. |

## The mailbox is simple, not unimportant {#role}

The remote stores row-sync artifacts and durable-file bodies. It does not query records or merge conflicts, but it controls a critical availability path and observes operational metadata.

A deployment owner must account for:

- who may list, read, write, and delete a mesh;
- object names, paths, sizes, request timing, and request identity;
- capacity, body-size, and durable-file quotas;
- stale writes, overwrite behavior, and retention;
- backup, restore, rollback, and evidence after an incident.

## Choose the policy surface you need {#choices}

| Backend           | Strength                                                                                            | Operational consequence                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cloudflare Worker | Protocol-aware D1/R2 handling, request authorization, typed limits, audit events, maintenance hooks | The deployment owner operates schema, bindings, policy, quotas, backup, and restore                              |
| WebDAV            | Portable file operations across hosted servers and home infrastructure                              | Authentication, overwrite behavior, logging, quotas, and retention belong to the chosen host                     |
| Google Drive      | User-owned storage through an application-authorized account                                        | Availability and access inherit Drive and OAuth behavior; application consent and token handling remain in scope |
| Custom adapter    | Fits an existing storage or deployment boundary                                                     | The implementation must preserve the adapter contract and document every backend-specific guarantee              |

Protocol awareness can add guardrails without receiving plaintext. It does not remove the host from the availability boundary.

## Operate for failure, not only steady state {#operations}

### Admission

A predictable route such as `main` is a namespace, not a credential. Enforce application authentication and explicit mesh authorization unless the deployment is intentionally public.

Use the host application's current resource policy for ordinary multi-user access. See [Access and identity](/auth) before introducing subject-specific routes or an application-managed grant chain.

### Capacity and abuse

Apply request body limits and per-mesh durable-file quotas. Monitor object growth, uncompacted change history, rejected writes, and maintenance backlog.

### Retention

Keep row history long enough for observation and safe compaction. Treat durable files separately: they remain until the application overwrites or deletes them.

### Backup and restore

Back up all state required to reconstruct the mailbox. Restore tests must cover the D1/R2 split or equivalent store layout and verify that clients can reconnect without silently moving backward.

> Encryption makes a stolen storage copy less revealing. It does not make deletion, rollback, corruption, or prolonged unavailability harmless.

## Record the runbook {#checklist}

- Name the deployment owner and incident contact.
- Define mesh admission and any read-only policy.
- Configure body, quota, and retention limits.
- Decide who may run compaction and maintenance.
- Capture structured audit evidence without logging secrets or payload plaintext.
- Back up the complete mailbox and rehearse restore.
- Document what clients see during withholding, rollback, and quota failure.

## Continue with the exact contract {#continue}

- [Worker runtime options](https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/runtime-options.md) — bindings, defaults, and limits.
- [Security guardrails](https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/security-guardrails.md) — request policy and threat boundaries.
- [Maintenance](https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/maintenance.md) — retention and operational procedures.
- [Adapter contract](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/adapter-contract.md) — requirements for custom storage.
