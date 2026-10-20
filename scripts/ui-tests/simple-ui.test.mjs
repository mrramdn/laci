// Simple's sheet, its menus and its fix sheet, and the toast over them (ui/src/simple/ui/Sheet.tsx,
// MoreMenu.tsx, ui/src/simple/fix.tsx, ui/src/overlays.tsx). A stand-in for React draws each in plain
// Node, so that a test can click a button, move the focus and press a key without a browser.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";

const { createElement, Fragment } = requireUi("react");
const noop = () => {};

// ── The stand-in ───────────────────────────────────────────────────────────────────────────────────

/** A drawn element: what a ref holds and what an event's target is. */
class Host {
  constructor(page, type) {
    this.page = page;
    this.type = type;
    this.props = {};
    this.children = [];
    this.parent = null;
  }
  get textContent() {
    return this.children
      .map((child) => (child instanceof Host ? child.textContent : child))
      .join("");
  }
  /** Printed as its tag and its words, so that a failed comparison stays short. */
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `<${this.type}${this.props.id ? `#${this.props.id}` : ""}>${this.textContent}`;
  }
  /** Every element inside this one. */
  descendants() {
    return this.children.flatMap((child) =>
      child instanceof Host ? [child, ...child.descendants()] : [],
    );
  }
  contains(other) {
    for (let at = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
  // The page has no layout or styles: everything is shown, and nothing is hidden or inert.
  get offsetParent() {
    return this.parent ?? {};
  }
  closest() {
    return null;
  }
  matches() {
    return false;
  }
  querySelectorAll(selector) {
    return this.page.query(selector, this);
  }
  focus() {
    this.page.document.activeElement = this;
    this.page.document.fire("focusin", { target: this });
  }
}

/** A key press, or any event, with what an event has to say about where it goes. */
const event = (extra) => ({
  defaultPrevented: false,
  stopped: false,
  isComposing: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {
    this.stopped = true;
  },
  ...extra,
});
const keyEvent = (key, target, extra) => event({ key, target, ...extra });

/**
 * A page that components are drawn on, with React's hooks standing in for the real ones. State, refs
 * and effects keep their place between draws; an effect runs after the draw in which its inputs
 * changed, and its clean-up runs before it runs again or when its component goes. A change to the
 * state draws again in the next microtask, or at once inside `act`.
 *
 * `query` answers the `querySelectorAll` of the component under test: the page has no selectors, so
 * a test says which elements the one selector it uses finds.
 */
function standIn() {
  const listeners = [];
  const document = {
    activeElement: null,
    body: {},
    getElementById: () => null,
    addEventListener: (type, handler, capture = false) =>
      void listeners.push({ type, handler, capture }),
    removeEventListener(type, handler, capture = false) {
      const at = listeners.findIndex(
        (l) => l.type === type && l.handler === handler && l.capture === capture,
      );
      if (at >= 0) listeners.splice(at, 1);
    },
    /** How many listeners wait for `type`. */
    waiting: (type) => listeners.filter((l) => l.type === type).length,
    /** Delivers an event as the browser does: the capturing listeners, then the others, unless stopped. */
    fire(type, ev) {
      for (const capture of [true, false]) {
        if (ev.stopped) break;
        for (const l of [...listeners])
          if (l.type === type && l.capture === capture) l.handler(ev);
      }
      return ev;
    },
  };
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

  const page = { document, query: () => [] };
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
  const react = {
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

  /** What an element draws, as hosts and text; a component is called, with its own place for hooks. */
  function render(element, path) {
    if (element === null || element === undefined || typeof element === "boolean")
      return [];
    if (typeof element === "string" || typeof element === "number")
      return [String(element)];
    if (Array.isArray(element))
      return element.flatMap((child, i) => render(child, `${path}[${child?.key ?? i}]`));
    const { type, props } = element;
    if (type === Fragment) return render(props.children, path);
    const key = `${path}/${typeof type === "function" ? type.name : type}${element.key ? `:${element.key}` : ""}`;
    if (typeof type === "function") {
      const instance = instances.get(key) ?? { cells: [] };
      instances.set(key, instance);
      instance.pass = pass;
      instance.at = 0;
      current = instance;
      const drawn = type(props);
      current = null;
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
    react,
    /** A store the components read through a selector, as they read the app's: it draws again when it changes. */
    store(initial) {
      let state = initial;
      const use = (select = (s) => s) => select(state);
      use.getState = () => state;
      use.setState = (change) => {
        state = { ...state, ...(typeof change === "function" ? change(state) : change) };
        schedule();
      };
      return use;
    },
    /** Draws `element` as the page's one component. */
    mount(element) {
      root = element;
      dirty = true;
      flush();
      return page;
    },
    unmount() {
      root = null;
      dirty = true;
      flush();
    },
    /** Runs `work`, such as a click, and draws what it changed. */
    act(work) {
      const result = work();
      flush();
      return result;
    },
    /** Lets every promise that can settle, settle, and draws what it changed. */
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
      flush();
    },
    all,
    find: (predicate) => all(predicate)[0],
    /** The button that says `text`. */
    button: (text) => all((n) => n.type === "button" && n.textContent === text)[0],
    text: () => output.map((n) => (n instanceof Host ? n.textContent : n)).join(" "),
    /** Delivers a React event to an element and up through those around it, until one stops it. */
    dispatch(host, name, ev) {
      for (let at = host; at && !ev.stopped; at = at.parent) at.props[name]?.(ev);
      return ev;
    },
  });
}

/** A promise a test settles when it likes. */
function later() {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return Object.assign(promise, { resolve });
}

/** The app's store, as ui-state-smoke.mjs loads it: nothing runs by itself. */
function appStore() {
  return load(
    "store.ts",
    { "./api": { api: async () => ({}), errorText: String } },
    {
      document: { documentElement: { dataset: {} } },
      localStorage: { getItem: () => null, setItem: noop },
      setTimeout: () => 0,
      clearTimeout: noop,
    },
  );
}

// ── The sheet ──────────────────────────────────────────────────────────────────────────────────────

/** Sheet.tsx on `page`, with the app's own store: the sheet counts itself there. */
function sheetOn(page, store) {
  page.query = (_, root) => root.descendants().filter((n) => n.type === "button");
  return load(
    "simple/ui/Sheet.tsx",
    {
      react: page.react,
      "react-dom": { createPortal: (children) => children },
      "../../common": { Icon: () => null, restoreFocus: noop },
      "../../store": store,
    },
    {
      document: page.document,
      HTMLElement: Host,
      // `page.mutated()` stands for a change inside the sheet, such as a button that went away.
      MutationObserver: class {
        constructor(changed) {
          this.changed = changed;
        }
        observe() {
          page.mutated = () => this.changed();
        }
        disconnect() {
          page.mutated = noop;
        }
      },
    },
  ).Sheet;
}

export async function escapeClosesASheetWhereverTheFocusIs() {
  const store = appStore();
  const page = standIn();
  const Sheet = sheetOn(page, store);
  let closed = 0;
  page.mount(
    createElement(Sheet, { title: "Back up", onClose: () => closed++ }, "Body"),
  );
  // The focus is on the page, as after a button that went away when it was used.
  page.document.activeElement = null;
  const escape = page.document.fire("keydown", keyEvent("Escape", page.document.body));
  assert.equal(closed, 1);
  assert.ok(escape.defaultPrevented, "the key is taken");
  assert.ok(escape.stopped, "the window behind never sees it");
  // Another key is left alone.
  const other = page.document.fire("keydown", keyEvent("F9", page.document.body));
  assert.equal(closed, 1);
  assert.equal(other.stopped, false);
}

export async function escapeIsTakenButDoesNotCloseASheetWhileAChangeRuns() {
  const store = appStore();
  const page = standIn();
  const Sheet = sheetOn(page, store);
  let closed = 0;
  const onClose = () => closed++;
  page.mount(createElement(Sheet, { title: "Back up", onClose }, "Body"));
  store.useApp.setState({ working: "Keeping them out…" });
  let escape = page.document.fire("keydown", keyEvent("Escape", page.document.body));
  assert.equal(closed, 0, "a change is running");
  assert.ok(escape.defaultPrevented && escape.stopped, "and the window behind still gets nothing");
  store.useApp.setState({ working: "" });
  page.mount(
    createElement(Sheet, { title: "Back up", onClose, dismissible: false }, "Body"),
  );
  escape = page.document.fire("keydown", keyEvent("Escape", page.document.body));
  assert.equal(closed, 0, "this one cannot be dismissed");
  assert.ok(escape.defaultPrevented && escape.stopped);
}

export async function theSheetTakesBackTheFocusThatAControlTookWithIt() {
  const store = appStore();
  const page = standIn();
  const Sheet = sheetOn(page, store);
  page.mount(createElement(Sheet, { title: "Back up", onClose: noop }, "Body"));
  const box = page.find((n) => n.props.role === "dialog");
  // Keep these out goes away when it is used, and the focus falls to the page.
  page.document.activeElement = page.document.body;
  page.mutated();
  assert.equal(page.document.activeElement, box);
  // Focus somewhere else, such as a menu drawn outside the sheet, stays where it is.
  const menu = new Host(page, "button");
  page.document.activeElement = menu;
  page.mutated();
  assert.equal(page.document.activeElement, menu);
}

export async function aSheetCountsItselfInTheAppAndLetsGoOfTheKeyWhenItCloses() {
  const store = appStore();
  const page = standIn();
  const Sheet = sheetOn(page, store);
  assert.equal(store.useApp.getState().sheets, 0);
  page.mount(createElement(Sheet, { title: "Back up", onClose: noop }, "Body"));
  assert.equal(store.useApp.getState().sheets, 1);
  assert.equal(page.document.waiting("keydown"), 1);
  page.unmount();
  assert.equal(store.useApp.getState().sheets, 0);
  assert.equal(page.document.waiting("keydown"), 0, "no key listener stays behind");
  const escape = page.document.fire("keydown", keyEvent("Escape", page.document.body));
  assert.equal(escape.stopped, false);
}

/** hotkeys.ts on the app's own store, with the keys it hears in the order the browser delivers them. */
function windowKeys(store) {
  const heard = { capture: [], bubble: [], terminal: 0 };
  const hotkeys = load(
    "hotkeys.ts",
    {
      react: { useEffect: (effect) => void effect() },
      "./api": { api: async () => ({}) },
      "./store": store,
      "./select": { selectIsOpen: () => false },
      "./terminal-api": { toggleTerminal: () => heard.terminal++ },
    },
    {
      document: {
        documentElement: { dataset: {} },
        activeElement: null,
        querySelector: () => null,
        querySelectorAll: () => [],
      },
      window: {
        addEventListener: (type, handler, capture) => {
          if (type === "keydown") (capture ? heard.capture : heard.bubble).push(handler);
        },
        removeEventListener: noop,
      },
      HTMLElement: Host,
      Element: Host,
    },
  );
  hotkeys.useGlobalHotkeys();
  const body = new Host(null, "body");
  const none = { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  return {
    heard,
    press(key, mods = {}) {
      const ev = keyEvent(key, body, { ...none, ...mods });
      for (const handlers of [heard.capture, heard.bubble]) {
        for (const handler of handlers) handler(ev);
        if (ev.stopped) break;
      }
      return ev;
    },
  };
}

export async function anOpenSheetHasTheWindowsKeysToItself() {
  const store = appStore();
  const page = standIn();
  const Sheet = sheetOn(page, store);
  const keys = windowKeys(store);
  store.useApp.setState({ selected: "/home/demo/project/clients/kopi-landing" });
  page.mount(createElement(Sheet, { title: "Back up", onClose: noop }, "Body"));
  // Ctrl+K, F4 and Escape with the focus outside the sheet: none reaches the window behind.
  keys.press("k", { ctrlKey: true });
  assert.equal(store.useApp.getState().palette, false);
  keys.press("F4");
  assert.equal(keys.heard.terminal, 0);
  keys.press("Escape");
  assert.equal(store.useApp.getState().selected, "/home/demo/project/clients/kopi-landing");
  // Closed, the window has its keys back.
  page.unmount();
  keys.press("k", { ctrlKey: true });
  assert.equal(store.useApp.getState().palette, true);
  store.useApp.setState({ palette: false });
  keys.press("F4");
  assert.equal(keys.heard.terminal, 1);
}

// ── The window ─────────────────────────────────────────────────────────────────────────────────────

/** SimpleShell.tsx with every page and what it draws left out, on an app state made by `patch`. */
function simpleWindow(patch = {}) {
  const page = standIn();
  const navigated = [];
  const nothing = () => null;
  const app = page.store({
    view: "today",
    selected: null,
    modal: null,
    palette: false,
    working: "",
    sheets: 0,
    snapshot: { scannedAt: "2026-10-08T09:00:00.000Z" },
    reportsSeen: 0,
    theme: "system",
    busy: false,
    historyPending: false,
    error: null,
    navigate: (view) => navigated.push(view),
    ...patch,
  });
  const { default: SimpleShell } = load(
    "simple/SimpleShell.tsx",
    {
      "@fontsource-variable/plus-jakarta-sans": {},
      "./simple.css": {},
      react: { ...page.react, lazy: () => nothing, Suspense: Fragment },
      "../brand": { LaciMark: nothing },
      "../clock": { useNow: () => Date.parse("2026-10-08T09:00:00.000Z") },
      "../common": { Icon: nothing },
      "../help": { HelpPage: nothing },
      "../hotkeys": { isShortcutsKey: (e) => e.key === "?", namePanes: noop },
      "../selectors": {
        homeModel: () => ({ needs: [] }),
        navBadges: () => ({ suggestions: 0 }),
      },
      "../store": { rescan: noop, setDesign: noop, setTheme: noop, useApp: app },
      "../terminal-api": { useTerms: () => false },
      "./fix": { FixSheet: nothing },
      "./AiHelpers": { AiHelpers: nothing },
      "./Home": { Home: nothing },
      "./Later": { Later: nothing },
      "./SettingsPage": { SettingsPage: nothing },
      "./ProjectPage": { ProjectPage: nothing },
      "./Projects": { Projects: nothing },
      "./CleanUp": { CleanUp: nothing },
      "./Activity": { Activity: nothing },
      "./model": { dayOf: () => "2026-10-08", urgentCount: () => 0 },
      "./state": { readNotNow: () => new Set(), useSimple: page.store({ notNow: 0 }) },
      "./ui": { MoreMenu: nothing },
    },
    { document: page.document, HTMLElement: Host },
  );
  page.mount(createElement(SimpleShell));
  return {
    ...page,
    navigated,
    frame: () => page.find((n) => n.props.className === "s-frame"),
    /** Presses `key` with the focus on the page, as the browser delivers it to the document. */
    press: (key) =>
      page.document.fire("keydown", keyEvent(key, new Host(page, "div"))),
  };
}

export async function theSimpleWindowWaitsWhileASheetIsOpen() {
  for (const [patch, waits] of [
    [{}, false],
    [{ sheets: 1 }, true],
    [{ modal: { kind: "help" } }, true],
    [{ palette: true }, true],
    [{ working: "Moving…" }, true],
  ])
    assert.equal(simpleWindow(patch).frame().props.inert, waits, JSON.stringify(patch));
}

export async function simpleLeavesTheKeysToASheetThatIsOpen() {
  // With nothing open, ? opens Help, and Escape goes no further than the page.
  const free = simpleWindow();
  assert.ok(free.press("?").defaultPrevented);
  assert.deepEqual(free.navigated, ["help"]);
  assert.ok(free.press("Escape").stopped);
  // With a sheet open, neither is Simple's to take: the sheet takes its own Escape.
  const covered = simpleWindow({ sheets: 1 });
  assert.equal(covered.press("?").defaultPrevented, false);
  assert.deepEqual(covered.navigated, []);
  assert.equal(covered.press("Escape").stopped, false);
}

// ── The toast ──────────────────────────────────────────────────────────────────────────────────────

export async function theToastWaitsWhileASheetIsOpen() {
  const toast = { title: "Kept out of saved versions", message: ".env", undo: "journal-1" };
  const quiet = { toast, working: "", historyPending: false, modal: null, palette: false, sheets: 0 };
  const drawn = (state) => {
    const { Overlays } = load("overlays.tsx", {
      "./api": { api: noop },
      "./store": {
        useApp: (select) => select({ ...quiet, ...state }),
        changed: noop,
        run: noop,
      },
    });
    const [shown] = Overlays().props.children;
    return shown.props.inert;
  };
  assert.equal(drawn({}), false, "with nothing open, Undo is there to use");
  assert.equal(drawn({ sheets: 1 }), true, "a sheet covers the window and the toast with it");
  assert.equal(drawn({ modal: { kind: "shortcuts" } }), true);
  assert.equal(drawn({ palette: true }), true);
  assert.equal(drawn({ working: "Undoing…" }), true);
}

// ── A menu ─────────────────────────────────────────────────────────────────────────────────────────

export async function aMenuClosesWhenTheFocusLeavesIt() {
  const page = standIn();
  page.query = (_, root) =>
    root.descendants().filter(
      (n) => (n.props.role ?? "").startsWith("menuitem") && n.props["aria-disabled"] !== "true",
    );
  const { MoreMenu } = load(
    "simple/ui/MoreMenu.tsx",
    {
      react: page.react,
      "react-dom": { createPortal: (children) => children },
      "../../common": { Icon: () => null },
      "./place": { usePlacement: noop },
    },
    { document: page.document, HTMLElement: Host },
  );
  const chosen = [];
  page.mount(
    createElement(
      "div",
      null,
      createElement(MoreMenu, {
        label: "More actions",
        items: [
          { label: "Archive…", onSelect: () => chosen.push("archive") },
          { label: "Delete…", onSelect: () => chosen.push("delete") },
        ],
      }),
      createElement("button", { type: "button", id: "side" }, "Search"),
    ),
  );
  const trigger = () => page.find((n) => n.props["aria-haspopup"] === "menu");
  const menu = () => page.find((n) => n.props.role === "menu");
  const items = () => menu().descendants().filter((n) => n.props.role === "menuitem");
  const side = page.find((n) => n.props.id === "side");
  const openFromTheKeyboard = () => {
    page.act(() => trigger().props.onKeyDown(keyEvent("ArrowDown", trigger())));
    assert.equal(trigger().props["aria-expanded"], true);
    assert.equal(page.document.activeElement, items()[0], "the focus is in the menu");
  };
  openFromTheKeyboard();
  // Moving through the menu, and back to its own button, leave it open.
  page.act(() => items()[1].focus());
  assert.ok(menu());
  page.act(() => trigger().focus());
  assert.ok(menu());
  // F6 takes the focus to the sidebar: the menu goes, and the focus stays where it went.
  page.act(() => side.focus());
  assert.equal(menu(), undefined);
  assert.equal(trigger().props["aria-expanded"], false);
  assert.equal(page.document.activeElement, side);
  assert.equal(page.document.waiting("focusin"), 0, "nothing listens once it is closed");
  // Closed, the focus can go anywhere without the menu opening again, and a choice still works.
  page.act(() => trigger().focus());
  assert.equal(menu(), undefined);
  openFromTheKeyboard();
  page.act(() => page.dispatch(items()[1], "onClick", event({})));
  assert.deepEqual(chosen, ["delete"]);
  assert.equal(menu(), undefined);
}

// ── The fix sheet ──────────────────────────────────────────────────────────────────────────────────

const KOPI = "/home/demo/project/clients/kopi-landing";
const words = load("words.ts");
const CLEAN = { files: [], more: 0 };
const WITH_ENV = { files: [{ path: ".env", tracked: false }], more: 0 };

/**
 * The fix sheet for `code` on kopi-landing, with the engine's answers for each request in the order
 * they come: a value, or a function that gives a value, a promise or throws.
 */
function fixSheet({ code = "no-remote", replies }) {
  const page = standIn();
  const asked = [];
  const opened = [];
  const toasts = [];
  const changes = [];
  const node = { id: KOPI, kind: "project", label: "kopi-landing" };
  const app = page.store({ snapshot: { nodes: { [KOPI]: node } }, historyPending: false });
  const simple = page.store({ fixing: { id: KOPI, code } });
  const ui = {
    Button: ({ children, onClick, disabled, kind }) =>
      createElement("button", { type: "button", onClick, disabled: Boolean(disabled), "data-kind": kind }, children),
    Callout: ({ children, tone }) => createElement("p", { "data-tone": tone }, children),
    Disclosure: ({ children }) => createElement("div", null, children),
    Sheet: ({ children, footer }) => createElement("div", { role: "dialog" }, children, footer),
  };
  const { FixSheet } = load("simple/fix.tsx", {
    react: page.react,
    "../api": {
      api: async (name, body) => {
        asked.push([name, body]);
        const next = replies[name]?.shift();
        if (next === undefined) throw new Error(`No answer for ${name}`);
        return typeof next === "function" ? next() : next;
      },
      errorText: (error) => (error instanceof Error ? error.message : String(error)),
    },
    "../hooks": { useHealth: () => null },
    "../store": {
      useApp: app,
      run: async (task) => task(),
      changed: (...args) => changes.push(args),
      toast: (...args) => toasts.push(args),
    },
    "../terminal-api": {
      openTerminal: async (...args) => {
        opened.push(args);
        return true;
      },
    },
    "./act": { aiName: () => "Claude Code", askFix: noop },
    "./state": { useSimple: simple },
    "./ui": ui,
  });
  page.mount(createElement(FixSheet));
  const myself = () =>
    page.button(words.fix.myselfFor[code] ?? words.fix.myself);
  return {
    ...page,
    asked: (name) => asked.filter(([request]) => request === name).length,
    opened,
    toasts,
    changes,
    myself,
    fixing: () => simple.getState().fixing,
    /** A new scan arrives, and the project in it is new: it may have changed. */
    scanArrives: () =>
      app.setState({ snapshot: { nodes: { [KOPI]: { ...node } } } }),
    /** A new scan arrives with the project exactly as it was. */
    scanWithoutNews: () =>
      app.setState({ snapshot: { nodes: app.getState().snapshot.nodes } }),
  };
}

export async function theTerminalOpensOnlyOnAnAnswerThatIsStillClean() {
  // The answer on the page is clean, and a file turned up since: the click looks again.
  const sheet = fixSheet({ replies: { "secrets/check": [CLEAN, WITH_ENV] } });
  await sheet.settle();
  assert.match(sheet.text(), /No files that look like passwords or keys/);
  assert.equal(sheet.myself().props.disabled, false);
  sheet.act(() => sheet.myself().props.onClick());
  await sheet.settle();
  assert.equal(sheet.asked("secrets/check"), 2, "it looked again before it did anything");
  assert.deepEqual(sheet.opened, [], "no command is typed with a secret file about");
  assert.deepEqual(sheet.fixing(), { id: KOPI, code: "no-remote" }, "the sheet stays");
  assert.match(sheet.text(), /\.env/, "and shows what turned up");
  assert.equal(sheet.myself().props.disabled, true);
  assert.equal(sheet.toasts.length, 0);
}

export async function theTerminalOpensWhenTheNewAnswerIsClean() {
  const sheet = fixSheet({ replies: { "secrets/check": [CLEAN, CLEAN] } });
  await sheet.settle();
  sheet.act(() => sheet.myself().props.onClick());
  assert.match(sheet.text(), /Looking for files that look like passwords or keys/, "it says it is looking");
  assert.equal(sheet.myself().props.disabled, true, "and a second click waits for the first");
  await sheet.settle();
  assert.deepEqual(sheet.opened, [[KOPI, "fix", "no-remote"]]);
  assert.equal(sheet.fixing(), null, "the sheet closes");
  assert.deepEqual(sheet.toasts, [[words.fix.started, words.fix.startedHint]]);
}

export async function aCheckThatFailsAtTheClickOpensNothing() {
  const sheet = fixSheet({
    replies: {
      "secrets/check": [
        CLEAN,
        () => {
          throw new Error("git is busy");
        },
        CLEAN,
      ],
    },
  });
  await sheet.settle();
  sheet.act(() => sheet.myself().props.onClick());
  await sheet.settle();
  assert.deepEqual(sheet.opened, []);
  assert.match(sheet.text(), /Laci couldn’t look for secret files/);
  assert.match(sheet.text(), /git is busy/);
  assert.equal(sheet.myself().props.disabled, true);
  // Try again looks once more, and a clean answer lets it go on.
  sheet.act(() => sheet.button(words.fix.tryAgain).props.onClick());
  await sheet.settle();
  assert.match(sheet.text(), /No files that look like passwords or keys/);
  assert.equal(sheet.myself().props.disabled, false);
}

export async function aSheetClosedWhileItLooksOpensNoTerminal() {
  const looking = later();
  const sheet = fixSheet({ replies: { "secrets/check": [CLEAN, () => looking] } });
  await sheet.settle();
  sheet.act(() => sheet.myself().props.onClick());
  // Cancel while the check is still out.
  const cancel = sheet.button(words.blocks.cancel);
  assert.ok(cancel, "the sheet is still there while it looks");
  sheet.act(() => cancel.props.onClick());
  assert.equal(sheet.fixing(), null);
  looking.resolve(CLEAN);
  await sheet.settle();
  assert.deepEqual(sheet.opened, []);
  assert.deepEqual(sheet.toasts, []);
}

export async function aSecondClickWhileItLooksOpensNothingMore() {
  const looking = later();
  const sheet = fixSheet({
    replies: { "secrets/check": [CLEAN, () => looking, CLEAN] },
  });
  await sheet.settle();
  sheet.act(() => sheet.myself().props.onClick());
  // A scan comes in meanwhile and its answer is clean, so the button is there to press again.
  sheet.act(() => sheet.scanArrives());
  await sheet.settle();
  assert.equal(sheet.myself().props.disabled, false);
  sheet.act(() => sheet.myself().props.onClick());
  assert.equal(sheet.asked("secrets/check"), 3, "the second click asks for nothing");
  looking.resolve(CLEAN);
  await sheet.settle();
  assert.deepEqual(sheet.opened, [[KOPI, "fix", "no-remote"]], "one terminal, not two");
}

export async function theSheetLooksAgainWhenTheProjectChanges() {
  const changing = later();
  const sheet = fixSheet({
    replies: { "secrets/check": [CLEAN, () => changing, WITH_ENV] },
  });
  await sheet.settle();
  assert.equal(sheet.asked("secrets/check"), 1);
  // A scan arrives with the project made new: an Undo, or an edit of .gitignore, may be in it.
  sheet.act(() => sheet.scanArrives());
  assert.equal(sheet.asked("secrets/check"), 2, "it looks again");
  assert.match(sheet.text(), /No files that look like passwords or keys/, "the old answer stays while it looks");
  assert.equal(sheet.myself().props.disabled, false);
  changing.resolve(WITH_ENV);
  await sheet.settle();
  assert.match(sheet.text(), /\.env/);
  assert.equal(sheet.myself().props.disabled, true, "the terminal waits again");
  // A scan that leaves the project as it was asks for nothing.
  sheet.act(() => sheet.scanWithoutNews());
  await sheet.settle();
  assert.equal(sheet.asked("secrets/check"), 2);
  sheet.act(() => sheet.scanArrives());
  await sheet.settle();
  assert.equal(sheet.asked("secrets/check"), 3);
}

export async function keepingFilesOutLooksAgainAndSaysSo() {
  const after = later();
  const sheet = fixSheet({
    replies: {
      "secrets/check": [WITH_ENV, () => after],
      "secrets/keep-out": [{ journal: { id: "journal-1" } }],
    },
  });
  await sheet.settle();
  assert.equal(sheet.myself().props.disabled, true);
  sheet.act(() => sheet.button(words.fix.keepOut).props.onClick());
  await sheet.settle();
  assert.equal(sheet.asked("secrets/keep-out"), 1);
  assert.equal(sheet.changes.length, 1);
  assert.match(sheet.text(), /Looking for files that look like passwords or keys/, "it checks again");
  assert.equal(sheet.myself().props.disabled, true);
  after.resolve(CLEAN);
  await sheet.settle();
  assert.match(sheet.text(), /No files that look like passwords or keys/);
  assert.equal(sheet.myself().props.disabled, false);
}

export async function aFixThatSavesNothingAsksNoQuestion() {
  const sheet = fixSheet({ code: "stash", replies: {} });
  await sheet.settle();
  assert.equal(sheet.asked("secrets/check"), 0);
  assert.equal(sheet.myself().props.disabled, false);
  sheet.act(() => sheet.myself().props.onClick());
  await sheet.settle();
  assert.deepEqual(sheet.opened, [[KOPI, "fix", "stash"]]);
  assert.equal(sheet.asked("secrets/check"), 0);
  sheet.scanArrives();
  await sheet.settle();
  assert.equal(sheet.asked("secrets/check"), 0);
}
