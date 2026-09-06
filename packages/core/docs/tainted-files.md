# Tainted files

Interocitor has two storage planes with different guarantees:

- **Rows are offline-first.** They are CRDT data, sync into the local store, merge, and remain queryable without a network.
- **Files are online-first.** Durable file bytes live in adapter-backed object storage. A client can keep an offline row reference to a file, but file bytes and object metadata are fetched live.

That split defines where access labels belong.

## Taint labels

A taint is a human-readable label for a non-default file key, such as `group1`.

Applications should store the authoritative taint in the CRDT row that references the file. A `types.file` column carries it as part of the `FileRef`:

```ts
const meta = await db.putFile("docs/q4.pdf", bytes, "application/pdf", {
  taint: "group1",
  key: groupKey,
});
await db.table("docs").patch(docId, { file: toFileRef("docs/q4.pdf", meta) });
// → file: { path: "docs/q4.pdf", digest: "…", size: 81920, contentType: "application/pdf", taint: "group1" }
```

That row is the offline-legible access surface. Clients can list files, show lock badges, and decide which key to unlock without downloading the object.

Core echoes the same taint into durable file metadata when the file is sealed with an extra key. The metadata echo is not the discovery path; it is an anti-silent-failure guard for clients that reach a file by path without its row.

## Sealing a file

Writing a tainted file binds the label and key together:

```ts
await db.putFile("docs/q4.pdf", bytes, "application/pdf", {
  taint: "group1",
  key: groupKey,
});
```

Absent a seal, files use the mesh key and have no taint.

Core does not interpret taints, resolve groups, wrap keys, or enforce ACL policy. The app owns the ACL, for example `user1 -> group1 -> wrapped-key` in a directory Interocitor.

## Download is not view

A tainted file can be downloaded before it is viewed. `openFile(path)` fetches object bytes and metadata, but does not decrypt tainted bytes. The app reads the taint, performs its unlock flow (biometry, passkey, keychain, or wrapped-key unwrap), then calls `open(key)`.

```ts
const sealed = await db.openFile("docs/q4.pdf");
console.log(sealed.taint); // "group1"
const key = await unlockGroupKey(sealed.taint);
const plaintext = await sealed.open(key);
```

`getFile(path)` remains the simple mesh-key read path. It refuses tainted files with an explicit error so callers do not discover the extra-key requirement through a failed decrypt.

## Override protection

Mesh membership alone must not be enough to replace or remove a sealed file. When a file is sealed, core sends the store a **seal guard**: an HMAC of the object's remote name under a key derived from the seal key. The store keeps the guard and refuses a later overwrite or delete that does not present the same value. The guard reveals neither the key nor the label, and different objects give unrelated guards, so the store cannot group files by key.

Deleting a sealed file therefore takes the key as well:

```ts
await db.deleteFile("docs/q4.pdf", { key: groupKey });
```

The worker and the in-memory adapter enforce the guard. A plain object store such as WebDAV has no logic to run, so there override protection is undefined and mesh membership is the only gate. Label-aware policy, such as which subjects may write `legal` files at all, is application-specific and belongs in the host's upload-authorization hook using the host's own credentials; the worker never sees the label.
