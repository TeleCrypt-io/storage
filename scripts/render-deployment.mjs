#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicAssets = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "public-assets.json"), "utf8"));
if (typeof publicAssets.origin !== "string" || !/^https:\/\/[A-Za-z0-9.-]+$/u.test(publicAssets.origin)) {
  throw new Error("public-assets.json has an invalid origin");
}

if (process.argv.length !== 4) {
  console.error("usage: render-deployment.mjs DIST_DIR SERVER_NAME");
  process.exit(2);
}

const dist = path.resolve(process.argv[2]);
const serverName = process.argv[3];
if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(serverName) || serverName.includes("..")) {
  throw new Error("SERVER_NAME must be a public DNS Matrix server name");
}

const backendOrigin = `https://backend.${serverName}`;
const publicAssetOrigin = publicAssets.origin;
const matrixWellKnown = `https://${serverName}/.well-known/matrix/client`;
const csp = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  `style-src 'self' ${publicAssetOrigin}`,
  `img-src 'self' ${publicAssetOrigin}`,
  "form-action 'self'",
  `connect-src 'self' ${backendOrigin} ${matrixWellKnown}`,
].join("; ");

function replaceInFile(file, replacements) {
  const filePath = path.join(dist, file);
  let content = fs.readFileSync(filePath, "utf8");
  for (const [from, to] of replacements) content = content.replaceAll(from, to);
  fs.writeFileSync(filePath, content);
}

replaceInFile("index.html", [
  ["__TELECRYPT_PUBLIC_ASSET_ORIGIN__", publicAssetOrigin],
  ["__TELECRYPT_DEPLOYMENT_CSP__", csp],
]);
replaceInFile("_headers", [["__TELECRYPT_DEPLOYMENT_CSP__", `${csp}; frame-ancestors 'none'`]]);
fs.writeFileSync(path.join(dist, "config.json"), `${JSON.stringify({ serverName }, null, 2)}\n`);
fs.writeFileSync(path.join(dist, "CNAME"), `storage.${serverName}\n`);
