import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Offline behavioral checks for the Pages Release state machine.  The fixtures
// below cover the remote outcomes that must be distinguished before mutation.
const workflow = readFileSync(".github/workflows/release-ui.yml", "utf8");
const verify = readFileSync(".github/workflows/verify.yml", "utf8");
const sharedUiRelease = readFileSync("scripts/verify-shared-ui-release.sh", "utf8");
const captureDiagnostics = readFileSync("scripts/capture-diagnostics.sh", "utf8");
const pagesPackage = readFileSync("scripts/package-pages.sh", "utf8");
const archiveTests = readFileSync("scripts/test-validate-pages-archive.py", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

function captureBody(text, name, closingIndent) {
  const start = text.indexOf(`${name}() {`);
  if (start < 0) return "";
  const end = text.indexOf(`\n${closingIndent}}`, start);
  return text.slice(start, end < 0 ? text.length : end);
}

for (const [name, body] of [
  ["capture_gh", captureBody(workflow, "capture_gh", "          ")],
  ["capture_command", captureBody(sharedUiRelease, "capture_command", "")],
]) {
  if (!/finish_capture "\$status" (?:true|false) "\$(?:output|stdout_path)" "\$(?:error|stderr_path)"/.test(body)) {
    throw new Error(`${name} must retain stdout as data and replay complete stderr without making stderr presence a failure`);
  }
}
if (!/>"\$stdout_path" 2>"\$stderr_path"/.test(captureDiagnostics) || !/cat "\$stderr_path"/.test(captureDiagnostics)) {
  throw new Error("shared diagnostic capture must retain and replay complete stderr");
}
if ([workflow, verify].some((text) => text.includes("--loglevel=error") || text.includes("--loglevel=silent") || text.includes("--silent"))) {
  throw new Error("required npm commands must not suppress warnings or diagnostics");
}
if (workflow.split("\n").some((line) => line.includes("fetch ") && line.includes("--quiet"))) {
  throw new Error("required Git fetches must not suppress warnings or diagnostics");
}

const exactNodeVersion = "24.20.0";
const exactNpmVersion = "11.19.0";
const nodeVersion = readFileSync(".node-version", "utf8").trim();
if (nodeVersion !== exactNodeVersion || packageJson.packageManager !== `npm@${exactNpmVersion}` || packageJson.engines?.node !== `>=${exactNodeVersion}`) throw new Error("Node/npm toolchain policy is not encoded exactly");
for (const [name, text] of [["verify workflow", verify], ["release workflow", workflow]]) {
  const nodeRuntimeCheck = [`test "$(node --version)" = v${exactNodeVersion}`, `test "$(node --version)" = "v${exactNodeVersion}"`];
  const npmRuntimeCheck = [`test "$(npm --version)" = ${exactNpmVersion}`, `test "$(npm --version)" = "${exactNpmVersion}"`];
  if (!text.includes(`node-version: "${exactNodeVersion}"`) || !nodeRuntimeCheck.some((fragment) => text.includes(fragment)) || !npmRuntimeCheck.some((fragment) => text.includes(fragment))) {
    throw new Error(`${name} does not use the exact Node/npm pins`);
  }
}
if ([workflow, verify].some((text) => text.includes("22.23.2") || text.includes("10.9.8"))) throw new Error("stale Node/npm pins remain in the workflows");

function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`missing workflow job: ${name}`);
  return match[1];
}

function step(jobText, name) {
  const marker = `      - name: ${name}\n`;
  const start = jobText.indexOf(marker);
  if (start < 0) throw new Error(`missing step: ${name}`);
  const shell = jobText.indexOf("        run: |\n", start);
  if (shell < 0) throw new Error(`step has no shell: ${name}`);
  const bodyStart = shell + "        run: |\n".length;
  const end = jobText.indexOf("\n      - ", bodyStart);
  return jobText.slice(bodyStart, end < 0 ? jobText.length : end);
}

function exactPublished(tag) {
  return {
    id: 42,
    tag_name: tag,
    name: tag,
    body: `Release ${tag}`,
    target_commitish: "a".repeat(40),
    created_at: "2026-08-24T00:00:00Z",
    published_at: "2026-08-24T00:00:01Z",
    draft: false,
    prerelease: false,
    immutable: true,
    assets: [{ id: 43, name: `storage-web-${tag.slice("storage-web-v".length)}.pages.zip`, state: "uploaded", size: 10, digest: `sha256:${"a".repeat(64) }` }],
  };
}

