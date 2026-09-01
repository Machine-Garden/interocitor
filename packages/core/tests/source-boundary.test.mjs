import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";

const CORE_SRC = new URL("../src/", import.meta.url);

const bannedPatterns = [
  /\bindexedDB\b/,
  /\bIDB[A-Za-z0-9_]*\b/,
  /\blocalStorage\b/,
  /\bwindow\b/,
  /\bdocument\b/,
  /\bnavigator\b/,
  /\bDOMParser\b/,
  /\bBlob\b/,
  /\bFile\b/,
  /URL\.createObjectURL/,
  /\bPublicKeyCredential\b/,
  /\bWebAuthn\b/,
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && path.endsWith(".ts")) {
      yield path;
    }
  }
}

test("@interocitor/core source has no browser runtime globals", async () => {
  const failures = [];
  for await (const path of walk(CORE_SRC.pathname)) {
    const source = await readFile(path, "utf8");
    for (const pattern of bannedPatterns) {
      if (pattern.test(source)) {
        failures.push(`${relative(CORE_SRC.pathname, path)} matched ${pattern}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
