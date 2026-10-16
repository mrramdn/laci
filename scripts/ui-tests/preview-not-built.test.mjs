// The browser preview and its fixtures are for development. A build of the interface may not hold
// any of them.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../../ui/dist/", import.meta.url));
/** Text only the preview and its fixtures have: its page, its errors, the demo home they describe. */
const MARKERS = [
  "__preview",
  "The preview has no",
  "laci preview",
  "/home/demo",
  "fixtures.json",
];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(dir, entry.name))
      : [path.join(dir, entry.name)],
  );
}

export async function theBuildHoldsNoPreview(t) {
  if (!existsSync(dist)) return t.skip("ui/dist is not built");
  for (const file of files(dist)) {
    assert.doesNotMatch(
      path.basename(file),
      /preview/,
      `${file} is in the build`,
    );
    if (!/\.(js|css|html|svg|json|map)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const marker of MARKERS)
      assert.ok(
        !text.includes(marker),
        `${file} holds ${JSON.stringify(marker)}`,
      );
  }
}
