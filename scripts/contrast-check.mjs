// Checks colour contrast with WCAG 2.2's formula: 4.5 to 1 for text, 3 to 1 for the parts of an
// interface and for icons.
//
// Simple's colours are data below, from design-research §3.5 of the 3.0 plan, each pair with the
// contrast that research measured. A Simple pair under its minimum fails the run. Detailed's colours
// are read from its stylesheet, light and dark, and only reported: they stay as they are, so a pair
// under its minimum is listed and not failed.
// Usage: node scripts/contrast-check.mjs [--all] [--css <file>]
//   --all   list every Detailed pair, not only the ones under their minimum
//   --css   the stylesheet to read Detailed's colours from (default: ui/src/styles/detailed.css,
//           else ui/src/style.css)
// Exit status: 1 when a Simple pair fails or Detailed's colours cannot be read.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const MIN = { text: 4.5, ui: 3 };

// --- The formula -------------------------------------------------------------------------------

/** `[r, g, b, a]` (0-255, alpha 0-1) for `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`, else null. */
export function parseColor(value) {
  const text = String(value).trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
  if (hex) {
    const full =
      hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const [r, g, b, a] = [0, 2, 4, 6].map((at) =>
      full.length > at ? parseInt(full.slice(at, at + 2), 16) : 255,
    );
    return [r, g, b, a / 255];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(text)?.[1];
  if (!fn) return null;
  const parts = fn.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const channel = (part) =>
    part.endsWith("%") ? (parseFloat(part) * 255) / 100 : parseFloat(part);
  const alpha =
    parts.length === 4
      ? parts[3].endsWith("%")
        ? parseFloat(parts[3]) / 100
        : parseFloat(parts[3])
      : 1;
  const color = [...parts.slice(0, 3).map(channel), alpha];
  return color.every(Number.isFinite) ? color : null;
}

/** `color` laid over the opaque `base`: what the eye gets from a tint or an overlay. */
export function over(color, base) {
  const alpha = color[3] ?? 1;
  return [0, 1, 2].map((i) => color[i] * alpha + base[i] * (1 - alpha));
}

export function luminance(color) {
  const [r, g, b] = color.slice(0, 3).map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours, 1 to 21. A foreground with alpha is laid over the background. */
export function contrast(foreground, background) {
  const fg = over(foreground, background);
  const [light, dark] = [luminance(fg), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (light + 0.05) / (dark + 0.05);
}

/** A ratio as shown: cut, never rounded up, so that 4.497 does not read as a pass at 4.50. */
export const show = (ratio) => (Math.floor(ratio * 100) / 100).toFixed(2);

// --- Simple, as researched ----------------------------------------------------------------------

/**
 * Simple's colours (design-research §3.5): a token for each, per theme. The decorative ones have no
 * minimum and are left out: `line` (#E6DED2 light, #39322B dark) and `sand` (#E9DCC8, #3B332A).
 */
export const SIMPLE = {
  light: {
    canvas: "#FBF8F3",
    surface: "#FFFFFF",
    sunken: "#F3EEE6",
    "line-strong": "#8C8174",
    ink: "#26211C",
    "ink-2": "#5E554B",
    "ink-3": "#71675C",
    brand: "#0E7268",
    "brand-fill": "#0E7268",
    "brand-hover": "#0B5D55",
    "on-brand": "#FFFFFF",
    "brand-soft": "#E2F1EE",
    "brand-ink": "#0A5A52",
    "attention-soft": "#FFF1D6",
    "attention-text": "#8A4B00",
    "attention-icon": "#B26200",
    "risk-soft": "#FDE8E5",
    "risk-text": "#A12A1F",
    "risk-icon": "#C2362A",
  },
  dark: {
    canvas: "#181512",
    surface: "#221E1A",
    sunken: "#12100D",
    "line-strong": "#7D7266",
    ink: "#F2EDE6",
    "ink-2": "#BDB3A7",
    "ink-3": "#A0968A",
    // In the dark the teal text and the teal button are two colours.
    brand: "#3CC4B4",
    "brand-fill": "#2BB3A3",
    "on-brand": "#0B1F1C",
    "brand-soft": "#133A35",
    "brand-ink": "#7FDDD1",
    "attention-soft": "#3A2A10",
    "attention-text": "#F4B860",
    "attention-icon": "#E9A23B",
    "risk-soft": "#3D1A16",
    "risk-text": "#FF8F80",
    "risk-icon": "#F26B5B",
  },
};

const T = MIN.text;
const U = MIN.ui;
/**
 * The pairs that must hold: a foreground, a background, the minimum, what the colour is for, and the
 * ratio the research measured for it as `[light, dark]` where it gave one. A pair whose token a theme
 * lacks (the button's hover colour in the dark) is not checked there.
 */
export const SIMPLE_PAIRS = [
  ["ink", "canvas", T, "body text"],
  ["ink", "surface", T, "body text", [15.95, 14.21]],
  ["ink", "sunken", T, "body text"],
  ["ink-2", "canvas", T, "secondary text"],
  ["ink-2", "surface", T, "secondary text", [7.3, 8.02]],
  ["ink-2", "sunken", T, "secondary text", [6.32]],
  ["ink-3", "canvas", T, "meta text"],
  ["ink-3", "surface", T, "meta text", [5.53, 5.69]],
  ["ink-3", "sunken", T, "meta text", [4.79]],
  ["on-brand", "brand-fill", T, "filled button label", [5.79, 6.58]],
  ["on-brand", "brand-hover", T, "filled button label, hovered", [7.75]],
  ["brand", "canvas", T, "links"],
  ["brand", "surface", T, "links", [5.79, 7.68]],
  ["brand", "sunken", T, "links"],
  ["brand-ink", "brand-soft", T, "Safe chip, selected item", [6.95, 7.82]],
  ["attention-text", "attention-soft", T, "Soon chip", [6.09, 7.82]],
  ["attention-text", "surface", T, "Soon text"],
  ["risk-text", "risk-soft", T, "Act now chip", [6.23, 6.99]],
  ["risk-text", "surface", T, "Act now text"],
  ["line-strong", "surface", U, "input borders", [3.81, 3.52]],
  ["line-strong", "canvas", U, "input borders"],
  ["brand", "canvas", U, "focus ring"],
  ["brand", "surface", U, "focus ring"],
  ["brand-fill", "canvas", U, "filled button edge"],
  ["brand-fill", "surface", U, "filled button edge"],
  ["attention-icon", "surface", U, "Soon icon", [4.53, 7.64]],
  ["attention-icon", "attention-soft", U, "Soon icon on its chip"],
  ["risk-icon", "surface", U, "Act now icon", [5.45, 5.54]],
  ["risk-icon", "risk-soft", U, "Act now icon on its chip"],
];

/** One row for each pair and theme: what was measured, against what it has to be. */
export function simpleRows(colors = SIMPLE, pairs = SIMPLE_PAIRS) {
  const rows = [];
  for (const [theme, tokens] of Object.entries(colors))
    for (const [fg, bg, min, use, measured] of pairs) {
      if (!tokens[fg] || !tokens[bg]) continue;
      const ratio = contrast(parseColor(tokens[fg]), parseColor(tokens[bg]));
      rows.push({
        theme,
        fg,
        bg,
        use,
        min,
        ratio,
        ok: ratio >= min,
        measured: measured?.[theme === "light" ? 0 : 1],
      });
    }
  return rows;
}

// --- Detailed, read from its stylesheet ----------------------------------------------------------

/** The top-level rules of `css` as `{ prelude, body }`, with comments gone. */
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  let depth = 0;
  let start = 0;
  let bodyFrom = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") {
      if (depth++ === 0) bodyFrom = i + 1;
    } else if (char === "}" && depth > 0 && --depth === 0) {
      found.push({
        prelude: text.slice(start, bodyFrom - 1).trim(),
        body: text.slice(bodyFrom, i),
      });
      start = i + 1;
    } else if (char === ";" && depth === 0) start = i + 1;
  }
  return found;
}

