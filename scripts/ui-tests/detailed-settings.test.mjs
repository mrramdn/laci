// Detailed's Settings, Archive and New project (ui/src/settings.tsx, dialogs.tsx and new-project.tsx),
// after the folder picker and Settings › About & updates reached them (ui:23 and the window's part of
// rel:U1):
// - a "Choose…" button, named for its folder, sits beside each folder field and puts the folder the
//   system's picker gives into it, opening at the folder the field holds; typing a path still works;
// - About & updates is the last section of Settings, with one button that follows where the update
//   stands, the notes of a new version, and the choice about looking for new versions.
// The real components are drawn into a small stand-in for React, on the real update store, with the
// preview's fixtures as the desktop's answers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";
import { fakeTimers, heldDate, Host, standIn } from "./react-stand-in.mjs";

const { createElement } = requireUi("react");
const noop = () => {};
const nothing = () => null;
const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);
const NOW = fixtures.meta.now;
// Compiled with the clock held at the fixtures' time, so "2 days ago" is the same whenever this runs.
const held = { Date: heldDate(NOW) };
const words = load("words.ts", {}, held);
const said = words.detailedSettings;
const INFO = fixtures["setup/info"];
const HOME = fixtures.snapshot.home;
const ACME = `${HOME}/project/clients/acme-store`;
const PREFS = {
  theme: null,
  design: "detailed",
  updates: null,
  configured: true,
  configPath: "~/.config/laci/config.json",
};
const errorText = (error) => (error instanceof Error ? error.message : String(error));
const BUSY = "Laci is busy with a change. Update when it's done.";

/** What the desktop says of an update. */
const status = (state, more = {}) => ({
  enabled: true,
  state,
  current: "3.0.0",
  install: "click",
  ...more,
});
/** A version out there: its notes (with an image from the web), when it came out, and its page. */
const FOUND = {
  version: "3.0.1",
  notes: "### Fixed\n- A project moved to another disk keeps its AI chats.\n\n![shot](https://example.com/shot.png)",
  date: "2026-10-06T09:00:00Z",
  url: "https://github.com/mrramdn/laci/releases/tag/v3.0.1",
};

/** The system's folder picker as a button that says what it was asked for and hands over `box.picked`. */
function chooser(box) {
  return {
    ChooseFolder: ({ ref, label, name, title, defaultPath, disabled, onPick }) =>
      createElement(
        "button",
        {
          ref,
          type: "button",
          "aria-label": name,
          "data-picker": title,
          "data-from": defaultPath,
          disabled: Boolean(disabled),
          onClick: () => onPick(box.picked),
        },
        label,
      ),
  };
}
/**
 * A Choose… button's name for a screen reader says which folder it chooses: it is the picker's own
 * title, which starts with the word the button shows.
 */
function namedForItsFolder(button) {
  assert.equal(button.textContent, said.choose);
  assert.equal(button.props["aria-label"], button.props["data-picker"]);
  assert.ok(button.props["aria-label"].startsWith(said.choose.replace("…", "")), button.props["aria-label"]);
}
/** A box and its button share a row, which the stylesheet spaces (in a field, `.fld > .addrow`), not the element. */
function aRowOfItsField(button) {
  assert.equal(button.parent.props.className, "addrow");
  assert.equal(button.parent.props.style, undefined);
}
const picker = (page, title) => page.find((n) => n.props["data-picker"] === title);
const field = (page, label) => page.find((n) => n.type === "input" && n.props["aria-label"] === label);
const type = (page, host, value) => page.act(() => host.props.onChange({ target: { value } }));

// --- Settings, and first run ---------------------------------------------------------------------

/**
 * Settings.tsx drawn with `first` or not, on a desktop that answers from `desk`: change `desk.status`,
 * `desk.found` (what a check finds) and `desk.refuse` (a request's name to why it is refused) as a test
 * needs.
 */
