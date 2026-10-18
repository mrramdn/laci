// ui:P3, the ways to switch and first run: the first-run screen's design and update choice and its
// notes for this computer (ui/src/settings.tsx), Settings › Appearance in Detailed, the toggle and
// Help at the foot of Detailed's sidebar (views/sidebar.tsx), Search and actions in either design
// (palette.tsx) and the card on Today that offers Simple (views/today.tsx). A stand-in for React
// draws each in plain Node, on the app's own store, so a test can pick, click and press keys.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";

const { createElement, Fragment } = requireUi("react");
const fixtures = requireUi("./src/preview/fixtures.json");
const noop = () => {};

// ── The stand-in ───────────────────────────────────────────────────────────────────────────────────

/** A drawn element: what a ref holds, what an event's target is and what can take the focus. */
class Host {
  constructor(page, type) {
    this.page = page;
    this.type = type;
    this.props = {};
    this.children = [];
    this.parent = null;
    this.connected = true;
  }
  get textContent() {
    return this.children
      .map((child) => (child instanceof Host ? child.textContent : child))
      .join("");
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `<${this.type}>${this.textContent}`;
  }
  get isConnected() {
    return this.connected;
  }
  /** Every element inside this one. */
  descendants() {
    return this.children.flatMap((child) =>
      child instanceof Host ? [child, ...child.descendants()] : [],
    );
  }
  focus() {
    this.page.document.activeElement = this;
  }
  // The page has no selectors and no layout.
  querySelector() {
    return null;
  }
  closest() {
    return null;
  }
  scrollIntoView() {}
}

/**
 * A page that components are drawn on, with React's hooks standing in for the real ones. State, refs
 * and effects keep their place between draws; an effect runs after the draw in which its inputs
 * changed, and its clean-up before it runs again or when its component goes. A change to the state
 * or to the app's store draws again in the next microtask.
 */
function standIn(document) {
  const instances = new Map();
  const hosts = new Map();
  let root = null;
  let output = [];
  let current = null;
  let pass = 0;
  let ids = 0;
  let dirty = false;
  let queued = false;
  let layout = [];
  let passive = [];
  const page = { document };
  const schedule = () => {
    dirty = true;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      flush();
    });
  };
  const slot = () => (current.cells[current.at++] ??= {});
  const effect = (list) => (run, deps) => {
    const cell = slot();
    const same =
      cell.deps &&
      deps &&
      cell.deps.length === deps.length &&
      deps.every((dep, i) => Object.is(dep, cell.deps[i]));
    cell.deps = deps;
    if (!same) list().push({ cell, run });
  };
  const memo = (make, deps) => {
    const cell = slot();
    if (
      !cell.deps ||
      !deps ||
      deps.length !== cell.deps.length ||
      deps.some((dep, i) => !Object.is(dep, cell.deps[i]))
    ) {
      cell.value = make();
      cell.deps = deps;
    }
    return cell.value;
  };
  page.react = {
    Fragment,
    useState(initial) {
      const cell = slot();
      if (!("value" in cell)) {
        cell.value = typeof initial === "function" ? initial() : initial;
        cell.set = (next) => {
          const value = typeof next === "function" ? next(cell.value) : next;
          if (Object.is(value, cell.value)) return;
          cell.value = value;
          schedule();
        };
      }
      return [cell.value, cell.set];
    },
    useRef(initial) {
      const cell = slot();
      return (cell.ref ??= { current: initial });
    },
    useId: () => (slot().id ??= `:r${++ids}:`),
    useMemo: memo,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: effect(() => passive),
    useLayoutEffect: effect(() => layout),
  };
  function render(element, path) {
    if (element === null || element === undefined || typeof element === "boolean")
      return [];
    if (typeof element === "string" || typeof element === "number")
      return [String(element)];
    if (Array.isArray(element))
      return element.flatMap((child, i) =>
        render(child, `${path}[${child?.key ?? i}]`),
      );
    const { type, props } = element;
    if (type === Fragment) return render(props.children, path);
    const key = `${path}/${typeof type === "function" ? type.name : type}${element.key ? `:${element.key}` : ""}`;
    if (typeof type === "function") {
      const instance = instances.get(key) ?? { cells: [] };
      instances.set(key, instance);
      instance.pass = pass;
      instance.at = 0;
      const outer = current;
      current = instance;
      const drawn = type(props);
      current = outer;
      return render(drawn, key);
    }
    const host = hosts.get(key) ?? new Host(page, type);
    hosts.set(key, host);
    host.pass = pass;
    host.props = props;
    host.children = render(props.children, key);
    for (const child of host.children) if (child instanceof Host) child.parent = host;
    if (typeof props.ref === "function") props.ref(host);
    else if (props.ref) props.ref.current = host;
    return [host];
  }
  function draw() {
    pass++;
    layout = [];
    passive = [];
    output = root ? render(root, "") : [];
    for (const [key, instance] of instances)
      if (instance.pass !== pass) {
        for (const cell of instance.cells) cell.cleanup?.();
        instances.delete(key);
      }
    for (const [key, host] of hosts)
      if (host.pass !== pass) {
        host.connected = false;
        if (host.props.ref && typeof host.props.ref !== "function")
          host.props.ref.current = null;
        hosts.delete(key);
      }
    for (const list of [layout, passive]) {
      for (const { cell } of list) {
        cell.cleanup?.();
        cell.cleanup = undefined;
      }
      for (const { cell, run } of list) {
        const cleanup = run();
        cell.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
    }
  }
  function flush() {
    for (let turns = 0; dirty; turns++) {
      assert.ok(turns < 50, "the page never settles");
      dirty = false;
      draw();
    }
  }
  const all = (predicate) => {
    const found = [];
    const walk = (nodes) => {
      for (const node of nodes)
        if (node instanceof Host) {
          if (predicate(node)) found.push(node);
          walk(node.children);
        }
    };
    walk(output);
    return found;
  };
  return Object.assign(page, {
    schedule,
    mount(element) {
      root = element;
      dirty = true;
      flush();
      return page;
    },
    /** Lets every promise that can settle, settle, and draws what changed. */
    async settle() {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      flush();
    },
    all,
    find: (predicate) => all(predicate)[0],
    /** The button that says `text`. */
    button: (text) =>
      all((n) => n.type === "button" && n.textContent.trim() === text)[0],
    text: () => output.map((n) => (n instanceof Host ? n.textContent : n)).join(" "),
    /** Runs a click or a change, as a person makes it, and draws what it changed. */
    act(work) {
      work();
      flush();
    },
  });
}

