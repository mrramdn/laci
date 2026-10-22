// Simple's AI helpers (ui/src/simple/AiHelpers.tsx) and what it works out (ui/src/simple/model.ts):
// the chats by project with their filters, the tools and whether each can use Laci, the summaries,
// and the page itself drawn by a stand-in for React, so a test can click through it: deleting chats
// waits for Select or a chat's own sheet, and each change sends the request Detailed sends.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";

const { createElement, Fragment } = requireUi("react");
const noop = () => {};

const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);
const model = load("simple/model.ts");
const { reportList } = load("helpers.ts");
const words = load("words.ts");
const said = words.aiHelpers;
const NOW = Date.parse(fixtures.meta.now);
const HOME = "/home/demo";
const ROOT = `${HOME}/project`;
const ACME = `${ROOT}/clients/acme-store`;
const KOPI = `${ROOT}/clients/kopi-landing`;
const scan = () => structuredClone(fixtures.snapshot);
const titles = (chats) => chats.map((c) => c.title);

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
  getClientRects() {
    return [{}];
  }
  focus() {
    this.page.document.activeElement = this;
  }
  /** The `data-` attributes, as an element's own. */
  get dataset() {
    return Object.fromEntries(
      Object.entries(this.props)
        .filter(([name]) => name.startsWith("data-"))
        .map(([name, value]) => [name.slice(5), value]),
    );
  }
  /** By classes and tag names, as ".s-savebar" or "button, input", which is all the pages ask for. */
  closest(selector) {
    const fits = (node, one) =>
      one.startsWith(".")
        ? String(node.props.className ?? "").split(" ").includes(one.slice(1))
        : node.type === one.replace(/\[.*\]$/, "");
    const wanted = selector.split(",").map((one) => one.trim());
    for (let node = this; node; node = node.parent)
      if (wanted.some((one) => fits(node, one))) return node;
    return null;
  }
  /** Drawn in the page's last draw. */
  get isConnected() {
    return this.page.drawn(this);
  }
  /** Only by a class, as ".s-summary-row", which is all the page asks for. */
  querySelectorAll(selector) {
    const name = selector.replace(/^\./, "");
    return this.descendants().filter((n) => String(n.props.className ?? "").split(" ").includes(name));
  }
  // What a page listens to here is tested on its own (theFocusMovesOnWhenItsControlGoes).
  addEventListener() {}
  removeEventListener() {}
}

/**
 * A page that components are drawn on, with React's hooks standing in for the real ones (as in
 * simple-ui.test.mjs). State, refs and effects keep their place between draws; an effect runs after
 * the draw in which its inputs changed. A change to the state draws again in the next microtask.
 */
function standIn() {
  const document = { activeElement: null };
  const instances = new Map();
  const hosts = new Map();
  let root = null;
  let output = [];
  let current = null;
  let pass = 0;
  let ids = 0;
  let dirty = false;
  let queued = false;
  let effects = [];
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
  const changedDeps = (cell, deps) =>
    !cell.deps ||
    !deps ||
    cell.deps.length !== deps.length ||
    deps.some((dep, i) => !Object.is(dep, cell.deps[i]));
  const effect = (run, deps) => {
    const cell = slot();
    if (changedDeps(cell, deps)) effects.push({ cell, run });
    cell.deps = deps;
  };
  const memo = (make, deps) => {
    const cell = slot();
    if (changedDeps(cell, deps)) {
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
      return (slot().ref ??= { current: initial });
    },
    useId: () => (slot().id ??= `:r${++ids}:`),
    useMemo: memo,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: effect,
    useLayoutEffect: effect,
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
    effects = [];
    output = root ? render(root, "") : [];
    for (const [key, instance] of instances)
      if (instance.pass !== pass) {
        for (const cell of instance.cells) cell.cleanup?.();
        instances.delete(key);
      }
    for (const [key, host] of hosts) if (host.pass !== pass) hosts.delete(key);
    for (const { cell } of effects) {
      cell.cleanup?.();
      cell.cleanup = undefined;
    }
    for (const { cell, run } of effects) {
      const cleanup = run();
      cell.cleanup = typeof cleanup === "function" ? cleanup : undefined;
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
    drawn: (host) => [...hosts.values()].includes(host),
    /** Draws again in the next microtask, as a change to a store does. */
    redraw: schedule,
    /** A store read through a selector, as the app's are: it draws again when it changes. */
    store(initial) {
      let state = initial;
      const listeners = new Set();
      const use = (select = (s) => s) => select(state);
      use.getState = () => state;
      use.setState = (change) => {
        const before = state;
        state = { ...state, ...(typeof change === "function" ? change(state) : change) };
        for (const listener of listeners) listener(state, before);
        schedule();
      };
      use.subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      return use;
    },
    mount(element) {
      root = element;
      dirty = true;
      flush();
      return page;
    },
    act(work) {
      const result = work();
      flush();
      return result;
    },
    /** Lets every promise that can settle, settle, and draws what it changed. */
    async settle() {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      flush();
    },
    all,
    find: (predicate) => all(predicate)[0],
    /** The first button whose words start with `text`. */
    button: (text) =>
      all((n) => n.type === "button" && n.textContent.startsWith(text))[0],
    text: () => output.map((n) => (n instanceof Host ? n.textContent : n)).join(" "),
  });
}

/**
 * Simple's building blocks, drawn plainly: a button is a button, a sheet a dialog with its words, a
 * card its title and content. What they do themselves is tested in simple-ui.test.mjs.
 */
function blocks() {
  const nothing = () => null;
  return {
    Button: ({ children, kind, danger, icon, small, ...rest }) =>
      createElement(
        "button",
        { type: "button", ...rest, "data-kind": kind, "data-danger": danger || undefined },
        children,
      ),
    Callout: ({ children, tone }) => createElement("p", { "data-tone": tone }, children),
    Card: ({ title, actions, children, footer, className }) =>
      createElement("section", { className }, title, actions, children, footer),
    Disclosure: ({ children }) => createElement("div", null, children),
    EmptyState: ({ title, children, action }) =>
      createElement("div", { "data-empty": true }, title, children, action),
    Info: nothing,
    MoreMenu: ({ label, items }) =>
      createElement(
        "div",
        { role: "menu", "aria-label": label },
        items
          .filter((item) => item !== "-")
          .map((item) =>
            createElement(
              "button",
              { key: item.label, type: "button", role: "menuitem", onClick: item.onSelect },
              item.label,
            ),
          ),
      ),
    Sheet: ({ title, description, children, footer }) =>
      createElement("div", { role: "dialog" }, title, description, children, footer),
    StatusChip: ({ children, tone }) => createElement("span", { "data-tone": tone }, children),
  };
}

