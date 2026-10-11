import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, seedHome } from "./support";

test("an unflagged host accepts only the desktop activation URL and starts without granting access", async () => {
  const { home, repo } = seedHome();
  const discovery = path.join(home, "discovery");
  const host = await electron.launch({ args: [appDir], cwd: appDir,
    env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_DESKTOP_DISCOVERY_DIR: discovery, MODEX_NO_LOGIN_PATH: "1", JEV_API_KEY: "", TYPESAFE_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") } });
  try {
    await host.firstWindow();
    const hasDesktopMenu = () => host.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.items.find((item) => item.label === "Desktop access"));
    expect(await hasDesktopMenu()).toBe(false);
    expect(fs.existsSync(discovery)).toBe(false);
    for (const url of ["https://connect", "modex-host://other", "modex-host://connect?command=run", "modex-host://connect#approve"]) {
      const prevented = await host.evaluate(({ app }, url) => {
        let prevented = false;
        app.emit("open-url", { preventDefault: () => { prevented = true; } }, url);
        return prevented;
      }, url);
      expect(prevented).toBe(false);
    }
    expect(await hasDesktopMenu()).toBe(false);
    expect(await host.evaluate(({ app }) => {
      let prevented = 0;
      for (let i = 0; i < 2; i++) app.emit("open-url", { preventDefault: () => { prevented++; } }, "modex-host://connect");
      return prevented;
    })).toBe(2);
    await expect.poll(hasDesktopMenu).toBe(true);
    await expect.poll(() => fs.existsSync(discovery) ? fs.readdirSync(discovery).filter((name) => name.endsWith(".json")).length : 0).toBe(1);
    const grants = JSON.parse(fs.readFileSync(path.join(home, "desktop-host", "clients.json"), "utf8"));
    expect(grants.grants).toEqual([]);
    expect(await host.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.filter((item) => item.label === "Desktop access").length)).toBe(1);
  } finally {
    await host.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
