import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import publicAssets from "./public-assets.json" with { type: "json" };

const deploymentCspPlaceholder = "__TELECRYPT_DEPLOYMENT_CSP__";
const developmentConnectSources = ["'self'", "http://localhost:*", "ws://localhost:*"];

const baseCspDirectives = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' __TELECRYPT_PUBLIC_ASSET_ORIGIN__",
  "img-src 'self' __TELECRYPT_PUBLIC_ASSET_ORIGIN__",
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
        : ["'self'"];
      const policy = context.server
        ? contentSecurityPolicy(connectSources).replaceAll("__TELECRYPT_PUBLIC_ASSET_ORIGIN__", publicAssets.origin)
        : deploymentCspPlaceholder;
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
        source: `/*\n  Content-Security-Policy: ${deploymentCspPlaceholder}\n  X-Frame-Options: DENY\n`,
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
export default defineConfig(({ mode }) => ({
  plugins: [react(), securityPolicyPlugin()],
  define: {
    global: "globalThis",
  },
  // Vite's React Fast Refresh preamble is an inline module script. The local
  // E2E server uses the same strict CSP as the app, so disable HMR there and
  // exercise the production React runtime without weakening the policy.
  ...(mode === "e2e" ? { server: { hmr: false } } : {}),
}));
