# Interocitor public site

The public site helps an application-fit evaluator decide whether Interocitor’s
local full-copy rows, directly remote files, trusted endpoints, and mailbox
boundary fit a product. It then routes builders and deployment owners to the
technical contract they control.

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

- `site/content/how-it-works.md` owns the visual and conceptual sync story;
- `site/content/trust.md` owns endpoint authority, key custody, recovery, and
  rotation;
- `site/content/data-boundaries.md` owns rows, files, meshes, availability, and
  sizing;
- `site/content/mailbox.md` owns mailbox placement and operational
  responsibility;
- `site/content/auth.md` owns the choice between host-owned authorization and
  specialized application-managed grants;
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
security headers, redirects, metadata, and live-demo reachability.

## Stable public routes

| Route              | Reader question                                                               |
| ------------------ | ----------------------------------------------------------------------------- |
| `/`                | Is Interocitor a fit for my application and threat model?                     |
| `/how-it-works`    | How do independent changes converge, and how is catch-up bounded?             |
| `/trust`           | Which endpoints may read the mesh, and how will its key lifecycle be handled? |
| `/data-boundaries` | What belongs in rows, files, and separate meshes?                             |
| `/mailbox`         | Where should the mailbox run, and who owns its operational risks?             |
| `/auth`            | Should mesh access follow host policy or application-managed grants?          |
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
and passes an anonymous link crawl. Keep canonical URL metadata absent until
those conditions hold.
