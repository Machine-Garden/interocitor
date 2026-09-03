import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";

const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const markdownContent = {
  name: "interocitor-markdown-content",
  enforce: "pre",
  transform(source, id) {
    if (!id.split("?", 1)[0].endsWith(".md")) return;
    return { code: `export default ${JSON.stringify(source)};`, map: null };
  },
} satisfies Plugin;

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      markdownContent,
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          main: "./worker/index.ts",
          compatibility_flags: ["nodejs_compat"],
          assets: {
            binding: "ASSETS",
            run_worker_first: ["/examples/*"],
          },
        },
      }),
    ],
  };
});
