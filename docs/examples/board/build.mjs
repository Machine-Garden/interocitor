import { buildDemo } from "../build-demo.mjs";

await buildDemo(import.meta.url, {
  label: "encrypted board",
  checkCommand: "yarn build:docs:board",
});
