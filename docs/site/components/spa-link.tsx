"use client";

import Link from "next/link";
import type { ComponentPropsWithoutRef } from "react";

type Props = ComponentPropsWithoutRef<"a">;

function cleanPath(href: string): string {
  if (href.startsWith("#") || /^[a-z][a-z+.-]*:/i.test(href)) return href;
  if (href.startsWith("QA.md")) return href.replace("QA.md", "/qa");

  const cleaned = href
    .replace(/^index\.html(?=#|$)/, "/")
    .replace(/^(how-it-works|trust|data-boundaries|mailbox|auth|automation)\.html/, "/$1");
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

export function SpaLink({ href = "", onClick, children, ...props }: Props) {
  const target = cleanPath(href);

  if (target.startsWith("/") && !target.startsWith("/examples/")) {
    return (
      <Link href={target} onClick={onClick} {...props}>
        {children}
      </Link>
    );
  }

  return (
    <a href={target} onClick={onClick} {...props}>
      {children}
    </a>
  );
}
