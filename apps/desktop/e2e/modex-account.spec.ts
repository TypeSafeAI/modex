import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import { launch, seedHome, tid } from "./support";

test("Modex identity has a separate account card and preserves CLI account selection", async () => {
  const { home, repo } = seedHome(); let app: ElectronApplication | undefined;
  try {
    const launched = await launch(home); app = launched.app; const page = launched.page;
    // Exercise real local IPC and encrypted persistence; only external browser/network
    // boundaries are fixtures. Production provider acceptance is a separate release gate.
    await app.evaluate(({ shell }) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) !== "https://api.workos.com/user_management/authenticate") return originalFetch(input, init);
        const claims = Buffer.from(JSON.stringify({ sub: "user_fixture", sid: "session_fixture", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
        return Response.json({ user: { id: "user_fixture", email: "val@example.test" }, access_token: `header.${claims}.signature`, refresh_token: "fixture-refresh-secret", oauth_tokens: { access_token: "provider-secret" } });
      };
      shell.openExternal = async (raw) => {
        const url = new URL(raw);
        if (url.pathname.endsWith("logout")) return;
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "fixture-code" }).toString();
        await originalFetch(callback);
      };
    });
    const before = await page.evaluate(() => window.modex!.invoke("chatgpt:status", undefined));
    await tid(page, "open-settings").click();
    await tid(page, "settings-nav").getByRole("button", { name: "General", exact: true }).click();
    const card = tid(page, "modex-account");
    await expect(card.getByRole("heading", { name: "Modex account", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(card.getByText("val@example.test", { exact: true })).toBeVisible();
    await expect(card.getByRole("status")).toContainText("Signed in to Modex");
    const status = await page.evaluate(() => window.modex!.invoke("modexAccount:status", undefined));
    expect(JSON.stringify(status)).not.toMatch(/fixture-refresh-secret|provider-secret|signature/);
    expect(await page.evaluate(() => window.modex!.invoke("chatgpt:status", undefined))).toEqual(before);
    await card.getByRole("button", { name: "Sign out of Modex", exact: true }).click();
    await expect(card.getByRole("status")).toContainText("Signed out locally");
    await expect(card.getByText("val@example.test", { exact: true })).toHaveCount(0);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});
