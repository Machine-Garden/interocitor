"use client";

import { useEffect, useState } from "react";

/**
 * Mermaid keys its work by this id and clears any element already carrying it, so two renders
 * must never share one. Count invocations instead of deriving the id from the component, which
 * hands the same id to both halves of a double-invoked effect.
 */
let diagramSequence = 0;

/**
 * Mermaid emits `width="100%"` and leaves the height to the viewBox. A browser then has to
 * derive the height from the aspect ratio, which Safari declines to do: the diagram collapses
 * to nothing. Pin the size the viewBox already describes so every browser lays it out the same.
 */
function withIntrinsicSize(svg: string): string {
  return svg.replace(/<svg([^>]*)>/, (tag, attributes: string) => {
    const box = /viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/.exec(attributes);
    if (!box) return tag;
    const sized = attributes.replaceAll(/\s(?:width|height)="[^"]*"/g, "");
    return `<svg${sized} width="${box[1]}" height="${box[2]}">`;
  });
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const id = `interocitor-diagram-${++diagramSequence}`;

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          // Mermaid measures label text in an element of its own, where a page-level custom
          // property does not resolve. Name the same stack --sans holds.
          fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          flowchart: { useMaxWidth: false },
          themeVariables: {
            background: "#f8f7f0",
            primaryColor: "#e3e6d8",
            primaryTextColor: "#17201c",
            primaryBorderColor: "#0a6948",
            lineColor: "#58645e",
            secondaryColor: "#dce6d9",
            tertiaryColor: "#fff8ed",
          },
        });
        const result = await mermaid.render(id, chart);
        if (active) setSvg(withIntrinsicSize(result.svg));
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Unknown diagram error");
        }
      });

    return () => {
      active = false;
    };
  }, [chart]);

  return (
    <figure className="mermaid-diagram" aria-busy={!svg && !error}>
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      ) : error ? (
        <p className="mermaid-error" role="alert">
          This diagram could not be rendered: {error}
        </p>
      ) : (
        <p className="mermaid-loading">Rendering diagram…</p>
      )}
      {/* Drawing the diagram needs a browser that runs our JavaScript and finishes mermaid's
          work. The source always reads, so a diagram that never arrives still leaves the
          reader the same relationships in text. */}
      <details className="mermaid-source">
        <summary>View diagram source</summary>
        <pre tabIndex={0}>
          <code>{chart}</code>
        </pre>
      </details>
    </figure>
  );
}
