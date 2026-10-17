// ui/src/simple/model.ts and the Countdown's clock: what Simple's pages work out from the scan, on
// the preview's demo home.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "../ui-module.mjs";

const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);
const model = load("simple/model.ts");
const { homeModel } = load("selectors.ts");
const { startCountdown } = load("simple/ui/countdown-clock.ts");
const ROOT = "/home/demo/project";
const NOW = new Date(fixtures.meta.now);
const scan = () => structuredClone(fixtures.snapshot);
const node = (snapshot, path) => snapshot.nodes[`${ROOT}/${path}`];

export async function aProjectIsAsSafeAsItsWorstProblem() {
  const s = scan();
  const safety = (path) => {
    const { tone, issue, noHistory } = model.safetyOf(node(s, path));
    return [tone, issue?.code, noHistory];
  };
  assert.deepEqual(safety("clients/kopi-landing"), ["act", "no-remote", false]);
  assert.deepEqual(safety("side/habit-app"), ["act", "no-remote", false]);
  assert.deepEqual(safety("clients/acme-store"), ["soon", "dirty", false]);
  assert.deepEqual(safety("side/dotfiles"), ["soon", "unpushed", false]);
  // Notes without version history: nothing at risk that Laci can see, but not "Safe" either.
  assert.deepEqual(safety("infra-notes"), ["fyi", undefined, true]);
  // A hidden warning doesn't count; the next one does, and none at all is safe.
  const kopi = node(s, "clients/kopi-landing");
  kopi.issues.find((i) => i.code === "no-remote").muted = true;
  assert.deepEqual(safety("clients/kopi-landing"), ["soon", "dirty", false]);
  kopi.issues.forEach((i) => (i.muted = true));
  assert.deepEqual(safety("clients/kopi-landing"), ["safe", undefined, false]);
  assert.deepEqual(model.hiddenIssues(kopi).map((i) => i.code), ["no-remote", "dirty"]);
}

export async function theIsItSafeCardListsTheChecksThatMatter() {
  const s = scan();
  const codes = (path) => model.safetyIssues(node(s, path)).map((i) => i.code);
  // Worst first; a missing README is not about safety, an old place for AI chats is.
  assert.deepEqual(codes("clients/acme-store"), ["dirty", "unpushed", "stale-cwd"]);
  assert.deepEqual(codes("side/habit-app"), ["no-remote"]);
  assert.deepEqual(model.toneOf("high"), "act");
  assert.deepEqual(model.toneOf("med"), "soon");
  assert.deepEqual(model.toneOf("low"), "fyi");
}

export async function theNumberInAProblemComesFromTheProject() {
  const s = scan();
  const count = (path, code) => {
    const n = node(s, path);
    return model.issueCount(n, n.issues.find((i) => i.code === code));
  };
  assert.equal(count("clients/kopi-landing", "no-remote"), 3);
  assert.equal(count("clients/kopi-landing", "dirty"), 1);
  // Unpushed versions without an upstream have no ahead count: the engine's own count is used.
  const dotfiles = node(s, "side/dotfiles");
  const unpushed = dotfiles.issues.find((i) => i.code === "unpushed");
  assert.equal(model.issueCount(dotfiles, unpushed), Number(/^\d+/.exec(unpushed.title)[0]));
  assert.equal(
    model.issueCount({ git: undefined }, { code: "stash", title: "2 forgotten stashes" }),
    2,
  );
}

export async function eachFixIsOfferedTheWaysItCanBeDone() {
  // The fixes the engine writes an AI prompt for: the agreed codes.
  assert.deepEqual(
    [...model.AI_FIXES].sort(),
    ["dirty", "diverged", "no-commits", "no-git", "no-remote", "stash", "unpushed"],
  );
  // Whatever saves or uploads a version is checked for secret files first, and can go to the AI.
  for (const code of model.SECRET_CHECKED) {
    assert.ok(model.AI_FIXES.has(code), code);
    assert.ok(model.TERMINAL_FIXES.has(code), code);
  }
  // Out of sync goes to the AI only: no upload or download button, as in Detailed.
  assert.ok(!model.TERMINAL_FIXES.has("diverged"));
  assert.ok(model.fixable("diverged") && model.fixable("behind"));
  assert.ok(!model.fixable("no-readme") && !model.fixable("stale-cwd"));
}

