import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const provenancePath = "src/vendor/telecrypt-ui/PROVENANCE.json";
const stylesheetPath = "src/vendor/telecrypt-ui/product.css";
export const EXPECTED_PROVENANCE = {
  vendor: "@telecrypt-io/ui",
  version: "0.1.8",
  canonical_source: "https://github.com/TeleCrypt-io/ui-shared-css",
  canonical_release: "v0.1.8",
  canonical_commit: "257c9ec70024b5d39b76c266c3ab5d129fc34c65",
  source_file: "src/product.css",
  sha256: "ce9c3c0ff968d3156521e79f9f81a800441f730c2875adf37a7d28c57cab5f6a",
};

const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
const stylesheetBytes = readFileSync(stylesheetPath);
const stylesheetHash = createHash("sha256").update(stylesheetBytes).digest("hex");

if (JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify(Object.keys(EXPECTED_PROVENANCE).sort())) {
  throw new Error("UI provenance must contain exactly the supported schema");
}

for (const [key, value] of Object.entries(EXPECTED_PROVENANCE)) {
  if (provenance[key] !== value) {
    throw new Error(`UI provenance ${key} does not match the selected release`);
  }
}
if (stylesheetHash !== EXPECTED_PROVENANCE.sha256) {
  throw new Error("Vendored UI stylesheet hash does not match the selected release");
}

/**
 * Optional release-byte gate used by CI. The source tree remains self-contained
 * and does not acquire a generated lock or a mutable runtime dependency, but a
 * consumer release must still prove that its vendored bytes came from the
 * selected immutable shared-CSS Release.
 */
export function validateSharedUiRelease(release, archivePath) {
  const expectedAsset = `telecrypt-io-ui-${EXPECTED_PROVENANCE.version}.tgz`;
  if (
    !release ||
    release.tag_name !== EXPECTED_PROVENANCE.canonical_release ||
    release.name !== EXPECTED_PROVENANCE.canonical_release ||
    release.target_commitish !== EXPECTED_PROVENANCE.canonical_commit ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.immutable !== true ||
    !Array.isArray(release.assets) ||
    release.assets.length !== 1
  ) {
    throw new Error("shared UI Release is not the exact immutable selected release");
  }
  const [asset] = release.assets;
  if (
    asset?.name !== expectedAsset ||
    asset.state !== "uploaded" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    !/^sha256:[0-9a-f]{64}$/u.test(asset.digest ?? "")
  ) {
    throw new Error("shared UI Release asset identity is not exact");
  }
  if (archivePath !== undefined) {
    const archive = readFileSync(archivePath);
    if (
      archive.byteLength !== asset.size ||
      `sha256:${createHash("sha256").update(archive).digest("hex")}` !== asset.digest
    ) {
      throw new Error("shared UI Release archive bytes do not match its published asset");
    }
    const vendored = execFileSync("tar", ["-xOzf", archivePath, "--", "package/src/product.css"], {
      maxBuffer: Number.POSITIVE_INFINITY,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (createHash("sha256").update(vendored).digest("hex") !== EXPECTED_PROVENANCE.sha256) {
      throw new Error("shared UI Release stylesheet bytes do not match provenance");
    }
  }
  return true;
}

if (process.argv[2]) {
  const release = JSON.parse(readFileSync(process.argv[2], "utf8"));
  validateSharedUiRelease(release, process.argv[3]);
}
