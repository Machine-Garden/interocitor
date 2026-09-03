import automationSource from "../content/automation.md";
import authSource from "../content/auth.md";
import dataBoundariesSource from "../content/data-boundaries.md";
import howItWorksSource from "../content/how-it-works.md";
import mailboxSource from "../content/mailbox.md";
import trustSource from "../content/trust.md";
import dictionarySource from "../../dictionary.md";
import flowsSource from "../../flows.md";
import qaSource from "../../QA.md";

export type PageRecord = {
  slug: string;
  navLabel: string;
  title: string;
  description: string;
  kicker: string;
  heading: string;
  lede: string;
  body: string;
  outline: Array<{ id: string; label: string }>;
  group: "Architecture" | "Reference";
};

type Metadata = Pick<PageRecord, "title" | "description" | "kicker" | "heading" | "lede">;

type SourceRecord = {
  slug: string;
  navLabel: string;
  source: string;
  group: PageRecord["group"];
  metadata?: Metadata;
};

const sources: SourceRecord[] = [
  {
    slug: "how-it-works",
    navLabel: "How it works",
    source: howItWorksSource,
    group: "Architecture",
  },
  { slug: "trust", navLabel: "Trust & keys", source: trustSource, group: "Architecture" },
  {
    slug: "data-boundaries",
    navLabel: "Data scope",
    source: dataBoundariesSource,
    group: "Architecture",
  },
  { slug: "mailbox", navLabel: "Mailbox", source: mailboxSource, group: "Architecture" },
  {
    slug: "auth",
    navLabel: "Access & identity",
    source: authSource,
    group: "Architecture",
  },
  {
    slug: "automation",
    navLabel: "Automation",
    source: automationSource,
    group: "Architecture",
  },
  {
    slug: "qa",
    navLabel: "Questions & answers",
    source: qaSource,
    group: "Reference",
    metadata: {
      title: "Interocitor questions and answers",
      description:
        "Plain-language answers about Interocitor's fit, trust, availability, keys, workers, and scale.",
      kicker: "Plain-language reference",
      heading: "Honest answers before architecture.",
      lede: "Use these questions to test Interocitor against a real product, threat model, or operational requirement before choosing packages and adapters.",
    },
  },
  {
    slug: "dictionary",
    navLabel: "Dictionary",
    source: dictionarySource,
    group: "Reference",
    metadata: {
      title: "Interocitor dictionary",
      description:
        "The precise meaning of Interocitor's keys, meshes, stores, artifacts, and trust boundaries.",
      kicker: "Terminology reference",
      heading: "Use the protocol’s terms precisely.",
      lede: "These definitions distinguish encryption capabilities, mesh identity, local persistence, remote storage, and recovery roles across every runtime.",
    },
  },
  {
    slug: "flows",
    navLabel: "Protocol flows",
    source: flowsSource,
    group: "Reference",
    metadata: {
      title: "Interocitor protocol flows",
      description:
        "Sequence and flow references for connect, flush, pull, compaction, bootstrap, and rehydration.",
      kicker: "Protocol reference",
      heading: "Follow each artifact through the mesh.",
      lede: "These flows expose request ordering, encryption boundaries, observation state, and compaction behavior for compatible implementations.",
    },
  },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[`*_]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function parse({ source, slug, navLabel, group, metadata }: SourceRecord): PageRecord {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const values: Record<string, string> = {};
  if (match) {
    for (const line of match[1].split("\n")) {
      const index = line.indexOf(":");
      if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
    }
  }

  const body = (match ? match[2] : source.replace(/^# .+\n+/, "")).trim();
  const outline = Array.from(body.matchAll(/^## (.+)$/gm), ([, rawLabel]) => {
    const explicit = rawLabel.match(/^(.*?) \{#([a-z0-9-]+)\}$/);
    const label = explicit ? explicit[1] : rawLabel;
    return { id: explicit ? explicit[2] : slugify(label), label };
  });
  const resolved = metadata ?? {
    title: values.title,
    description: values.description,
    kicker: values.kicker,
    heading: values.heading,
    lede: values.lede,
  };

  return { slug, navLabel, ...resolved, body, outline, group };
}

export const pages = sources.map((source) => parse(source));

export function getPage(slug: string): PageRecord | undefined {
  return pages.find((page) => page.slug === slug);
}

export const shortRoutes: Record<string, string> = {
  github: "https://github.com/Machine-Garden/interocitor",
  core: "https://github.com/Machine-Garden/interocitor/tree/main/packages/core#readme",
  web: "https://github.com/Machine-Garden/interocitor/tree/main/packages/web#readme",
  react: "https://github.com/Machine-Garden/interocitor/tree/main/packages/react#readme",
  workers: "https://github.com/Machine-Garden/interocitor/tree/main/packages/workers#readme",
  examples: "https://github.com/Machine-Garden/interocitor/tree/main/examples",
  security:
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/security-model.md",
  recovery:
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/recovery.md",
  "mesh-access":
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/mesh-access.md",
  "worker-runtime":
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/runtime-options.md",
  "worker-maintenance":
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/maintenance.md",
  "worker-relay":
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/relay.md",
  "shared-keys":
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/shared-key-scenarios.md",
  "web-credentials":
    "https://github.com/Machine-Garden/interocitor/tree/main/packages/web#credential-storage-choices",
  "data-surfaces":
    "https://github.com/Machine-Garden/interocitor/tree/main/packages/core#keep-rows-and-files-distinct",
  compaction:
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/compaction.md",
  "adapter-contract":
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/adapter-contract.md",
  python:
    "https://github.com/Machine-Garden/interocitor/tree/main/packages/interocitor-python#readme",
  "data-migrations":
    "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/data-migrations.md",
};
