import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
let other: ReturnType<typeof seedHome>;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  other = seedHome();
  const file = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.projects.push({ id: "p2", name: "Other project", path: other.repo, addedAt: new Date().toISOString() });
  state.settings.approval_rules = [{ id: "other", when: "keep the other project rule", decision: "never", project: other.repo, match: "Bash: git push*", enabled: true }];
  fs.writeFileSync(file, JSON.stringify(state));
  ({ app, page } = await launch(home));
});
test.afterAll(async () => {
  await app?.close();
  for (const dir of [home, repo, other?.home, other?.repo]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const settings = () => tid(page, "settings");
const rules = () => tid(page, "approval-rule");
const preview = () => tid(page, "approval-preview");
const storedRules = () => page.evaluate(() => window.modex!.invoke("approvals:rules:get", undefined));
const open = async () => {
  await tid(page, "open-settings").click();
  await expect(settings()).toBeVisible();
  await tid(page, "settings-nav").getByRole("button", { name: "Approval rules" }).click();
};

test("Settings scopes new rules, previews without saving, keeps inactive rules visible, and preserves drafts on error", async () => {
  await open();
  await expect(tid(page, "approval-gate-status")).toContainText("not active");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  const rule = rules().last();
  await expect(rule.getByRole("combobox", { name: "Scope", exact: true })).toHaveValue(repo);
  await rule.getByLabel("When the agent wants to").fill("run tests");
  await expect(tid(rule, "rule-inactive")).toHaveText("Inactive without Jev");
  await rule.getByRole("combobox", { name: "Decision", exact: true }).selectOption("allow");
  await rule.getByLabel("Exact match (optional)").fill("Bash: npm test*");
  await expect(tid(rule, "rule-inactive")).toHaveCount(0);
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await expect(preview()).toHaveAttribute("data-decision", "allow");
  await expect(preview()).toContainText("Exact match");
  await expect(preview()).toContainText("Preview only");
  expect(await storedRules()).toHaveLength(1);
  expect((await page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads).toHaveLength(0);
  await page.getByLabel("Sample action").fill("npm build");
  await expect(preview()).toHaveCount(0);
  await page.getByLabel("Sample action").fill("npm test");
  await expect(preview()).toHaveCount(0);
  await page.getByLabel("Requests additional sandbox permissions").check();
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await expect(preview()).toHaveAttribute("data-decision", "ask");
  await expect(preview()).toContainText("only you can grant additional permissions");
  await page.getByLabel("Requests additional sandbox permissions").uncheck();
  await page.getByRole("combobox", { name: "Preview project", exact: true }).selectOption("p2");
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await expect(preview()).toHaveAttribute("data-decision", "ask");
  await expect(preview()).toContainText("No applicable rule");
  await rule.getByRole("combobox", { name: "Scope", exact: true }).selectOption("");
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await expect(preview()).toHaveAttribute("data-decision", "allow");
  await rule.getByLabel("When the agent wants to").fill("");
  await settings().getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings()).toBeVisible();
  await expect(settings().getByRole("alert")).toContainText("When must contain");
  expect(await storedRules()).toHaveLength(1);
  await settings().getByRole("button", { name: "Cancel", exact: true }).click();
  await open();
  await expect(rules()).toHaveCount(1);
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await rules().last().getByLabel("When the agent wants to").fill("run tests");
  await settings().getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings()).toHaveCount(0);
  const saved = await storedRules();
  expect(saved).toHaveLength(2);
  expect(saved[0]?.project).toBe(other.repo);
  expect(saved[1]?.project).toBe(repo);
  await open();
  await expect(rules()).toHaveCount(2);
  await rules().last().getByLabel("Enabled", { exact: true }).uncheck();
  await settings().getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings()).toHaveCount(0);
  expect((await storedRules())[1]?.enabled).toBe(false);
  await open();
  await page.getByRole("button", { name: "Delete rule 2", exact: true }).click();
  await settings().getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings()).toHaveCount(0);
  expect(await storedRules()).toEqual([saved[0]]);
});

test("automatic allow and never persist compact receipts; ask and project isolation keep human cards", async () => {
  const script = path.join(home, "approvals-script.json");
  fs.writeFileSync(script, JSON.stringify({ steps: [
    { tool_calls: [{ name: "write_file", arguments: { path: "approval.txt", content: "approved once" } }] },
    { content: "Finished." },
  ] }));
  for (const decision of ["allow", "never", "ask"] as const) {
    fs.rmSync(path.join(repo, "approval.txt"), { force: true });
    await page.evaluate(async ({ script, repo, decision }) => {
      await window.modex!.invoke("settings:update", { mock_script: script, approval_gate: { enabled: true, threshold: 0.8, timeout_ms: 3000 }, approval_rules: [
        { id: "write", when: "write the sample", decision, project: repo, match: "write: write approval.txt", enabled: true },
      ] });
    }, { script, repo, decision });
    await page.keyboard.press("Meta+n");
    await tid(page, "composer-input").fill(`${decision} the sample`);
    await page.keyboard.press("Meta+Enter");
    const approval = items(page, "approval");
    await expect(approval).toHaveCount(1);
    await expect(approval).toHaveAttribute("data-decided-by", decision);
    if (decision === "ask") {
      await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
      await expect(tid(approval, "approval-reason")).toContainText("write the sample");
      await approval.getByRole("button", { name: "Deny", exact: true }).click();
    } else {
      await expect(tid(approval, "approval-receipt")).toContainText(decision === "allow" ? "Allowed:" : "Refused by rule");
      await expect(approval.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
      await tid(approval, "item-toggle").click();
      await expect(tid(approval, "item-body")).toContainText("write the sample");
    }
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    expect(fs.existsSync(path.join(repo, "approval.txt"))).toBe(decision === "allow");
    await page.reload();
    await expect(approval).toHaveAttribute("data-decided-by", decision);
  }
  // The current project rule must not approve work in another project's worktree or checkout.
  await page.evaluate(async ({ otherRepo }) => {
    await window.modex!.invoke("approvals:rules:set", { rules: [{ id: "other-allow", when: "write", decision: "allow", project: otherRepo, match: "write: *", enabled: true }] });
  }, { otherRepo: other.repo });
  await page.keyboard.press("Meta+n");
  await tid(page, "composer-input").fill("keep this project isolated");
  await page.keyboard.press("Meta+Enter");
  await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
  await expect(items(page, "approval")).not.toHaveAttribute("data-decided-by", /.+/);
  await items(page, "approval").getByRole("button", { name: "Deny", exact: true }).click();
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
});

test("a safety-downgraded receipt explains why a human must answer", async () => {
  // Gate tests exercise the injected Jev transport; this checks its receipt's renderer contract.
  const threadId = await currentRow(page).getAttribute("data-thread-id");
  await app.evaluate(({ BrowserWindow }, threadId) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "item", threadId, item: {
      id: "destructive-fixture", kind: "approval", question: "Allow publishing the sample?", canAlways: false,
      decidedBy: { source: "rule", ruleId: "publish", when: "publish a package", decision: "ask", via: "jev", p: 0.95, ms: 25, destructive: 0.9, downgraded: "destructive" },
      at: new Date().toISOString(),
    } });
  }, threadId);
  const card = items(page, "approval").last();
  await expect(tid(card, "approval-reason")).toContainText('looks destructive (Jev 0.90); rule "publish a package" would have allowed it');
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Always", exact: true })).toHaveCount(0);
});
