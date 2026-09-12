#!/usr/bin/env bash
set -euo pipefail

# Storage vendors the stylesheet, so this is a release-time provenance gate,
# not a runtime download. Keep the selected release exact until the shared UI
# source publishes a successor and this checkout updates its provenance.
ui_tag="v0.1.8"
ui_asset="telecrypt-io-ui-0.1.8.tgz"
if test -n "${HARNESS_ARTIFACTS_ROOT:-}"; then
  temporary_dir="$(mktemp -d "$HARNESS_ARTIFACTS_ROOT/storage-ui-release-XXXXXX")"
else
  temporary_dir="$(mktemp -d)"
fi
cleanup() {
  local status=$? cleanup_status=0
  if test "$status" -eq 0; then
    rm -rf -- "$temporary_dir" || cleanup_status=$?
    if test "$cleanup_status" -ne 0; then
      printf 'shared UI release cleanup failed (status %s)\n' "$cleanup_status" >&2
      status="$cleanup_status"
    fi
  else
    printf 'shared UI release evidence retained at %s\n' "$temporary_dir" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/release-common.sh"

release_json="$temporary_dir/release.json"
capture_response "$release_json" \
  gh api --hostname github.com --header 'X-GitHub-Api-Version: 2026-03-10' \
  "/repos/TeleCrypt-io/ui-shared-css/releases/tags/$ui_tag"

require_api_json "$release_json" "$release_json.err" jq -e --arg tag "$ui_tag" --arg asset "$ui_asset" '
  type == "object" and .tag_name == $tag and .name == $tag and
  .draft == false and .prerelease == false and .immutable == true and
  (.target_commitish | type == "string" and test("^[0-9a-f]{40}$")) and
  (.assets | type == "array" and length == 1) and
  (.assets[0] | type == "object" and .name == $asset and .state == "uploaded" and
    (.id | type == "number" and . > 0 and floor == .) and
    (.size | type == "number" and . > 0 and floor == .) and
    (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")))
' "$release_json"

asset_id="$(api_value "$release_json" jq -er '.assets[0].id' "$release_json")"
asset_size="$(api_value "$release_json" jq -er '.assets[0].size' "$release_json")"
asset_digest="$(api_value "$release_json" jq -er '.assets[0].digest' "$release_json")"
archive="$temporary_dir/$ui_asset"
capture_binary "$archive" \
  gh api --hostname github.com --header 'Accept: application/octet-stream' \
  --header 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/TeleCrypt-io/ui-shared-css/releases/assets/$asset_id"
test "$(wc -c <"$archive")" = "$asset_size"
test "sha256:$(sha256sum "$archive" | awk '{print $1}')" = "$asset_digest"
if node scripts/verify-provenance.mjs "$release_json" "$archive"; then
  :
else
  status="$?"
  replay_capture "$release_json" "$release_json.err" || :
  exit "$status"
fi
