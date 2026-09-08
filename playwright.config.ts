import { defineConfig, devices } from "@playwright/test";

// Playwright forces colored child-process output; do not also pass NO_COLOR,
// which Node reports as a conflicting, ignored setting.
delete process.env.NO_COLOR;

// E2E uses the operator-started disposable Synapse/MAS fixture at localhost:8008
// and starts only this repository's Vite development server.
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