/** `run` as the store has it: the task, and its error to `onError` or a toast. */
const runner = (toasts) => async (task, _working, options = {}) => {
  try {
    return await task();
  } catch (error) {
    if (options.onError) options.onError(error);
    else toasts.push(["Couldn’t finish", String(error)]);
    return undefined;
  }
};

/**
 * A page is compiled once and its imports ask the test running now (`current`), whose stand-in
 * draws it: compiling it again for each test would take longer than the tests. The tests of a file
 * run one after another.
 */
function shared() {
  const box = { current: null };
  const react = { Fragment };
  for (const hook of ["useState", "useRef", "useId", "useMemo", "useCallback", "useEffect", "useLayoutEffect"])
    react[hook] = (...args) => box.current.page.react[hook](...args);
  return {
    box,
    react,
    /** A function of the running test's, by name. */
    live: (name) => (...args) => box.current[name](...args),
    /** A store of the running test's, by name. */
    store: (name) => {
      const use = (select) => box.current[name](select);
      use.getState = () => box.current[name].getState();
      use.setState = (change) => box.current[name].setState(change);
      use.subscribe = (listener) => box.current[name].subscribe(listener);
      return use;
    },
    /** zustand's `create`: a store made once, whose changes draw the running test's page. */
    zustand: {
      create: (init) => {
        let state = init();
        const use = (select = (s) => s) => select(state);
        use.getState = () => state;
        use.setState = (change) => {
          state = { ...state, ...(typeof change === "function" ? change(state) : change) };
          box.current?.page.redraw();
        };
        use.reset = () => (state = init());
        return use;
      },
    },
  };
}

