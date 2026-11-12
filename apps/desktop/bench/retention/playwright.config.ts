import { defineConfig } from "@playwright/test";
import path from "node:path";
const output = process.env.MODEX_RETENTION_OUTPUT;
if (!output || !path.isAbsolute(output)) throw new Error("An explicit private MODEX_RETENTION_OUTPUT is required.");
export default defineConfig({
  testDir: ".", testMatch: ["history.spec.ts", "stream.spec.ts"], workers: 1,
  timeout: 180_000, expect: { timeout: 15_000 }, retries: 0, maxFailures: 1,
  reporter: [["list"], ["json", { outputFile: path.join(output, "report.json") }]],
  outputDir: path.join(output, "artifacts"), use: { trace: "off" },
});
