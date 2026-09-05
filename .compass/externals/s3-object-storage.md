# S3-compatible object storage

## What it is

A bucket service speaking the S3 API — AWS S3 by default, or any provider
implementing the same surface. It holds durable file bodies for a deployment
that does not want them in R2.

## Good at

Large byte objects, lifecycle rules, and a storage bill an **operator** already
understands.

## Bad at

Listing at scale and read-after-write expectations across regions. It offers no
merge, no query over content, and no notion of what an object means.

## How it breaks

Credentials rotate out from under a running deployment. Requests are signed, so
clock skew fails them. Cross-region replication makes a freshly written object
briefly unreadable from another device.

## How you talk to it

Signed S3 requests from the
[file body stores](../interocitor/mailbox-host/file-body-stores/README.md)
inside the mailbox host.

## Their chart

—
