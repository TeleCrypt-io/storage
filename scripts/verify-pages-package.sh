#!/usr/bin/env bash
set -euo pipefail

temporary_dir="$(mktemp -d)"
cleanup() {
  local status=$? cleanup_status=0
  rm -rf -- "$temporary_dir" || cleanup_status=$?
  if test "$status" -eq 0 && test "$cleanup_status" -ne 0; then
    printf 'Pages package verification cleanup failed (status %s)\n' "$cleanup_status" >&2
    status="$cleanup_status"
  fi
  exit "$status"
}
trap cleanup EXIT
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_dir="$(cd "$script_dir/.." && pwd -P)"
find -P "$repo_dir/dist" -type f -printf '%p\t%T@\n' | LC_ALL=C sort >"$temporary_dir/source-before"
bash "$script_dir/package-pages.sh" "$repo_dir/dist" "$temporary_dir/pages.zip" 1
find -P "$repo_dir/dist" -type f -printf '%p\t%T@\n' | LC_ALL=C sort >"$temporary_dir/source-after"
cmp -s "$temporary_dir/source-before" "$temporary_dir/source-after"
bash "$script_dir/package-pages.sh" "$repo_dir/dist" "$temporary_dir/pages-second.zip" 1
cmp -s "$temporary_dir/pages.zip" "$temporary_dir/pages-second.zip"
python3 "$script_dir/validate-pages-archive.py" "$temporary_dir/pages.zip"
