import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createThread, launch, seedHome, tid } from "./support";

let app: ElectronApplication, page: Page, home: string, repo: string;
test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  await createThread(page, "Browser tools");
  await page.keyboard.press("Meta+Shift+b");
});
test.afterEach(async () => { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });

async function site() {
  await app.evaluate(({ session }) => {
    session.fromPartition("persist:modex-workspace-browser").protocol.handle("https", () => new Response('<title>Login fixture</title><form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form><script>window.submitted = false;document.querySelector("form").onsubmit = e => {e.preventDefault();window.submitted = true;};</script>', { headers: { "content-type": "text/html" } }));
  });
  await tid(page, "workspace-address").fill("https://example.test/login");
  await tid(page, "workspace-address").press("Enter");
  await expect(page.getByRole("tab", { name: "Login fixture", exact: true })).toBeVisible();
}

test("browser tools dialog supports keyboard dismissal and explains credential setup", async () => {
  await page.getByRole("button", { name: "Browser extensions and sign-in", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Browser extensions and sign-in" });
  await expect(tools).toContainText("1Password CLI");
  await expect(tools).toContainText("Touch ID");
  await expect(tools.getByRole("button", { name: "Add extension" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tools).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Browser extensions and sign-in", exact: true })).toBeFocused();
});

test("approved content scripts run in the persistent browser session and disable on reload", async () => {
  const extension = path.join(home, "fixture-extension");
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture helper", version: "1.0", content_scripts: [{ matches: ["https://example.test/*"], js: ["page.js"], run_at: "document_end" }] }));
  fs.writeFileSync(path.join(extension, "page.js"), 'document.documentElement.dataset.modexExtension = "active";');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    dialog.showMessageBox = async (_window: unknown, options: any) => {
      if (!options.detail.includes("https://example.test/*")) throw new Error("Missing site disclosure");
      return { response: 1, checkboxChecked: false };
    };
  }, extension);
  await page.getByRole("button", { name: "Browser extensions and sign-in", exact: true }).click();
  await page.getByRole("button", { name: "Add extension", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Fixture helper");
  await page.keyboard.press("Escape");
  await site();
  const injected = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL() === "https://example.test/login")!.executeJavaScript("document.documentElement.dataset.modexExtension"));
  await expect.poll(injected).toBe("active");
  expect(await app.evaluate(({ session }) => [session.defaultSession.extensions.getAllExtensions().length, session.fromPartition("modex-knowledge").extensions.getAllExtensions().length])).toEqual([0, 0]);
  await page.getByRole("button", { name: "Browser extensions and sign-in", exact: true }).click();
  await page.getByRole("button", { name: "Disable Fixture helper", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable Fixture helper", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reload page", exact: true }).click();
  await expect.poll(injected).toBeUndefined();
});

test("1Password fills only the selected guest and never submits or exposes credentials to app IPC", async () => {
  const bin = path.join(home, "bin"); fs.mkdirSync(bin);
  const entry = { id: "a".repeat(26), title: "Fixture login", category: "LOGIN", vault: { id: "b".repeat(26) }, urls: [{ href: "https://example.test" }], fields: [{ purpose: "USERNAME", value: "val-fixture" }, { purpose: "PASSWORD", value: "fixture-secret" }] };
  fs.writeFileSync(path.join(bin, "op"), `#!/bin/sh\ncase "$2" in\nlist) cat <<'JSON'\n${JSON.stringify([entry])}\nJSON\n;;\nget) cat <<'JSON'\n${JSON.stringify(entry)}\nJSON\n;;\nesac\n`, { mode: 0o700 });
  await app.evaluate(({ dialog }, binPath) => { process.env.PATH = binPath + ":/usr/bin:/bin"; dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }, bin);
  await site();
  await page.getByRole("button", { name: "Page options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Fill with 1Password", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Login filled" })).toBeVisible();
  const values = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL() === "https://example.test/login")!.executeJavaScript('[document.querySelector("input").value, document.querySelector("input[type=password]").value, window.submitted, typeof window.modex, typeof require]'));
  expect(values).toEqual(["val-fixture", "fixture-secret", false, "undefined", "undefined"]);
  await expect(page.locator("body")).not.toContainText("fixture-secret");
  expect(fs.readFileSync(path.join(home, "app/state.json"), "utf8")).not.toContain("fixture-secret");
});
