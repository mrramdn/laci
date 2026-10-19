// Simple's own Delete, Archive and Free up space sheets (ui/src/simple/dialogs.tsx), and Detailed's
// dialogs leaving those three to Simple (ui/src/dialogs.tsx). The sheets are drawn in plain Node with
// a stand-in for React (simple-ui.test.mjs has its like, which runs effects in the order they were
// written), the real Sheet, Countdown and buttons, a clock the test moves on, and an engine that
// answers what each test says: what a click sends, where the focus goes, and that a Countdown
// cancelled in any way sends nothing.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";

const React = requireUi("react");
const { renderToStaticMarkup } = requireUi("react-dom/server");
const { createElement, Fragment } = React;
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
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `<${this.type}>${this.textContent}`;
  }
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
  get disabled() {
    return Boolean(this.props.disabled);
  }
  getAttribute(name) {
    return this.props[name] ?? null;
  }
  /** As much of a selector as the sheets ask about: one class, or one attribute with its value. */
  matches(selector) {
    const [, name] = /^\.([\w-]+)$/.exec(selector) ?? [];
    if (name) return String(this.props.className ?? "").split(/\s+/).includes(name);
    const [, attribute, value] = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector) ?? [];
    return attribute ? this.getAttribute(attribute) === value : false;
  }
  closest(selector) {
    for (let at = this; at instanceof Host; at = at.parent) if (at.matches(selector)) return at;
    return null;
  }
  querySelectorAll(selector) {
    return this.page.query(selector, this);
  }
  focus() {
    this.page.document.activeElement = this;
    this.page.document.fire("focusin", { target: this });
  }
}

/** An element in a few words, for a message. */
const named = (element) =>
  element instanceof Host ? `<${element.type}> “${element.textContent}”` : String(element);

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

/**
 * A page that components are drawn on, with React's hooks standing in for the real ones: state, refs
 * and effects keep their place between draws, an effect runs after the draw in which its inputs
 * changed, and its clean-up runs before it runs again or when its component goes. As in React, the
 * effects of what a component draws run before its own: the sheet puts the focus on its first
 * control, and the one who drew the sheet can then move it.
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

  function render(element, path) {
    if (element === null || element === undefined || typeof element === "boolean") return [];
    if (typeof element === "string" || typeof element === "number") return [String(element)];
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
      const marks = [layout.length, passive.length];
      const drawn = type(props);
      current = null;
      // This component's effects wait until what it drew has queued its own.
      const own = [layout.splice(marks[0]), passive.splice(marks[1])];
      const nodes = render(drawn, key);
      layout.push(...own[0]);
      passive.push(...own[1]);
      return nodes;
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
        if (host.props.ref && typeof host.props.ref !== "function") host.props.ref.current = null;
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
    mount(element) {
      root = element;
      dirty = true;
      flush();
      return page;
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
  });
}

/** Timers that run only when the test moves the clock on. */
function clock() {
  let now = 0;
  let serial = 0;
  const waiting = new Map();
  return {
    setTimeout(callback, ms = 0) {
      waiting.set(++serial, { at: now + ms, callback });
      return serial;
    },
    clearTimeout: (id) => void waiting.delete(id),
    /** Moves on by `ms`, running each timer that comes due on the way, the earliest first. */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const [due] = [...waiting]
          .filter(([, timer]) => timer.at <= until)
          .sort(([a, x], [b, y]) => x.at - y.at || a - b);
        if (!due) break;
        waiting.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
  };
}

// ── The sheets ─────────────────────────────────────────────────────────────────────────────────────

const words = load("words.ts");
const said = words.dialogs;
const HOME = "/home/demo";
const KOPI = `${HOME}/project/clients/kopi-landing`;
const DEST = `${HOME}/project/_archive/clients/kopi-landing`;
const NO_REMOTE = {
  code: "no-remote",
  severity: "high",
  title: "No remote",
  detail: "3 commits exist only on this disk",
};
const DIRTY = { code: "dirty", severity: "med", title: "1 uncommitted change" };
const KOPI_NODE = {
  id: KOPI,
  kind: "project",
  name: "kopi-landing",
  label: "kopi-landing",
  path: KOPI,
  archived: false,
  git: { commits: 3, dirty: 1, ahead: 0, behind: 0, stashes: 0, remotes: [] },
  issues: [NO_REMOTE, DIRTY],
  size: {
    total: 440_431_751,
    reclaimable: 440_401_920,
    parts: [{ path: "node_modules", bytes: 440_401_920 }],
  },
  archivePlan: { dest: DEST, checks: [], ops: [] },
};
/**
 * kopi-landing once every version is saved and uploaded: its "Is it safe?" card has nothing to say,
 * and an allowed delete plan fits it.
 */
