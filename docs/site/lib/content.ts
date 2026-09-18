import applicationsSource from "../content/applications.md";
import automationSource from "../content/automation.md";
import authSource from "../content/auth.md";
import compactionSource from "../content/compaction.md";
import dataBoundariesSource from "../content/data-boundaries.md";
import dictionarySource from "../content/dictionary.md";
import flowsSource from "../content/flows.md";
import howItWorksSource from "../content/how-it-works.md";
import integrationsSource from "../content/integrations.md";
import limitsSource from "../content/limits.md";
import mailboxSource from "../content/mailbox.md";
import qaSource from "../content/qa.md";
import retentionSource from "../content/retention.md";
import securitySource from "../content/security.md";
import storageSource from "../content/storage.md";
import taintedFilesSource from "../content/tainted-files.md";
import trustSource from "../content/trust.md";
import whySource from "../content/why.md";

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
  group: "Learn" | "Plan" | "Reference";
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
    slug: "why",
    navLabel: "Start with why",
    source: whySource,
    group: "Learn",
  },
  {
    slug: "how-it-works",
    navLabel: "How it works",
    source: howItWorksSource,
    group: "Learn",
  },
  {
    slug: "storage",
    navLabel: "Storage model",
    source: storageSource,
    group: "Learn",
  },
  {
    slug: "security",
    navLabel: "Security model",
    source: securitySource,
    group: "Learn",
  },
  {
    slug: "compaction",
    navLabel: "Compaction",
    source: compactionSource,
    group: "Learn",
  },
  {
    slug: "tainted-files",
    navLabel: "Tainted files",
    source: taintedFilesSource,
    group: "Learn",
  },
  {
    slug: "applications",
    navLabel: "Applications",
    source: applicationsSource,
    group: "Plan",
  },
  {
    slug: "integrations",
    navLabel: "Integrations",
    source: integrationsSource,
    group: "Plan",
  },
  {
    slug: "trust",
    navLabel: "Trust & key custody",
    source: trustSource,
    group: "Plan",
  },
  {
    slug: "limits",
    navLabel: "Limits of security",
    source: limitsSource,
    group: "Plan",
  },
  {
    slug: "data-boundaries",
    navLabel: "Data boundaries",
    source: dataBoundariesSource,
    group: "Plan",
  },
  {
    slug: "mailbox",
    navLabel: "Mailbox operations",
    source: mailboxSource,
    group: "Plan",
  },
  {
    slug: "retention",
    navLabel: "Data retention",
    source: retentionSource,
    group: "Plan",
  },
  {
    slug: "auth",
    navLabel: "Authentication",
    source: authSource,
    group: "Plan",
  },
  {
    slug: "automation",
    navLabel: "Automation",
    source: automationSource,
    group: "Plan",
  },
  {
    slug: "qa",
    navLabel: "Q&A",
    source: qaSource,
    group: "Reference",
  },
  {
    slug: "dictionary",
    navLabel: "Glossary",
    source: dictionarySource,
    group: "Reference",
  },
  {
    slug: "flows",
    navLabel: "Core flows",
    source: flowsSource,
    group: "Reference",
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
  recovery: "/qa#lost-key",
  "mesh-access": "/auth",
  "worker-runtime": "/mailbox",
  "worker-maintenance": "/mailbox#operations",
  "worker-relay": "/flows#access",
  "shared-keys": "/trust",
  roles: "/applications",
  packages: "/integrations",
  ladder: "/integrations",
  "web-credentials": "/trust#custody",
  "data-surfaces": "/data-boundaries",
  "adapter-contract": "/mailbox",
  python: "/automation",
  "data-migrations": "/automation#duplicate",
};
