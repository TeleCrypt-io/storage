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
source "$script_dir/capture-diagnostics.sh"

capture_command() {
  local output="$1" error="$2" status
  shift 2
  if run_captured "$output" "$error" 120 "$@"; then
    status=0
  else
    status="$?"
  fi
  finish_capture "$status" true "$output" "$error"
}

capture_binary() {
  local output="$1" error="$2" status
  shift 2
  if run_captured "$output" "$error" 120 "$@"; then
    status=0
  else
    status="$?"
  fi
  finish_capture "$status" false "$output" "$error"
}

replay_api_failure() {
  local body="$1" error="$2"
  shift 2
  if test -f "$body.err"; then
    replay_capture "$body" "$body.err" true "$error" "$@"
  else
    replay_capture "$body" "$error" true "$@"
  fi
}

require_api_json() {
  local body="$1" transport_error="$2" status replay_status=0 semantic_output="$1.semantic.out" semantic_error="$1.semantic.err"
  shift 2
  if "$@" >"$semantic_output" 2>"$semantic_error"; then
    if cat "$semantic_error" >&2; then :; else replay_status=1; fi
    if cat "$semantic_output"; then :; else replay_status=1; fi
    return "$replay_status"
  else
    status="$?"
  fi
  if test "$transport_error" = "$body.err"; then
    replay_api_failure "$body" "$semantic_error" "$semantic_output" || replay_status="$?"
  else
    replay_api_failure "$body" "$semantic_error" "$semantic_output" "$transport_error" || replay_status="$?"
  fi
  return "$status"
}

api_value() {
  local body="$1" status replay_status=0 semantic_output="$1.semantic.out"
  shift
  local semantic_error="$body.semantic.err"
  if "$@" >"$semantic_output" 2>"$semantic_error"; then
    if cat "$semantic_error" >&2; then :; else replay_status=1; fi
    if cat "$semantic_output"; then :; else replay_status=1; fi
    return "$replay_status"
  else
    status="$?"
  fi
  replay_api_failure "$body" "$semantic_error" "$semantic_output" || replay_status="$?"
  return "$status"
}

release_json="$temporary_dir/release.json"
capture_command "$release_json.stdout" "$release_json.stderr" \
  gh api --hostname github.com --header 'X-GitHub-Api-Version: 2026-03-10' \
  "/repos/TeleCrypt-io/ui-shared-css/releases/tags/$ui_tag"
mv -- "$release_json.stdout" "$release_json"

require_api_json "$release_json" "$release_json.stderr" jq -e --arg tag "$ui_tag" --arg asset "$ui_asset" '
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
capture_binary "$archive.stdout" "$archive.stderr" \
  gh api --hostname github.com --header 'Accept: application/octet-stream' \
  --header 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/TeleCrypt-io/ui-shared-css/releases/assets/$asset_id"
mv -- "$archive.stdout" "$archive"
test "$(wc -c <"$archive")" = "$asset_size"
test "sha256:$(sha256sum "$archive" | awk '{print $1}')" = "$asset_digest"
if node scripts/verify-provenance.mjs "$release_json" "$archive"; then
  :
else
  status="$?"
  replay_capture "$release_json" "$release_json.stderr" || :
  exit "$status"
fi
