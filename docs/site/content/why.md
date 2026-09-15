---
title: Why Interocitor exists, and why it is called that
description: Two whys come before "why use it": where the name comes from, and what the project was built to avoid holding.
kicker: Origins · Start with why
heading: Start with why. Several of them come before the one you expect.
lede: Most projects answer "why use this" first. Two earlier questions decide whether that one is worth asking at all: why a data library is named after a fictional machine, and what its authors were trying to stop doing.
---

## Ask the earlier whys first {#whys}

"Why should you use Interocitor?" is a fair question and it is answered elsewhere: [how one change travels](/how-it-works) and [what you can build](/applications). It is not the first why.

Before it come two others. The name is a claim about what kind of thing this is. The origin is a claim about what its authors refused to hold.

## Why "interocitor" {#name}

The interocitor is a fictional device from Raymond F. Jones's 1949 short story "The Alien Machine," later folded into the novel _This Island Earth_ and filmed in 1955.

It arrives as a mail-order kit of unlabelled parts and no promise of what it becomes. That is the point: assembling it is a screening test, quietly sorting for the engineers worth recruiting. Once assembled it is a two-way viewing screen, a power source, and — in the film that followed — a weapon. Whoever switches one on finds the Peace Engineers on the other side, hiring.

The name is a description, not a joke.

Interocitor ships as a kit rather than a service. There is no account to open and no server of ours to reach. You supply the parts: [which storage carries the mailbox](/storage), [where the mesh key comes from](/trust), which rows exist, and how their fields merge. That assembly _is_ the test, because it decides what the deployment can do and who can read it. And like the original, it has a dangerous end — every endpoint holding the mesh key reads everything in that mesh, and [a key lost with no recovery path](/qa#lost-key) takes the data with it.

So: good luck assembling yours, and be careful with it.

## Why it was built {#origin}

To move one person's data between that person's own devices without us standing in the middle of it.

Stand in the middle and you become a custodian. The ordinary shape — the application talks to your server, your server keeps the rows in plaintext — hands you every user's personal data whether you wanted it or not, and the apparatus arrives with it: a lawful basis for holding it, an agreement with every service that touches it on the way, a retention policy, an answer when someone asks for a copy of everything you have on them, a second answer when they ask you to destroy it, a residency story for where the disks physically are, a consent dialog on the way in, and a seventy-two-hour clock that starts the moment somebody gets into that database. None of it is unreasonable. It is the bill for holding the data, and it comes due whether or not holding it was ever the point. For a small team that only wanted a sync feature, it is most of the work.

So the founding move was to stop holding it. Payloads are sealed on the trusted endpoint, before the remote receives a byte, with a key the remote is never given. What the storage side keeps is ciphertext. It cannot read that to profile anyone, cannot hand a readable copy to whoever asks for one, cannot leak one in a breach, and cannot lose one to an employee having a bad day with production access. Remove yourself from the equation and the contents stop being yours to mishandle.

That is a smaller surface rather than a blanket exemption, and the difference is worth stating precisely:

| The storage side still keeps                           | And can still                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| Encrypted changes, snapshots, and ordinary file bodies | Store and return them. Not open them.                         |
| Object paths, sizes, and timing                        | Infer activity and volume, and read a careless path outright. |
| Request identity and device records                    | See which account, count its devices, and cut either off.     |

Whether that ciphertext is personal data at all depends on whose hands it is in. To the side running the storage it is dead weight: no key, no reasonable way to get one, nothing to read, profile, reason about, or hand to anyone — and the test for whether data identifies a person is increasingly applied to the party actually holding it rather than in the abstract. To the side running the application it is personal data as surely as it ever was, because that side has the users, the keys, and the answer to give. Sealing on the client moves the boundary; it does not move the application's operator outside it.

The envelope is what stays personal everywhere. Account identifiers, addresses, device records, paths, sizes, and timing are visible to whoever runs the storage, and they identify people on their own without any help from the payload. [Every endpoint holding the mesh key](/trust) is a complete plaintext reader, which is the real access decision. Destroying key material leaves the remote's copy inert, but it cannot reach plaintext already copied onto an endpoint, and Interocitor does not claim an erasure it cannot perform. [Operating the mailbox](/mailbox) still carries residency, retention, availability, and backup.

What changes is the blast radius, and the number of ordinary mistakes that can become a disclosure. A full dump of the mailbox is a dump of ciphertext and routing metadata: a smaller and much duller thing to explain to a regulator, to a customer, or to yourself. [The precise boundary is worth reading before you promise anything](/security).

## Why the purpose kept widening {#after}

The original need was narrow: one user, several devices, one private set of records.

The shape turned out to carry more than that. The same artifacts move between [several people in one mesh](/data-boundaries), keep [durable files byte-exact](/storage), rest on WebDAV, an S3 bucket, Google Drive, a home NAS, or a Cloudflare Worker, and are read by [endpoints written in browsers, Swift, Python, or by an agent](/automation). Each of those arrived after the boundary, not before it, which is why they all sit on the same side of it.

## Bring your own cloud, literally {#converging}

Niki Tonsky's ["Local, first, forever"](https://tonsky.me/blog/crdt-filesync/) argues that local-first applications should sync through the commodity file-sync services people already run — Dropbox, iCloud, Google Drive, Syncthing — so the data outlives the company that wrote the app, with CRDTs letting concurrently edited files merge instead of collide. "Just bring your own cloud."

It was neither the inspiration nor the base idea here. Interocitor was developed independently and walked in from the other direction: it starts from what a provider must not be able to read, and arrives at commodity storage because storage that cannot read the data is interchangeable by construction. His starts from durability of ownership and arrives at the same kind of dumb, replaceable remote.

Which makes that closing line a literal description of what ships here. Interocitor comes with adapters for storage people already have, rather than a service of ours: any WebDAV-compatible server — a NAS in the hallway, Nextcloud, ownCloud, whatever the owner already runs — any S3-compatible bucket, signed from the browser itself with short-lived credentials scoped to one prefix, Google Drive through the narrow `drive.file` scope, and a Cloudflare Worker for deployments that need the mailbox to enforce quotas and authorization. [Each one carries the same artifacts](/storage#backends), because none of them has to understand what it is carrying. The storage contract is public, so a backend nobody has written yet is [one more adapter, not a fork](/integrations).

Any of them. Bring your own.

So read his piece — then bring your cloud.