async function settingsPage({
  first = false,
  info = INFO,
  prefs = PREFS,
  status: stands = status("idle", { enabled: false }),
} = {}) {
  const page = standIn();
  page.document.documentElement = { dataset: {} };
  const box = { picked: `${HOME}/work` };
  const asked = [];
  const toasts = [];
  const opened = [];
  const saved = [];
  const listeners = [];
  const desk = {
    prefs: { ...prefs },
    status: stands,
    found: status("available", { ...FOUND }),
    refuse: {},
  };
  const answers = {
    "setup/info": () => structuredClone(info),
    prefs: () => ({ ...desk.prefs }),
    "setup/save": (body) => (saved.push(body), { revision: 2 }),
    "backup/move": (body) => ({ revision: 3, dest: body.dir || "~/.local/share/laci/history", moved: !body.fresh }),
    "update/status": () => desk.status,
    "update/check": () => (desk.status = desk.found),
    "update/install": () => ({ started: true }),
    "update/restart": () => ({}),
    updates: (body) => {
      desk.prefs = { ...desk.prefs, updates: body.updates };
      desk.status = { ...desk.status, enabled: body.updates === "daily" };
      return desk.prefs;
    },
  };
  const api = async (name, body = {}) => {
    asked.push([name, body]);
    if (name in desk.refuse) throw desk.refuse[name];
    if (!answers[name]) throw new Error(`No answer for ${name}`);
    return answers[name](body);
  };
  const app = page.store({
    snapshot: structuredClone(fixtures.snapshot),
    design: "detailed",
    theme: "system",
    apps: INFO.apps,
    terminalTarget: "internal",
    setupPending: false,
    historyPending: false,
    working: "",
    modal: null,
    palette: false,
    error: null,
    skipSetup: false,
    settingsDirty: false,
  });
  // The real update store, on the page's own `create`, with the desktop's events sent from `emit`.
  const update = load(
    "update.ts",
    {
      "./api": { api, errorText },
      "@tauri-apps/api/event": {
        listen: (name, handler) => {
          listeners.push({ name, handler });
          return Promise.resolve(noop);
        },
      },
      zustand: { create: (init) => page.store(init()) },
    },
    held,
  );
  // marked and DOMPurify load on demand: this stands in for readme.ts once they are in.
  const markdown = {
    drawn: [],
    clicks: [],
    renderReadme(raw, folder, loadRemote) {
      markdown.drawn.push({ raw, folder, loadRemote });
      return { html: `<p>${raw}</p>`, remote: raw.includes("![") && !loadRemote ? 1 : 0, headings: [] };
    },
    proseClick: (_event, how) => markdown.clicks.push(how),
  };
  const settings = load(
    "settings.tsx",
    {
      react: page.react,
      "./api": { api, errorText },
      "./select": {
        Select: ({ label, value }) => createElement("select", { "aria-label": label, value }),
      },
      "./brand": { LaciMark: nothing },
      "./common": { Icon: nothing },
      "./hooks": { useMarkdown: () => markdown },
      "./looks": { LookPicker: nothing },
      "./pick": chooser(box),
      "./store": {
        useApp: app,
        acknowledge: noop,
        changed: noop,
        chooseDesign: () => true,
        copyText: noop,
        // As the store moves the copy: through `run`, which hands a failure to `onError`, and a toast in the words
        // the store chooses.
        moveCopy: async (dir, fresh, words, onError) => {
          try {
            const answer = await api("backup/move", fresh ? { dir, fresh } : { dir });
            toasts.push([words.said(answer), words.note]);
            // As the store takes in the change: history is read again, and Change… waits for it.
            app.setState({ historyPending: true });
            return true;
          } catch (error) {
            onError(error);
            return false;
          }
        },
        openCopy: noop,
        rescan: noop,
        run: async (task, _working, options = {}) => {
          try {
            return await task();
          } catch (error) {
            options.onError?.(error);
            return undefined;
          }
        },
        setDesign: noop,
        setTheme: noop,
        toast: (...args) => void toasts.push(args),
        urlOpen: (url) => void opened.push(url),
      },
      "./clock": { useNow: () => Date.parse(NOW) },
      "./update": update,
    },
    { ...held, document: page.document },
  );
  page.mount(createElement(settings.Settings, { first }));
  await page.settle();
  await page.settle();
  return {
    ...page,
    ...settings,
    app,
    desk,
    box,
    markdown,
    toasts,
    opened,
    saved,
    asked: (name) => asked.filter(([request]) => request === name),
    /** The desktop tells the window how an update stands. */
    emit: async (event) => {
      for (const { name, handler } of listeners)
        if (name === "laci") handler({ payload: { type: "update", ...event } });
      await page.settle();
    },
    /** Lets what a click set going finish. */
    done: async () => {
      await page.settle();
      await page.settle();
    },
  };
}

/** The folders Settings lists as places to look in, as `[where, ticked]`. */
const folders = (page) =>
  page
    .all((n) => n.type === "section" && n.props.className === "sset")[0]
    .descendants()
    .filter((n) => n.type === "label" && n.props.className === "opt")
    .map((label) => [
      label.descendants().find((n) => n.props.className === "mono")?.textContent,
      label.descendants().find((n) => n.type === "input")?.props.checked,
    ]);
/** The alert Settings shows, if any. */
const alert = (page) => page.find((n) => n.props.role === "alert")?.textContent;

export async function theHistoryBackupMovesOnlyOnceSettingsHasAskedWhere() {
  const p = await settingsPage();
  const change = picker(p, said.backupFolderTitle);
  assert.equal(change.props["data-from"], "~", "the default folder isn't one to start the picker in");
  assert.equal(p.find((n) => n.type === "button" && n.textContent === said.backupFolderDefaultButton), undefined);
  const move = () => p.find((n) => n.type === "button" && n.textContent === said.backupMove);
  const question = () => p.find((n) => n.props.role === "group" && n.props["aria-label"] === said.backupMove);
  p.box.picked = "/mnt/archive/ai-chats";
  p.act(() => change.props.onClick());
  assert.deepEqual(p.asked("backup/move"), [], "a pick only asks");
  const asked = question().textContent;
  assert.ok(asked.includes(said.backupMoveAsk("/mnt/archive/ai-chats")), asked);
  assert.ok(asked.includes(said.backupMoveNote), asked);
  // Refused, as for a folder that holds files: the reason shows beside the question, which stays.
  const why = "That folder already holds files. Choose an empty folder, or one that holds a copy Laci made.";
  p.desk.refuse["backup/move"] = new Error(why);
  p.act(() => move().props.onClick());
  await p.done();
  assert.ok(p.all((n) => n.props.role === "alert").some((n) => n.textContent === why));
  assert.ok(question());
  delete p.desk.refuse["backup/move"];
  p.act(() => move().props.onClick());
  await p.done();
  assert.deepEqual(p.asked("backup/move").at(-1), ["backup/move", { dir: "/mnt/archive/ai-chats" }]);
  assert.equal(question(), undefined, "moved, the question goes");
  assert.deepEqual(p.toasts.at(-1), [said.backupMoved("/mnt/archive/ai-chats"), said.backupMoveNote]);
}

