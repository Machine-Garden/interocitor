---
title: How long does the mailbox keep your data?
description: Understand the two retention clocks, why an idle mesh is measured by writes, what eviction does and does not destroy, and why a wipe is not a deletion.
kicker: Mailbox · Retention
heading: Storage you do not pay for forever is storage with a clock on it.
lede: A mesh lives on somebody's disk, and disks have owners with budgets. Interocitor's answer is that the clock must be stated, that it measures writes, and that clients find out rather than simply finding the mailbox empty.
---

## Separate the two clocks {#layers}

Two different parties can decide that data has outlived its usefulness, and they decide it for different reasons.

**Protocol retention** is what the devices in a mesh promise each other. It is written into the [manifest](/compaction) when the mesh is created, every device reads it, and it governs history rather than data: how long an uploaded change waits before a snapshot must absorb it, and how long a device may stay away before its unsent writes stop being publishable. Nothing here deletes anything a user would recognize as their data.

**Mailbox retention** is what the storage owner promises the devices. It governs the data itself: how long an untouched mesh occupies the disk, whether file bodies outlive the rows that point at them, how many bytes one mesh may hold. The remote cannot read any of it, and that is exactly why it cannot make a clever decision about what is worth keeping. It can only count time and bytes.

> The protocol's clock decides when history is tidied. The mailbox's clock decides when storage is reclaimed. Confusing them is how deployments lose data they meant to keep.

The two clocks must be ordered. A mailbox that reclaims a mesh sooner than the protocol allows a device to be absent will meet returning devices that have been fenced by one rule and emptied by the other. Mailbox retention must be the longer of the two, by a wide margin.

## Know which limits already exist {#limits}

| Clock              | Who sets it                     | Default   | Do clients see it?               | What it bounds                                                 |
| ------------------ | ------------------------------- | --------- | -------------------------------- | -------------------------------------------------------------- |
| Compact-after      | The mesh, in its manifest       | 7 days    | Yes                              | How long an uploaded change waits before a snapshot covers it  |
| Maximum offline    | The mesh, in its manifest       | 30 days   | Yes                              | How long an absent device's unsent writes stay publishable     |
| Mesh idle life     | The storage owner               | Unlimited | Only through the eviction record | How long an unwritten mesh stays on the disk                   |
| Durable file life  | The storage owner               | Unlimited | No                               | Nothing yet; file bodies are kept until overwritten or deleted |
| Backup and restore | The storage provider, or nobody | None      | No                               | Whether anything survives the deletion at all                  |

The first two travel with the mesh, so every device already agrees on them. The rest belong to whoever owns the disk, and on a plain WebDAV server or an S3 bucket there is no code anywhere that will tell a device what they are.

Absent must be read as **unknown**, never as unlimited. A mesh that has never been told its mailbox retention does not thereby have none.

## Measure idleness in writes {#idle}

An Interocitor mesh is a medium. Every trusted device already holds a complete copy, and the mailbox exists so that copies can reach each other. That makes the useful question not "is anybody looking at this?" but "is anything new happening to it?"

So the idle clock counts **writes**: new records, new devices announcing themselves, new snapshots. A mesh that is read every day and written to never is a mesh whose devices already have everything it holds. Storing it is storing a copy of what the readers are reading from.

The recommended idle life is **one year**. It is far past the thirty-day offline limit, past any plausible holiday, sabbatical, or dormant project, and short enough that abandoned meshes do not accumulate on an operator's disk forever. On a Cloudflare deployment that is a single setting. On an S3-compatible bucket an object-age lifecycle rule expresses the same policy, because object age is write age.

Two consequences follow, and both should be stated to users rather than discovered by them:

- **A mesh of readers can expire.** A read-only device holds a copy but cannot originate a change, so a mesh whose remaining participants are all readers will go idle and be evicted on schedule.
- **Reconnecting is not writing.** A device that opens the mesh, finds nothing new, and writes nothing has not extended its life.

## Understand that eviction is not deletion {#eviction}

When the idle clock runs out the mailbox reclaims the storage. What it does not do is end the mesh.

The mesh identity survives. Its address still routes, its record still exists, and it is marked **evicted** rather than removed. A device that connects afterwards is told what happened instead of finding an empty room and quietly assuming it is the first to arrive.

And because every trusted device holds a complete copy of what it has seen, the devices put the mesh back between them. Each one that reconnects learns that the mesh has started a new life, republishes its own rows with their original timestamps, and lets the usual last-writer-wins merge settle the overlaps. It has to be each one: two devices that last synced at different moments hold different sets, so letting only the first to return refill the mesh would quietly lose whatever the others alone still hold. Where the devices are still around, an eviction costs each of them one round of re-upload.

This is the honest shape of the guarantee, and it cuts both ways:

- **As an operator, you can reclaim storage without destroying anything** whose owners still care about it. The ones who care will bring it back.
- **As a compliance measure, eviction proves nothing.** Emptying the mailbox does not delete the data, because the data is on the devices, and the devices will restore it. Real deletion means revoking the address so no device may reach it, and rotating the mesh key so the copies that remain cannot be rejoined. Storage reclamation is a cost control. Do not sell it as erasure.

## Know what does not come back {#irreversible}

Refill is a row story. Several things are outside it.

- **File bodies are not refilled.** Durable files are written straight to the remote and never cached locally, so a device holding the rows holds only the digests that name the files. Rows come back pointing at bytes that are gone. A Cloudflare deployment sweeping an idle mesh deliberately keeps file bodies for this reason; a bucket lifecycle rule that expires everything by age does not.
- **Devices past the offline limit lose their queue.** A device absent longer than the mesh's maximum offline duration rebuilds from the remote rather than publishing its stale work, and that work stays in a local quarantine for a person to review. This is normal policy, but a returning device can meet an evicted mesh and an expired queue in the same reconnect.
- **Nothing outlives the last copy.** A mesh whose devices are all gone is gone when the mailbox reclaims it. There is no copy left to refill from. If that matters, the answer is a storage-level backup, tested by restoring it, not a longer idle clock.

## Publish your numbers {#publish}

A deployment's retention policy is part of its contract with the people using it, not an operational detail behind it. Decide and state:

1. the idle life of a mesh, and that it is measured in writes;
2. whether file bodies survive an eviction, or expire on their own clock;
3. the byte and object limits one mesh may reach before writes are refused;
4. what backup exists, how far back it goes, and when a restore was last tested;
5. what a deletion request actually does, given that eviction alone does not delete.

Where the mailbox is a Cloudflare deployment, the sweep can state the first two itself, so the numbers cannot drift from the code. Where it is a bucket, a server, or somebody's NAS, the numbers live in your own documentation and nowhere else. Write them down anyway. A limit nobody can discover is a limit your users will find out about the hard way.

Operational wiring for a Cloudflare deployment is in [Mailbox operations](/mailbox). The protocol side of history retention is in [Compaction](/compaction).
