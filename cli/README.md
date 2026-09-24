# TeleCrypt.io Storage CLI

The command-line interface for TeleCrypt.io end-to-end encrypted Matrix storage.

Current TeleCrypt project facts and product decisions are maintained in the canonical
[`www.telecrypt.io/llms.txt`](https://www.telecrypt.io/llms.txt); this README documents the CLI commands.

This package is maintained in the [`storage`](https://github.com/TeleCrypt-io/storage)
repository under `cli/`. It has an independent lockfile and release workflow so CLI checks and
release archives remain isolated from the Web package at the repository root.

The CLI runs on Linux and requires Node.js `>=24.20.0`; release tooling verifies that exact Node.js
version and the bundled npm `11.19.0`.

It consumes one exact public `@telecrypt-io/storage` library version and provides the
`telecrypt-io storage` command group: login, mandatory Decryption Key Safe setup or restoration,
shared vaults and nested folders, and file
upload, download, rename, and deletion.

**Distribution:** the standalone CLI is available only as an exact
[GitHub Release](https://github.com/TeleCrypt-io/storage/releases), never from the NPM registry.

## Install

```bash
npm install -g --ignore-scripts https://github.com/TeleCrypt-io/storage/releases/download/storage-cli-vX.Y.Z/storage-cli-vX.Y.Z.tgz
```

Replace `X.Y.Z` with an existing release version. `npm` is used only as the Node installer: the
archive and its bundled runtime dependencies are fetched from GitHub, not from the NPM registry.
This installs the `telecrypt-io` executable. The library source is in
[`TeleCrypt-io/storage-sdk`](https://github.com/TeleCrypt-io/storage-sdk).

## Usage

The CLI supports MAS/OIDC device authorization only; it never sends a Matrix login password.
The Decryption Key Safe must be set up and its Recovery Key preserved before using Storage. A new
client login to an existing account must restore the Safe first. See the [canonical CLI reference](./CLI.md)
for commands, profile handling, JSON output, sharing, file operations, and Safe setup/restoration.

See [CLI.md](./CLI.md) for the full command reference.

## Licence

The packaged release contains the [Business Source License 1.1](./LICENSE). In the source
repository, the authoritative copy is the [root license](../LICENSE). Non-commercial use is
permitted; it converts to Apache License 2.0 on 2030-07-20.

For commercial licensing, contact TeleCrypt.io.

## Third-party notices

The CLI bundles exact runtime dependencies. Each release archive includes a generated
`THIRD-PARTY-LICENSES.txt` inventory from the lockfile. Before packing, the release workflow checks
that each bundled package has one license file in the installed dependencies; use the copy inside
the archive as the authoritative dependency notice.
