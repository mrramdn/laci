// Tests of the release scripts: node --test scripts/release/release.test.mjs
// The fixture is a file signed by `tauri signer sign --app-version 9.9.9-rc.1` with a throwaway key whose private
// half was deleted; test-updater.key.pub is its public half.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkLatestJson, checkSums, downloadBase, latestJson, packageNames, sha256sums } from "./assets.mjs";
import { finalize } from "./finalize.mjs";
import { parsePublicKey, parseSignature, shippedPublicKey, verifyUpdate } from "./minisign.mjs";
import { releaseBody, releaseNotes, sections } from "./notes.mjs";
import { verify } from "./verify.mjs";
import { currentVersion, parseTag, parseVersion, readVersions, root, setVersion } from "./version.mjs";

const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const FIXTURE_VERSION = "9.9.9-rc.1";
const fixture = (name) => readFileSync(path.join(fixtures, name));
const appImage = `laci_${FIXTURE_VERSION}_amd64.AppImage`;
const testKey = fixture("test-updater.key.pub").toString("utf8").trim();
const testSignature = fixture(`${appImage}.sig`).toString("utf8");
const made = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "laci-release-test-"));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const CHANGELOG = `# Changelog

## [Unreleased]

Coming next.

## [3.0.0]

### Added

- Simple.

## [2.5.2] - 2026-10-20

A security update.

## [2.5.1]

## [2.5.0] - 2026-13-40

Broken date.
`;

test("versions: tags name a semantic version, without build metadata", () => {
  assert.deepEqual(parseVersion("3.0.0"), { version: "3.0.0", core: "3.0.0", prerelease: null });
  assert.equal(parseVersion("3.0.0-rc.1").prerelease, "rc.1");
  assert.equal(parseTag("v3.0.0-rc.2").version, "3.0.0-rc.2");
  for (const bad of ["3.0", "03.0.0", "3.0.0+build", "3.0.0-", "3.0.0-rc..1", " 3.0.0"]) {
    assert.equal(parseVersion(bad), null, bad);
  }
  for (const bad of ["3.0.0", "v3.0", "release-3.0.0", "v3.0.0;rm"]) assert.throws(() => parseTag(bad), /not a release tag/);
});

test("versions: every file in this checkout holds the same one", () => {
  const version = currentVersion();
  assert.ok(parseVersion(version), version);
  assert.ok(Object.keys(readVersions()).includes("Cargo.lock (laci-core)"));
});

test("versions: set writes every file, and only Laci's own entries of Cargo.lock", () => {
  const dir = temp();
  mkdirSync(path.join(dir, "ui"));
  mkdirSync(path.join(dir, "src-tauri"));
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "ui/package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.linux.conf.json",
  ]) {
    copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const lockBefore = readFileSync(path.join(dir, "Cargo.lock"), "utf8").split("\n");
  setVersion("3.0.0-rc.1", dir);
  assert.equal(currentVersion(dir), "3.0.0-rc.1");
  const lockAfter = readFileSync(path.join(dir, "Cargo.lock"), "utf8").split("\n");
  assert.equal(lockAfter.length, lockBefore.length);
  const changed = lockAfter.filter((line, i) => line !== lockBefore[i]);
  assert.deepEqual(changed, ['version = "3.0.0-rc.1"', 'version = "3.0.0-rc.1"']);
  // A file left behind is named.
  const pkg = path.join(dir, "ui/package.json");
  writeFileSync(pkg, readFileSync(pkg, "utf8").replace("3.0.0-rc.1", "3.0.0-rc.0"));
  assert.throws(() => currentVersion(dir), /ui\/package.json: 3.0.0-rc.0/);
  assert.throws(() => setVersion("3.0", dir), /not a version/);
});

test("notes: a final version needs its dated section", () => {
  assert.equal(releaseNotes(CHANGELOG, "2.5.2").body, "A security update.");
  assert.throws(() => releaseNotes(CHANGELOG, "3.0.0"), /needs a section "## \[3.0.0\] - YYYY-MM-DD"/);
  assert.throws(() => releaseNotes(CHANGELOG, "2.5.3"), /needs a section/);
  assert.throws(() => releaseNotes(CHANGELOG, "2.5.0"), /the date must be YYYY-MM-DD/);
  assert.throws(() => releaseNotes(CHANGELOG, "2.5.1"), /needs a section/);
});