// ── The app's store, with the window on it ─────────────────────────────────────────────────────────

/**
 * The app: its store (store.ts as it is, with requests answered by `answers`), on a document of
 * `os` that the components share, and a page to draw them on. `requests` lists what was asked for.
 * `globals` gives the components more of a browser, such as a MutationObserver.
 */
function app({ os = "linux", design = "detailed", answers = {}, globals = {} } = {}) {
  const requests = [];
  const main = { id: "main", focused: 0, focus: () => main.focused++ };
  const document = {
    documentElement: { dataset: { os, design } },
    body: {},
    activeElement: null,
    getElementById: (id) => (id === "main" ? main : null),
    addEventListener: noop,
    removeEventListener: noop,
  };
  const api = {
    api: async (name, body) => {
      requests.push([name, body]);
      const answer = answers[name];
      return typeof answer === "function" ? answer(body) : (answer ?? {});
    },
    errorText: (error) => (error instanceof Error ? error.message : String(error)),
  };
  const page = standIn(document);
  const store = load("store.ts", { "./api": api }, {
    document,
    localStorage: { getItem: () => null, setItem: noop },
    setTimeout: () => 0,
    clearTimeout: noop,
  });
  store.useApp.subscribe(() => page.schedule());
  // The components read the store through a selector, as they do the app's.
  const useApp = Object.assign(
    (select = (state) => state) => select(store.useApp.getState()),
    store.useApp,
  );
  const stubs = {
    react: page.react,
    "./api": api,
    "../api": api,
    "./store": { ...store, useApp },
    "../store": { ...store, useApp },
    "./clock": { useNow: () => Date.now() },
    "../clock": { useNow: () => Date.now() },
    "./brand": { LaciMark: () => null },
    "../brand": { LaciMark: () => null },
    "./styles/looks.css": {},
    "./select": { Select: () => null },
    "./deadline": { DeadlinePill: () => null },
    "../deadline": { DeadlinePill: () => null },
  };
  const common = {
    Icon: () => null,
    KindIcon: () => null,
    PriorityGlyph: () => null,
    Highlight: ({ text }) => text,
    restoreFocus: noop,
  };
  stubs["./common"] = common;
  stubs["../common"] = common;
  return {
    page,
    store,
    state: () => store.useApp.getState(),
    requests,
    asked: (name) => requests.filter(([request]) => request === name),
    main,
    /** Loads a file of the interface onto this app's store and page. */
    load: (file, more = {}) =>
      load(file, { ...stubs, ...more }, { document, HTMLElement: Host, ...globals }),
  };
}