const ONLINE = {
  git: { ...KOPI_NODE.git, dirty: 0, remotes: [{ name: "origin", host: "github.com" }] },
  issues: [],
};
const OPS = [
  { kind: "delete", label: "Move the project folder to system Trash", from: KOPI },
  { kind: "keep", label: "Keep agent history outside the project" },
];
/** The engine's delete plan: allowed, with `files` only this computer has. */
const allowed = (files = []) => ({
  allowed: true,
  path: KOPI,
  checks: [
    { code: "remote-verified", severity: "low", title: "Local Git refs verified on origin" },
    { code: "ignored-files", severity: "med", title: "Ignored files are not backed up by Git" },
  ],
  unbacked: { files, more: 0 },
  ops: OPS,
});
const BLOCKED = {
  allowed: false,
  path: KOPI,
  checks: [
    {
      code: "delete-blocked",
      severity: "high",
      title: "This project cannot be removed yet",
      detail: "This project has no remote backup",
    },
    { code: "ignored-files", severity: "med", title: "Ignored files are not backed up by Git" },
  ],
  unbacked: { files: [".env"], more: 0 },
  ops: OPS,
};
/** The engine's archive plan, with these checks. */
const archivePlan = (checks) => ({
  dest: DEST,
  checks,
  ops: [
    {
      kind: "move",
      label: "Move folder",
      from: "~/project/clients/kopi-landing",
      to: "~/project/_archive/clients/kopi-landing",
    },
    // What Detailed's Archive dialog offers to do as well, with a box to tick.
    {
      kind: "delete",
      label: "Optional: delete deps & build output",
      detail: "440 MB (node_modules)",
    },
  ],
});

/**
 * Simple's sheets with `modal` open on kopi-landing (as `node` changes it), and the engine's answers
 * for each request in the order they come: a value, or a function that gives one or throws.
 */
function sheets({ kind = "delete", node: change = {}, replies = {} } = {}) {
  const page = standIn();
  // The controls a sheet can give the focus to: its buttons and fields that aren't disabled.
  page.query = (_, root) =>
    root
      .descendants()
      .filter((n) => (n.type === "button" || n.type === "input") && !n.disabled);
  const time = clock();
  const asked = [];
  const changes = [];
  const fixes = [];
  const restored = [];
  const selected = [];
  const node = { ...KOPI_NODE, ...change };
  const app = page.store({
    modal: { kind, id: KOPI },
    snapshot: { home: HOME, nodes: { [KOPI]: node } },
    historyPending: false,
    working: "",
    sheets: 0,
    selected: KOPI,
    pendingSelection: null,
    view: "project",
    navigate: (view) => app.setState({ view }),
  });
  // As the store's run(): nothing starts while the Log is still catching up with a change.
  const store = {
    useApp: app,
    run: async (task, working, options = {}) => {
      if (options.history && app.getState().historyPending) return undefined;
      app.setState({ working });
      try {
        return await task();
      } catch (error) {
        options.onError?.(error);
        return undefined;
      } finally {
        app.setState({ working: "" });
      }
    },
    changed: (...args) => changes.push(args),
    selectWhenReady: (path) => selected.push(path),
  };
  // The sheets and their building blocks (simple/ui) in one go, so what they share loads once.
  const { SimpleDialogs } = load(
    "simple/dialogs.tsx",
    {
      react: page.react,
      "react-dom": { createPortal: (children) => children },
      "../api": {
        api: async (name, body) => {
          asked.push([name, body]);
          const next = replies[name]?.shift();
          if (next === undefined) throw new Error(`No answer for ${name}`);
          return typeof next === "function" ? next(body) : next;
        },
        errorText: (error) => (error instanceof Error ? error.message : String(error)),
      },
      "../common": { restoreFocus: (element) => restored.push(element) },
      "../../common": { Icon: () => null, restoreFocus: noop },
      "../store": store,
      "../../store": store,
      "./state": { openFix: (id, code) => fixes.push([id, code]) },
      "../art": { Art: () => null },
    },
    {
      document: page.document,
      HTMLElement: Host,
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
    },
  );
  // What opened the sheet: ⋯ More on the project's page.
  const opener = new Host(page, "button");
  page.document.activeElement = opener;
  page.mount(createElement(SimpleDialogs));
  const filled = () => page.all((n) => n.props["data-ui"] === "primary").map((n) => n.textContent);
  return {
    ...page,
    time,
    app,
    opener,
    changes,
    fixes,
    restored,
    selected,
    /** The requests named `name` that were sent, with their bodies. */
    asked: (name) => asked.filter(([request]) => request === name).map(([, body]) => body),
    filled,
    countdown: () => page.find((n) => n.props["data-ui"] === "countdown"),
    dialog: () => page.find((n) => n.props.role === "dialog"),
    /** What a screen reader is told went wrong, wherever the focus is. */
    alert: () => page.find((n) => n.props.role === "alert")?.textContent ?? "",
    /**
     * Fails unless `element` has the focus, and says what has it. Elements are only ever compared
     * this way: what assert writes about two of them that differ reaches into the whole page.
     */
    focusIs(element, message = "the focus") {
      const at = page.document.activeElement;
      assert.ok(element && at === element, `${message} is on ${named(at)}, not ${named(element)}`);
    },
    /** Presses `key` with the focus on the page, as the browser delivers it to the document. */
    press: (key) =>
      page.act(() =>
        page.document.fire("keydown", event({ key, target: page.document.body })),
      ),
    /** Clicks a button, or submits the form a submit button is in, as the browser does. */
    click(button) {
      assert.ok(button, "the button is there");
      assert.equal(button.disabled, false, `${button.textContent} can be pressed`);
      page.act(() => {
        if (button.props.type === "submit") {
          let form = button.parent;
          while (form && form.type !== "form") form = form.parent;
          form.props.onSubmit(event({}));
        } else button.props.onClick(event({}));
      });
    },
    type(text) {
      const field = page.find((n) => n.type === "input");
      page.act(() => field.props.onChange({ target: { value: text } }));
    },
    /** Moves the clock on and lets what that started settle. */
    async wait(ms) {
      page.act(() => time.advance(ms));
      await page.settle();
    },
  };
}
const TRASH = () => said.delete.trash;

