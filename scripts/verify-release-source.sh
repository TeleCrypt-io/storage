#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag required}"
sha="${2:?release commit required}"
prefix="${3:?release tag prefix required}"
[[ -n "$prefix" ]]
case "$tag" in
  "$prefix"*) version="${tag#"$prefix"}";;
  *) printf 'release tag does not use expected prefix\n' >&2; exit 1;;
esac
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
test "$(git cat-file -t "refs/tags/$tag")" = tag
test "$(git rev-parse "refs/tags/$tag^{commit}")" = "$sha"
test "$(git rev-parse HEAD)" = "$sha"