const snapshot = (configured = true) => ({
  ...structuredClone(fixtures.snapshot),
  revision: 1,
  configured,
});
const prefs = (choices = {}) => ({
  theme: null,
  design: null,
  updates: null,
  configured: false,
  configPath: "~/.config/laci/config.json",
  os: "linux",
  ...choices,
});
const setupInfo = (more = {}) => ({
  ...structuredClone(fixtures["setup/info"]),
  configured: false,
  roots: [],
  candidates: [{ path: "/home/demo/project", repos: 7 }],
  ...more,
});
const words = load("words.ts");

// ── First run ──────────────────────────────────────────────────────────────────────────────────────

/** A new install on its first-run screen, as the window shows it once the saved choices are in. */
async function firstRun({ os, answers = {}, saved = {}, globals } = {}) {
  const world = app({
    os,
    design: "simple",
    globals,
    answers: {
      prefs: prefs(saved),
      "setup/info": setupInfo(),
      "setup/save": {},
      design: (body) => body,
      updates: (body) => prefs({ ...saved, ...body, configured: true }),
      ...answers,
    },
  });
  world.store.applyPrefs(prefs(saved));
  world.store.useApp.getState().load(snapshot(false));
  const { Settings } = world.load("settings.tsx");
  world.page.mount(createElement(Settings, { first: true }));
  await world.page.settle();
  const radio = (name, value) =>
    world.page.find(
      (n) =>
        n.type === "input" &&
        n.props.type === "radio" &&
        n.props.value === value &&
        (name === "updates" ? n.props.name === "updates" : n.props.name !== "updates"),
    );
  return {
    ...world,
    radio,
    pick: (name, value) => world.page.act(() => radio(name, value).props.onChange()),
    start: async () => {
      world.page.act(() => world.page.button(words.firstRun.start).props.onClick());
      await world.page.settle();
    },
    skip: () => world.page.act(() => world.page.button("Skip for now").props.onClick()),
  };
}

export async function firstRunAsksHowLaciShouldLookWithSimplePicked() {
  const run = await firstRun();
  const text = run.page.text();
  assert.match(text, /Welcome to Laci/);
  // The last question is how Laci should look, after the one about new versions.
  assert.ok(
    text.indexOf(words.firstRun.updatesTitle) < text.indexOf(words.firstRun.lookTitle),
  );
  assert.ok(text.indexOf(words.firstRun.lookTitle) < text.indexOf(words.firstRun.start));
  assert.equal(run.radio("design", "simple").props.checked, true);
  assert.equal(run.radio("design", "detailed").props.checked, false);
  // A new install's window is Simple while it asks, so first run wears Simple's colours.
  assert.equal(run.state().design, "simple");
  assert.equal(run.radio("updates", "daily").props.checked, true);
  // Picking changes nothing until the setup is saved or skipped.
  run.pick("design", "detailed");
  assert.equal(run.radio("design", "detailed").props.checked, true);
  assert.equal(run.state().design, "simple");
  assert.deepEqual(run.asked("design"), []);
}

export async function startingSavesTheDesignFirstAndTheUpdateChoiceWithTheSetup() {
  const run = await firstRun();
  run.pick("design", "detailed");
  run.pick("updates", "off");
  await run.start();
  const order = run.requests
    .map(([name]) => name)
    .filter((name) => ["design", "setup/save", "updates"].includes(name));
  assert.deepEqual(order, ["design", "setup/save", "updates"]);
  assert.deepEqual(run.asked("design"), [["design", { design: "detailed" }]]);
  assert.deepEqual(run.asked("updates"), [["updates", { updates: "off" }]]);
  assert.equal(run.state().design, "detailed");
  assert.equal(run.state().designSet, true);
  // The choice is on the screen as it is made: no "Now in Detailed view".
  assert.notEqual(run.state().toast?.title, "Now in Detailed view");
}

export async function skippingKeepsThePickedDesignAndNothingElse() {
  const run = await firstRun();
  run.pick("updates", "off");
  run.skip();
  await run.page.settle();
  assert.deepEqual(run.asked("design"), [["design", { design: "simple" }]]);
  // Whether to look for new versions is a choice of its own: Skip doesn't make it.
  assert.deepEqual(run.asked("updates"), []);
  assert.deepEqual(run.asked("setup/save"), []);
  assert.equal(run.state().skipSetup, true);
  assert.equal(run.state().designSet, true);
}

/**
 * First run on a page with a MutationObserver, whose #main is first run's own until `drawn()` puts
 * the window's page in its place. `changed()` tells the observers that the page changed.
 */
