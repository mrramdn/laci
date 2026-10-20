// Laci's mark from one description: the glyph on a 1024 grid, its plates, pixel maps for small sizes, the
// symbolic glyph and the lockups. Writes the SVG sources in docs/brand/src; renders on request.
//   node scripts/brand-icons.mjs                  SVG sources only
//   node scripts/brand-icons.mjs --icons DIR      also the app icon set (PNG, SVG) into DIR
//   node scripts/brand-icons.mjs --sheet FILE     also a review sheet (PNG)
//   node scripts/brand-icons.mjs --font TTF       outline the wordmark again from Plus Jakarta Sans Bold
// Rendering needs resvg and ImageMagick (magick); --font needs usvg.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = path.join(root, "docs/brand/src");
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : path.resolve(args[at + 1] ?? "");
};
const run = (command, list) =>
  execFileSync(command, list, { encoding: "utf8", stdio: "pipe" });

// Indonesian names: kunyit is turmeric, jati is teak, santan is coconut milk, malam is night.
const LIGHT = {
  plate: ["#FFD34E", "#F4AC1A"],
  edge: "#D9940A",
  frame: "#3B2A1E",
  opening: "#140D09",
  card: "#E9D3A6",
  folder: "#FFF5DF",
};
const DARK = { ...LIGHT, plate: ["#231D17", "#14100C"], frame: "#FFC83D", opening: "#0B0806" };
const FLAT = "#F9BF33"; // the plate at 32 px and below, where a gradient only blurs

// The glyph: a cabinet whose drawer is pulled out, two folders inside, a cup pull. Its groups are its layers
// (cabinet, contents, drawer front), back to front.
const glyph = (c) =>
  `<g id="g1-cabinet"><path id="frame" fill="${c.frame}" d="M256 544V312a96 96 0 0 1 96-96h320a96 96 0 0 1 96 96v232z"/>` +
  `<path id="opening" fill="${c.opening}" d="M312 544V312a40 40 0 0 1 40-40h320a40 40 0 0 1 40 40v232z"/></g>` +
  `<g id="g2-contents"><path id="card" fill="${c.card}" d="M472 544V368a24 24 0 0 1 24-24h144a24 24 0 0 1 24 24v176z"/>` +
  `<path id="folder" fill="${c.folder}" d="M360 544V392a24 24 0 0 1 24-24h64a24 24 0 0 1 24 24a8 8 0 0 0 8 8h96a24 24 0 0 1 24 24v120z"/></g>` +
  `<g id="g3-drawer"><path id="front" fill="${c.frame}" fill-rule="evenodd" d="M272 568h480a72 72 0 0 1 72 72v96a72 72 0 0 1-72 72H272a72 72 0 0 1-72-72v-96a72 72 0 0 1 72-72zM436 640h152a12 12 0 0 1 12 12v4a88 52 0 0 1-176 0v-4a12 12 0 0 1 12-12z"/></g>`;
const scaled = (s, c) =>
  `<g transform="translate(512 512) scale(${s}) translate(-512 -512)">${glyph(c)}</g>`;
const gradient = (id, [top, bottom]) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`;
const svg = (viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

const masters = {
  // Glyph alone, for use on a coloured surface.
  "laci-glyph.svg": svg("0 0 1024 1024", glyph(LIGHT)),
  // Linux (GNOME/KDE): a rounded square with a darker front edge, no shadow.
  "laci-icon-linux.svg": svg(
    "0 0 1024 1024",
    `<defs>${gradient("plate", LIGHT.plate)}</defs><rect x="100" y="116" width="824" height="824" rx="185" fill="${LIGHT.edge}"/>` +
      `<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#plate)"/>${scaled(0.8047, LIGHT)}`,
  ),
  // The web and the app: the plate nearly fills the square.
  "laci-icon-tight.svg": svg(
    "0 0 1024 1024",
    `<defs>${gradient("plate", LIGHT.plate)}</defs><rect x="32" y="32" width="960" height="960" rx="216" fill="url(#plate)"/>${scaled(0.9375, LIGHT)}`,
  ),
  // The dark appearance, for dark surfaces that need a quieter mark.
  "laci-icon-tight-dark.svg": svg(
    "0 0 1024 1024",
    `<defs>${gradient("plate", DARK.plate)}</defs><rect x="32" y="32" width="960" height="960" rx="216" fill="url(#plate)"/>${scaled(0.9375, DARK)}`,
  ),
  // One colour, 16 px grid: GNOME's symbolic icon, and any place that tints the mark itself.
  "laci-symbolic.svg": svg(
    "0 0 16 16",
    `<g fill="currentColor"><path d="M4 8V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v4h-1V4H5v4z"/><path d="M6 8V5h4v3z"/>` +
      `<path fill-rule="evenodd" d="M4 9h8a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zm2 1v1h1v1h2v-1h1v-1z"/></g>`,
  ),
};

