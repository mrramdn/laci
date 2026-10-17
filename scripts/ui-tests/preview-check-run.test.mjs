// What scripts/ui-preview-check.mjs makes of what its shots find: which screens Simple may lack,
// what is retried, what fails the run, and what it prints. The page is answered for, so there is no
// browser here.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  drawing,
  loadPixels,
  nameOf,
  parseArgs,
  print,
  takeShots,
} from "../ui-preview-check.mjs";

/** A shot of `screen` in `design`. */
const shotOf = (design, screen, width = 1440) => ({
  design,
  theme: "light",
  size: { width, height: 900 },
  screen,
});

/** A PNG of 4x3 pixels, white but for what `paint` says. */
function image(PNG, paint = () => [255, 255, 255, 255]) {
  const png = new PNG({ width: 4, height: 3 });
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) png.data.set(paint(x, y), (y * 4 + x) * 4);
  return PNG.sync.write(png);
}

/** Runs `body` with console.log collected, and returns the lines. */
async function printed(body) {
  const lines = [];
  const log = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await body();
  } finally {
    console.log = log;
  }
  return lines;
}

/**
 * Takes `shots` with a `visit` that answers from `reply({ side, shot, want })`. Returns what was
 * found, and each visit that was asked for.
 */
async function taken({ args = [], sides = ["new"], shots, reply, out, pixels }) {
  const options = parseArgs(["--jobs", "1", ...args]);
  const trees = sides.map((name) => ({
    name,
    label: name === "ref" ? "main (abc1234)" : "the working tree",
  }));
  const asked = [];
  const wants = [];
  const visit = async ({ side, shot, want }) => {
    asked.push(`${side.name} ${nameOf(shot)}`);
    wants.push({ side: side.name, ...want });
    return {
      png: null,
      problems: [],
      overflow: null,
      rules: null,
      axe: null,
      failed: null,
      failure: null,
      ...reply({ side: side.name, shot, want }),
    };
  };
  const problems = [];
  const notes = new Set();
  const want = {
    shoot: Boolean(out),
    axe: options.axe,
    overflow: options.overflow,
    rules: options.rules,
  };
  let report;
  await printed(async () => {
    report = await takeShots({
      options,
      want,
      out,
      trees,
      browser: null,
      axePath: null,
      pixels,
      shots,
      problems,
      notes,
      visit,
    });
  });
  return { report, problems, notes, asked, wants, options, trees };
}

/** Prints what `run` found and returns the lines and the problems that printing added. */
async function said(run, { drawn, shots, out = null }) {
  const problems = [...run.problems];
  const lines = await printed(() =>
    print({
      options: run.options,
      out,
      trees: run.trees,
      drawn,
      shots,
      report: run.report,
      problems,
      notes: run.notes,
    }),
  );
  return { lines, problems };
}