export async function aHistoryBackupLaciCantReachIsNotMovedButANewOneCanStart() {
  const p = await settingsPage();
  const why =
    "The folder for the copy of AI chats isn't there: /mnt/archive/ai-chats. Connect its drive, or choose another folder for the copy.";
  const snapshot = structuredClone(fixtures.snapshot);
  snapshot.backup = { ...snapshot.backup, chosen: true, dest: "/mnt/archive/ai-chats", bytes: 1e9, packed: true, error: why };
  p.app.setState({ snapshot });
  await p.settle();
  const row = () => p.find((n) => n.props["data-ui"] === "backup-folder");
  // Why, in Detailed's words, and where to choose another folder.
  assert.equal(
    row().descendants().find((n) => n.props.role === "alert").textContent,
    words.engineWords.detailed.copyMissing("/mnt/archive/ai-chats"),
  );
  // The folder is a labelled output, not a span a screen reader skips the name of.
  const shown = row().descendants().find((n) => n.type === "output");
  assert.equal(shown.textContent, "/mnt/archive/ai-chats");
  assert.equal(p.find((n) => n.props.id === shown.props["aria-labelledby"]).textContent, said.backupFolder);
  p.box.picked = `${HOME}/ai-chats`;
  p.act(() => picker(p, said.backupFolderTitle).props.onClick());
  await p.settle();
  const question = p.find((n) => n.props.role === "group" && n.props["aria-label"] === said.backupFresh);
  assert.ok(question.textContent.includes(said.backupFreshAsk("~/ai-chats")), question.textContent);
  assert.ok(question.textContent.includes(said.backupFreshNote), question.textContent);
  assert.ok(!question.textContent.includes("1.0 GB"), "nothing is said to move");
  assert.equal(p.document.activeElement, question, "the question takes the focus");
  // Only as it opens: while it stays open, the focus stays where it went, also when an automatic backup reads
  // history again meanwhile.
  const cancel = () => p.find((n) => n.type === "button" && n.textContent === said.cancel);
  cancel().focus();
  p.app.setState({ historyPending: true });
  await p.settle();
  p.app.setState({ historyPending: false });
  await p.settle();
  assert.ok(p.document.activeElement === cancel(), p.focused());
  p.act(() => p.find((n) => n.type === "button" && n.textContent === said.backupFresh).props.onClick());
  await p.done();
  assert.deepEqual(p.asked("backup/move").at(-1), ["backup/move", { dir: `${HOME}/ai-chats`, fresh: true }]);
  assert.deepEqual(p.toasts.at(-1), [said.backupKept(`${HOME}/ai-chats`), said.backupFreshNote]);
  // Answered, the focus goes back to Change… once history is read again and Change… can take it.
  const change = () => picker(p, said.backupFolderTitle);
  assert.equal(change().props.disabled, true);
  // Compared as booleans: a failed compare of two elements would print the whole page.
  assert.ok(p.document.activeElement !== change(), "not while it is disabled");
  p.app.setState({ historyPending: false });
  await p.settle();
  assert.ok(p.document.activeElement === change(), p.focused());
}

export async function aChooseButtonSitsBesideEachFolderFieldOfSettings() {
  const p = await settingsPage();
  const buttons = p.all((n) => n.props["data-picker"] !== undefined);
  assert.deepEqual(
    buttons.map((b) => [b.props["data-picker"], b.textContent]),
    [
      [said.addFolderTitle, "Choose…"],
      [said.archiveFolderTitle, "Choose…"],
      [said.backupFolderTitle, said.backupFolderChange],
      [said.reportsFolderTitle, "Choose…"],
    ],
  );
  // Each is in the row of its field, and the field's own row is what draws it beside the box.
  for (const [title, label] of [
    [said.addFolderTitle, "Another folder"],
    [said.archiveFolderTitle, "Default archive folder"],
    [said.reportsFolderTitle, "Reports folder"],
  ]) {
    const button = picker(p, title);
    assert.equal(button.parent, field(p, label).parent, `${label}: the button is in its row`);
    aRowOfItsField(button);
    // Three buttons that say "Choose…" are told apart by their names.
    namedForItsFolder(button);
  }
  // The picker opens at the folder a field holds, and at the home folder when it holds none.
  assert.equal(picker(p, said.addFolderTitle).props["data-from"], "~");
  assert.equal(picker(p, said.archiveFolderTitle).props["data-from"], "~");
  assert.equal(picker(p, said.reportsFolderTitle).props["data-from"], INFO.reportsDir);
  type(p, field(p, "Default archive folder"), "~/backup/archive");
  type(p, field(p, "Another folder"), "/mnt/projects");
  assert.equal(picker(p, said.archiveFolderTitle).props["data-from"], "~/backup/archive");
  assert.equal(picker(p, said.addFolderTitle).props["data-from"], "/mnt/projects");
}

export async function aFieldsRowIsSpacedByTheStylesheet() {
  const css = readFileSync(new URL("../../ui/src/styles/detailed.css", import.meta.url), "utf8");
  // A row of its own, as Add folder's, keeps its space; in a field it takes none, as the box alone
  // took none. The elements set nothing themselves (aRowOfItsField).
  assert.match(css, /\n\.addrow \{[^}]*\n {2}margin: 8px 0 6px;/);
  assert.match(css, /\n\.fld > \.addrow \{\n {2}margin: 0;\n\}/);
}