export async function deleteLeadsWithArchiveAndTheBinIsNeverTheFilledButton() {
  const sheet = sheets({ replies: { "delete/plan": [allowed()] } });
  assert.match(sheet.text(), /Delete kopi-landing\?/);
  assert.match(sheet.text(), /Checking that nothing would be lost/);
  // Archive instead is there before the plan is: it doesn't need one. The focus starts on it.
  assert.deepEqual(sheet.filled(), ["Archive instead"]);
  sheet.focusIs(sheet.button("Archive instead"));
  assert.equal(sheet.button(TRASH()).disabled, true, "the bin waits for the plan");
  await sheet.settle();
  assert.match(sheet.text(), /Everything in it is saved and online\./);
  const trash = sheet.button(TRASH());
  assert.equal(trash.disabled, false);
  assert.match(trash.props.className, /s-btn-outline/);
  assert.match(trash.props.className, /s-btn-danger/);
  assert.deepEqual(sheet.filled(), ["Archive instead"], "one filled button, and it is not the bin");
  assert.match(sheet.text(), /To get it back, open the Trash in your file manager and choose Restore\./);
  assert.deepEqual(sheet.asked("delete/plan"), [{ id: KOPI }]);
}

export async function filesOnlyThisComputerHasAskForTheProjectsName() {
  const sheet = sheets({ replies: { "delete/plan": [allowed([".env", "uploads/orders.csv"])] } });
  await sheet.settle();
  assert.match(sheet.text(), /Only this computer has these files/);
  assert.match(sheet.text(), /\.env/);
  assert.match(sheet.text(), /uploads\/orders\.csv/);
  assert.match(sheet.text(), /Type kopi-landing to move it to the Trash with these files/);
  assert.equal(sheet.button(TRASH()).disabled, true);
  assert.match(sheet.text(), /Type the name above first\./);
  // Enter in a name that isn't right yet starts nothing.
  sheet.type("kopi");
  const form = sheet.find((n) => n.type === "form");
  sheet.act(() => form.props.onSubmit(event({})));
  assert.ok(!sheet.countdown(), "the Countdown is gone");
  sheet.type(" kopi-landing ");
  assert.equal(sheet.button(TRASH()).disabled, false);
  sheet.click(sheet.button(TRASH()));
  assert.ok(sheet.countdown(), "the Countdown runs");
  assert.match(sheet.text(), /Moving kopi-landing to the Trash in 5 seconds\./);
  assert.deepEqual(sheet.asked("delete"), [], "and nothing is sent yet");
}

export async function cancellingTheCountdownSendsNothing() {
  const sheet = sheets({ replies: { "delete/plan": [allowed()] } });
  await sheet.settle();
  sheet.click(sheet.button(TRASH()));
  await sheet.wait(3000);
  assert.match(sheet.text(), /in 2 seconds/);
  sheet.click(sheet.button(words.blocks.cancel));
  assert.ok(!sheet.countdown(), "the Countdown is gone");
  await sheet.wait(60_000);
  assert.deepEqual(sheet.asked("delete"), []);
  assert.match(sheet.text(), /Cancelled\. Nothing changed\./);
  sheet.focusIs(sheet.button(TRASH()), "the focus is back on the button");
  assert.deepEqual(sheet.app.getState().modal, { kind: "delete", id: KOPI }, "the sheet stays");
}