async function inFolder(body) {
  const out = mkdtempSync(path.join(os.tmpdir(), "laci-preview-check-"));
  try {
    return await body(out);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export async function aSimpleScreenThatDoesNotShowIsNotedOnceAndItsOtherShotsAreSkipped() {
  const shots = [
    shotOf("simple", "today", 720),
    shotOf("simple", "log", 720),
    shotOf("simple", "log", 840),
    shotOf("simple", "log", 1200),
  ];
  const run = await taken({
    shots,
    reply: ({ shot }) =>
      shot.screen === "log" ? { failed: "locator.click: Timeout 8000ms exceeded." } : {},
  });
  assert.deepEqual([...run.report.missing.keys()], ["simple log"]);
  assert.match(run.report.missing.get("simple log"), /Timeout 8000ms/);
  assert.deepEqual(run.problems, [], "a screen that Simple lacks yet is not a failure");
  assert.equal(run.asked.filter((visit) => visit.includes(" log ")).length, 1, "the rest are not tried");
  assert.equal(run.asked.filter((visit) => visit.includes(" today ")).length, 1);
  const { lines, problems } = await said(run, { drawn: ["simple"], shots });
  assert.ok(lines.some((line) => line.startsWith("simple log: not shown yet (locator.click")));
  assert.ok(lines.includes("Simple lacks 1 screen. --strict fails on that."));
  assert.deepEqual(problems, []);
}

export async function withStrictAScreenSimpleLacksFailsAndItsPictureIsKept() {
  await inFolder(async (out) => {
    const run = await taken({
      args: ["--strict"],
      shots: [shotOf("simple", "log", 720), shotOf("simple", "log", 840)],
      out,
      reply: () => ({ failed: "no such place", failure: Buffer.from("a picture") }),
    });
    assert.equal(run.report.missing.size, 0);
    assert.equal(run.problems.length, 2);
    assert.match(
      run.problems[0],
      /^log simple light 720x900: the screen did not show: no such place \(picture: .*failed-new-log-simple-light-720x900\.png\)$/,
    );
    assert.equal(run.asked.length, 4, "each shot is tried a second time first");
    assert.ok(readdirSync(out).includes("failed-new-log-simple-light-720x900.png"));
  });
}

export async function aDetailedScreenIsTriedAgainOnceBeforeItFailsTheRun() {
  const shots = [shotOf("detailed", "agents")];
  let calls = 0;
  const flaky = await taken({ shots, reply: () => (++calls === 1 ? { failed: "Timeout" } : {}) });
  assert.deepEqual(flaky.problems, []);
  assert.equal(flaky.asked.length, 2);
  const broken = await taken({ shots, reply: () => ({ failed: "Timeout" }) });
  assert.deepEqual(broken.problems, [
    "agents detailed light 1440x900: the screen did not show: Timeout",
  ]);
  assert.equal(broken.asked.length, 2);
  assert.equal(broken.report.missing.size, 0, "only Simple may lack a screen");
}

export async function whatTheOlderBuildLogsIsANoteAndWhatTheNewOneLogsFailsTheRun() {
  const shots = [shotOf("detailed", "today")];
  const logs = (who) => ({ side }) =>
    side === who ? { problems: ["console error: boom", "console error: boom"] } : {};
  const older = await taken({ sides: ["ref", "new"], shots, reply: logs("ref") });
  assert.deepEqual(older.problems, []);
  assert.deepEqual([...older.notes], [
    "today detailed light 1440x900 in main (abc1234): console error: boom",
  ]);
  const newer = await taken({ sides: ["ref", "new"], shots, reply: logs("new") });
  assert.deepEqual(newer.problems, [
    "today detailed light 1440x900 in the working tree: console error: boom",
  ]);
  assert.equal(newer.notes.size, 0);
}

export async function onlyTheWorkingTreeIsMeasuredForOverflowRulesAndAxe() {
  const quietPage = { scrollWidth: 720, clientWidth: 720, offenders: [] };
  const run = await taken({
    args: ["--overflow", "--rules", "--axe"],
    sides: ["ref", "new"],
    shots: [shotOf("simple", "today")],
    reply: ({ side }) =>
      side === "ref"
        ? {
            overflow: { scrollWidth: 900, clientWidth: 720, offenders: ["div ends at 900 px"] },
            rules: [{ rule: "target", text: "10x10 px", where: "button" }],
            axe: [{ id: "x", impact: "critical", help: "h", nodes: ["a"] }],
          }
        : { overflow: quietPage, rules: [], axe: [] },
  });
  assert.deepEqual(run.report.overflow, []);
  assert.deepEqual(run.report.rules, []);
  assert.equal(run.report.axe.size, 0);
  assert.deepEqual(
    run.wants.map(({ side, overflow, rules, axe }) => [side, overflow, rules, axe]),
    [
      ["ref", false, false, false],
      ["new", true, true, true],
    ],
    "the checks are asked of the working tree alone",
  );
  // Rules are Simple's: a Detailed shot does not ask for them.
  const detailed = await taken({
    args: ["--rules"],
    shots: [shotOf("detailed", "today")],
    reply: () => ({}),
  });
  assert.equal(detailed.wants[0].rules, false);
}

export async function changedPixelsAreCountedForEachScreenAndKeptWhereTheyAre() {
  const pixels = await loadPixels();
  const { PNG } = pixels;
  await inFolder(async (out) => {
    const white = image(PNG);
    const off = image(PNG, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const shots = [
      shotOf("detailed", "today", 720),
      shotOf("detailed", "today", 840),
      shotOf("detailed", "log", 720),
    ];
    const run = await taken({
      args: ["--compare", "main"],
      sides: ["ref", "new"],
      shots,
      out,
      pixels,
      reply: ({ side, shot }) => ({
        png: side === "new" && shot.screen === "today" && shot.size.width === 720 ? off : white,
      }),
    });
    assert.equal(run.report.changed, 1);
    assert.deepEqual(
      [...run.report.compare].map(([screen, row]) => [screen, row.shots, row.changed, row.pixels]),
      [
        ["today", 2, 1, 1],
        ["log", 1, 0, 0],
      ],
    );
    assert.deepEqual(run.report.compare.get("today").files, [
      "today-detailed-light-720x900.png: 1 pixel",
    ]);
    assert.deepEqual(readdirSync(path.join(out, "diff")), ["today-detailed-light-720x900.png"]);
    assert.equal(readdirSync(path.join(out, "ref")).length, 3);
    assert.equal(readdirSync(path.join(out, "new")).length, 3);

    // What it says: a table by screen, the files that changed, and a problem that fails the run.
    const { lines, problems } = await said(run, { drawn: ["detailed"], shots, out });
    assert.ok(lines.some((line) => line.trim() === "Compared with main (abc1234):"));
    assert.ok(lines.some((line) => /^\s+today\s+2\s+1\s+1$/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /^\s+log\s+1\s+0\s+0$/.test(line)));
    assert.ok(lines.includes("  changed: today-detailed-light-720x900.png: 1 pixel"));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^1 shot changed against main \(abc1234\); see .*\/diff$/);
  });
}

export async function nothingChangedIsSaidSoAndDoesNotFailTheRun() {
  const pixels = await loadPixels();
  await inFolder(async (out) => {
    const white = image(pixels.PNG);
    const shots = [shotOf("detailed", "log", 720)];
    const run = await taken({
      args: ["--compare", "main"],
      sides: ["ref", "new"],
      shots,
      out,
      pixels,
      reply: () => ({ png: white }),
    });
    const { lines, problems } = await said(run, { drawn: ["detailed"], shots, out });
    assert.ok(lines.includes("  No pixel changed."));
    assert.deepEqual(problems, []);
  });
}

export async function imagesOfAnotherSizeAreNamedAsResizedInTheList() {
  const pixels = await loadPixels();
  const { PNG } = pixels;
  await inFolder(async (out) => {
    const tall = new PNG({ width: 4, height: 5 });
    const run = await taken({
      args: ["--compare", "main"],
      sides: ["ref", "new"],
      shots: [shotOf("detailed", "log", 720)],
      out,
      pixels,
      reply: ({ side }) => ({ png: side === "ref" ? image(PNG) : PNG.sync.write(tall) }),
    });
    assert.equal(run.report.changed, 1);
    assert.deepEqual(run.report.compare.get("log").files, [
      "log-detailed-light-720x900.png: 4x3 became 4x5",
    ]);
  });
}

export async function overflowRulesAndAxeAreReportedInOrderAndOnlySimpleFailsOnAxe() {
  const wide = { scrollWidth: 800, clientWidth: 720, offenders: ["div ends at 800 px"] };
  const shots = [
    shotOf("simple", "log", 720),
    shotOf("simple", "today", 720),
    shotOf("detailed", "today", 720),
  ];
  const axe = [
    { id: "color-contrast", impact: "serious", help: "Contrast", nodes: ["a", "b"] },
    { id: "region", impact: "moderate", help: "Landmarks", nodes: ["main"] },
  ];
  const run = await taken({
    args: ["--overflow", "--rules", "--axe"],
    shots,
    reply: ({ shot }) => ({
      overflow: shot.screen === "log" ? wide : null,
      rules:
        shot.design === "simple"
          ? [{ rule: "target", text: "10x10 px, under 24x24", where: "button" }]
          : [],
      axe,
    }),
  });
  const { lines, problems } = await said(run, { drawn: ["simple", "detailed"], shots });
  assert.ok(
    lines.includes("overflow: log simple light 720x900: 800 px of content in 720 px (div ends at 800 px)"),
  );
  assert.ok(
    lines.includes('rules: target: 10x10 px, under 24x24, button (2 shots, first log simple light 720x900)'),
    lines.join("\n"),
  );
  assert.ok(lines.includes("axe, simple (serious and critical fail): 2 rules"));
  assert.ok(lines.includes("axe, detailed (report only): 2 rules"));
  // Two Simple shots found each rule, and one Detailed shot did.
  const serious = lines.indexOf("  serious  color-contrast: 4 elements in 2 shots, Contrast");
  const moderate = lines.indexOf("  moderate region: 2 elements in 2 shots, Landmarks");
  assert.ok(serious >= 0 && serious < moderate, "the worse rule comes first");
  assert.ok(lines.includes("  serious  color-contrast: 2 elements in 1 shot, Contrast"));
  assert.ok(lines.includes("           e.g. a in log simple light 720x900"), "the example is first by name");
  assert.deepEqual(problems, [
    "1 shot scroll sideways",
    "1 rule break in Simple",
    "axe serious: color-contrast, 4 elements in Simple",
  ]);
}

/** Asks `drawing` about `designs` in the sides, with `verdicts[design][side]` as the answers. */
async function drawnIn(designs, sides, verdicts) {
  const trees = sides.map((name) => ({
    name,
    label: name === "ref" ? "main (abc1234)" : "the working tree",
  }));
  const problems = [];
  const notes = new Set();
  const found = await drawing({
    browser: null,
    trees,
    designs,
    problems,
    notes,
    look: async ({ side, design }) => verdicts[design][side.name],
  });
  return { found, problems, notes };
}

export async function aDesignIsShotWhereverItDrawsAndSkippedWhereItDoesNot() {
  const both = await drawnIn(["detailed", "simple"], ["new"], {
    detailed: { new: "yes" },
    simple: { new: "yes" },
  });
  assert.deepEqual(both.found, ["detailed", "simple"]);
  assert.deepEqual([...both.notes, ...both.problems], []);
  // A build with no Simple shell draws Detailed when asked for Simple. That is no failure.
  const noShell = await drawnIn(["detailed", "simple"], ["new"], {
    detailed: { new: "yes" },
    simple: { new: "no" },
  });
  assert.deepEqual(noShell.found, ["detailed"]);
  assert.deepEqual(
    [...noShell.notes],
    ["simple: skipped, there is no shell for it in the working tree yet"],
  );
  assert.deepEqual(noShell.problems, []);
}

export async function aDesignThatOnlyOneSideDrawsCannotBeComparedAndIsSkippedWithTheSide() {
  const older = await drawnIn(["simple"], ["ref", "new"], { simple: { ref: "no", new: "yes" } });
  assert.deepEqual(older.found, []);
  assert.deepEqual(
    [...older.notes],
    ["simple: skipped, there is no shell for it in main (abc1234) yet"],
  );
  const neither = await drawnIn(["simple"], ["ref", "new"], { simple: { ref: "no", new: "no" } });
  assert.deepEqual(
    [...neither.notes],
    ["simple: skipped, there is no shell for it in main (abc1234) and the working tree yet"],
  );
}

export async function aDesignThatDoesNotDrawAtAllFailsTheRun() {
  const broken = await drawnIn(["detailed"], ["ref", "new"], {
    detailed: { ref: "yes", new: "broken" },
  });
  assert.deepEqual(broken.found, []);
  assert.deepEqual(broken.problems, ["detailed did not draw in the working tree"]);
  assert.equal(broken.notes.size, 0);
}

export async function withoutASimpleShellTheRulesHaveNothingToCheck() {
  const run = await taken({
    args: ["--rules"],
    shots: [],
    reply: () => ({}),
  });
  const { lines, problems } = await said(run, { drawn: ["detailed"], shots: [] });
  assert.ok(lines.some((line) => line.startsWith("rules: these are Simple's, and Simple does not draw yet")));
  assert.deepEqual(problems, []);
}