const normal = (selector) => selector.replace(/\s+/g, "").replaceAll("'", '"');
const selectors = (prelude) => prelude.split(",").map(normal);

/** The custom properties a rule body declares, in order. */
function declarations(body) {
  const found = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g))
    found[name] = value.trim();
  return found;
}

/**
 * Detailed's colour tokens as the stylesheet writes them: `light` (`:root`), `dark` (the explicit
 * `:root[data-theme="dark"]`) and `systemDark` (the same under `prefers-color-scheme: dark`, for
 * a system set to dark). Each is a map from a token name, without `--`, to its text.
 */
export function readTokens(css) {
  const top = rules(css);
  const merge = (list) => Object.assign({}, ...list.map((r) => declarations(r.body)));
  const at = (list, selector) =>
    list.filter((r) => selectors(r.prelude).includes(normal(selector)));
  const media = top
    .filter((r) => /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/.test(r.prelude))
    .flatMap((r) => rules(r.body));
  return {
    light: merge(at(top, ":root")),
    dark: merge(at(top, ':root[data-theme="dark"]')),
    systemDark: merge(at(media, ':root:not([data-theme="light"])')),
  };
}

/** `name` of a token map as a colour, following `var(--other)`; null when it is not a colour. */
export function colorOf(tokens, name, seen = new Set()) {
  const value = tokens[name];
  if (value === undefined || seen.has(name)) return null;
  const alias = /^var\(\s*--([\w-]+)\s*\)$/.exec(value);
  return alias
    ? colorOf(tokens, alias[1], new Set([...seen, name]))
    : parseColor(value);
}