export async function escapeStopsTheCountdownAndTheNextOneClosesTheSheet() {
  const sheet = sheets({ replies: { "delete/plan": [allowed()] } });
  await sheet.settle();
  sheet.click(sheet.button(TRASH()));
  await sheet.wait(4000);
  const stop = sheet.press("Escape");
  assert.ok(stop.defaultPrevented);
  assert.ok(!sheet.countdown(), "the Countdown is gone");
  const stays = { kind: "delete", id: KOPI };
  assert.deepEqual(sheet.app.getState().modal, stays, "Escape stops the Countdown only");
  await sheet.wait(60_000);
  assert.deepEqual(sheet.asked("delete"), []);
  sheet.press("Escape");
  assert.equal(sheet.app.getState().modal, null);
  await sheet.wait(60_000);
  assert.deepEqual(sheet.asked("delete"), []);
}

export async function closingTheSheetDuringTheCountdownSendsNothing() {
  const sheet = sheets({ replies: { "delete/plan": [allowed()] } });
  await sheet.settle();
  sheet.click(sheet.button(TRASH()));
  await sheet.wait(2000);
  // A click beside the sheet, or its close button, closes it.
  sheet.act(() => sheet.app.setState({ modal: null }));
  await sheet.wait(60_000);
  assert.deepEqual(sheet.asked("delete"), []);
  assert.equal(sheet.document.waiting("keydown"), 0, "no key listener stays behind");
}

export async function theEndOfTheCountdownMovesTheProjectToTheBin() {
  const sheet = sheets({ replies: { "delete/plan": [allowed()], delete: [{}] } });
  await sheet.settle();
  sheet.click(sheet.button(TRASH()));
  await sheet.wait(4999);
  assert.deepEqual(sheet.asked("delete"), []);
  await sheet.wait(1);
  assert.deepEqual(sheet.asked("delete"), [{ id: KOPI, confirm: true }]);
  await sheet.settle();
  assert.equal(sheet.app.getState().modal, null);
  assert.deepEqual(sheet.changes, [
    [{}, "Moved kopi-landing to the Trash", said.restoreSteps("linux")],
  ]);
  // Its page is gone with it: Projects shows instead.
  assert.equal(sheet.app.getState().selected, null);
  assert.equal(sheet.app.getState().view, "folder");
}

export async function aCountdownThatEndsWhileAnotherChangeRunsSendsNothing() {
  const sheet = sheets({ replies: { "delete/plan": [allowed()], delete: [{}] } });
  await sheet.settle();
  sheet.click(sheet.button(TRASH()));
  await sheet.wait(1000);
  sheet.act(() => sheet.app.setState({ historyPending: true }));
  await sheet.wait(4000);
  assert.deepEqual(sheet.asked("delete"), []);
  assert.match(sheet.text(), /Laci is finishing another change\. Try again in a moment\./);
  assert.equal(sheet.button(TRASH()).disabled, true, "and it waits for that change");
  sheet.act(() => sheet.app.setState({ historyPending: false }));
  assert.equal(sheet.button(TRASH()).disabled, false);
}

export async function aMoveTheEngineRefusesSaysSoAndChecksAgain() {
  const sheet = sheets({
    replies: {
      "delete/plan": [allowed(), BLOCKED],
      delete: [
        () => {
          throw new Error("This project is in use by Claude Code. Close it first.");
        },
      ],
    },
  });
  await sheet.settle();
  sheet.click(sheet.button(TRASH()));
  assert.equal(sheet.alert(), "", "nothing to say yet");
  await sheet.wait(5000);
  assert.equal(sheet.asked("delete").length, 1);
  assert.match(sheet.text(), /Laci couldn’t move kopi-landing to the Trash\./);
  // Said out loud too, as the focus moves on to what can be done next.
  assert.equal(sheet.alert(), "Laci couldn’t move kopi-landing to the Trash.");
  assert.equal(sheet.button(TRASH()).disabled, true);
  sheet.focusIs(sheet.button(said.checkAgain));
  assert.deepEqual(sheet.changes, []);
  sheet.click(sheet.button(said.checkAgain));
  await sheet.settle();
  assert.equal(sheet.asked("delete/plan").length, 2);
  assert.match(sheet.text(), /Laci can’t move kopi-landing to the Trash yet\./);
}

