#!/usr/bin/env bash
set -euo pipefail
publisher_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "$#" -ne 4 ]]; then
  printf 'usage: download-release.sh TAG SOURCE_SHA DOWNLOAD_DIR SOURCE_CHECKOUT\n' >&2
  exit 2
fi
tag="$1"
sha="$2"
directory="$3"
source_checkout="$(cd -- "$4" && pwd -P)"
test "$(git -C "$source_checkout" rev-parse HEAD)" = "$sha"
bash "$publisher_root/scripts/verify-release-source.sh" \
  "$tag" "$sha" storage-web-v "$source_checkout"
export GITHUB_REPOSITORY=TeleCrypt-io/storage
asset="storage-web-${tag#storage-web-v}.pages.zip"
metadata="$(mktemp)"
trap 'rm -f -- "$metadata"' EXIT
gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" >"$metadata"
digest="$(jq -er '.assets[0].digest' "$metadata")"
size="$(jq -er '.assets[0].size' "$metadata")"
id="$(jq -er '.id' "$metadata")"
bash "$publisher_root/scripts/verify-release.sh" \
  "$tag" "$sha" "$asset" "$digest" "$size" "$directory" "$id"
