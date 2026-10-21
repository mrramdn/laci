// ui/src/simple/art: Simple's eight illustrations stay small, coloured through the theme's tokens,
// and safe to draw inline.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

const dir = new URL("../../ui/src/simple/art/", import.meta.url);
const NAMES = [
  "all-safe",
  "back-up",
  "no-chats",
  "no-projects",
  "no-summaries",
  "nothing-to-clean",
  "welcome",
  "went-wrong",
];
const svg = (name) => readFileSync(new URL(`${name}.svg`, dir), "utf8");
/** The classes that take a colour from the theme: the line, sand, and the paper and accent fills. */
const TONES = new Set(["a-sand", "a-sand-line", "a-ink", "a-soft", "a-paper"]);
/** What a viewer outside the app shows: the light theme's tokens, from Laci's mark. */
const FALLBACKS = new Set(["#E9DCC8", "#3B2A1E", "#FFD34E", "#FFF5DF", "none"]);

export async function thereAreEightAndEachIsSmall() {
  const files = readdirSync(dir).filter((file) => file.endsWith(".svg"));
  assert.deepEqual(files.map((file) => file.replace(/\.svg$/, "")).sort(), NAMES);
  for (const name of NAMES) {
    const bytes = statSync(new URL(`${name}.svg`, dir)).size;
    assert.ok(bytes < 8 * 1024, `${name}.svg is ${bytes} bytes`);
  }
}

export async function eachIsDrawnWithStrokesAndTheThemesTwoTones() {
  for (const name of NAMES) {
    const text = svg(name);
    assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 160 120"/, name);
    // Lucide's caps and joins, at Lucide's weight.
    assert.match(text, /stroke-linecap="round" stroke-linejoin="round"/, name);
    assert.match(text, /stroke-width="2"/, name);
    for (const [, classes] of text.matchAll(/class="([^"]*)"/g))
      for (const which of classes.split(/\s+/)) assert.ok(TONES.has(which), `${name}: class ${which}`);
    for (const [, color] of text.matchAll(/(?:fill|stroke)="([^"]*)"/g))
      assert.ok(FALLBACKS.has(color), `${name}: colour ${color}`);
    // Every coloured shape has a class, so the theme can recolour it.
    for (const [shape] of text.matchAll(/<(?:path|rect|circle)\b[^>]*>/g))
      assert.match(shape, /class="/, `${name}: ${shape}`);
  }
}

export async function nothingInThemRunsOrLoads() {
  for (const name of NAMES) {
    const text = svg(name);
    assert.doesNotMatch(text, /<(script|foreignObject|image|use|text|style)\b/i, name);
    assert.doesNotMatch(text, /\bon[a-z]+=|href=|url\(/i, name);
  }
}
