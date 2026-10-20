// Simple's Settings (ui/src/simple/SettingsPage.tsx) and its draft (ui/src/simple/model.ts): what
// waits for "Save changes" and what changes at once, each through the request Detailed's Settings
// sends, and the browser preview's answer to the update choice (ui/src/preview/ipc.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";
import { kit } from "./simple-helpers.test.mjs";

const { createElement } = requireUi("react");
const noop = () => {};

const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);
const model = load("simple/model.ts");
const words = load("words.ts");
const said = words.settings;
const INFO = fixtures["setup/info"];
const PREFS = {
  theme: null,
  design: "simple",
  updates: null,
  configured: true,
  configPath: "~/.config/laci/config.json",
};

// ── The draft ──────────────────────────────────────────────────────────────────────────────────────

export async function theSavedSettingsAreTheDraftToChange() {
  const saved = model.draftOf(INFO);
  assert.deepEqual(saved, {
    roots: ["/home/demo/project"],
    archiveDir: "",
    reportsDir: "/home/demo/Documents/agent-reports",
    presets: ["claude", "codex"],
    apps: { editor: "code", files: "dolphin", terminal: "kitty" },
    terminalTarget: "internal",
  });
  assert.equal(model.draftChanged(saved, model.draftOf(INFO)), false);
  // Each field counts; the order of folders and of tools doesn't.
  const changed = (patch) => model.draftChanged({ ...saved, ...patch }, saved);
  assert.equal(changed({ archiveDir: "/mnt/archive" }), true);
  assert.equal(changed({ reportsDir: "" }), true);
  assert.equal(changed({ apps: { ...saved.apps, editor: "zed" } }), true);
  assert.equal(changed({ terminalTarget: "external" }), true);
  assert.equal(changed({ presets: ["codex", "claude"] }), false);
  const two = model.withRoot(saved, "/home/demo/work");
  assert.equal(model.draftChanged({ ...two, roots: [...two.roots].reverse() }, two), false);
}

export async function aProjectFolderIsAddedOnceAndRemovedByItsPath() {
  const saved = model.draftOf(INFO);
  const added = model.withRoot(saved, "/home/demo/work");
  assert.deepEqual(added.roots, ["/home/demo/project", "/home/demo/work"]);
  assert.equal(model.withRoot(added, "/home/demo/work"), added, "already there");
  assert.deepEqual(model.withoutRoot(added, "/home/demo/project").roots, ["/home/demo/work"]);
  // Another case is another folder.
  assert.notEqual(model.withRoot(added, "/home/demo/Work"), added);
  assert.deepEqual(model.withTool(saved, "claude", false).presets, ["codex"]);
  assert.deepEqual(model.withTool(saved, "antigravity", true).presets, ["claude", "codex", "antigravity"]);
  assert.deepEqual(
    model.suggestedFolders(
      [
        { path: "/home/demo/project", repos: 6 },
        { path: "/home/demo/code", repos: 1 },
        { path: "/home/demo/work", repos: 4 },
      ],
      saved.roots,
    ).map((c) => c.path),
    ["/home/demo/work", "/home/demo/code"],
  );
}

export async function appsOfferWhatIsInstalledAndWhatWasChosen() {
  assert.deepEqual(model.appChoices(["code", "zed"], "subl"), [
    { app: "code", name: "VS Code", installed: true },
    { app: "zed", name: "Zed", installed: true },
    { app: "subl", name: "Sublime Text", installed: false },
  ]);
  assert.deepEqual(model.appChoices(["code"], "code").map((c) => c.app), ["code"]);
  assert.equal(said.notInstalledApp("Sublime Text"), "Sublime Text (not installed)");
}

