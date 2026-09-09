import { readFileSync } from "node:fs";

const expectedProduction = new Map([
  ["default-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["object-src", ["'none'"]],
  ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
  ["style-src", ["'self'"]],
  ["img-src", ["'self'"]],
  ["connect-src", [
    "'self'",
    "https://backend.telecrypt.io",
    "https://backend.stage.telecrypt.io",
    "https://stage.telecrypt.io/.well-known/matrix/client",
    "https://telecrypt.io/.well-known/matrix/client",
  ]],
  ["form-action", ["'self'"]],
]);
const expectedStage = new Map([
  ...expectedProduction,
  ["frame-ancestors", ["'none'"]],
]);

function serializePolicy(policy) {
  return [...policy]
    .map(([name, sources]) => `${name}${sources.length === 0 ? "" : ` ${sources.join(" ")}`}`)
    .join("; ");
}

function parsePolicy(policy) {
  const directives = new Map();
  for (const rawDirective of policy.split(";")) {
    const fields = rawDirective.trim().split(/\s+/u).filter(Boolean);
    if (fields.length === 0) continue;
    const [name, ...sources] = fields;
    if (!/^[a-z][a-z-]*$/u.test(name) || directives.has(name)) {
      throw new Error(`CSP contains an invalid or duplicate directive: ${name}`);
    }
    directives.set(name, sources);
  }
  return directives;
}

function requireExactPolicy(actual, expected) {
  if (actual.size !== expected.size) throw new Error("CSP contains an unexpected directive set");
  for (const [name, sources] of expected) {
    if (JSON.stringify(actual.get(name)) !== JSON.stringify(sources)) {
      throw new Error(`CSP directive does not match the exact contract: ${name}`);
    }
  }
}

const indexHtml = readFileSync("index.html", "utf8");
const matches = [...indexHtml.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/giu)];
if (matches.length !== 1) throw new Error("index.html must contain exactly one CSP meta policy");
requireExactPolicy(parsePolicy(matches[0][1]), expectedProduction);

const headerFile = readFileSync("public/_headers", "utf8");
const headerLines = headerFile.split("\n");
if (headerLines.at(-1) === "") headerLines.pop();
if (headerLines.length !== 3 || headerLines[0] !== "/*") {
  throw new Error("public/_headers must contain exactly one /* rule and two headers");
}
const headers = new Map();
for (const line of headerLines.slice(1)) {
  const match = line.match(/^ {2}([A-Za-z0-9-]+): ([^\r\n]*)$/u);
  if (!match || headers.has(match[1])) {
    throw new Error("public/_headers contains an invalid or duplicate header");
  }
  headers.set(match[1], match[2]);
}
const expectedHeaders = new Map([
  ["Content-Security-Policy", serializePolicy(expectedStage)],
  ["X-Frame-Options", "DENY"],
]);
if (headers.size !== expectedHeaders.size) {
  throw new Error("public/_headers contains an unexpected header set");
}
for (const [name, value] of expectedHeaders) {
  if (headers.get(name) !== value) {
    throw new Error(`public/_headers differs from the exact stage contract: ${name}`);
  }
}
requireExactPolicy(parsePolicy(headers.get("Content-Security-Policy")), expectedStage);

const viteConfig = readFileSync("vite.config.ts", "utf8");
for (const exact of [
  `"connect-src 'self' https://backend.telecrypt.io https://backend.stage.telecrypt.io https://stage.telecrypt.io/.well-known/matrix/client https://telecrypt.io/.well-known/matrix/client;";`,
  `"connect-src 'self' http://localhost:* ws://localhost:*;";`,
]) {
  if (!viteConfig.includes(exact)) {
    throw new Error("Vite development CSP transform differs from its exact contract");
  }
}
if (!viteConfig.includes("return html.replace(productionConnectSrc, developmentConnectSrc);")) {
  throw new Error("Vite must replace only the exact production connect-src directive in development");
}
