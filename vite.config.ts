import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const publicAssetOrigin = "https://www.telecrypt.io";

const productionConnectSources = [
  "'self'",
  "https://backend.telecrypt.io",
  "https://backend.stage.telecrypt.io",
  "https://stage.telecrypt.io/.well-known/matrix/client",
  "https://telecrypt.io/.well-known/matrix/client",
];
const developmentConnectSources = ["'self'", "http://localhost:*", "ws://localhost:*"];

const baseCspDirectives = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  `style-src 'self' ${publicAssetOrigin}`,
  `img-src 'self' ${publicAssetOrigin}`,
  "form-action 'self'",
];

export function contentSecurityPolicy(
  connectSources: readonly string[],
  includeFrameAncestors = false,
): string {
  const directives = [
    ...baseCspDirectives,
    `connect-src ${connectSources.join(" ")}`,
  ];
  if (includeFrameAncestors) directives.push("frame-ancestors 'none'");
  return directives.join("; ");
}

function securityPolicyPlugin(): Plugin {
  return {
    name: "storage-security-policy",
    transformIndexHtml(html: string, context: { server?: unknown }) {
      const connectSources = context.server
        ? developmentConnectSources
        : productionConnectSources;
      const policy = contentSecurityPolicy(connectSources);
      return {
        html,
        tags: [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: policy,
            },
            injectTo: "head-prepend",
          },
        ],
      };
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: `/*\n  Content-Security-Policy: ${contentSecurityPolicy(productionConnectSources, true)}\n  X-Frame-Options: DENY\n`,
      });
    },
  };
}

// The storage SDK's matrix-js-sdk dependency (and its dependency matrix-encrypt-attachment) expect a Node-ish
// `Buffer`/`global` to exist. The browser has neither natively, so we polyfill:
// `global` -> `globalThis` at build/dev time, and `Buffer` via the `buffer`
// package (wired up as an actual global in src/main.tsx). Everything else in
// matrix-js-sdk resolves via its own "browser" package.json field, which Vite
// picks up automatically — no further Node polyfills needed.
export default defineConfig({
  plugins: [react(), securityPolicyPlugin()],
  define: {
    global: "globalThis",
  },
});
