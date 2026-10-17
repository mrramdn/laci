// scripts/contrast-check.mjs: the formula, Simple's pairs (read from its tokens) against what the
// research measured, and Detailed's colours as the stylesheet writes them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  check,
  colorOf,
  contrast,
  detailedCss,
  detailedRows,
  luminance,
  over,
  parseColor,
  readSimpleTokens,
  readTokens,
  show,
  simpleColors,
  simpleCss,
  simpleRows,
} from "../contrast-check.mjs";

const script = fileURLToPath(new URL("../contrast-check.mjs", import.meta.url));
/** The text of Simple's tokens, and its colours as the pairs read them. */
const tokensText = () => readFileSync(simpleCss(), "utf8");
const simple = () => simpleColors(readSimpleTokens(tokensText()));

export async function theFormulaGivesWcagsEndpoints() {
  assert.equal(contrast(parseColor("#000"), parseColor("#fff")), 21);
  assert.equal(contrast(parseColor("#fff"), parseColor("#000")), 21);
  assert.equal(contrast(parseColor("#777"), parseColor("#777")), 1);
  // #767676 is the lightest grey that reaches 4.5 on white, and #777777 the first that does not.
  assert.ok(contrast(parseColor("#767676"), parseColor("#fff")) >= 4.5);
  assert.ok(contrast(parseColor("#777777"), parseColor("#fff")) < 4.5);
}

export async function colourWritingsAreRead() {
  assert.deepEqual(parseColor("#fff"), [255, 255, 255, 1]);
  assert.deepEqual(parseColor("#0E7268"), [14, 114, 104, 1]);
  assert.deepEqual(parseColor("rgba(255, 255, 255, 0.08)"), [255, 255, 255, 0.08]);
  assert.deepEqual(parseColor("rgb(0 0 0 / 50%)"), [0, 0, 0, 0.5]);
  assert.equal(parseColor("var(--x)"), null);
  assert.equal(parseColor("0 1px 2px black"), null);
}

export async function aTintOrOverlayIsJudgedOnTheColourItMakes() {
  assert.deepEqual(over([255, 255, 255, 0.5], [0, 0, 0]), [127.5, 127.5, 127.5]);
  // White text at half strength on black is the grey it looks like, not white.
  assert.ok(contrast([255, 255, 255, 0.5], [0, 0, 0]) < 21);
  assert.ok(luminance([255, 255, 255]) > luminance([127, 127, 127]));
}

export async function aRatioIsCutNeverRoundedUp() {
  assert.equal(show(4.499), "4.49");
  assert.equal(show(4.5), "4.50");
  assert.equal(show(21), "21.00");
}

export async function everySimplePairMeetsItsMinimum() {
  const colors = simple();
  const rows = simpleRows(colors);
  assert.ok(rows.length >= 60, `${rows.length} pairs`);
  assert.deepEqual(
    rows.filter((row) => !row.ok).map((row) => `${row.theme} ${row.fg} on ${row.bg}`),
    [],
  );
  for (const theme of ["light", "dark"]) assert.ok(rows.some((row) => row.theme === theme));
  assert.ok(rows.some((row) => row.min === 4.5) && rows.some((row) => row.min === 3));
}

export async function simplePairsReproduceWhatTheResearchMeasured() {
  const measured = simpleRows(simple()).filter((row) => row.measured !== undefined);
  assert.ok(measured.length >= 25, `${measured.length} pairs have a measured value`);
  // The research rounded to two places.
  for (const row of measured)
    assert.ok(
      Math.abs(row.ratio - row.measured) < 0.011,
      `${row.theme} ${row.fg} on ${row.bg}: ${row.ratio} against ${row.measured}`,
    );
}

export async function simpleColoursComeFromItsTokensInBothThemes() {
  const tokens = readSimpleTokens(tokensText());
  for (const set of [tokens.light, tokens.dark, tokens.systemDark])
    for (const name of ["canvas", "surface", "ink", "brand", "risk-text", "attention-text"])
      assert.ok(colorOf(set, name), `--${name}`);
  assert.ok(luminance(colorOf(tokens.light, "canvas")) > luminance(colorOf(tokens.dark, "canvas")));
  // The dark colours are written twice, for the system and for the theme chosen in the window.
  assert.deepEqual(tokens.systemDark, tokens.dark);
  // The parts both designs share take Simple's colours under Detailed's names.
  assert.deepEqual(colorOf(tokens.light, "accent"), colorOf(tokens.light, "brand"));
  assert.deepEqual(colorOf(tokens.light, "text"), colorOf(tokens.light, "ink"));
}

export async function aFailingSimplePairFailsTheRun() {
  const css = readFileSync(detailedCss(), "utf8");
  const tokens = tokensText();
  assert.equal(check({ css, tokens }).failed, false);
  const faded = structuredClone(simple());
  faded.light["ink-3"] = "#B0A598";
  const { failed, lines } = check({ css, tokens, colors: faded });
  assert.equal(failed, true);
  assert.ok(lines.some((line) => line.startsWith("FAIL") || line.includes("FAIL")));
  assert.ok(lines.some((line) => /Simple: \d+ of \d+ pairs are under their minimum/.test(line)));
}

