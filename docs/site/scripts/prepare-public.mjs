import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const docsRoot = fileURLToPath(new URL("../..", import.meta.url));
const publicRoot = fileURLToPath(new URL("../public", import.meta.url));

await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });
await Promise.all([
  cp(`${docsRoot}/assets`, `${publicRoot}/assets`, { recursive: true }),
  cp(`${siteRoot}/assets/og.png`, `${publicRoot}/og.png`),
  cp(`${docsRoot}/examples`, `${publicRoot}/examples`, {
    recursive: true,
    filter: (source) =>
      !source.endsWith(".mjs") && !source.endsWith(".ts") && !source.endsWith(".spec.ts"),
  }),
]);