export async function theAiToolsAreTheOnesLaciComesWithAndTheSummariesFolderSaysHowItIs() {
  assert.deepEqual(model.catalogTools(fixtures.snapshot), [
    { id: "antigravity", name: "Antigravity", found: false },
    { id: "claude", name: "Claude Code", found: true },
    { id: "codex", name: "Codex", found: true },
  ]);
  const dir = { path: "/home/demo/Documents/agent-reports", total: 7 };
  assert.equal(model.summariesFolder(dir.path, dir), "read");
  assert.equal(model.summariesFolder("/home/demo/notes", dir), "unsaved");
  assert.equal(model.summariesFolder("", undefined), "off");
  assert.equal(model.summariesFolder(dir.path, { ...dir, error: "Permission denied" }), "unreadable");
  assert.equal(said.summariesFolder.read(7), "7 summaries found.");
}

// ── The page ───────────────────────────────────────────────────────────────────────────────────────

const settingsKit = kit.shared();
let settingsModule;
/** SettingsPage.tsx, compiled the first time a test needs it. */
function settingsOnce() {
  const { live, store } = settingsKit;
  return (settingsModule ??= load(
    "simple/SettingsPage.tsx",
    {
      "./settings.css": {},
      react: settingsKit.react,
      "@tauri-apps/api/app": { getVersion: live("getVersion") },
      "../api": { api: live("api"), errorText: String },
      "../brand": { LaciMark: () => null },
      "../common": { Icon: () => null },
      "../pick": {
        ChooseFolder: ({ label, name, onPick }) =>
          createElement(
            "button",
            {
              type: "button",
              "aria-label": name,
              onClick: () => onPick(settingsKit.box.current.picked),
            },
            label,
          ),
      },
      "../store": {
        changed: live("changed"),
        copyText: live("copyText"),
        refreshLog: noop,
        run: live("run"),
        setDesign: live("setDesign"),
        setTheme: live("setTheme"),
        toast: live("toast"),
        urlOpen: live("urlOpen"),
        useApp: store("app"),
      },
      "./act": {
        aiTools: (s) =>
          s.connectors
            .filter((c) => c.capabilities?.launch)
            .map((c) => ({ value: c.provider ?? c.id, label: c.name })),
      },
      "./AiHelpers": {
        setCopying: live("setCopying"),
        showTools: live("showTools"),
        useCapabilities: () => ({}),
        // Tested with AI helpers (simple-helpers.test.mjs); here, where Settings sends the focus.
        useFocusStays: (_page, instead) => void (settingsKit.box.current.instead = instead),
        useHelpers: store("helpers"),
      },
      "./ui": kit.blocks(),
    },
    { requestAnimationFrame: (fn) => fn() },
  ));
}

/**
 * SettingsPage.tsx on the preview's scan, `setup/info` and `prefs` as the fixtures have them. Every
 * request is kept, and what the store's helpers were asked for.
 */
async function settingsPage({ prefs = PREFS, technical = false, replies = {} } = {}) {
  const page = kit.standIn();
  const asked = [];
  const did = [];
  const toasts = [];
  const app = page.store({
    snapshot: structuredClone(fixtures.snapshot),
    revision: 1,
    historyPending: false,
    setupPending: false,
    design: "simple",
    theme: "system",
    activity: null,
    navigate: (to) => did.push(["navigate", to]),
  });
  const helpers = page.store({ technical });
  const answers = {
    "setup/info": () => structuredClone(INFO),
    prefs: () => prefs,
    "setup/save": () => ({ revision: 2 }),
    updates: (body) => ({ ...prefs, updates: body.updates }),
    ...replies,
  };
  settingsKit.box.current = {
    page,
    app,
    helpers,
    picked: "/home/demo/work",
    api: async (name, body = {}) => {
      asked.push([name, body]);
      const answer = answers[name];
      if (!answer) throw new Error(`No answer for ${name}`);
      return answer(body);
    },
    run: kit.runner(toasts),
    toast: (title, message = "") => void toasts.push([title, message]),
    changed: (_change, title, message) => void toasts.push([title, message]),
    getVersion: async () => "3.0.0",
    ...Object.fromEntries(
      ["copyText", "setDesign", "setTheme", "urlOpen", "setCopying", "showTools"].map((name) => [
        name,
        (...args) => void did.push([name, ...args]),
      ]),
    ),
  };
  page.mount(createElement(settingsOnce().SettingsPage));
  await page.settle();
  return {
    ...page,
    app,
    helpers,
    toasts,
    did,
    asked: (name) => asked.filter(([request]) => request === name),
    /** Where the page sends the focus when the control that had it goes. */
    instead: (control) => settingsKit.box.current.instead(control),
    /** The radio button whose option starts with `label`. */
    radio: (label) =>
      page
        .find((n) => n.type === "label" && n.textContent.startsWith(label))
        ?.children.find((n) => n.type === "input"),
  };
}