export async function aFolderChosenIsAddedAtOnceAndATypedOneStillWorks() {
  const p = await settingsPage();
  assert.deepEqual(folders(p), [["~/project", true]]);
  p.box.picked = `${HOME}/work`;
  p.act(() => picker(p, said.addFolderTitle).props.onClick());
  assert.deepEqual(folders(p), [
    ["~/project", true],
    ["~/work", true],
  ]);
  // A typed path is added as it always was, and the box is left empty.
  const box = field(p, "Another folder");
  type(p, box, "~/code/");
  assert.equal(field(p, "Another folder").props.value, "~/code/");
  p.act(() => p.find((n) => n.type === "form").props.onSubmit({ preventDefault: noop }));
  assert.deepEqual(folders(p), [
    ["~/project", true],
    ["~/work", true],
    ["~/code", true],
  ]);
  assert.equal(field(p, "Another folder").props.value, "");
  // A folder chosen twice is one folder.
  p.act(() => picker(p, said.addFolderTitle).props.onClick());
  assert.equal(folders(p).length, 3);
}

export async function theWholeDiskIsNotAFolderToKeepProjectsIn() {
  const p = await settingsPage();
  p.box.picked = "/";
  p.act(() => picker(p, said.addFolderTitle).props.onClick());
  assert.deepEqual(folders(p), [["~/project", true]], "nothing added");
  assert.equal(alert(p), said.wholeDisk, "a chosen folder that isn't taken says why");
  // A "/" typed was always passed over without a word.
  const q = await settingsPage();
  type(q, field(q, "Another folder"), "/");
  q.act(() => q.find((n) => n.type === "form").props.onSubmit({ preventDefault: noop }));
  assert.deepEqual(folders(q), [["~/project", true]]);
  assert.equal(alert(q), undefined);
}

export async function theFoldersChosenForArchiveAndReportsAreWhatSaveSends() {
  const p = await settingsPage();
  p.box.picked = `${HOME}/Documents/archive`;
  p.act(() => picker(p, said.archiveFolderTitle).props.onClick());
  // Inside the home folder it is written as ~, the way a saved one is.
  assert.equal(field(p, "Default archive folder").props.value, "~/Documents/archive");
  p.box.picked = "/mnt/notes/reports";
  p.act(() => picker(p, said.reportsFolderTitle).props.onClick());
  assert.equal(field(p, "Reports folder").props.value, "/mnt/notes/reports");
  p.box.picked = `${HOME}/work`;
  p.act(() => picker(p, said.addFolderTitle).props.onClick());
  // Save and rescan sends them as full paths.
  p.act(() => p.button("Save and rescan").props.onClick());
  await p.done();
  const [sent] = p.saved;
  assert.equal(sent.archiveDir, `${HOME}/Documents/archive`);
  assert.equal(sent.reportsDir, "/mnt/notes/reports");
  assert.deepEqual(sent.roots, [`${HOME}/project`, `${HOME}/work`]);
}

export async function firstRunHasTheButtonsForItsFoldersAndKeepsItsOwnChoiceAboutUpdates() {
  const p = await settingsPage({ first: true, info: { ...INFO, roots: [], reportsDir: "" } });
  assert.deepEqual(
    p.all((n) => n.props["data-picker"] !== undefined).map((b) => b.props["data-picker"]),
    [said.addFolderTitle, said.archiveFolderTitle],
    "its Add folder and its archive folder; it has no reports folder",
  );
  assert.equal(picker(p, said.archiveFolderTitle).parent, field(p, "Default archive folder").parent);
  p.box.picked = `${HOME}/code`;
  p.act(() => picker(p, said.addFolderTitle).props.onClick());
  assert.deepEqual(folders(p), [["~/code", true]]);
  // About & updates comes after the first run, and the question first run asks is still the one it asked.
  assert.equal(p.find((n) => n.id === "settings-updates"), undefined);
  assert.equal(p.asked("update/status").length, 0, "first run asks the desktop nothing about updates");
  const choice = p.all((n) => n.props["data-ui"] === "updates-choice");
  assert.equal(choice.length, 1);
  assert.deepEqual(
    choice[0].descendants().filter((n) => n.type === "input").map((n) => [n.props.value, n.props.checked]),
    [
      ["daily", true],
      ["off", false],
    ],
  );
}

// --- Settings › About & updates ------------------------------------------------------------------

const section = (page) => page.find((n) => n.id === "settings-updates");
const part = (page, ui) => page.find((n) => n.props["data-ui"] === ui);
const action = (page) => part(page, "update-action");
/** What sits beside the button: its hint, or why it was refused. */
const beside = (page) => action(page).parent.children.filter((n) => n !== action(page));
const radios = (page) =>
  section(page)
    .descendants()
    .filter((n) => n.type === "input" && n.props.type === "radio");

export async function aboutAndUpdatesEndsSettingsAndAsksTheDesktopWhereUpdatesStand() {
  const p = await settingsPage();
  const sections = p.all((n) => n.type === "section" && String(n.props.className).startsWith("sset"));
  assert.equal(sections.at(-1), section(p), "the last section of Settings");
  assert.equal(section(p).props["data-ui"], "updates");
  assert.equal(section(p).props.tabIndex, -1, "a jump to #settings-updates can put the focus on it");
  const title = section(p).descendants().find((n) => n.type === "h2");
  assert.equal(title.textContent, `6${said.updatesTitle}`);
  assert.equal(section(p).props["aria-labelledby"], title.props.id);
  // It sits between the sections and the foot with Save and rescan.
  const page = section(p).parent;
  assert.equal(page.children.at(-2), section(p));
  assert.equal(page.children.at(-1).props.className, "setup-foot");
  // The version and where the update stands come from the desktop, asked once.
  assert.equal(p.asked("update/status").length, 1);
  assert.equal(part(p, "update-version").textContent, said.version("3.0.0"));
  assert.equal(part(p, "update-status").textContent, said.neverLooked);
  assert.equal(part(p, "update-status").props.role, "status", "a change of it is read out");
  assert.equal(action(p).textContent, said.check);
}

