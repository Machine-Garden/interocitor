"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PageRecord } from "@/lib/content";

const groups = ["Learn", "Plan", "Reference"] as const;

export function DocsSidebar({ pages }: { pages: PageRecord[] }) {
  const pathname = usePathname();
  const current = pathname.replace(/^\//, "").replace(/\.html$/, "");

  return (
    <aside className="docs-sidebar">
      {groups.map((group) => (
        <section key={group}>
          <p>{group}</p>
          <nav aria-label={`${group} documentation`}>
            {pages
              .filter((item) => item.group === group)
              .map((item) => (
                <Link
                  href={`/${item.slug}`}
                  aria-current={item.slug === current ? "page" : undefined}
                  key={item.slug}
                >
                  {item.navLabel}
                </Link>
              ))}
          </nav>
        </section>
      ))}
      <div>
        <p>Live examples</p>
        <a href="/examples/todomvc/">TodoMVC ↗</a>
        <a href="/examples/chat/">Encrypted chat ↗</a>
        <a href="/examples/board/">Collaborative board ↗</a>
        <a href="/examples/family-locator/">Family locator ↗</a>
      </div>
    </aside>
  );
}
