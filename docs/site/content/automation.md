---
title: Design trusted automation with Interocitor
description: Add a worker or agent as a trusted endpoint while preserving key custody, isolation, coordination, and delivery boundaries.
kicker: Architecture decision 04 · Trusted automation
heading: Treat automation as a trusted peer, not a mailbox feature.
lede: A worker or agent can observe local rows, act, and write results through the same mesh. Once it holds the key, it is inside the plaintext boundary. CRDT convergence still does not make work exactly once.
---

## Decision summary {#summary}

|                   |                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------- |
| **Decision**      | Choose the trusted processor, its mesh scope, and its coordination rule.              |
| **Core boundary** | A key-bearing worker may read the complete row database and can publish changes.      |
| **Complete when** | Key custody, isolation, retries, claims, outputs, and failure ownership are explicit. |

## A processor is another endpoint {#endpoint}

The automation runtime opens a local store, resolves mesh key material, connects to the mailbox, and observes or queries rows. It applies application logic and writes result rows or durable files back.

```text
product endpoint ⇄ protected mailbox ⇄ worker endpoint
     plaintext                               plaintext
```

The mailbox remains storage. It does not invoke the worker, decide which row is a task, or record that an external side effect succeeded.

## Isolate by mesh, not by row convention {#isolation}

A worker with the mesh key can decrypt the full row database. Filtering a query or agreeing to read one table is application behavior, not cryptographic isolation.

Use a separate mesh and key when:

- different agents should see different tenants or workflows;
- one processor has a wider external-action capability;
- compromise or revocation must have a smaller blast radius;
- retention, deployment ownership, or availability differs.

Cross-mesh transfer then becomes an explicit trusted application step. That extra boundary is useful only if the product owns the bridge and its failure cases.

## Convergence is not a job queue {#coordination}

Two processors can observe the same task before either sees the other’s claim. The CRDT will converge their row changes, but it cannot undo a duplicated email, payment, or external API call.

Choose an application rule that matches the side effect:

| Requirement                       | Application pattern                                    |
| --------------------------------- | ------------------------------------------------------ |
| Duplicate work is harmless        | Idempotent handler with a stable operation key         |
| One processor should normally act | Claim row plus expiry and visible owner                |
| Strict single execution matters   | External coordinator or transactional system of record |
| A result can be recomputed        | Deterministic output row keyed by input version        |

> “Eventually one winning claim” is not the same as “only one side effect happened.”

## Design the processor lifecycle {#lifecycle}

- Define which row transition makes work eligible.
- Use observation as a wake-up signal, then re-read durable state.
- Give each action a stable idempotency key.
- Record claim, attempt, result, and failure state where trusted peers can converge on them.
- Put large outputs in durable files and reference them from rows.
- Bound retries and surface poison work for human or system review.
- Protect headless key material and rotate to a new mesh after compromise.
- Monitor mailbox availability separately from processor health.

## Continue with the exact contract {#continue}

- [Python runtime](https://github.com/Machine-Garden/interocitor/tree/main/packages/interocitor-python#readme) — build a headless compatible peer.
- [Change observation](https://github.com/Machine-Garden/interocitor/tree/main/packages/core#observe-completed-pulls) — wake on completed merge effects.
- [Data migrations](https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/data-migrations.md) — application-owned concurrent processing patterns.
- [Trust and keys](/trust) — scope key custody and compromise response.
