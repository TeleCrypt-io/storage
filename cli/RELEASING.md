# Releasing

Update `cli/package.json` and `cli/package-lock.json`, then push an annotated
`storage-cli-vX.Y.Z` tag for that commit. The workflow checks the tag and version, installs the
locked dependencies, runs lint, unit tests, and the build, generates the bundled dependency notice,
packages the CLI once, and attaches that archive to the GitHub Release.

The tag points at the merged repository commit. The CLI workflow runs package commands with `cli/`
as its working directory and uses the shared release verification helpers in `scripts/` plus the
CLI-specific packaging helper in `cli/scripts/`.

Harness acceptance downloads that archive and checks its GitHub Release digest before running the
CLI against Stage. A failed release run should be inspected before retrying; published Releases are
immutable, so corrections use a new version and tag.