function publicationAction(probe, attempt, tag = "storage-web-v1.2.3") {
  if (probe === null) return "create-draft";
  if (probe.transport === "timeout" || probe.transport === "error") throw new Error("transport failure");
  if (probe.tag_name !== tag || probe.name !== tag || probe.body !== `Release ${tag}` || probe.target_commitish !== "a".repeat(40) || probe.prerelease !== false) throw new Error("identity conflict");
  if (probe.draft === true) {
    if (probe.created_at !== "2026-08-24T00:00:00Z" || probe.published_at !== null) throw new Error("draft timestamp conflict");
    if (probe.immutable !== undefined && probe.immutable !== false) throw new Error("draft immutable");
    if (!Number.isSafeInteger(probe.id) || probe.id <= 0 || !Array.isArray(probe.assets) || probe.assets.some((asset) => !Number.isSafeInteger(asset?.id) || asset.id <= 0)) throw new Error("draft identity or asset schema conflict");
    return "reuse-draft";
  }
  if (probe.draft === false) {
    if (attempt <= 1 || probe.immutable !== true || probe.created_at !== "2026-08-24T00:00:00Z" || probe.published_at !== "2026-08-24T00:00:01Z" || probe.assets?.length !== 1) throw new Error("published conflict");
    return "reuse-published";
  }
  throw new Error("unknown state");
}

function discoverRelease(pages, tag = "storage-web-v1.2.3") {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("incomplete Release list");
  const matches = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!Array.isArray(page) || page.length > 100) throw new Error("invalid Release list page");
    for (const release of page) if (release?.tag_name === tag) matches.push(release);
    if (page.length < 100) {
      if (matches.length > 1) throw new Error("duplicate Release records");
      if (matches.length === 0) return "absent";
      if (matches[0].draft === true) return "draft";
      if (matches[0].draft === false) return "published";
      throw new Error("unknown Release state");
    }
  }
  throw new Error("incomplete Release list");
}

function finalPublishRecheck(probe, tag = "storage-web-v1.2.3") {
  if (publicationAction(probe, 1, tag) !== "reuse-draft") throw new Error("final state is not a draft");
  const expectedName = `storage-web-${tag.slice("storage-web-v".length)}.pages.zip`;
  if (probe.id !== 42 || probe.assets.length !== 1 || probe.assets[0]?.id !== 43 || probe.assets[0]?.name !== expectedName || probe.assets[0]?.state !== "uploaded" || probe.assets[0]?.size !== 10 || probe.assets[0]?.digest !== `sha256:${"a".repeat(64)}`) throw new Error("final draft asset changed");
}

