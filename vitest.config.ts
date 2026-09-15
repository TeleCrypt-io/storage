import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component/wiring tests only (jsdom, core/ mocked at the boundary).
// Real-crypto/real-Synapse coverage lives in Playwright
// (test/e2e), not here.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    exclude: ["**/node_modules/**", "**/test/e2e/**", "**/cli/**"],
  },
});
