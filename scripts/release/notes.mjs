// A release's notes, from CHANGELOG.md.
//   node scripts/release/notes.mjs 3.0.0-rc.1     print the notes the release and latest.json get
// A final version X.Y.Z needs a section "## [X.Y.Z] - YYYY-MM-DD". A pre-release X.Y.Z-rc.N takes "## [X.Y.Z]" when
// there is one (with or without a date), and otherwise "## [Unreleased]".
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseVersion, root } from "./version.mjs";

const HEADING = /^## \[([^\]]+)\](?:\s+-\s+(\S+))?\s*$/;

/** Every "## [...]" section of a changelog, in order, with its text up to the next one. */
export function sections(changelog) {
  const found = [];
  let current = null;
  for (const line of changelog.split("\n")) {
    const heading = line.startsWith("## ") ? HEADING.exec(line) : null;
    if (line.startsWith("## ")) {
      current = heading ? { name: heading[1], date: heading[2] ?? null, heading: line, lines: [] } : null;
      if (current) found.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return found.map(({ lines, ...section }) => ({ ...section, body: lines.join("\n").trim() }));
}

function validDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

/** The section a version's release takes its notes from. Throws, saying what the changelog needs, when it has none. */
export function releaseNotes(changelog, version) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`${JSON.stringify(version)} is not a version`);
  const all = sections(changelog);
  const named = (name) => all.find((section) => section.name === name);
  let section;
  if (parsed.prerelease) {
    section = named(parsed.core) ?? named("Unreleased");
    if (!section) throw new Error(`CHANGELOG.md has neither "## [${parsed.core}]" nor "## [Unreleased]" for ${version}`);
  } else {
    section = named(version);
    if (!section || !section.date) {
      throw new Error(`CHANGELOG.md needs a section "## [${version}] - YYYY-MM-DD" for ${version}`);
    }
  }
  if (section.date !== null && !validDate(section.date)) {
    throw new Error(`"${section.heading}" in CHANGELOG.md: the date must be YYYY-MM-DD`);
  }
  if (!section.body) throw new Error(`"${section.heading}" in CHANGELOG.md has no notes`);
  return section;
}

/**
 * The text of the GitHub release: the notes, then where the packages come from and how to check them. A release
 * candidate also says how its deb or rpm gives way to the final version: apt and dnf rank X.Y.Z-rc.N above X.Y.Z, so
 * installing the final over it is a downgrade to them.
 */
export function releaseBody(notes, { version, runUrl, runner, glibc }) {
  const parsed = parseVersion(version);
  const core = parsed?.prerelease ? parsed.core : null;
  const candidate = core
    ? [
        `**The deb or rpm of a release candidate:** apt and dnf take ${version} for newer than ${core}. ` +
          `Before installing ${core}, remove this one with \`sudo apt remove laci\` or \`sudo dnf remove laci\`. ` +
          "Your settings and Laci's data stay. The AppImage updates itself.",
        "",
      ]
    : [];
  const built = [
    `Built and checked by [GitHub Actions](${runUrl}) on ${runner}`,
    glibc ? `, for Linux x86-64 with glibc ${glibc} or newer` : "",
    ". To check a download, see [Verify a download](https://github.com/mrramdn/laci/blob/main/RELEASING.md#verify-a-download).",
  ].join("");
  return `${notes.trim()}\n\n---\n\n${[...candidate, built].join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/release/notes.mjs <version>");
    process.exit(2);
  }
  try {
    const section = releaseNotes(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
    console.log(`${section.heading}\n\n${section.body}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
