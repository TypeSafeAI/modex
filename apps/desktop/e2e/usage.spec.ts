import { test as base, expect } from "@playwright/test";
import { createServer } from "vite";
import path from "node:path";
import { appDir } from "./support";

const test = base.extend<{ usageUrl: string }>({
  usageUrl: async ({}, use) => {
    const server = await createServer({
      configFile: path.join(appDir, "vite.usage.config.ts"),
      server: { host: "127.0.0.1", port: 0, open: false },
    });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === "string")
        throw new Error("No usage preview listener");
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      await server.close();
    }
  },
});

test("collapsed navigation reopens for a destination and stays accessible on mobile", async ({
  page,
  usageUrl,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(usageUrl);
  const nav = page.getByRole("navigation", { name: "Usage navigation" });
  const manage = nav.getByRole("button", { name: "Manage", exact: true });
  await manage.focus();
  await page.keyboard.press("Enter");
  await expect(manage).toHaveAttribute("aria-expanded", "false");
  await expect(
    nav.getByRole("button", { name: "Sources", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "View coverage" }).click();
  await expect(manage).toHaveAttribute("aria-expanded", "true");
  await expect(
    nav.getByRole("button", { name: "Sources", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await manage.click();
  await nav.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav.getByRole("button")).toHaveCount(6);
  for (const label of ["Overview", "Models", "Sources"]) {
    await nav.getByRole("button", { name: label, exact: true }).click();
    await expect(
      nav.getByRole("button", { name: label, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Copilot demo rows stay unpriced across overview, activity, accounts and CSV", async ({
  page,
  usageUrl,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(usageUrl);
  await page
    .getByRole("combobox", { name: "Tool", exact: true })
    .selectOption("github-copilot");
  const cost = page
    .locator(".metric")
    .filter({ hasText: "API-equivalent cost" });
  await expect(cost.locator(".metric-value")).toHaveText("Unpriced");
  await page.getByRole("button", { name: "Cost", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /^Monthly cost/ }),
  ).toHaveAttribute("aria-label", /Jan 2026: Unpriced/);
  const nav = page.getByRole("navigation", { name: "Usage navigation" });
  await nav.getByRole("button", { name: /^Activity/ }).click();
  await expect(page.locator("tbody tr").first()).toContainText(
    "GitHub Copilot",
  );
  await expect(page.locator("tbody tr").first()).toContainText("Unpriced");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloaded;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks).toString("utf8").split("\r\n").slice(1);
  expect(rows.length).toBeGreaterThan(1);
  expect(
    rows.every(
      (row) => row.includes(",github-copilot,") && row.endsWith(",,unpriced"),
    ),
  ).toBe(true);
  await nav.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "GitHub Copilot", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".account-value")).toContainText("Unpriced");
  expect(errors).toEqual([]);
});
