<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="Interocitor" width="560"/>
  </a>
</p>

# @interocitor/webdav

Disposable loopback WebDAV and static-file server for Interocitor development,
demos, and integration tests.

> **Do not deploy this server.** It has no authentication, authorization, TLS,
> request-size limit, or tenant isolation. It also serves files from the
> repository root on non-WebDAV routes. The process binds to `127.0.0.1`, but
> any local process or browser page that can reach the port can use it.

Run the public package from the repository with the commands below.

## Start the server

From the repository root, after `yarn install`:

```bash
node packages/webdav/server.mjs --mode=memory
```

The WebDAV base URL is:

```text
http://127.0.0.1:4173/__webdav__
```

Set another loopback port with `PORT`:

```bash
PORT=4174 node packages/webdav/server.mjs --mode=memory
```

These are complete runnable commands. Node.js 18 or later is required.

## Storage modes

### Memory

`--mode=memory` is the default. All WebDAV objects live in process memory and
disappear when the process exits.

### File

File mode makes remote objects inspectable on disk:

```bash
node packages/webdav/server.mjs \
  --mode=file \
  --data-root=examples/todo-webdav/webdav-data
```

The argument parser requires the `--name=value` form shown above. A relative
`--data-root` is resolved from the repository root, not the current working
directory.

**File mode deletes the entire resolved data-root directory every time the
server starts.** Use only a dedicated disposable path. Do not point it at
source code, a home directory, or data you need to keep.

## Routes and behavior

| Route | Behavior |
| --- | --- |
| `/__webdav__/*` | Unauthenticated WebDAV `OPTIONS`, `PROPFIND`, `MKCOL`, `PUT`, `GET`, and `DELETE` |
| `/` | Serves `examples/index.html` |
| any other path | Serves the corresponding file below the repository root, or the test harness fallback |

The server is a byte transport. It does not query rows, merge CRDT changes, or
perform encryption. Interocitor clients encrypt change and snapshot payloads
only when their engine has been configured with key material. Without client
encryption, this server stores readable bytes.

## Use it with an Interocitor client

Point a WebDAV adapter at the route base. This partial configuration fragment
assumes an initialized application and imports from the current source build:

```ts
import { WebDAVAdapter } from '@interocitor/core';

const adapter = new WebDAVAdapter({
  baseUrl: 'http://127.0.0.1:4173/__webdav__',
});
```

For an end-to-end runnable browser flow, use the
[WebDAV TODO example](../../examples/todo-webdav/README.md). For test isolation
and browser-test setup, see
[Test an Interocitor product](../core/docs/testing.md).

## Validate the package

From the repository root:

```bash
yarn workspace @interocitor/webdav check
```

This syntax-checks `server.mjs`. Integration coverage is owned by the root
WebDAV and browser suites; see the repository `package.json` for the current
targeted commands.

## What this package is not

- a production or self-hosted sync service;
- a database or query server;
- an authentication layer;
- an encryption layer;
- a durable mailbox.

## License

MIT
