# TeleCrypt Storage

The TeleCrypt encrypted-storage web application. The browser client uses the public
[`@telecrypt-io/storage`](https://github.com/TeleCrypt-io/storage-sdk) SDK; the companion command-line
client and its user guide live in [`cli/`](./cli/).

See [`LICENSE`](./LICENSE) for licensing.

## Deployment rendering

The Web bundle is environment-neutral. At deployment time, render the selected private Matrix
server name into the built files without rebuilding the JavaScript:

```sh
node scripts/render-deployment.mjs dist "$SERVER_NAME"
```

The renderer writes the same `config.json`, CSP meta tag, Cloudflare `_headers`, and `CNAME`
from `SERVER_NAME`. It derives `backend.<SERVER_NAME>`, `storage.<SERVER_NAME>`, and the public
asset origin together, so a release can be reused by multiple environments. The deployment must
run this step before `scripts/package-pages.sh` or Pages upload.
