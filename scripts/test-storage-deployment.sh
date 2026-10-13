#!/usr/bin/env bash
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd -- "$here/.." && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fail() {
  printf 'storage deployment check failed: %s\n' "$*" >&2
  exit 1
}

assert_failure() {
  if "$@" >"$work/assert-output" 2>"$work/assert-error"; then
    fail "expected command to fail: $*"
  fi
}

selection_repo="$work/selection-repo"
remote="$work/remote.git"
git init --quiet --initial-branch=main "$selection_repo"
git -C "$selection_repo" config user.email test@example.invalid
git -C "$selection_repo" config user.name 'Storage deployment test'
printf 'main\n' >"$selection_repo/source"
git -C "$selection_repo" add source
git -C "$selection_repo" commit --quiet -m main
git -C "$selection_repo" switch --quiet -c stage
printf 'stage\n' >>"$selection_repo/source"
git -C "$selection_repo" add source
git -C "$selection_repo" commit --quiet -m stage
release_sha="$(git -C "$selection_repo" rev-parse HEAD)"
git -C "$selection_repo" tag -a storage-web-v1.2.3 "$release_sha" -m web
printf 'unreleased stage head\n' >>"$selection_repo/source"
git -C "$selection_repo" add source
git -C "$selection_repo" commit --quiet -m 'stage without release tag'
stage_sha="$(git -C "$selection_repo" rev-parse HEAD)"
git -C "$selection_repo" switch --quiet main
git init --quiet --bare "$remote"
git -C "$selection_repo" remote add origin "$remote"
git -C "$selection_repo" push --quiet origin main stage --tags

selector() {
  (cd "$selection_repo" && bash "$root/scripts/select-storage-release.sh" "$@")
}

manual_stage="$(selector workflow_dispatch refs/heads/main main stage '')"
grep -Fx 'tag=' <<<"$manual_stage" >/dev/null
grep -Fx "source_sha=$stage_sha" <<<"$manual_stage" >/dev/null
grep -Fx "source_ref=$stage_sha" <<<"$manual_stage" >/dev/null
grep -Fx 'source_kind=branch' <<<"$manual_stage" >/dev/null
grep -Fx 'metadata_source_ref=stage' <<<"$manual_stage" >/dev/null

manual_production="$(selector workflow_dispatch refs/heads/main main production storage-web-v1.2.3)"
grep -Fx "source_sha=$release_sha" <<<"$manual_production" >/dev/null
grep -Fx 'source_kind=release' <<<"$manual_production" >/dev/null
grep -Fx 'source_ref=storage-web-v1.2.3' <<<"$manual_production" >/dev/null
grep -Fx 'metadata_source_ref=storage-web-v1.2.3' <<<"$manual_production" >/dev/null
assert_failure selector workflow_dispatch refs/heads/main main production ''
assert_failure selector workflow_dispatch refs/heads/stage main stage ''

git -C "$selection_repo" switch --quiet stage
push_selection="$(selector push refs/heads/stage "$stage_sha" stage '')"
grep -Fx 'tag=' <<<"$push_selection" >/dev/null
grep -Fx "source_sha=$stage_sha" <<<"$push_selection" >/dev/null
grep -Fx 'source_kind=branch' <<<"$push_selection" >/dev/null
grep -Fx 'metadata_source_ref=stage' <<<"$push_selection" >/dev/null

fixture="$work/source"
mkdir -p "$fixture/scripts"
cp "$root/scripts/render-deployment.mjs" \
  "$root/public-assets.json" "$fixture/scripts/"
# The renderer reads public-assets.json from the checkout root.
mv "$fixture/scripts/public-assets.json" "$fixture/public-assets.json"
git init --quiet --initial-branch=main "$fixture"
git -C "$fixture" config user.email test@example.invalid
git -C "$fixture" config user.name 'Storage publishing test'
git -C "$fixture" add .
git -C "$fixture" commit --quiet -m 'fixture source'
source_sha="$(git -C "$fixture" rev-parse HEAD)"
release_tag=storage-web-v9.8.7
git -C "$fixture" tag -a "$release_tag" "$source_sha" -m fixture
git -C "$fixture" checkout --quiet --detach "$release_tag"

