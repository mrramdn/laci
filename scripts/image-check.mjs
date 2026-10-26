// Checks that the repository holds raster images only where they belong: the screenshots in docs/screenshots
// (taken from the demo home, scripts/demo.ts) and the app icons in src-tauri/icons. Any other PNG, JPEG, WebP,
// GIF, AVIF or BMP that git tracks fails the check, so a picture of a real desktop can't slip in elsewhere.
//   node scripts/image-check.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Where raster images may live.
const ALLOWED = ["docs/screenshots/", "src-tauri/icons/"];
const RASTER = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);
const images = tracked.filter((file) => RASTER.test(file));
const misplaced = images.filter(
  (file) => !ALLOWED.some((dir) => file.startsWith(dir)),
);

if (misplaced.length) {
  for (const file of misplaced)
    console.error(`FAIL ${file} is a raster image outside ${ALLOWED.join(" and ")}`);
  console.error(
    "Screenshots go in docs/screenshots and come from the demo home (scripts/demo.ts); app icons go in\n" +
      "src-tauri/icons. Move the file there, or remove it.",
  );
  process.exit(1);
}
console.log(
  `PASS images: ${images.length} raster images, all in ${ALLOWED.join(" or ")}`,
);