export async function saveChangesComesWithAChangeAndSendsEverySetting() {
  const page = await settingsPage();
  assert.equal(page.button(said.save), undefined, "nothing to save yet");
  page.act(() => page.button(said.remove).props.onClick());
  const save = page.button(said.save);
  assert.equal(save.props["data-kind"], "filled", "the screen's one filled button");
  assert.match(page.text(), new RegExp(said.unsaved));
  page.act(() => save.props.onClick());
  await page.settle();
  // One request saves them all, as Detailed's Settings sends it: what was not touched stays.
  assert.deepEqual(page.asked("setup/save"), [
    [
      "setup/save",
      {
        roots: [],
        archiveDir: "",
        reportsDir: "/home/demo/Documents/agent-reports",
        presets: ["claude", "codex"],
        apps: { editor: "code", files: "dolphin", terminal: "kitty" },
        terminalTarget: "internal",
      },
    ],
  ]);
  assert.deepEqual(page.toasts.at(-1), [said.saved, said.savedNote]);
  // What is saved is read again, and with nothing waiting the bar goes.
  assert.equal(page.asked("setup/info").length, 2);
  assert.equal(page.button(said.save), undefined);
}

export async function aSaveThatFailsSaysWhyAndKeepsTheChanges() {
  const page = await settingsPage({
    replies: {
      "setup/save": () => {
        throw new Error("That folder can’t be read");
      },
    },
  });
  page.act(() => page.button(said.remove).props.onClick());
  page.act(() => page.button(said.save).props.onClick());
  await page.settle();
  // Said as a problem is: its icon and words (a Callout), never red words alone.
  const alert = page.find((n) => n.props.role === "alert");
  assert.match(alert.textContent, /That folder can’t be read/);
  assert.ok(alert.descendants().some((n) => n.props["data-tone"] === "act"));
  // The changes still wait, to try again or to discard.
  assert.ok(page.button(said.save));
  assert.doesNotMatch(page.text(), /~\/project/);
  page.act(() => page.button(said.discard).props.onClick());
  await page.settle();
  assert.equal(page.find((n) => n.props.role === "alert"), undefined);
}

export async function discardPutsBackWhatIsSaved() {
  let info = structuredClone(INFO);
  const page = await settingsPage({ replies: { "setup/info": () => structuredClone(info) } });
  page.act(() => page.radio(said.targets.external).props.onChange());
  assert.ok(page.button(said.save));
  // Meanwhile something else changes what is saved, such as an Undo in Activity: the changes that
  // wait stay as they are.
  info = { ...info, roots: [...info.roots, "/home/demo/work"] };
  page.app.setState({ revision: 2 });
  await page.settle();
  assert.equal(page.radio(said.targets.external).props.checked, true);
  assert.doesNotMatch(page.text(), /~\/work/);
  // Discard puts back what is saved now, not what was saved when the changes began.
  page.act(() => page.button(said.discard).props.onClick());
  await page.settle();
  assert.equal(page.button(said.save), undefined);
  assert.equal(page.radio(said.targets.internal).props.checked, true);
  assert.match(page.text(), /~\/work/);
  assert.deepEqual(page.asked("setup/save"), []);
}

