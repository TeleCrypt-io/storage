#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: package-pages.sh DIST_DIR OUTPUT_ZIP SOURCE_DATE_EPOCH" >&2
  exit 2
fi
for tool in python3 zip stat find touch; do
  command -v "$tool" >/dev/null || {
    echo "Pages package requires $tool" >&2
    exit 1
  }
done

dist_dir="$1"
output_zip="$2"
source_date_epoch="$3"
[[ -d "$dist_dir" && "$source_date_epoch" =~ ^[0-9]+$ && "$source_date_epoch" -le 4102444800 ]] || {
  echo "Pages package inputs are invalid" >&2
  exit 1
}
[[ ! -e "$output_zip" && ! -e "$output_zip.partial" ]] || {
  echo "Pages package output already exists" >&2
  exit 1
}
mkdir -p "$(dirname "$output_zip")"
output_dir="$(cd "$(dirname "$output_zip")" && pwd -P)"
output_zip="$output_dir/$(basename "$output_zip")"
partial_zip="$output_zip.partial"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
dist_dir="$(cd "$dist_dir" && pwd -P)"
[[ "$output_zip" != "$dist_dir"/* ]] || {
  echo "Pages package output must not be inside the source tree" >&2
  exit 1
}
read -r max_archive_bytes max_member_count max_member_path_bytes max_member_uncompressed_bytes max_total_uncompressed_bytes < <(python3 -c 'import json,sys; limits=json.load(open(sys.argv[1], encoding="utf-8")); print(*(limits[key] for key in ("max_archive_bytes", "max_member_count", "max_member_path_bytes", "max_member_uncompressed_bytes", "max_total_uncompressed_bytes")))' "$script_dir/pages-package-limits.json")
[[ "$max_archive_bytes" =~ ^[1-9][0-9]*$ && "$max_member_count" =~ ^[1-9][0-9]*$ && "$max_member_path_bytes" =~ ^[1-9][0-9]*$ && "$max_member_uncompressed_bytes" =~ ^[1-9][0-9]*$ && "$max_total_uncompressed_bytes" =~ ^[1-9][0-9]*$ ]]

if test -n "$(find -P "$dist_dir" \( -type l -o \( ! -type f ! -type d \) \) -print -quit)"; then
  echo "Pages tree contains a symlink or non-regular entry" >&2
  exit 1
fi
member_count=0
total_uncompressed=0
while IFS= read -r -d '' path; do
  relative="${path#"$dist_dir"/}"
  case "$relative" in
    /*|*\\*|*$'\n'*|*$'\r'*)
      echo "Pages tree contains an abnormal path" >&2
      exit 1
      ;;
  esac
  path_bytes="$(printf '%s' "$relative" | wc -c)"
  [[ "$path_bytes" =~ ^[0-9]+$ && "$path_bytes" -le "$max_member_path_bytes" ]] || {
    echo "Pages tree member name exceeds the byte limit" >&2
    exit 1
  }
  IFS=/ read -r -a parts <<<"$relative"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != "." && "$part" != ".." ]] || {
      echo "Pages tree contains a non-canonical path" >&2
      exit 1
    }
  done
  member_count=$((member_count + 1))
  member_size="$(stat -c '%s' -- "$path")"
  [[ "$member_size" =~ ^[0-9]+$ && "$member_size" -le "$max_member_uncompressed_bytes" ]] || {
    echo "Pages tree member exceeds the uncompressed size limit" >&2
    exit 1
  }
  total_uncompressed=$((total_uncompressed + member_size))
  [[ "$member_count" -le "$max_member_count" && "$total_uncompressed" -le "$max_total_uncompressed_bytes" ]] || {
    echo "Pages tree exceeds its count or aggregate size limit" >&2
    exit 1
  }
done < <(find -P "$dist_dir" -type f -print0)

stage_dir="$(mktemp -d)"
manifest="$(mktemp)"
cleanup() {
  local status=$? cleanup_status=0 removal_status
  rm -rf -- "$stage_dir" || cleanup_status=$?
  if rm -f -- "$manifest"; then
    removal_status=0
  else
    removal_status=$?
    if test "$cleanup_status" -eq 0; then cleanup_status="$removal_status"; fi
  fi
  if test "$status" -eq 0 && test "$cleanup_status" -ne 0; then
    printf 'Pages package cleanup failed (status %s)\n' "$cleanup_status" >&2
    status="$cleanup_status"
  fi
  exit "$status"
}
trap cleanup EXIT
cp -a --reflink=auto -- "$dist_dir"/. "$stage_dir"/
find -P "$stage_dir" -type f -exec touch -d "@${source_date_epoch}" {} +

(
  cd "$stage_dir"
  find . -type f -print | LC_ALL=C sort >"$manifest"
)
(cd "$stage_dir" && timeout --signal=TERM --kill-after=5s 300s zip -X -D "$partial_zip" -@ <"$manifest")
test -s "$partial_zip"
test "$(wc -c <"$partial_zip")" -le "$max_archive_bytes"
python3 "$script_dir/validate-pages-archive.py" "$partial_zip"
mv "$partial_zip" "$output_zip"
