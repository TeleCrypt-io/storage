#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 6 ]]; then
  printf 'usage: publish-storage-release.sh ENVIRONMENT SOURCE_KIND RELEASE_TAG SOURCE_SHA SOURCE_REF SOURCE_CHECKOUT\n' >&2
  exit 2
fi

environment="$1"
source_kind="$2"
release_tag="$3"
expected_sha="$4"
source_ref="$5"
source_checkout="$(cd -- "$6" && pwd -P)"
publisher_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

case "$environment" in
  stage)
    bucket=telecrypt-storage-stage
    server_name=stage.telecrypt.io
    public_host=storage.stage.telecrypt.io
    ;;
  production)
    bucket=telecrypt-storage-prod
    server_name=telecrypt.io
    public_host=storage.telecrypt.io
    ;;
  *) printf 'environment must be stage or production\n' >&2; exit 2;;
esac

[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]
source_sha="$(git -C "$source_checkout" rev-parse HEAD)"
test "$source_sha" = "$expected_sha"
case "$source_kind" in
  branch)
    test "$environment" = stage
    test -z "$release_tag"
    test "$source_ref" = stage
    ;;
  release)
    case "$release_tag" in
      storage-web-v*) test "$source_ref" = "$release_tag" ;;
      *) printf 'release source requires a storage-web tag\n' >&2; exit 2;;
    esac
    ;;
  *) printf 'source kind must be branch or release\n' >&2; exit 2;;
esac

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
release_dir="$work/release"
dist="$work/dist"

mkdir -- "$dist"
if [[ "$source_kind" == branch ]]; then
  cp -a -- "$source_checkout/dist/." "$dist/"
else
  bash "$publisher_root/scripts/download-release.sh" \
    "$release_tag" "$source_sha" "$release_dir" "$source_checkout"
  archive="$release_dir/storage-web-${release_tag#storage-web-v}.pages.zip"
  unzip -q "$archive" -d "$dist"
fi
node "$source_checkout/scripts/render-deployment.mjs" "$dist" "$server_name"

test "$(jq -er '.serverName' "$dist/config.json")" = "$server_name"
for file in index.html _headers config.json; do
  if grep -Eq '__SERVER_NAME__|__TELECRYPT_' "$dist/$file"; then
    printf 'deployment placeholder remains in %s\n' "$file" >&2
    exit 1
  fi
done
public_assets_origin="$(jq -er '.origin' "$source_checkout/public-assets.json")"
for file in index.html _headers; do
  grep -Fq "connect-src 'self' https:" "$dist/$file"
  grep -Fq "$public_assets_origin" "$dist/$file"
done
grep -Fq 'Content-Security-Policy' "$dist/index.html"
grep -Eq "Content-Security-Policy: .*frame-ancestors 'none'" "$dist/_headers"
test "$(<"$dist/CNAME")" = "storage.$server_name"

endpoint=https://1tuq0.upcloudobjects.com
region=europe-2
base="s3://$bucket"
public_url="https://$public_host"
metadata="source-commit=$source_sha,source-ref=$source_ref"
immutable_cache='public, max-age=31536000, immutable'
no_cache='no-cache'

files=()
while IFS= read -r -d '' file; do
  files+=("${file#"$dist/"}")
done < <(find "$dist" -type f -print0 | LC_ALL=C sort -z)

hashed_assets=()
other_files=()
for file in "${files[@]}"; do
  case "$file" in
    CNAME|_headers) continue ;;
    index.html) continue ;;
  esac
  if [[ "$file" =~ ^assets/.+-[A-Za-z0-9_-]{8,}\.[^/]+$ ]]; then
    hashed_assets+=("$file")
  else
    other_files+=("$file")
  fi
done

upload() {
  local file="$1" cache_control="$2"
  local -a options=(
    --endpoint-url "$endpoint"
    --region "$region"
    --cache-control "$cache_control"
    --no-cli-pager
  )
  if [[ "$file" == index.html ]]; then
    options+=(--content-type text/html --metadata "$metadata")
  elif [[ "$file" == config.json ]]; then
    options+=(--content-type application/json)
  elif [[ "$file" == *.wasm ]]; then
    options+=(--content-type application/wasm)
  fi
  aws s3 cp "$dist/$file" "$base/$file" "${options[@]}"
}

for file in "${hashed_assets[@]}"; do
  upload "$file" "$immutable_cache"
done
for file in "${other_files[@]}"; do
  upload "$file" "$no_cache"
done
upload index.html "$no_cache"

index_metadata="$work/index-metadata.json"
aws s3api head-object \
  --bucket "$bucket" --key index.html \
  --endpoint-url "$endpoint" --region "$region" \
  --no-cli-pager >"$index_metadata"
jq -e --arg sha "$source_sha" --arg ref "$source_ref" \
  '.Metadata["source-commit"]==$sha and .Metadata["source-ref"]==$ref' \
  "$index_metadata" >/dev/null

for file in "${hashed_assets[@]}" "${other_files[@]}" index.html; do
  downloaded="$work/public-object"
  curl --fail --silent --show-error --location \
    --retry 3 --retry-all-errors --connect-timeout 10 --max-time 60 \
    --proto '=https' --proto-redir '=https' \
    "$public_url/$file" --output "$downloaded"
  cmp -- "$dist/$file" "$downloaded"
done

printf 'Published %s from %s to %s (%s)\n' \
  "${release_tag:-stage source}" "$source_sha" "$environment" "$public_url"
