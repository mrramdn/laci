// Every file keeps a name of its own on macOS and Windows, whose file systems ignore case: two paths
// that differ only in case can't both be checked out, and two names in one folder that differ only in
// case before the extension (Countdown.tsx, countdown.ts) make an import of either one ambiguous.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function noTwoFilesDifferOnlyInCase() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 100, "git lists the repository's files");
  const seen = new Map();
  const clashes = [];
  for (const file of files) {
    const folder = path.posix.dirname(file);
    const stem = path.posix.basename(file).split(".")[0];
    for (const key of [`path:${file.toLowerCase()}`, `stem:${folder.toLowerCase()}/${stem.toLowerCase()}`]) {
      const other = seen.get(key);
      const mine = key.startsWith("path:") ? file : `${folder}/${stem}`;
      if (other !== undefined && other !== mine) clashes.push(`${other} and ${file}`);
      else seen.set(key, mine);
    }
  }
  assert.deepEqual(clashes, []);
}
