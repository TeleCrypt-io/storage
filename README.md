# storage.telecrypt.io

The static React/Vite site served at [storage.telecrypt.io](https://storage.telecrypt.io).
Current TeleCrypt project facts and product decisions are maintained only in the canonical
[`llms.txt`](https://www.telecrypt.io/llms.txt); this README documents this website implementation.
It consumes the browser SDK version pinned in `package.json` and `package-lock.json`, installed
with `npm ci`. The command-line client is maintained in the isolated [`cli/`](./cli/) package.

## Source boundaries

- [`storage-sdk`](https://github.com/TeleCrypt-io/storage-sdk) owns the library source and package releases.
- [`cli/`](./cli/) owns the command-line client, its tests, and its exact GitHub Release archive.
- This repository owns the static website, its UI tests, and the workflows for both isolated packages.

The Web and CLI packages have separate `package.json` and lockfiles. Run each package's checks from
its directory; root Web commands never discover or lint CLI source.

## Security boundaries

The web client uses MAS/OIDC authorization-code + PKCE only; it never collects or sends a Matrix
login password. The Vite build generates the CSP meta policy in `index.html` and the `_headers` file
used by Cloudflare Pages from one policy definition. Vite relaxes only `connect-src` for its
development server so the disposable localhost MAS/Synapse fixture remains usable. The page hostname is validated before the UI renders
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

The Cloudflare Pages Git integration builds only the `stage` branch. That branch is advanced only to
a commit that has already passed the repository checks and is identified by a published immutable
`storage-web-v*` release; the Cloudflare deployment record must resolve to that same commit. A branch
name alone is never sufficient deployment evidence. Cloudflare Pages stage must emit exactly one response
`Content-Security-Policy` header containing the full site policy plus `frame-ancestors 'none'`, and
exactly one `X-Frame-Options: DENY` header on every response. This is a stage acceptance requirement;
GitHub Pages production cannot emit response headers and uses the generated HTML meta policy as its
browser baseline. The generated `dist/_headers` file records the stage contract.

## Shared product assets

Storage loads the shared product stylesheet, logo and favicon from the canonical public website:

- [Product stylesheet](https://www.telecrypt.io/ui/product.css)
- [Logo](https://www.telecrypt.io/logo-mark.png)
- [Favicon](https://www.telecrypt.io/favicon-32x32.png)

These stable URLs are deliberately shared with Controlplane’s Plan page. The landing website keeps
its own independent design. Shared asset changes take effect as browsers and the public edge refresh
their normal caches, so the Storage and Plan applications should be checked together after a style
change. Application releases remain self-contained for their code and backend behavior.

## Development and checks

```
npm ci --ignore-scripts --no-fund --no-audit
npm run dev       # http://localhost:5173
npm run lint
npm test          # component/wiring tests; no browser Harness execution in CI
npm run build
```

The CLI has its own checks:

```
cd cli
npm ci --ignore-scripts --no-fund --no-audit
npm run lint
npm run test:unit
npm run build
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

Pushes and pull requests to `main` only verify the source. An annotated
`storage-web-v<major>.<minor>.<patch>` tag runs the release workflow; it checks the tag commit and
package version, installs dependencies, runs tests and lint, builds the site, and publishes one immutable
Release archive. An owner-authorized production promotion dispatches the workflow at that exact tag,
rebuilds the tagged source, verifies the published archive's GitHub digest and size, and deploys those
archive bytes through GitHub's Pages upload and deploy actions. The workflow does not edit an existing
Release. The source is environment-neutral, and
the browser derives its backend from the canonical site hostname. VM activation and acceptance follow
the operator-managed Harness deployment contract.

An annotated `storage-cli-v<major>.<minor>.<patch>` tag runs the isolated CLI release workflow. It
checks `cli/` against the tag, installs its lockfile, runs lint, unit tests, and the build, generates
the bundled dependency notice, packages one archive, and verifies the immutable GitHub Release
asset. CLI release archives are installed directly from that GitHub Release; they are not published
to the NPM registry.

## License

TeleCrypt-authored source in this repository is licensed under [BUSL-1.1](./LICENSE). Third-party
dependencies retain their own licenses.
