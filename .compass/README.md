# Interocitor Compass

## Scope

Interocitor is a protocol and client library that lets trusted devices share
an encrypted, convergent data space through commodity storage that never
merges, queries, or reads the data it carries.

## Roots

| Root        | What it is                                  | Chart                                   |
| ----------- | ------------------------------------------- | --------------------------------------- |
| interocitor | The protocol and the runtimes that speak it | [interocitor/](./interocitor/README.md) |

## Out of scope

- **Reader-facing documentation.** The public site, package READMEs, guides,
  and examples describe this system rather than compose it. This chart does not
  govern them.
- **Implementation rationale.** Why a retry sits where it does, why a helper is
  shaped as it is, and every other reason that would vanish in a rewrite belong
  beside the code.
- **Build, test, and release machinery.** `yarn preflight` and the suites it
  runs are live sources; this chart names them rather than describing them.
- **Runtime state.** What a given device has pulled, merged, or queued is
  observability territory, not chart territory.

## Navigating

Registry: [COMPASS.md](./COMPASS.md). Every architectural directory's
identity document is its `README.md`.

Code carries `compass: <address>` markers pointing back here. Find everything
participating in one place with `grep -r "compass: interocitor.trust"`.

`yarn check:chart` (part of `yarn check:static`) asserts the invariants this
chart depends on: every marker address resolves to a document, every
implementation coordinate exists on disk, every link and anchor resolves, the
block set matches CONTAINERS.md, and the five diagram-bearing document kinds
have diagrams. It also asserts minimum scan counts, so a chart that lost its
markers fails rather than passing quietly.
