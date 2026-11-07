// Checks the app icons in src-tauri/icons: what the Tauri configs list, the PNG sizes, and that
// scripts/brand-icons.mjs still writes exactly the committed files.
//   node scripts/brand-check.mjs
// Comparing the icons with a fresh render needs resvg and ImageMagick (magick). Without them that
// comparison is skipped; everything else still runs.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tauriDir = path.join(root, "src-tauri");
const iconDir = path.join(tauriDir, "icons");
const problems = [];
const problem = (text) => problems.push(text);

// What brand-icons.mjs writes with --icons.
const ICONS = [
  "128x128.png",
  "128x128@2x.png",
  "16x16.png",
  "24x24.png",
  "32x32.png",
  "48x48.png",
  "64x64.png",
  "icon.png",
  "icon.svg",
  "laci-symbolic.svg",
];
// The config and the Linux overlay. An overlay's icon list replaces the base list.
const CONFIGS = ["tauri.conf.json", "tauri.linux.conf.json"];

/** Width, height, bit depth and colour type from a PNG's header; null if it isn't a PNG. */
function pngHeader(data) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (data.length < 33 || !data.subarray(0, 8).equals(signature)) return null;
  if (data.toString("latin1", 12, 16) !== "IHDR") return null;
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    depth: data[24],
    colour: data[25],
  };
}

const present = readdirSync(iconDir).sort();
for (const name of present.filter((name) => !ICONS.includes(name)))
  problem(`src-tauri/icons/${name} isn't in the icon set; remove it`);
for (const name of ICONS.filter((name) => !present.includes(name)))
  problem(`src-tauri/icons/${name} is missing`);
console.log(`Icon set: ${present.length} files in src-tauri/icons`);

// Linux uses the first PNG in bundle.icon as the window icon, so each list starts with the
// 512 px icon.png. Release overlays passed with --config may leave the list out.
const used = new Set();
const configs = readdirSync(tauriDir).filter((name) =>
  /^tauri(\.[\w.]+)?\.conf\.json$/.test(name),
);
for (const name of CONFIGS.filter((name) => !configs.includes(name)))
  problem(`src-tauri/${name} is missing`);
for (const name of configs.sort()) {
  const bundle = JSON.parse(readFileSync(path.join(tauriDir, name))).bundle;
  if (bundle?.icon || CONFIGS.includes(name)) {
    const first = bundle?.icon?.[0];
    if (first !== "icons/icon.png")
      problem(`${name}: bundle.icon starts with ${first}, not icons/icon.png`);
  }
  // Every icon the config names: in bundle.icon, in package files, as the installer icon.
  JSON.stringify(bundle ?? {}, (key, value) => {
    if (typeof value === "string" && value.startsWith("icons/")) {
      used.add(value.slice("icons/".length));
      if (!existsSync(path.join(tauriDir, value)))
        problem(`${name}: ${value} doesn't exist`);
    }
    return value;
  });
}
for (const name of present.filter((name) => !used.has(name)))
  problem(`src-tauri/icons/${name} isn't used in any tauri*.conf.json`);
console.log(`Configs: ${configs.join(", ")}`);

// PNGs: 8-bit RGBA, which Tauri needs for the window icon, at the size the name gives.
let pngs = 0;
for (const name of present.filter((name) => name.endsWith(".png"))) {
  const header = pngHeader(readFileSync(path.join(iconDir, name)));
  const match = name.match(/^(\d+)x\1(@2x)?\.png$/);
  const size =
    name === "icon.png" ? 512 : match && match[1] * (match[2] ? 2 : 1);
  if (!header) problem(`${name} isn't a PNG`);
  else if (!size) problem(`${name}: the name doesn't give a size`);
  else if (header.width !== size || header.height !== size)
    problem(`${name} is ${header.width}x${header.height}, not ${size}x${size}`);
  else if (header.depth !== 8 || header.colour !== 6)
    problem(`${name} isn't 8-bit RGBA`);
  else pngs++;
}
console.log(`PNG: ${pngs} files at the sizes their names give`);

// brand-icons.mjs writes into the folder above its own, so it runs from a copy in a temporary folder
// laid out like the repo, with the two files it reads outlines from: the wordmark, and the social
// preview, which keeps its tagline's. Its SVG sources and the app's marks are compared every time;
// the icons only when the render tools are installed. Another resvg version may draw slightly
// different pixels, so the report names the versions.
const versions = {};
for (const tool of ["resvg", "magick"]) {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8" });
  if (!result.error)
    versions[tool] =
      result.stdout.match(/ImageMagick \S+/)?.[0] ??
      `${tool} ${result.stdout.trim()}`;
}
const missing = ["resvg", "magick"].filter((tool) => !versions[tool]);
const render = missing.length === 0;
let stale = false;
const temp = mkdtempSync(path.join(tmpdir(), "laci-brand-check-"));
try {
  for (const file of [
    "scripts/brand-icons.mjs",
    "docs/brand/src/laci-wordmark.svg",
    "docs/brand/src/laci-social.svg",
  ]) {
    mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(temp, file));
  }
  mkdirSync(path.join(temp, "ui/public"), { recursive: true });
  mkdirSync(path.join(temp, "ui/src"), { recursive: true });
  let written = true;
  try {
    execFileSync(
      process.execPath,
      [
        path.join(temp, "scripts/brand-icons.mjs"),
        ...(render ? ["--icons", path.join(temp, "src-tauri/icons")] : []),
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    written = false;
    problem(`brand-icons.mjs failed: ${error.stderr || error.message}`.trim());
  }
  // Each file must be in both places and the same byte for byte. Returns how many are.
  const compare = (files) => {
    let same = 0;
    for (const file of files) {
      const [committed, fresh] = [root, temp].map((base) =>
        path.join(base, file),
      );
      if (!existsSync(fresh))
        problem(`${file}: brand-icons.mjs doesn't write it`);
      else if (!existsSync(committed))
        problem(`${file}: brand-icons.mjs writes it, but it isn't committed`);
      else if (!readFileSync(committed).equals(readFileSync(fresh)))
        problem(`${file} differs from what brand-icons.mjs writes`);
      else same++;
    }
    stale ||= same < files.length;
    return same;
  };
  // The files in a folder here or in the fresh copy.
  const listed = (dir) =>
    [
      ...new Set(
        [root, temp].flatMap((base) =>
          existsSync(path.join(base, dir))
            ? readdirSync(path.join(base, dir)).map((name) => `${dir}/${name}`)
            : [],
        ),
      ),
    ].sort();
  if (written) {
    const sources = compare([
      ...listed("docs/brand/src"),
      "ui/public/favicon.svg",
      "ui/src/brand-marks.ts",
    ]);
    console.log(
      `Sources: ${sources} files (docs/brand/src, the favicon, the app's marks) match brand-icons.mjs`,
    );
    if (render) {
      const icons = compare(listed("src-tauri/icons"));
      console.log(
        `Render: ${icons} icons match a fresh render (${Object.values(versions).join(", ")})`,
      );
    }
  }
  if (!render)
    console.log(
      `Render: skipped, ${missing.join(" and ")} not found; the other checks ran`,
    );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (problems.length) {
  for (const text of problems) console.error(`FAIL ${text}`);
  if (stale)
    console.error(
      "These files come from scripts/brand-icons.mjs. Change the script, then run\n" +
        "  node scripts/brand-icons.mjs --icons src-tauri/icons",
    );
  process.exit(1);
}
console.log("PASS brand icons");