export async function theOneButtonFollowsTheUpdateAndKeepsItsPlace() {
  const p = await settingsPage();
  const button = action(p);
  // Check now asks the desktop, which finds a new version.
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(p.asked("update/check").length, 1);
  assert.equal(part(p, "update-status").textContent, said.available("3.0.1", "2 days ago"));
  assert.equal(action(p).textContent, said.install);
  assert.equal(action(p), button, "the same button, so its focus stays where it was");
  // Install starts the download, whose progress comes as events.
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(p.asked("update/install").length, 1);
  await p.emit(status("downloading", { ...FOUND, progress: 40 }));
  assert.equal(part(p, "update-status").textContent, said.downloading("3.0.1", 40));
  assert.equal(action(p).textContent, said.downloadingButton, "it downloads; it installs once that is done");
  assert.equal(action(p).props["aria-busy"], true);
  // A click while it works does nothing.
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(p.asked("update/install").length, 1);
  assert.equal(p.asked("update/check").length, 1);
  // Once it is ready, Restart finishes it, and says what a restart closes.
  await p.emit(status("ready", { ...FOUND }));
  assert.equal(part(p, "update-status").textContent, said.ready("3.0.1"));
  assert.equal(action(p).textContent, said.restart);
  assert.equal(action(p).props["aria-busy"], undefined);
  assert.deepEqual(beside(p).map((n) => n.textContent), [said.restartNote]);
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(p.asked("update/restart").length, 1);
  assert.equal(action(p), button, "still the same button");
}

export async function whileTheDesktopLooksTheButtonSaysSoAndWaits() {
  const p = await settingsPage();
  await p.emit(status("checking"));
  assert.equal(part(p, "update-status").textContent, said.looking);
  assert.equal(action(p).textContent, said.checking);
  assert.equal(action(p).props["aria-busy"], true);
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(p.asked("update/check").length, 0, "no second check while one runs");
  // Nothing newer: when the desktop last looked, in words.
  await p.emit(status("idle", { checkedAt: "2026-10-08T08:37:00Z" }));
  assert.equal(part(p, "update-status").textContent, said.upToDate("23 minutes ago"));
  assert.equal(action(p).textContent, said.check);
}

export async function aCopyThatCannotInstallLinksToItsReleaseInstead() {
  const p = await settingsPage();
  await p.emit(status("available", { ...FOUND, install: "notice" }));
  assert.equal(action(p).textContent, said.releasePage);
  assert.deepEqual(beside(p).map((n) => n.textContent), [said.noticeNote], "and why there is no Install");
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.deepEqual(p.opened, [FOUND.url]);
  assert.equal(p.asked("update/install").length, 0, "it never asks to install");
  // With no page to open the button can only look again.
  await p.emit(status("available", { ...FOUND, install: "notice", url: undefined }));
  assert.equal(action(p).textContent, said.check);
  // A failed download of a copy that installs itself keeps its version, but so does a failed check:
  // the button looks again, and the version comes back with its Install.
  await p.emit(status("error", { ...FOUND, error: "The download stopped. Check the connection and try again." }));
  assert.equal(part(p, "update-status").textContent, "The download stopped. Check the connection and try again.");
  assert.equal(part(p, "update-status").props.className, "rp-status bad", "a failure is red");
  assert.equal(action(p).textContent, said.check);
  // A failed look has no version to install, so the button looks again.
  await p.emit(status("error", { error: "Laci couldn't reach the update server. Check the connection and try again." }));
  assert.equal(action(p).textContent, said.check);
}

export async function aCheckThatFailedWithAVersionOnOfferLooksAgainAndInstallsNothing() {
  const p = await settingsPage();
  // The daily look found a version. Offline, a check the user asked for fails, and the desktop
  // keeps the version on offer without saying which step failed.
  await p.emit(status("available", { ...FOUND }));
  const offline = "Laci couldn't reach the update server. Check the connection and try again.";
  await p.emit(status("error", { ...FOUND, error: offline }));
  assert.equal(part(p, "update-status").textContent, offline);
  assert.equal(action(p).textContent, said.check, "the button says what it does");
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(p.asked("update/check").length, 1);
  assert.equal(p.asked("update/install").length, 0, "nothing is downloaded or installed");
  // The version is on offer again, and installing it is a click of its own.
  assert.equal(part(p, "update-status").textContent, said.available("3.0.1", "2 days ago"));
  assert.equal(action(p).textContent, said.install);
}

export async function nothingIsSaidAboutFolderAccessBeforeAnInstall() {
  const p = await settingsPage();
  await p.emit(status("available", { ...FOUND }));
  assert.equal(p.all((n) => n.props["data-ui"] === "status").length, 0);
  assert.equal(action(p).props["aria-describedby"], undefined);
}

export async function aRefusalIsShownBesideTheButtonUntilTheNextRequest() {
  const p = await settingsPage();
  await p.emit(status("available", { ...FOUND }));
  p.desk.refuse["update/install"] = BUSY;
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(alert(p), BUSY);
  assert.deepEqual(beside(p).map((n) => n.textContent), [BUSY]);
  assert.equal(action(p).textContent, said.install, "the button is what it was");
  // The next request clears it, and a restart refused says so as well.
  delete p.desk.refuse["update/install"];
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(alert(p), undefined);
  await p.emit(status("ready", { ...FOUND }));
  p.desk.refuse["update/restart"] = BUSY;
  p.act(() => action(p).props.onClick());
  await p.done();
  assert.equal(alert(p), BUSY);
  assert.equal(action(p).textContent, said.restart);
}