const tag = "storage-web-v1.2.3";
if (publicationAction(null, 1, tag) !== "create-draft") throw new Error("absence did not create a draft");
if (discoverRelease([[]], tag) !== "absent") throw new Error("empty complete Release list was not absent");
const olderReleases = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, tag_name: "storage-web-v0.0.0", draft: false }));
if (discoverRelease([olderReleases, [{ id: 101, tag_name: tag, draft: true }]], tag) !== "draft") throw new Error("older draft was not discovered");
let rejected = false;
try {
  discoverRelease([[{ id: 1, tag_name: tag, draft: true }, { id: 2, tag_name: tag, draft: false }]], tag);
} catch {
  rejected = true;
}
if (!rejected) throw new Error("duplicate Release records were accepted");
if (discoverRelease([[{ id: 1, tag_name: tag, draft: false }]], tag) !== "published") throw new Error("published Release was not discovered");
rejected = false;
try {
  discoverRelease(Array.from({ length: 2 }, () => olderReleases), tag);
} catch {
  rejected = true;
}
if (!rejected) throw new Error("Release list without a terminal page was accepted");
if (publicationAction({ id: 42, tag_name: tag, name: tag, body: `Release ${tag}`, target_commitish: "a".repeat(40), created_at: "2026-08-24T00:00:00Z", published_at: null, draft: true, prerelease: false, assets: [] }, 1, tag) !== "reuse-draft") throw new Error("draft was not reusable");
if (publicationAction(exactPublished(tag), 2, tag) !== "reuse-published") throw new Error("exact rerun was not reusable");
const exactDraft = { id: 42, tag_name: tag, name: tag, body: `Release ${tag}`, target_commitish: "a".repeat(40), created_at: "2026-08-24T00:00:00Z", published_at: null, draft: true, prerelease: false, immutable: false, assets: [{ id: 43, name: "storage-web-1.2.3.pages.zip", state: "uploaded", size: 10, digest: `sha256:${"a".repeat(64)}` }] };
finalPublishRecheck(exactDraft, tag);
for (const mutation of ["id", "tag_name", "name", "body", "target_commitish", "draft", "prerelease", "immutable", "created_at", "published_at", "asset_state", "asset_size", "assets", "asset_id", "duplicate_name", "duplicate_id"]) {
  const mutated = { ...exactDraft };
  if (mutation === "assets") mutated.assets = [{ ...exactDraft.assets[0], digest: `sha256:${"b".repeat(64)}` }];
  else if (mutation === "asset_id") mutated.assets = [{ ...exactDraft.assets[0], id: 44 }];
  else if (mutation === "duplicate_name") mutated.assets = [exactDraft.assets[0], { ...exactDraft.assets[0], id: 44 }];
  else if (mutation === "duplicate_id") mutated.assets = [exactDraft.assets[0], { ...exactDraft.assets[0], name: "other.pages.zip" }];
  else if (mutation === "asset_state") mutated.assets = [{ ...exactDraft.assets[0], state: "pending" }];
  else if (mutation === "asset_size") mutated.assets = [{ ...exactDraft.assets[0], size: 11 }];
  else if (mutation === "id") mutated.id = 43;
  else if (mutation === "immutable") mutated.immutable = true;
  else if (mutation === "created_at") mutated.created_at = "not-a-timestamp";
  else if (mutation === "published_at") mutated.published_at = "2026-08-24T00:00:01Z";
  else mutated[mutation] = mutation === "draft" ? false : mutation === "prerelease" ? true : "changed";
  try {
    finalPublishRecheck(mutated, tag);
  } catch {
    continue;
  }
  throw new Error(`final draft recheck accepted a ${mutation} mutation`);
}
for (const invalid of [{ transport: "timeout" }, { transport: "error" }, { ...exactPublished(tag), immutable: false }, { ...exactPublished(tag), assets: [] }, { id: 0, tag_name: tag, name: tag, body: `Release ${tag}`, target_commitish: "a".repeat(40), created_at: "2026-08-24T00:00:00Z", published_at: null, draft: true, prerelease: false, assets: [] }, { id: 42, tag_name: tag, name: tag, body: `Release ${tag}`, target_commitish: "a".repeat(40), created_at: "2026-08-24T00:00:00Z", published_at: null, draft: true, prerelease: false, assets: [{ id: 0 }] }]) {
  try {
    publicationAction(invalid, 2, tag);
  } catch {
    continue;
  }
  throw new Error("invalid Release state was accepted");
}

