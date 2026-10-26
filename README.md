# TeleCrypt Storage

The TeleCrypt encrypted-storage web application. The browser client uses the public
[`@telecrypt-io/storage`](https://github.com/TeleCrypt-io/storage-sdk) SDK; the companion command-line
client and its user guide live in [`cli/`](./cli/).

See [`LICENSE`](./LICENSE) for licensing.

Storage Web development supports Node.js `>=24.22.1`; release tooling pins Node.js `24.22.1` and
npm `11.19.0`.

Storage discovers its OAuth issuer and endpoints from Matrix auth metadata. The issuer may be
hosted separately from the homeserver; login and token refresh use those advertised endpoints while
binding the browser session to the discovered issuer. Logout uses the advertised revocation endpoint
when present and falls back to the trusted homeserver's Matrix logout endpoint when it is omitted.
If Matrix rejects the access token as unknown, Web refreshes through the discovered issuer's token
endpoint and retries; local session state remains until logout is confirmed.

The `Deploy Storage Web` workflow publishes Storage to UpCloud Object Storage.
Pushes to `stage` build and publish that exact commit. Manual dispatches run from `main`; Stage
defaults to the current `stage` head, while Production requires a `storage-web-vX.Y.Z` release tag.
When a release tag is supplied, the workflow publishes its verified `.pages.zip` archive without
building it again.
