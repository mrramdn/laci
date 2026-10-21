// The release workflow's first check, before anything is built.
//   node scripts/release/verify.mjs --tag v3.0.0 --commit <sha>
//     the tag names the version every file holds, the commit is on main or a release/* branch, and CHANGELOG.md
//     has the notes
//   node scripts/release/verify.mjs --dry-run --commit <sha> [--version 3.0.0-rc.1]
//     the same for the version in the files, or for --version, which the dry run's build writes into them. A commit
//     that is on no release branch only warns.
// In GitHub Actions it writes version, tag and prerelease to $GITHUB_OUTPUT. THIRD_PARTY_NOTICES.md is checked by
// its own step (node scripts/notices.mjs --check), which needs the Rust crates fetched.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { releaseNotes } from "./notes.mjs";
import { currentVersion, parseTag, parseVersion, root } from "./version.mjs";

/** The branches, of `git branch -r --contains`, a release may come from. */
export const releaseBranches = (remoteBranches) =>
  remoteBranches
    .map((line) => line.trim())
    .filter((branch) => /^origin\/(main|release\/[^\s]+)$/.test(branch));

/** Checks a release (or a dry run) and answers what it found. Throws at the first thing that refuses it. */
export function verify({ tag, dryRun, version: override, files, changelog, branches }) {
  const notes = [];
  let version;
  if (dryRun) {
    if (override && !parseVersion(override)) throw new Error(`${JSON.stringify(override)} is not a version`);
    version = override || files();
    notes.push(override ? `version ${version}, which the build writes into the files` : `version ${version}`);
  } else {
    version = parseTag(tag).version;
    const held = files();
    if (held !== version) throw new Error(`Tag ${tag} names ${version}, but the files hold ${held}`);
    notes.push(`version ${version}: the tag and every file agree`);
  }
  const onBranch = releaseBranches(branches);
  if (onBranch.length) notes.push(`commit on ${onBranch.join(", ")}`);
  else if (dryRun) notes.push("warning: the commit is on neither main nor a release/* branch; a tag here would be refused");
  else throw new Error("The tagged commit is on neither main nor a release/* branch");
  const section = releaseNotes(changelog, version);
  notes.push(`notes from "${section.heading}"`);
  return { version, tag: tag ?? `v${version}`, prerelease: parseVersion(version).prerelease !== null, notes };
}

function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      commit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      version: { type: "string" },
    },
  });
  if (!values.commit || values["dry-run"] === Boolean(values.tag) || (values.version && !values["dry-run"])) {
    console.error("Usage: verify.mjs --tag <tag> --commit <sha> | --dry-run --commit <sha> [--version <version>]");
    process.exit(2);
  }
  const branches = execFileSync("git", ["branch", "-r", "--format=%(refname:short)", "--contains", values.commit], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const result = verify({
    tag: values.tag,
    dryRun: values["dry-run"],
    version: values.version,
    files: () => currentVersion(),
    changelog: readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
    branches,
  });
  for (const line of result.notes) console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\ntag=${result.tag}\nprerelease=${result.prerelease}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