export async function aChangeMadeWhileSettingsAreReadAgainStays() {
  // The first read answers at once; each later one waits until the test lets it answer.
  const waiting = [];
  let reads = 0;
  const page = await settingsPage({
    replies: {
      "setup/info": () =>
        ++reads === 1
          ? structuredClone(INFO)
          : new Promise((answer) => waiting.push(() => answer(structuredClone(INFO)))),
    },
  });
  const tool = (name) =>
    page
      .find((n) => n.type === "label" && n.textContent.startsWith(name))
      .children.find((n) => n.type === "input");
  // A rescan moves the revision on, so the page reads what is saved again. Before the answer
  // comes, an AI tool is ticked.
  page.app.setState({ revision: 2 });
  await page.settle();
  assert.equal(waiting.length, 1);
  page.act(() => tool("Antigravity").props.onChange({ target: { checked: true } }));
  assert.ok(page.button(said.save));
  waiting.shift()();
  await page.settle();
  // The tick stays, with the bar that saves it.
  assert.equal(tool("Antigravity").props.checked, true);
  assert.ok(page.button(said.save));
  // Discard reads what is saved again too, and a change made before that answer stays as well.
  page.act(() => page.button(said.discard).props.onClick());
  await page.settle();
  assert.equal(waiting.length, 1);
  page.act(() => page.radio(said.targets.external).props.onChange());
  waiting.shift()();
  await page.settle();
  assert.equal(page.radio(said.targets.external).props.checked, true);
  assert.ok(page.button(said.save));
}

export async function aSwitchOfDesignWaitsWhileChangesAreUnsaved() {
  // Detailed's Settings would start without them: the store holds a switch back while they wait.
  const page = await settingsPage();
  const waits = () => page.app.getState().settingsDirty;
  assert.equal(waits(), false);
  page.act(() => page.button(said.remove).props.onClick());
  assert.equal(waits(), true);
  page.act(() => page.button(said.discard).props.onClick());
  await page.settle();
  assert.equal(waits(), false);
  // Leaving Settings drops the changes, as it always has, and nothing waits any more.
  page.act(() => page.button(said.remove).props.onClick());
  assert.equal(waits(), true);
  page.mount(null);
  assert.equal(waits(), false);
}

export async function saveChangesGivesTheFocusBackToTheSettingYouUsedLast() {
  const page = await settingsPage();
  const root = page.find((n) => String(n.props.className).startsWith("s-page s-settings"));
  const radio = page.radio(said.targets.external);
  // The focus comes into the page, then a setting is changed: that is where you are.
  root.props.onFocus({ target: page.button(said.designs.simple) });
  page.act(() => radio.props.onChange());
  root.props.onChange({ target: radio });
  // Tabbing on to the bar passes the rest of the page, and neither that nor the bar counts.
  root.props.onFocus({ target: page.button(said.report) });
  const save = page.button(said.save);
  root.props.onFocus({ target: save });
  root.props.onClick({ target: save });
  // When the bar goes, its buttons send the focus back to the setting; any other control that goes
  // leaves it to the usual next one.
  assert.equal(page.instead(save), radio);
  assert.equal(page.instead(page.button(said.discard)), radio);
  assert.equal(page.instead(radio), undefined);
  // A folder you remove goes with its button, and the control the focus moves on to takes its place.
  const remove = page.button(said.remove);
  root.props.onClick({ target: remove });
  page.act(() => remove.props.onClick());
  const add = page.button(said.addFolder);
  root.props.onFocus({ target: add });
  assert.equal(page.instead(page.button(said.save)), add);
}

