---
title: Interocitor questions and answers
description: Direct answers about privacy, offline work, conflicts, files, keys, servers, automation, scale, and fit.
kicker: Reference · Product boundaries
heading: Start with the questions that can disqualify the design.
lede: Offline rows, visible metadata, key custody, remote failure, and unsuitable workloads can each determine whether Interocitor fits an application.
---

## What is Interocitor for? {#what}

Interocitor lets trusted endpoints share structured application rows through a remote mailbox. Each endpoint works with a complete local row database; protected changes are exchanged when transport is available and merged by the endpoints.

It fits applications that need offline row work and remote storage without plaintext access. It is not a general server database, an exactly-once queue, or a system for selective row visibility inside one mesh.

## Can the remote read my data? {#privacy}

Not the protected payloads when a mesh key is configured. Row changes, snapshots, and ordinary durable files are encrypted before the remote receives them.

The remote still observes paths, sizes, timing, request identity, device activity, and control metadata. Read [the security model](/security) for the complete boundary.

## Does the application work offline? {#offline}

Rows do after the local store opens. Reads and writes use local state, and pending changes publish later.

Durable files are different. Their bytes live remotely and require transport unless the application implements its own file cache.

## What happens when two endpoints edit concurrently? {#conflicts}

Each endpoint publishes its own change. After receiving the same change set, every endpoint applies the schema’s CRDT merge rules and reaches the same row state.

Different-field edits normally preserve both values. The configured rule settles concurrent edits to the same field. See [two offline edits converge](/flows#offline).

## Does everyone in a mesh see every row? {#whole-mesh}

Every key-bearing endpoint can eventually receive the complete row database. Query filters restrict application behavior, not cryptographic access.

Use separate meshes for different row audiences. Use [a tainted file](/tainted-files) when only one durable file needs fewer readers.

## Who decides who may connect? {#identity}

The host application authenticates a stable subject and evaluates current resource policy. Worker middleware enforces that decision for each mesh request. A mesh address is not a credential, and a mesh key is not a login token.

Read [the authentication model](/auth).

## What if a key is lost? {#lost-key}

Another trusted endpoint or recovery prepared earlier can restore portable credentials. Twelve random BIP-39 words are one application-level recovery format. If no key or recovery remains, protected data cannot be opened; the remote has no master key.

## What if a key is stolen? {#stolen-key}

Account revocation can stop later remote access but cannot erase a copied key. Create a new mesh and key, migrate from an endpoint that remains trusted, and retire the old location.

## What if the mailbox is deleted? {#deleted-mailbox}

Encryption cannot recreate unavailable data. Local row copies may survive, but shared remote history and durable files need independent backup or another complete copy. Important deployments should test a full restore.

## Will row history grow forever? {#history}

A single trusted compactor periodically publishes a complete snapshot and deletes only the exact changes it covers. [Compaction](/compaction) bounds normal catch-up while preserving uncovered changes.

## Can a worker or agent join? {#automation}

Yes. A key-bearing agent is a trusted endpoint that can read the complete mesh and publish changes. Give it an appropriate mesh boundary, protect its key, and coordinate external effects separately from CRDT merge.

Read [the automation guide](/automation).

## How large can a mesh become? {#scale}

The complete row database must fit every endpoint that opens the mesh. Measure a realistic snapshot, the weakest supported device, catch-up time, local storage, memory, and query behavior.

Split a mesh only when the application can also own the resulting trust and workflow boundary.

## When should I choose something else? {#not-fit}

Choose another foundation when the server must query plaintext, when many small groups need different row visibility, when strict central transactions define the product, or when durable files must work offline without an application-owned cache.

Interocitor is strongest when trusted endpoints own row semantics and remote infrastructure can remain a protected mailbox.
