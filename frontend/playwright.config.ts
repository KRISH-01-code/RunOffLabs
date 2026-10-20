import { defineConfig } from "@playwright/test";

// End-to-end tests run against their own servers (backend :8100 with a throwaway
// SQLite file, frontend :3100 built into .next-e2e), so they never touch your
// projects or a dev server you have running. They use your installed Chrome.
const API_PORT = 8100;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1, // the tests share one backend
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  },
  webServer: [
    {
      command: `rm -rf .e2e && mkdir .e2e && RUNOFFLAB_DB=.e2e/e2e.db .venv/bin/uvicorn runofflab.api.app:app --port ${API_PORT}`,
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx next build && npx next start --port ${WEB_PORT}`,
      env: { NEXT_DIST_DIR: ".next-e2e", RUNOFFLAB_API_URL: `http://127.0.0.1:${API_PORT}` },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
