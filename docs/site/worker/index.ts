import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  );
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The same `describedby` and `alternate` links the documents carry in their
 * heads, said at the HTTP level as well.
 *
 * A reader that only issues `HEAD`, or that takes the response without parsing
 * the body, still learns where the machine-readable index is and that this page
 * has a Markdown twin — without spending a request to find out.
 *
 * The twin's path needs no table of slugs: `/:slug` and `/:slug/index.md` are
 * the same route space, so a one-segment path that rendered a page has its
 * Markdown at that path plus `/index.md`, and the two cannot drift apart.
 */
function withDescriptionLinks(response: Response, pathname: string): Response {
  const type = response.headers.get("content-type") ?? "";
  const html = type.startsWith("text/html");
  if (!html && !type.startsWith("text/markdown")) return response;
  if (response.status !== 200) return response;

  const links = ['</llms.txt>; rel="describedby"; type="text/markdown"'];
  if (html && /^\/[a-z0-9-]+$/.test(pathname)) {
    links.push(`<${pathname}/index.md>; rel="alternate"; type="text/markdown"`);
  }

  const headers = new Headers(response.headers);
  headers.set("link", links.join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker = {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const demo = url.pathname.match(/^\/examples\/(todomvc|chat|board|family-locator)$/);
    if (demo) {
      return Response.redirect(new URL(`/examples/${demo[1]}/`, url), 308);
    }

    if (/^\/examples\/(todomvc|chat|board|family-locator)\//.test(url.pathname)) {
      return withSecurityHeaders(
        withDescriptionLinks(await env.ASSETS.fetch(request), url.pathname),
      );
    }

    if (url.pathname === "/_vinext/image") {
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
      );
    }

    return withSecurityHeaders(
      withDescriptionLinks(await handler.fetch(request, env, context), url.pathname),
    );
  },
};

export default worker;
