---
title: What can you build with Interocitor?
description: Products the guarantees already carry, the roles Interocitor plays in place of Dexie, TanStack DB, Firebase, Automerge, or a distributed database, and when to reach for the original.
kicker: Plan · Applications
heading: One library that stands in for several tools.
lede: Interocitor keeps the local API you already know and takes the server out of the trust boundary. That is the whole difference, and it cuts both ways.
---

## Start from the guarantees {#guarantees}

Interocitor is a small set of guarantees. Every trusted device holds a full local copy of the rows. Files stay byte-exact and digest-verified. The remote stores what it cannot read.

Those three guarantees are enough for a family of products that people already trust today, and they are also what makes Interocitor fit into places where you would otherwise pick a browser store, a reactive collection layer, a hosted backend, or a small distributed database.

Nothing on this page is a claim to do more than that. Interocitor does the same few things in each role; the role only changes which of them you lean on.

## Build something people already trust {#build}

| Build something like | Because                                                                                                                                                                                                                                                                      | Where it stands                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear               | Speed. Every row is already on the device, so lists, filters, and keyboard-driven edits never wait on a round trip. Scale by giving each team or project its own mesh and keeping its credentials as a connected store in the parent, so a session opens only what it needs. | Behind Linear on workspace-wide search, reporting, and per-issue permissions, which need a server that reads the data. Ahead on offline work and on a vendor that cannot read your issues.                                                                       |
| Obsidian             | The folder tree is rows that merge; note bodies are durable files named by a digest, so structure converges and content stays exact.                                                                                                                                         | Obsidian Sync also encrypts end to end. Here the storage is yours and the vault is a library you embed; note bodies still replace as whole files rather than merging.                                                                                            |
| Signal               | The mailbox stores and returns encrypted artifacts. With a mesh key it never receives message plaintext, and object names are keyed hashes.                                                                                                                                  | Less secure than Signal: private chat is more than encryption, and there is no ratchet, no sealed sender, and no safety numbers, so a copied key opens the whole history. More secure than XChat: your secrets never rest anywhere the operator could open them. |
| Cryptomator          | Files are encrypted before the WebDAV, Google Drive, or iCloud folder adapter sees them, on storage the user already pays for and owns.                                                                                                                                      | Equal at the boundary, since both encrypt before the folder adapter sees a byte and both leave sizes visible. Behind Cryptomator as a drop-in virtual drive; ahead when the files belong to an application with rows that need to merge.                         |
| Bitwarden            | A portable key, device pairing, and recovery phrases are built in, so a vault syncs across devices without a custodial server.                                                                                                                                               | Bitwarden's server also never sees the vault. It offers emergency access and organization administration that Interocitor leaves to the host to build; in exchange there is no custodial account or server at all.                                               |
| A field-data app     | Inspections and surveys are written offline and merged field by field later; two workers on one report keep both sets of edits.                                                                                                                                              | Behind a hosted form platform on server-side dashboards and exports, which need plaintext. Ahead on two workers merging one report and on a remote that never sees the survey.                                                                                   |
| Trusted automation   | A worker or agent is just another trusted endpoint. It holds the key, reads task rows, does the work, and writes results back, from a browser, a server process, or a script.                                                                                                | An agent holding the key is as trusted as a person holding it; there is no narrower server-enforced view for it. Behind a server-mediated integration on least privilege, ahead on no server code and no plaintext passing through one.                          |
| A case-file system   | A file sealed under an extra key lives inside a shared mesh: the rows stay shared, only the key holders open the bytes, and the seal guards the object against overwrite or deletion.                                                                                        | Behind a document-management system on server-enforced per-document permissions and read audit. Ahead on a server that cannot read the sealed file and cannot overwrite or delete it without the key.                                                            |

The common thread: the users can each hold a full copy, the server should not be able to read it, and there is no server code to write, host, or defend.

## Know when it is the wrong tool {#wrong-tool}

Interocitor is the wrong tool when the product needs server-side queries or reporting over plaintext, per-row access control inside one dataset, or central transactions.

Every endpoint holds the entire mesh it opens, so large or many-audience datasets are split into meshes rather than filtered per row. The remote can still see sizes, timing, and request identity even though it cannot read the content. Read [data boundaries](/data-boundaries) before deciding, and [security](/security) for what the remote learns.

## Play the role of Dexie {#dexie}

