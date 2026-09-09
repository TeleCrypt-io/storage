# Pages deployment step

This step deploys an already-uploaded artifact through GitHub's Pages API. It uses Python's
standard library; it has no npm dependencies or build step.

The caller owns source/release verification, the Pages upload, and the `github-pages` environment.
Pass the upload's `artifact_id` as `artifact-id` and the verified source commit as `build-version`.
The job needs `pages: write` and `id-token: write`; no artifact-listing permission is needed.
`page_url` is returned only after GitHub reports successful deployment. Failures remain failures;
pending deployments are cancelled on an interrupted or failed wait, with cancellation errors
reported alongside the original error.

Other repositories use an exact immutable `pages-deploy-vX.Y.Z` release of this repository.
That source-only release does not build or deploy the Storage application.

Run the offline API contract checks with `python3 scripts/test-deploy-pages.py` from the repository
root. These checks do not establish a successful live deployment.
