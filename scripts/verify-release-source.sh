#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag required}"
sha="${2:?release commit required}"
prefix="${3:?release tag prefix required}"
source_checkout="${4:-.}"
[[ -n "$prefix" ]]
case "$tag" in
  "$prefix"*) version="${tag#"$prefix"}";;
  *) printf 'release tag does not use expected prefix\n' >&2; exit 1;;
esac
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
test "$(git -C "$source_checkout" cat-file -t "refs/tags/$tag")" = tag
test "$(git -C "$source_checkout" rev-parse "refs/tags/$tag^{commit}")" = "$sha"
test "$(git -C "$source_checkout" rev-parse HEAD)" = "$sha"