export async function aFolderFromThePickerJoinsTheProjectFoldersOnce() {
  const page = await settingsPage();
  page.act(() => page.button(said.addFolder).props.onClick());
  assert.match(page.text(), /~\/work/);
  page.act(() => page.button(said.addFolder).props.onClick());
  page.act(() => page.button(said.save).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("setup/save")[0][1].roots, ["/home/demo/project", "/home/demo/work"]);
}

export async function aWholeDiskIsNoProjectFolder() {
  const page = await settingsPage();
  // "/": a toast says why, and nothing changes.
  for (const disk of ["/", "//"]) {
    settingsKit.box.current.picked = disk;
    page.act(() => page.button(said.addFolder).props.onClick());
    assert.deepEqual(page.toasts.at(-1), [said.wholeDisk, said.wholeDiskNote], disk);
  }
  assert.equal(page.button(said.save), undefined, "nothing waits to be saved");
  // A folder on another disk is a folder.
  settingsKit.box.current.picked = "/mnt/projects";
  page.act(() => page.button(said.addFolder).props.onClick());
  page.act(() => page.button(said.save).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("setup/save")[0][1].roots, [
    "/home/demo/project",
    "/mnt/projects",
  ]);
}

export async function homeAddsNoWholeDiskEither() {
  // Home's "Choose folder…", when no project folder is set yet, saves the folder at once.
  const asked = [];
  const toasts = [];
  const act = load("simple/act.ts", {
    "../api": {
      api: async (name, body) => {
        asked.push([name, body]);
        return name === "setup/info" ? structuredClone(INFO) : { revision: 2 };
      },
    },
    "../agent-launch": { agentProviders: () => [] },
    "../session-ui": { requestResume: noop },
    "../store": {
      changed: (_change, title, message) => void toasts.push([title, message]),
      run: (task) => task(),
      toast: (title, message, options) => void toasts.push([title, message, options]),
      useApp: { setState: noop },
    },
  });
  for (const disk of ["/", "//"]) await act.addProjectFolder(disk);
  assert.deepEqual(asked, [], "nothing is read or saved");
  assert.deepEqual(
    toasts,
    ["/", "//"].map(() => [said.wholeDisk, said.wholeDiskNote, { error: true }]),
  );
  // A folder is added as it always was, with every other setting as it is saved.
  await act.addProjectFolder("/home/demo/work");
  assert.deepEqual(asked.map(([name]) => name), ["setup/info", "setup/save"]);
  assert.deepEqual(asked[1][1].roots, ["/home/demo/project", "/home/demo/work"]);
  assert.deepEqual(toasts.at(-1), [words.home.addedFolder, "work"]);
}

export async function eachFolderButtonSaysWhichFolderItChooses() {
  const page = await settingsPage();
  const named = (name) =>
    page.find((n) => n.type === "button" && n.props["aria-label"] === name);
  // Two of them say "Choose folder…". A screen reader names each by its folder, in a name that
  // starts with the button's own words, so a voice command finds it by them too.
  for (const [shown, name] of [
    [said.addFolder, said.addFolderName],
    [said.chooseArchive, said.chooseArchiveName],
    [said.chooseSummaries, said.chooseSummariesName],
  ]) {
    assert.equal(named(name)?.textContent, shown, name);
    assert.ok(name.startsWith(shown.replace("…", "")), name);
  }
  assert.equal(said.chooseArchive, said.chooseSummaries);
  assert.notEqual(said.chooseArchiveName, said.chooseSummariesName);
}

export async function theUpdateChoiceIsSavedAtOnceThroughItsOwnRequest() {
  const page = await settingsPage();
  // Nobody has chosen yet: neither choice is ticked, and the page says Laci doesn't look.
  assert.equal(page.radio(said.updateChoices.daily).props.checked, false);
  assert.equal(page.radio(said.updateChoices.off).props.checked, false);
  assert.match(page.text(), new RegExp(said.updatesUnset));
  page.act(() => page.radio(said.updateChoices.daily).props.onChange());
  await page.settle();
  assert.deepEqual(page.asked("updates"), [["updates", { updates: "daily" }]]);
  assert.equal(page.radio(said.updateChoices.daily).props.checked, true);
  assert.deepEqual(page.toasts.at(-1), [said.updatesSaved.daily, ""]);
  // It is not one of the changes that wait for Save changes.
  assert.equal(page.button(said.save), undefined);
  assert.deepEqual(page.asked("setup/save"), []);
}

