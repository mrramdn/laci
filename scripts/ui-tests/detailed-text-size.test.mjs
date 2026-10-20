// Detailed's text is at least 12 px (M5): its stylesheets (ui/src/styles) and the sizes written inline
// in its components. Every font-size and font shorthand gives 12 px or more, in px; a size relative
// to its parent (em, rem, %, smaller…) would hide one under 12. <small>, which the browser draws a
// size down, is set to 12 px. Simple (ui/src/simple) has its own floor of 13 px, checked by
// `ui-preview-check.mjs --rules`. A size of 0, which hides words on purpose, is allowed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN = 12;
const src = fileURLToPath(new URL("../../ui/src/", import.meta.url));
const SHEETS = ["styles/detailed.css", "styles/looks.css"];

/** Detailed's .tsx files: everything under ui/src but Simple's folder and the preview. */
function components(dir = src) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["simple", "preview"].includes(entry.name)) found.push(...components(full));
    } else if (entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/** Each declaration of a sheet that sets a size: [line, property, value]. */
function sizesIn(css) {
  const found = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[;{\s])(font-size|font)\s*:\s*([^;}]+)/g))
      found.push([i + 1, m[1], m[2].trim()]);
  });
  return found;
}

/** What is wrong with one size, or null. A font shorthand's size is its first length. */
function problemOf(property, value) {
  // 0 hides the words of a badge that the narrow sidebar draws as a dot.
  if (property === "font-size" && /^(0|inherit|initial|unset|revert)$/.test(value)) return null;
  if (/\b(smaller|x-small|xx-small|small)\b/.test(value)) return `"${value}" is a size down`;
  const size = property === "font" ? value.match(/(?:^|\s)(\d*\.?\d+)(px|r?em|%)/) : value.match(/^(\d*\.?\d+)(px|r?em|%)$/);
  if (!size) return property === "font" ? null : `"${value}" is not a size in px`;
  if (size[2] !== "px") return `${size[1]}${size[2]} depends on its parent: write it in px`;
  return Number(size[1]) < MIN ? `${size[1]} px is under ${MIN} px` : null;
}

export async function detailedSheetsHaveNoTextUnder12px() {
  const problems = [];
  for (const sheet of SHEETS) {
    const css = readFileSync(path.join(src, sheet), "utf8");
    const sizes = sizesIn(css);
    assert.ok(sizes.length > 0, `${sheet} sets no sizes: has it moved?`);
    for (const [line, property, value] of sizes) {
      const problem = problemOf(property, value);
      if (problem) problems.push(`ui/src/${sheet}:${line} ${property}: ${value} (${problem})`);
    }
  }
  assert.deepEqual(problems, [], `Detailed's text goes under ${MIN} px:\n${problems.join("\n")}`);
}

export async function smallIsSetTo12px() {
  const css = readFileSync(path.join(src, "styles/detailed.css"), "utf8");
  assert.match(css, /(^|\n)small \{\n {2}font-size: 12px;\n\}/, "detailed.css sets <small> to 12 px");
}

export async function detailedInlineSizesAreAtLeast12px() {
  const problems = [];
  const files = components();
  assert.ok(files.some((file) => file.endsWith("inspector.tsx")), "the inspector is among them");
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/fontSize\s*:\s*("[^"]*"|'[^']*'|[\d.]+)/g)) {
        const raw = m[1].replace(/^["']|["']$/g, "");
        const value = /^[\d.]+$/.test(raw) ? `${raw}px` : raw;
        const problem = problemOf("font-size", value);
        if (problem) problems.push(`${path.relative(src, file)}:${i + 1} fontSize ${m[1]} (${problem})`);
      }
    });
  }
  assert.deepEqual(problems, [], `Detailed's inline text goes under ${MIN} px:\n${problems.join("\n")}`);
}

export async function theCheckCatchesWhatItShould() {
  assert.equal(problemOf("font-size", "12px"), null);
  assert.equal(problemOf("font-size", "13.5px"), null);
  assert.match(problemOf("font-size", "11.5px"), /under 12/);
  assert.match(problemOf("font-size", "0.8em"), /depends on its parent/);
  assert.match(problemOf("font-size", "smaller"), /size down/);
  assert.equal(problemOf("font", "500 12px var(--mono)"), null);
  assert.equal(problemOf("font", "12px/1.5 var(--mono)"), null);
  assert.match(problemOf("font", "500 11px var(--mono)"), /under 12/);
  assert.match(problemOf("font", "11.5px/1.5 var(--mono)"), /under 12/);
  assert.equal(problemOf("font", "inherit"), null);
  assert.equal(problemOf("font-size", "0"), null);
  const sizes = sizesIn(".a {\n  font-size: 10px; /* font-size: 9px */\n}\n.b { font: 600 11px x; }");
  assert.deepEqual(sizes, [
    [2, "font-size", "10px"],
    [4, "font", "600 11px x"],
  ]);
}
