// Simple's Clean up (ui/src/simple/CleanUp.tsx and its part of ui/src/simple/model.ts): what Undo can
// take back comes first, one card is open at a time and holds the one filled button, each change is
// the request Detailed's Tidy sends, a blocked suggestion offers nothing, and whatever deletes for
// good waits for the Countdown, which sends nothing when it is cancelled.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";
import {
  describe,
  fakeTimers,
  heldDate,
  Host,
  keyEvent,
  simpleBlocks,
  standIn,
} from "./react-stand-in.mjs";

const { createElement } = requireUi("react");
const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);
// Compiled once, at the fixtures' time, and handed to each page drawn below.
const held = { Date: heldDate(fixtures.meta.now) };
const words = load("words.ts", {}, held);
const helpers = load("helpers.ts", {}, held);
const model = load("simple/model.ts", { "../helpers": helpers, "./helpers": helpers }, held);
const said = words.cleanup;
const ROOT = "/home/demo/project";
const scan = () => structuredClone(fixtures.snapshot);
const proposal = (category) => scan().proposals.find((p) => p.category === category);
const nothing = () => null;

const RECONNECT = "reconnect:-home-demo-project-old-portfolio";
const HABIT = `${ROOT}/side/habit-app`;
/** Leftover AI chats whose project folder Laci confirmed gone. */
const LEFTOVER = {
  id: "orphan:claude:/home/demo/project/gone-app:5e1f",
  category: "orphan",
  title: "2 Claude Code sessions for deleted gone-app",
  why: "~/project/gone-app no longer exists. Last used 2026-09-01.",
  confidence: "med",
  ops: [
    {
      kind: "move",
      label: "Quarantine (restorable)",
      from: "~/.claude/projects/-home-demo-project-gone-app",
      to: "~/.local/share/laci/orphans/claude",
    },
  ],
  action: {
    type: "quarantine",
    moves: [
      {
        from: "/home/demo/.claude/projects/-home-demo-project-gone-app",
        to: "claude/-home-demo-project-gone-app",
      },
    ],
  },
  availability: "missing",
  validation: { projects: [`${ROOT}/gone-app`] },
};
/** Leftover AI chats Laci can't check: the engine blocks them and says why. */
const BLOCKED = {
  id: "orphan:-media-usb-thesis",
  category: "orphan",
  title: "Detached history needs a location check",
  why: "The external drive has no recorded identity. Reconnect it and save its scan location in Settings before cleanup.",
  reason:
    "The external drive has no recorded identity. Reconnect it and save its scan location in Settings before cleanup.",
  blocked: true,
  availability: "unavailable",
  confidence: "med",
  ops: [{ kind: "move", label: "Quarantine (restorable)", from: "~/.claude/projects/-media-usb-thesis" }],
  action: { type: "quarantine", moves: [{ from: "/home/demo/.claude/projects/-media-usb-thesis", to: "claude/-media-usb-thesis" }] },
};
/** One project in two folders: nothing for Laci to apply. */
const TWICE = {
  id: "dup:9f2c",
  category: "duplicate",
  title: "kopi-landing exists in 2 places",
  why: "~/project/clients/kopi-landing and ~/backup/kopi-landing share their first commit. One is probably a stale copy.",
  confidence: "med",
  ops: [
    { kind: "keep", label: "~/project/clients/kopi-landing", detail: "last commit 2026-10-08 · 12 commits" },
    { kind: "keep", label: "~/backup/kopi-landing", detail: "last commit 2026-06-01 · 9 commits" },
  ],
};

// --- What Clean up offers ------------------------------------------------------------------------

