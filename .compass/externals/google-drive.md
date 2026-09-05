# Google Drive

## What it is

A consumer and workspace file service holding files a person already considers
theirs. An Interocitor **mesh** placed here lives in the account holder's own
Drive, visible and removable through Google's own interface.

## Good at

Durable storage the account holder already has, already pays for, and can
inspect without any Interocitor tooling.

## Bad at

Path addressing. Drive identifies files by opaque IDs with non-unique names, so
every path lookup is a search. Quotas and rate limits apply per account.

## How it breaks

OAuth tokens expire and refresh flows fail. Rate limiting returns retryable
errors under bursty flushes. Two files can legitimately share a name in one
folder, so a name lookup can return more than one candidate.

## How you talk to it

The Drive REST API behind the
[storage adapter](../interocitor/mailbox-sync/storage-adapters/README.md)
contract, with an application-supplied access token.

## Their chart

—
