#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: package-pages.sh DIST_DIR OUTPUT_ZIP SOURCE_DATE_EPOCH" >&2
  exit 2
fi

dist_dir="$1"
output_zip="$2"
source_date_epoch="$3"
[[ -d "$dist_dir" && "$source_date_epoch" =~ ^[0-9]+$ ]]
for required in index.html CNAME _headers config.json; do
  test -f "$dist_dir/$required"
done

mkdir -p "$(dirname "$output_zip")"
output_zip="$(cd "$(dirname "$output_zip")" && pwd -P)/$(basename "$output_zip")"
rm -f -- "$output_zip"
stage_dir="$(mktemp -d)"
trap 'rm -rf -- "$stage_dir"' EXIT
cp -a -- "$dist_dir"/. "$stage_dir"/
find "$stage_dir" -type f -exec touch -d "@${source_date_epoch}" {} +
(
  cd "$stage_dir"
  find . -type f -print | LC_ALL=C sort | zip -X -D "$output_zip" -@
)
test -s "$output_zip"
