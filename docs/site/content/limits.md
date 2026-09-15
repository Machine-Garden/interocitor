---
title: Where does security actually live?
description: Compare server-held and client-held custody, understand what browser extensions and code replacement defeat, and find the physical limit every security model reaches.
kicker: Security · Limits
heading: Every security model ends somewhere physical.
lede: Security is not a property a system has. It is a location where a secret is kept and a set of people trusted to keep it. Moving data out of the cloud moves that location; it does not remove it.
---

## Move the secret, not the risk {#relocation}

Every design keeps the secret somewhere. Choosing an architecture does not reduce risk in the abstract — it decides who holds the key, and therefore who has to be compromised before your data is readable.

Conventional applications put the secret on the server. Interocitor puts it on the client. Both are defensible. Neither is safe in a way that survives the question "safe from whom?"

> A security claim is a statement about custody, not about software.

Read [Trust & key custody](/trust) for how custody is configured. This page is about what custody can and cannot achieve at all.

## Count what a breach costs {#blast-radius}

The usual argument for local-first is that the client is more trustworthy than the cloud. That argument is weak, and it is not the one Interocitor makes. By any honest measure a browser is a worse-defended environment than a datacenter.

The real difference is **blast radius**.

| | Server-held custody | Client-held custody |
| --- | --- | --- |
| Who must be compromised | The operator | One user's device |
| What one compromise yields | Every user's data | That user's data |
| Attack economics | One target, enormous payoff | Many targets, small payoffs each |
| Who can be compelled | One company, one jurisdiction | Each person individually |

A datacenter is defended far better than a laptop and is worth attacking far more. Interocitor does not claim your device is a stronger vault. It claims a breach of the mailbox yields ciphertext, and that compromising you does not compromise anyone else.

## Read the server bill honestly {#server}

Server-held custody buys real things that client-held custody does not: centralized patching, revocation, rate limiting, audit logs, anomaly detection, an operations team paged at three in the morning — and account recovery, which matters more than most threat models admit. A user who forgets everything can still be let back in.

It is also genuinely well engineered. The chain runs from encryption on the disks, through key-management hardware, access control, and audit regimes, out to badge readers, camera coverage, staff background checks, and a fence around a building.

Follow that chain to its end and it terminates in a fence, a guard, an employment contract, and a legal system. The last links are physical and social, not cryptographic. That is not a flaw in the design. It is what the bottom of every design looks like.

The cost is the trade: the operator can read your data, and so can anyone who compromises, buys, subpoenas, or joins the operator.

## Accept what the browser is {#browser}

Client-held custody moves the secret into an environment you do not control and cannot harden from inside the page.

- **Extensions sit above your page.** A content script shares your origin and can read `localStorage` and IndexedDB. Page CSP has never governed content-script execution, and an extension can strip your CSP response header before your page parses it. You cannot configure your way out of this from the page.
- **Userscripts are the same authority** with a lower installation bar.
- **Your code is re-delivered on every load.** A server-side application is deployed once and can be audited as deployed. A web application is shipped fresh to every visitor, so "the code I reviewed" and "the code running in this tab" are separate claims. Anyone who can change what your origin serves — you, your host, your CDN, an attacker with your deploy credentials, or a court order — changes the application for everyone with no visible trace. Subresource integrity, integrity manifests, and transparency logs are the proposed answer to this, and they are early-stage standardization rather than something you can rely on today.
- **The disk outlives the session.** A copied browser profile, a laptop backup, or a synced profile carries the local replica and any credential stored beside it.

Interocitor addresses the last of these and can raise the cost of the first. It does not address hostile first-party code. If the code serving your application is against you, no configuration of this library helps — it is the thing doing the decrypting.

## Reach the end of the chain {#physics}

Beyond software there is a limit that no design crosses.

A person who can reach *you* does not need to break your encryption. Security folklore calls this rubber-hose cryptanalysis, and there is a well-known cartoon about a five-dollar wrench; most languages have their own grimmer version of the joke. The point behind it is serious and load-bearing: your cryptosystem's strength is capped by what happens to the human holding the key.

This is not an argument for giving up. It is the boundary condition that tells you where to stop spending. If your threat model includes someone arriving at your home, or a state with a warrant for your person, then software is not the layer that saves you, and choosing a sync library is not the decision that matters.

State that limit plainly to your users. A product that implies otherwise is lying to people who may be relying on it.

## Spend where the attacks are {#distribution}

Real attacks are overwhelmingly bulk, automated, opportunistic, and remote. Almost nobody is coming to your home. A great many people are running an extension that scrapes browser storage across every origin it can reach, and a great many laptops are lost with the screen unlocked.

Design for that distribution:

- Make the common, automated attack expensive and unrewarding.
- Make the targeted attack require work specific to your application, so it does not come for free with a generic tool.
- Be explicit that the tail — hostile first-party code, a determined targeted attacker, physical coercion — is not covered.

Raising cost is a legitimate goal even when it is not a boundary. The failure is not having cheap deterrents; it is describing a deterrent as a guarantee.

## Know what Interocitor claims {#claims}

| Threat | Covered | By what |
| --- | --- | --- |
| Storage operator reads your rows | Yes | Payload encryption before upload; the remote is a mailbox |
| Remote breach or backup leak | Yes | The remote holds ciphertext it cannot decrypt |
| Copied disk or browser profile | Partly | Credential custody options; the local replica itself is not yet encrypted |
| Bulk storage-scraping extension | Partly | Credential custody; an application-supplied second key raises cost |
| Extension targeting your application | No | It runs above the page and can read what the page can read |
| Hostile or replaced first-party code | No | It holds the key by definition |
| Remote withholding or rolling back data | No | Detected in some cases, not prevented; see [the security model](/security) |
| Coercion of a key holder | No | Outside what software can reach |

"Partly" is doing real work in that table. Read it as "raises cost", never as "prevents".

## Treat security as a practice {#practice}

The library is one link. A strong link in a chain of weak ones is decoration.

What actually determines whether your data stays yours:

- Full-disk encryption, a screen that locks, and an OS that gets updates.
- A browser profile you are deliberate about, and extensions you actually chose and still trust.
- Separate meshes for data that must not mix, so that one compromise does not become all of them.
- A key custody mode matched to the device: memory-only on shared machines, a passkey or passphrase where the device is yours but the disk may be copied.
- Mesh key material treated as the capability it is — generated, never chosen by hand, never reused across meshes, never pasted into anything you would not paste a password into.
- An honest answer to "what happens if I lose this", decided before you need it. See [Trust & key custody](/trust).

None of these are settings in this library. That is the point. Interocitor can make the remote unable to read your data and can give you real choices about where the key lives. The rest is a practice, and it belongs to whoever is running the application.
