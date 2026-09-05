# Compass

## Roots

| Root                          | What it is                                                                                                                 | The orientation it gives                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [interocitor](./interocitor/) | A protocol and client library for trusted devices sharing an encrypted data space over storage that does not understand it | Where in the protocol and its runtimes am I — rows, artifact exchange, files, trust, or the host side of a mailbox |

## External systems

| Name                                                           | Owner                                                 | Scope boundary                                                                         | Shared domain terms                   | Their chart |
| -------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- | ----------- |
| [WebDAV storage service](externals/webdav-storage.md)          | Whoever runs the NAS, Nextcloud, or ownCloud instance | Byte objects at paths, listed and fetched over HTTP                                    | remote mailbox, durable file          | —           |
| [Google Drive](externals/google-drive.md)                      | Google, on behalf of the account holder               | A user's own Drive files and folders                                                   | remote mailbox, durable file          | —           |
| [Cloudflare platform](externals/cloudflare-platform.md)        | Cloudflare, on behalf of the account holder           | Worker execution, D1 rows, R2 objects, Durable Objects                                 | remote mailbox, mesh address          | —           |
| [S3-compatible object storage](externals/s3-object-storage.md) | AWS or another S3-compatible provider                 | Buckets of immutable-addressed byte objects                                            | remote mailbox, durable file          | —           |
| [Host application](externals/host-application.md)              | The team deploying Interocitor                        | Identity, sessions, membership, and the authorization decision a mailbox host enforces | mesh address, mesh                    | —           |
| [WebAuthn authenticator](externals/webauthn-authenticator.md)  | The person holding the passkey or security key        | Origin-scoped credentials and the blobs bound to them                                  | credential store, credential envelope | —           |

## Named dependencies that are not external systems

| Name                    | Used by                        | Why it is not one                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IndexedDB               | `interocitor.rows.local-store` | A browser storage engine the runtime supplies; nobody names it as a service they possess, and it disappears with the tab's origin                                                                                                    |
| SQLite                  | `interocitor.rows.local-store` | An embedded library linked into the Apple runtime; the database file it reads belongs to the app, not to a separate party                                                                                                            |
| Web Crypto              | `interocitor.trust.encryption` | The platform primitive that performs AES-GCM; it computes, it holds nothing, and it is gone when the process is                                                                                                                      |
| React                   | `interocitor.rows.table-api`   | A rendering framework the consuming application chooses; the row subscriptions it exposes exist without it                                                                                                                           |
| CryptoKit               | `interocitor.trust.encryption` | The Apple platform primitive that performs the same AES-GCM as Web Crypto on another runtime; it computes and holds nothing                                                                                                          |
| D1, R2, Durable Objects | `interocitor.mailbox-host`     | Products of the [Cloudflare platform](./externals/cloudflare-platform.md), already admitted as one external system; naming each binding separately would inventory a dependency manifest rather than a service an operator possesses |