const SURFACES = ["bg", "sidebar", "subtle", "surface", "surface-hover", "surface-active"];
/** Tints are drawn over the page or over a card. */
const BASES = ["bg", "surface"];
/**
 * Detailed's pairs: text on each surface, the colours it uses for words on the page and on their own
 * tint, and the colours that draw glyphs. `[foreground, background, minimum, what it is]`; a
 * background written `soft-token/base` is that tint laid over the base.
 */
export const DETAILED_PAIRS = [
  ...["text", "muted", "faint"].flatMap((fg) =>
    SURFACES.map((bg) => [fg, bg, T, "text"]),
  ),
  ...["accent", "green-text", "amber-text", "red-text"].flatMap((fg) =>
    ["bg", "surface", "subtle", "sidebar"].map((bg) => [fg, bg, T, "coloured text"]),
  ),
  ...[
    ["accent", "accent-soft"],
    ["green-text", "green-soft"],
    ["amber-text", "amber-soft"],
    ["red-text", "red-soft"],
    ["purple", "purple-soft"],
  ].flatMap(([fg, soft]) =>
    BASES.map((base) => [fg, `${soft}/${base}`, T, "text on its tint"]),
  ),
  ["on-accent", "accent", T, "primary button label"],
  ["on-accent", "accent-hover", T, "primary button label, hovered"],
  ...["accent", "green", "amber", "red", "purple"].flatMap((fg) =>
    BASES.map((bg) => [fg, bg, U, "icon or mark"]),
  ),
];

/** One row for each pair that Detailed's tokens can answer, in `theme`. */
export function detailedRows(theme, tokens, pairs = DETAILED_PAIRS) {
  const rows = [];
  const opaque = (name) => {
    const color = colorOf(tokens, name);
    return color && (color[3] ?? 1) === 1 ? color : null;
  };
  for (const [fg, bgName, min, use] of pairs) {
    const [tint, base] = bgName.split("/");
    const foreground = colorOf(tokens, fg);
    const underneath = base ? opaque(base) : null;
    const tinted = base ? colorOf(tokens, tint) : null;
    const background = base
      ? underneath && tinted && over(tinted, underneath)
      : opaque(bgName);
    if (!foreground || !background) continue;
    const ratio = contrast(foreground, background);
    rows.push({ theme, fg, bg: bgName, use, min, ratio, ok: ratio >= min });
  }
  return rows;
}

