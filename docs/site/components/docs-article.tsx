import Link from "next/link";
import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PageRecord } from "@/lib/content";
import { MermaidDiagram } from "@/components/mermaid-diagram";

function heading(children: ReactNode): { id: string | undefined; children: ReactNode } {
  const text = Children.toArray(children)
    .filter((child): child is string => typeof child === "string")
    .join("");
  const match = text.match(/^(.*?) \{#([a-z0-9-]+)\}$/);
  if (match) return { id: match[2], children: match[1] };
  const id = text
    .toLowerCase()
    .replaceAll(/[`*_]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return { id: id || undefined, children };
}

function markdownHref(href: string): string {
  const localDocs: Record<string, string> = {
    "QA.md": "/qa",
    "dictionary.md": "/dictionary",
    "flows.md": "/flows",
  };
  const local = Object.entries(localDocs).find(([name]) => href.startsWith(name));
  if (local) return href.replace(local[0], local[1]);
  return href;
}

function Markdown({ page }: { page: PageRecord }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href = "", children }) => {
          const target = markdownHref(href);
          return target.startsWith("/") ? (
            <Link href={target}>{children}</Link>
          ) : (
            <a href={target}>{children}</a>
          );
        },
        h2: ({ children }) => {
          const value = heading(children);
          return <h2 id={value.id}>{value.children}</h2>;
        },
        h3: ({ children }) => {
          const value = heading(children);
          return <h3 id={value.id}>{value.children}</h3>;
        },
        code: ({ className, children }) => {
          const chart = String(children).replace(/\n$/, "");
          return className === "language-mermaid" ? (
            <MermaidDiagram chart={chart} />
          ) : (
            <code className={className}>{children}</code>
          );
        },
        pre: ({ children }) => {
          // The single child is still the unrendered `code` element, so match on its language
          // rather than on MermaidDiagram: a diagram must not inherit the code-block chrome.
          const nodes = Children.toArray(children);
          const only = nodes.length === 1 && isValidElement(nodes[0]) ? nodes[0] : undefined;
          const language = (only?.props as { className?: string } | undefined)?.className;
          if (language === "language-mermaid") return only;
          return <pre>{children}</pre>;
        },
      }}
    >
      {page.body}
    </ReactMarkdown>
  );
}

export function DocsArticle({ page }: { page: PageRecord }) {
  return (
    <>
      <section className="docs-hero-band">
        <div className="docs-hero">
          <div>
            <p>{page.kicker}</p>
            <h1>{page.heading}</h1>
            <p className="docs-lede">{page.lede}</p>
          </div>
          <aside aria-label="Interocitor boundary">
            <span>trusted endpoint</span>
            <b aria-hidden="true">→</b>
            <span>protected mailbox</span>
            <b aria-hidden="true">→</b>
            <span>trusted endpoint</span>
          </aside>
        </div>
      </section>

      <div className="docs-reading-grid">
        <main id="main" className="docs-content">
          <Markdown page={page} />
        </main>

        <aside className="docs-outline">
          <p>On this page</p>
          <nav aria-label="On this page">
            {page.outline.map((item) => (
              <a key={item.id} href={`#${item.id}`}>
                {item.label}
              </a>
            ))}
          </nav>
        </aside>
      </div>
    </>
  );
}
