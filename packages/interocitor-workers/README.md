<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# interocitor-workers

Cloudflare Workers runtime for Interocitor-native sync endpoints, invalidation fanout, and maintenance workflows.

## What it is

This package contains a generic Worker entrypoint intended to back Interocitor-native storage flows on Cloudflare using:

- Workers
- Durable Objects
- D1
- Server-sent events for invalidation

## Entry point

- worker source: `src/index.js`

## Example consumer

The current TODO demo that consumes this runtime lives here:

- GitHub: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-cloudflare-do>
- Monorepo path: `examples/todo-cloudflare-do`

That example uses this package as its Wrangler `main` entry, but this package is intended to stay generic rather than demo-bound.

## Current scope

- native IO endpoints
- folder/file metadata
- append-only mutation support
- compaction hooks
- path activity tracking
- maintenance and TTL cleanup
- SSE invalidation streams

## License

MIT
