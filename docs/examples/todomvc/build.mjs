import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const sourcePath = fileURLToPath(new URL("./app.ts", import.meta.url));
const outputPath = fileURLToPath(new URL("./app.js", import.meta.url));
const check = process.argv.includes("--check");

const result = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
});

const generated = result.outputFiles[0]?.contents;
if (!generated) throw new Error("TodoMVC bundle generation produced no output");

if (check) {
  const committed = await readFile(outputPath);
  if (!committed.equals(generated)) {
    throw new Error("docs/examples/todomvc/app.js is stale; run yarn build:docs:todomvc");
  }
} else {
  await writeFile(outputPath, generated);
}
