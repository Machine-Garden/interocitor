---
title: Where should the Interocitor mailbox live?
description: Choose remote storage by access control, availability, limits, observability, backup, and operational ownership.
kicker: Mailbox · Operational boundary
heading: Encrypted storage is still an operational dependency.
lede: The remote may not read protected contents, but it can still delay, reject, delete, or roll back the artifacts every endpoint needs.
---

## Define the mailbox boundary {#depot}

The **remote mailbox** stores row-change artifacts, snapshots, control records, and durable files. With protection configured, it receives encrypted payloads rather than plaintext application data.

Confidentiality does not make the service passive. Its owner still controls:

- authorization at each mesh route;
- storage quotas and request-size limits;
- retention and compaction scheduling;
- logs and audit evidence;
- backup and restore;
- incident response and availability.

The mailbox is intentionally simple, but it remains part of the product’s security and recovery model.

## Choose a backend by ownership {#choices}

| Backend                 | Choose it when                                      | Responsibility that remains                                               |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Cloudflare + R2         | You need a programmable protocol-aware remote       | Identity integration, limits, D1/R2 bindings, backups, and operations.    |
| Cloudflare + S3         | File bodies need an S3-compatible placement         | Everything above, plus S3 credentials, residency, migration, and restore. |
| WebDAV server           | You need a portable file-oriented remote            | Server login, overwrite behavior, quotas, logs, and backups.              |
| Google Drive            | The user should own the storage account             | Consent, tokens, provider availability, and the user’s storage decisions. |
| Custom adapter          | The mailbox must fit an existing platform           | Faithful adapter semantics and an explicit account of missing guarantees. |

No backend is universally best. Choose the failure modes and operational owner the product can support.

The [complete storage model](/storage#backends) shows what is local, what is remote, and exactly how WebDAV, Google Drive, Cloudflare + R2, and Cloudflare + S3 place the mailbox artifacts. In particular, S3 is a durable-file body destination behind the Worker, not a standalone row-sync mailbox; D1 still contains row history, control state, and durable-file metadata.

## Treat addresses as routing, not credentials {#door}

An address such as `main` selects a mesh namespace. It is not a secret and does not authenticate a requester.

For an ordinary multi-user deployment, use the application’s existing identity and current resource policy to [authorize mesh requests through middleware](/auth). Apply per-mesh quotas and request limits so one faulty or hostile client cannot exhaust shared storage.

Encryption hides protected payload contents. The remote still observes routes, object paths, sizes, timing, request identity, and other operating metadata.

## Test failure and restore {#operations}

Exercise the conditions the deployment must survive:

1. deny an unauthorized request;
2. exceed a quota and return a usable error;
3. interrupt snapshot cleanup and verify that it retries safely;
4. restore every mailbox store from backup;
5. reconnect a trusted endpoint without silently accepting stale state;
6. investigate damaged protected data without logging plaintext or keys.

A backup is credible only after a complete restore test. Include every store required by the mailbox, not only the largest object bucket.

## Publish an operational owner {#card}

Record the service owner, incident contact, storage limits, backup schedule, restore procedure, compaction owner, acceptable outage, and user-visible failure behavior.

Continue with [the security model](/security), [compaction](/compaction), or [authentication](/auth).

## Decision summary {#summary}

|                       |                                                                 |
| --------------------- | --------------------------------------------------------------- |
| **Choose by**         | Access, failure, limits, evidence, backup, and ownership.       |
| **Encryption cannot** | Guarantee availability, freshness, or protection from deletion. |
| **Ready when**        | The owning team can restore the complete mailbox under test.    |