export async function simpleTokensThatLackAColourOrDisagreeFailTheRun() {
  const css = readFileSync(detailedCss(), "utf8");
  const tokens = tokensText();
  // A colour the pairs need, gone from the light block.
  const lacking = tokens.replace(/--ink-3:\s*#[0-9a-f]+;/, "");
  assert.notEqual(lacking, tokens);
  const gone = check({ css, tokens: lacking });
  assert.equal(gone.failed, true);
  assert.ok(gone.lines.some((line) => line.includes("has no colour for --ink-3")));
  // The system's dark block and the chosen one must say the same.
  const block = /(:where\(:not\(\[data-theme="light"\]\)\)\s*\{[^}]*?--surface:\s*)#[0-9a-f]+;/;
  const split = tokens.replace(block, "$1#2a2520;");
  assert.notEqual(split, tokens);
  const differ = check({ css, tokens: split });
  assert.equal(differ.failed, true);
  assert.ok(differ.lines.some((line) => /Simple: the dark colours differ .*surface/.test(line)));
  // No tokens at all is a broken run.
  assert.equal(check({ css, tokens: undefined }).failed, true);
}

export async function tokensAreFoundWhereTheStylesheetWritesThem() {
  const css = `
    /* :root { --bg: #abcdef } */
    :root { --bg: #fff; --text: #111; --alias: var(--text); --shadow: 0 1px 2px rgba(0, 0, 0, .1); }
    @media (min-resolution: 1.5dppx) { :root { --bg: #f00; } }
    .x::after { content: "}"; }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) { --bg: #010101; --text: #eee; }
    }
    :root[data-theme='dark'] { --bg: #020202; --text: #eee; }
    :root { --more: #123456; }`;
  const tokens = readTokens(css);
  assert.equal(tokens.light.bg, "#fff", "a :root inside another rule or a comment is not Detailed's");
  assert.equal(tokens.light.more, "#123456", "a later :root adds to the first");
  assert.equal(tokens.systemDark.bg, "#010101");
  assert.equal(tokens.dark.bg, "#020202");
  assert.deepEqual(colorOf(tokens.light, "alias"), parseColor("#111"));
  assert.equal(colorOf(tokens.light, "shadow"), null);
  assert.equal(colorOf(tokens.light, "missing"), null);
}

export async function detailedTokensComeFromItsStylesheetInBothThemes() {
  const tokens = readTokens(readFileSync(detailedCss(), "utf8"));
  const names = ["bg", "sidebar", "subtle", "surface", "text", "muted", "faint", "accent"];
  for (const set of [tokens.light, tokens.dark, tokens.systemDark])
    for (const name of names) assert.ok(colorOf(set, name), `--${name}`);
  assert.ok(luminance(colorOf(tokens.light, "bg")) > luminance(colorOf(tokens.dark, "bg")));
  // The stylesheet writes the dark colours twice, for the system and for Settings.
  assert.deepEqual(tokens.systemDark, tokens.dark);
}

export async function detailedPairsLayTintsOverTheirBase() {
  const light = readTokens(readFileSync(detailedCss(), "utf8")).light;
  const rows = detailedRows("light", light);
  assert.ok(rows.length >= 50, `${rows.length} pairs`);
  const row = rows.find((r) => r.fg === "green-text" && r.bg === "green-soft/surface");
  const soft = over(colorOf(light, "green-soft"), colorOf(light, "surface"));
  assert.equal(row.ratio, contrast(colorOf(light, "green-text"), soft));
  const plain = rows.find((r) => r.fg === "text" && r.bg === "surface");
  assert.equal(plain.ratio, contrast(colorOf(light, "text"), colorOf(light, "surface")));
  assert.equal(plain.min, 4.5);
  // A pair whose token is not there is left out, not guessed.
  assert.deepEqual(detailedRows("light", { text: "#111" }), []);
}

export async function detailedIsReportedAndNeverFailsTheRun() {
  const css = readFileSync(detailedCss(), "utf8");
  const tokens = tokensText();
  const quiet = check({ css, tokens });
  assert.equal(quiet.failed, false);
  assert.match(quiet.lines.join("\n"), /Detailed \(.*report only\): \d+ pairs/);
  // --all lists every pair, not just the ones under their minimum.
  assert.ok(check({ css, tokens, all: true }).lines.length > quiet.lines.length);
  // Nothing to read is a broken run, as is a stylesheet without the colours.
  assert.equal(check({ css: undefined, tokens }).failed, true);
  assert.equal(check({ css: ":root { --x: 1px; }", tokens }).failed, true);
}

export async function theCommandReportsAndExitsWithTheResult() {
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const fine = run();
  assert.equal(fine.status, 0, fine.stdout + fine.stderr);
  assert.match(fine.stdout, /Simple: all \d+ pairs meet their minimum/);
  assert.match(fine.stdout, /Detailed \(.*\): \d+ pairs/);
  assert.match(fine.stdout, /Simple \(ui\/src\/simple\/tokens\.css\): \d+ pairs/);
  const none = run("--css", fileURLToPath(new URL("./no-such.css", import.meta.url)));
  assert.equal(none.status, 1);
  assert.match(none.stdout, /no stylesheet found/);
  const noTokens = run("--tokens", fileURLToPath(new URL("./no-such.css", import.meta.url)));
  assert.equal(noTokens.status, 1);
  assert.match(noTokens.stdout, /Simple: no tokens found/);
}