// Small sizes are drawn on the pixel grid: a scaled master turns to mush below 32 px. Rectangles are
// [top, bottom, left, right], inclusive. The cabinet and drawer get one-pixel corner notches.
const PIXEL = {
  16: { rx: 3, cabinet: [3, 7, 4, 11], drawer: [9, 13, 3, 12], folder: [[5, 7, 6, 9]], hole: [[10, 10, 6, 9], [11, 11, 7, 8]] },
  24: { rx: 5, cabinet: [4, 11, 6, 17], drawer: [13, 19, 4, 19], card: [[6, 11, 13, 15]], folder: [[7, 7, 9, 11], [8, 11, 9, 14]], hole: [[15, 15, 10, 13], [16, 16, 11, 12]] },
  32: { rx: 7, cabinet: [7, 16, 9, 22], drawer: [18, 24, 7, 24], card: [[9, 16, 16, 20]], folder: [[10, 10, 11, 13], [11, 16, 11, 17]], hole: [[20, 20, 13, 18], [21, 21, 14, 17]] },
};
function pixelMap(size, spec) {
  const grid = Array.from({ length: size }, () => Array(size).fill(""));
  const fill = (color, [top, bottom, left, right]) => {
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) grid[y][x] = color;
  };
  const [ct, cb, cl, cr] = spec.cabinet;
  fill(LIGHT.frame, [ct, ct, cl + 1, cr - 1]);
  fill(LIGHT.frame, [ct + 1, cb, cl, cr]);
  for (const box of spec.card ?? []) fill(LIGHT.card, box);
  for (const box of spec.folder) fill(LIGHT.folder, box);
  const [dt, db, dl, dr] = spec.drawer;
  fill(LIGHT.frame, [dt, dt, dl + 1, dr - 1]);
  fill(LIGHT.frame, [dt + 1, db - 1, dl, dr]);
  fill(LIGHT.frame, [db, db, dl + 1, dr - 1]);
  for (const box of spec.hole) fill("", box);
  let rects = "";
  grid.forEach((row, y) => {
    for (let x = 0; x < size; ) {
      let end = x;
      while (end + 1 < size && row[end + 1] === row[x]) end++;
      if (row[x]) rects += `<rect x="${x}" y="${y}" width="${end - x + 1}" height="1" fill="${row[x]}"/>`;
      x = end + 1;
    }
  });
  return svg(
    `0 0 ${size} ${size}`,
    `<rect width="${size}" height="${size}" rx="${spec.rx}" fill="${FLAT}"/><g shape-rendering="crispEdges">${rects}</g>`,
  );
}
for (const [size, spec] of Object.entries(PIXEL)) masters[`laci-${size}.svg`] = pixelMap(Number(size), spec);

// The wordmark: lowercase "laci" in Plus Jakarta Sans Bold, −0.02 em, as outlines. At font size 1000 the
// "l" runs from y 243 to the baseline at 1000, and the word from x 61, 1511 wide.
const wordmarkFile = path.join(src, "laci-wordmark.svg");
const font = option("--font");
if (font) {
  const dir = mkdtempSync(path.join(tmpdir(), "laci-wordmark-"));
  writeFileSync(
    path.join(dir, "text.svg"),
    svg("0 0 3000 1400", `<text x="0" y="1000" font-family="Plus Jakarta Sans" font-weight="700" font-size="1000" letter-spacing="-20" fill="${LIGHT.frame}">laci</text>`),
  );
  run("usvg", ["--use-font-file", font, "--skip-system-fonts", path.join(dir, "text.svg"), path.join(dir, "out.svg")]);
  const d = readFileSync(path.join(dir, "out.svg"), "utf8").match(/ d="([^"]+)"/)?.[1];
  assert.ok(d, "usvg wrote no outline");
  writeFileSync(wordmarkFile, svg("40 220 1560 820", `<path fill="${LIGHT.frame}" d="${d}"/>`));
  rmSync(dir, { recursive: true });
}
const word = readFileSync(wordmarkFile, "utf8").match(/ d="([^"]+)"/)?.[1];
assert.ok(word, `Missing wordmark outline in ${wordmarkFile}`);