test("notes: a release candidate's text tells deb and rpm users to remove it before the final", () => {
  const where = { runUrl: "https://github.com/mrramdn/laci/actions/runs/1", runner: "ubuntu-22.04", glibc: "2.35" };
  const candidate = releaseBody("Coming next.", { ...where, version: "3.0.0-rc.2" });
  assert.match(candidate, /apt and dnf take 3\.0\.0-rc\.2 for newer than 3\.0\.0\./);
  assert.match(candidate, /Before installing 3\.0\.0, remove this one with `sudo apt remove laci` or `sudo dnf remove laci`/);
  assert.match(candidate, /\n\nBuilt and checked by/);
  const final = releaseBody("Done.", { ...where, version: "3.0.0" });
  assert.doesNotMatch(final, /apt remove/);
  assert.match(final, /^Done\.\n\n---\n\nBuilt and checked by/);
});

test("notes: a pre-release takes its version's section, or Unreleased", () => {
  assert.equal(releaseNotes(CHANGELOG, "3.0.0-rc.1").body, "### Added\n\n- Simple.");
  assert.equal(releaseNotes(CHANGELOG, "3.1.0-rc.1").heading, "## [Unreleased]");
  const empty = "## [Unreleased]\n\n## [2.5.2] - 2026-10-20\n\nx\n";
  assert.throws(() => releaseNotes(empty, "3.0.0-rc.1"), /has no notes/);
  assert.throws(() => releaseNotes("## [2.5.2] - 2026-10-20\n\nx\n", "3.0.0-rc.1"), /neither/);
  assert.deepEqual(
    sections(CHANGELOG).map((section) => section.name),
    ["Unreleased", "3.0.0", "2.5.2", "2.5.1", "2.5.0"],
  );
});

test("notes: the changelog has notes for the version in the files", () => {
  assert.ok(releaseNotes(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), currentVersion()).body);
});

