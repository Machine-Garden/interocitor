import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const CORE_SOURCE_URL = new URL("../src/core/", import.meta.url);
const OBSERVATION_OWNER = "change-observation.ts";
const FLUSH_OWNER = "flush.ts";

test("change observation has one source owner", async () => {
  const sourceFiles = (await readdir(CORE_SOURCE_URL)).filter((name) => name.endsWith(".ts"));
  const bypassPatterns = [
    /(?:getMeta|setMeta)\(['"](?:changeObservation|cursor|seenChangeFiles|writerFrontiers)['"]\)/,
    /lastIndexOf\(['"]-chg_['"]\)/,
    /\$\{entry\.hlc\}-\$\{entry\.id\}\.json/,
  ];

  for (const fileName of sourceFiles) {
    const source = await readFile(new URL(fileName, CORE_SOURCE_URL), "utf8");
    if (fileName !== OBSERVATION_OWNER) {
      for (const pattern of bypassPatterns) {
        assert.doesNotMatch(
          source,
          pattern,
          `${fileName} bypasses the ${OBSERVATION_OWNER} completeness owner`,
        );
      }
    }
    if (fileName !== FLUSH_OWNER) {
      assert.doesNotMatch(
        source,
        /flushToAdapter/,
        `${fileName} bypasses primary publication plus receipt recording`,
      );
    }
  }

  const flushSource = await readFile(new URL(FLUSH_OWNER, CORE_SOURCE_URL), "utf8");
  assert.doesNotMatch(
    flushSource,
    /export\s+async\s+function\s+flushReplica/,
    "replica publication must not be callable with an authoritative adapter",
  );

  const engineSource = await readFile(new URL("sync-engine.ts", CORE_SOURCE_URL), "utf8");
  assert.match(
    engineSource,
    /await ChangeObservationLedger\.clearAll\(this\.local\);/,
    "full local resets must invalidate stale observation ledgers",
  );
});