const release = job("release");
const deploy = job("deploy");
const build = job("build");
const releaseShell = step(release, "Create or reuse the exact draft Release");
const packageShell = step(build, "Package the deterministic Pages artifact");
const deployVerifyShell = step(deploy, "Download and verify the immutable Release artifact");
const assetRecheckLine = releaseShell.split("\n").find((line) =>
  line.includes('--arg name "storage-web-${RELEASE_TAG#storage-web-v}.pages.zip"') &&
  line.includes('((.assets|type)=="array" and (.assets|length)==1)'),
);
if (!assetRecheckLine) throw new Error("draft asset recheck predicate is missing");
const assetRecheckMatch = assetRecheckLine.match(/'([^']+)' "\$json"(?: >\/dev\/null)?$/u);
if (!assetRecheckMatch) throw new Error("draft asset recheck predicate cannot be extracted");
const assetRecheckPredicate = assetRecheckMatch[1];
const expectedAssetRecheckPredicate = '((.assets|type)=="array" and (.assets|length)==1) and (.assets[0]|type=="object" and (.id|type=="number" and .>0 and floor==.) and .name==$name and .state=="uploaded" and .size==$size and .digest==$digest)';
const brokenAssetRecheckPredicate = expectedAssetRecheckPredicate.replace(".>0", ".id>0");
if (assetRecheckPredicate === brokenAssetRecheckPredicate || releaseShell.includes(brokenAssetRecheckPredicate)) {
  throw new Error("draft asset recheck still uses the broken jq input context");
}
if (assetRecheckPredicate !== expectedAssetRecheckPredicate) {
  throw new Error("draft asset recheck predicate differs from the exact contract");
}
function assertAssetPredicate(predicate, document, expectedStatus, expectedError = undefined) {
  const result = spawnSync(
    "jq",
    [
      "-e",
      "--arg",
      "name",
      "storage-web-1.2.3.pages.zip",
      "--arg",
      "digest",
      `sha256:${"a".repeat(64)}`,
      "--argjson",
      "size",
      "10",
      predicate,
    ],
    {
      input: `${JSON.stringify(document)}\n`,
      encoding: "utf8",
      maxBuffer: Number.POSITIVE_INFINITY,
    },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const spawnError = result.error ? String(result.error.stack ?? result.error) : "none";
  const expectedLabel = expectedStatus === 5 ? "historical broken predicate regression" : "jq predicate assertion";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(`${expectedLabel} stderr:\n${stderr}`);
  if (
    result.error ||
    result.status !== expectedStatus ||
    (expectedError !== undefined && !stderr.includes(expectedError))
  ) {
    throw new Error(
      `${expectedLabel} jq exit status mismatch: expected ${expectedStatus}, got ${result.status}; ` +
      `signal=${result.signal ?? "none"}; spawnerror=${spawnError}\n` +
      `stdout:\n${stdout}\n` +
      `stderr:\n${stderr}`,
    );
  }
}
const validAssetDocument = {
  assets: [{ id: 43, name: "storage-web-1.2.3.pages.zip", state: "uploaded", size: 10, digest: `sha256:${"a".repeat(64)}` }],
};
assertAssetPredicate(assetRecheckPredicate, validAssetDocument, 0);
assertAssetPredicate(brokenAssetRecheckPredicate, validAssetDocument, 5, 'Cannot index number with string "id"');
for (const asset of [
  { ...validAssetDocument.assets[0], id: 0 },
  { ...validAssetDocument.assets[0], id: 43.5 },
  { ...validAssetDocument.assets[0], id: "43" },
  { ...validAssetDocument.assets[0], id: undefined },
]) {
  assertAssetPredicate(assetRecheckPredicate, { assets: [asset] }, 1);
}
for (const fragment of [
  "refs/tags/$RELEASE_TAG:refs/remotes/origin/release-tag", "refs/heads/main:refs/remotes/origin/main",
  "git cat-file -t refs/remotes/origin/release-tag", "git merge-base --is-ancestor",
  "https://github.com/${GITHUB_REPOSITORY}.git", "--no-includes", "--name-only", "protocol.file.allow=never",
  "protocol.ext.allow=never", "protocol.ssh.allow=never", "credential.helper=", "core.askPass=/bin/false",
  "http.proxy=", "https.proxy=", "timeout --signal=TERM --kill-after=5s", "--method POST",
  "--field draft=true", "target_commitish=$RELEASE_SHA", "--method DELETE", "--input \"$archive\"", "Accept: application/octet-stream",
  "cmp -s \"$archive\"", "--method PATCH", "--field draft=false", "GITHUB_RUN_ATTEMPT",
]) if (!releaseShell.includes(fragment)) throw new Error(`release state machine is missing ${fragment}`);
if (workflow.includes("github.run_attempt")) throw new Error("artifact names vary across reruns");
if (!workflow.includes("name: storage-pages-${{ github.run_id }}-${{ github.sha }}") || !workflow.includes("overwrite: true")) throw new Error("Pages artifact reruns are not stable and overwritable");
if ([workflow, verify, sharedUiRelease].some((text) => text.includes("--output"))) throw new Error("binary downloads still use unsupported gh api --output");
if (!releaseShell.includes("upload_url") || !releaseShell.includes("uploads.github.com") || !releaseShell.includes('"$upload_url?name=$asset_name"')) throw new Error("Release asset upload does not use the authoritative uploads.github.com URL");
for (const fragment of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_PARAMETERS", "GH_HOST: github.com", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
  if (!workflow.includes(fragment)) throw new Error(`transport hardening is missing ${fragment}`);
}
for (const [name, text] of [["verify workflow", verify], ["release workflow", workflow]]) {
  for (const fragment of ['GIT_CONFIG_COUNT: "1"', "GIT_CONFIG_KEY_0: init.defaultBranch", "GIT_CONFIG_VALUE_0: main"]) {
    if (!text.includes(fragment)) throw new Error(`${name} does not pin Git's default branch`);
  }
  if (text.includes('GIT_CONFIG_COUNT: "0"')) throw new Error(`${name} leaves Git's default branch implicit`);
}
if (releaseShell.indexOf("--method POST") > releaseShell.indexOf("--method DELETE") || releaseShell.indexOf("--method DELETE") > releaseShell.indexOf("--input \"$archive\"") || releaseShell.indexOf("--input \"$archive\"") > releaseShell.indexOf("--method PATCH")) throw new Error("draft lifecycle operations are out of order");
if (workflow.includes("gh release create") || workflow.includes("release create") || workflow.includes("--draft")) throw new Error("one-shot Release recovery remains");
for (const fragment of ["releases?per_page=100&page=$page", "capture_gh \"$page_json\" api", "page_size", "test \"$page_size\" -le 100", "release-matches.jsonl", "match_count", "discovery_state", "jq -s -er"]) if (!releaseShell.includes(fragment)) throw new Error(`complete Release discovery is missing ${fragment}`);
if (releaseShell.includes("max_release_pages") || releaseShell.includes("Release list completeness cannot be proven within the bounded page limit")) throw new Error("Release discovery has an artificial total page ceiling");
if (releaseShell.includes("/releases/tags/$RELEASE_TAG")) throw new Error("draft-blind tag endpoint remains the discovery authority");
if (!releaseShell.includes("created_at") || !releaseShell.includes("published_at")) throw new Error("draft timestamp checks are missing");
if (!workflow.includes("concurrency:\n  group: pages-storage-web-")) throw new Error("Pages concurrency is missing");
if (!release.includes("needs: build") && !workflow.includes("release:\n    needs: build")) throw new Error("Release does not depend on the tested build");
if (!workflow.includes("needs: [build, release]")) throw new Error("Pages deployment is not downstream of publication");
if (deploy.indexOf("actions/upload-pages-artifact@v5.0.0") < 0 || deploy.indexOf("actions/deploy-pages@v5.0.1") < 0) throw new Error("Pages ordering is not explicit");
if (workflow.indexOf("actions/upload-pages-artifact@v5.0.0") > workflow.indexOf("actions/deploy-pages@v5.0.1")) throw new Error("Pages deployment precedes artifact upload");
for (const fragment of ["validate-pages-archive.py", "pages_digest", "pages_size"]) if (!workflow.includes(fragment)) throw new Error(`Pages artifact contract is missing ${fragment}`);
for (const line of workflow.split("\n").filter((line) => line.includes("gh api"))) if (!line.includes("--hostname github.com")) throw new Error(`GitHub API is not pinned: ${line}`);
if (!packageShell.includes("timeout --signal=TERM --kill-after=5s 300s bash scripts/package-pages.sh") || !packageShell.includes("validate-pages-archive.py")) throw new Error("Pages packaging commands are not directly bounded");
if (pagesPackage.includes("zip -X -q") || pagesPackage.includes("zip -q")) throw new Error("Pages packaging must retain zip diagnostics");
if (!deployVerifyShell.includes("timeout --signal=TERM --kill-after=5s 300s unzip ") || deployVerifyShell.includes("unzip -q") || !deployVerifyShell.includes("validate-pages-archive.py")) throw new Error("Pages artifact extraction commands are not directly bounded");
if (!verify.includes("npm run verify:archive") || !verify.includes("npm run verify:package")) throw new Error("verification contract is incomplete");
if (!archiveTests.includes("unittest.main(testRunner=unittest.TextTestRunner(stream=sys.stdout))")) throw new Error("archive test success report must use stdout");
if (!releaseShell.includes("revalidate_draft_for_publish")) throw new Error("the draft is not re-fetched immediately before publication");
if (!releaseShell.includes('verify_source\n              revalidate_draft_for_publish "$probe" "$release_id"\n              capture_gh "$RUNNER_TEMP/published.json"')) throw new Error("publication does not perform the final source and Release recheck immediately before PATCH");
console.log("storage Release behavioral invariants passed");
