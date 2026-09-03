import Link from "next/link";
import { Children, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PageRecord } from "@/lib/content";

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
  if (href.startsWith("../")) {
    return `https://github.com/Machine-Garden/interocitor/blob/main/${href.slice(3)}`;
  }
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
      }}
    >
      {page.body}
    </ReactMarkdown>
  );
}

export function SiteShell({ page, pages }: { page: PageRecord; pages: PageRecord[] }) {
  return (
    <div className="docs-page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="docs-header">
        <div className="docs-header-inner">
          <Link className="brand" href="/" aria-label="Interocitor home">
            <img className="brand-logo" src="/assets/hero-dark.svg" alt="Interocitor" />
          </Link>
          <nav aria-label="Documentation navigation">
            <Link href="/">Overview</Link>
            <Link href="/how-it-works">How it works</Link>
            <Link href="/qa">Q&amp;A</Link>
            <a href="/examples/todomvc/">Live TodoMVC</a>
          </nav>
          <a className="docs-github" href="https://github.com/Machine-Garden/interocitor">
            GitHub ↗
          </a>
        </div>
      </header>

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

      <div className="docs-layout">
        <aside className="docs-sidebar">
          {(["Architecture", "Reference"] as const).map((group) => (
            <section key={group}>
              <p>{group}</p>
              <nav aria-label={`${group} documentation`}>
                {pages
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <Link
                      href={`/${item.slug}`}
                      aria-current={item.slug === page.slug ? "page" : undefined}
                      key={item.slug}
                    >
                      {item.navLabel}
                    </Link>
                  ))}
              </nav>
            </section>
          ))}
          <div>
            <p>Run the model</p>
            <a href="/examples/todomvc/">Live TodoMVC ↗</a>
            <a href="/examples/chat/">Encrypted chat ↗</a>
          </div>
        </aside>

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

      <footer className="docs-footer">
        <div>
          <img src="/assets/hero-dark.svg" alt="Interocitor" />
          <p>Trusted endpoints · protected mailbox.</p>
        </div>
        <nav aria-label="Site links">
          <Link href="/">Overview</Link>
          <Link href="/how-it-works">How it works</Link>
          <a href="https://github.com/Machine-Garden/interocitor">Source on GitHub</a>
        </nav>
      </footer>
    </div>
  );
}