export async function notNowHidesANeedUntilTheNextDay() {
  const h = homeModel(scan(), NOW);
  const first = h.needs[0];
  assert.equal(model.needKey(first), `risk:${ROOT}/clients/kopi-landing:no-remote`);
  const none = model.homeCards(h, new Set());
  assert.equal(none.main, first);
  assert.equal(none.shown, h.needs.length);
  assert.deepEqual(none.needsYou, h.needs.slice(1, 4));
  // Hidden today: the next need leads, and "See all" counts one fewer.
  const day = model.dayOf(NOW);
  const stored = { day, keys: [model.needKey(first)] };
  const hidden = model.hiddenToday(stored, day);
  const cards = model.homeCards(h, hidden);
  assert.equal(cards.main, h.needs[1]);
  assert.equal(cards.shown, h.needs.length - 1);
  // The next day, or with storage that can't be read, nothing is hidden.
  assert.equal(model.hiddenToday(stored, "2099-01-01").size, 0);
  for (const junk of [null, "x", { day }, { day, keys: "x" }, { day, keys: [1, "k"] }])
    assert.ok(model.hiddenToday(junk, day).size <= 1);
  // Everything hidden: a quiet card says how many, never "Everything is safe".
  const all = new Set(h.needs.map(model.needKey));
  assert.deepEqual(model.homeCards(h, all).main, { kind: "quiet", hidden: h.needs.length });
  assert.equal(model.dayOf(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  // The sidebar counts what is "Act now" and not hidden: the two projects only on this computer.
  assert.equal(model.urgentCount(h, new Set()), 2);
  assert.equal(model.urgentCount(h, hidden), 1);
  assert.equal(model.urgentCount(h, all), 0);
  // A due date is a problem only once it has come.
  assert.deepEqual([-1, 0, 1, 2, 3, 9].map(model.dueTone), ["act", "act", "soon", "soon", "fyi", "fyi"]);
}

export async function projectsFilterSortAndSearch() {
  const s = scan();
  const list = (query) =>
    model
      .projectsModel(s, { filter: "all", query: "", sort: "name", folder: null, ...query }, NOW)
      .shown.map((n) => n.label);
  const { counts } = model.projectsModel(s, { filter: "all", query: "", sort: "recent", folder: null }, NOW);
  // All leaves archived projects out; Needs you is what Home lists, archived ones included.
  assert.deepEqual(counts, { all: 6, needs: 6, active: 4, archived: 1 });
  assert.deepEqual(list({ filter: "archived" }), ["old-portfolio"]);
  assert.deepEqual(
    list({ filter: "needs" }).sort(),
    homeModel(s, NOW).needs.map((need) => need.n.label).sort(),
  );
  assert.deepEqual(list({}), ["acme-store", "campus-lms", "dotfiles", "habit-app", "infra-notes", "kopi-landing"]);
  // The search reads the name, the description and what it is built with, every word.
  assert.deepEqual(list({ query: "coffee" }), ["acme-store", "kopi-landing"]);
  assert.deepEqual(list({ query: "Astro" }), ["kopi-landing"]);
  assert.deepEqual(list({ query: "coffee astro" }), ["kopi-landing"]);
  assert.deepEqual(list({ query: "nothing like it" }), []);
  // In one folder.
  assert.deepEqual(list({ folder: `${ROOT}/clients` }), ["acme-store", "kopi-landing"]);
  // Due dates first, then the most recent; the biggest first.
  assert.equal(list({ sort: "due" })[0], "acme-store");
  const sizes = model
    .projectsModel(s, { filter: "all", query: "", sort: "size", folder: null }, NOW)
    .shown.map((n) => n.size?.total ?? 0);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  const recent = model
    .projectsModel(s, { filter: "all", query: "", sort: "recent", folder: null }, NOW)
    .shown.map((n) => n.lastActivity?.at ?? "");
  assert.deepEqual(recent, [...recent].sort().reverse());
}

export async function inOffersTheFoldersThatHoldProjects() {
  const folders = model.projectFolders(scan()).map((n) => n.path.replace(`${ROOT}`, "~"));
  assert.deepEqual(folders, ["~", "~/clients", "~/side", "~/thesis"]);
}

/** Timers that run only when told to. */
function fakeTimers() {
  const due = new Map();
  let id = 0;
  return {
    timers: {
      setTimeout: (callback) => {
        due.set(++id, callback);
        return id;
      },
      clearTimeout: (which) => due.delete(which),
    },
    second() {
      const [[which, callback]] = due;
      due.delete(which);
      callback();
    },
    get waiting() {
      return due.size;
    },
  };
}

export async function theCountdownRunsOutOnceAndOnlyAtTheEnd() {
  const clock = fakeTimers();
  const said = [];
  let done = 0;
  const countdown = startCountdown(5, { tick: (left) => said.push(left), done: () => done++ }, clock.timers);
  assert.deepEqual(said, [], "nothing happens when it starts");
  for (let i = 0; i < 4; i++) clock.second();
  assert.deepEqual(said, [4, 3, 2, 1]);
  assert.equal(done, 0);
  clock.second();
  assert.equal(done, 1);
  assert.equal(clock.waiting, 0);
  // Too late to cancel: it already ran.
  assert.equal(countdown.cancel(), false);
}

export async function cancellingTheCountdownMeansItNeverRuns() {
  const clock = fakeTimers();
  let done = 0;
  const countdown = startCountdown(5, { tick: () => {}, done: () => done++ }, clock.timers);
  clock.second();
  clock.second();
  assert.equal(countdown.cancel(), true);
  assert.equal(clock.waiting, 0, "no timer is left to fire");
  assert.equal(countdown.cancel(), false, "a second cancel does nothing");
  assert.equal(done, 0);
}
