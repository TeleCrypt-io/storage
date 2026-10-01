#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
tag="${1:?release tag required}"
sha="${2:?release commit required}"
directory="${3:?download directory required}"
bash scripts/verify-release-source.sh "$tag" "$sha" storage-web-v
export GITHUB_REPOSITORY=TeleCrypt-io/storage
asset="storage-web-${tag#storage-web-v}.pages.zip"
metadata="$(mktemp)"
trap 'rm -f -- "$metadata"' EXIT
gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" >"$metadata"
digest="$(jq -er '.assets[0].digest' "$metadata")"
size="$(jq -er '.assets[0].size' "$metadata")"
id="$(jq -er '.id' "$metadata")"
bash scripts/verify-release.sh "$tag" "$sha" "$asset" "$digest" "$size" "$directory" "$id"