export async function theUpdateChoiceWaitsForPrefs() {
  const page = await settingsPage({
    replies: {
      prefs: () => {
        throw new Error("prefs failed");
      },
    },
  });
  assert.equal(page.radio(said.updateChoices.daily).props.disabled, true);
}

export async function theViewThemeAndCopyOfChatsChangeAtOnce() {
  const page = await settingsPage();
  const detailed = page.find(
    (n) => n.type === "button" && n.props["aria-pressed"] === false && n.textContent.startsWith("Detailed"),
  );
  page.act(() => detailed.props.onClick());
  page.act(() => page.radio(words.shell.themes.dark).props.onChange());
  const copy = page
    .find((n) => n.type === "label" && n.textContent.startsWith(words.aiHelpers.copyAuto))
    .children.find((n) => n.type === "input");
  page.act(() => copy.props.onChange({ target: { checked: true } }));
  assert.deepEqual(page.did, [
    ["setDesign", "detailed"],
    ["setTheme", "dark"],
    ["setCopying", true],
  ]);
  assert.equal(page.button(said.save), undefined, "none of them waits for Save changes");
}

export async function technicalSettingsOpenWhenToolsSendsYouThere() {
  const shut = await settingsPage();
  assert.ok(shut.button(said.showTechnical));
  assert.equal(shut.button(said.addToolButton), undefined, "folded away");
  const page = await settingsPage({ technical: true });
  assert.ok(page.button(said.hideTechnical));
  assert.equal(page.helpers.getState().technical, false, "asked once");
  assert.equal(page.document.activeElement?.type, "h2", "the focus goes to it");
  // Your own AI tool is added there, with the dialog both designs share.
  page.act(() => page.button(said.addToolButton).props.onClick());
  assert.deepEqual(page.app.getState().modal, { kind: "connector" });
  // The settings file is where prefs says.
  assert.match(page.text(), /~\/\.config\/laci\/config\.json/);
}

export async function aboutSaysTheVersionAndWhereToReportAProblem() {
  const page = await settingsPage();
  assert.match(page.text(), /Version 3\.0\.0/);
  page.act(() => page.button(said.report).props.onClick());
  assert.deepEqual(page.did.at(-1), ["urlOpen", words.help.reportUrl]);
}

// ── The preview ────────────────────────────────────────────────────────────────────────────────────

/** Runs `body` with the preview's engine started fresh; `request` is the interface's `api`. */
async function onPreview(body) {
  globalThis.window = { crypto: globalThis.crypto };
  try {
    load("preview/ipc.ts").installIpc({ design: "simple", theme: "light", updates: null });
    const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
    await body((name, args = {}) => invoke("request", { name, body: args }), invoke);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete globalThis.window;
  }
}

export async function thePreviewKeepsTheUpdateChoiceAndPrefsReportsIt() {
  await onPreview(async (request, invoke) => {
    assert.equal((await request("prefs")).updates, null);
    const reply = await request("updates", { updates: "daily" });
    // It answers like prefs, as the engine's does.
    assert.equal(reply.updates, "daily");
    assert.equal(reply.configPath, "~/.config/laci/config.json");
    assert.equal((await request("prefs")).updates, "daily");
    // Only the two choices are taken, and a refused one changes nothing.
    await assert.rejects(request("updates", { updates: "weekly" }));
    assert.equal((await request("prefs")).updates, "daily");
    // About shows the version the pretend update starts from.
    assert.equal(await invoke("plugin:app|version"), (await request("update/status")).current);
  });
}
