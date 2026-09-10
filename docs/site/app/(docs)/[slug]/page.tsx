import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DocsArticle } from "@/components/docs-article";
import { getPage, pages, shortRoutes } from "@/lib/content";

type Props = { params: Promise<{ slug: string }> };

function resolveSlug(slug: string): string {
  return slug.endsWith(".html") ? slug.slice(0, -5) : slug;
}

export function generateStaticParams() {
  return pages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = getPage(resolveSlug(slug));
  if (!page) return {};

  return {
    title: page.title,
    description: page.description,
    openGraph: { title: page.title, description: page.description, images: [] },
    twitter: { title: page.title, description: page.description, images: [] },
  };
}

export default async function DocumentationPage({ params }: Props) {
  const { slug } = await params;
  const cleanSlug = resolveSlug(slug);
  if (slug.endsWith(".html") && getPage(cleanSlug)) redirect(`/${cleanSlug}`);
  if (shortRoutes[slug]) redirect(shortRoutes[slug]);

  const page = getPage(cleanSlug);
  if (!page) notFound();
  return <DocsArticle page={page} />;
}