test("minisign: a signature by tauri signer verifies, for its version only", () => {
  const data = fixture(appImage);
  const { keyId, fields } = verifyUpdate(data, testSignature, testKey, FIXTURE_VERSION);
  assert.equal(keyId, "F40EE7ABF57FF8F0");
  assert.deepEqual([fields.version, fields.file], [FIXTURE_VERSION, appImage]);
  assert.equal(verifyUpdate(data, testSignature, testKey, `v${FIXTURE_VERSION}`).keyId, keyId);
  assert.throws(() => verifyUpdate(data, testSignature, testKey, "9.9.9"), /for version 9.9.9-rc.1, not 9.9.9/);
  assert.throws(() => verifyUpdate(Buffer.from("other"), testSignature, testKey, FIXTURE_VERSION), /doesn't match/);
  // The app's own key didn't make it.
  assert.throws(
    () => verifyUpdate(data, testSignature, shippedPublicKey(), FIXTURE_VERSION),
    /Signed with key F40EE7ABF57FF8F0, but the public key is/,
  );
  assert.throws(() => verifyUpdate(data, "not a signature!", testKey, FIXTURE_VERSION), /not base64/);
});

test("minisign: a changed trusted comment is refused before its version is read", () => {
  const text = Buffer.from(testSignature, "base64").toString("utf8");
  const forged = text.replace(`version:${FIXTURE_VERSION}`, "version:10.0.0");
  assert.notEqual(forged, text);
  assert.throws(
    () => verifyUpdate(fixture(appImage), Buffer.from(forged).toString("base64"), testKey, "10.0.0"),
    /trusted comment's signature is wrong/,
  );
});

test("minisign: a signature without a version is refused, as requireSignedVersion does", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const id = Buffer.from("0123456789abcdef", "hex");
  const pub = Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64");
  const pubFile = Buffer.from(`untrusted comment: minisign public key\n${pub}\n`).toString("base64");
  const data = Buffer.from("payload");
  const signature = sign(null, createHash("blake2b512").update(data).digest(), privateKey);
  const comment = "timestamp:1\tfile:laci.AppImage";
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  const sigLine = Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64");
  const sigFile = `untrusted comment: x\n${sigLine}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
  const encoded = Buffer.from(sigFile).toString("base64");
  assert.equal(parsePublicKey(pubFile).keyId, "EFCDAB8967452301");
  assert.equal(parseSignature(encoded).prehashed, true);
  assert.throws(() => verifyUpdate(data, encoded, pubFile, "1.0.0"), /names no version/);
});

test("minisign: the app ships a public key", () => {
  assert.match(parsePublicKey(shippedPublicKey()).keyId, /^[0-9A-F]{16}$/);
});

/** A release folder with the fixture AppImage, its signature and stand-in packages. */
function packagesDir() {
  const dir = temp();
  const names = packageNames(FIXTURE_VERSION);
  copyFileSync(path.join(fixtures, appImage), path.join(dir, names.appImage));
  copyFileSync(path.join(fixtures, `${appImage}.sig`), path.join(dir, names.signature));
  writeFileSync(path.join(dir, names.deb), "deb");
  writeFileSync(path.join(dir, names.rpm), "rpm");
  return dir;
}

test("latest.json: the updater finds the AppImage, signed for the announced version", () => {
  const dir = packagesDir();
  const baseUrl = downloadBase(`v${FIXTURE_VERSION}`);
  const feed = latestJson({
    version: FIXTURE_VERSION,
    notes: "Notes",
    pubDate: "2026-10-21T10:00:00Z",
    baseUrl,
    appImage,
    signature: testSignature,
  });
  assert.deepEqual(Object.keys(feed.platforms), ["linux-x86_64", "linux-x86_64-appimage"]);
  assert.equal(
    feed.platforms["linux-x86_64"].url,
    `https://github.com/mrramdn/laci/releases/download/v9.9.9-rc.1/${appImage}`,
  );
  const options = { dir, publicKey: testKey, version: FIXTURE_VERSION, baseUrl };
  assert.equal(checkLatestJson(JSON.stringify(feed), options).length, 2);
  const broken = (change) => {
    const copy = structuredClone(feed);
    change(copy);
    return () => checkLatestJson(JSON.stringify(copy), options);
  };
  assert.throws(broken((f) => (f.version = "9.9.9-rc.2")), /announces 9.9.9-rc.2/);
  assert.throws(broken((f) => (f.pub_date = "21 Oct 2026")), /RFC 3339/);
  assert.throws(broken((f) => delete f.platforms["linux-x86_64"]), /has no linux-x86_64$/);
  assert.throws(
    broken((f) => (f.platforms["linux-x86_64-appimage"].url = `https://example.com/${appImage}`)),
    /is not an asset of/,
  );
  assert.throws(
    broken((f) => (f.platforms["linux-x86_64"].url = `${baseUrl}/laci_9.9.9-rc.1_amd64.deb`)),
    /doesn't match/,
  );
  assert.throws(broken((f) => (f.platforms["linux-x86_64"].url = `${baseUrl}/missing.AppImage`)), /not among/);
});

