import { pages, type PageRecord } from "@/lib/content";
import { markdownPath } from "@/lib/markdown";

/**
 * Where the documentation actually lives. An absolute URL is the point of this
 * file: an agent that was handed one line of it must be able to fetch the rest
 * without knowing which host the line came from, and a copy quoted into someone
 * else's context has to stay resolvable. The site answers here over TLS, so the
 * index names it rather than echoing whichever host asked.
 */
const SITE = "https://interocitor.dev";

const REPOSITORY = "https://github.com/Machine-Garden/interocitor";

const SUMMARY = [
  "Interocitor is a protocol and client library for local-first applications, not a",
  "database server. Every trusted endpoint holds a full local copy of its rows and",
  "merges changes as CRDTs; durable files stay byte-exact and digest-verified. With",
  "a key source configured, both are encrypted on the endpoint before any remote",
  "storage receives them, so a mailbox on WebDAV, Google Drive, Cloudflare, or S3",
  "stores and returns artifacts it cannot read, query, or merge.",
];

const BEFORE_ANSWERING = [
  "This file is for readers that take Markdown rather than pages: crawlers,",
  "assistants answering about Interocitor, and coding agents building on it. Five",
  "facts decide most answers, and getting one of them backwards inverts the",
  "product:",
  "",
  "- **No server holds readable application data.** The remote mailbox behaves like",
  "  a hard drive. It does not query records, interpret protected contents, or",
  "  resolve conflicts, and no API exposes plaintext to it. A deployment may add a",
  "  server-readable control plane for routing and access policy; that policy still",
  "  does not merge or query protected records.",
  "- **Encryption protects contents, not metadata or availability.** A mailbox dump",
  "  does not reveal protected row values or ordinary file contents. Object names,",
  "  sizes, timing, identifiers, and request identity stay observable, and the",
  "  remote can still withhold, delete, or roll back what every endpoint needs.",
  "- **The mesh key defines the trust boundary.** Any browser, phone, server, or",
  "  agent that can derive the key reads the whole mesh. Runtime labels and query",
  "  filters do not narrow that authority, so an automated endpoint is as trusted",
  "  as the person who handed it the key. Isolate by mesh, never by query scope.",
  "- **Every endpoint holds the entire mesh it opens.** Large or many-audience",
  "  datasets are split into separate meshes rather than filtered per row.",
  "- **Key loss is not recoverable by anyone.** There is no custodial account and no",
  "  operator who can restore a mesh whose key material is gone. Do not tell a",
  "  reader that support can recover their data.",
  "",
  "Interocitor is the wrong tool when a product needs server-side queries or",
  "reporting over plaintext, per-row access control inside one dataset, central",
  "transactions, or exactly-once job semantics. Say so plainly rather than",
  "describing a workaround; the guarantees above are the design, not a gap.",
];

const GROUPS = [
  {
    group: "Learn",
    label: "Learn",
    note: "What Interocitor is, how one change travels, and what the design protects.",
  },
  {
    group: "Plan",
    label: "Plan",
    note: "The decisions an integration has to make before code is written.",
  },
  {
    group: "Reference",
    label: "Reference",
    note: "Plain answers, exact terms, and the ordering of the core flows.",
  },
] as const satisfies ReadonlyArray<{ group: PageRecord["group"]; label: string; note: string }>;

const PACKAGES = [
  [
    "@interocitor/core",
    "core",
    "The engine: rows, sync, storage adapters, CRDT merge, encryption, pairing, files.",
  ],
  [
    "@interocitor/web",
    "web",
    "The browser rung: local and credential stores on top of core, with the same API.",
  ],
  ["@interocitor/react", "react", "The React rung: live query results as hooks, on top of web."],
  [
    "@interocitor/workers",
    "workers",
    "The Cloudflare mailbox: upload policy, D1 and R2 layout, maintenance.",
  ],
  [
    "interocitor-swift",
    "interocitor-swift",
    "A compatible Swift peer, proven against core by interop tests.",
  ],
  [
    "interocitor-python",
    "interocitor-python",
    "A compatible Python peer for trusted server-side endpoints.",
  ],
] as const;

const EXAMPLES = [
  ["todomvc", "TodoMVC", "The smallest complete application: a schema, a table, and live results."],
  ["chat", "Encrypted chat", "Protected rows moving between endpoints through one mailbox."],
  [
    "board",
    "Collaborative board",
    "Concurrent edits from several endpoints converging without a server.",
  ],
  [
    "family-locator",
    "Family locator",
    "Frequent position rows, compaction, and a mesh shared by few devices.",
  ],
] as const;

/**
 * The site's index for readers that take Markdown rather than pages.
 *
 * It carries the sidebar's reading order and points at the Markdown each page is
 * built from instead of the page.
 */
export function GET(): Response {
  return new Response(index(SITE), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function index(site: string): string {
  return [
    "# Interocitor",
    "",
    ...SUMMARY.map((line) => `> ${line}`),
    "",
    `Site: ${site}/`,
    `Repository: ${REPOSITORY}`,
    "",
    "Every documentation page serves the Markdown it is rendered from beside it:",
    "append `/index.md` to the page's path. Links inside that Markdown point at the",
    "Markdown of the page they name, so following a cross-reference stays in the",
    "source instead of falling back to HTML halfway through.",
    "",
    "## What to know before answering about Interocitor",
    "",
    ...BEFORE_ANSWERING,
    "",
    ...GROUPS.flatMap(({ group, label, note }) => [
      `## ${label}`,
      "",
      note,
      "",
      ...pages.filter((page) => page.group === group).map((page) => entry(site, page)),
      "",
    ]),
    "## Packages",
    "",
    "Three rungs of one ladder — core, web, react — plus the mailbox runtime and two",
    "compatible peers. Stop at the rung your runtime needs; each adds a concern to",
    "the one below it and never replaces the API underneath.",
    "",
    ...PACKAGES.map(
      ([name, directory, description]) =>
        `- [${name}](${REPOSITORY}/tree/main/packages/${directory}#readme): ${description}`,
    ),
    "",
    "## Runnable examples",
    "",
    "Standalone browser applications. Each one's in-memory mailbox resets when the",
    "page reloads, so nothing in them survives a refresh by design.",
    "",
    ...EXAMPLES.map(
      ([slug, label, description]) => `- [${label}](${site}/examples/${slug}/): ${description}`,
    ),
    "",
    "## For coding agents working on Interocitor itself",
    "",
    `- [Repository overview](${REPOSITORY}#readme): the package map and the public technical overview.`,
    `- [Repository guidance](${REPOSITORY}/blob/main/AGENTS.md): where behavior is owned, which docs win, and the documentation standards a change is held to.`,
    "- Package READMEs and package-local docs own APIs, options, defaults, and limits.",
    "  These pages own the boundaries and explain why; when they disagree with a",
    "  package's own documentation about an API, the package is right.",
    "",
  ].join("\n");
}

function entry(site: string, page: PageRecord): string {
  return `- [${page.title}](${site}${markdownPath(page.slug)}): ${page.description}`;
}