async function firstRunOnAPage() {
  const observers = [];
  class Observer {
    constructor(changed) {
      this.changed = changed;
      this.on = false;
      observers.push(this);
    }
    observe(_target, options) {
      this.on = Boolean(options.childList && options.subtree);
    }
    disconnect() {
      this.on = false;
    }
  }
  const run = await firstRun({ globals: { MutationObserver: Observer } });
  const { document } = run.page;
  const element = (name) => ({
    name,
    isConnected: true,
    focused: [],
    classList: { contains: (word) => word === name },
    focus(options) {
      this.focused.push(options);
      document.activeElement = this;
    },
  });
  const setup = element("setup");
  const windowMain = element("main");
  let main = setup;
  document.getElementById = (id) => (id === "main" ? main : null);
  return {
    ...run,
    document,
    setup,
    windowMain,
    waiting: () => observers.filter((o) => o.on).length,
    drawn: () => void (main = windowMain),
    changed: () => observers.filter((o) => o.on).forEach((o) => o.changed([])),
  };
}

export async function whenFirstRunGoesTheFocusGoesToTheWindowsPage() {
  const run = await firstRunOnAPage();
  run.skip();
  // Skip goes with first run, and the window's code is still on its way.
  run.document.activeElement = run.document.body;
  run.page.mount(null);
  assert.equal(run.waiting(), 1, "it waits for the window");
  run.changed();
  assert.deepEqual(run.setup.focused, []);
  run.drawn();
  run.changed();
  assert.deepEqual(run.windowMain.focused, [{ preventScroll: true }]);
  assert.equal(run.waiting(), 0, "and stops waiting");

  // A window drawn already takes the focus at once.
  const ready = await firstRunOnAPage();
  ready.skip();
  ready.document.activeElement = ready.document.body;
  ready.drawn();
  ready.page.mount(null);
  assert.deepEqual(ready.windowMain.focused, [{ preventScroll: true }]);
  assert.equal(ready.waiting(), 0);
}

export async function theFocusStaysWhereSomethingElsePutItWhenFirstRunGoes() {
  const run = await firstRunOnAPage();
  run.skip();
  run.page.mount(null);
  // Search and actions, say, took the focus before the window was drawn.
  const search = { isConnected: true };
  run.document.activeElement = search;
  run.drawn();
  run.changed();
  assert.deepEqual(run.windowMain.focused, []);
  assert.equal(run.document.activeElement, search);
  assert.equal(run.waiting(), 0);
}

export async function skipWaitsWhileADialogIsOpen() {
  const run = await firstRun();
  run.store.useApp.setState({ modal: { kind: "new" } });
  run.skip();
  assert.deepEqual(run.asked("design"), []);
  assert.equal(run.state().skipSetup, false);
}

export async function aSavedUpdateChoiceIsPickedAgain() {
  const run = await firstRun({ saved: { updates: "off" } });
  assert.equal(run.radio("updates", "off").props.checked, true);
}

export async function firstRunAgainPicksTheUpdateChoiceSavedSinceThen() {
  // config.json, as the desktop's `prefs` reads it and `updates` writes it.
  const config = { updates: null };
  const world = app({
    design: "simple",
    answers: {
      prefs: () => prefs({ updates: config.updates }),
      "setup/info": setupInfo(),
      "setup/save": {},
      design: (body) => body,
      updates: (body) => {
        config.updates = body.updates;
        return prefs({ updates: config.updates, configured: true });
      },
    },
  });
  world.store.applyPrefs(prefs());
  world.store.useApp.getState().load(snapshot(false));
  // One settings.tsx for the whole session, as the window has.
  const { Settings } = world.load("settings.tsx");
  const updates = (value) =>
    world.page.find(
      (n) => n.type === "input" && n.props.name === "updates" && n.props.value === value,
    );
  const start = async () => {
    world.page.act(() => world.page.button(words.firstRun.start).props.onClick());
    await world.page.settle();
  };
  world.page.mount(createElement(Settings, { first: true }));
  await world.page.settle();
  world.page.act(() => updates("off").props.onChange());
  await start();
  assert.equal(config.updates, "off");
  // Undoing that setup in Activity brings first run back in the same session, once its scan is done.
  world.page.mount(null);
  world.store.useApp.setState({ setupPending: false });
  world.page.mount(createElement(Settings, { first: true }));
  await world.page.settle();
  assert.equal(world.asked("prefs").length, 2, "first run asks again");
  assert.equal(updates("off").props.checked, true);
  assert.equal(updates("daily").props.checked, false);
  // Start keeps the choice as it is saved.
  await start();
  assert.deepEqual(world.asked("updates").at(-1), ["updates", { updates: "off" }]);
  assert.equal(config.updates, "off");
}

