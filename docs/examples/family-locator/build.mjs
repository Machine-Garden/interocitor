import { buildDemo } from "../build-demo.mjs";

await buildDemo(import.meta.url, {
  label: "family locator",
  checkCommand: "yarn build:docs:locator",
});
