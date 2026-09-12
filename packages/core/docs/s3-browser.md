# Use an S3 mailbox from a browser

`S3Adapter` lets a browser use AWS S3 or a compatible object store as the
complete Interocitor mailbox. Row changes, snapshots, control records, and
durable files all become objects beneath one bucket prefix.

This is different from the Worker `S3FileBodyStore`: that deployment keeps row
history and file metadata in D1 and sends only durable-file bodies to S3.

## Before you connect

The bucket endpoint must:

- be reachable over HTTPS from the browser;
- allow the application's exact origin through CORS;
- support SigV4 `GET`, `PUT`, `DELETE`, `HEAD`, and ListObjectsV2 requests; and
- authorize the client only for the mailbox prefix it needs.

Do not ship a long-lived S3 secret in JavaScript or browser storage. Have a
trusted service exchange the application's session for short-lived,
prefix-scoped credentials. The adapter calls a credential provider before each
request, so that provider can refresh credentials as they expire.

## Connect the adapter

This partial integration assumes the application owns the temporary-credential
route and its normal error UI:

```ts
import { Interocitor, PortablePassphraseKeySource } from "@interocitor/core";
import { S3Adapter } from "@interocitor/core/adapters/s3";
import { IndexedDbLocalStore, createWebCredentialStore } from "@interocitor/web";

const dbName = "tasks";

const adapter = new S3Adapter({
  bucket: "acme-interocitor",
  region: "ap-southeast-2",
  keyPrefix: "mailboxes/alice",
  credentials: async () => {
    const response = await fetch("/api/interocitor/s3-credentials");
    if (!response.ok) throw new Error("Could not obtain mailbox credentials");
    return response.json();
  },
});

const db = new Interocitor(adapter, {
  dbName,
  remotePath: "/team-planning",
  localStore: new IndexedDbLocalStore(dbName),
  keySource: new PortablePassphraseKeySource({
    credentialStore: createWebCredentialStore(dbName, { storage: "sessionStorage" }),
  }),
});

await db.connect();
```

The credential response has this shape:

```ts
interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
```

Passing a static `S3Credentials` object is supported for controlled
development, but it does not solve safe distribution or rotation in a shipped
browser application. After an application obtains a replacement credential,
`adapter.setCredentials(nextCredentials)` marks the adapter unauthenticated;
call `db.connect()` to resume the remote session.

## Configure bucket CORS

This illustrative AWS S3 CORS rule permits one deployed application origin:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": [
      "authorization",
      "content-type",
      "x-amz-content-sha256",
      "x-amz-date",
      "x-amz-security-token"
    ],
    "ExposeHeaders": ["ETag", "Last-Modified", "Content-Length", "x-amz-request-id"],
    "MaxAgeSeconds": 3600
  }
]
```

Adapt the rule to the provider's CORS format. Keep `AllowedOrigins` and
`AllowedHeaders` narrow. A browser reports many CORS failures as a generic
network error; the adapter's message points back to endpoint reachability and
bucket CORS, while the browser console usually identifies the rejected header.

AWS documents the [CORS rule elements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
and [ListObjectsV2 request](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).

## Grant only one prefix

The issuing service should scope the temporary principal to:

- `s3:ListBucket` on the bucket, limited to `mailboxes/alice/*`; and
- `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on
  `arn:aws:s3:::acme-interocitor/mailboxes/alice/*`.

The exact policy syntax varies between S3-compatible providers. Prefix
isolation is an access boundary, not a confidentiality substitute: configure a
non-null Interocitor key source so application payloads are protected before
the adapter uploads them.

## Use a compatible endpoint

AWS regional endpoints are selected when `endpoint` is omitted. This partial
configuration assumes `getTemporaryCredentials` is supplied by the host
application; a compatible provider normally needs an explicit endpoint and
signing region:

```ts
const adapter = new S3Adapter({
  bucket: "interocitor",
  region: "auto",
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  addressingStyle: "path",
  credentials: getTemporaryCredentials,
});
```

Custom endpoints default to path-style URLs. Set `addressingStyle: "virtual"`
only when the provider expects the bucket in the hostname. Buckets containing
a dot always fall back to path style so the generated hostname does not create
a TLS wildcard mismatch. Plain HTTP is rejected except for loopback endpoints
used in local development.

## Configuration reference

| Option             | Required | Meaning                                                                                                              |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `bucket`           | Yes      | Bucket carrying the mailbox objects.                                                                                 |
| `region`           | Yes      | Region in the SigV4 credential scope. Use a provider-documented value such as `auto` only with an explicit endpoint. |
| `credentials`      | Yes      | Static credentials or an async provider returning current credentials.                                               |
| `endpoint`         | No       | HTTPS S3-compatible endpoint. Defaults to AWS for the selected region.                                               |
| `addressingStyle`  | No       | `virtual` for AWS by default; `path` for custom endpoints by default.                                                |
| `keyPrefix`        | No       | Prefix prepended to every Interocitor path, without creating a folder object.                                        |
| `requestTimeoutMs` | No       | Deadline for each request; defaults to 30 seconds.                                                                   |
| `fetcher`          | No       | Alternate `fetch`, intended for compatible runtimes and tests.                                                       |

`getHandshakeConfig()` returns only bucket, region, endpoint, addressing style,
and prefix. It never returns credentials. A paired endpoint must obtain its own
authorized credential; possession of a pairing payload does not grant bucket
access.

## Object-store behavior and limits

S3 has prefixes rather than folders, so `ensureFolder()` is a no-op. Listings
use ListObjectsV2 with `/` as a delimiter and follow continuation tokens until
all direct children are collected. Reads, writes, metadata checks, and deletes
map to exact `GET`, `PUT`, `HEAD`, and `DELETE` requests signed with
[Signature Version 4](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html).

Every write is one complete object PUT. The adapter does not multipart-upload,
resume, cache, or queue durable-file bodies. Provider object-size limits,
browser memory, bucket lifecycle rules, clock accuracy, quotas, backup, and
restore remain deployment responsibilities. Generic S3 cannot enforce
Interocitor's optional `sealGuard`; use a protocol-aware mailbox when the
remote must reject unauthorized overwrites rather than merely store protected
bytes.
