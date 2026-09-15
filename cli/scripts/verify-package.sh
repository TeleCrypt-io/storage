#!/usr/bin/env bash
set -euo pipefail

archive="${1:?package archive required}"
version="${2:?package version required}"
test -s "$archive"
test "$(basename "$archive")" = "storage-cli-v${version}.tgz"

for required in package/package.json package/dist/index.js package/README.md package/CLI.md \
  package/LICENSE package/THIRD-PARTY-LICENSES.txt; do
  tar -tzf "$archive" | grep -Fx "$required" >/dev/null
done

EXPECTED_VERSION="$version" node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(0, "utf8"));
const expected = process.env.EXPECTED_VERSION;
if (manifest.name !== "@telecrypt-io/storage-cli" || manifest.version !== expected) {
  throw new Error("package name and version do not match the release");
}
if (manifest.bin?.["telecrypt-io"] !== "dist/index.js") {
  throw new Error("package does not expose the telecrypt-io executable");
}
' < <(tar -xOzf "$archive" package/package.json)

test "$(tar -xOzf "$archive" package/THIRD-PARTY-LICENSES.txt | wc -c)" -gt 0
