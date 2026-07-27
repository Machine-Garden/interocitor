# Interocitor public site

Interocitor's public site introduces browser-app teams to local-first rows,
durable remote files, deployment choices, and client-held encryption
boundaries. It establishes product fit before routing qualified readers to
developer documentation.

The deployable files live in this directory. `index.html` is the single product
landing page. Keep experiments outside this boundary; variants dilute the
product story and create stale documentation surfaces.

Recommended Cloudflare Pages settings:

- Build command: none
- Build output directory: `docs`
- Framework preset: none / static

## Content boundary

The site is for product discovery and adoption:

- advertise the product outcome before implementation detail;
- explain the use cases and trust boundary;
- show the product surfaces and deployment choices;
- route qualified readers to focused developer documentation.

The site must not expose a repository quickstart, package map, API reference, or
protocol manual as landing-page content. Keep those details in the root README,
package READMEs, package-local docs, examples, and JSDoc.

## Landing-page anchors

Keep these local anchors stable:

| Concept | Anchor |
| --- | --- |
| Why Interocitor | `#why` |
| Use cases | `#use-cases` |
| Rows and files | `#surfaces` |
| Data model | `#model` |
| Remote backends | `#remotes` |
| Security boundary | `#security` |
| Developer paths | `#docs` |

Do not publish a canonical URL, `og:url`, or public `@see` URL until the
production domain resolves, serves this page over valid TLS, and passes an
anonymous link crawl.

Short documentation routes such as `/web`, `/workers`, `/mesh-access`,
`/recovery`, and `/security` are defined in `_redirects` and lead to the
corresponding public repository documentation. Cloudflare Pages or Wrangler
interprets these redirects; a basic static file server does not.

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

## Launch gate

Before deploying the public site:

1. make the source and documentation targets anonymously reachable;
2. verify the repository examples from a clean clone against the homepage's
   capability claims;
3. deploy the site and verify every short route;
4. only then add the production canonical URL.
