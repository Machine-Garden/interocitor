import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Execution shim only: build.ts owns page registration, chrome, and validation.
globalThis.__INTEROCITOR_DOCS_ROOT__ = fileURLToPath(new URL("..", import.meta.url));

const result = await build({
  entryPoints: [new URL("./build.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  write: false,
});

const source = result.outputFiles[0]?.text;
if (!source) throw new Error("Site builder compilation produced no output");

await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
