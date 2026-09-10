# storage.telecrypt.io

The static React/Vite site served at [storage.telecrypt.io](https://storage.telecrypt.io).
Current TeleCrypt project facts and product decisions are maintained only in the canonical
[`llms.txt`](https://telecrypt.io/llms.txt); this README documents this website implementation.
It consumes the exact published `@telecrypt-io/storage@0.5.30` browser library. The package lock
binds that dependency to the published tarball's integrity and the release workflows verify the
immutable SDK release record and package bytes before dependency installation.
Storage protocol, cryptography, and the command-line client deliberately live in their own
repositories.

## Source boundaries

- [`storage-sdk`](https://github.com/TeleCrypt-io/storage-sdk) owns the library source and package releases.
- [`storage-cli`](https://github.com/TeleCrypt-io/storage-cli) owns the command-line client.
- This repository owns only the static website, its UI tests, and its GitHub Pages deployment.

## Security boundaries

The web client uses MAS/OIDC authorization-code + PKCE only; it never collects or sends a Matrix
login password. GitHub Pages cannot set response headers, so `index.html` provides an
early CSP meta policy as a baseline. A header CSP remains required when the static site moves behind
a header-capable edge. Vite relaxes only `connect-src` for its development server so the disposable
localhost MAS/Synapse fixture remains usable. The page hostname is validated before the UI renders
and derives the canonical HTTPS TeleCrypt backend URL (`storage.telecrypt.io` maps to
`backend.telecrypt.io`; `storage.stage.telecrypt.io` maps to
`backend.stage.telecrypt.io`). The OIDC issuer
is derived from that backend origin. The same
exact compiled JS, CSS, and other application assets can therefore be served in both environments.

The browser session and Matrix device identifier are stored in tab-scoped `sessionStorage`, not
`localStorage`; a reload in the same tab can resume, while another tab must authenticate separately.
The device identifier is required when the shared refresh adapter is created, so refreshed OAuth scopes
remain bound to the Matrix device that owns the session.
If session storage is unavailable, the UI fails closed and does not open an account. The only
browser-persistent UI value is the non-secret OIDC client registration identifier.
Operation failures retain complete error, response, and nested-cause details for the UI after
credential redaction and control-character escaping; diagnostic output is not capped or replaced
with a generic message because it is large or unfamiliar.

The exact-tag workflow creates and verifies one exact published, non-prerelease immutable GitHub
Release. Before starting the workflow, verify that the active repository ruleset protects the
`storage-web-v*` tags from moving or deletion. The workflow builds and tests the site, creates or
resumes one exact draft Release, verifies its metadata and bytes, publishes it, then verifies the
public download and deploys those exact bytes to GitHub Pages production. A rerun may reproduce the
local package for comparison, but it never replaces a published asset. Any source or metadata change
fails closed and requires a new version.

The Cloudflare Pages Git integration builds only the `stage` branch. That branch is advanced only to
a commit that has already passed the repository checks and is identified by a published immutable
`storage-web-v*` release; the Cloudflare deployment record must resolve to that same commit. A branch
name alone is never sufficient deployment evidence. Cloudflare Pages stage must emit exactly one response
`Content-Security-Policy` header containing the full site policy plus `frame-ancestors 'none'`, and
exactly one `X-Frame-Options: DENY` header on every response. The checked-in `public/_headers` file
records that contract; GitHub Pages production cannot emit response headers and continues to use
the HTML meta policy as its browser baseline.

GitHub Pages release publication is separate from authenticated acceptance. The response-header
requirement is a stage-only acceptance check on the header-capable Cloudflare Pages target:
`storage.stage.telecrypt.io` must add `Content-Security-Policy: frame-ancestors 'none'` and
`X-Frame-Options: DENY`. GitHub Pages production is the documented hosting exception because it
cannot emit response headers; its HTML meta policy remains the browser baseline.

## Shared UI vendor baseline

`src/vendor/telecrypt-ui/product.css` is an exact local vendor copy of the
canonical shared UI stylesheet. `src/theme.css` imports it directly, keeping
this repository self-contained without a runtime package dependency. The
vendor `PROVENANCE.json` records only the exact `TeleCrypt-io/ui-shared-css` source, release,
commit, source path, and content hash.

## Development and checks

```
npm ci --ignore-scripts --no-fund --no-audit
npm run dev       # http://localhost:5173
npm run lint
npm test          # component/wiring tests; no browser Harness execution in CI
npm run typecheck
npm run verify:security
npm run verify:archive
npm run build
npm run verify:package
```

Browser acceptance tooling is operator-local Harness work, never a GitHub Actions job. Its real
browser suite expects the shared disposable Synapse/MAS fixture to be running on localhost before
`npm run e2e`; this repository does not carry or duplicate that fixture. Component tests may mock
the SDK boundary for isolated UI behavior, but they do not replace the real-stack e2e suite. The
same Podman fixture is shared with the SDK and CLI functional tests.

If setup or tests report an error or issue, preserve the fixture and diagnostics; do not tear them
down before the private Harness investigation is complete. The fixture workflow here does not provide
that procedure; follow the [Harness operator workflow](https://github.com/TeleCrypt-io/Harness/blob/main/docs/release.md#required-stage-first-sequence)
for the canonical ordering and stopping boundary.

## Releases and deployment

Pushes and pull requests to `main` only verify the source. A protected annotated
`storage-web-v<major>.<minor>.<patch>` tag runs the exact-version release workflow; it checks the
tag/source/main/package identity, installs dependencies, runs tests/lint/typecheck/build, and
creates the single immutable Release archive. GitHub Pages deployment occurs only after the
published Release is rechecked and its archive bytes match the Release API digest. Cloudflare Pages
stage builds the same released commit from `stage`, with previews disabled; its deployment record is
accepted only when its source commit matches the immutable Release. The source is environment-neutral,
and the browser derives its backend from the canonical site hostname. VM activation, promotion, and
authenticated acceptance follow the operator-managed Harness deployment contract; this repository
does not publish or duplicate those private operational steps.

## License

TeleCrypt-authored source in this repository is licensed under [BUSL-1.1](./LICENSE). Third-party
dependencies retain their own licenses.
