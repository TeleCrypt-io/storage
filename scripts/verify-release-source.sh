#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag required}"
sha="${2:?release commit required}"
[[ "$tag" =~ ^storage-web-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
test "$(git cat-file -t "refs/tags/$tag")" = tag
test "$(git rev-parse "refs/tags/$tag^{commit}")" = "$sha"
test "$(git rev-parse HEAD)" = "$sha"
