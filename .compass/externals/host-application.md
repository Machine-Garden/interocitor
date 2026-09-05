# Host application

## What it is

The product a team already runs, into which Interocitor is mounted. It owns
users, sessions, membership, billing, and revocation. Interocitor never
authenticates anybody; it asks this system for a decision and enforces the
answer.

## Good at

Knowing who the caller is and whether they may touch a given **mesh** — the one
question Interocitor deliberately refuses to answer for itself.

## Bad at

Freshness guarantees Interocitor cannot inspect. A revocation that has not
reached the middleware is invisible to the mailbox host.

## How it breaks

A stale token still verifies. A membership check reads a cached row. An
authorization callback throws, and the host must decide whether that denies or
crashes the request.

## How you talk to it

The host supplies mesh middleware and integrity gates to
[access-control](../interocitor/mailbox-host/access-control/README.md), and
wraps its own Worker with Interocitor's mount.

## Their chart

—
