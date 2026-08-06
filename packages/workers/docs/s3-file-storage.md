# Store durable file bodies in AWS S3

Use a regional AWS S3 bucket when a mesh's durable file bodies need placement
in a specific AWS region while its Interocitor Worker, CRDT sync objects, and
operational metadata remain on Cloudflare. This is a file-body placement
control, not an AWS-native Interocitor backend or a whole-mesh residency claim.

## Storage boundary

| Surface                                                                                          | Storage after S3 is selected       |
| ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Changes, snapshots, manifests, device records, and recovery wrappers                             | Cloudflare D1                      |
| Durable-file path, object key, size, content type, `taint`, uploader, timestamps, and read count | Cloudflare D1                      |
| Durable file body                                                                                | The configured AWS S3 bucket       |
| Realtime invalidation                                                                            | Optional Cloudflare Durable Object |

With a non-null client `keySource`, Interocitor encrypts the durable body before
the Worker receives it. S3 server-side encryption is an additional storage
layer; it does not replace client encryption. Cloudflare and the Worker still
observe the D1 metadata listed above. AWS observes the bucket, IAM principal,
object key, stored size, content type, timing, and KMS request metadata. The
object key contains the mesh address and an encoded application file path; URL
encoding is not confidentiality protection.

## Prepare the regional bucket

Create a general-purpose S3 bucket in the required AWS region. The Worker uses
the corresponding regional endpoint and rejects redirects, so a wrong region
fails instead of following S3 to another endpoint. Do not configure cross-region
replication when the residency policy forbids copies elsewhere.

Give the Worker IAM principal only these object permissions on the chosen key
prefix:

- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`

If `kmsKeyId` names a customer-managed KMS key in the same region, the
principal also needs the applicable `kms:GenerateDataKey` and `kms:Decrypt`
permissions. Keep the access
key ID, secret access key, and optional session token in Worker secret bindings,
not plaintext Wrangler variables or source.

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
  S3StoredFileBucket,
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
    if (!address.startsWith("sensitive-au-")) return env.INTEROCITOR_FILES;
    return new S3StoredFileBucket({
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
resolver receives only the accepted mesh address; `taint`, file path, and
request headers do not choose the provider. Moving an existing mesh between R2
and S3 requires an explicit body migration before changing the resolver.

## `S3StoredFileBucket` configuration

| Option            | Required | Behavior                                                                                             |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `bucket`          | Yes      | General-purpose AWS S3 bucket name                                                                   |
| `region`          | Yes      | Exact AWS region used in the endpoint and SigV4 credential scope; values such as `auto` are rejected |
| `accessKeyId`     | Yes      | IAM access key ID                                                                                    |
| `secretAccessKey` | Yes      | IAM secret access key                                                                                |
| `sessionToken`    | No       | Token for temporary AWS credentials                                                                  |
| `keyPrefix`       | No       | Prefix prepended to every Interocitor object key                                                     |
| `kmsKeyId`        | No       | Sends `aws:kms` and this same-region customer-managed key ID on every PUT                            |
| `fetcher`         | No       | Fetch implementation; defaults to the Worker global `fetch`                                          |

Construction rejects an invalid bucket name or region, missing credentials,
and a KMS key ARN from another region. An absent object makes `get()` return
`null`. Other non-success responses reject with the S3 operation, HTTP status,
and AWS request ID when one is present; response bodies are not copied into the
error.

The implementation signs the request body, uses HTTPS, and performs exact-key
GET, PUT, and DELETE only. D1 remains authoritative for quotas and returned
file metadata; S3 persists the body and content type, not the D1 metadata. A
successful S3 PUT followed by a D1 failure can leave an orphan
object, and a successful S3 delete followed by a D1 failure can leave stale D1
metadata; this is the same two-store failure boundary as the R2 configuration.
