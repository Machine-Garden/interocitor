# Store durable file bodies in S3-compatible object storage

Use `S3FileBodyStore` when a mesh's durable file bodies belong in an
S3-compatible bucket while its Interocitor Worker, CRDT sync objects, and
operational metadata remain on Cloudflare. With no `endpoint`, the adapter
defaults to the AWS regional endpoint. Use `AwsS3FileBodyStore` when you want
AWS bucket/region validation or optional SSE-KMS headers. This is a file-body
placement control, not a whole-mesh residency claim.

## Storage boundary

| Surface                                                                   | Storage after S3 is selected        |
| ------------------------------------------------------------------------- | ----------------------------------- |
| Changes, snapshots, manifests, device records, and recovery wrappers      | Cloudflare D1                       |
| Durable-file object name, key, size, uploader, timestamps, and read count | Cloudflare D1                       |
| Durable file body                                                         | The configured S3-compatible bucket |
| Realtime invalidation                                                     | Optional Cloudflare Durable Object  |

With a non-null client `keySource`, Interocitor encrypts the durable body before
the Worker receives it. S3 server-side encryption is an additional storage
layer; it does not replace client encryption. Cloudflare and the Worker still
observe the D1 metadata listed above. The selected object-storage provider
observes its bucket, access principal, object key, stored size, content type,
timing, and any provider-level encryption metadata. The object key contains the
mesh address and an encoded application file path; URL encoding is not
confidentiality protection.

## Prepare the object store

Create a bucket with the provider and record its S3-compatible endpoint and
signing region. The Worker uses that exact endpoint and rejects redirects, so a
wrong endpoint or region fails instead of silently following a redirect.

Configure the provider credentials with only these object permissions on the
chosen key prefix:

- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`

Keep the access key ID, secret access key, and optional session token in Worker
secret bindings, not plaintext Wrangler variables or source. Provider-specific
server-side encryption is additional to client encryption; configure it only
through the provider's supported headers and permissions.

For AWS, use the regional endpoint and `AwsS3FileBodyStore`. If `kmsKeyId`
names a customer-managed KMS key in the same region, the principal also needs
the applicable `kms:GenerateDataKey` and `kms:Decrypt` permissions.

AWS documents the [regional S3 endpoint
forms](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html),
[SigV4 request authentication](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html),
and [SSE-KMS request
headers](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-kms-encryption.html).

## Select S3 for residency-sensitive meshes

This illustrative Worker fragment keeps ordinary meshes in R2 and selects an
Australian S3 bucket for meshes admitted under the `sensitive-au-` namespace.
The surrounding Worker, D1 schema, integrity gates, and authorization policy
are application-owned setup.

```ts
import {
  R2FileBodyStore,
  AwsS3FileBodyStore,
  createInterocitorMount,
  type D1Database,
  type R2Bucket,
} from "@interocitor/workers";

interface Env {
  INTEROCITOR_DB: D1Database;
  INTEROCITOR_FILES: R2Bucket;
  AWS_S3_BUCKET: string;
  AWS_S3_ACCESS_KEY_ID: string;
  AWS_S3_SECRET_ACCESS_KEY: string;
  AWS_S3_KMS_KEY_ID: string;
}

const mount = createInterocitorMount<Env>({
  mountPrefix: "/sync",
  db: (env) => env.INTEROCITOR_DB,
  files: (env, { address }) => {
    if (!address.startsWith("sensitive-au-")) {
      return new R2FileBodyStore(env.INTEROCITOR_FILES);
    }
    return new AwsS3FileBodyStore({
      bucket: env.AWS_S3_BUCKET,
      region: "ap-southeast-2",
      accessKeyId: env.AWS_S3_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_S3_SECRET_ACCESS_KEY,
      kmsKeyId: env.AWS_S3_KMS_KEY_ID,
      keyPrefix: "interocitor",
    });
  },
  runtime: {
    meshIntegrityGates: [acceptApplicationMesh],
    meshMiddleware: [authorizeApplicationMesh],
  },
});
```

Every read, overwrite, and delete for a mesh must make the same selection. The
resolver receives only the accepted mesh address; the object name and
request headers do not choose the provider. Moving an existing mesh between R2
and S3 requires an explicit body migration before changing the resolver.

## S3-compatible adapter configuration

| Option            | Required | Behavior                                                                                  |
| ----------------- | -------- | ----------------------------------------------------------------------------------------- |
| `bucket`          | Yes      | Provider bucket name                                                                      |
| `region`          | Yes      | Provider region used in the SigV4 credential scope; values such as `auto` and `fsn1` work |
| `accessKeyId`     | Yes      | Provider access key                                                                       |
| `secretAccessKey` | Yes      | Provider secret access key                                                                |
| `endpoint`        | No       | HTTPS S3 endpoint; omitted means AWS's regional endpoint                                  |
| `addressingStyle` | No       | `path` or `virtual`; custom endpoints default to `path`                                   |
| `sessionToken`    | No       | Token for temporary credentials                                                           |
| `keyPrefix`       | No       | Prefix prepended to every Interocitor object key                                          |
| `fetcher`         | No       | Fetch implementation; defaults to the Worker global `fetch`                               |

`S3FileBodyStore` validates provider-neutral bucket, region, credential, and
HTTPS endpoint shapes. An absent object makes `get()` return `null`. Other
non-success responses reject with the S3 operation, HTTP status, and provider
request ID when one is present; response bodies are not copied into the error.

`AwsS3FileBodyStore` additionally validates AWS general-purpose bucket names
and regions and accepts the optional `kmsKeyId` setting. It is the AWS-specific
convenience class; it uses the same exact-key implementation.

### Cloudflare R2

Use the native `R2FileBodyStore` when the Worker has an R2 binding. If the
Worker must reach R2 through its S3 API, configure the account endpoint and
`region: "auto"`; the generic adapter defaults to path-style addressing for a
custom endpoint:

```ts
new S3FileBodyStore({
  bucket: env.R2_BUCKET_NAME,
  endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  region: "auto",
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
});
```

### Hetzner Object Storage

Pass the location endpoint and location name as the endpoint and signing
region. Path style is the default for custom endpoints; set
`addressingStyle: "virtual"` if the deployment prefers bucket-host addressing:

```ts
new S3FileBodyStore({
  bucket: env.HETZNER_BUCKET,
  endpoint: "https://fsn1.your-objectstorage.com",
  region: "fsn1",
  accessKeyId: env.HETZNER_ACCESS_KEY,
  secretAccessKey: env.HETZNER_SECRET_KEY,
});
```

The implementation signs the request body, uses HTTPS, and performs exact-key
GET, PUT, and DELETE only. D1 remains authoritative for quotas and durable-file
application and operational metadata. The selected object store persists the
body and content type and reports the stored size and optional ETag needed to
serve that body; it
does not own the D1 metadata. A
successful S3 PUT followed by a D1 failure can leave an orphan
object, and a successful S3 delete followed by a D1 failure can leave stale D1
metadata; this is the same two-store failure boundary as the R2 configuration.
