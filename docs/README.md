# Interocitor public site

Interocitor fits browser apps whose trusted endpoints may hold plaintext while
a protected mesh keeps row changes, snapshots, and durable-file bodies
unreadable to the remote mailbox. Products that require server-side search,
analytics, business logic, or administrator access to plaintext need a
conventional server database instead.

`index.html` owns product-fit and threat-boundary orientation.
`how-it-works.html` owns the visual explanation of the file-sync pattern,
Interocitor's row-sync lifecycle, bounded catch-up through compaction, and its
trust boundary. Keep detailed claims at one of these owners and link from the
other instead of duplicating them.

Recommended Cloudflare Pages settings:

- Build command: none
- Build output directory: `docs`
- Framework preset: none / static

## Content boundary

Site maintainers keep public pages at the product-decision layer:

- advertise the product outcome before implementation detail;
- explain the use cases and trust boundary;
- show the product surfaces and deployment choices;
- route visitors through the sync model, data surfaces, storage choices, and
  trust boundary;
- let visitors understand the complete sync loop through diagrams before
  routing them to protocol reference;
- expose external developer links only when their targets are anonymously
  reachable.

The site must not expose a repository quickstart, package map, API reference, or
protocol manual as landing-page content. Keep those details in the root README,
package READMEs, package-local docs, examples, and JSDoc.

## Landing-page anchors

Keep these local anchors stable:

| Concept            | Anchor            |
| ------------------ | ----------------- |
| Why Interocitor    | `#why`            |
| Use cases          | `#use-cases`      |
| Plain-language fit | `#plain-language` |
| Rows and files     | `#surfaces`       |
| Data model         | `#model`          |
| Remote backends    | `#remotes`        |
| Security boundary  | `#security`       |
| Operational limits | `#docs`           |

## Public pages

| Page                              | Reader question                                                               |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `index.html`                      | Is Interocitor a fit for my application and threat model?                     |
| `how-it-works.html`               | How do independent changes converge, and what happens after history piles up? |
| `examples/todo-webdav/index.html` | Can an Interocitor app work entirely in the browser without a backend?        |

## Publication metadata

Site maintainers own the public URL metadata. A release may include a canonical
URL, `og:url`, or public `@see` URL only while the production domain resolves,
serves the page over valid TLS, and passes an anonymous link crawl. Keep that
metadata absent whenever any condition fails.

The `/how-it-works` route serves the visual explainer. Short documentation
routes such as `/web`, `/workers`, `/mesh-access`, `/recovery`, and `/security`
are also defined in `_redirects` and lead to the corresponding public repository
documentation. Cloudflare Pages or Wrangler interprets these redirects; a basic
static file server does not.

## Local preview

For the landing page alone:

```bash
python3 -m http.server 4174 --directory docs
```

Open `http://127.0.0.1:4174/`. Short documentation routes return `404` in this
mode.

To exercise `_redirects` from the repository root, use the Wrangler binary
already owned by the Cloudflare example workspace:

```bash
yarn workspace todo-cloudflare-do-example exec wrangler pages dev ../../docs --port 4174
```

## Release gate

The site maintainer applies this gate to every public release. Block the release
unless:

1. source and documentation targets are anonymously reachable;
2. repository examples from a clean clone support the homepage's
   capability claims;
3. the candidate deployment serves both public pages and every short route; and
4. publication metadata satisfies the policy above.
