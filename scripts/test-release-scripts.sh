#!/usr/bin/env bash
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd -- "$here/.." && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fail() {
  printf 'release script test failed: %s\n' "$*" >&2
  exit 1
}

assert_success() {
  if ! "$@" >/dev/null 2>"$work/assert-error"; then
    cat -- "$work/assert-error" >&2 || true
    fail "expected command to succeed: $*"
  fi
}

assert_failure() {
  if "$@" >/dev/null 2>"$work/assert-error"; then
    fail "expected command to fail: $*"
  fi
}

repo="$work/repo"
git init --quiet --initial-branch=main "$repo"
git -C "$repo" config user.email test@example.invalid
git -C "$repo" config user.name 'Release script test'
printf 'one\n' >"$repo/file"
git -C "$repo" add file
git -C "$repo" commit --quiet -m initial
commit_one="$(git -C "$repo" rev-parse HEAD)"

git -C "$repo" tag -a storage-web-v1.2.3 "$commit_one" -m web
git -C "$repo" tag -a storage-cli-v1.2.3 "$commit_one" -m cli
git -C "$repo" tag -a storage-web-v01.2.3 "$commit_one" -m leading-major-zero
git -C "$repo" tag -a storage-web-v1.02.3 "$commit_one" -m leading-minor-zero
git -C "$repo" tag -a storage-web-v1.2.03 "$commit_one" -m leading-patch-zero
git -C "$repo" tag -a storage-web-v1.2.3.4 "$commit_one" -m extra-version-part
git -C "$repo" tag storage-web-v1.2.4 "$commit_one"

source_check() {
  (cd "$repo" && bash "$here/verify-release-source.sh" "$@")
}

git -C "$repo" checkout --quiet --detach "$commit_one"
assert_success source_check storage-web-v1.2.3 "$commit_one" storage-web-v
assert_success source_check storage-cli-v1.2.3 "$commit_one" storage-cli-v
assert_failure source_check storage-cli-v1.2.3 "$commit_one" storage-web-v
assert_failure source_check storage-web-v01.2.3 "$commit_one" storage-web-v
assert_failure source_check storage-web-v1.02.3 "$commit_one" storage-web-v
assert_failure source_check storage-web-v1.2.03 "$commit_one" storage-web-v
assert_failure source_check storage-web-v1.2.3.4 "$commit_one" storage-web-v
assert_failure source_check storage-web-v1.2.4 "$commit_one" storage-web-v

git -C "$repo" checkout --quiet main
printf 'two\n' >>"$repo/file"
git -C "$repo" add file
git -C "$repo" commit --quiet -m second
commit_two="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" tag -a storage-web-v1.2.5 "$commit_one" -m checkout-mismatch
git -C "$repo" checkout --quiet --detach "$commit_one"
assert_failure source_check storage-web-v1.2.5 "$commit_two" storage-web-v
git -C "$repo" checkout --quiet --detach "$commit_two"
assert_failure source_check storage-web-v1.2.5 "$commit_one" storage-web-v

fake_bin="$work/bin"
mkdir -- "$fake_bin"
cat >"$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${FAKE_GH_MODE:-ok}" == api-fail && "${1:-}" == api ]]; then
  printf 'simulated GitHub API failure\n' >&2
  exit 1
fi
if [[ "${FAKE_GH_MODE:-ok}" == download-fail && "${1:-}" == release && "${2:-}" == download ]]; then
  printf 'simulated GitHub archive download failure\n' >&2
  exit 1
fi
if [[ "${1:-}" == api ]]; then
  cat -- "$FAKE_RELEASE_JSON"
  exit 0
fi
if [[ "${1:-}" == release && "${2:-}" == download ]]; then
  pattern=''
  directory=''
  while (($#)); do
    case "$1" in
      --pattern) pattern="$2"; shift 2;;
      --dir) directory="$2"; shift 2;;
      *) shift;;
    esac
  done
  test -n "$pattern" -a -n "$directory"
  mkdir -p -- "$directory"
  cp -- "$FAKE_ARCHIVE" "$directory/$pattern"
  if [[ -n "${FAKE_DOWNLOAD_COUNT_FILE:-}" ]]; then
    printf 'downloaded\n' >"$FAKE_DOWNLOAD_COUNT_FILE"
  fi
  exit 0
