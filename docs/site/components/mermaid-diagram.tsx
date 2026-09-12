"use client";

import { useEffect, useId, useState } from "react";

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
  const reactId = useId();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const id = `interocitor-diagram-${reactId.replaceAll(":", "")}`;

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            background: "#f8f7f0",
            primaryColor: "#e3e6d8",
            primaryTextColor: "#17201c",
            primaryBorderColor: "#0a6948",
            lineColor: "#58645e",
            secondaryColor: "#dce6d9",
            tertiaryColor: "#fff8ed",
            fontFamily: "var(--sans)",
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
  }, [chart, reactId]);

  if (error) {
    return (
      <p className="mermaid-error" role="alert">
        This diagram could not be rendered: {error}
      </p>
    );
  }

  return (
    <figure className="mermaid-diagram" aria-busy={!svg}>
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="mermaid-loading">Rendering diagram…</p>
      )}
    </figure>
  );
}