export async function theNotesOfANewVersionAreDrawnLikeAReadme() {
  const p = await settingsPage();
  // None before a new version is known, or when it comes without notes.
  assert.equal(part(p, "release-notes"), undefined);
  await p.emit(status("available", { ...FOUND, notes: undefined }));
  assert.equal(part(p, "release-notes"), undefined);
  await p.emit(status("available", { ...FOUND }));
  const heading = section(p).descendants().find((n) => n.type === "h3");
  assert.equal(heading.textContent, said.whatsNew("3.0.1"));
  const notes = part(p, "release-notes");
  assert.equal(notes.props.className, "readme", "in the class Detailed draws a README in");
  assert.equal(notes.props.dangerouslySetInnerHTML.__html, `<p>${FOUND.notes}</p>`, "what renderReadme made of them");
  // Notes belong to no project: a path in them points into a folder no project is in.
  const [drawn] = p.markdown.drawn.slice(-1);
  assert.equal(drawn.raw, FOUND.notes);
  assert.equal(drawn.loadRemote, false);
  assert.ok(!drawn.folder.startsWith(HOME));
  // An image from the web waits for a click, as in a README.
  const note = section(p).descendants().find((n) => n.props.className === "readme-note");
  assert.equal(note.children[0].textContent, said.remoteImages(1));
  assert.equal(said.remoteImages(1), "1 image from the web is not loaded.");
  assert.equal(said.remoteImages(3), "3 images from the web are not loaded.");
  p.act(() => note.descendants().find((n) => n.type === "button").props.onClick());
  assert.equal(p.markdown.drawn.at(-1).loadRemote, true);
  assert.equal(section(p).descendants().find((n) => n.props.className === "readme-note"), undefined);
  // A link in them is for the readme's own click handler, and one with no place to go says so.
  p.act(() => notes.props.onClick({}));
  const [how] = p.markdown.clicks;
  assert.equal(how.blocked, said.notesBlocked);
  how.relative("docs/changes.md");
  assert.deepEqual(p.toasts.at(-1), ["Link not opened", said.notesBlocked]);
}

export async function theChoiceAboutLookingForNewVersionsIsSavedAtOnce() {
  const p = await settingsPage();
  const group = section(p).descendants().find((n) => n.props.role === "radiogroup");
  assert.equal(group.props["data-ui"], "updates-choice");
  assert.equal(group.props["aria-labelledby"], group.parent.children[0].props.id);
  assert.equal(group.parent.children[0].textContent, said.updatesChoice);
  // The question is first run's, and said as first run says it. Settings has no first-run
  // question, so its caption is not the one first run gives it.
  assert.notEqual(said.updatesChoice, words.firstRun.updatesTitle);
  assert.deepEqual(
    group.descendants().filter((n) => n.type === "b").map((n) => n.textContent),
    [words.firstRun.updates.daily, words.firstRun.updates.off],
  );
  const unset = () => section(p).descendants().some((n) => n.type === "small" && n.textContent === said.updatesUnset);
  const checked = () => radios(p).map((n) => n.props.checked);
  // Nothing chosen yet: neither is ticked, and the section says Laci doesn't look.
  assert.deepEqual(checked(), [false, false]);
  assert.equal(unset(), true);
  p.act(() => radios(p)[0].props.onChange());
  await p.done();
  assert.deepEqual(p.asked("updates"), [["updates", { updates: "daily" }]]);
  assert.deepEqual(checked(), [true, false]);
  assert.equal(unset(), false);
  assert.deepEqual(p.toasts.at(-1), [said.updatesSaved.daily]);
  // Off is a choice too, and not the same as none.
  p.act(() => radios(p)[1].props.onChange());
  await p.done();
  assert.deepEqual(p.asked("updates").at(-1), ["updates", { updates: "off" }]);
  assert.deepEqual(checked(), [false, true]);
  assert.equal(unset(), false);
  assert.deepEqual(p.toasts.at(-1), [said.updatesSaved.off]);
  // A choice the desktop refuses stays as it was, and says why.
  p.desk.refuse.updates = BUSY;
  p.act(() => radios(p)[0].props.onChange());
  await p.done();
  assert.deepEqual(checked(), [false, true]);
  assert.equal(alert(p), BUSY);
  assert.equal(p.toasts.length, 2, "no toast for a choice that wasn't saved");
}

export async function theSavedChoiceIsReadFromTheDesktopWhenSettingsOpens() {
  // What the desktop saved, whether it looks by itself, and what the section shows.
  for (const [updates, enabled, ticked, unset] of [
    ["daily", true, [true, false], false],
    ["off", false, [false, true], false],
    [null, false, [false, false], true],
  ]) {
    const p = await settingsPage({
      prefs: { ...PREFS, updates },
      status: status("idle", { enabled }),
    });
    assert.deepEqual(radios(p).map((n) => n.props.checked), ticked, String(updates));
    assert.equal(
      section(p).descendants().some((n) => n.type === "small" && n.textContent === said.updatesUnset),
      unset,
      String(updates),
    );
  }
}

