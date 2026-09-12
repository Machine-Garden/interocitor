# Decide who may upload durable files

A durable-file `PUT` passes three gates before its body reaches the file-body
store, and they answer different questions:

| Layer              | Configured by                                                    | Answers                                         | Can an application skip it? |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| Deployment floor   | `maxStoredFileBytes`, `maxMeshStoredBytes`, the device-id header | What this deployment will store for anyone      | No                          |
| Entitlement        | `standardUploadPolicy(options)` — or your own equivalent         | What this mesh's plan is allowed to store       | It is opt-in                |
| Per-write judgment | `authorizeFileUpload`                                            | Whether this particular write is acceptable now | It is opt-in                |

The floor runs first and never yields: a policy that returns `true` cannot lift
`maxMeshStoredBytes`. Everything a policy expresses can only tighten it. Set
the floor to the widest thing you are willing to store for anybody, and let
policy narrow it per caller.

Field meanings, option defaults, statuses, and failure behavior live in the
[Worker configuration reference](runtime-options.md#durable-file-upload-policy).
This page is about which layer a given requirement belongs in.

## When to use each layer

**Use the deployment floor alone** when every mesh is equal and the only
question is how much this Worker will hold. No policy needed — omit
`authorizeFileUpload` entirely and uploads are governed by size, the required
`X-Interocitor-Device-Id` header, and the per-mesh quota.

**Add `standardUploadPolicy()`** when the mailbox is reachable by anyone who
can mint a mesh address and you want the cheap abuse cases gone without writing
the judgment yourself:

```ts
import { standardUploadPolicy } from "@interocitor/workers";

runtime: {
  authorizeFileUpload: standardUploadPolicy(),
}
```

It expresses one judgment: a mesh created moments ago that has told nobody
about itself has nothing worth sharing, and is the cheapest thing for a script
to manufacture. A mesh that has existed for a minute and holds a second
announced device has passed both tests.

Nothing applies it for you. It is a named, opt-in policy, not a default that
changes behavior on upgrade.

**Write your own `authorizeFileUpload`** when the decision depends on something
only your application knows — a session, a plan, a path convention, a
moderation state. Supplying a function replaces `standardUploadPolicy`
entirely; there is no layer underneath it but the floor. Compose rather than
fork when only part of the judgment is yours (see below).

## Recipes

### Tell bots from first-run users

The defaults are the bot-protection recipe:

```ts
authorizeFileUpload: standardUploadPolicy({
  minMeshAgeMs: 60_000,        // a mesh must have existed a minute
  minDeviceCount: 2,           // and have somewhere to share to
  onUnknownMeshAge: "reject",  // a mesh with no sync root reads as too new
}),
```

Two of these deserve a decision rather than acceptance.

`minMeshAgeMs` is the crudest of these defenses and the one most likely to
catch a real person: a new mesh and a scripted one are described by identical
facts for exactly as long as the window lasts. Shorten it for an application
whose first-run flow uploads immediately.

`onUnknownMeshAge` decides what a mesh holding no sync root may do. A durable
file can be written before any sync flush has happened, so an application that
uploads before its first flush will see **every first upload refused** under
the `"reject"` default. Measure your own first-run flow; set `"allow"` if
uploads legitimately precede the first flush.

Set either check to `0` to disable it without disabling the others.

### Sell a premium tier with a larger store

Keep the deployment ceiling at the widest tier you sell, and narrow it per
plan in policy:

```ts
const free = standardUploadPolicy({ maxMeshStoredBytes: 128 * 1024 * 1024 });
const premium = standardUploadPolicy({
  minMeshAgeMs: 0,
  minDeviceCount: 0,
  maxMeshStoredBytes: 1024 * 1024 * 1024,
});

runtime: {
  maxMeshStoredBytes: () => 1024 * 1024 * 1024, // the widest tier on offer
  authorizeFileUpload: async (request, env) =>
    (await isPremiumAccount(request.request, env))
      ? premium(request)
      : free(request),
}
```

The request body has already been read when policy runs, so `request.request`
still carries headers and cookies — the usual place a plan or session lives.

A tier ceiling credits what an overwrite frees: re-saving a file of the same
size is not charged twice, because `request.replacedBytes` reports the stored
bytes of the object being replaced (`0` when the path is new). Subtract it
whenever you compare a projected total against a limit of your own:

```ts
const projected = mesh.storedBytes - request.replacedBytes + request.size;
```

### Skip the gates for an authenticated caller

Compose instead of forking when your judgment is only an exception to the
standard one:

```ts
const standard = standardUploadPolicy();

runtime: {
  authorizeFileUpload: async (request, env) => {
    if (await isPaidAccount(request.request, env)) return true;
    return standard(request);
  },
}
```

### Decide on the state of the mesh itself

`meshInfo(request)` resolves the facts the deployment's own row store already
keeps — mesh age, announced devices, stored volume — for rules the request
alone cannot answer:

```ts
import { meshInfo } from "@interocitor/workers";

authorizeFileUpload: async (request, env) => {
  if (await isPaidAccount(request.request, env)) return true;

  const mesh = await meshInfo(request);
  if (mesh.ageMs === null || mesh.ageMs < 60_000)
    return { allowed: false, status: 429, reason: "mesh too new" };
  if (mesh.deviceCount < 2) return { allowed: false, status: 403, reason: "nothing to share yet" };
  return request.size <= 4 * 1024 * 1024;
};
```

Stored volume is known before policy runs and costs nothing. Age and device
count are read on first call and memoized for the rest of the request, so a
policy that never asks never pays for them.

In application tests, `provideMeshInfo(request, info)` seeds a hand-built
request; `meshInfo` throws a `TypeError` on a request the runtime did not
supply, so a test cannot silently observe an empty mesh.

## What these facts will not tell you

Every field comes from the deployment's own row store, never from metadata a
client can assert, and encrypted payloads stay opaque. Three limits still
matter before a policy leans on them:

- **`deviceCount` counts announcements, not vouched devices.** Heartbeats are
  ordinary mesh writes, so this stops a bot that only uploads, not one that
  announces devices it invented. One device syncing two roots counts twice.
- **`createdAt: null` is an answer, not a gap.** It means the address holds no
  sync root yet. Decide what that means for your policy rather than treating it
  as zero or as ancient.
- **Rejection happens after the body is read.** A policy limits what gets
  stored, not what gets transferred — and so does `maxStoredFileBytes`, which
  is measured on the received bytes. Cap transfer at the edge if that is the
  cost you care about.

The uploader device id and other client-supplied metadata are policy inputs,
not authenticated identity. The hook governs durable-file writes only; for
whole-mesh request policy use
[`meshMiddleware`](mesh-control.md).
