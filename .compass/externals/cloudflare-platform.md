# Cloudflare platform

## What it is

The edge compute and storage products an account holder subscribes to: Workers
for execution, D1 for rows, R2 for object bytes, and Durable Objects for
coordinated state. Interocitor's own Worker runs _on_ this platform; the
platform is not Interocitor's.

## Good at

Running close to the client, giving a deployment one URL prefix, and supplying
both a row store and an object store under one account.

## Bad at

Long-running work and large single objects. Workers have CPU-time and
subrequest budgets, and D1 is not a general-purpose transactional database.

## How it breaks

D1 statements hit size or time limits under large batches. R2 and D1 fall out of
step when one write succeeds and the other does not. Durable Object
sockets drop, which degrades invalidation to polling rather than losing data.

## How you talk to it

Bindings supplied by the host Worker environment, consumed by
[mailbox-host](../interocitor/mailbox-host/README.md) and, from the client
side, by the Cloudflare
[storage adapter](../interocitor/mailbox-sync/storage-adapters/README.md).

## Their chart

—
