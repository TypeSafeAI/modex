import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5187', trace: 'retain-on-failure' },
  webServer: { command: 'npm run preview -- --port 5187 --strictPort', url: 'http://127.0.0.1:5187', reuseExistingServer: false },
});