/** Where Detailed's colours are written: its own stylesheet once the styles are split, else style.css. */
export function detailedCss(base = root) {
  return [
    path.join(base, "ui", "src", "styles", "detailed.css"),
    path.join(base, "ui", "src", "style.css"),
  ].find((file) => existsSync(file));
}

// --- The run ------------------------------------------------------------------------------------

/** One pair as a line. `under` names a pair below its minimum: Simple's fails, Detailed's is low. */
const line = (row, under) =>
  `${row.ok ? "ok  " : under}  ${show(row.ratio).padStart(5)}  min ${String(row.min).padEnd(3)}  ` +
  `${row.fg} on ${row.bg} (${row.use})`;

/**
 * Runs the check. Returns `{ failed, lines }`: whether the run fails, and what it said. `css` is
 * the text of Detailed's stylesheet, or undefined when there is none. `colors` are Simple's.
 */
export function check({ css, cssName = "the stylesheet", all = false, colors = SIMPLE } = {}) {
  const lines = [];
  const say = (text = "") => lines.push(text);
  let failed = false;

  const simple = simpleRows(colors);
  say(`Simple (design-research §3.5): ${simple.length} pairs`);
  for (const theme of Object.keys(colors)) {
    say(`  ${theme}`);
    for (const row of simple.filter((r) => r.theme === theme))
      say(`    ${line(row, "FAIL")}`);
  }
  const bad = simple.filter((row) => !row.ok);
  if (bad.length) failed = true;
  say(
    bad.length
      ? `Simple: ${bad.length} of ${simple.length} pairs are under their minimum.`
      : `Simple: all ${simple.length} pairs meet their minimum.`,
  );

  say();
  if (css === undefined) {
    failed = true;
    say("Detailed: no stylesheet found (ui/src/styles/detailed.css or ui/src/style.css).");
    return { failed, lines };
  }
  const tokens = readTokens(css);
  // The dark block only overrides: whatever it leaves out comes from `:root`.
  const themes = { light: tokens.light, dark: { ...tokens.light, ...tokens.dark } };
  const missing = Object.entries(themes).filter(([, set]) => !colorOf(set, "text"));
  if (missing.length) {
    failed = true;
    const names = missing.map(([theme]) => theme).join(" and ");
    say(`Detailed: could not read the ${names} colours from ${cssName}.`);
    return { failed, lines };
  }
  const rows = Object.entries(themes).flatMap(([theme, set]) => detailedRows(theme, set));
  const shown = all ? rows : rows.filter((row) => !row.ok);
  const low = rows.filter((row) => !row.ok).length;
  say(`Detailed (${cssName}, report only): ${rows.length} pairs, ${low} under their minimum`);
  for (const theme of Object.keys(themes))
    for (const row of shown.filter((r) => r.theme === theme))
      say(`  ${theme.padEnd(5)} ${line(row, "low ")}`);
  // The same dark colours are written twice, for the system and for the choice in Settings.
  const drift = Object.keys({ ...tokens.dark, ...tokens.systemDark }).filter(
    (name) => tokens.dark[name] !== tokens.systemDark[name],
  );
  if (drift.length)
    say(
      `Detailed: the dark colours differ between the system's and the explicit block: ${drift.join(", ")}`,
    );
  return { failed, lines };
}

function main(argv) {
  const css = argv.includes("--css")
    ? argv[argv.indexOf("--css") + 1]
    : detailedCss();
  const { failed, lines } = check({
    css: css && existsSync(css) ? readFileSync(css, "utf8") : undefined,
    cssName: css ? path.relative(root, path.resolve(css)) : undefined,
    all: argv.includes("--all"),
  });
  console.log(lines.join("\n"));
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2));
