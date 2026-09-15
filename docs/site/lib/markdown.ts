import { getPage, type PageRecord } from "./content";

/**
 * A documentation page as the Markdown it is rendered from.
 *
 * The site paints these documents into pages; a reader that would rather take
 * the source reads it here, beside the page, so it arrives at the material this
 * site renders rather than at a rendering of it. Front matter becomes the
 * document's own title and summary, and the kicker, outline, and boundary strip
 * are left behind as page chrome.
 */
export function publishedMarkdown(page: PageRecord): string {
  return `${[`# ${page.title}`, `> ${page.description}`, page.lede, withPublishedLinks(page.body)].join("\n\n")}\n`;
}

/** Where the Markdown behind a documentation page is served, beside the page. */
export function markdownPath(slug: string): string {
  return `/${slug}/index.md`;
}

const FENCE = /^```.*$/gm;
const LINK = /(!?)\[([^\]]*)\]\((\/[^)\s]*)\)/g;

/**
 * Cross-references repointed at the Markdown of the page they name, so a reader
 * following the text stays in the source instead of falling back to HTML
 * halfway through. Targets the site does not document are left as they are.
 */
function withPublishedLinks(body: string): string {
  return outsideCode(body)
    .map((part, index) => (index % 2 === 0 ? repointed(part) : part))
    .join("");
}

function repointed(part: string): string {
  return part.replaceAll(LINK, (match, image: string, text: string, target: string) => {
    if (image) return match;
    const [path, ...fragment] = target.split("#");
    const page = getPage(path.replace(/^\//, ""));
    if (!page) return match;
    const suffix = fragment.length > 0 ? `#${fragment.join("#")}` : "";
    return `[${text}](${markdownPath(page.slug)}${suffix})`;
  });
}

/** Prose and fenced code, alternating, prose first. */
function outsideCode(body: string): string[] {
  const fences = [...body.matchAll(FENCE)];
  const parts: string[] = [];
  let read = 0;

  for (let index = 0; index + 1 < fences.length; index += 2) {
    const opening = fences[index];
    const closing = fences[index + 1];
    const end = closing.index + closing[0].length;
    parts.push(body.slice(read, opening.index), body.slice(opening.index, end));
    read = end;
  }

  parts.push(body.slice(read));
  return parts;
}
