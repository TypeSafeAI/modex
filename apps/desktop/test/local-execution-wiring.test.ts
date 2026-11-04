import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Product admission of local execution is this one option on the product runner, with the CLI path and discovery's
 * advertised context main itself owns. Removing it closes admission again: the runner refuses every local selection
 * and persisted target (runner-local-models tests). No flag or renderer option opens or closes it.
 */
test("main wires local execution into the product runner exactly once, from main's own connections", () => {
  const source = fs.readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  assert.equal(/local-models\/execution\.js/.test(source), true, "main/index.ts imports the local execution module");
  assert.equal(source.match(/new LocalExecution\(/g)?.length, 1, "main/index.ts constructs LocalExecution once");
  assert.match(source, /new ThreadRunner\(\{ localExecution: new LocalExecution\(home, localModels\.connections, \(\) => resolveCli\("codex", sessionCliSettings\.codex_bin\), undefined, model => localModels\.discovery\.advertisedContext\(model\)\),/);
});
