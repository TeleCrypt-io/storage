# Shared release-workflow helpers. This file is sourced by workflow steps; it
# deliberately imposes no output-size limit.

capture_pid=""
capture_stdout_path=""
capture_stderr_path=""

capture_signal() {
  local signal="$1" kill_status=0 kill_probe_status=0 wait_status=0
  set +e
  trap - HUP INT TERM
  if test -n "$capture_pid"; then
    if kill -TERM "$capture_pid"; then :; else
      kill_status="$?"
      if kill -0 "$capture_pid" 2>/dev/null; then
        printf 'diagnostic capture termination failed for pid %s (status %s)\n' "$capture_pid" "$kill_status" >&2
      else
        kill_probe_status="$?"
        if test "$kill_probe_status" -ne 1 || test -e "/proc/$capture_pid"; then
          printf 'diagnostic capture termination failed for pid %s (status %s; probe status %s)\n' "$capture_pid" "$kill_status" "$kill_probe_status" >&2
        fi
      fi
    fi
    if wait "$capture_pid"; then
      wait_status=0
    else
      wait_status="$?"
      case "$wait_status" in
        127) printf 'diagnostic capture wait failed for pid %s (status %s)\n' "$capture_pid" "$wait_status" >&2 ;;
        *) : ;;
      esac
    fi
    capture_pid=""
  fi
  if test -n "$capture_stdout_path"; then
    if cat "$capture_stdout_path" >&2; then :; else
      printf 'diagnostic stdout replay failed (status %s)\n' "$?" >&2
    fi
  fi
  if test -n "$capture_stderr_path"; then
    if cat "$capture_stderr_path" >&2; then :; else
      printf 'diagnostic stderr replay failed (status %s)\n' "$?" >&2
    fi
  fi
  exit "$((128 + signal))"
}

run_captured() {
  local stdout_path="$1" stderr_path="$2" timeout_seconds="$3" status
  shift 3
  : > "$stdout_path"
  : > "$stderr_path"
  capture_stdout_path="$stdout_path"
  capture_stderr_path="$stderr_path"
  trap 'capture_signal 1' HUP
  trap 'capture_signal 2' INT
  trap 'capture_signal 15' TERM
  timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" "$@" >"$stdout_path" 2>"$stderr_path" &
  capture_pid="$!"
  if wait "$capture_pid"; then status=0; else status="$?"; fi
  capture_pid=""
  trap - HUP INT TERM
  return "$status"
}

finish_capture() {
  local command_status="$1" replay_stdout="$2" stdout_path="$3" stderr_path="$4" replay_status=0
  if test "$command_status" -ne 0; then
    replay_capture "$stdout_path" "$stderr_path" "$replay_stdout" || replay_status="$?"
  else
    replay_capture "$stdout_path" "$stderr_path" false || replay_status="$?"
  fi
  if test "$command_status" -ne 0; then return "$command_status"; fi
  return "$replay_status"
}

replay_capture() {
  local stdout_path="$1" stderr_path="$2" replay_stdout=true replay_status=0 cat_status=0 capture_extra_path
  shift 2
  if test "$#" -gt 0; then
    replay_stdout="$1"
    shift
  fi
  if test "$replay_stdout" = true; then
    if cat "$stdout_path" >&2; then :; else
      cat_status="$?"
      replay_status=1
      printf 'diagnostic stdout replay failed (status %s)\n' "$cat_status" >&2
    fi
  fi
  if cat "$stderr_path" >&2; then :; else
    cat_status="$?"
    replay_status=1
    printf 'diagnostic stderr replay failed (status %s)\n' "$cat_status" >&2
  fi
  for capture_extra_path in "$@"; do
    if cat "$capture_extra_path" >&2; then :; else
      cat_status="$?"
      replay_status=1
      printf 'diagnostic replay failed for %s (status %s)\n' "$capture_extra_path" "$cat_status" >&2
    fi
  done
  return "$replay_status"
}

capture_response() {
  local output="$1" replay_stdout=true status
  shift
  if test "${1:-}" = --binary; then
    replay_stdout=false
    shift
  fi
  local error="$output.err"
  if run_captured "$output" "$error" 120 "$@"; then status=0; else status="$?"; fi
  finish_capture "$status" "$replay_stdout" "$output" "$error"
}

capture_gh() {
  local output="$1"
  shift
  capture_response "$output" gh "$@"
}

capture_binary() {
  local output="$1"
  shift
  capture_response "$output" --binary "$@"
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

api_value() {
  local body="$1" status replay_status=0 semantic_output="$1.semantic.out"
  shift
  local error="$body.semantic.err"
  if "$@" >"$semantic_output" 2>"$error"; then
    if cat "$error" >&2; then :; else replay_status=1; fi
    if cat "$semantic_output"; then :; else replay_status=1; fi
    return "$replay_status"
  else
    status="$?"
  fi
  replay_api_failure "$body" "$error" "$semantic_output" || replay_status="$?"
  return "$status"
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

verify_source() {
  local tag="$1" expected_sha="$2" release_commit
  timeout --signal=TERM --kill-after=5s 60s git fetch --force --no-tags origin "refs/tags/$tag:refs/remotes/origin/release-tag"
  test "$(git cat-file -t refs/remotes/origin/release-tag)" = tag
  release_commit="$(git rev-parse 'refs/remotes/origin/release-tag^{commit}')"
  test "$release_commit" = "$expected_sha"
  test "$(git rev-parse HEAD)" = "$expected_sha"
}

verify_published_release() {
  local json="$1" id="$2" tag="$3" target="$4" name="$5" digest="$6" size="$7"
  require_api_json "$json" "$json.err" jq -e \
    --arg id "$id" --arg tag "$tag" --arg target "$target" --arg name "$name" \
    --arg digest "$digest" --argjson size "$size" \
    'def iso: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") and ((try fromdateiso8601 catch null) != null); (.id|tostring)==$id and .tag_name==$tag and .name==$tag and .body==("Release "+$tag) and .target_commitish==$target and .draft==false and .prerelease==false and .immutable==true and (.created_at|iso) and (.published_at|iso) and ((.published_at|fromdateiso8601) >= (.created_at|fromdateiso8601)) and ((.assets|type)=="array" and (.assets|length)==1) and .assets[0].name==$name and .assets[0].state=="uploaded" and .assets[0].size==$size and .assets[0].digest==$digest' \
    "$json"
}