export async function aDeleteThatCantHappenYetSaysWhyInPlainWords() {
  const sheet = sheets({ replies: { "delete/plan": [BLOCKED, BLOCKED] } });
  await sheet.settle();
  const text = sheet.text();
  assert.match(text, /Laci can’t move kopi-landing to the Trash yet\./);
  assert.match(text, /every saved version is online/);
  // The project's own problems, as its page says them.
  assert.match(text, /Only on this computer/);
  assert.match(text, /Changes not saved as a version/);
  assert.equal(sheet.button(TRASH()).disabled, true);
  assert.match(text, /Not possible yet\. The reason is above\./);
  assert.doesNotMatch(text, /To get it back/, "how to restore waits until it can happen");
  // A blocked plan asks for no name, and the engine's own words wait under Show details.
  assert.ok(!sheet.find((n) => n.type === "input"));
  assert.doesNotMatch(text, /no remote backup/);
  sheet.click(sheet.button(words.blocks.showDetails));
  assert.match(sheet.text(), /This project has no remote backup/);
  // The engine's steps, with the path written from home.
  assert.match(
    sheet.text(),
    /Move the project folder to system Trash: ~\/project\/clients\/kopi-landing/,
  );
  sheet.click(sheet.button(said.checkAgain));
  await sheet.settle();
  assert.equal(sheet.asked("delete/plan").length, 2);
}

export async function anArchivedProjectHasNoArchiveInstead() {
  const sheet = sheets({ node: { archived: true }, replies: { "delete/plan": [allowed()] } });
  // With no safe choice to start on, the focus starts on Cancel, before anything that can't be undone.
  sheet.focusIs(sheet.button(words.blocks.cancel));
  await sheet.settle();
  assert.ok(!sheet.button(said.delete.archiveInstead));
  // Nor does it recommend archiving what is archived.
  assert.match(
    sheet.text(),
    /It is in your archive folder already\. Laci can’t undo a move to the Trash\./,
  );
  assert.doesNotMatch(sheet.text(), /Archiving is the safer choice/);
  assert.deepEqual(sheet.filled(), [], "the bin is still not filled");
  assert.equal(sheet.button(TRASH()).disabled, false);
  sheet.focusIs(sheet.button(words.blocks.cancel));
}

