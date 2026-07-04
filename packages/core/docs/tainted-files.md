# Tainted files

Interocitor has two storage planes with different guarantees:

- **Rows are offline-first.** They are CRDT data, sync into the local store, merge, and remain queryable without a network.
- **Files are online-first.** Durable file bytes live in adapter-backed object storage. A client can keep an offline row reference to a file, but file bytes and object metadata are fetched live.

That split defines where access labels belong.

## Taint labels

A taint is a human-readable label for a non-default file key, such as `group1`.

Applications should store the authoritative taint in the CRDT row that references the file:

```ts
{ path: 'docs/q4.pdf', taint: 'group1' }
```

That row is the offline-legible access surface. Clients can list files, show lock badges, and decide which key to unlock without downloading the object.

Core echoes the same taint into durable file metadata when the file is sealed with an extra key. The metadata echo is not the discovery path; it is an anti-silent-failure guard for clients that reach a file by path without its row.

## Sealing a file

Writing a tainted file binds the label and key together:

```ts
await db.putFile('docs/q4.pdf', bytes, 'application/pdf', {
  taint: 'group1',
  key: groupKey,
});
```

Absent a seal, files use the mesh key and have no taint.

Core does not interpret taints, resolve groups, wrap keys, or enforce ACL policy. The app owns the ACL, for example `user1 -> group1 -> wrapped-key` in a directory Interocitor.

## Download is not view

A tainted file can be downloaded before it is viewed. `openFile(path)` fetches object bytes and metadata, but does not decrypt tainted bytes. The app reads the taint, performs its unlock flow (biometry, passkey, keychain, or wrapped-key unwrap), then calls `open(key)`.

```ts
const sealed = await db.openFile('docs/q4.pdf');
console.log(sealed.taint); // "group1"
const key = await unlockGroupKey(sealed.taint);
const plaintext = await sealed.open(key);
```

`getFile(path)` remains the simple mesh-key read path. It refuses tainted files with an explicit error so callers do not discover the extra-key requirement through a failed decrypt.