export async function theDesignFollowsTheWindowUntilOneIsPicked() {
  // The palette's "Switch to Detailed view" works on the first-run screen too.
  const run = await firstRun();
  run.page.act(() => run.store.setDesign("detailed"));
  assert.equal(run.radio("design", "detailed").props.checked, true);
  run.pick("design", "simple");
  run.page.act(() => run.store.setDesign("detailed"));
  assert.equal(run.radio("design", "simple").props.checked, true);
}

export async function anUpdateChoiceThatCantBeSavedSaysSoAndTheSetupStands() {
  const run = await firstRun({
    answers: {
      "setup/save": { revision: 2, journal: { id: "setup-1", canUndo: true } },
      updates: () => {
        throw "Unknown request";
      },
    },
  });
  await run.start();
  assert.deepEqual(run.asked("setup/save").length, 1);
  // One toast says both, and keeps the Undo of the setup.
  const { title, message, undo, error } = run.state().toast;
  assert.deepEqual(
    { title, message, undo, error },
    {
      title: "All set",
      message: `${words.firstRun.updatesFailed}: Unknown request`,
      undo: "setup-1",
      error: true,
    },
  );
  assert.equal(run.state().view, "today");
}

export async function firstRunSaysWhatThisComputerNeeds() {
  const notes = [
    words.firstRun.moveTitle,
    words.firstRun.installTitle("Git"),
    words.firstRun.folderAccessTitle,
  ];
  const shown = async (os, info) => {
    const run = await firstRun({ os, answers: { "setup/info": setupInfo(info) } });
    return notes.filter((note) => run.page.text().includes(note));
  };
  // macOS run from the disk image, without Apple's command line tools.
  assert.deepEqual(await shown("macos", { git: false, translocated: true }), notes);
  // Installed, with Git: only how macOS asks for folders.
  assert.deepEqual(await shown("macos", { git: true }), [words.firstRun.folderAccessTitle]);
  // Elsewhere Git is the only one that can be missing, and nothing shows until the desktop says.
  assert.deepEqual(await shown("linux", { git: false, translocated: true }), [notes[1]]);
  assert.deepEqual(await shown("windows", {}), []);
}