export async function aLongListOfFilesNamesEightAndShowDetailsTheRest() {
  const files = Array.from({ length: 12 }, (_, i) => `data/backup-${i + 1}.db`);
  const sheet = sheets({
    replies: { "delete/plan": [{ ...allowed(files), unbacked: { files, more: 3 } }] },
  });
  await sheet.settle();
  const shown = () => sheet.all((n) => n.type === "li" && /^data\//.test(n.textContent));
  assert.deepEqual(
    shown().map((n) => n.textContent),
    files.slice(0, 8),
  );
  // The four more it named and the three it only counted.
  assert.match(sheet.text(), /and 7 more files/);
  sheet.click(sheet.button(words.blocks.showDetails));
  assert.match(sheet.text(), /Only on this computer/);
  assert.equal(shown().length, 8 + 12);
  assert.match(sheet.text(), /and 3 more files/);
  // A short list isn't named twice.
  const few = sheets({ replies: { "delete/plan": [allowed([".env"])] } });
  await few.settle();
  few.click(few.button(words.blocks.showDetails));
  assert.doesNotMatch(few.text(), /Only on this computer/);
}

export async function archiveInsteadTurnsTheSheetIntoArchive() {
  const sheet = sheets({
    node: ONLINE,
    replies: { "delete/plan": [allowed()], "archive/plan": [archivePlan([])] },
  });
  await sheet.settle();
  const box = sheet.find((n) => n.props.role === "dialog");
  sheet.click(sheet.button(said.delete.archiveInstead));
  assert.deepEqual(sheet.app.getState().modal, { kind: "archive", id: KOPI });
  assert.ok(sheet.dialog() === box, "the same sheet");
  assert.match(sheet.text(), /Archive kopi-landing\?/);
  // The button that was pressed went: the sheet takes the focus, then gives it to the way on.
  box.focus();
  await sheet.wait(0);
  assert.deepEqual(sheet.asked("archive/plan"), [{ id: KOPI, destination: DEST }]);
  sheet.focusIs(sheet.button(said.archive.archive));
}

export async function anUnsafeProjectIsBackedUpFirst() {
  const sheet = sheets({
    kind: "archive",
    replies: { "archive/plan": [archivePlan([NO_REMOTE, DIRTY])] },
  });
  assert.match(sheet.text(), /Checking where it goes/);
  await sheet.wait(0);
  assert.deepEqual(sheet.filled(), ["Back up first"]);
  const anyway = sheet.button(said.archive.anyway);
  assert.match(anyway.props.className, /s-btn-outline/);
  assert.equal(anyway.disabled, false);
  assert.match(sheet.text(), /Only on this computer/);
  assert.match(sheet.text(), /Laci helps you with “Only on this computer” first\./);
  sheet.click(sheet.button(said.archive.backUpFirst));
  assert.equal(sheet.app.getState().modal, null, "the archive sheet goes first");
  assert.deepEqual(sheet.fixes, []);
  await sheet.wait(0);
  // The fix sheet for the worst problem, opened from what opened this sheet.
  assert.deepEqual(sheet.fixes, [[KOPI, "no-remote"]]);
  assert.ok(
    sheet.restored.length === 1 && sheet.restored[0] === sheet.opener,
    "the focus went back to what opened the sheet",
  );
  assert.deepEqual(sheet.asked("archive"), []);
}

export async function archivingAnywayIsAChangeWithUndo() {
  const sheet = sheets({
    kind: "archive",
    replies: {
      "archive/plan": [archivePlan([DIRTY])],
      archive: [{ revision: 9, journal: { id: "journal-1", title: "Archived kopi-landing" } }],
    },
  });
  await sheet.wait(0);
  sheet.click(sheet.button(said.archive.anyway));
  await sheet.settle();
  assert.deepEqual(sheet.asked("archive"), [{ id: KOPI, destination: DEST, trashHeavy: false }]);
  assert.equal(sheet.app.getState().modal, null);
  assert.deepEqual(sheet.changes, [
    [
      { revision: 9, journal: { id: "journal-1", title: "Archived kopi-landing" } },
      "Archived kopi-landing",
      said.archive.archivedNote,
    ],
  ]);
  assert.deepEqual(sheet.selected, [DEST]);
}

export async function aSafeProjectArchivesWithItsOneFilledButton() {
  const sheet = sheets({
    kind: "archive",
    node: ONLINE,
    replies: { "archive/plan": [archivePlan([])], archive: [{}] },
  });
  await sheet.wait(0);
  assert.deepEqual(sheet.filled(), [said.archive.archive]);
  assert.ok(!sheet.button(said.archive.backUpFirst));
  assert.match(sheet.text(), /Saved as versions and uploaded to github\.com\./);
  // Show details has the steps Laci takes. Simple's archive deletes nothing: freeing the space is a
  // step of its own, so the one Detailed offers to tick isn't listed.
  sheet.click(sheet.button(words.blocks.showDetails));
  assert.match(sheet.text(), /Move folder: ~\/project\/clients\/kopi-landing → ~\/project\/_archive/);
  assert.doesNotMatch(sheet.text(), /delete deps/);
  sheet.click(sheet.button(said.archive.archive));
  await sheet.settle();
  assert.deepEqual(sheet.asked("archive"), [{ id: KOPI, destination: DEST, trashHeavy: false }]);
}

export async function hiddenWarningsDontHoldTheArchiveUpButItIsntCalledSafe() {
  const hidden = [{ ...NO_REMOTE, muted: true }];
  const sheet = sheets({
    kind: "archive",
    node: { issues: [{ ...NO_REMOTE, muted: true }] },
    replies: { "archive/plan": [archivePlan(hidden)] },
  });
  await sheet.wait(0);
  assert.deepEqual(sheet.filled(), [said.archive.archive]);
  assert.ok(!sheet.button(said.archive.backUpFirst));
  // It has no online copy: the user only asked Laci not to warn about that.
  assert.doesNotMatch(sheet.text(), /Saved as versions/);
  assert.match(sheet.text(), /You hid 1 warning about this project\. Show details lists it\./);
  sheet.click(sheet.button(words.blocks.showDetails));
  assert.match(sheet.text(), /Hidden warnings\s*Only on this computer/);
}

export async function aProblemTheArchivePlanLeavesOutIsStillOne() {
  // Out of sync: versions here that the online copy lacks. The engine's plan doesn't name it, and
  // the project's "Is it safe?" card does.
  const diverged = { code: "diverged", severity: "med", title: "Diverged from origin/main" };
  const sheet = sheets({
    kind: "archive",
    node: { ...ONLINE, issues: [diverged] },
    replies: { "archive/plan": [archivePlan([])] },
  });
  await sheet.wait(0);
  assert.doesNotMatch(sheet.text(), /Saved as versions/);
  assert.match(sheet.text(), /Out of sync/);
  assert.deepEqual(sheet.filled(), [said.archive.backUpFirst]);
  assert.match(sheet.button(said.archive.anyway).props.className, /s-btn-outline/);
  sheet.click(sheet.button(said.archive.backUpFirst));
  await sheet.wait(0);
  assert.deepEqual(sheet.fixes, [[KOPI, "diverged"]]);
  // A code project with no version history isn't a folder of notes either.
  const noGit = { code: "no-git", severity: "med", title: "Not under version control" };
  const bare = sheets({
    kind: "archive",
    node: { git: undefined, issues: [noGit] },
    replies: { "archive/plan": [archivePlan([])] },
  });
  await bare.wait(0);
  assert.doesNotMatch(bare.text(), /That is fine for notes/);
  assert.match(bare.text(), /No version history/);
  assert.deepEqual(bare.filled(), [said.archive.backUpFirst]);
  // One the user hid holds nothing up, and still isn't called safe.
  const quiet = sheets({
    kind: "archive",
    node: { ...ONLINE, issues: [{ ...diverged, muted: true }] },
    replies: { "archive/plan": [archivePlan([])] },
  });
  await quiet.wait(0);
  assert.deepEqual(quiet.filled(), [said.archive.archive]);
  assert.match(quiet.text(), /You hid 1 warning about this project\./);
}

export async function archiveHoldsTheFocusOnTheSheetUntilItsPlanIsIn() {
  const sheet = sheets({ kind: "archive", replies: { "archive/plan": [archivePlan([NO_REMOTE])] } });
  // There is nothing to choose yet, so the sheet itself has the focus; a screen reader reads it out.
  sheet.focusIs(sheet.dialog());
  await sheet.wait(0);
  sheet.focusIs(sheet.button(said.archive.backUpFirst));
}

export async function aProjectThatChangedIsCheckedAgain() {
  const sheet = sheets({
    kind: "archive",
    replies: { "archive/plan": [archivePlan([DIRTY]), archivePlan([])] },
  });
  await sheet.wait(0);
  assert.deepEqual(sheet.filled(), [said.archive.backUpFirst]);
  // The changes were saved as a version meanwhile, in the terminal or by an AI.
  const saved = { ...KOPI_NODE, issues: [], git: { ...KOPI_NODE.git, dirty: 0 } };
  sheet.act(() => sheet.app.setState({ snapshot: { home: HOME, nodes: { [KOPI]: saved } } }));
  await sheet.wait(0);
  assert.equal(sheet.asked("archive/plan").length, 2);
  assert.deepEqual(sheet.filled(), [said.archive.archive]);
}

export async function anArchiveThatFailsSaysSoAndKeepsTheFocusOnIt() {
  const sheet = sheets({
    kind: "archive",
    replies: {
      "archive/plan": [archivePlan([DIRTY]), archivePlan([DIRTY])],
      archive: [
        () => {
          throw new Error("This project is in use by Claude Code. Close it first.");
        },
      ],
    },
  });
  await sheet.wait(0);
  sheet.click(sheet.button(said.archive.anyway));
  // The engine says no, and the sheet asks for the plan again once the clock moves on.
  await sheet.settle();
  await sheet.wait(0);
  assert.equal(sheet.asked("archive").length, 1);
  assert.match(sheet.text(), /Laci couldn’t archive kopi-landing\./);
  assert.equal(sheet.alert(), "Laci couldn’t archive kopi-landing.");
  sheet.focusIs(sheet.button(said.archive.anyway));
  assert.deepEqual(sheet.changes, []);
  // It looks again at what it would do, and the engine's own words wait under Show details.
  assert.equal(sheet.asked("archive/plan").length, 2);
  sheet.click(sheet.button(words.blocks.showDetails));
  assert.match(sheet.text(), /in use by Claude Code/);
}

export async function anotherPlaceForTheArchiveIsCheckedFirst() {
  const sheet = sheets({
    kind: "archive",
    node: ONLINE,
    replies: {
      "archive/plan": [
        archivePlan([]),
        () => {
          throw new Error("The archive destination already exists");
        },
        { ...archivePlan([]), dest: `${HOME}/old/kopi-landing` },
      ],
    },
  });
  await sheet.wait(0);
  sheet.click(sheet.button(words.blocks.showDetails));
  const field = () => sheet.find((n) => n.type === "input");
  assert.equal(field().props.value, "~/project/_archive/clients/kopi-landing");
  // A place that isn't whole is refused before the engine is asked.
  sheet.type("old/kopi-landing");
  await sheet.wait(200);
  assert.equal(sheet.asked("archive/plan").length, 1);
  assert.match(sheet.text(), /Laci can’t archive kopi-landing there\./);
  assert.match(sheet.text(), /Write the full location/);
  assert.equal(sheet.button(said.archive.archive).disabled, true);
  // One the engine refuses says so; the next one it accepts can be used.
  sheet.type("~/project/_archive/clients/kopi-landing");
  await sheet.wait(200);
  assert.match(sheet.text(), /The archive destination already exists/);
  sheet.type("~/old/kopi-landing");
  await sheet.wait(199);
  assert.equal(sheet.button(said.archive.archive).disabled, true, "while it is looked at");
  await sheet.wait(1);
  assert.deepEqual(sheet.asked("archive/plan").at(-1), {
    id: KOPI,
    destination: `${HOME}/old/kopi-landing`,
  });
  assert.equal(sheet.button(said.archive.archive).disabled, false);
}

export async function freeingSpaceSaysWhatGoesAndWaits() {
  const sheet = sheets({ kind: "clean", replies: { clean: [{ revision: 4 }] } });
  const text = sheet.text();
  assert.match(text, /Free up space in kopi-landing\?/);
  assert.match(text, /Deleted for good/);
  assert.match(text, /node_modules\s*440 MB/);
  assert.match(text, /Frees 440 MB\./);
  assert.match(text, /The next install or build brings them back\./);
  assert.deepEqual(sheet.filled(), [], "a button that deletes for good is never the filled one");
  const free = sheet.button("Free 440 MB");
  assert.match(free.props.className, /s-btn-danger/);
  // Its button needs nothing first, so the focus starts on Cancel: Enter alone frees nothing.
  sheet.focusIs(sheet.button(words.blocks.cancel));
  sheet.click(free);
  assert.match(
    sheet.text(),
    /Deleting the downloaded packages and build files in kopi-landing in 5 seconds\./,
  );
  sheet.press("Escape");
  await sheet.wait(60_000);
  assert.deepEqual(sheet.asked("clean"), []);
  sheet.click(sheet.button("Free 440 MB"));
  await sheet.wait(5000);
  assert.deepEqual(sheet.asked("clean"), [{ id: KOPI }]);
  assert.equal(sheet.app.getState().modal, null);
  assert.deepEqual(sheet.changes, [[{ revision: 4 }, "Freed 440 MB in kopi-landing"]]);
}

export async function freeingSpaceTheEngineRefusesSaysSo() {
  const sheet = sheets({
    kind: "clean",
    replies: {
      clean: [
        () => {
          throw new Error("This project is in use by a dev server. Close it first.");
        },
      ],
    },
  });
  sheet.click(sheet.button("Free 440 MB"));
  await sheet.wait(5000);
  assert.deepEqual(sheet.asked("clean"), [{ id: KOPI }]);
  assert.match(sheet.text(), /Laci couldn’t free up space in kopi-landing\./);
  assert.equal(sheet.alert(), "Laci couldn’t free up space in kopi-landing.");
  sheet.focusIs(sheet.button("Free 440 MB"), "back where it started");
  assert.deepEqual(sheet.changes, []);
  assert.deepEqual(sheet.app.getState().modal, { kind: "clean", id: KOPI });
}

export async function aSheetWhoseProjectWentClosesItself() {
  const sheet = sheets({ kind: "archive", replies: { "archive/plan": [archivePlan([])] } });
  await sheet.wait(0);
  sheet.act(() => sheet.app.setState({ snapshot: { home: HOME, nodes: {} } }));
  await sheet.settle();
  assert.equal(sheet.app.getState().modal, null, "the window doesn't wait for an empty sheet");
  assert.ok(!sheet.dialog());
}

// ── Detailed leaves them to Simple ─────────────────────────────────────────────────────────────────

/** Detailed's dialogs.tsx, drawn to HTML on a server for the app state `read` gives. */
function detailedDialogs(read) {
  const useApp = Object.assign((select) => (select ? select(read()) : read()), {
    getState: read,
    setState: noop,
  });
  const none = () => null;
  return load(
    "dialogs.tsx",
    {
      "./api": { api: async () => ({}), errorText: String },
      "./store": { useApp, changed: noop, run: noop, selectWhenReady: noop },
      "./common": { Icon: none, Ops: none, restoreFocus: noop, SeverityGlyph: none },
      "./terminal-api": { closeTerminal: noop, useTerms: () => undefined },
      "./session-ui": { AgentDialog: none, DeleteSessions: none, SessionDialog: none },
      "./mcp-setup": { McpDialog: none },
      "./select": {
        Select: none,
        SelectPortal: React.createContext(null),
        selectIsOpen: () => false,
      },
      "./settings": { useConfigPath: () => "~/.config/laci/config.json" },
    },
    {
      document: { documentElement: { dataset: { os: "linux" } }, activeElement: null },
      HTMLElement: class {},
    },
  ).Dialogs;
}

export async function detailedLeavesArchiveDeleteAndFreeUpSpaceToSimple() {
  let state;
  const Dialogs = detailedDialogs(() => state);
  const drawn = (design, kind) => {
    state = {
      design,
      modal: kind === "shortcuts" ? { kind } : { kind, id: KOPI },
      snapshot: { home: HOME, nodes: { [KOPI]: KOPI_NODE }, proposals: [] },
      historyPending: false,
      working: "",
      palette: false,
    };
    return renderToStaticMarkup(createElement(Dialogs));
  };
  for (const kind of ["archive", "delete", "clean"]) {
    assert.equal(drawn("simple", kind), "", `${kind} is Simple's own in Simple`);
    assert.match(drawn("detailed", kind), /role="dialog"/, `${kind} stays Detailed's in Detailed`);
  }
  assert.match(drawn("detailed", "delete"), /Move kopi-landing to Trash\?/);
  // Every other dialog is still the shared one in Simple.
  assert.match(drawn("simple", "shortcuts"), /Keyboard shortcuts/);
}