const helpersKit = shared();
let helpersModule;
/** AiHelpers.tsx, compiled the first time a test needs it. */
function helpersOnce() {
  const { live, store } = helpersKit;
  return (helpersModule ??= load(
    "simple/AiHelpers.tsx",
    {
      "./ai-helpers.css": {},
      react: helpersKit.react,
      zustand: helpersKit.zustand,
      "../actions": { closeReportItem: live("closeReportItem") },
      "../api": { api: live("api"), errorText: String },
      "../clock": { useNow: () => NOW },
      "../common": { Icon: () => null },
      "../hooks": {
        useReportSearch: (s) => ({
          needle: "",
          fullText: false,
          found: undefined,
          shown: reportList(s),
        }),
        useReportText: () => ({ raw: "# Title\n\nWords.", retry: noop }),
      },
      "../mcp-setup": { loadMcp: async () => {}, useMcp: store("mcp") },
      "../pick": { chooseFolder: live("chooseFolder") },
      "../readme": {
        renderReadme: (raw) => ({ html: raw, remote: 0, headings: [] }),
        proseClick: noop,
      },
      "../session-ui": { requestResume: live("requestResume") },
      "../store": {
        acknowledge: noop,
        changed: live("changed"),
        copyText: live("copyText"),
        external: noop,
        goToProject: live("goToProject"),
        markReportsSeen: noop,
        moveCopy: live("moveCopy"),
        openCopy: live("openCopy"),
        refreshLog: noop,
        rescan: noop,
        run: live("run"),
        setDesign: live("setDesign"),
        toast: live("toast"),
        useApp: store("app"),
      },
      "./act": {
        aiTools: (s) =>
          s.connectors
            .filter((c) => c.capabilities?.launch)
            .map((c) => ({ value: c.provider ?? c.id, label: c.name })),
        editorName: () => "VS Code",
      },
      "./ui": blocks(),
    },
    {
      // As in a browser, a frame comes once what was drawn is in.
      requestAnimationFrame: (fn) => setImmediate(fn),
      CSS: { escape: (s) => s },
      document: {
        body: BODY,
        get activeElement() {
          return helpersKit.box.current?.page.document.activeElement;
        },
      },
      // The running test gets each watcher's callback, to call as the page changes.
      MutationObserver: class {
        constructor(callback) {
          helpersKit.box.current?.watchers?.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    },
  ));
}
/** Where the focus is when no control has it. */
const BODY = { body: true };

/**
 * AiHelpers.tsx on the preview's scan, with the engine's answers in `replies` by request: a value, or
 * a function of the request's body. Every request is kept in `asked`.
 */
function helpersPage({ view = "agents", snapshot = scan(), replies = {}, mcp = {} } = {}) {
  const page = standIn();
  const asked = [];
  const toasts = [];
  const resumed = [];
  const closed = [];
  const copied = [];
  const navigated = [];
  const app = page.store({
    view,
    snapshot,
    historyPending: false,
    report: null,
    reportFilter: null,
    reportsSeen: 0,
    apps: fixtures.apps,
    navigate: (to) => {
      navigated.push(to);
      app.setState({ view: to });
    },
    openReport: ({ id }) => app.setState({ view: "reports", report: id ?? null }),
  });
  const mcpStore = page.store({ statuses: mcp });
  helpersKit.box.current = {
    page,
    app,
    mcp: mcpStore,
    api: async (name, body = {}) => {
      asked.push([name, body]);
      const reply = replies[name];
      return typeof reply === "function" ? reply(body) : (reply ?? {});
    },
    run: runner(toasts),
    toast: (title, message = "") => void toasts.push([title, message]),
    changed: (_change, title, message) => void toasts.push([title, message]),
    closeReportItem: async (...args) => void closed.push(args),
    copyText: (...args) => void copied.push(args),
    requestResume: (...args) => void resumed.push(args),
    goToProject: (id) => void navigated.push(`project:${id}`),
    setDesign: (design) => void navigated.push(`design:${design}`),
    // The system's picker hands over a folder on another drive.
    chooseFolder: (_options, onPick) => onPick("/mnt/archive/ai-chats"),
    // As the store moves the copy: a refusal goes to `onError`, the engine's answer to a toast with its Undo, in
    // the words the store chooses for it.
    moveCopy: async (dir, fresh, words, onError) => {
      const body = fresh ? { dir, fresh } : { dir };
      asked.push(["backup/move", body]);
      const reply = replies["backup/move"];
      if (reply instanceof Error) {
        onError(reply);
        return false;
      }
      const answer =
        typeof reply === "function"
          ? reply(body)
          : (reply ?? { dest: dir ? dir : "~/.local/share/laci/history", moved: true });
      toasts.push([words.said(answer), words.note]);
      // As the store takes in the change: history is read again, and Change… waits for it.
      app.setState({ historyPending: true });
      return true;
    },
    openCopy: (dest) => void navigated.push(`copy:${dest}`),
  };
  const exports = helpersOnce();
  exports.useHelpers.reset();
  page.mount(createElement(exports.AiHelpers));
  return {
    ...page,
    app,
    module: exports,
    helpers: exports.useHelpers,
    mcp: mcpStore,
    asked: (name) => asked.filter(([request]) => request === name),
    toasts,
    resumed,
    closed,
    copied,
    navigated,
    /** The checkboxes Select puts beside the chats. */
    picks: () => page.all((n) => n.type === "input" && n.props["aria-label"]?.startsWith("Select: ")),
    tab: (name) => page.find((n) => n.props.role === "tab" && n.textContent.startsWith(name)),
  };
}

// ── What the page works out ────────────────────────────────────────────────────────────────────────

export async function chatsAreListedByProjectWithTheQuickOnesFolded() {
  const chats = model.helperChats(scan(), { filter: "all", query: "" }, NOW);
  assert.equal(chats.all.length, 7);
  // The project with the newest chat first; a project's quick chats fold away behind its others.
  const groups = chats.groups.map((g) => [g.node?.label, titles(g.chats), titles(g.quick)]);
  assert.deepEqual(groups[0], ["kopi-landing", ["Empty session"], ["Hero section copy and layout"]]);
  // A project with only quick chats shows them, rather than an empty card.
  assert.deepEqual(groups[1], ["acme-store", ["Checkout total wrong on mobile"], []]);
  // Chats whose project moved away belong to the folder they were in, last among the dated ones.
  assert.deepEqual(groups.at(-1), [
    "project",
    ["Portfolio projects grid", "Midtrans checkout integration"],
    [],
  ]);
  // A chat in no project or folder at all comes after every project.
  const s = scan();
  s.sessions.push({ ...s.sessions[1], sessionId: "away", cwd: "/elsewhere", file: "/elsewhere/away.jsonl", updatedAt: "2026-10-08T08:00:00.000Z" });
  const outside = model.helperChats(s, { filter: "all", query: "" }, NOW);
  assert.equal(outside.groups.at(-1).node, undefined);
  assert.deepEqual(titles(outside.groups.at(-1).chats), ["Checkout total wrong on mobile"]);
  assert.equal(outside.counts.outside, 1);
}

export async function theFiltersOfChatsMeanWhatTheySay() {
  const of = (filter, query = "", s = scan()) => model.helperChats(s, { filter, query }, NOW);
  assert.deepEqual(of("all").counts, { all: 7, week: 4, old: 1, outside: 0, kept: 0, backup: 0 });
  assert.deepEqual(titles(of("week").shown), [
    "Empty session",
    "Checkout total wrong on mobile",
    "Hero section copy and layout",
    "Why the droplet keeps running out of memory",
  ]);
  assert.deepEqual(titles(of("old").shown), ["Midtrans checkout integration"]);
  // The search narrows the filter, by title, what was said or the project.
  assert.deepEqual(titles(of("week", "droplet").shown), ["Why the droplet keeps running out of memory"]);
  assert.deepEqual(titles(of("all", "acme-store").shown), [
    "Checkout total wrong on mobile",
    "Midtrans checkout integration",
  ]);
  // Kept and Only in Laci's copy are offered while some chat is, and a filter no longer offered
  // shows everything, so the list never strands empty.
  assert.deepEqual(of("all").filters, ["all", "week", "old", "outside"]);
  assert.equal(of("kept").filter, "all");
  const s = scan();
  s.sessions[3].kept = true;
  s.sessions[4].backup = true;
  const marked = of("kept", "", s);
  assert.deepEqual(marked.filters, ["all", "week", "old", "outside", "kept", "backup"]);
  assert.deepEqual(titles(marked.shown), ["Why the droplet keeps running out of memory"]);
  assert.deepEqual(titles(of("backup", "", s).shown), ["Grading export to PDF"]);
}

export async function selectCanPickOnlyTheChatsLaciCanDelete() {
  const s = scan();
  s.sessions[2].kept = true;
  const chats = model.helperChats(s, { filter: "all", query: "" }, NOW);
  // The Codex chat changed a moment ago (it may be open) and the kept one is left alone.
  assert.deepEqual(titles(chats.selectable), [
    "Checkout total wrong on mobile",
    "Why the droplet keeps running out of memory",
    "Grading export to PDF",
    "Portfolio projects grid",
    "Midtrans checkout integration",
  ]);
}

export async function toolsListTheAddedOnesFirstThenTheOnesLaciKnows() {
  const tools = model.toolCards(scan());
  assert.deepEqual(
    tools.map((t) => [t.id, t.provider, t.launch, t.mcp, t.found, Boolean(t.connector)]),
    [
      ["claude", "claude", true, true, true, true],
      ["codex", "codex", true, true, true, true],
      ["antigravity", "antigravity", true, false, false, false],
    ],
  );
  // The user's own tool comes after the ones Laci comes with.
  const s = scan();
  s.connectors.unshift({ ...s.connectors[1], id: "mine", name: "Mine", builtin: false, provider: undefined });
  assert.deepEqual(model.toolCards(s).map((t) => t.id), ["claude", "codex", "mine", "antigravity"]);
  assert.equal(model.toolCards(s)[2].provider, "mine");
}

export async function anAiIsInstalledOutOfReachOrMissing() {
  const [claude, , antigravity] = model.toolCards(scan());
  assert.equal(model.installOf(claude, undefined), undefined, "unknown until agent/models says");
  assert.equal(model.installOf(claude, true), "installed");
  // Its chats are here, so it is installed, but Laci can't find its program.
  assert.equal(model.installOf(claude, false), "cant-start");
  assert.equal(model.installOf(antigravity, false), "missing");
  assert.equal(said.install["cant-start"], "Installed, but Laci can’t start it");
}

export async function canUseLaciIsWhatTheAiOwnSettingsSay() {
  const status = (state) => ({ ...fixtures["agent/mcp"].agents[0], state });
  assert.equal(model.canUseOf(undefined), undefined);
  assert.deepEqual(
    ["registered", "missing", "other", "off"].map((state) => said.canUseWords[model.canUseOf(status(state))]),
    ["Yes", "Not yet", "Uses another Laci", "Turned off"],
  );
}

export async function anAiStartsWithTheChoiceMadeLast() {
  const caps = structuredClone(fixtures["agent/models"].claude);
  assert.deepEqual(model.startsWith(undefined), {});
  assert.deepEqual(model.startsWith(caps), { model: undefined, effort: undefined });
  assert.equal(said.startsWith("", ""), "Starts with its own model and thinking effort.");
  caps.remembered = { model: "opus", effort: "high" };
  assert.deepEqual(model.startsWith(caps), { model: "Opus", effort: "high" });
  assert.equal(said.startsWith("Opus", "high"), "Starts with Opus, with high thinking effort.");
  // A model the AI no longer lists is named as it was saved.
  caps.remembered = { model: "claude-old-1", effort: null };
  assert.deepEqual(model.startsWith(caps), { model: "claude-old-1", effort: undefined });
}

export async function aSummaryIsReadWithoutTheLinesTheReaderShowsAbove() {
  const raw = fixtures["reports/read"]["2026-10-07-checkout-total-on-mobile-safari.md"].raw;
  const body = model.summaryBody(raw);
  assert.match(body, /^## Summary\n/);
  assert.doesNotMatch(body, /\*\*Date:\*\*|\*\*Session:\*\*|# Checkout total/);
  // Front matter, a byte order mark and a field that runs over two lines go too; the rest stays.
  assert.equal(
    model.summaryBody("\uFEFF---\ntitle: x\n---\n\n# T\n- **Projects:** a,\n  b\n\nText\n- **Date:** kept"),
    "Text\n- **Date:** kept",
  );
}

export async function aLinkInASummaryOpensAnotherInItsFolder() {
  const reports = [{ id: "2026-10-01-a.md" }, { id: "b c.md" }];
  const link = (href, folder = "/notes/reports") => model.summaryLink(href, reports, folder)?.id;
  assert.equal(link("2026-10-01-a.md"), "2026-10-01-a.md");
  assert.equal(link("./b%20c.md#open"), "b c.md");
  assert.equal(link("/notes/reports/b c.md"), "b c.md");
  assert.equal(link("../elsewhere/b c.md"), undefined);
  assert.equal(link("sub/2026-10-01-a.md"), undefined);
}

// ── The page ───────────────────────────────────────────────────────────────────────────────────────

export async function deletingChatsWaitsForSelect() {
  const page = helpersPage({ replies: { "session/delete": { revision: 2 } } });
  // Before Select, no chat can be picked and there is nothing to delete with.
  assert.deepEqual(page.picks(), []);
  assert.equal(page.button(said.delete), undefined);
  page.act(() => page.button(said.select).props.onClick());
  // Select's bar takes its place, with the focus on what the bar says.
  assert.equal(page.document.activeElement?.textContent, said.selectNone);
  // Only the chats Laci can delete get a box: not the one that changed a moment ago. One more is
  // among kopi-landing's folded quick chats, and Select all counts it.
  assert.equal(page.picks().length, 5);
  assert.ok(page.button(said.selectAll(6)));
  assert.equal(page.button(said.delete).props.disabled, true, "nothing is chosen yet");
  const acme = page.picks().find((n) => n.props["aria-label"] === "Select: Checkout total wrong on mobile");
  page.act(() => acme.props.onChange());
  assert.match(page.text(), /1 chat selected, 285 B/);
  page.act(() => page.button(said.delete).props.onClick());
  // The sheet asks first, and nothing is sent before Delete.
  assert.ok(page.find((n) => n.props.role === "dialog"));
  assert.deepEqual(page.asked("session/delete"), []);
  const confirm = page.all((n) => n.type === "button" && n.textContent === said.deleteNow)[0];
  page.act(() => confirm.props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("session/delete"), [
    [
      "session/delete",
      {
        files: [
          "/home/demo/.claude/projects/-home-demo-project-clients-acme-store/5f0c2a1e-8d4b-4c7a-9e21-3b6d0f9a7c42.jsonl",
        ],
      },
    ],
  ]);
  assert.deepEqual(page.toasts.at(-1), [said.deleted(1), "Undo puts it back."]);
  assert.equal(page.find((n) => n.props.role === "dialog"), undefined, "the sheet closes");
  // Done leaves Select: the boxes go, and the focus goes back to Select.
  page.act(() => page.button(said.done).props.onClick());
  assert.deepEqual(page.picks(), []);
  assert.equal(page.document.activeElement, page.button(said.select));
}

export async function aChatsOwnSheetAsksBeforeItDeletes() {
  const page = helpersPage({ replies: { "session/delete": { revision: 2 } } });
  page.act(() => page.button("Checkout total wrong on mobile").props.onClick());
  const sheet = () => page.find((n) => n.props.role === "dialog");
  assert.match(sheet().textContent, /Claude Code · acme-store · yesterday/);
  page.act(() => page.button(said.delete).props.onClick());
  assert.match(sheet().textContent, new RegExp(said.deleteOne.replace("?", "\\?")));
  assert.equal(page.document.activeElement?.type, "h3", "the question takes the focus");
  // Cancel goes back to the chat, with the focus on Delete… again.
  page.act(() => page.button(words.blocks.cancel).props.onClick());
  assert.equal(page.document.activeElement?.textContent, said.delete);
  assert.deepEqual(page.asked("session/delete"), []);
  page.act(() => page.button(said.delete).props.onClick());
  page.act(() => page.all((n) => n.type === "button" && n.textContent === said.deleteNow)[0].props.onClick());
  await page.settle();
  assert.equal(page.asked("session/delete").length, 1);
  assert.equal(sheet(), undefined);
}

export async function aChatContinuesInItsProjectOrComesBackFromLacisCopy() {
  const s = scan();
  s.sessions[3].backup = true;
  s.sessions[3].id = "copy-n1";
  const page = helpersPage({ snapshot: s, replies: { "backup/restore": { revision: 2 } } });
  page.act(() => page.button(said.continue).props.onClick());
  assert.equal(page.resumed[0][1], ACME, "in the project it belongs to");
  // A chat only Laci's copy has is put back first; it can't be continued as it is.
  page.act(() => page.button(said.restore).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("backup/restore"), [["backup/restore", { id: "copy-n1" }]]);
}

export async function theTabsAreTheViewsDetailedHas() {
  const page = helpersPage();
  assert.equal(page.tab("Chats").props["aria-selected"], true);
  page.act(() => page.tab("Summaries").props.onClick());
  assert.deepEqual(page.navigated, ["reports"]);
  assert.equal(page.tab("Summaries").props["aria-selected"], true);
  page.act(() => page.tab("Tools").props.onClick());
  assert.equal(page.app.getState().view, "agents");
  assert.equal(page.tab("Tools").props["aria-selected"], true);
  // Each tab counts what it lists: Tools has a card for each AI Laci knows, added or not.
  assert.match(page.tab("Tools").textContent, /^Tools3$/);
  // The arrow keys move along the tabs and open the one they reach.
  const list = page.find((n) => n.props.role === "tablist");
  page.act(() => list.props.onKeyDown({ key: "ArrowRight", preventDefault: noop }));
  assert.equal(page.tab("Chats").props["aria-selected"], true);
  assert.equal(page.document.activeElement, page.tab("Chats"));
  page.act(() => list.props.onKeyDown({ key: "End", preventDefault: noop }));
  assert.equal(page.tab("Tools").props["aria-selected"], true);
}

export async function aiHelpersOpensOnChatsAgainUnlessToolsIsAskedFor() {
  const page = helpersPage();
  const { AiHelpers, showTools } = page.module;
  page.act(() => page.tab("Tools").props.onClick());
  // Away and back, from the sidebar or a project's "See all" for its chats: Chats again.
  page.mount(null);
  page.mount(createElement(AiHelpers));
  assert.equal(page.tab("Chats").props["aria-selected"], true);
  // Settings' way to the tools asks for Tools, once.
  page.mount(null);
  showTools();
  page.mount(createElement(AiHelpers));
  assert.equal(page.tab("Tools").props["aria-selected"], true);
  assert.equal(page.app.getState().view, "agents");
  assert.equal(page.helpers.getState().toTools, false, "asked once");
  page.mount(null);
  page.mount(createElement(AiHelpers));
  assert.equal(page.tab("Chats").props["aria-selected"], true);
}

export async function aSummaryTakesTheListsPlaceOnANarrowWindowWithTheFocus() {
  const page = helpersPage({ view: "reports" });
  await page.settle();
  const row = (id) => page.find((n) => n.props.className === "s-summary-row" && n.props["data-id"] === id);
  // On a wide window the list stays beside the summary, and so does the focus.
  page.act(() => row("2026-10-05-email-filters.md").props.onClick());
  await page.settle();
  assert.notEqual(page.document.activeElement?.type, "h2");
  // On a narrow window the list goes, so the focus goes to the summary's title.
  page.find((n) => n.props.className === "s-summaries-list").getClientRects = () => [];
  page.act(() => row("2026-10-06-kopi-hero-and-contact-form.md").props.onClick());
  await page.settle();
  assert.equal(page.document.activeElement?.type, "h2");
  assert.equal(page.document.activeElement.textContent, "Kopi landing: hero copy and contact form");
}

export async function theSummaryListIsOneStopForTabAndTheArrowKeysMoveAlongIt() {
  const page = helpersPage({ view: "reports" });
  await page.settle();
  const rows = () => page.all((n) => n.props.className === "s-summary-row");
  const stops = () => rows().filter((n) => n.props.tabIndex === 0).map((n) => n.props["data-id"]);
  // Tab stops on the summary that is open: the newest, until another is chosen.
  assert.deepEqual(stops(), ["2026-10-07-checkout-total-on-mobile-safari.md"]);
  const list = page.find((n) => n.type === "ul" && n.props["aria-label"] === said.summaryList);
  const press = (key, on = list) => page.act(() => on.props.onKeyDown({ key, preventDefault: noop }));
  rows()[0].focus();
  press("ArrowDown");
  assert.equal(page.document.activeElement, rows()[1]);
  press("End");
  assert.equal(page.document.activeElement, rows().at(-1));
  press("ArrowDown");
  assert.equal(page.document.activeElement, rows().at(-1), "the last stays the last");
  press("Home");
  assert.equal(page.document.activeElement, rows()[0]);
  // The arrow down in the search field goes into the list.
  page.document.activeElement = null;
  press("ArrowDown", page.find((n) => n.type === "input" && n.props["aria-label"] === said.searchSummaries));
  assert.equal(page.document.activeElement, rows()[0]);
  page.act(() => rows()[2].props.onClick());
  await page.settle();
  assert.deepEqual(stops(), ["2026-10-05-email-filters.md"]);
}

export async function theFocusMovesOnWhenItsControlGoes() {
  // The choice: the next control that can take it, else the nearest before it.
  const around = ["a", "b", "c", "d"];
  assert.equal(model.focusAfter(around, "b", (x) => x !== "c"), "d");
  assert.equal(model.focusAfter(around, "d", () => true), "c", "after the last, the one before");
  assert.equal(model.focusAfter(around, "x", () => true), undefined);
  // The pages watch for it: here on a page of three controls, as a browser would show them.
  const page = standIn();
  const watchers = [];
  const app = page.store({ working: "" });
  helpersKit.box.current = { page, watchers, app };
  const listeners = {};
  const control = (name) => ({
    name,
    isConnected: true,
    offsetParent: {},
    disabled: false,
    inert: false,
    matches(selector) {
      return selector === ":disabled" && this.disabled;
    },
    closest(selector) {
      return selector === "[inert]" && this.inert ? {} : null;
    },
    focus() {
      page.document.activeElement = this;
    },
  });
  const [a, b, c] = ["a", "b", "c"].map(control);
  const root = {
    querySelectorAll: () => [a, b, c],
    addEventListener: (type, listener) => (listeners[type] = listener),
    removeEventListener: noop,
    contains: (node) => [a, b, c].includes(node),
  };
  const { useFocusStays } = helpersOnce();
  function Probe() {
    useFocusStays(page.react.useRef(root));
    return null;
  }
  page.mount(createElement(Probe));
  const changed = () => watchers.forEach((watcher) => watcher());
  // Its control taken off the page, the focus goes on to the next one.
  b.focus();
  listeners.focusin({ target: b });
  b.isConnected = false;
  page.document.activeElement = BODY;
  changed();
  assert.equal(page.document.activeElement, c);
  // A control switched off for a moment keeps the focus.
  listeners.focusin({ target: c });
  c.disabled = true;
  changed();
  assert.equal(page.document.activeElement, c);
  // While a change runs the window takes no focus: the move waits for the change to end.
  c.disabled = false;
  a.inert = true;
  app.setState({ working: "Saving…" });
  c.isConnected = false;
  page.document.activeElement = BODY;
  changed();
  assert.equal(page.document.activeElement, BODY);
  a.inert = false;
  app.setState({ working: "" });
  await page.settle();
  assert.equal(page.document.activeElement, a, "the one before, the last being gone");
  c.isConnected = true;
  // Nothing moves after a click on no control, or once the focus went on elsewhere.
  listeners.pointerdown({ target: { closest: () => null } });
  c.isConnected = false;
  page.document.activeElement = BODY;
  changed();
  assert.equal(page.document.activeElement, BODY);
  a.focus();
  listeners.focusin({ target: a });
  listeners.focusout({ relatedTarget: { outside: true } });
  a.isConnected = false;
  page.document.activeElement = BODY;
  changed();
  assert.equal(page.document.activeElement, BODY);
}

export async function aPageCanSendTheFocusBackWhereItWas() {
  const page = standIn();
  const watchers = [];
  helpersKit.box.current = { page, watchers, app: page.store({ working: "" }) };
  const listeners = {};
  const control = () => ({
    isConnected: true,
    offsetParent: {},
    matches: () => false,
    closest: () => null,
    focus() {
      page.document.activeElement = this;
    },
  });
  const [theme, report, save] = [control(), control(), control()];
  const root = {
    querySelectorAll: () => [theme, report, save],
    addEventListener: (type, listener) => (listeners[type] = listener),
    removeEventListener: noop,
    contains: (node) => [theme, report, save].includes(node),
  };
  const { useFocusStays } = helpersOnce();
  function Probe() {
    useFocusStays(page.react.useRef(root), (gone) => (gone === save ? theme : undefined));
    return null;
  }
  page.mount(createElement(Probe));
  const goes = (which) => {
    which.focus();
    listeners.focusin({ target: which });
    which.isConnected = false;
    page.document.activeElement = BODY;
    watchers.forEach((watcher) => watcher());
  };
  // Save changes goes with its bar: the focus goes back to the setting, not on to the page's last control.
  goes(save);
  assert.equal(page.document.activeElement, theme);
  // When that one can't take it either, the usual way: here the one before.
  save.isConnected = true;
  theme.isConnected = false;
  goes(save);
  assert.equal(page.document.activeElement, report);
}

export async function theCopyOfChatsSaysAfterHowManyDaysAnAiDeletesThem() {
  const s = scan();
  assert.deepEqual(model.chatsAtRisk(s), { provider: "claude", days: 30 });
  // The days are the AI's own setting, as the scan read it.
  s.warnings[0].title = "Claude Code deletes session logs after 7 days";
  assert.deepEqual(model.chatsAtRisk(s), { provider: "claude", days: 7 });
  s.warnings[0].title = "Claude Code deletes old session logs";
  assert.deepEqual(model.chatsAtRisk(s), { provider: "claude" });
  assert.equal(model.chatsAtRisk({ ...s, warnings: [] }), undefined);
  assert.equal(
    said.copyWarn("Claude Code", 1),
    "Claude Code deletes chats after 1 day. Without a copy, older chats are gone for good.",
  );
  assert.equal(said.copyWarn("Claude Code"), "Claude Code deletes its old chats. Without a copy, they are gone for good.");
  // The card says it while Laci copies only when asked.
  const week = scan();
  week.warnings[0].title = "Claude Code deletes session logs after 7 days";
  const page = helpersPage({ snapshot: week });
  const warned = () => page.find((n) => n.props["data-tone"] === "soon")?.textContent;
  assert.equal(warned(), said.copyWarn("Claude Code", 7));
  page.app.setState({ snapshot: { ...week, backup: { ...week.backup, auto: true } } });
  await page.settle();
  assert.equal(warned(), undefined);
}

export async function theCopyOfChatsMovesToAnotherFolderOnlyOnceAskedWhere() {
  const replies = {};
  const page = helpersPage({ replies });
  const place = () => page.find((n) => n.props["data-ui"] === "copy-place");
  const button = (words) => page.find((n) => n.type === "button" && n.textContent === words);
  assert.ok(place().textContent.includes(said.copyPlaceOwn), place().textContent);
  assert.equal(button(said.copyPlaceBack), undefined, "the copy is in Laci’s own folder already");
  page.act(() => button(said.copyPlaceChange).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("backup/move"), [], "a folder picked only asks");
  assert.ok(place().textContent.includes(said.copyMoveAsk("/mnt/archive/ai-chats")), place().textContent);
  assert.ok(place().textContent.includes(said.copyMoveNote));
  // Refused, the question stays, and says why.
  replies["backup/move"] = new Error("That folder already holds files.");
  page.act(() => button(said.copyMove).props.onClick());
  await page.settle();
  assert.match(place().textContent, /That folder already holds files\./);
  delete replies["backup/move"];
  page.act(() => button(said.copyMove).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("backup/move").at(-1), ["backup/move", { dir: "/mnt/archive/ai-chats" }]);
  assert.deepEqual(page.toasts.at(-1), [said.copyMoved("/mnt/archive/ai-chats"), said.copyMoveNote]);
  assert.equal(button(said.copyMove), undefined, "moved, the question goes");
  // A chosen folder shows, and the copy can go back to Laci’s own folder, asked the same way.
  const s = scan();
  page.app.setState({ snapshot: { ...s, backup: { ...s.backup, chosen: true, dest: "/mnt/archive/ai-chats" } } });
  await page.settle();
  assert.ok(place().textContent.includes("/mnt/archive/ai-chats"));
  page.act(() => button(said.copyPlaceBack).props.onClick());
  await page.settle();
  assert.ok(place().textContent.includes(said.copyMoveAsk(said.copyPlaceOwnName)), place().textContent);
  page.act(() => button(said.copyMove).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("backup/move").at(-1), ["backup/move", { dir: "" }]);
  // Laci's own folder is said by its name, as the card says it, not by its path.
  assert.deepEqual(page.toasts.at(-1), [said.copyMoved(said.copyPlaceOwnName), said.copyMoveNote]);
}

export async function aCopyLaciCantReachIsNotMovedButANewOneCanStart() {
  const replies = { "backup/move": ({ dir }) => ({ dest: dir, moved: false }) };
  const s = scan();
  const why = "The folder for the copy of AI chats isn't there: /mnt/archive/ai-chats. Connect its drive, or choose another folder for the copy.";
  const snapshot = { ...s, backup: { ...s.backup, chosen: true, dest: "/mnt/archive/ai-chats", bytes: 1e9, packed: true, error: why } };
  const page = helpersPage({ snapshot, replies });
  const place = () => page.find((n) => n.props["data-ui"] === "copy-place");
  const button = (words) => page.find((n) => n.type === "button" && n.textContent === words);
  const change = button(said.copyPlaceChange);
  assert.equal(change.props["aria-label"], said.copyPlaceChangeName);
  assert.ok(change.props["aria-label"].startsWith(said.copyPlaceChange.replace("…", "")));
  page.act(() => change.props.onClick());
  await page.settle();
  // The question says no move happens, and takes the focus.
  const asked = place().textContent;
  assert.ok(asked.includes(said.copyFreshAsk("/mnt/archive/ai-chats")), asked);
  assert.ok(asked.includes(said.copyFreshNote), asked);
  assert.ok(!asked.includes("1.0 GB"), "nothing is said to move");
  assert.equal(button(said.copyMove), undefined);
  const group = page.find((n) => n.props.role === "group" && n.props["aria-label"] === said.copyFresh);
  assert.equal(page.document.activeElement, group);
  // What it says is what a screen reader tells with the group.
  const told = page.find((n) => n.props.id === group.props["aria-describedby"]);
  assert.ok(told.textContent.includes(said.copyFreshAsk("/mnt/archive/ai-chats")), told.textContent);
  assert.ok(told.textContent.includes(said.copyFreshNote), told.textContent);
  page.act(() => button(said.copyFresh).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("backup/move").at(-1), ["backup/move", { dir: "/mnt/archive/ai-chats", fresh: true }]);
  assert.deepEqual(page.toasts.at(-1), [said.copyKept("/mnt/archive/ai-chats"), said.copyFreshNote]);
  // Answered, the focus goes back to Change… once history is read again and Change… can take it.
  assert.equal(button(said.copyPlaceChange).props.disabled, true);
  assert.notEqual(page.document.activeElement, button(said.copyPlaceChange));
  page.app.setState({ historyPending: false });
  await page.settle();
  assert.equal(page.document.activeElement, button(said.copyPlaceChange));
}

export async function theSizeOfACopyIsSaidOnlyOnceItIsPacked() {
  const s = scan();
  const plain = { ...s, backup: { ...s.backup, bytes: 5.2e9, packed: undefined } };
  const page = helpersPage({ snapshot: plain });
  const place = () => page.find((n) => n.props["data-ui"] === "copy-place");
  const button = (words) => page.find((n) => n.type === "button" && n.textContent === words);
  page.act(() => button(said.copyPlaceChange).props.onClick());
  await page.settle();
  assert.ok(place().textContent.includes(said.copyMovePlainAsk("/mnt/archive/ai-chats")), place().textContent);
  assert.ok(!place().textContent.includes("5.2 GB"));
  page.act(() => button(words.blocks.cancel).props.onClick());
  await page.settle();
  page.app.setState({ snapshot: { ...s, backup: { ...s.backup, bytes: 1.01e9, packed: true } } });
  await page.settle();
  page.act(() => button(said.copyPlaceChange).props.onClick());
  await page.settle();
  assert.ok(place().textContent.includes(said.copyMoveAsk("/mnt/archive/ai-chats", "1.0 GB")), place().textContent);
}

export async function stillToDoItemsAreClosedInLaciNotInTheFile() {
  const page = helpersPage({ view: "reports" });
  await page.settle();
  // The newest summary is open beside the list, with its two items still to do.
  assert.match(page.text(), /Checkout total wrong on mobile Safari/);
  const done = page.find((n) => n.type === "button" && n.props["aria-label"]?.startsWith(said.itemDoneFor("Send")));
  page.act(() => done.props.onClick());
  const notNeeded = page.find((n) => n.type === "button" && n.props["aria-label"]?.startsWith(said.notNeededFor("Promo")));
  page.act(() => notNeeded.props.onClick());
  await page.settle();
  assert.deepEqual(
    page.closed,
    [
      [
        "2026-10-07-checkout-total-on-mobile-safari.md",
        "Send the staging link to the client and ask for the go to release.",
        "done",
      ],
      [
        "2026-10-07-checkout-total-on-mobile-safari.md",
        "Promo codes stack with the expo discount; ask whether that is wanted.",
        "dropped",
      ],
    ],
  );
  // The summary names its chat, which opens on its own sheet.
  page.act(() => page.button(said.fromChat("Checkout")).props.onClick());
  assert.match(page.find((n) => n.props.role === "dialog").textContent, /Checkout total wrong on mobile/);
}

export async function summariesNotSetUpOfferAFolder() {
  const s = scan();
  delete s.reportsDir;
  delete s.reports;
  const page = helpersPage({ view: "reports", snapshot: s });
  assert.match(page.text(), new RegExp(said.noFolderTitle));
  assert.ok(page.button(said.chooseFolder));
}

export async function showingAnAisChatsAddsOrRemovesIt() {
  const page = helpersPage({ replies: { "agent/models": (body) => fixtures["agent/models"][body.provider] } });
  page.act(() => page.tab("Tools").props.onClick());
  await page.settle();
  // Whether each program is installed is asked without starting it.
  assert.deepEqual(
    page.asked("agent/models").map(([, body]) => body),
    [
      { provider: "claude", passive: true },
      { provider: "codex", passive: true },
      { provider: "antigravity", passive: true },
    ],
  );
  assert.match(page.text(), /Not installed/);
  const box = (name) =>
    page.find((n) => n.type === "label" && n.textContent === `${said.showChats}${said.forTool(name)}`)
      .children.find((n) => n.type === "input");
  assert.equal(box("Codex").props.checked, true);
  page.act(() => box("Codex").props.onChange());
  page.act(() => box("Antigravity").props.onChange());
  await page.settle();
  assert.deepEqual(page.asked("connector/remove"), [["connector/remove", { id: "codex" }]]);
  assert.deepEqual(page.asked("connector/add"), [["connector/add", { preset: "antigravity" }]]);
  assert.deepEqual(page.toasts.slice(-2), [
    [said.chatsHidden("Codex"), said.chatsHiddenNote],
    [said.chatsShown("Antigravity"), undefined],
  ]);
}

export async function yourOwnAiToolIsRemovedRatherThanUnticked() {
  const s = scan();
  s.connectors.push({ ...s.connectors[1], id: "mine", name: "Mine", builtin: false, provider: undefined });
  const page = helpersPage({ snapshot: s, replies: { "connector/remove": { revision: 2 } } });
  page.act(() => page.tab("Tools").props.onClick());
  await page.settle();
  // The tools Laci comes with keep their box. Your own is there only while Laci shows its chats, so
  // a box to untick would make it vanish: it has a Remove button instead.
  assert.deepEqual(
    page.all((n) => n.type === "label" && n.textContent.startsWith(said.showChats)).map((n) => n.textContent),
    ["Claude Code", "Codex", "Antigravity"].map((name) => `${said.showChats}${said.forTool(name)}`),
  );
  page.act(() => page.button(`${said.removeOwn}${said.forTool("Mine")}`).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("connector/remove"), [["connector/remove", { id: "mine" }]]);
  assert.deepEqual(page.toasts.at(-1), [said.ownRemoved("Mine"), said.ownRemovedNote]);
}

export async function lettingAnAiUseLaciGoesThroughItsOwnSettings() {
  const [claude, codex] = fixtures["agent/mcp"].agents;
  const statuses = { claude, codex: { ...codex, state: "registered" } };
  const page = helpersPage({
    mcp: statuses,
    replies: {
      "agent/models": (body) => fixtures["agent/models"][body.provider],
      "agent/mcp/apply": (body) => ({
        status: { ...statuses[body.provider], state: body.remove ? "missing" : "registered" },
      }),
    },
  });
  page.act(() => page.tab("Tools").props.onClick());
  await page.settle();
  assert.match(page.text(), /Can use Laci: Not yet/);
  page.act(() => page.button(`${said.canUseAction["not-yet"]}${said.forTool("Claude Code")}`).props.onClick());
  const sheet = () => page.find((n) => n.props.role === "dialog");
  assert.match(sheet().textContent, /Let Claude Code use Laci/);
  // What changes is shown before anything is sent: Claude Code's own command, and the file it changes.
  assert.match(sheet().textContent, /claude mcp add laci --scope user/);
  assert.ok(sheet().textContent.includes(said.keepsCopy(claude.file)), claude.file);
  // The command can be copied, to run it yourself when Laci can't.
  page.act(() => page.find((n) => n.type === "button" && n.textContent === said.copyChange).props.onClick());
  assert.deepEqual(page.copied, [[claude.add, said.changeCopied, "Claude Code"]]);
  assert.deepEqual(page.asked("agent/mcp/apply"), []);
  page.act(() => page.find((n) => n.type === "button" && n.textContent === said.useAction["not-yet"]).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("agent/mcp/apply"), [["agent/mcp/apply", { provider: "claude" }]]);
  assert.equal(page.mcp.getState().statuses.claude.state, "registered");
  assert.equal(sheet(), undefined);
  // Codex can already: its sheet offers only to stop, says the command that stops it, and stopping
  // is asked for as removing.
  page.act(() => page.button(`${said.canUseAction.yes}${said.forTool("Codex")}`).props.onClick());
  assert.equal(page.find((n) => n.type === "button" && n.props["data-kind"] === "filled"), undefined);
  assert.match(sheet().textContent, /codex mcp remove laci/);
  assert.doesNotMatch(sheet().textContent, /codex mcp add/);
  page.act(() => page.button(said.stopUsing).props.onClick());
  await page.settle();
  assert.deepEqual(page.asked("agent/mcp/apply").at(-1), ["agent/mcp/apply", { provider: "codex", remove: true }]);
}

export async function anAiWhoseSettingsFileLaciEditsIsToldWhatComesOutOfIt() {
  const [claude] = fixtures["agent/mcp"].agents;
  const file = { ...claude, how: "file", file: "~/.ai/settings.json", snippet: '{"laci": {}}' };
  const page = helpersPage({
    mcp: { claude: { ...file, state: "registered" } },
    replies: { "agent/models": (body) => fixtures["agent/models"][body.provider] },
  });
  page.act(() => page.tab("Tools").props.onClick());
  await page.settle();
  page.act(() => page.button(`${said.canUseAction.yes}${said.forTool("Claude Code")}`).props.onClick());
  const text = page.find((n) => n.props.role === "dialog").textContent;
  assert.match(text, new RegExp(said.takesOut("~/.ai/settings.json").replaceAll(".", "\\.")));
  assert.doesNotMatch(text, /"laci"/, "what was added is not shown as what is added now");
  // Not set up yet, the sheet shows what goes into the file.
  page.mcp.setState({ statuses: { claude: { ...file, state: "missing" } } });
  await page.settle();
  assert.match(page.find((n) => n.props.role === "dialog").textContent, /Laci adds this to ~\/\.ai\/settings\.json:\{"laci": \{\}\}/);
}

export async function startAChatOffersEachAiLaciCanStart() {
  const page = helpersPage();
  const menu = page.find((n) => n.props.role === "menu" && n.props["aria-label"] === said.start);
  assert.deepEqual(
    menu.children.map((n) => n.textContent),
    [said.startWith("Claude Code"), said.startWith("Codex")],
  );
  page.act(() => menu.children[1].props.onClick());
  assert.deepEqual(page.app.getState().modal, { kind: "agent", provider: "codex", projectPath: "" });
  // Detailed's denser lists stay one switch away, under ⋯ More.
  const more = page.find((n) => n.props.role === "menu" && n.props["aria-label"] === words.blocks.moreFor(said.title));
  page.act(() => more.children[0].props.onClick());
  assert.deepEqual(page.navigated, ["design:detailed"]);
}

/**
 * The stand-in for React, the plain building blocks and a page compiled once, for
 * simple-settings.test.mjs. An object, so the runner doesn't take it for a test.
 */
export const kit = { standIn, blocks, runner, shared };
