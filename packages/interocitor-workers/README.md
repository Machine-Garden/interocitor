<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# interocitor-workers

Cloudflare Workers runtime for Interocitor-native transport flows.

## Why this package exists

Interocitor's rule is simple: the transport must not need to understand your data.

This package provides a Cloudflare-hosted transport layer that adds operational conveniences — request ordering, invalidation fanout, maintenance workflows, metadata tracking — without moving merge or decryption to the server.

That matters because once the server must interpret document structure to do sync work, true client-side encryption stops being structural. `interocitor-workers` keeps the server useful but deliberately dumb about your plaintext.

## What it is

This package contains a generic Worker entrypoint intended to back Interocitor-native storage flows on Cloudflare using:

- Workers
- Durable Objects
- D1
- server-sent events for invalidation

## Entry point

- worker source: `src/index.js`

## Current scope

- native IO endpoints
- folder and file metadata
- append-only mutation support
- post-compaction change pruning hooks
- path activity tracking
- maintenance and TTL cleanup
- SSE invalidation streams

## Important architectural point

The Worker may coordinate transport behavior, but it should not become a merge engine.

- ciphertext comes in
- ciphertext goes out
- clients decrypt
- clients merge
- clients answer queries locally

That is the entire reason Interocitor can promise a privacy-first sync model.

## Example consumer

The current TODO demo that consumes this runtime lives here:

- GitHub: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-cloudflare-do>
- Monorepo path: `examples/todo-cloudflare-do`

That example uses this package as its Wrangler `main` entry, while this package itself stays generic and reusable.

## What this package is not

- not a general-purpose database API
- not a server-side CRDT merge service
- not plaintext application storage

## License

MIT