archive_tree="$work/archive-tree"
mkdir -p "$archive_tree/assets"
cat >"$archive_tree/index.html" <<'EOF'
<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="__TELECRYPT_DEPLOYMENT_CSP__"></head><body><script src="/assets/app-ABCDEF0123456789.js"></script></body></html>
EOF
cat >"$archive_tree/_headers" <<'EOF'
/*
  Content-Security-Policy: __TELECRYPT_DEPLOYMENT_CSP__
  X-Frame-Options: DENY
EOF
printf '{"serverName":"__SERVER_NAME__"}\n' >"$archive_tree/config.json"
printf 'storage.telecrypt.io\n' >"$archive_tree/CNAME"
printf 'console.log("hashed");\n' >"$archive_tree/assets/app-ABCDEF0123456789.js"
printf '<svg></svg>\n' >"$archive_tree/favicon.svg"
archive="$work/storage-web-9.8.7.pages.zip"
(cd "$archive_tree" && zip -q -r "$archive" .)

fake_bin="$work/bin"
object_root="$work/objects"
mkdir -p "$fake_bin" "$object_root"
cat >"$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == api ]]; then
  printf 'api\n' >>"$FAKE_GH_LOG"
  size="$(wc -c <"$FAKE_ARCHIVE")"
  digest="sha256:$(sha256sum "$FAKE_ARCHIVE" | cut -d' ' -f1)"
  jq -n --arg tag "$FAKE_RELEASE_TAG" --arg sha "$FAKE_RELEASE_SHA" \
    --arg asset "storage-web-${FAKE_RELEASE_TAG#storage-web-v}.pages.zip" \
    --arg digest "$digest" --argjson size "$size" \
    '{id:23,tag_name:$tag,target_commitish:$sha,draft:false,prerelease:false,
      immutable:true,assets:[{name:$asset,state:"uploaded",size:$size,digest:$digest}]}'
  exit 0
fi
if [[ "${1:-}" == release && "${2:-}" == download ]]; then
  printf 'download\n' >>"$FAKE_GH_LOG"
  destination=''
  pattern=''
  while (($#)); do
    case "$1" in
      --dir) destination="$2"; shift 2;;
      --pattern) pattern="$2"; shift 2;;
      *) shift;;
    esac
  done
  mkdir -p "$destination"
  cp "$FAKE_ARCHIVE" "$destination/$pattern"
  exit 0
fi
exit 1
EOF
cat >"$fake_bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == s3 && "${2:-}" == cp ]]; then
  shift 2
  local_file="$1"
  destination="$2"
  shift 2
  cache=''
  metadata=''
  content_type=''
  endpoint=''
  region=''
  while (($#)); do
    case "$1" in
      --cache-control) cache="$2"; shift 2;;
      --metadata) metadata="$2"; shift 2;;
      --content-type) content_type="$2"; shift 2;;
      --endpoint-url) endpoint="$2"; shift 2;;
      --region) region="$2"; shift 2;;
      --acl) printf 'unexpected ACL option\n' >&2; exit 1;;
      --no-cli-pager) shift;;
      *) shift;;
    esac
  done
  [[ "$endpoint" == https://1tuq0.upcloudobjects.com && "$region" == europe-2 ]]
  bucket="${destination#s3://}"
  bucket="${bucket%%/*}"
  key="${destination#s3://$bucket/}"
  if [[ "${FAKE_AWS_FAIL_KEY:-}" == "$key" ]]; then
    printf 'simulated object upload failure\n' >&2
    exit 1
  fi
  mkdir -p "$FAKE_OBJECT_ROOT/$bucket/$(dirname "$key")" "$FAKE_OBJECT_ROOT/.metadata/$bucket/$(dirname "$key")"
  cp "$local_file" "$FAKE_OBJECT_ROOT/$bucket/$key"
  IFS=, read -r commit_pair ref_pair <<<"$metadata"
  jq -n --arg commit "${commit_pair#source-commit=}" \
    --arg ref "${ref_pair#source-ref=}" --arg cache "$cache" \
    --arg type "$content_type" \
    '{Metadata:{"source-commit":$commit,"source-ref":$ref},CacheControl:$cache,ContentType:$type}' \
    >"$FAKE_OBJECT_ROOT/.metadata/$bucket/$key.json"
  printf '%s\n' "$key" >>"$FAKE_UPLOAD_LOG"
  exit 0
fi
if [[ "${1:-}" == s3api && "${2:-}" == head-object ]]; then
  shift 2
  bucket=''
  key=''
  while (($#)); do
    case "$1" in
      --bucket) bucket="$2"; shift 2;;
      --key) key="$2"; shift 2;;
      --endpoint-url|--region) shift 2;;
      --no-cli-pager) shift;;
      *) shift;;
    esac
  done
  cat "$FAKE_OBJECT_ROOT/.metadata/$bucket/$key.json"
  exit 0
fi
exit 1
EOF
cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url=''
output=''
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2;;
    --retry|--connect-timeout|--max-time|--proto|--proto-redir) shift 2;;
    --fail|--silent|--show-error|--location|--retry-all-errors) shift;;
    https://*) url="$1"; shift;;
    *) shift;;
  esac
done
[[ "$url" == https://storage.stage.telecrypt.io/* || "$url" == https://storage.telecrypt.io/* ]]
key="${url#https://storage.stage.telecrypt.io/}"
if [[ "$key" == "$url" ]]; then key="${url#https://storage.telecrypt.io/}"; bucket=telecrypt-storage-prod; else bucket=telecrypt-storage-stage; fi
cp "$FAKE_OBJECT_ROOT/$bucket/$key" "$output"
printf '%s\n' "$url" >>"$FAKE_CURL_LOG"
EOF
chmod +x "$fake_bin/gh" "$fake_bin/aws" "$fake_bin/curl"

export PATH="$fake_bin:$PATH"
export FAKE_OBJECT_ROOT="$object_root"
export FAKE_RELEASE_TAG="$release_tag"
export FAKE_RELEASE_SHA="$source_sha"
export FAKE_ARCHIVE="$archive"
export FAKE_UPLOAD_LOG="$work/uploads.log"
export FAKE_CURL_LOG="$work/curl.log"
export FAKE_GH_LOG="$work/gh.log"
export GITHUB_REPOSITORY=TeleCrypt-io/storage

publish_env=()
publish_release() {
  env "${publish_env[@]}" bash "$root/scripts/publish-storage-release.sh" \
    stage release "$release_tag" "$source_sha" "$release_tag" "$fixture"
}

branch_fixture="$work/branch-source"
git clone --quiet --no-hardlinks "$fixture" "$branch_fixture"
git -C "$branch_fixture" tag -d "$release_tag" >/dev/null
test -z "$(git -C "$branch_fixture" tag)"
mkdir -p "$branch_fixture/dist"
cp -a "$archive_tree/." "$branch_fixture/dist/"

publish_branch() {
  env "${publish_env[@]}" bash "$root/scripts/publish-storage-release.sh" \
    stage branch '' "$source_sha" stage "$branch_fixture"
}

publish_env=(FAKE_AWS_FAIL_KEY=index.html)
assert_failure publish_release
publish_env=()
test ! -e "$object_root/telecrypt-storage-stage/index.html"
test "$(tail -n 1 "$FAKE_UPLOAD_LOG")" != index.html

: >"$FAKE_UPLOAD_LOG"
: >"$FAKE_CURL_LOG"
: >"$FAKE_GH_LOG"
publish_release
test "$(tail -n 1 "$FAKE_UPLOAD_LOG")" = index.html
first_upload="$(head -n 1 "$FAKE_UPLOAD_LOG")"
[[ "$first_upload" == assets/* ]]
if grep -Fxq CNAME "$FAKE_UPLOAD_LOG"; then fail 'CNAME was uploaded'; fi
if grep -Fxq _headers "$FAKE_UPLOAD_LOG"; then fail '_headers was uploaded'; fi
test "$(wc -l <"$FAKE_CURL_LOG")" -eq "$(wc -l <"$FAKE_UPLOAD_LOG")"
jq -e --arg sha "$source_sha" \
  '.Metadata["source-commit"]==$sha and .Metadata["source-ref"]=="storage-web-v9.8.7" and .CacheControl=="no-cache" and .ContentType=="text/html"' \
  "$object_root/.metadata/telecrypt-storage-stage/index.html.json" >/dev/null
jq -e '.CacheControl=="public, max-age=31536000, immutable"' \
  "$object_root/.metadata/telecrypt-storage-stage/assets/app-ABCDEF0123456789.js.json" >/dev/null
jq -e '.CacheControl=="no-cache" and .ContentType=="application/json"' \
  "$object_root/.metadata/telecrypt-storage-stage/config.json.json" >/dev/null

bad_archive_tree="$work/bad-archive-tree"
mkdir -p "$bad_archive_tree/assets"
printf '<html>bad</html>\n' >"$bad_archive_tree/index.html"
printf 'Content-Security-Policy: __TELECRYPT_DEPLOYMENT_CSP__\n' >"$bad_archive_tree/_headers"
printf '{"serverName":"__SERVER_NAME__"}\n' >"$bad_archive_tree/config.json"
printf 'storage.telecrypt.io\n' >"$bad_archive_tree/CNAME"
printf 'bad\n' >"$bad_archive_tree/assets/app-ABCDEF0123456789.js"
bad_archive="$work/bad.pages.zip"
(cd "$bad_archive_tree" && zip -q -r "$bad_archive" .)
: >"$FAKE_UPLOAD_LOG"
FAKE_ARCHIVE="$bad_archive"
export FAKE_ARCHIVE
assert_failure publish_release
test ! -s "$FAKE_UPLOAD_LOG"
FAKE_ARCHIVE="$archive"
export FAKE_ARCHIVE

# A branch build publishes its exact built dist and does not need a release tag or API call.
: >"$FAKE_GH_LOG"
: >"$FAKE_UPLOAD_LOG"
: >"$FAKE_CURL_LOG"
publish_branch
test ! -s "$FAKE_GH_LOG"
jq -e --arg sha "$source_sha" \
  '.Metadata["source-commit"]==$sha and .Metadata["source-ref"]=="stage"' \
  "$object_root/.metadata/telecrypt-storage-stage/index.html.json" >/dev/null

# The same release archive maps to Production's bucket, identity, and public host.
: >"$FAKE_GH_LOG"
: >"$FAKE_UPLOAD_LOG"
: >"$FAKE_CURL_LOG"
env FAKE_RELEASE_TAG="$release_tag" FAKE_RELEASE_SHA="$source_sha" FAKE_ARCHIVE="$archive" \
  bash "$root/scripts/publish-storage-release.sh" \
    production release "$release_tag" "$source_sha" "$release_tag" "$fixture"
test "$(tail -n 1 "$FAKE_UPLOAD_LOG")" = index.html
test "$(head -n 1 "$FAKE_CURL_LOG")" = https://storage.telecrypt.io/assets/app-ABCDEF0123456789.js
test "$(jq -r '.serverName' "$object_root/telecrypt-storage-prod/config.json")" = telecrypt.io

printf 'storage deployment checks passed\n'
