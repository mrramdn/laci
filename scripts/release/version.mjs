// Laci's version, which lives in four files: Cargo.toml's [workspace.package] (and with it Cargo.lock's entries for
// laci and laci-core), package.json and ui/package.json. tauri.conf.json takes Cargo's; if it ever sets one, it
// must match too.
//   node scripts/release/version.mjs                 print the version, or fail when the files disagree
//   node scripts/release/version.mjs set 3.0.0-rc.1  write it into every file
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));

// A tag is v and a semantic version: 3.0.0, or a pre-release such as 3.0.0-rc.1. No build metadata (+...): GitHub
// download addresses and the deb and rpm file names would carry it.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** The parts of a version, or null when it isn't one Laci releases. */
export function parseVersion(version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    version,
    core: `${match[1]}.${match[2]}.${match[3]}`,
    prerelease: match[4] ?? null,
  };
}

/** The version a tag names. Throws for anything but v<version>. */
export function parseTag(tag) {
  const parsed = tag.startsWith("v") ? parseVersion(tag.slice(1)) : null;
  if (!parsed) throw new Error(`${JSON.stringify(tag)} is not a release tag: use v<version>, such as v3.0.0 or v3.0.0-rc.1`);
  return { ...parsed, tag };
}

const read = (dir, file) => readFileSync(path.join(dir, file), "utf8");

// The version line of Cargo.toml's [workspace.package] table.
const CARGO_VERSION = /(\[workspace\.package\][^[]*?\nversion = ")([^"]*)(")/;
// Cargo.lock's entry of a crate of this workspace: name, then version.
const lockEntry = (name) => new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")([^"]*)(")`);

/** Each place that holds the version, and what it says. */
export function readVersions(dir = root) {
  const found = {};
  const cargo = CARGO_VERSION.exec(read(dir, "Cargo.toml"));
  found["Cargo.toml"] = cargo?.[2];
  const lock = read(dir, "Cargo.lock");
  for (const name of ["laci", "laci-core"]) found[`Cargo.lock (${name})`] = lockEntry(name).exec(lock)?.[2];
  for (const file of ["package.json", "ui/package.json"]) found[file] = JSON.parse(read(dir, file)).version;
  for (const file of ["src-tauri/tauri.conf.json", "src-tauri/tauri.linux.conf.json"]) {
    const version = JSON.parse(read(dir, file)).version;
    if (version !== undefined) found[file] = version;
  }
  return found;
}

/** The one version all the files hold. Throws, naming the files, when they disagree or one has none. */
export function currentVersion(dir = root) {
  const found = readVersions(dir);
  const versions = new Set(Object.values(found));
  if (versions.size !== 1 || versions.has(undefined)) {
    const list = Object.entries(found).map(([file, version]) => `  ${file}: ${version ?? "(none)"}`);
    throw new Error(`The version differs between files:\n${list.join("\n")}`);
  }
  return [...versions][0];
}

/** Writes `version` into every file that holds it. */
export function setVersion(version, dir = root) {
  if (!parseVersion(version)) throw new Error(`${JSON.stringify(version)} is not a version`);
  const replace = (file, pattern) => {
    const text = read(dir, file);
    if (!pattern.test(text)) throw new Error(`No version found in ${file}`);
    writeFileSync(path.join(dir, file), text.replace(pattern, `$1${version}$3`));
  };
  replace("Cargo.toml", CARGO_VERSION);
  for (const name of ["laci", "laci-core"]) replace("Cargo.lock", lockEntry(name));
  for (const file of ["package.json", "ui/package.json"]) replace(file, /^(\s*"version": ")([^"]*)(")/m);
  for (const file of ["src-tauri/tauri.conf.json", "src-tauri/tauri.linux.conf.json"]) {
    if (JSON.parse(read(dir, file)).version !== undefined) replace(file, /^(\s*"version": ")([^"]*)(")/m);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, version] = process.argv.slice(2);
  try {
    if (command === "set" && version) {
      setVersion(version);
      console.log(`Laci ${version}: written to Cargo.toml, Cargo.lock, package.json and ui/package.json.`);
    } else if (command === undefined) {
      console.log(currentVersion());
    } else {
      console.error("Usage: node scripts/release/version.mjs [set <version>]");
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
