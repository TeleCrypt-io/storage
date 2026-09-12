#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag required}"
sha="${2:?release commit required}"
asset="${3:?asset name required}"
digest="${4:?asset digest required}"
size="${5:?asset size required}"
directory="${6:?download directory required}"
expected_id="${7:-}"

release_json="$(mktemp)"
trap 'rm -f "$release_json"' EXIT
gh api --hostname github.com "/repos/$GITHUB_REPOSITORY/releases/tags/$tag" >"$release_json"
jq -e --arg tag "$tag" --arg sha "$sha" --arg asset "$asset" \
  --arg digest "$digest" --argjson size "$size" --arg id "$expected_id" \
  '(.id|type)=="number" and .id>0 and .tag_name==$tag and .target_commitish==$sha and .draft==false and .prerelease==false and .immutable==true and ((.assets|type)=="array" and (.assets|length)==1) and .assets[0].name==$asset and .assets[0].state=="uploaded" and .assets[0].size==$size and .assets[0].digest==$digest and ($id=="" or (.id|tostring)==$id)' \
  "$release_json" >/dev/null

mkdir -p "$directory"
gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$asset" --dir "$directory" >/dev/null
archive="$directory/$asset"
test "$(wc -c <"$archive")" = "$size"
test "sha256:$(sha256sum "$archive" | awk '{print $1}')" = "$digest"
jq -r '.id' "$release_json"
