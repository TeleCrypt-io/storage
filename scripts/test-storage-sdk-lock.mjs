import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORAGE_SDK_PACKAGE,
  STORAGE_SDK_RESOLVED,
  STORAGE_SDK_VERSION,
  validateStorageSdkReleaseBytes,
  validateStorageSdkLock,
} from "./verify-storage-sdk-lock.mjs";

const packageJson = {
  dependencies: { [STORAGE_SDK_PACKAGE]: STORAGE_SDK_VERSION },
};
const validIntegrity = `sha512-${"A".repeat(86)}==`;
const validRecord = {
  schema: 1,
  package: STORAGE_SDK_PACKAGE,
  version: STORAGE_SDK_VERSION,
  tag: "v0.5.30",
  commit: "1".repeat(40),
  tarball_sha256: `sha256:${"b".repeat(64)}`,
  tarball_sha512: validIntegrity,
  tarball_size: 1,
};
const lockJson = {
  packages: {
    "": { dependencies: { [STORAGE_SDK_PACKAGE]: STORAGE_SDK_VERSION } },
    [`node_modules/${STORAGE_SDK_PACKAGE}`]: {
      version: STORAGE_SDK_VERSION,
      resolved: STORAGE_SDK_RESOLVED,
      integrity: validIntegrity,
    },
  },
};

assert.equal(validateStorageSdkLock(packageJson, lockJson, validRecord), true);

for (const [label, mutate] of [
  ["missing integrity", (entry) => delete entry.integrity],
  ["malformed integrity", (entry) => { entry.integrity = "sha256-not-accepted"; }],
  ["wrong resolved identity", (entry) => { entry.resolved = "https://registry.npmjs.org/other.tgz"; }],
  ["wrong version", (entry) => { entry.version = "0.4.0"; }],
]) {
  const invalid = structuredClone(lockJson);
  mutate(invalid.packages[`node_modules/${STORAGE_SDK_PACKAGE}`]);
  assert.throws(() => validateStorageSdkLock(packageJson, invalid, validRecord), /preflight failed/, label);
}

const wrongDirectDependency = structuredClone(lockJson);
wrongDirectDependency.packages[""].dependencies[STORAGE_SDK_PACKAGE] = "0.4.0";
assert.throws(
  () => validateStorageSdkLock(packageJson, wrongDirectDependency, validRecord),
  /direct dependency/,
  "wrong direct dependency",
);

assert.throws(
  () => validateStorageSdkLock(packageJson, lockJson),
  /immutable SDK release record is required/u,
  "release record is mandatory",
);
assert.throws(
  () => validateStorageSdkLock(packageJson, lockJson, { ...validRecord, tarball_sha512: `sha512-${"C".repeat(86)}==` }),
  /release record digest/u,
  "lock must bind to release record",
);
for (const [label, mutation] of [
  ["wrong commit", (record) => { record.commit = "0".repeat(40); }],
  ["wrong package", (record) => { record.package = "@telecrypt-io/not-storage"; }],
  ["wrong record tag", (record) => { record.tag = "v0.5.1"; }],
  ["wrong record size", (record) => { record.tarball_size = 0; }],
]) {
  const invalidRecord = structuredClone(validRecord);
  mutation(invalidRecord);
  assert.throws(() => validateStorageSdkLock(packageJson, lockJson, invalidRecord), /release record/u, label);
}

const configuredRoot = process.env.HARNESS_ARTIFACTS_ROOT;
const directory = mkdtempSync(join(configuredRoot || tmpdir(), "storage-sdk-release-record-"));
console.error(`Storage SDK lock test evidence retained at ${directory}`);
const archive = join(directory, "storage-0.5.30.tgz");
const bytes = Buffer.from("package-bytes");
const record = {
  ...validRecord,
  tarball_size: bytes.length,
  tarball_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  tarball_sha512: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
};
writeFileSync(archive, bytes);
assert.equal(validateStorageSdkReleaseBytes(archive, record), true);
writeFileSync(archive, Buffer.from("different1234"));
assert.throws(() => validateStorageSdkReleaseBytes(archive, record), /digests/u);

console.log("storage SDK lock preflight regression checks passed");