`table`, `where`, `subscribe`, and `useLiveQuery` will feel familiar. Queries cover one indexed field with `equals`, ranges, `startsWith`, `anyOf`, and `orderBy`.

There are no compound or multi-entry indexes, no collection chaining, no bulk operations, and no versioned migrations. In exchange rows merge per field with hybrid logical clock ordering, and syncing to a remote that holds only ciphertext is already there when you want it.

Reach for Dexie when you do not need to sync "own" data. If the rows belong to one person on one device and never leave it, Interocitor's merge, key, and mailbox add nothing you will use.

## Play the role of TanStack DB {#tanstack-db}

You get reactive collections and live queries feeding React, with sync built in, and without a server that owns the canonical data or understands the schema. The client replica is canonical and the remote is a mailbox.

Filtering runs on the endpoint. Scale comes from splitting meshes and keeping their credentials as connected stores, not from a server that pages results. The merge and a file surface are part of the library rather than something you wire to a backend.

Reach for TanStack DB when a trusted backend already owns the data and you want the client to be a cache of it.

## Play the role of Firebase {#firebase}

You get a store that syncs across devices, works offline by default, and needs no backend code. The remote cannot read it, so there are no server queries and the unit of access is the mesh, not the row.

Realtime is an optional invalidation signal that tells clients to pull. Auth is your host's identity provider, as described in [authentication](/auth). The Cloudflare worker sits where security rules sit in the request path, but it decides only who may touch a mesh, how many bytes, and what gets logged. It never decides which rows.

Reach for Firestore when the server must read, query, or report on the data.

## Play the role of a distributed database {#distributed}

Interocitor is not a browser library, and it does not have to persist in IndexedDB. The core runs wherever you give it a local store: memory, or your own, in a server process.

Point it at WebDAV, an S3-compatible bucket, or a NAS, and a mesh behaves much like a small distributed database whose storage cannot read it. Clients merge and compact; the storage only keeps bytes. Trusted workers and agents join as endpoints, the way [automation](/automation) describes, and share the same rows and files as the browsers.

Reach for a real database when you need central transactions or plaintext reporting.

## Play the role of Automerge or Yjs {#automerge}

Automerge and Yjs replicate one mutable document: a JSON-like tree or a set of shared types that you change in place, and whose whole history travels with it. They ask you to decide what one document is, and they leave storage, networking, encryption, and key handling to adapters you assemble.

Interocitor replicates rows. You do not mutate a replica; you issue `add`, `patch`, `replace`, and `delete` against a table, and each column merges on its own clock. The document boundary becomes a table with indexes, `where`, and subscriptions. History is compacted into snapshots rather than kept forever. Encryption, storage adapters, pairing, and recovery come with the library.

Reach for Automerge or Yjs when collaborators edit one document, canvas, or text body: there is no rich-text or sequence CRDT here, and a note body is a durable file that replaces whole.

## Accept the complexity {#complexity}

Interocitor is lower level than any of these, in the way Rust is lower level than a garbage-collected language. You name the key source, which endpoints hold the key, who compacts, which meshes a session opens, and which files carry a seal.

That is the price of no server code, no plaintext rows on the remote, and deterministic convergence regardless of arrival order. Most of these choices are deployment policy the runtime cannot verify. Server-managed [compaction](/compaction) is the one checked case.

## Decision summary {#summary}

| Play the role of       | How Interocitor plays it                                                                                       | What is different                                                                                | Reach for the original when                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Dexie                  | A typed table store over IndexedDB with `where`, `subscribe`, and `useLiveQuery`                               | Narrower queries; rows merge per field; sync and encryption come with it                         | You do not need to sync "own" data                    |
| TanStack DB            | Reactive collections and live queries feeding React, with sync built in                                        | No server that understands the schema; the remote is a mailbox; scale by splitting meshes        | A trusted backend already owns the data               |
| Firebase / Firestore   | A multi-device synced store with offline as the default and no backend to write                                | The remote holds ciphertext; access is per mesh; the worker only admits, meters, and audits      | The server must read, query, or report on the data    |
| A distributed database | The core in a server process with a memory or custom local store, over WebDAV, S3-compatible storage, or a NAS | Storage cannot read it; clients merge and compact; no server-side queries                        | You need central transactions or plaintext reporting  |
| Automerge / Yjs        | Rows and tables instead of one mutable document; each field is the merge unit, each row change is the artifact | No document tree, no in-document history, no text CRDT; queries, indexes, and tombstones instead | Collaborators edit one document, canvas, or text body |
