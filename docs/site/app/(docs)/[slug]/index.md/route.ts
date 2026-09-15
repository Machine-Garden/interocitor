import { getPage } from "@/lib/content";
import { publishedMarkdown } from "@/lib/markdown";

type Props = { params: Promise<{ slug: string }> };

/**
 * The Markdown a documentation page is built from, served beside the page.
 *
 * `/storage` renders it; `/storage/index.md` hands it over. A reader that takes
 * Markdown — an assistant, a crawler, a coding agent — gets the document rather
 * than a rendering of it, and `llms.txt` points at these paths.
 */
export async function GET(_request: Request, { params }: Props): Promise<Response> {
  const { slug } = await params;
  const page = getPage(slug);
  if (!page) return new Response("Not found\n", { status: 404 });

  return new Response(publishedMarkdown(page), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
