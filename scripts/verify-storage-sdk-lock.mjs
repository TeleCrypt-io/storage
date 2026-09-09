import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STORAGE_SDK_PACKAGE = "@telecrypt-io/storage";
export const STORAGE_SDK_VERSION = "0.5.29";
export const STORAGE_SDK_RESOLVED =
  "https://registry.npmjs.org/@telecrypt-io/storage/-/storage-0.5.29.tgz";

const STORAGE_SDK_LOCK_PATH = `node_modules/${STORAGE_SDK_PACKAGE}`;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const MAX_RELEASE_BYTES = 256 * 1024 * 1024;
const RELEASE_RECORD_KEYS = [
  "commit",
  "package",
  "schema",
  "tag",
  "tarball_sha256",
  "tarball_sha512",
  "tarball_size",
  "version",
];

function fail(message) {
  throw new Error(`storage SDK lock preflight failed: ${message}`);
}

export function validateStorageSdkReleaseRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("the exact immutable SDK release record is required");
  }
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...RELEASE_RECORD_KEYS].sort())) {
    fail("the SDK release record has an unexpected schema");
  }
  if (
    record.schema !== 1 ||
    record.package !== STORAGE_SDK_PACKAGE ||
    record.version !== STORAGE_SDK_VERSION ||
    record.tag !== `v${STORAGE_SDK_VERSION}` ||
    !COMMIT.test(record.commit ?? "") ||
    !SHA256_DIGEST.test(record.tarball_sha256 ?? "") ||
    !SHA512_SRI.test(record.tarball_sha512 ?? "") ||
    !Number.isSafeInteger(record.tarball_size) ||
    record.tarball_size < 1 ||
    record.tarball_size > MAX_RELEASE_BYTES
  ) {
    fail(`the SDK release record is not an exact v${STORAGE_SDK_VERSION} immutable package record`);
  }
  return record;
}

export function validateStorageSdkReleaseBytes(archivePath, record) {
  validateStorageSdkReleaseRecord(record);
  let stat;
  try {
    stat = statSync(archivePath);
  } catch {
    fail("the SDK release package bytes are unavailable");
  }
  if (!stat.isFile() || stat.size !== record.tarball_size || stat.size > MAX_RELEASE_BYTES) {
    fail("the SDK release package bytes do not match the immutable record size");
  }
  const bytes = readFileSync(archivePath);
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const sha512 = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (sha256 !== record.tarball_sha256 || sha512 !== record.tarball_sha512) {
    fail("the SDK release package bytes do not match the immutable record digests");
  }
  return true;
}

export function validateStorageSdkLock(packageJson, lockJson, releaseRecord) {
  if (packageJson?.dependencies?.[STORAGE_SDK_PACKAGE] !== STORAGE_SDK_VERSION) {
    fail(`package.json must require ${STORAGE_SDK_PACKAGE}@${STORAGE_SDK_VERSION} exactly`);
  }

  const root = lockJson?.packages?.[""];
  if (root?.dependencies?.[STORAGE_SDK_PACKAGE] !== STORAGE_SDK_VERSION) {
    fail(`package-lock.json direct dependency must require ${STORAGE_SDK_VERSION} exactly`);
  }

  const entry = lockJson?.packages?.[STORAGE_SDK_LOCK_PATH];
  if (!entry || typeof entry !== "object") {
    fail(`package-lock.json is missing the direct ${STORAGE_SDK_LOCK_PATH} entry`);
  }
  if (entry.version !== STORAGE_SDK_VERSION) {
    fail(`the locked SDK version must be ${STORAGE_SDK_VERSION} exactly`);
  }
  if (entry.resolved !== STORAGE_SDK_RESOLVED) {
    fail(`the locked SDK tarball identity must be ${STORAGE_SDK_RESOLVED}`);
  }
  if (typeof entry.integrity !== "string" || !SHA512_SRI.test(entry.integrity)) {
    fail("the locked SDK entry must contain one exact sha512 SRI integrity value");
  }
  const record = validateStorageSdkReleaseRecord(releaseRecord);
  if (entry.integrity !== record.tarball_sha512) {
    fail("the locked SDK integrity is not the exact immutable release record digest");
  }
  return true;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const lockJson = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const recordPath = process.argv[2];
  const archivePath = process.argv[3];
  const record = recordPath ? JSON.parse(readFileSync(recordPath, "utf8")) : undefined;
  validateStorageSdkLock(packageJson, lockJson, record);
  if (archivePath) validateStorageSdkReleaseBytes(archivePath, record);
  console.log(`verified ${STORAGE_SDK_PACKAGE}@${STORAGE_SDK_VERSION} lock identity`);
}
