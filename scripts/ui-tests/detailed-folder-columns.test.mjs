// Detailed's folder list (ui/src/views/folder.tsx) gives up columns by its own width, as
// ui/src/styles/detailed.css says it, instead of squeezing Summary: with the side panel open a 1440 px
// window left Summary 20 px, one letter and an ellipsis. The list is laid out here as the sheet's flex
// rules lay it out, at every width, with no browser: Summary is 160 px or more, or not there at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../../ui/src/${file}`, import.meta.url), "utf8");
const css = read("styles/detailed.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The sheet as nested blocks: { prelude, body } for a rule, { prelude, blocks } for an at-rule. */
function blocksOf(text) {
  const found = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const prelude = text.slice(start, open).trim();
        const inner = text.slice(open + 1, i);
        found.push(
          prelude.startsWith("@") ? { prelude, blocks: blocksOf(inner) } : { prelude, body: inner },
        );
        start = i + 1;
      }
    }
  }
  return found;
}

const declarations = (body) =>
  Object.fromEntries(
    body
      .split(";")
      .map((d) => d.split(":").map((part) => part.trim()))
      .filter(([property, value]) => property && value),
  );
const selectorsOf = (prelude) => prelude.split(",").map((s) => s.trim());
const sheet = blocksOf(css);

/** What the sheet's rules outside any @media or @container set for `selector`, merged in order. */
function topRule(selector) {
  const merged = {};
  for (const block of sheet)
    if (block.body !== undefined && selectorsOf(block.prelude).includes(selector))
      Object.assign(merged, declarations(block.body));
  return merged;
}

const COLUMNS = ["c-name", "c-sum", "c-stack", "c-ai", "c-when", "c-size", "c-health"];
const px = (value) => Number(/^(\d+(?:\.\d+)?)px$/.exec(value)?.[1]);
const basisOf = (flex) => px(flex.split(/\s+/)[2]);

/** The folder list's container queries: [the width it applies below, { column: declarations }]. */
const queries = sheet
  .filter((block) => block.blocks && /^@container\s+folder-list\b/.test(block.prelude))
  .map((block) => {
    const below = /\(\s*width\s*<\s*(\d+)px\s*\)/.exec(block.prelude);
    assert.ok(below, `${block.prelude} says the width it applies below as (width < N px)`);
    const rules = {};
    for (const rule of block.blocks)
      for (const selector of selectorsOf(rule.prelude))
        rules[selector.replace(/^\./, "")] = {
          ...rules[selector.replace(/^\./, "")],
          ...declarations(rule.body),
        };
    return [Number(below[1]), rules];
  });

/** The row laid out `width` px wide: each column shown and its width, as flex lays it out. */
const item = topRule(".item");
const base = Object.fromEntries(COLUMNS.map((name) => [name, topRule(`.${name}`)]));
function layout(width) {
  const [, right, , left] = item.padding.split(/\s+/).map(px);
  const columns = COLUMNS.map((name) => {
    const style = { ...base[name] };
    for (const [below, rules] of queries) if (width < below) Object.assign(style, rules[name] ?? {});
    return { name, style, fixed: style.flex.split(/\s+/).length === 3 };
  }).filter(({ style }) => style.display !== "none");
  const growing = columns.filter((column) => !column.fixed);
  const taken = columns.reduce((sum, { style, fixed }) => sum + (fixed ? basisOf(style.flex) : 0), 0);
  const free = width - left - right - px(item.gap) * (columns.length - 1) - taken;
  const shown = Object.fromEntries(
    columns.map(({ name, style, fixed }) => [name, fixed ? basisOf(style.flex) : free / growing.length]),
  );
  Object.defineProperty(shown, "grows", { value: growing.map(({ name }) => name) });
  return shown;
}

export function theFolderListIsTheContainerItsColumnsAnswerTo() {
  assert.match(
    read("views/folder.tsx"),
    /className="[^"]*\bfolder-list\b[^"]*" role="grid" aria-label="Folder contents"/,
  );
  assert.equal(topRule(".folder-list").container, "folder-list / inline-size");
  assert.ok(queries.length > 0, "detailed.css has @container folder-list rules");
}

export function summaryIsWideEnoughToReadOrNotThereAtEveryWidth() {
  for (let width = 360; width <= 1800; width++) {
    const shown = layout(width);
    if ("c-sum" in shown) assert.ok(shown["c-sum"] >= 160, `${width} px: Summary is ${shown["c-sum"]} px`);
    // One column takes the room that is left: Summary, or Name once Summary has gone.
    assert.deepEqual(shown.grows, ["c-sum" in shown ? "c-sum" : "c-name"], `${width} px`);
    for (const [name, size] of Object.entries(shown)) assert.ok(size > 0, `${width} px: ${name}`);
  }
}

export function a1440PxWindowWithTheSidePanelOpenReadsTheSummary() {
  // The window's columns: the sidebar, the list, the side panel (inspector).
  const app = topRule(".app")["grid-template-columns"].split(/\s+/);
  const list = 1440 - px(app[0]) - px(topRule(".insp").width);
  assert.equal(list, 816);
  const shown = layout(list);
  assert.ok(shown["c-sum"] >= 160, `Summary is ${shown["c-sum"]} px`);
  assert.ok("c-name" in shown && "c-when" in shown && "c-ai" in shown);
}

export function aWideListKeepsEveryColumnAsItWas() {
  for (const width of [960, 1100, 1200, 1400, 1600]) {
    assert.deepEqual(Object.keys(layout(width)), COLUMNS, `${width} px`);
  }
  // A list too narrow for Summary is as the narrow window has it: Name, Modified and Health.
  assert.deepEqual(Object.keys(layout(600)), ["c-name", "c-when", "c-health"]);
}
