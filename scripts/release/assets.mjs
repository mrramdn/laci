// What a release holds besides the packages: latest.json for the updater, SHA256SUMS and provenance.json.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { verifyUpdate } from "./minisign.mjs";
import { parseVersion } from "./version.mjs";

export const REPOSITORY = "mrramdn/laci";

/** Where a tag's assets download from once the release is published. */
export const downloadBase = (tag, repository = REPOSITORY) => `https://github.com/${repository}/releases/download/${tag}`;

/** The file names Tauri gives a version's packages, and the updater's signature of the AppImage. */
export function packageNames(version) {
  const appImage = `laci_${version}_amd64.AppImage`;
  return { appImage, signature: `${appImage}.sig`, deb: `laci_${version}_amd64.deb`, rpm: `laci-${version}-1.x86_64.rpm` };
}

// The plugin looks for `linux-x86_64-<bundle>` first and then `linux-x86_64`. Only the AppImage installs an update
// in Laci; a deb or rpm copy finds the version under `linux-x86_64` and links to the release page.
const TARGETS = ["linux-x86_64", "linux-x86_64-appimage"];

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A time as latest.json's pub_date: RFC 3339 in UTC, to the second. */
export const rfc3339 = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The updater feed of a release, in the static format tauri-plugin-updater reads. */
export function latestJson({ version, notes, pubDate, baseUrl, appImage, signature }) {
  const entry = { signature: signature.trim(), url: `${baseUrl}/${encodeURIComponent(appImage)}` };
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: Object.fromEntries(TARGETS.map((target) => [target, { ...entry }])),
  };
}

/**
 * Reads latest.json the way the updater will, and checks every download it names: the file is among the assets in
 * `dir`, its address is the release's, and its signature verifies under `publicKey` for the announced version.
 * Answers one line per target. Throws at the first problem.
 */
export function checkLatestJson(text, { dir, publicKey, version, baseUrl }) {
  const feed = JSON.parse(text);
  if (feed.version !== version || !parseVersion(feed.version)) {
    throw new Error(`latest.json announces ${feed.version}, not ${version}`);
  }
  if (typeof feed.pub_date !== "string" || !RFC3339.test(feed.pub_date) || Number.isNaN(Date.parse(feed.pub_date))) {
    throw new Error(`latest.json's pub_date ${JSON.stringify(feed.pub_date)} is not an RFC 3339 time`);
  }
  if (typeof feed.notes !== "string" || !feed.notes.trim()) throw new Error("latest.json has no notes");
  const platforms = feed.platforms ?? {};
  const lines = [];
  for (const target of TARGETS) {
    const entry = platforms[target];
    if (!entry) throw new Error(`latest.json has no ${target}`);
    const url = new URL(entry.url);
    if (url.protocol !== "https:" || !entry.url.startsWith(`${baseUrl}/`)) {
      throw new Error(`${target}: ${entry.url} is not an asset of ${baseUrl}`);
    }
    const name = decodeURIComponent(entry.url.slice(baseUrl.length + 1));
    const file = path.join(dir, name);
    if (name.includes("/") || !existsSync(file)) throw new Error(`${target}: ${name} is not among the assets`);
    const { keyId, fields } = verifyUpdate(readFileSync(file), entry.signature, publicKey, feed.version);
    if (fields.file !== undefined && fields.file !== name) {
      throw new Error(`${target}: the signature is of ${fields.file}, not ${name}`);
    }
    lines.push(`${target}: ${name}, signature by key ${keyId} for version ${fields.version}`);
  }
  return lines;
}

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** SHA256SUMS in the format `sha256sum -c` reads, sorted by name. */
export function sha256sums(dir, names) {
  return [...names]
    .sort()
    .map((name) => `${sha256(path.join(dir, name))}  ${name}\n`)
    .join("");
}

/** Checks every line of SHA256SUMS against the files in `dir`. Answers the names it checked. */
export function checkSums(dir, text) {
  const names = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}([^/]+)$/.exec(line);
    if (!match) throw new Error(`Not a SHA256SUMS line: ${line}`);
    if (sha256(path.join(dir, match[2])) !== match[1]) throw new Error(`${match[2]}: the checksum doesn't match`);
    names.push(match[2]);
  }
  return names;
}

/** provenance.json, in the shape of 2.5.2's, made by the release workflow. */
export function provenance({ version, commit, tag, dryRun, runner, glibc, runUrl, artifact, keyId, sums }) {
  return {
    version,
    sourceCommit: commit,
    sourceTag: dryRun ? null : tag,
    ...(dryRun ? { dryRun: true } : {}),
    workflow: "Release",
    runner,
    glibc,
    githubActionsRun: runUrl,
    githubArtifact: artifact,
    checks: {
      versionAndChangelog: "passed",
      thirdPartyNotices: "passed",
      noWebDriverServer: "passed",
      packageValidation: "passed",
      nativeProductionPackageRegression: "passed",
      packageInstall: "passed (the deb with apt on Ubuntu 22.04, the rpm with dnf on Fedora)",
      updaterSignature: `passed (key ${keyId}${dryRun ? ", a throwaway key of this dry run" : ""}, version ${version})`,
      latestJson: "passed",
    },
    sha256: sums,
  };
}