export async function cleanUpOffersWhatUndoCanTakeBackFirstAndTheSurestFirst() {
  const view = model.cleanupView(scan());
  // The engine lists by kind; Simple puts what deletes for good after what Undo can take back.
  assert.deepEqual(
    view.items.map((item) => [item.p.id, item.tile, item.ready, item.undoable]),
    [
      [RECONNECT, "history", true, true],
      ["migration:stale-cwd", "history", true, true],
      [`archive:${HABIT}`, "archive", true, true],
      ["space:inactive", "space", true, false],
    ],
  );
  assert.equal(view.first, RECONNECT, "the first card that opens can be undone");
  const space = view.items.at(-1);
  const habit = fixtures.snapshot.nodes[HABIT];
  assert.deepEqual(space.nodes.map((n) => n.label), ["habit-app"]);
  assert.equal(space.bytes, habit.size.reclaimable);
  assert.equal(view.bytes, habit.size.reclaimable);
  // One tile for each kind there is, in Clean up's order, with what opens when it is chosen.
  assert.deepEqual(
    view.tiles.map((tile) => [tile.tile, tile.count, tile.bytes, tile.first]),
    [
      ["history", 2, 0, RECONNECT],
      ["space", 1, habit.size.reclaimable, "space:inactive"],
      ["archive", 1, 0, `archive:${HABIT}`],
    ],
  );
  assert.deepEqual(view.items[0].nodes.map((n) => n.label), ["old-portfolio"]);
}

export async function whatLaciCantMakeComesLastAndWhatDeletesForGoodNeverOpensByItself() {
  const s = scan();
  s.proposals = [TWICE, BLOCKED, proposal("space"), LEFTOVER];
  const view = model.cleanupView(s);
  assert.deepEqual(
    view.items.map((item) => item.p.id),
    [LEFTOVER.id, "space:inactive", TWICE.id, BLOCKED.id],
  );
  const [leftover, , twice, blocked] = view.items;
  assert.equal(view.first, LEFTOVER.id);
  assert.deepEqual([leftover.ready, leftover.undoable], [true, true]);
  assert.deepEqual(leftover.gone, ["gone-app"], "the folder that is gone, by name");
  assert.equal(blocked.ready, false, "blocked by the engine");
  assert.equal(twice.ready, false, "nothing to apply");
  assert.deepEqual(twice.nodes.map((n) => n.label), ["kopi-landing"], "the copy Laci knows");
  assert.deepEqual(
    view.tiles.map((tile) => [tile.tile, tile.count]),
    [["space", 1], ["leftover", 2], ["twice", 1]],
  );
  // With only what deletes for good left, no card opens by itself.
  s.proposals = [proposal("space")];
  assert.equal(model.cleanupView(s).first, undefined);
  s.proposals = [];
  assert.deepEqual(model.cleanupView(s), { items: [], tiles: [], bytes: 0, first: undefined });
}

export async function theSpaceLaciUsesListsWhatItCanEmptyFirst() {
  const storage = structuredClone(fixtures.storage);
  const part = (id) => storage.parts.find((p) => p.id === id);
  Object.assign(part("removed"), { bytes: 4096, free: 4096 });
  Object.assign(part("legacy"), { bytes: 1000, free: 1000 });
  const space = model.laciSpace(storage);
  assert.deepEqual(
    space.parts.map((p) => p.id),
    ["removed", "undo", "legacy", "history", "journal", "cache"],
  );
  assert.equal(space.free, 5096);
  // A part from a newer engine comes last, as the engine names it.
  storage.parts.unshift({ id: "new", label: "Something new", about: "", bytes: 1, free: 0 });
  assert.equal(model.laciSpace(storage).parts.at(-1).id, "new");
  // Every part the engine has today has Simple's words, and those Laci can empty a button.
  for (const { id, free } of fixtures.storage.parts) {
    assert.ok(said.laci.parts[id]?.label, id);
    if (["removed", "undo", "legacy"].includes(id))
      assert.ok(said.laci.parts[id].button && said.laci.parts[id].counting, id);
    assert.equal(free, 0, "the demo home has nothing to free");
  }
}

// --- The page --------------------------------------------------------------------------------------

/**
 * Clean up on the stand-in, at the fixtures' time, with the scan `snapshot` and the `storage` reply.
 * Each request gets the answer in `replies`, else an empty one; `sent` lists them in order, without
 * the reads of the space Laci uses.
 */