export async function theInstallNoteLinksToGitsDownloads() {
  const run = await firstRun({ answers: { "setup/info": setupInfo({ git: false }) } });
  run.page.act(() => run.page.button(words.firstRun.installLink).props.onClick());
  await run.page.settle();
  assert.deepEqual(run.asked("open/url"), [
    ["open/url", { url: "https://git-scm.com/downloads" }],
  ]);
  // Only a Mac gets the line to type, as code.
  const line = (world) => world.page.find((n) => n.type === "code")?.textContent;
  assert.equal(line(run), undefined);
  const mac = await firstRun({ os: "macos", answers: { "setup/info": setupInfo({ git: false }) } });
  assert.equal(line(mac), "xcode-select --install");
  assert.match(mac.page.text(), new RegExp(words.firstRun.installMac.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

// ── Settings › Appearance ──────────────────────────────────────────────────────────────────────────

async function settings() {
  const world = app({
    answers: {
      prefs: prefs({ configured: true, design: "detailed" }),
      "setup/info": { ...setupInfo(), configured: true },
      design: (body) => body,
      theme: (body) => body,
    },
  });
  world.store.applyPrefs(prefs({ configured: true, design: "detailed" }));
  world.store.useApp.getState().load(snapshot());
  world.store.useApp.setState({ view: "settings" });
  const { Settings } = world.load("settings.tsx");
  world.page.mount(createElement(Settings));
  await world.page.settle();
  return world;
}

export async function appearanceSwitchesTheDesignAndTheThemeAtOnce() {
  const world = await settings();
  const section = world.page.find((n) => n.props["data-ui"] === "appearance");
  assert.ok(section, "Settings has Appearance");
  const look = (design) =>
    world.page.find((n) => n.type === "button" && n.props["data-design"] === design);
  assert.equal(look("detailed").props["aria-pressed"], true);
  assert.equal(look("simple").props["aria-pressed"], false);
  const theme = (label) =>
    section.descendants().find((n) => n.type === "button" && n.textContent === label);
  world.page.act(() => theme(words.views.themes.dark).props.onClick());
  assert.equal(world.state().theme, "dark");
  assert.deepEqual(world.asked("theme"), [["theme", { theme: "dark" }]]);
  world.page.act(() => look("simple").props.onClick());
  assert.equal(world.state().design, "simple");
  assert.equal(world.state().view, "settings", "Simple's Settings, where Detailed's were");
  assert.deepEqual(world.asked("design"), [["design", { design: "simple" }]]);
  // Nothing else in Settings was saved by it.
  assert.deepEqual(world.asked("setup/save"), []);
}

/** Detailed's "Default archive folder" field in Settings. */
const archiveField = (world) =>
  world.page.find((n) => n.type === "input" && n.props["aria-label"] === "Default archive folder");

export async function aSwitchWaitsWhileSettingsHaveChangesThatArentSaved() {
  const world = await settings();
  const type = (value) =>
    world.page.act(() => archiveField(world).props.onChange({ target: { value } }));
  const look = (design) =>
    world.page.find((n) => n.type === "button" && n.props["data-design"] === design);
  assert.equal(world.state().settingsDirty, false, "nothing typed yet");
  type("~/my-new-archive");
  assert.equal(world.state().settingsDirty, true);
  // Appearance doesn't switch: Simple's Settings would start without the typed folder.
  world.page.act(() => look("simple").props.onClick());
  assert.equal(world.state().design, "detailed");
  assert.deepEqual(world.asked("design"), []);
  assert.deepEqual(
    [world.state().toast?.title, world.state().toast?.message],
    ["Save your settings first", "Or leave Settings to drop the changes."],
  );
  assert.equal(archiveField(world).props.value, "~/my-new-archive");
  // Nor do the sidebar's toggle and Search and actions, which switch the same way.
  assert.equal(world.store.setDesign("simple"), false);
  // Typing it back as it was leaves nothing to save.
  type("");
  assert.equal(world.state().settingsDirty, false);
  // Once the changes are saved, the switch goes ahead.
  type("~/my-new-archive");
  world.page.act(() => world.page.button("Save and rescan").props.onClick());
  await world.page.settle();
  assert.equal(world.asked("setup/save")[0][1].archiveDir, "/home/demo/my-new-archive");
  assert.equal(world.state().settingsDirty, false);
  world.page.act(() => look("simple").props.onClick());
  assert.equal(world.state().design, "simple");
}

export async function leavingSettingsLetsASwitchGoAheadAgain() {
  // Leaving Settings drops the changes that wait there, as it always has.
  const world = await settings();
  world.page.act(() => archiveField(world).props.onChange({ target: { value: "~/elsewhere" } }));
  assert.equal(world.state().settingsDirty, true);
  world.page.mount(null);
  assert.equal(world.state().settingsDirty, false);
  assert.equal(world.store.setDesign("simple"), true);
}

export async function simpleSettingsSayHowToLetTheSwitchGoAhead() {
  const world = app({ design: "simple", answers: { design: (body) => body } });
  world.store.applyPrefs(prefs({ configured: true, design: "simple" }));
  world.store.useApp.setState({ settingsDirty: true });
  assert.equal(world.store.setDesign("detailed"), false);
  assert.equal(world.state().design, "simple");
  assert.equal(world.state().toast?.title, "Save or discard your changes first");
  // Choosing the design shown switches nothing, so it is still saved.
  assert.equal(world.store.setDesign("simple"), true);
  assert.deepEqual(world.asked("design"), [["design", { design: "simple" }]]);
}

export async function firstRunHasNoAppearanceAndSettingsHasNoFirstRunQuestions() {
  const world = await settings();
  const text = world.page.text();
  assert.ok(!text.includes(words.firstRun.lookTitle));
  assert.ok(!text.includes(words.firstRun.updatesTitle));
  const run = await firstRun();
  assert.equal(run.page.find((n) => n.props["data-ui"] === "appearance"), undefined);
}

// ── The foot of Detailed's sidebar ─────────────────────────────────────────────────────────────────

function sidebar() {
  const world = app({ answers: { ls: { path: "", entries: [] }, design: (body) => body } });
  world.store.applyPrefs(prefs({ configured: true, design: "detailed" }));
  world.store.useApp.getState().load(snapshot());
  const { Sidebar } = world.load("views/sidebar.tsx");
  world.page.mount(createElement(Sidebar));
  return world;
}

export async function detailedsSidebarHasTheToggleWhereSimpleHasItsOwn() {
  const world = sidebar();
  const toggle = world.page.find((n) => n.props["data-ui"] === "design-toggle");
  assert.ok(toggle, "a toggle at the foot of the sidebar");
  assert.equal(toggle.props.role, "group");
  assert.equal(toggle.props["aria-label"], words.views.view);
  const buttons = toggle.descendants().filter((n) => n.type === "button");
  assert.deepEqual(
    buttons.map((b) => [b.textContent, b.props["aria-pressed"]]),
    [
      ["Simple", "false"],
      ["Detailed", "true"],
    ],
  );
  // As in Simple's toggle, the design shown does nothing more.
  assert.equal(buttons[1].props.onClick, undefined);
  world.page.act(() => buttons[0].props.onClick());
  assert.equal(world.state().design, "simple");
  assert.deepEqual(world.asked("design"), [["design", { design: "simple" }]]);
  assert.equal(world.state().toast.title, "Now in Simple view");
}

export async function theToggleWaitsWhileADialogIsOpen() {
  const world = sidebar();
  world.store.useApp.setState({ modal: { kind: "shortcuts" } });
  const toggle = world.page.find((n) => n.props["data-ui"] === "design-toggle");
  world.page.act(() => toggle.descendants().find((n) => n.type === "button").props.onClick());
  assert.equal(world.state().design, "detailed");
  assert.deepEqual(world.asked("design"), []);
}

export async function helpAtTheFootOpensHelpAndTakesTheFocusBack() {
  const world = sidebar();
  const help = world.page.button("Help");
  assert.ok(help, "Help is at the foot of the sidebar");
  help.focus();
  world.page.act(() => help.props.onClick());
  assert.deepEqual(world.state().modal, { kind: "help" });
  // The window goes inert under the dialog, which lets go of the focus.
  world.page.document.activeElement = world.page.document.body;
  world.page.act(() => world.store.useApp.setState({ modal: null }));
  assert.equal(world.page.document.activeElement, world.page.button("Help"));
  // A dialog Help didn't open leaves the focus alone.
  world.page.act(() => world.store.useApp.setState({ modal: { kind: "shortcuts" } }));
  world.page.document.activeElement = world.page.document.body;
  world.page.act(() => world.store.useApp.setState({ modal: null }));
  assert.equal(world.page.document.activeElement, world.page.document.body);
}

// ── Search and actions ─────────────────────────────────────────────────────────────────────────────

export async function bothDesignsCanSwitchFromSearchAndActions() {
  const world = app();
  const { actionsFor } = world.load("palette.tsx");
  const ids = (design, reports) => actionsFor(design, reports).map(([id]) => id);
  const label = (design, id) => actionsFor(design, true).find(([at]) => at === id)?.[1];
  assert.equal(label("detailed", "design"), "Switch to Simple view");
  assert.equal(label("simple", "design"), "Switch to Detailed view");
  // Detailed's actions are as they were, with the switch added last.
  assert.deepEqual(ids("detailed", true), [
    "view:today",
    "view:tidy",
    "view:agents",
    "view:reports",
    "view:log",
    "new",
    "shortcuts",
    "view:settings",
    "rescan",
    "theme",
    "design",
  ]);
  assert.ok(!ids("detailed", false).includes("view:reports"));
  // Simple lists its own places in its own words, Help for the keys, and the same switch.
  assert.deepEqual(ids("simple", true), [
    "view:today",
    "view:folder",
    "view:agents",
    "view:tidy",
    "view:log",
    "new",
    "help",
    "view:settings",
    "rescan",
    "theme",
    "design",
  ]);
  const said = words.search.actions;
  assert.deepEqual(
    actionsFor("simple", true).map(([, text]) => text),
    [
      said.home,
      said.projects,
      said.helpers,
      said.cleanup,
      said.activity,
      said.newProject,
      said.help,
      said.settings,
      said.checkAgain,
      said.theme,
      words.views.switchTo.detailed,
    ],
  );
}

function palette(design) {
  const world = app({ design, answers: { design: (body) => body } });
  world.store.applyPrefs(prefs({ configured: true, design }));
  world.store.useApp.getState().load(snapshot());
  world.store.useApp.setState({ palette: true });
  const { Palette } = world.load("palette.tsx");
  world.page.mount(createElement(Palette));
  const option = (text) =>
    world.page.find((n) => n.props.role === "option" && n.textContent.includes(text));
  return { ...world, option };
}

/** Every time a result gives says how long ago in words, and there is at least one. */
function assertTimesInWords(world) {
  const times = world.page
    .all((n) => n.props.className === "acc")
    .map((n) => n.textContent)
    .filter(Boolean);
  assert.ok(times.length, "some results give a time");
  for (const time of times) assert.match(time, /\bago$|^(yesterday|today|just now)$/i, time);
}

export async function simpleSearchesInItsOwnWords() {
  const world = palette("simple");
  const dialog = world.page.find((n) => n.props.role === "dialog");
  assert.equal(dialog.props["aria-label"], words.search.label);
  const input = world.page.find((n) => n.type === "input");
  assert.equal(input.props.placeholder, words.search.placeholder(true));
  const text = world.page.text();
  for (const action of Object.values(words.search.actions)) assert.match(text, new RegExp(action));
  // Detailed's words stay in Detailed.
  assert.doesNotMatch(text, /Open Agents|Open Tidy up|Scan again|Jump to/);
  // Times read as words: "5 days ago", never "5 d".
  assertTimesInWords(world);
  // Help is Simple's page.
  world.page.act(() => world.option(words.search.actions.help).props.onClick());
  assert.equal(world.state().view, "help");
  assert.equal(world.state().palette, false);
}

export async function eachDesignNamesWhatASearchFindsInItsOwnWords() {
  // "checkout" finds an AI chat and a summary in the fixtures: groups only a typed search shows.
  const groups = (design) => {
    const world = palette(design);
    const input = world.page.find((n) => n.type === "input");
    world.page.act(() => input.props.onChange({ target: { value: "checkout" } }));
    return {
      world,
      names: world.page.all((n) => n.props.className === "pal-sec").map((n) => n.textContent),
    };
  };
  const simple = groups("simple");
  for (const name of [words.search.groups.chats, words.search.groups.summaries])
    assert.ok(simple.names.includes(name), `${name} in ${simple.names}`);
  assert.ok(!simple.names.some((name) => /^(Sessions|Reports)$/.test(name)), `${simple.names}`);
  // The times of chats and summaries read as words too.
  assertTimesInWords(simple.world);
  const detailed = groups("detailed");
  for (const name of ["Sessions", "Reports"])
    assert.ok(detailed.names.includes(name), `${name} in ${detailed.names}`);
}

export async function switchingFromSearchAndActionsClosesItAndSwitches() {
  for (const [from, to, text] of [
    ["detailed", "simple", "Switch to Simple view"],
    ["simple", "detailed", "Switch to Detailed view"],
  ]) {
    const world = palette(from);
    world.page.act(() => world.option(text).props.onClick());
    assert.equal(world.state().palette, false);
    assert.equal(world.state().design, to);
    assert.deepEqual(world.asked("design"), [["design", { design: to }]]);
  }
  // Detailed keeps its own words.
  const detailed = palette("detailed");
  assert.equal(detailed.page.find((n) => n.props.role === "dialog").props["aria-label"], "Jump to");
  assert.ok(detailed.option("Open Agents"));
}

// ── The card that offers Simple ────────────────────────────────────────────────────────────────────

/** Today's card that offers Simple, or with `page` the whole of Today, on a scan of `roots`. */
function today(offer, { page = "TrySimple", roots } = {}) {
  const world = app({ answers: { design: (body) => body } });
  world.store.applyPrefs(prefs({ configured: true, design: offer ? null : "detailed" }));
  const scan = snapshot();
  world.store.useApp.getState().load(roots ? { ...scan, roots } : scan);
  const drawn = world.load("views/today.tsx", {
    "../backup": { BackupNotice: () => null },
    "../session-ui": { requestResume: noop },
    "../agent-launch": { askAgent: noop },
  });
  world.page.mount(createElement(drawn[page]));
  return world;
}

export async function onlySomeoneWhoSetUpBeforeTwoDesignsIsOfferedSimple() {
  assert.equal(today(false).page.text(), "");
  const world = today(true);
  assert.match(world.page.text(), new RegExp(words.views.offerTitle));
  assert.ok(world.page.find((n) => n.props["data-ui"] === "design-offer"));
}

export async function anUpgradeWithoutProjectFoldersIsOfferedSimpleToo() {
  // Laci 2 let every folder stay unticked, which saves no project folder at all.
  const world = today(true, { page: "Today", roots: [] });
  assert.match(world.page.text(), /No folders selected yet/);
  assert.ok(world.page.find((n) => n.props["data-ui"] === "design-offer"));
  // Without the offer, Today is as it was.
  const chosen = today(false, { page: "Today", roots: [] });
  assert.match(chosen.page.text(), /No folders selected yet/);
  assert.equal(chosen.page.find((n) => n.props["data-ui"] === "design-offer"), undefined);
}

export async function tryingSimpleSwitchesToItsHome() {
  const world = today(true);
  world.page.act(() => world.page.button(words.views.offerTry).props.onClick());
  assert.equal(world.state().design, "simple");
  assert.equal(world.state().view, "today", "Simple's Home");
  assert.deepEqual(world.asked("design"), [["design", { design: "simple" }]]);
}

export async function noThanksKeepsDetailedForGoodAndTheFocusOnToday() {
  const world = today(true);
  world.page.act(() => world.page.button(words.views.offerNo).props.onClick());
  assert.deepEqual(world.asked("design"), [["design", { design: "detailed" }]]);
  assert.equal(world.state().design, "detailed");
  assert.equal(world.state().designOffer, false);
  assert.equal(world.page.text(), "", "the card is gone");
  assert.equal(world.main.focused, 1, "the focus is on Today, not lost with the card");
  // Keeping the design shown says nothing.
  assert.equal(world.state().toast, null);
}
