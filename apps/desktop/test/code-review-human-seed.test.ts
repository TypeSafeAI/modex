import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ghTransport } from "../src/main/engine/code-review/gh.js";
import { CodeReviewService } from "../src/main/engine/code-review/read-service.js";
import type { CodeReviewRequest, PrActivity, PrCheck, PrFiles, PrKey, PrOverview, PrStack, ReadResult } from "../src/shared/code-review.js";

function ready<T>(result: ReadResult<unknown>): T {
  assert.equal(result.state, "ready", JSON.stringify(result));
  return (result as { value: T }).value;
}

// Catches the human seed reverting to baseWorld: its overview has no description and its
// activity/checks/stack/second diff reads fail despite the checklist asking a person to use them.
test("the human seed supports populated overview, paged activity, checks, stack and both diffs through real gh reads", async (t) => {
  const desktop = fileURLToPath(new URL("../../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-cr-human-seed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.resolve(desktop, "../../docs/reviews/2026-10-22-cr8-voiceover/seed.mjs"), root], { cwd: desktop });
  const changes = { FAKE_GH_WORLD: path.join(root, "gh-world.json"), FAKE_GH_LOG: path.join(root, "gh-calls.log"), FAKE_GH_HOLDS: path.join(root, "holds"), GH_CONFIG_DIR: path.join(root, "gh-config") };
  const original = Object.fromEntries(Object.keys(changes).map(k => [k, process.env[k]]));
  Object.assign(process.env, changes);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const service = new CodeReviewService({ enabled: true, transport: ghTransport(path.join(root, "bin", "gh")) });
  let request = 0;
  type Ask = CodeReviewRequest extends infer R ? R extends CodeReviewRequest ? Omit<R, "requestId"> : never : never;
  const read = async (ask: Ask) => { const reply = await service.read({ ...ask, requestId: `human-${++request}` }); assert.ok(reply); return reply.result; };
  await read({ op: "connection" });
  await read({ op: "inbox", query: "" });
  const key: PrKey = { account: "1001", host: "github.com", repoId: "7301", number: 73 };
  const overview = ready<PrOverview>(await read({ op: "overview", key }));
  assert.match(overview.body, /## What changes/);
  assert.ok(overview.body.length > 2000, "a long Markdown description for the scrolling journey");
  assert.deepEqual(overview.totals, { files: 11, additions: 8912, deletions: 47, commits: 1 });
  const first = await read({ op: "activity", key, cursor: null });
  const activity = ready<PrActivity[]>(first);
  assert.equal(first.state === "ready" && first.coverage?.next, "p2", "Load more activity must be reachable");
  const last = await read({ op: "activity", key, cursor: "p2" });
  const all = [...activity, ...ready<PrActivity[]>(last)];
  assert.equal(last.state === "ready" && last.coverage?.complete, true);
  assert.equal(all.filter(a => a.kind === "comment").length, 101);
  assert.equal(new Set(all.map(a => a.id)).size, all.length);
  assert.ok(all.some(a => a.kind === "deployment" && a.status === "success" && a.url === "https://example.test/preview/73"));
  const checks = ready<PrCheck[]>(await read({ op: "checks", key, revision: overview.revision }));
  assert.equal(checks.length, 5);
  assert.ok(checks.some(c => c.conclusion === "failure"));
  assert.ok(checks.some(c => c.status === "running"));
  assert.equal(ready<PrStack>(await read({ op: "stack", key })).source, "inferred");
  const files = ready<PrFiles>(await read({ op: "files", key, revision: overview.revision, cursor: null })).files;
  assert.equal(files.length, 11);
  assert.equal(files.reduce((n, f) => n + f.additions, 0), 8912);
  assert.equal(files.reduce((n, f) => n + f.deletions, 0), 47);
  assert.ok(files.some(f => f.path === "src/holds/move.ts" && f.patch.kind === "text" && /\n /.test(f.patch.patch) && /\n-/.test(f.patch.patch) && /\n\+/.test(f.patch.patch)));
  const fieldKey: PrKey = { ...key, repoId: "7302", number: 91 };
  const field = ready<PrOverview>(await read({ op: "overview", key: fieldKey }));
  const fieldFiles = ready<PrFiles>(await read({ op: "files", key: fieldKey, revision: field.revision, cursor: null })).files;
  assert.equal(fieldFiles.length, 4);
  assert.deepEqual(fieldFiles.reduce((sum, f) => [sum[0]! + f.additions, sum[1]! + f.deletions], [0, 0]), [11, 4]);
  for (const other of [{ ...key, number: 70 }, { ...fieldKey, number: 73 }]) {
    const meta = ready<PrOverview>(await read({ op: "overview", key: other }));
    const listed = ready<PrFiles>(await read({ op: "files", key: other, revision: meta.revision, cursor: null })).files;
    assert.equal(listed.length, meta.totals.files, `listed PR ${other.repoId}#${other.number} must not open an incomplete fixture`);
    assert.equal(listed.reduce((n, f) => n + f.additions, 0), meta.totals.additions);
    assert.equal(listed.reduce((n, f) => n + f.deletions, 0), meta.totals.deletions);
    ready<PrActivity[]>(await read({ op: "activity", key: other, cursor: null }));
    ready<PrCheck[]>(await read({ op: "checks", key: other, revision: meta.revision }));
    ready<PrStack>(await read({ op: "stack", key: other }));
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, "gh-calls.log"), "utf8"), /^(POST|PUT|PATCH|DELETE) /m);
  assert.equal(fs.readFileSync(path.join(root, "provider-calls.log"), "utf8"), "");
});