function cleanUpPage({ snapshot = scan(), storage = fixtures.storage, replies = {}, state = {} } = {}) {
  const page = standIn();
  const timers = fakeTimers();
  const asked = [];
  const runs = [];
  const changes = [];
  const toasts = [];
  const opened = [];
  const app = page.store({
    snapshot,
    historyPending: false,
    revision: 1,
    working: "",
    modal: null,
    palette: false,
    sheets: 0,
    ...state,
  });
  const globals = {
    ...held,
    document: page.document,
    HTMLElement: Host,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  // The real Countdown, on timers the test moves on.
  const { Countdown } = load(
    "simple/ui/Countdown.tsx",
    { react: page.react, "../../common": { Icon: nothing }, "../../words": words },
    globals,
  );
  const { CleanUp } = load(
    "simple/CleanUp.tsx",
    {
      "./cleanup-activity.css": {},
      "../helpers": helpers,
      "../words": words,
      "./model": model,
      react: page.react,
      "../api": {
        api: async (name, body) => {
          asked.push([name, body ?? {}]);
          if (name === "storage") return structuredClone(storage);
          const answer = replies[name];
          return typeof answer === "function" ? answer(body) : (answer ?? {});
        },
        errorText: (error) => (error instanceof Error ? error.message : String(error)),
      },
      "../clock": { useNow: () => Date.parse(fixtures.meta.now) },
      "../common": { Icon: nothing },
      "../store": {
        useApp: app,
        run: async (task, working, options) => {
          runs.push([working, options]);
          try {
            return await task();
          } catch (error) {
            toasts.push(["Couldn’t finish", String(error)]);
            return undefined;
          }
        },
        // As the store's own: the change moves the revision on, and Laci reads the history again.
        changed: (...args) => {
          changes.push(args);
          app.setState((s) => ({ revision: s.revision + 1, historyPending: true }));
        },
        toast: (...args) => toasts.push(args),
        goToProject: (id) => opened.push(id),
      },
      "./ui": simpleBlocks({ Countdown }),
    },
    globals,
  );
  page.mount(createElement(CleanUp));
  return {
    ...page,
    app,
    timers,
    runs,
    changes,
    toasts,
    opened,
    asked: (name) => asked.filter(([request]) => request === name),
    sent: () => asked.filter(([request]) => request !== "storage"),
    /** The row of the suggestion titled `title`: the button that opens and closes it. */
    toggle: (title) =>
      page.find((n) => n.props.className === "s-sug-toggle" && n.textContent.startsWith(title)),
    card: (title) =>
      page.find(
        (n) =>
          n.props["data-ui"] === "suggestion" &&
          n.descendants().some((d) => d.props.className === "s-sug-toggle" && d.textContent.startsWith(title)),
      ),
    filled: () =>
      page.all((n) => n.type === "button" && n.props["data-kind"] === "filled"),
    /** Lets the Countdown run out. */
    runOut() {
      for (let i = 0; i < 5; i++) page.act(() => timers.second());
    },
    /** The scan after a change is in, with `next` as the snapshot when the change shows in it. */
    async historyRead(next) {
      app.setState({ historyPending: false, ...(next ? { snapshot: next } : {}) });
      await page.settle();
    },
  };
}

export async function cancellingTheCountdownSendsNoRequest() {
  const page = cleanUpPage();
  await page.settle();
  const title = said.space.title("440 MB", "habit-app");
  const button = said.space.button("440 MB");
  // What deletes for good never opens by itself.
  assert.ok(!page.button(button));
  page.act(() => page.toggle(title).props.onClick());
  assert.equal(page.button(button).props["data-kind"], "outline", "and is never the filled button");
  assert.deepEqual(
    page.filled().map(describe),
    [],
    "the open card's button is the only one that could be",
  );

  const start = page.button(button);
  page.act(() => start.focus());
  page.act(() => start.props.onClick());
  assert.match(page.text(), /Freeing 440 MB in 5 seconds\./);
  page.act(() => page.timers.second());
  assert.match(page.text(), /Freeing 440 MB in 4 seconds\./);
  // The Countdown's Cancel takes the focus as it shows (autoFocus).
  page.act(() => page.button(words.blocks.cancel).focus());
  page.act(() => page.button(words.blocks.cancel).props.onClick());
  assert.equal(page.timers.waiting, 0, "no timer is left to fire");
  assert.deepEqual(page.sent(), [], "nothing was asked of the engine");
  assert.deepEqual(page.toasts, [[words.blocks.cancelled]]);
  assert.doesNotMatch(page.text(), /in \d seconds/);
  assert.equal(page.focused(), describe(start), "the focus goes back to where it started");

  // Escape stops it as well.
  page.act(() => page.button(button).props.onClick());
  const escape = page.act(() =>
    page.document.fire("keydown", keyEvent("Escape", page.document.body)),
  );
  assert.ok(escape.defaultPrevented && escape.stopped, "the page behind never sees the key");
  assert.equal(page.timers.waiting, 0);
  assert.deepEqual(page.sent(), []);

  // So does anything that covers the window, the palette or a dialog: it never runs out unseen, and
  // the toast says that nothing changed.
  page.toasts.length = 0;
  page.act(() => page.button(button).props.onClick());
  page.app.setState({ palette: true });
  await page.settle();
  assert.equal(page.timers.waiting, 0);
  assert.deepEqual(page.toasts, [[words.blocks.cancelled]]);
  page.app.setState({ palette: false });
  await page.settle();
  assert.doesNotMatch(page.text(), /in \d seconds/, "and it doesn't start again by itself");
  assert.deepEqual(page.sent(), []);
  // Opening another suggestion stops it the same way.
  page.act(() => page.button(button).props.onClick());
  page.act(() => page.toggle(said.reconnect.title("old-portfolio")).props.onClick());
  assert.equal(page.timers.waiting, 0);
  assert.deepEqual(page.toasts.at(-1), [words.blocks.cancelled]);
  assert.deepEqual(page.sent(), []);
  page.act(() => page.toggle(title).props.onClick());

  // Leaving the page stops it too.
  page.act(() => page.button(button).props.onClick());
  page.unmount();
  assert.equal(page.timers.waiting, 0);
  assert.deepEqual(page.sent(), []);
}

export async function aCountdownThatRunsOutMakesTheChangeOnce() {
  const page = cleanUpPage();
  await page.settle();
  page.act(() => page.toggle(said.space.title("440 MB", "habit-app")).props.onClick());
  page.act(() => page.button(said.space.button("440 MB")).props.onClick());
  page.runOut();
  await page.settle();
  // The request Detailed's Tidy sends, with Undo's guard on the history.
  assert.deepEqual(page.sent(), [["apply", { id: "space:inactive" }]]);
  assert.deepEqual(page.runs, [[said.space.doing("440 MB"), { history: true }]]);
  // Undo can't take it back, so the toast leaves its second line to the engine's note on getting
  // the files back.
  assert.deepEqual(page.changes.map((args) => args.slice(1)), [[said.space.done("440 MB"), ""]]);
  assert.equal(page.timers.waiting, 0);
  // The space Laci uses is read again once the change is in, not while Laci reads the history.
  assert.equal(page.asked("storage").length, 1);
  await page.historyRead();
  assert.equal(page.asked("storage").length, 2);
}

export async function theSpaceLaciUsesIsReadWhenThePageOpensAndOnceAChangeIsIn() {
  const storage = structuredClone(fixtures.storage);
  Object.assign(storage.parts.find((p) => p.id === "removed"), { bytes: 12e6, free: 12e6 });
  const page = cleanUpPage({ storage });
  await page.settle();
  assert.equal(page.asked("storage").length, 1);
  // A scan moves the revision on, and changes nothing Laci keeps itself.
  page.app.setState({ revision: 9 });
  await page.settle();
  assert.equal(page.asked("storage").length, 1);
  // While Laci reads the history after a change, the engine refuses to empty anything: so does the page.
  page.app.setState({ historyPending: true });
  await page.settle();
  assert.equal(page.button(said.laci.parts.removed.button).props.disabled, true);
  assert.equal(page.asked("storage").length, 1);
  await page.historyRead();
  assert.equal(page.asked("storage").length, 2, "the change is in: Kept for Undo may have grown");
  assert.equal(page.button(said.laci.parts.removed.button).props.disabled, false);
}

export async function aCopyLaciCantReachSaysWhyInSimplesWords() {
  const storage = structuredClone(fixtures.storage);
  const why =
    "The folder for the copy of AI chats isn't there: /media/backup/ai-chats. Connect its drive, or choose another folder for the copy.";
  Object.assign(storage.parts.find((p) => p.id === "history"), { dir: "/media/backup/ai-chats", error: why });
  const page = cleanUpPage({ storage });
  await page.settle();
  const row = page.find((n) => n.props["data-ui"] === "space-part" && n.props["data-id"] === "history");
  const told = row.descendants().find((n) => n.props["data-tone"] === "soon");
  assert.equal(told.textContent, words.engineWords.simple.copyMissing("/media/backup/ai-chats"));
}

export async function theOpenCardHoldsTheOneFilledButtonAndChangesAsDetailedDoes() {
  const page = cleanUpPage();
  await page.settle();
  assert.deepEqual(page.filled().map((b) => b.textContent), [said.reconnect.button]);
  // A closed row says whether Undo can take the change back; how sure Laci is waits in the card.
  const space = said.space.title("440 MB", "habit-app");
  assert.equal(page.toggle(space).textContent, `${space}${said.forGood}${said.review}`);
  assert.equal(page.toggle(space).props["aria-expanded"], false);
  const sure = (title) =>
    page.card(title).descendants().some((n) => n.props["data-info"] === "sure");
  assert.equal(sure(space), false);
  assert.equal(sure(said.reconnect.title("old-portfolio")), true);
  page.act(() => page.filled()[0].props.onClick());
  await page.settle();
  assert.deepEqual(page.sent(), [["apply", { id: RECONNECT }]]);
  assert.deepEqual(page.runs, [[said.reconnect.doing, { history: true }]]);
  assert.deepEqual(page.changes[0].slice(1), [said.reconnect.done, "old-portfolio"]);
  // While Laci reads the history again, the suggestions wait.
  assert.ok(!page.find((n) => n.props["data-ui"] === "suggestion"));
  await page.historyRead();

  // A tile opens its kind's first suggestion, and closes the card that was open.
  const tile = page.find((n) => n.props["data-ui"] === "tile" && n.textContent.startsWith(said.tiles.archive));
  page.act(() => tile.props.onClick());
  assert.equal(page.focused(), describe(page.toggle(said.archive.title("habit-app"))));
  assert.deepEqual(page.filled().map((b) => b.textContent), [said.archive.button("habit-app")]);
  assert.equal(page.toggle(said.reconnect.title("old-portfolio")).props["aria-expanded"], false);

  // Archiving opens the archive dialog, which shows the plan first: nothing is sent from here.
  page.act(() => page.filled()[0].props.onClick());
  await page.settle();
  assert.deepEqual(page.app.getState().modal, { kind: "archive", id: HABIT });
  assert.equal(page.sent().length, 1);
  // The Trash waits in ⋯, as Tidy offers it beside Archive: its dialog still leads with archiving.
  page.app.setState({ modal: null });
  await page.settle();
  page.act(() => page.button(words.project.delete).props.onClick());
  assert.deepEqual(page.app.getState().modal, { kind: "delete", id: HABIT });
  assert.equal(page.sent().length, 1);

  // Hide for 90 days is Detailed's Dismiss.
  page.app.setState({ modal: null });
  await page.settle();
  page.act(() => page.button(said.hide).props.onClick());
  await page.settle();
  assert.deepEqual(page.sent().at(-1), ["proposal/dismiss", { id: `archive:${HABIT}` }]);
  assert.deepEqual(page.toasts.at(-1), [said.hidden, said.hiddenNote]);
}

export async function afterAChangeTheFocusGoesOnToTheCardThatOpensNext() {
  const page = cleanUpPage();
  await page.settle();
  const reconnect = page.filled()[0];
  page.act(() => reconnect.focus());
  page.act(() => reconnect.props.onClick());
  // The window waits while the change runs, and the focus falls to the page.
  page.document.activeElement = page.document.body;
  await page.settle();
  // The next scan comes without the suggestion: the next card opens and takes the focus.
  const next = scan();
  next.proposals = next.proposals.filter((p) => p.id !== RECONNECT);
  await page.historyRead(next);
  assert.equal(page.focused(), describe(page.toggle(said.migration.title(1))));
  assert.deepEqual(page.filled().map((b) => b.textContent), [said.migration.button(1)]);

  // A change that fails leaves its card, and the focus goes back to its button.
  const failing = cleanUpPage({
    replies: {
      apply: () => {
        throw new Error("old-portfolio is in use");
      },
    },
  });
  await failing.settle();
  const button = failing.filled()[0];
  failing.act(() => button.focus());
  failing.act(() => button.props.onClick());
  failing.document.activeElement = failing.document.body;
  await failing.settle();
  assert.equal(failing.focused(), describe(button));
  assert.deepEqual(failing.toasts, [["Couldn’t finish", "Error: old-portfolio is in use"]]);
}

export async function leftoverChatsAreSetAsideAndTheTrashWaitsForTheCountdown() {
  const s = scan();
  s.proposals = [LEFTOVER];
  const page = cleanUpPage({ snapshot: s });
  await page.settle();
  assert.match(page.text(), new RegExp(said.leftover.title("gone-app")));
  const aside = page.button(said.leftover.button);
  assert.equal(aside.props["data-kind"], "filled", "setting aside can be undone");
  page.act(() => aside.props.onClick());
  await page.settle();
  assert.deepEqual(page.sent(), [["apply", { id: LEFTOVER.id, recovery: "quarantine" }]]);
  assert.equal(page.changes.at(-1)[1], said.leftover.done);

  // The Trash is in ⋯, and waits for the Countdown like anything Undo can't take back.
  const other = cleanUpPage({ snapshot: s });
  await other.settle();
  other.act(() => other.button(said.leftover.trash).props.onClick());
  assert.match(other.text(), new RegExp(`${said.leftover.trashCounting} in 5 seconds`));
  other.act(() => other.button(words.blocks.cancel).props.onClick());
  assert.deepEqual(other.sent(), [], "cancelled, it sends nothing");
  other.act(() => other.button(said.leftover.trash).props.onClick());
  other.runOut();
  await other.settle();
  assert.deepEqual(other.sent(), [["apply", { id: LEFTOVER.id, recovery: "trash" }]]);
  assert.equal(other.changes.at(-1)[1], said.leftover.trashDone);
}

export async function aBlockedSuggestionSaysWhyAndOffersNothing() {
  const s = scan();
  s.proposals = [BLOCKED, TWICE];
  const page = cleanUpPage({ snapshot: s });
  await page.settle();
  assert.deepEqual(page.filled().map(describe), [], "nothing Laci can make opens by itself");
  page.act(() => page.toggle(said.leftover.blockedTitle).props.onClick());
  const card = page.card(said.leftover.blockedTitle);
  assert.match(card.textContent, new RegExp(said.leftover.blocked));
  assert.match(card.textContent, /no recorded identity/, "the engine's reason, in its details");
  assert.match(card.textContent, new RegExp(said.leftAlone));
  const buttons = card.descendants().filter((n) => n.type === "button");
  assert.deepEqual(
    buttons.map(describe),
    [describe(page.toggle(said.leftover.blockedTitle))],
    "only the row that opens it",
  );

  // Same project twice has nothing to apply either: Laci changes nothing, and points to the copies.
  page.act(() => page.toggle(said.twice.title("kopi-landing", 2)).props.onClick());
  const twice = page.card(said.twice.title("kopi-landing", 2));
  assert.match(twice.textContent, new RegExp(said.twice.why.slice(0, 40)));
  assert.deepEqual(page.filled().map(describe), []);
  // Opening each copy is what it offers, so those buttons show instead of waiting in ⋯.
  assert.equal(page.button(said.open("kopi-landing")).props["data-kind"], "outline");
  assert.ok(!twice.descendants().some((n) => n.props.role === "menu"));
  page.act(() => page.button(said.open("kopi-landing")).props.onClick());
  assert.deepEqual(page.opened, [`${ROOT}/clients/kopi-landing`]);
  assert.deepEqual(page.sent(), []);
}

export async function emptyingKeptForUndoWaitsForTheCountdown() {
  const storage = structuredClone(fixtures.storage);
  Object.assign(storage.parts.find((p) => p.id === "removed"), { bytes: 12e6, free: 12e6 });
  const page = cleanUpPage({ storage, replies: { "storage/free": { freed: 12e6 } } });
  await page.settle();
  assert.match(page.text(), new RegExp(said.couldFree("452 MB")), "the suggestions and Laci's own space");
  const empty = said.laci.parts.removed.button;
  page.act(() => page.button(empty).props.onClick());
  assert.match(page.text(), /Emptying Kept for Undo \(12 MB\) in 5 seconds\./);
  // One Countdown at a time: nothing else that deletes for good can start meanwhile.
  page.act(() => page.toggle(said.space.title("440 MB", "habit-app")).props.onClick());
  assert.equal(page.button(said.space.button("440 MB")).props.disabled, true);
  page.act(() => page.button(words.blocks.cancel).props.onClick());
  assert.deepEqual(page.sent(), []);
  page.act(() => page.button(empty).props.onClick());
  page.runOut();
  await page.settle();
  assert.deepEqual(page.sent(), [["storage/free", { part: "removed" }]]);
  assert.equal(page.asked("storage").length, 2, "and the space is read again");
  assert.deepEqual(page.toasts.at(-1), [said.laci.freed("12 MB"), said.laci.parts.removed.label]);
}

export async function aCountdownStopsWhenLaciReadsTheHistoryAgain() {
  // A change made elsewhere, by your AI say, sets Laci reading the history again, and the engine
  // empties nothing until it is done: the Countdown stops and says so, rather than run out to nothing.
  const storage = structuredClone(fixtures.storage);
  Object.assign(storage.parts.find((p) => p.id === "removed"), { bytes: 12e6, free: 12e6 });
  const page = cleanUpPage({ storage });
  await page.settle();
  const empty = said.laci.parts.removed.button;
  page.act(() => page.button(empty).props.onClick());
  assert.match(page.text(), /Emptying Kept for Undo \(12 MB\) in 5 seconds\./);
  page.app.setState({ historyPending: true });
  await page.settle();
  assert.equal(page.timers.waiting, 0, "no timer is left to fire");
  assert.doesNotMatch(page.text(), /in \d seconds/);
  assert.deepEqual(page.toasts, [[words.blocks.cancelled]]);
  // Once Laci is done, the button is back and nothing starts by itself.
  await page.historyRead();
  assert.equal(page.button(empty).props.disabled, false);
  assert.doesNotMatch(page.text(), /in \d seconds/);
  assert.deepEqual(page.sent(), []);

  // The same for a suggestion: while Laci reads the history, the suggestions wait.
  page.act(() => page.toggle(said.space.title("440 MB", "habit-app")).props.onClick());
  page.act(() => page.button(said.space.button("440 MB")).props.onClick());
  assert.match(page.text(), /Freeing 440 MB in 5 seconds\./);
  page.app.setState({ historyPending: true });
  await page.settle();
  assert.equal(page.timers.waiting, 0);
  assert.deepEqual(page.toasts.at(-1), [words.blocks.cancelled]);
  assert.deepEqual(page.sent(), []);
}

export async function everyInfoOnThePageHasItsWordInHelp() {
  const s = scan();
  s.proposals.push(LEFTOVER, BLOCKED, TWICE);
  const page = cleanUpPage({ snapshot: s });
  await page.settle();
  const terms = new Set();
  const look = () =>
    page.all((n) => n.props["data-info"]).forEach((n) => terms.add(n.props["data-info"]));
  for (const card of page.all((n) => n.props["data-ui"] === "suggestion")) {
    const toggle = card.descendants().find((n) => n.props.className === "s-sug-toggle");
    page.act(() => toggle.props.onClick());
    look();
  }
  // An ⓘ whose word isn't in the glossary draws nothing at all.
  for (const term of terms) assert.ok(words.termOf(term), `no glossary entry "${term}"`);
  assert.deepEqual(
    [...terms].sort(),
    ["archive", "copy-chats", "kept-for-undo", "leftover", "packages", "reconnect", "same-twice", "sure"],
  );
}

export async function whileLaciLooksAgainThePageSaysSo() {
  // After a change the engine checks the AI history again, and the suggestions wait (README, Tidy up).
  const page = cleanUpPage({ state: { historyPending: true } });
  await page.settle();
  assert.match(page.text(), new RegExp(said.checking));
  assert.ok(!page.find((n) => n.props["data-ui"] === "suggestion"));
  const empty = cleanUpPage({ snapshot: { ...scan(), proposals: [] } });
  await empty.settle();
  assert.match(empty.text(), new RegExp(said.emptyTitle));
}