test("SHA256SUMS: sha256sum's format, and a changed file is caught", () => {
  const dir = packagesDir();
  const names = readdirSync(dir);
  const sums = sha256sums(dir, names);
  assert.match(sums, /^[0-9a-f]{64} {2}laci-9\.9\.9-rc\.1-1\.x86_64\.rpm\n/);
  assert.deepEqual(checkSums(dir, sums), [...names].sort());
  writeFileSync(path.join(dir, packageNames(FIXTURE_VERSION).deb), "changed");
  assert.throws(() => checkSums(dir, sums), /deb: the checksum doesn't match/);
});

const run = {
  commit: "0".repeat(40),
  runner: "ubuntu-22.04",
  glibc: "2.35",
  runUrl: "https://github.com/mrramdn/laci/actions/runs/1",
  artifact: "laci-release",
};

test("finalize: a dry run writes every asset, checked", () => {
  const out = temp();
  const log = finalize(
    { ...run, version: FIXTURE_VERSION, dryRun: true, packages: packagesDir(), out, publicKey: testKey },
    { changelog: CHANGELOG, now: new Date("2026-10-21T10:00:00.250Z") },
  );
  assert.deepEqual(readdirSync(path.join(out, "assets")).sort(), [
    "SHA256SUMS",
    "laci-9.9.9-rc.1-1.x86_64.rpm",
    "laci_9.9.9-rc.1_amd64.AppImage",
    "laci_9.9.9-rc.1_amd64.AppImage.sig",
    "laci_9.9.9-rc.1_amd64.deb",
    "latest.json",
    "provenance.json",
  ]);
  const read = (name) => readFileSync(path.join(out, "assets", name), "utf8");
  const feed = JSON.parse(read("latest.json"));
  assert.deepEqual([feed.version, feed.pub_date, feed.notes], [FIXTURE_VERSION, "2026-10-21T10:00:00Z", "Coming next."]);
  const prov = JSON.parse(read("provenance.json"));
  assert.equal(prov.dryRun, true);
  assert.equal(prov.sourceTag, null);
  assert.equal(prov.glibc, "2.35");
  assert.match(prov.checks.packageInstall, /^passed \(the deb with apt on Ubuntu 22\.04, the rpm with dnf on Fedora\)$/);
  assert.deepEqual(Object.keys(prov.sha256), [
    "laci-9.9.9-rc.1-1.x86_64.rpm",
    "laci_9.9.9-rc.1_amd64.AppImage",
    "laci_9.9.9-rc.1_amd64.AppImage.sig",
    "laci_9.9.9-rc.1_amd64.deb",
    "latest.json",
  ]);
  assert.equal(checkSums(path.join(out, "assets"), read("SHA256SUMS")).length, 6);
  assert.match(readFileSync(path.join(out, "notes.md"), "utf8"), /^Coming next\.\n\n---\n\n\*\*The deb or rpm of a release candidate:\*\*.*\n\nBuilt and checked by/);
  assert.ok(log.some((line) => line.startsWith("latest.json linux-x86_64-appimage")));
});

test("finalize: a release checks the signature with the app's key first and writes nothing else", () => {
  const out = temp();
  assert.throws(
    () => finalize({ ...run, version: FIXTURE_VERSION, packages: packagesDir(), out }, { changelog: CHANGELOG }),
    /Signed with key F40EE7ABF57FF8F0/,
  );
  assert.deepEqual(readdirSync(out), []);
});

test("finalize: the packages must be exactly the release's", () => {
  const dir = packagesDir();
  writeFileSync(path.join(dir, "stray.txt"), "");
  assert.throws(
    () => finalize({ ...run, version: FIXTURE_VERSION, dryRun: true, packages: dir, out: temp(), publicKey: testKey }, {
      changelog: CHANGELOG,
    }),
    /should hold exactly/,
  );
  assert.throws(
    () => finalize({ ...run, version: FIXTURE_VERSION, tag: "v9.9.9", packages: packagesDir(), out: temp() }, {
      changelog: CHANGELOG,
    }),
    /doesn't name version/,
  );
});

test("verify: the tag, the files, the branch and the notes must agree", () => {
  const base = { changelog: CHANGELOG, branches: ["origin/main", ""] };
  const ok = verify({ ...base, tag: "v3.0.0-rc.1", files: () => "3.0.0-rc.1" });
  assert.deepEqual([ok.version, ok.tag, ok.prerelease], ["3.0.0-rc.1", "v3.0.0-rc.1", true]);
  assert.equal(verify({ ...base, tag: "v2.5.2", files: () => "2.5.2" }).prerelease, false);
  assert.throws(() => verify({ ...base, tag: "v3.0.0-rc.2", files: () => "3.0.0-rc.1" }), /files hold 3.0.0-rc.1/);
  assert.throws(() => verify({ ...base, tag: "v3.0.0", files: () => "3.0.0" }), /needs a section/);
  assert.equal(
    verify({ ...base, branches: ["origin/release/2.5"], tag: "v2.5.2", files: () => "2.5.2" }).notes[1],
    "commit on origin/release/2.5",
  );
  for (const branches of [[], ["origin/feature"], ["origin/mainline", "origin/m6/release"]]) {
    assert.throws(() => verify({ ...base, branches, tag: "v2.5.2", files: () => "2.5.2" }), /neither main nor/);
  }
  // A dry run builds anywhere, as the files' version or one it writes.
  const dry = verify({ ...base, branches: ["origin/m6/release"], dryRun: true, files: () => "2.5.2" });
  assert.deepEqual([dry.version, dry.tag], ["2.5.2", "v2.5.2"]);
  assert.match(dry.notes[1], /^warning/);
  const rc = verify({ ...base, dryRun: true, version: "3.0.0-rc.1", files: () => "2.5.2" });
  assert.deepEqual([rc.version, rc.prerelease], ["3.0.0-rc.1", true]);
  assert.throws(() => verify({ ...base, dryRun: true, version: "3.0", files: () => "2.5.2" }), /not a version/);
});
