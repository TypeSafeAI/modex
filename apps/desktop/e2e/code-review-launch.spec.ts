import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { baseWorld, launchWithGh } from "./code-review-support.js";

test("Code Review runs the selected app on initial launch and recovery", async () => {
  const h = await launchWithGh(baseWorld());
  try {
    const checkIdentity = async () => {
      const identity = await h.app.evaluate(({ app }) => ({ executable: process.execPath, packaged: app.isPackaged }));
      expect(identity.packaged).toBe(Boolean(process.env.MODEX_PACKAGED_APP));
      if (process.env.MODEX_PACKAGED_APP) {
        expect(fs.realpathSync(identity.executable)).toBe(fs.realpathSync(process.env.MODEX_PACKAGED_APP));
      }
    };
    await checkIdentity();
    await h.relaunch();
    await checkIdentity();
  } finally {
    await h.close();
  }
});