// Lockup: the tight mark at height H; the "l" is 0.70 H tall and sits on the drawer's bottom edge (0.77 H);
// the gap and the clear space around it are 0.25 H.
function lockup(ink) {
  const H = 256;
  const scale = (0.7 * H) / 757;
  const pad = 0.25 * H;
  const width = Math.ceil(2 * pad + 1.25 * H + 1511 * scale);
  const mark = masters["laci-icon-tight.svg"].replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const x = pad + 1.25 * H - 61 * scale;
  const y = pad + 0.77 * H - 1000 * scale;
  return svg(
    `0 0 ${width} ${2 * pad + H}`,
    `<svg x="${pad}" y="${pad}" width="${H}" height="${H}" viewBox="0 0 1024 1024">${mark}</svg>` +
      `<path fill="${ink}" transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(5)})" d="${word}"/>`,
  );
}
masters["laci-lockup.svg"] = lockup(LIGHT.frame);
masters["laci-lockup-dark.svg"] = lockup(LIGHT.folder);

mkdirSync(src, { recursive: true });
for (const [name, text] of Object.entries(masters)) writeFileSync(path.join(src, name), text);
console.log(`Wrote ${Object.keys(masters).length} sources in ${path.relative(root, src)}`);

// The app draws the mark inline (ui/src/brand.tsx), and the dev server's tab uses the favicon.
const inline = (name) =>
  masters[name]
    .trim()
    .replace(/ id="(?!plate")[^"]*"/g, "")
    .replace(/^<svg /, '<svg aria-hidden="true" ');
writeFileSync(path.join(root, "ui/public/favicon.svg"), masters["laci-icon-tight.svg"]);
writeFileSync(
  path.join(root, "ui/src/brand-marks.ts"),
  `// Written by scripts/brand-icons.mjs from docs/brand/src; run it again instead of editing.\n` +
    `export const MARK = ${JSON.stringify(inline("laci-icon-tight.svg"))};\n` +
    `export const MARK_16 = ${JSON.stringify(inline("laci-16.svg"))};\n` +
    `export const MARK_24 = ${JSON.stringify(inline("laci-24.svg"))};\n`,
);

// Rendering.
const temp = mkdtempSync(path.join(tmpdir(), "laci-brand-"));
const png = (name, size) => {
  const out = path.join(temp, `${name}-${size}.png`);
  run("resvg", ["-w", String(size), "-h", String(size), path.join(src, name), out]);
  return out;
};
const small = (size) => png(`laci-${size}.svg`, size);

const icons = option("--icons");
if (icons) {
  mkdirSync(icons, { recursive: true });
  const put = (file, name) => copyFileSync(file, path.join(icons, name));
  put(png("laci-icon-linux.svg", 512), "icon.png");
  for (const size of [16, 24, 32]) put(small(size), `${size}x${size}.png`);
  for (const size of [48, 64, 128]) put(png("laci-icon-linux.svg", size), `${size}x${size}.png`);
  put(png("laci-icon-linux.svg", 256), "128x128@2x.png");
  put(path.join(src, "laci-icon-linux.svg"), "icon.svg");
  put(path.join(src, "laci-symbolic.svg"), "laci-symbolic.svg");
  console.log(`Rendered the icon set in ${path.relative(root, icons) || icons}`);
}

let strips = 0;
const sheet = option("--sheet");
if (sheet) {
  const lockups = ["laci-lockup.svg", "laci-lockup-dark.svg"].map((name) => {
    const out = path.join(temp, name.replace(".svg", ".png"));
    run("resvg", ["-w", "640", path.join(src, name), out]);
    return out;
  });
  const zoom = (file, factor) => {
    const out = file.replace(".png", `-x${factor}.png`);
    run("magick", [file, "-filter", "point", "-resize", `${factor * 100}%`, out]);
    return out;
  };
  const strip = (files, background) => {
    const out = path.join(temp, `strip-${++strips}.png`);
    run("magick", ["-background", background, "-gravity", "center", ...files.flatMap((f) => [f, "-bordercolor", background, "-border", "16"]), "+append", out]);
    return out;
  };
  const masterRow = ["laci-icon-linux.svg", "laci-icon-tight.svg", "laci-icon-tight-dark.svg"].map((n) => png(n, 256));
  const sizes = [png("laci-icon-linux.svg", 128), png("laci-icon-linux.svg", 64), png("laci-icon-tight.svg", 48), ...[32, 24, 16].map(small)];
  const zoomed = [32, 24, 16].map((size) => zoom(small(size), 6));
  const rows = [];
  for (const [background, mark] of [["#FBF8F3", lockups[0]], ["#1B1814", lockups[1]]]) {
    rows.push(strip(masterRow, background), strip(sizes, background), strip([...zoomed, mark], background));
  }
  run("magick", [...rows, "-background", "#FBF8F3", "-gravity", "west", "-append", sheet]);
  console.log(`Review sheet: ${sheet}`);
}
rmSync(temp, { recursive: true });
