import { defineConfig } from "@playwright/test";

const port = Number(process.env.MODEX_SITE_TEST_PORT ?? 5187);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 30_000,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `npm run preview -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
