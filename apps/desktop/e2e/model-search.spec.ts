import { test, expect } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { launch, seedHome, tid, resizeWindow, setTheme } from "./support.js";

// Catches search filtering that changes exact identities or loses input/draft state when
// actual main-owned discovery finishes. Only the metadata server is synthetic.
test("model search preserves exact manual IDs, query, focus and draft through delayed discovery", async () => {
  const pending: http.ServerResponse[] = [];
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); pending.push(res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const { home } = seedHome();
  let opened: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    opened = await launch(home);
    const { page } = opened;
    for (const [label, manualModels] of [["Alpha lab", ["alpha/model"]], ["Beta lab", ["MiXeD/vendor:Q4_0"]]] as const) {
      await page.evaluate(async ({ label, manualModels, url }) => window.modex!.invoke("local-models:command", { op: "create", input: { label, runtime: "responses", url, manualModels: [...manualModels] } }), { label, manualModels, url });
    }
    await tid(page, "composer-input").fill("unsent draft stays exactly here");
    const before = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
    await tid(page, "model-picker").click();
    const search = page.getByRole("searchbox", { name: "Search models" });
    await expect(search).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("search-loading.png"), animations: "disabled" });
    await search.fill("beta LAB");
    await expect(tid(page, "model-local-group")).toHaveCount(1);
    await search.fill("mixed/VENDOR:q4_0");
    await expect.poll(() => pending.length).toBe(2);
    for (const res of pending) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "Discovered/New:Q8" }] })); }
    await expect(tid(page, "model-local-group")).toContainText("reachable");
    await expect(search).toHaveValue("mixed/VENDOR:q4_0");
    await expect(search).toBeFocused();
    await expect(tid(page, "model-local-title")).toHaveText(["MiXeD/vendor:Q4_0"]);
    await expect(tid(page, "model-local-option")).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("search-ready.png"), animations: "disabled" });
    await search.fill("no-such-model");
    await expect(page.getByRole("status").filter({ hasText: "No matching models" })).toBeVisible();
    await expect(tid(page, "model-local-manage")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("search-no-matches.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(tid(page, "model-picker")).toBeFocused();
    await expect(tid(page, "composer-input")).toHaveValue("unsent draft stays exactly here");
    const after = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
    expect(after.threads).toEqual(before.threads);
    expect(hits).toEqual(["GET /v1/models", "GET /v1/models"]);
  } finally {
    for (const res of pending) if (!res.writableEnded) res.end();
    try { await opened?.app.close(); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

// Catches the shared Menu's capture handler consuming Home/End from the text field.
test("model search keeps text cursor keys and navigates choices without changing selection", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await page.evaluate(() => window.modex!.invoke("local-models:command", { op: "create", input: { label: "Keyboard lab", runtime: "responses", url: "http://127.0.0.1:1/v1", manualModels: ["opaque/Exact:ID"] } }));
    await tid(page, "model-picker").click();
    const search = page.getByRole("searchbox", { name: "Search models" });
    await search.fill("opaque/Exact:ID");
    await search.press("Home");
    await expect(search).toBeFocused();
    expect(await search.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(0);
    await search.press("End");
    expect(await search.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(15);
    await search.press("ArrowLeft");
    expect(await search.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(14);
    await expect(tid(page, "model-local-option")).toBeEnabled();
    await search.press("ArrowDown");
    await expect(tid(page, "model-local-option")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("opaque/Exact:ID");
    await search.press("ArrowUp");
    await expect(tid(page, "model-local-manage")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(search).toBeFocused();
    await search.fill("Exact");
    await expect(tid(page, "model-local-title")).toHaveText(["opaque/Exact:ID"]);
    await page.keyboard.press("Escape");
    await expect(tid(page, "model-picker")).toBeFocused();
    await tid(page, "model-picker").click();
    await expect(search).toHaveValue("");
    await search.press("ArrowUp");
    await expect(tid(page, "model-local-manage")).toBeFocused();
    expect((await page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads).toHaveLength(0);
    await page.keyboard.press("Escape");
    await resizeWindow(app, page, 900, 600);
    for (const theme of ["graphite", "jev", "coven"] as const) {
      await setTheme(page, theme);
      await tid(page, "model-picker").click();
      await search.fill("opaque/Exact:ID");
      await expect(search).toBeInViewport();
      await expect(tid(page, "model-local-manage")).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath(`search-minimum-${theme}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
    }
  } finally { await app.close(); }
});
