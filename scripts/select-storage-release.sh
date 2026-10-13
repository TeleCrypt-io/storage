#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 5 ]]; then
  printf 'usage: select-storage-release.sh EVENT_NAME GITHUB_REF GITHUB_SHA ENVIRONMENT RELEASE_TAG\n' >&2
  exit 2
fi

event_name="$1"
github_ref="$2"
github_sha="$3"
environment="$4"
release_tag="$5"

case "$environment" in
  stage|production) ;;
  *) printf 'environment must be stage or production\n' >&2; exit 2;;
esac

case "$event_name" in
  push)
    test "$environment" = stage
    test "$github_ref" = refs/heads/stage
    test -z "$release_tag"
    test "$(git rev-parse HEAD)" = "$github_sha"
    selected_sha="$github_sha"
    source_ref="$selected_sha"
    source_kind=branch
    metadata_source_ref=stage
    ;;
  workflow_dispatch)
    test "$github_ref" = refs/heads/main
    if [[ "$environment" == production && -z "$release_tag" ]]; then
      printf 'Production deployment requires release_tag\n' >&2
      exit 2
    fi
    if [[ -n "$release_tag" ]]; then
      case "$release_tag" in
        storage-web-v*) version="${release_tag#storage-web-v}" ;;
        *) printf 'release_tag must use storage-web-vX.Y.Z\n' >&2; exit 2;;
      esac
      [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
      tag_ref="refs/tags/$release_tag"
      test "$(git cat-file -t "$tag_ref")" = tag
      selected_sha="$(git rev-parse "$tag_ref^{commit}")"
      source_ref="$release_tag"
      source_kind=release
      metadata_source_ref="$release_tag"
    else
      # Fetch the branch once, then pin all later work to the fetched commit.
      git fetch --no-tags origin refs/heads/stage >/dev/null
      selected_sha="$(git rev-parse 'FETCH_HEAD^{commit}')"
      source_ref="$selected_sha"
      source_kind=branch
      metadata_source_ref=stage
    fi
    ;;
  *)
    printf 'unsupported event: %s\n' "$event_name" >&2
    exit 2
    ;;
esac

printf 'tag=%s\nsource_sha=%s\nsource_ref=%s\nsource_kind=%s\nmetadata_source_ref=%s\n' \
  "$release_tag" "$selected_sha" "$source_ref" "$source_kind" \
  "$metadata_source_ref"
