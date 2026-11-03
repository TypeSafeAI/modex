import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tid } from "./support.js";
import { baseWorld, LENDING, launchWithGh, prRow, type Harness } from "./code-review-support.js";
import { ghFile, ghPull } from "../test/fixtures/code-review-gh-world.js";

/**
 * CR-8 (#327): regression budgets for opening the inbox, an overview and a large diff, through the production
 * read service in real Electron with the synthetic gh. Each is the median of five launches, from the click to the
 * content on screen.
 *
 * The budgets leave headroom for hosted runners, which have run the same code several times slower than this Mac
 * (docs/status.md, the 500 ms transcript gate). They catch a change that makes these paths several times slower;
 * they are not a claim about GitHub's latency, since the synthetic gh answers at once.
 *
 * MODEX_MEASURE=<file> writes the times as JSON before anything is asserted. MODEX_BUDGET_GH_DELAY_MS slows every gh
 * answer by that much, which is how each budget was shown to fail (docs/reviews/2026-11-02-v0.5.0-candidate.md).
 */
const BUDGET_MS = { inbox: 5000, overview: 1500, thousandFiles: 2500, largePatch: 3000 };
const LAUNCHES = 5;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function world() {
  const w = baseWorld();
  const files = Array.from({ length: 1000 }, (_, i) => ghFile(`src/generated/module-${String(i).padStart(4, "0")}.ts`, `@@ -0,0 +1 @@\n+export const value${i} = ${i};`, 1, 0, "added"));
  w.routes["repos/example-org/lending/pulls/73"] = ghPull(LENDING, 73, "A thousand files", { files: 1000, additions: 1000, deletions: 0 });
  w.routes["repos/example-org/lending/pulls/73/files"] = files;
  // 3 MiB of added text in one patch: 49,152 lines of 63 characters plus the newline.
  const big = `@@ -0,0 +1,49152 @@\n${Array.from({ length: 49152 }, () => "+" + "x".repeat(62)).join("\n")}`;
  w.routes["repos/example-org/lending/pulls/70"] = ghPull(LENDING, 70, "One very large patch", { files: 1, additions: 49152, deletions: 0 });
  w.routes["repos/example-org/lending/pulls/70/files"] = [ghFile("data/large.txt", big, 49152, 0, "added")];
  return w;
}

/** Puts a sleep in front of the synthetic gh, for the failure proof only. */
function slowGh(h: Harness, ms: number): void {
  const gh = path.join(h.home, "bin", "gh"), real = `${gh}-real`;
  fs.renameSync(gh, real);
  fs.writeFileSync(gh, `#!/bin/sh\nsleep ${ms / 1000}\nexec '${real}' "$@"\n`, { mode: 0o755 });
}

test("opening the inbox, an overview and a large diff stay within their budgets", async () => {
  const delay = Number(process.env.MODEX_BUDGET_GH_DELAY_MS ?? 0);
  test.setTimeout(delay ? 900_000 : 300_000);
  const data = world();
  const runs: Record<keyof typeof BUDGET_MS, number[]> = { inbox: [], overview: [], thousandFiles: [], largePatch: [] };
  for (let i = 0; i < LAUNCHES; i++) {
    const h = await launchWithGh(data);
    try {
      const { page } = h;
      if (delay) slowGh(h, delay);
      const timed = async (name: keyof typeof BUDGET_MS, act: () => Promise<void>, done: () => Promise<void>) => {
        const t = Date.now();
        await act();
        await done();
        runs[name].push(Date.now() - t);
      };
      await timed("inbox", () => tid(page, "rail-code-review").click(), () => expect(prRow(page, "example-org/lending#73"), "inbox").toBeVisible({ timeout: 120_000 }));
      await timed("overview", () => prRow(page, "example-org/lending#73").click(), () => expect(tid(page, "cr-description"), "overview").toBeVisible({ timeout: 120_000 }));
      await timed("thousandFiles", () => tid(page, "code-review-tab-changes").click(), () => expect(page.getByRole("button", { name: "Collapse src/generated/module-0000.ts" }), "1,000-file diff").toBeVisible({ timeout: 300_000 }));
      await prRow(page, "example-org/lending#70").click();
      await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #70", { timeout: 120_000 });
      await timed("largePatch", () => tid(page, "code-review-tab-changes").click(), () => expect(page.getByRole("button", { name: "Collapse data/large.txt" }), "3 MiB patch").toBeVisible({ timeout: 120_000 }));
    } finally {
      await h.close();
    }
  }
  const medians = Object.fromEntries(Object.entries(runs).map(([name, values]) => [name, median(values)])) as Record<keyof typeof BUDGET_MS, number>;
  const file = process.env.MODEX_MEASURE;
  if (file) fs.writeFileSync(file, JSON.stringify({ measuredAt: new Date().toISOString(), delay, machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, loadAverage: os.loadavg() }, medians, runs, budgets: BUDGET_MS }, null, 2) + "\n");
  for (const name of Object.keys(BUDGET_MS) as (keyof typeof BUDGET_MS)[]) expect.soft(medians[name], `${name} median of ${runs[name].join(", ")} ms`).toBeLessThanOrEqual(BUDGET_MS[name]);
});
