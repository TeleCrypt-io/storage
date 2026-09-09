import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const productionConnectSrc =
  "connect-src 'self' https://backend.telecrypt.io https://backend.stage.telecrypt.io https://stage.telecrypt.io/.well-known/matrix/client https://telecrypt.io/.well-known/matrix/client;";
const developmentConnectSrc =
  "connect-src 'self' http://localhost:* ws://localhost:*;";

// The storage SDK's matrix-js-sdk dependency (and its dependency matrix-encrypt-attachment) expect a Node-ish
// `Buffer`/`global` to exist. The browser has neither natively, so we polyfill:
// `global` -> `globalThis` at build/dev time, and `Buffer` via the `buffer`
// package (wired up as an actual global in src/main.tsx). Everything else in
// matrix-js-sdk resolves via its own "browser" package.json field, which Vite
// picks up automatically — no further Node polyfills needed.
export default defineConfig({
  build: {
    // The separately emitted encrypted IndexedDB worker is about 747 kB minified. Keep a narrow
    // reviewed ceiling above it so this required crypto chunk is not a standing warning and future
    // growth still fails visibly during release review.
    chunkSizeWarningLimit: 1024,
  },
  plugins: [
    react(),
    {
      // Keep the checked-in policy strict for production while allowing the
      // disposable localhost MAS/Synapse fixture used by Playwright and
      // interactive development. Vite applies this transform only to pages
      // served by the development server; release builds retain the exact
      // production policy from index.html.
      name: "allow-local-fixture-in-development-csp",
      apply: "serve",
      transformIndexHtml(html) {
        if (!html.includes(productionConnectSrc)) {
          throw new Error("development CSP transform could not find the production connect-src policy");
        }
        return html.replace(productionConnectSrc, developmentConnectSrc);
      },
    },
  ],
  define: {
    global: "globalThis",
  },
});