export async function updateViewSaysWhereItStandsInWords() {
  const { updateView } = await settingsPage();
  const NOON = Date.parse(NOW);
  const view = (state, more, now = NOON) => updateView(state && status(state, more), now);
  const action = (kind, label, busy = false) => ({ kind, label, busy });
  // Before the desktop has said anything.
  assert.deepEqual(updateView(null, NOON), {
    line: said.reading,
    bad: false,
    action: action("check", said.check),
    hint: "",
  });
  // Nothing newer: when it was looked for, or that it never was.
  assert.deepEqual(view("idle"), { line: said.neverLooked, bad: false, action: action("check", said.check), hint: "" });
  assert.equal(view("idle", { checkedAt: "2026-10-08T08:59:30Z" }).line, "No newer version was found just now.");
  assert.equal(view("idle", { checkedAt: "2026-09-08T09:00:00Z" }).line, "No newer version was found 4 weeks ago.");
  assert.equal(said.upToDate(""), "No newer version was found.");
  assert.deepEqual(view("checking"), {
    line: said.looking,
    bad: false,
    action: action("check", said.checking, true),
    hint: "",
  });
  // A new version: installed on a click, or linked when the copy can't install itself.
  assert.deepEqual(view("available", FOUND), {
    line: "Version 3.0.1 is available, published 2 days ago.",
    bad: false,
    action: action("install", said.install),
    hint: "",
  });
  assert.equal(view("available", { ...FOUND, date: undefined }).line, "Version 3.0.1 is available.");
  assert.deepEqual(view("available", { ...FOUND, install: "notice" }).action, action("release", said.releasePage));
  assert.equal(view("available", { ...FOUND, install: "notice" }).hint, said.noticeNote);
  assert.deepEqual(view("available", { ...FOUND, install: "notice", url: undefined }).action, action("check", said.check));
  // The download, with its progress when the size is known, and then the restart.
  assert.deepEqual(view("downloading", { ...FOUND, progress: 40 }), {
    line: "Downloading version 3.0.1… 40%",
    bad: false,
    action: action("install", "Downloading…", true),
    hint: "",
  });
  assert.equal(view("downloading", FOUND).line, "Downloading version 3.0.1…");
  assert.deepEqual(view("downloading", FOUND).action, action("install", "Downloading…", true));
  // The whole download is in: the install that follows takes a moment.
  assert.deepEqual(view("downloading", { ...FOUND, progress: 100 }).action, action("install", said.installing, true));
  assert.deepEqual(view("ready", FOUND), {
    line: "Version 3.0.1 is ready. Restart Laci to finish.",
    bad: false,
    action: action("restart", said.restart),
    hint: said.restartNote,
  });
  // A failure is said as the desktop says it. The desktop keeps a version found whether the check,
  // the download or the restart failed, so the button looks again: it never installs in its place.
  assert.deepEqual(view("error", { error: "No connection." }), {
    line: "No connection.",
    bad: true,
    action: action("check", said.check),
    hint: "",
  });
  assert.deepEqual(view("error", { ...FOUND, error: "The download stopped." }), {
    line: "The download stopped.",
    bad: true,
    action: action("check", said.check),
    hint: "",
  });
  assert.deepEqual(view("error", { ...FOUND, install: "notice" }).action, action("release", said.releasePage));
  assert.equal(view("error", { ...FOUND, install: "notice" }).hint, said.noticeNote);
  assert.equal(view("error").line, said.failed, "when it gives no reason");
}

// --- Archive, and New project --------------------------------------------------------------------

/** Detailed's Archive dialog (dialogs.tsx) for acme-store, with the plan the fixtures have for it. */
async function archivePage() {
  const page = standIn();
  const timers = fakeTimers();
  const box = { picked: "/mnt/backup" };
  const asked = [];
  const plan = fixtures["archive/plan"][ACME];
  const app = page.store({
    snapshot: structuredClone(fixtures.snapshot),
    modal: { kind: "archive", id: ACME },
    design: "detailed",
    historyPending: false,
    working: "",
    palette: false,
  });
  // The dialog looks for what can be tabbed to: its buttons are all this page has.
  page.query = (_selector, host) => host.descendants().filter((n) => n.type === "button");
  const dialogs = load(
    "dialogs.tsx",
    {
      react: { ...page.react, lazy: () => nothing, Suspense: ({ children }) => children },
      "./api": {
        api: async (name, body = {}) => {
          asked.push([name, body]);
          if (name !== "archive/plan") throw new Error(`No answer for ${name}`);
          return { ...plan, dest: body.destination ?? plan.dest };
        },
        errorText,
      },
      "./store": {
        useApp: app,
        changed: noop,
        selectWhenReady: noop,
        run: async (task, _working, options = {}) => {
          try {
            return await task();
          } catch (error) {
            options.onError?.(error);
            return undefined;
          }
        },
      },
      "./pick": chooser(box),
      "./shortcuts": { detailedList: () => [] },
      "./common": { Icon: nothing, Ops: nothing, restoreFocus: noop, SeverityGlyph: nothing },
      "./settings": { useConfigPath: () => "~/.config/laci/config.json" },
      "./terminal-api": { closeTerminal: noop, useTerms: noop },
      "./session-ui": { AgentDialog: nothing, DeleteSessions: nothing, SessionDialog: nothing },
      "./mcp-setup": { McpDialog: nothing },
      "./select": {
        Select: nothing,
        SelectPortal: { Provider: ({ children }) => children },
        selectIsOpen: () => false,
      },
    },
    {
      ...held,
      document: page.document,
      HTMLElement: Host,
      window: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    },
  );
  page.mount(createElement(dialogs.Dialogs));
  // The plan of where it goes is asked for once the typing stops.
  const planned = async () => {
    timers.second();
    await page.settle();
  };
  await planned();
  return { ...page, box, plan, planned, asked: (name) => asked.filter(([request]) => request === name) };
}