fi
printf 'unexpected fake gh invocation\n' >&2
exit 1
EOF
chmod +x "$fake_bin/gh"

archive="$work/archive.tgz"
printf 'archive bytes\n' >"$archive"
archive_size="$(wc -c <"$archive")"
archive_digest="sha256:$(sha256sum "$archive" | awk '{print $1}')"
release_tag='storage-web-v9.8.7'
asset_name='fixture-archive.tgz'
release_json="$work/release.json"
jq -n \
  --arg tag "$release_tag" --arg sha "$commit_one" --arg asset "$asset_name" \
  --arg digest "$archive_digest" --argjson size "$archive_size" \
  '{id:123, tag_name:$tag, target_commitish:$sha, draft:false, prerelease:false,
    immutable:true, assets:[{name:$asset, state:"uploaded", size:$size, digest:$digest}]}' \
  >"$release_json"

release_check() {
  local mode=$1 metadata=$2 destination=$3 expected_digest=$4 expected_size=$5 expected_id=$6
  (cd "$root" && \
    GITHUB_REPOSITORY=TeleCrypt-io/storage \
    FAKE_GH_MODE="$mode" FAKE_RELEASE_JSON="$metadata" FAKE_ARCHIVE="$archive" \
    PATH="$fake_bin:$PATH" \
    bash "$here/verify-release.sh" "$release_tag" "$commit_one" "$asset_name" \
      "$expected_digest" "$expected_size" "$destination" "$expected_id")
}

result="$(release_check ok "$release_json" "$work/download-ok" "$archive_digest" "$archive_size" 123)"
[[ "$result" == 123 ]] || fail "expected release ID 123, got $result"
cmp -- "$archive" "$work/download-ok/$asset_name"

bad_digest_json="$work/release-bad-digest.json"
jq '.assets[0].digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"' \
  "$release_json" >"$bad_digest_json"
assert_failure release_check ok "$bad_digest_json" "$work/download-bad-digest" "$archive_digest" "$archive_size" 123
test ! -e "$work/download-bad-digest"

bad_size_json="$work/release-bad-size.json"
bad_size=$((archive_size + 1))
jq --argjson size "$bad_size" '.assets[0].size = $size' \
  "$release_json" >"$bad_size_json"
assert_failure release_check ok "$bad_size_json" "$work/download-bad-size" "$archive_digest" "$archive_size" 123
test ! -e "$work/download-bad-size"

assert_failure release_check ok "$release_json" "$work/download-bad-id" "$archive_digest" "$archive_size" 999
test ! -e "$work/download-bad-id"
assert_failure release_check api-fail "$release_json" "$work/download-api-failure" "$archive_digest" "$archive_size" 123
assert_failure release_check download-fail "$release_json" "$work/download-failure" "$archive_digest" "$archive_size" 123

render_dist="$work/rendered-dist"
mkdir -p "$render_dist"
printf '%s\n' '<meta __TELECRYPT_PUBLIC_ASSET_ORIGIN__ __TELECRYPT_DEPLOYMENT_CSP__>' >"$render_dist/index.html"
printf '%s\n' 'Content-Security-Policy: __TELECRYPT_DEPLOYMENT_CSP__' >"$render_dist/_headers"
assert_success node "$root/scripts/render-deployment.mjs" "$render_dist" stage.telecrypt.io
grep -F 'https://www.telecrypt.io' "$render_dist/index.html" "$render_dist/_headers" >/dev/null
grep -F 'https://backend.stage.telecrypt.io' "$render_dist/index.html" "$render_dist/_headers" >/dev/null
[[ "$(<"$render_dist/config.json")" == *'"serverName": "stage.telecrypt.io"'* ]]
[[ "$(<"$render_dist/CNAME")" == 'storage.stage.telecrypt.io' ]]
! grep -F '__TELECRYPT_' "$render_dist/index.html" "$render_dist/_headers"
assert_failure node "$root/scripts/render-deployment.mjs" "$render_dist" 'stage..telecrypt.io'

printf 'release script checks passed\n'
