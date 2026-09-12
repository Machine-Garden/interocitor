# S3-compatible object storage

## What it is

A bucket service speaking the S3 API — AWS S3 by default, or any provider
implementing the required surface. A direct storage adapter can place a whole
mailbox beneath one bucket prefix. A mailbox host can instead use S3 only for
durable file bodies while keeping row artifacts and file metadata in D1.

## Good at

Large byte objects, lifecycle rules, and a storage bill an **operator** already
understands.

## Bad at

Listing at scale and read-after-write expectations across regions. It offers no
merge, no query over content, and no notion of what an object means.

## How it breaks

Credentials rotate out from under a running browser or deployment. Requests are
signed, so clock skew fails them. Browser access also depends on bucket CORS.
Replication, lifecycle policy, or restore can make current objects absent or
replace them with older valid bytes.

## How you talk to it

Signed S3 requests either from the browser-capable
[storage adapter](../interocitor/mailbox-sync/storage-adapters/README.md) or from
the [file body stores](../interocitor/mailbox-host/file-body-stores/README.md)
inside the mailbox host. The direct adapter uses temporary prefix-scoped
credentials and does not obtain or persist them itself.

## Their chart

—