export async function theArchiveDestinationTakesAChosenFolderAndTheProjectInsideIt() {
  const p = await archivePage();
  const input = () => field(p, "Archive destination");
  assert.equal(input().props.value, p.plan.dest);
  const button = () => picker(p, said.destinationTitle("acme-store"));
  assert.equal(button().textContent, "Choose…");
  assert.equal(button().parent, input().parent, "in the row of the field");
  aRowOfItsField(button());
  namedForItsFolder(button());
  // The destination is the project's own new folder, so the picker opens in the folder above it.
  assert.equal(button().props["data-from"], `${HOME}/project/_archive/clients`);
  // The folder chosen takes the project inside, under its own name, and the plan is asked for there.
  p.box.picked = "/mnt/backup";
  p.act(() => button().props.onClick());
  assert.equal(input().props.value, "/mnt/backup/acme-store");
  await p.planned();
  assert.deepEqual(p.asked("archive/plan").at(-1), [
    "archive/plan",
    { id: ACME, destination: "/mnt/backup/acme-store" },
  ]);
  assert.equal(button().props["data-from"], "/mnt/backup", "and now opens beside it");
  // A path typed still works, ~ as well; one that isn't a full path opens at the home folder.
  type(p, input(), "~/cold/acme-store");
  assert.equal(button().props["data-from"], `${HOME}/cold`);
  await p.planned();
  assert.deepEqual(p.asked("archive/plan").at(-1)[1], { id: ACME, destination: `${HOME}/cold/acme-store` });
  type(p, input(), "cold/acme-store");
  assert.equal(button().props["data-from"], "~");
}

/** Detailed's New project dialog (new-project.tsx), in the first folder Laci looks in. */
async function newProjectPage() {
  const page = standIn();
  const box = { picked: `${HOME}/work` };
  const asked = [];
  const app = page.store({
    snapshot: structuredClone(fixtures.snapshot),
    view: "today",
    cwd: HOME,
    terminalTarget: "internal",
    historyPending: false,
  });
  const { NewProject } = load(
    "new-project.tsx",
    {
      react: page.react,
      "./api": {
        api: async (name, body = {}) => {
          asked.push([name, body]);
          if (name !== "new/info") throw new Error(`No answer for ${name}`);
          return structuredClone(fixtures["new/info"]);
        },
        errorText,
      },
      "./dialogs": {
        DialogFrame: ({ children, footer }) => createElement("div", null, children, footer),
      },
      "./agent-launch": {
        AgentFields: nothing,
        agentDraft: () => ({ provider: "" }),
        withoutContinue: (draft) => draft,
        agentProviders: () => [],
        validateAgentDraft: noop,
      },
      "./pick": chooser(box),
      "./select": {
        Select: ({ label, value }) => createElement("select", { "aria-label": label, value }),
      },
      "./store": { useApp: app, changed: noop, selectWhenReady: noop },
      "./terminal-api": { useTerms: { setState: noop } },
    },
    { ...held, document: page.document },
  );
  page.mount(createElement(NewProject));
  await page.settle();
  return { ...page, box, asked: (name) => asked.filter(([request]) => request === name) };
}

export async function newProjectChoosesItsLocationAndATemplateFolderWithThePicker() {
  const p = await newProjectPage();
  const where = () => p.find((n) => n.type === "select" && n.props["aria-label"] === "Project location");
  const button = picker(p, said.locationTitle);
  assert.equal(button.textContent, "Choose…");
  assert.equal(button.parent, where().parent, "beside the location");
  aRowOfItsField(button);
  namedForItsFolder(button);
  assert.equal(button.props["data-from"], `${HOME}/project`, "it opens where the project would go now");
  assert.equal(button.props.disabled, false);
  p.box.picked = `${HOME}/work`;
  p.act(() => picker(p, said.locationTitle).props.onClick());
  assert.equal(where().props.value, `${HOME}/work`);
  assert.equal(picker(p, said.locationTitle).props["data-from"], `${HOME}/work`);
  // The folder of a local template is a folder field too, once "Local template" is the way to start.
  assert.equal(picker(p, said.templateTitle), undefined);
  const ways = p.all((n) => n.type === "input" && n.props.name === "from");
  p.act(() => ways[1].props.onChange());
  const starter = () =>
    p.find((n) => n.type === "input" && n.props.placeholder?.endsWith("starter"));
  const add = () => p.button("Add template folder");
  assert.equal(add().props.disabled, true, "nothing to add yet");
  assert.equal(picker(p, said.templateTitle).parent, starter().parent);
  aRowOfItsField(picker(p, said.templateTitle));
  namedForItsFolder(picker(p, said.templateTitle));
  assert.equal(picker(p, said.templateTitle).props["data-from"], "~");
  p.box.picked = `${HOME}/templates/starter`;
  p.act(() => picker(p, said.templateTitle).props.onClick());
  assert.equal(starter().props.value, `${HOME}/templates/starter`);
  assert.equal(add().props.disabled, false);
  assert.equal(p.asked("new/template").length, 0, "adding it is the person's click");
  assert.equal(picker(p, said.templateTitle).props["data-from"], `${HOME}/templates/starter`);
  // Typing a path is still how it is written when the picker isn't wanted.
  type(p, starter(), "/srv/templates/site");
  assert.equal(starter().props.value, "/srv/templates/site");
}
