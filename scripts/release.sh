#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
mode="${1:?usage: bash scripts/release.sh prepare|publish TAG}"
tag="${2:?release tag required}"
case "$mode" in prepare|publish) ;; *) echo 'Expected prepare or publish' >&2; exit 2;; esac
sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
case "$tag" in
  storage-web-v*) prefix=storage-web-v; package=.; asset="storage-web-${tag#storage-web-v}.pages.zip";;
  storage-cli-v*) prefix=storage-cli-v; package=cli; asset="$tag.tgz";;
  *) echo 'Expected storage-web-vX.Y.Z or storage-cli-vX.Y.Z' >&2; exit 2;;
esac
bash scripts/verify-release-source.sh "$tag" "$sha" "$prefix"
version="${tag#"$prefix"}"
test "$version" = "$(cd "$package" && node -p 'require("./package.json").version')"
test "$version" = "$(cd "$package" && node -p 'require("./package-lock.json").packages[""].version')"
directory="$(pwd)/release/$tag"
export GITHUB_REPOSITORY=TeleCrypt-io/storage
if [[ "$mode" == prepare ]]; then
test "$(node --version)" = "v$(cat .node-version)"
(
cd "$package"
test "$(npm --version)" = "$(node -p 'require("./package.json").packageManager.replace(/^npm@/u, "")')"
npm ci --ignore-scripts --no-fund --no-audit
npm run lint
if [[ "$package" == cli ]]; then npm run test:unit; else npm test; fi
rm -rf -- dist
npm run build
)
mkdir -p "$directory"
if [[ "$package" == cli ]]; then
  cp LICENSE cli/LICENSE
  (cd cli && node scripts/generateThirdPartyLicenses.mjs package-lock.json node_modules THIRD-PARTY-LICENSES.txt
   npm pack --ignore-scripts --pack-destination "$directory" --json) >"$directory/pack.json"
  mv "$directory/$(jq -r '.[0].filename' "$directory/pack.json")" "$directory/$asset"
  bash cli/scripts/verify-package.sh "$directory/$asset" "$version"
else
  bash scripts/test-release-scripts.sh
  bash scripts/package-pages.sh dist "$directory/$asset" "$(git show -s --format=%ct "$sha")"
fi
jq -n --arg sha "$sha" --arg asset "$asset" --arg digest "sha256:$(sha256sum "$directory/$asset" | cut -d' ' -f1)" --argjson size "$(wc -c <"$directory/$asset")" '{sha:$sha,asset:$asset,digest:$digest,size:$size}' >"$directory/manifest.json"
printf 'Prepared %s/%s; publish with: bash scripts/release.sh publish %s\n' "$directory" "$asset" "$tag"
else
test "$(jq -r .sha "$directory/manifest.json")" = "$sha"
test "$(jq -r .asset "$directory/manifest.json")" = "$asset"
digest="$(jq -r .digest "$directory/manifest.json")"
size="$(jq -r .size "$directory/manifest.json")"
test "sha256:$(sha256sum "$directory/$asset" | cut -d' ' -f1)" = "$digest"
test "$(wc -c <"$directory/$asset")" = "$size"
gh release create "$tag" "$directory/$asset" --repo "$GITHUB_REPOSITORY" --verify-tag --target "$sha" --generate-notes
verified="$(mktemp -d)"
trap 'rm -rf -- "$verified"' EXIT
bash scripts/verify-release.sh "$tag" "$sha" "$asset" "$digest" "$size" "$verified"
cmp "$directory/$asset" "$verified/$asset"
fi
