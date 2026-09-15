# Interocitor public site

The public site helps an application-fit evaluator decide whether Interocitor’s
local full-copy rows, directly remote files, trusted endpoints, and mailbox
boundary fit a product. It reads like a good high-school textbook:
self-contained, compact, plain, lively, and intellectually respectful. It
assumes no supplied context and little spare attention, never low intelligence.
Deeper package documentation owns university-level explanation and reference;
internal material stays out of the ordinary visitor path.

The site is a Vinext/React application under `site/`. Navigation between the
landing page and documentation uses client-side transitions, while direct URLs
remain independently renderable.

## Content owners

The existing landing page is a deliberately designed product surface. Its
React source is `site/components/home-landing.tsx`; `index.css` and
`chooser.css` own its established visual treatment. Preserve its content,
section anchors, diagrams, and examples unless the requested work explicitly
changes the landing page.

Reader-facing documentation is Markdown:

- `site/content/why.md` owns the project's origin: the name's source, the
  motive for building it, and the independent-convergence note;
- `site/content/how-it-works.md` owns the visual and conceptual sync story;
- `site/content/storage.md` owns the local and remote storage model, the
  application-layer protection point, and physical backend placement;
- `site/content/trust.md` owns endpoint authority, key custody, recovery, and
  rotation;
- `site/content/data-boundaries.md` owns rows, files, meshes, availability, and
  sizing;
- `site/content/mailbox.md` owns mailbox placement and operational
  responsibility;
- `site/content/auth.md` owns the relationship among host authentication, mesh
  middleware, recovery phrases, mesh keys, tainted-file keys, and specialized
  application-managed grants;
- `site/content/automation.md` owns trusted processors, isolation, and delivery
  semantics;
- `QA.md`, `dictionary.md`, and `flows.md` are rendered directly as reference
  pages rather than copied into another source format.

Front matter supplies each focused page’s browser title, description, kicker,
heading, and lede. Second-level Markdown headings form the page outline. An
explicit heading anchor uses this form:

```markdown
## Keys and plaintext stay at the ends {#boundary}
```

Keep detailed claims at one canonical owner and link from other pages instead
of duplicating them. Package READMEs and package-local documentation remain the
owners of APIs, options, defaults, limits, and procedures.

## Work on the site

Install from the repository root, then run the site workspace:

```bash
yarn install --immutable
yarn workspace @interocitor/site dev
```

The site prepares its public assets before development and builds. This copies
the committed live-demo artifacts and shared logo assets into the framework’s
generated `public/` directory; do not edit that directory.

Validate a site change with:

```bash
yarn check:docs:site
yarn build:docs:site
yarn test:e2e:docs:site
```

`yarn check:docs:site` type-checks the application. The build emits the
Cloudflare Worker-compatible Sites artifact. The browser suite checks the
landing-page contract, Markdown routes, client-side navigation, narrow layouts,
security headers, redirects, metadata, the agent index and Markdown sources, and
live-demo reachability.

## Stable public routes

| Route              | Reader question                                                               |
| ------------------ | ----------------------------------------------------------------------------- |
| `/`                | Is Interocitor a fit for my application and threat model?                     |
| `/why`             | Why is it called that, and what was it built to avoid holding?                |
| `/how-it-works`    | What is Interocitor, why use it, and how does one change travel?              |
| `/storage`         | What rests locally and remotely, and where does each backend put it?          |
| `/trust`           | Which endpoints may read the mesh, and how will its key lifecycle be handled? |
| `/data-boundaries` | What belongs in rows, files, and separate meshes?                             |
| `/mailbox`         | Where should the mailbox run, and who owns its operational risks?             |
| `/auth`            | How do host auth, middleware, recovery, taints, and grants compose?           |
| `/automation`      | How should a trusted worker or agent coordinate and isolate its work?         |
| `/qa`              | What are the plain-language product and threat-boundary answers?              |
| `/dictionary`      | What does each protocol and security term mean?                               |
| `/flows`           | What is the exact ordering for core sync flows?                               |

The landing-page anchors `#why`, `#use-cases`, `#plain-language`, `#model`,
`#surfaces`, `#remotes`, `#security`, `#decisions`, and `#docs` are also part of
the public route contract.

Legacy `.html` URLs redirect to their clean route. Short routes such as `/web`,
`/workers`, `/mesh-access`, `/recovery`, and `/security` redirect to the
corresponding canonical repository documentation.

## Readers that take Markdown

Every route in the table above also serves the Markdown it is rendered from, at
the same path plus `/index.md`. The document carries its front-matter title and
description, then its lede and body; the kicker, outline, and boundary strip
stay behind as page chrome. Cross-references are repointed at the Markdown of
the page they name, so a reader following the text stays in the source.

`/llms.txt` is the index for those readers. It states the boundaries an answer
about Interocitor has to get right — no server holds readable data, metadata and
availability are outside the encryption boundary, the mesh key is the whole
trust boundary, every endpoint holds the entire mesh, and lost key material is
lost data — and then lists the documentation in the sidebar's reading order,
pointing at each page's Markdown. Its page entries, groups, and descriptions are
generated from `site/lib/content.ts`; only the prose is written by hand, so a
new page joins the index by being added there. Its URLs are absolute against
`https://interocitor.dev`, because a single line of this file may be quoted into
a context that has no idea which host served it and must still resolve.

Neither file is worth much if it has to be guessed at, so every response says
where it is. Each page carries `<link rel="describedby" href="/llms.txt">` in
its head and a documentation page adds `<link rel="alternate"
type="text/markdown">` pointing at its own twin; the Worker repeats both as an
HTTP `Link:` header, so a reader that only issues `HEAD`, or that never parses
the body, learns the same thing without a second request. A short row at the
foot of each article says it in words as well. The links declare
`type="text/markdown"` because that is the format; `/llms.txt` is nonetheless
served as `text/plain`, so opening it in a browser tab reads it instead of
downloading it.

## Runnable examples

The live examples under `examples/` remain standalone browser applications:

- `/examples/todomvc/`
- `/examples/chat/`
- `/examples/board/`
- `/examples/family-locator/`

Their HTML is application scaffolding for a runnable example, not a duplicate
documentation source. Keep each example aligned with the public API and retain
the statement that its in-memory mailbox resets when the page reloads.

## Security and publication

The application Worker applies the public security-header policy to rendered
pages. Protected payload claims must continue to state both halves of the
boundary: a mailbox dump does not reveal protected row values or ordinary file
contents, while object names, sizes, timing, identifiers, request identity,
withholding, deletion, and rollback remain observable or possible.

Sites configuration lives in `site/.openai/hosting.json`. A publication may
advertise a canonical production URL only after it resolves, serves valid TLS,
and passes an anonymous link crawl. `https://interocitor.dev` now meets those
conditions and is the canonical origin `/llms.txt` names.

`robots.txt` is served by Cloudflare rather than from this repository, and its
managed block currently disallows ClaudeBot, GPTBot, CCBot, Google-Extended and
their peers. The agent index describes the site for readers that are allowed to
take it; changing who is allowed is a Cloudflare setting, not a code change.
