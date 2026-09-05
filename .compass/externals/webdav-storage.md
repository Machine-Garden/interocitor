# WebDAV storage service

## What it is

A file server that speaks WebDAV — a NAS appliance, a Nextcloud or ownCloud
instance, or any HTTP service implementing the same verbs. It is a place to put
bytes at paths, owned and administered by whoever runs it.

## Good at

Holding whole objects at stable paths, listing a directory, and being somewhere
its owner already trusts and already backs up.

## Bad at

Anything conditional. There is no compare-and-swap, no ETag write guard, and no
notion of a transaction across two paths.

## How it breaks

Authentication expires mid-session. Listings paginate or truncate. Servers
differ on `PROPFIND` depth, on whether a `PUT` to a missing parent creates it,
and on how they encode names. A slow or unreachable server looks the same as an
empty mesh until a listing succeeds.

## How you talk to it

HTTP verbs — `PROPFIND`, `GET`, `PUT`, `DELETE`, `MKCOL` — behind the
[storage adapter](../interocitor/mailbox-sync/storage-adapters/README.md)
contract.

## Their chart

—
