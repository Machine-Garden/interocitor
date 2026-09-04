---
title: Interocitor glossary
description: Concise definitions for the terms that establish Interocitor’s data, trust, and availability boundaries.
kicker: Reference · Core terms
heading: Use the terms that define the system.
lede: Trusted endpoint, remote mailbox, mesh, key, row, durable file, taint, change, snapshot, compaction, CRDT, adapter, and recovery each name a distinct contract.
---

## Trusted endpoint {#trusted-endpoint}

A device or program allowed to hold or derive the mesh key and process plaintext. A phone, browser, server, and agent have the same cryptographic authority when they hold that key.

## Remote mailbox {#remote-mailbox}

The online storage used to exchange protected row artifacts and hold durable files. It stores and returns objects; it does not query rows or resolve conflicts.

## Mesh {#mesh}

A group of endpoints sharing one complete row database, one remote history, and usually one mesh key. Every key-bearing endpoint can eventually receive every row.

## Mesh key {#mesh-key}

The cryptographic material used to encrypt and decrypt a mesh’s protected contents. Copying usable key material gives another endpoint the same decryption capability.

## Local store {#local-store}

The row database on a trusted endpoint. Reads and writes use it first, so row work can continue offline after initialization.

## Row {#row}

A unit of structured application state that lives locally and merges with changes from other endpoints, such as a task, message, status, or map marker.

## Durable file {#durable-file}

A remotely stored byte object such as a document, image, audio file, or export. It is fetched directly and does not inherit the row database’s offline queue or merge behavior.

## Taint {#taint}

An application-defined label indicating that a durable file requires an additional key. Interocitor preserves the label; the application defines its meaning and distributes the corresponding key. See [tainted files](/tainted-files).

## Change {#change}

An immutable artifact describing one or more row operations. Endpoints publish changes to the mailbox, track exact artifacts already observed, and merge unseen operations.

## Snapshot {#snapshot}

An encrypted copy of the complete current row state plus exact coverage of the changes included in it. It gives new and returning endpoints a bounded baseline.

## Compaction {#compaction}

Publication of a fresh snapshot followed by deletion of only the exact change artifacts it covers. Compaction bounds catch-up and requires one publisher at a time. See [compaction](/compaction).

## CRDT {#crdt}

Conflict-free replicated data type: deterministic merge semantics that let endpoints receiving the same changes converge regardless of arrival order.

## Adapter {#adapter}

The implementation connecting Interocitor to a particular remote mailbox, such as WebDAV, Google Drive, or a Cloudflare Worker.

## Recovery {#recovery}

An application-prepared path for restoring portable mesh credentials after local key loss. Recovery must exist before the last usable key disappears and does not revoke copied keys.

See [the core flows](/flows) for these terms in context.
