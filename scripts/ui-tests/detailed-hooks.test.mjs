// Detailed's views on the shared actions and hooks (ui:X2b): inspector.tsx, session-ui.tsx and
// views/folder, tidy, log, reports and agents. The real React draws them into a small stand-in for the
// page, on the real store and sync.ts, with the preview's fixtures as the desktop's answers.
// - A status event from the desktop (a scan's progress) draws none of them again, while what each
//   one shows still does.
// - Their changes go through ui/src/actions.ts, and their health and notes come from ui/src/hooks.ts.
// - marked and DOMPurify (ui/src/readme.ts) load only when a README or a report is drawn, and its
//   raw text never shows while they do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";

const React = requireUi("react");
const { createRoot } = requireUi("react-dom/client");
const { act, createElement: h, Fragment, Profiler } = React;

const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);
const ACME = "/home/demo/project/clients/acme-store";
const CLIENTS = "/home/demo/project/clients";
const CHECKOUT = "2026-10-07-checkout-total-on-mobile-safari.md";
const CHECKOUT_SESSION = "5f0c2a1e-8d4b-4c7a-9e21-3b6d0f9a7c42";
const CHECKOUT_LOG = `/home/demo/.claude/projects/-home-demo-project-clients-acme-store/${CHECKOUT_SESSION}.jsonl`;
/** What the stand-in for readme.ts draws any Markdown as. */
const DRAWN = '<p class="drawn">Drawn from Markdown</p>';
const noop = () => {};

// ── A page for React to draw on ─────────────────────────────────────────────────────────────────────

/** A node of the page: its children and text. Nothing is laid out, and events are not delivered. */
class PageNode {
  constructor(document, nodeType, nodeName) {
    this.ownerDocument = document;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.childNodes = [];
    this.parentNode = null;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, before) {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  get textContent() {
    return this.nodeType === 3
      ? this.nodeValue
      : this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(this.ownerDocument.createTextNode(String(text)));
  }
  addEventListener() {}
  removeEventListener() {}
}
class PageElement extends PageNode {
  constructor(document, tag, namespaceURI = "http://www.w3.org/1999/xhtml") {
    super(document, 1, tag.toUpperCase());
    this.tagName = tag.toUpperCase();
    this.localName = tag;
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.style = { setProperty: noop, removeProperty: noop };
    this.html = "";
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_namespace, name, value) {
    this.setAttribute(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_namespace, name) {
    this.attributes.delete(name);
  }
  /** What dangerouslySetInnerHTML put here. The page keeps it as text and doesn't parse it. */
  get innerHTML() {
    return this.html;
  }
  set innerHTML(html) {
    this.textContent = "";
    this.html = html;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  scrollIntoView() {}
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {}
}
/** A document, and the window React reads `event` from. */
function page() {
  const document = {
    nodeType: 9,
    nodeName: "#document",
    activeElement: null,
    createElement: (tag) => new PageElement(document, tag),
    createElementNS: (namespaceURI, tag) => new PageElement(document, tag, namespaceURI),
    createTextNode(text) {
      const node = new PageNode(document, 3, "#text");
      node.nodeValue = text;
      return node;
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
  };
  document.documentElement = new PageElement(document, "html");
  document.documentElement.dataset = { os: "linux", design: "detailed" };
  document.body = document.documentElement.appendChild(new PageElement(document, "body"));
  const window = {
    document,
    event: undefined,
    HTMLIFrameElement: class {},
    addEventListener: noop,
    removeEventListener: noop,
  };
  document.defaultView = window;
  return { document, window };
}
/** Every element inside `node`. */
function* inside(node) {
  for (const child of node.childNodes)
    if (child.nodeType === 1) {
      yield child;
      yield* inside(child);
    }
}
/** The props React drew an element with, its handlers among them: react-dom keeps them on it. */
function props(element) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  assert.ok(key, `React did not draw this <${element.localName}>`);
  return element[key];
}
/** An event for a handler to take, from `element`. */
const eventOn = (element, extra = {}) => ({
  target: element,
  currentTarget: element,
  defaultPrevented: false,
  propagationStopped: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {
    this.propagationStopped = true;
  },
  ...extra,
});
/** A promise a test settles when it likes. */
function later() {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return Object.assign(promise, { resolve });
}

// ── Detailed, on a desktop that answers from the fixtures ───────────────────────────────────────────

/**
 * The window's code as Detailed runs it: the real store, sync.ts, actions.ts, hooks.ts, the views and
 * what they share, with what the views draw beside their own work (selects, terminals, the agent
 * fields, a dialog's frame, MCP rows) left out. `calls` lists the shared actions and hooks the views
 * called, and `requests` what was asked of the desktop. With `holdMarkdown`, readme.ts stays on its
 * way until `releaseMarkdown()`. `edit` changes the scan before the window reads it.
 */
async function detailed({ holdMarkdown = false, edit = noop } = {}) {
  const { document, window } = page();
  const scan = structuredClone(fixtures.snapshot);
  edit(scan);
  let revision = scan.revision ?? 0;
  const node = (id) => ({ ...structuredClone(scan.nodes[id]), revision: ++revision });
  const change = () => ({ revision: ++revision, journal: { id: `j${revision}`, canUndo: true } });
  const answers = {
    prefs: () => ({
      theme: "",
      design: "detailed",
      configured: true,
      configPath: "~/.config/laci/config.json",
      os: "linux",
    }),
    snapshot: () => scan,
    status: () => ({ type: "status", busy: false, revision, historyPending: false }),
    apps: () => fixtures.apps,
    "new/current": () => null,
    health: (body) => fixtures.health[body.id],
    log: () => fixtures.log,
    storage: () => fixtures.storage,
    ls: (body) => fixtures.ls[body.path] ?? { path: body.path, entries: [] },
    "ls/newest": (body) => fixtures["ls/newest"][body.path] ?? {},
    "reports/read": (body) => fixtures["reports/read"][body.id],
    "reports/search": () => [],
    "agent/models": (body) => {
      const caps = fixtures["agent/models"][body.provider];
      if (!caps) throw `No models for ${body.provider}`;
      return caps;
    },
    meta: (body) => node(body.id),
    todo: (body) => node(body.id),
    notes: (body) => ({ ...node(body.id), notes: body.text }),
    apply: change,
    "log/undo": change,
    "proposal/dismiss": () => ({}),
    "report/close": () => ({}),
  };
  const requests = [];
  const api = {
    api: async (name, body = {}) => {
      requests.push({ name, body });
      const answer = answers[name];
      if (!answer) throw `The test has no answer for ${name}`;
      return structuredClone(await answer(body));
    },
    errorText: (error) => (error instanceof Error ? error.message : String(error)),
  };
  // The views' timers (a note waits 600 ms to be saved) run when a test says so.
  const timers = [];
  const storage = new Map();
  const globals = {
    document,
    window,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, String(value)),
    },
    setTimeout: (callback) => timers.push(callback),
    clearTimeout: (id) => {
      if (id) timers[id - 1] = null;
    },
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
  };

  // readme.ts: as soon as it is asked for, or held back until the test lets it come.
  let required = 0;
  const held = later();
  const markdown = {
    renderReadme: () => ({ html: DRAWN, remote: 0, headings: [] }),
    proseClick: noop,
  };
  /** `deps` with readme.ts among them, counted each time a file loads it. */
  const withReadme = (deps) => {
    for (const name of ["./readme", "../readme"])
      Object.defineProperty(deps, name, {
        enumerable: true,
        get() {
          required++;
          // A module that says it is one is passed on as it is, and import() waits for a promise.
          return holdMarkdown ? Object.assign(held, { __esModule: true }) : markdown;
        },
      });
    return deps;
  };

  const calls = [];
  /** `module` with each function it exports noted in `calls` before it runs. */
  const noted = (module) =>
    Object.fromEntries(
      Object.entries(module).map(([name, value]) => [
        name,
        typeof value === "function"
          ? (...args) => {
              calls.push([name, ...args]);
              return value(...args);
            }
          : value,
      ]),
    );
  const twice = (name, module) => ({ [`./${name}`]: module, [`../${name}`]: module });

  const store = load("store.ts", { "./api": api }, globals);
  const actions = noted(load("actions.ts", { "./api": api, "./store": store }, globals));
  const hooks = noted(
    load("hooks.ts", withReadme({ "./api": api, "./store": store }), globals),
  );
  // The views' components read the store as they draw, so its reads count their draws.
  let draws = 0;
  const useApp = Object.assign((...args) => {
    draws++;
    return store.useApp(...args);
  }, store.useApp);
  const selects = new Map();
  const left = withReadme({
    ...twice("api", api),
    ...twice("store", { ...store, useApp }),
    ...twice("actions", actions),
    ...twice("hooks", hooks),
    ...twice("clock", { useNow: () => Date.parse(fixtures.meta.now) }),
    ...twice("select", {
      // Remembered by label, so a test can choose an option.
      Select: (options) => {
        selects.set(options.label, options);
        return h("button", { className: options.className }, options.children);
      },
    }),
    ...twice("terminal-controls", { TerminalButton: () => null, launchShell: noop }),
    ...twice("terminal-api", {
      openTerminal: async () => {},
      restoreTerminals: async () => {},
      useTerms: (select) => select({ tabs: [] }),
    }),
    ...twice("agent-launch", {
      agentProviders: (connectors) =>
        connectors.map((c) => ({ value: c.provider ?? c.id, label: c.name })),
      agentDraft: (provider, target) => ({ provider, target, prompt: "" }),
      AgentFields: () => null,
      askAgent: async () => {},
      launchAgent: async () => {},
    }),
    "./dialogs": {
      DialogFrame: ({ title, description, footer, children }) =>
        h("div", { role: "dialog" }, h("h2", null, title), h("p", null, description), children, footer),
    },
    "../mcp-setup": { McpRow: () => null, loadMcp: async () => {} },
    "../hotkeys": { HIDDEN_FILES_HINT: "Ctrl+H" },
  });
  // What the views share is one module each, as in the window. A file is compiled when a test first
  // needs it, since compiling is most of what a test takes.
  const files = new Map();
  const compiled = (file) => {
    if (!files.has(file)) files.set(file, load(file, left, globals));
    return files.get(file);
  };
  for (const [name, file] of [
    ["helpers", "helpers.ts"],
    ["common", "common.tsx"],
    ["session-ui", "session-ui.tsx"],
  ])
    for (const key of [`./${name}`, `../${name}`])
      Object.defineProperty(left, key, { enumerable: true, get: () => compiled(file) });
  const views = {
    get Inspector() {
      return compiled("inspector.tsx").Inspector;
    },
    get Folder() {
      return compiled("views/folder.tsx").Folder;
    },
    get Tidy() {
      return compiled("views/tidy.tsx").Tidy;
    },
    get LogView() {
      return compiled("views/log.tsx").LogView;
    },
    get ReportsView() {
      return compiled("views/reports.tsx").ReportsView;
    },
    get AgentsView() {
      return compiled("views/agents.tsx").AgentsView;
    },
    get AgentDialog() {
      return compiled("session-ui.tsx").AgentDialog;
    },
    get SessionDialog() {
      return compiled("session-ui.tsx").SessionDialog;
    },
    get DeleteSessions() {
      return compiled("session-ui.tsx").DeleteSessions;
    },
  };
  let deliver;
  const { useLaciSync } = load(
    "sync.ts",
    {
      "@tauri-apps/api/event": {
        listen: async (_name, handler) => {
          deliver = handler;
          return noop;
        },
      },
      "./api": api,
      "./store": store,
      "./terminal-api": left["./terminal-api"],
    },
    globals,
  );

  // React reads `window.event` as it schedules a change. Both go back as they were when the test ends.
  const outer = Object.getOwnPropertyDescriptors(globalThis);
  globalThis.window = window;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const commits = new Map();
  function Sync() {
    useLaciSync();
    return null;
  }
  /** Detailed's details panel, as DetailedShell draws it. */
  function Shown() {
    const n = store.useApp((s) => (s.selected ? s.snapshot?.nodes[s.selected] : undefined));
    return n ? h(views.Inspector, { node: n }) : null;
  }
  /** Lets every promise that can settle, settle, and draws what that changed. */
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    });
  /** Each time React draws anything inside the view `name` again. */
  const counted = (name, element) =>
    h(
      Profiler,
      { key: name, id: name, onRender: () => commits.set(name, (commits.get(name) ?? 0) + 1) },
      element,
    );
  /** Draws the window with these views in it, each counted by its own name. */
  async function draw(shown) {
    const views = Object.entries(shown).map(([name, element]) => counted(name, element));
    await act(async () => root.render(h(Fragment, null, h(Sync, { key: "sync" }), ...views)));
    await settle();
  }
  /** Takes the window away and gives the globals back. */
  async function close() {
    await act(async () => root.unmount());
    for (const name of ["window", "IS_REACT_ACT_ENVIRONMENT"])
      if (outer[name]) Object.defineProperty(globalThis, name, outer[name]);
      else delete globalThis[name];
  }
  // The window starts as the app's does: once the first scan is in.
  try {
    await act(async () => root.render(h(Fragment, null, h(Sync, { key: "sync" }))));
    await settle();
    assert.ok(store.useApp.getState().snapshot, "the first scan is in");
  } catch (error) {
    await close();
    throw error;
  }

  const app = {
    Shown,
    store,
    calls,
    requests,
    selects,
    container,
    state: () => store.useApp.getState(),
    /** The bodies of the requests named `name`, in the order they were sent. */
    asked: (name) => requests.filter((r) => r.name === name).map((r) => r.body),
    /** How many times the views' components have been drawn. */
    draws: () => draws,
    required: () => required,
    draw,
    settle,
    /** Changes the store and draws what that changed. */
    set: (fields) => act(async () => store.useApp.setState(fields)),
    /** The desktop's news of a scan, as sync.ts hears it. */
    status: (fields) =>
      act(async () =>
        deliver({
          payload: {
            type: "status",
            busy: false,
            revision: store.useApp.getState().revision,
            historyPending: false,
            ...fields,
          },
        }),
      ),
    /** The views a change drew again. */
    async redrawn(change) {
      const before = new Map(commits);
      await change();
      await settle();
      return [...commits]
        .filter(([name, count]) => count !== (before.get(name) ?? 0))
        .map(([name]) => name)
        .sort();
    },
    /** Runs every timer that waits, oldest first, and draws what they changed. */
    timers: () =>
      act(async () => {
        for (let due = timers.findIndex(Boolean); due >= 0; due = timers.findIndex(Boolean)) {
          const run = timers[due];
          timers[due] = null;
          run();
        }
      }),
    /** Every drawn element that passes `test`. */
    all: (test) => [...inside(container)].filter(test),
    /** The drawn buttons that say `text`. */
    buttons: (text) =>
      [...inside(container)].filter(
        (e) => e.localName === "button" && e.textContent.trim() === text,
      ),
    /** Runs one of an element's handlers, as a click or a key would, and returns the event. */
    async fire(element, handler, extra) {
      const event = eventOn(element, extra);
      await act(async () => props(element)[handler](event));
      return event;
    },
    /** What the shared action or hook `name` was called with: nodes by id, tasks by their text. */
    said: (name) =>
      calls
        .filter(([called]) => called === name)
        .map(([, ...args]) =>
          args.map((arg) => (arg?.tasks && arg.id ? arg.id : arg?.text && arg.line ? arg.text : arg)),
        ),
    releaseMarkdown: async () => {
      held.resolve(markdown);
      await settle();
    },
    close,
  };
  // The views stay getters, so that only those a test draws are compiled.
  return Object.defineProperties(app, Object.getOwnPropertyDescriptors(views));
}

// ── A status event ──────────────────────────────────────────────────────────────────────────────────

export async function aStatusEventDrawsNoDetailedViewAgain() {
  const app = await detailed();
  try {
    await app.set({ cwd: CLIENTS, selected: ACME, report: CHECKOUT });
    app.store.toggleExpanded("agents:storage");
    app.store.toggleExpanded("space:inactive");
    await app.draw({
      inspector: h(app.Shown),
      folder: h(app.Folder),
      tidy: h(app.Tidy),
      log: h(app.LogView),
      reports: h(app.ReportsView),
      agents: h(app.AgentsView),
      "start-agent": h(app.AgentDialog, { request: { kind: "agent", projectPath: ACME } }),
      session: h(app.SessionDialog, {
        request: {
          kind: "session",
          provider: "claude",
          sessionId: CHECKOUT_SESSION,
          file: CHECKOUT_LOG,
        },
      }),
      "delete-sessions": h(app.DeleteSessions, { files: [CHECKOUT_LOG] }),
    });
    // Every view is up, with what it asked for: the storage under Agents, the report and its items.
    for (const text of ["Laci's storage", "Open items", "Free 440 MB", "Changed settings"])
      assert.ok(app.container.textContent.includes(text), text);

    for (const tab of ["health", "todo", "agents", "readme"]) {
      await app.set({ tab });
      for (const busy of [true, false])
        assert.deepEqual(
          await app.redrawn(() => app.status({ busy })),
          [],
          `a scan that is ${busy ? "running" : "done"}, with the ${tab} tab open`,
        );
      assert.equal(app.state().busy, false, "the events reached the store");
    }
    // A newer scan's news, which moves the status on and nothing else.
    const next = app.state().revision + 1;
    assert.deepEqual(await app.redrawn(() => app.status({ busy: true, revision: next })), []);
    assert.equal(app.state().statusRevision, next);
    assert.equal(app.state().busy, true);

    // What a view shows still draws it again, and only it.
    assert.deepEqual(await app.redrawn(() => app.set({ tidyFilter: "space" })), ["tidy"]);
    assert.deepEqual(await app.redrawn(() => app.set({ logFilter: "moves" })), ["log"]);
    assert.deepEqual(await app.redrawn(() => app.set({ filter: "projects" })), ["folder"]);
    assert.deepEqual(
      await app.redrawn(() => app.set({ reportFilter: { project: ACME } })),
      ["reports"],
    );
    assert.deepEqual(
      await app.redrawn(() => app.set({ apps: { ...app.state().apps, editor: "zed" } })),
      ["inspector"],
    );
    // A changed project is news to every view.
    const acme = app.state().snapshot.nodes[ACME];
    assert.deepEqual(
      await app.redrawn(() => act(async () => app.state().patch({ ...acme, notes: "New" }))),
      [
        "agents",
        "delete-sessions",
        "folder",
        "inspector",
        "log",
        "reports",
        "session",
        "start-agent",
        "tidy",
      ],
    );
  } finally {
    await app.close();
  }
}

export async function aFolderRowDrawsAgainOnlyWhenItsOwnSelectionChanges() {
  const app = await detailed();
  try {
    await app.set({ cwd: CLIENTS });
    await app.draw({ folder: h(app.Folder) });
    const row = (name) =>
      app.all((e) => e.getAttribute("role") === "row" && e.textContent.includes(name))[0];
    const selected = (name) => props(row(name))["aria-selected"];
    assert.deepEqual([selected("acme-store"), selected("kopi-landing")], [false, false]);
    // Choosing a project draws its row again, and neither the folder nor the other row.
    let before = app.draws();
    await app.fire(row("acme-store"), "onClick");
    assert.equal(app.state().selected, ACME);
    assert.equal(app.draws() - before, 1);
    assert.deepEqual([selected("acme-store"), selected("kopi-landing")], [true, false]);
    // Choosing the other one draws the two rows whose selection changed.
    before = app.draws();
    await app.fire(row("kopi-landing"), "onClick");
    assert.equal(app.draws() - before, 2);
    assert.deepEqual([selected("acme-store"), selected("kopi-landing")], [false, true]);
  } finally {
    await app.close();
  }
}

// ── The shared actions and hooks ────────────────────────────────────────────────────────────────────

export async function theDetailsPanelChangesAProjectThroughTheSharedActions() {
  const app = await detailed();
  try {
    await app.set({ selected: ACME, tab: "health" });
    await app.draw({ inspector: h(app.Shown) });
    assert.ok(app.said("useHealth").length, "its health comes from hooks.ts");
    assert.ok(app.said("useHealth").every(([id]) => id === ACME));
    assert.deepEqual(app.asked("health"), [{ id: ACME }]);

    // Mute, and the project as the reply has it asks for its health again.
    await app.fire(app.buttons("Mute")[0], "onClick");
    assert.deepEqual(app.said("muteCheck"), [[ACME, "dirty", true]]);
    assert.deepEqual(app.asked("meta"), [{ id: ACME, key: "quiet", value: "dirty" }]);
    assert.equal(app.asked("health").length, 2);

    // Its fields.
    await act(async () => app.selects.get("Priority").onValueChange("low"));
    await act(async () => app.selects.get("Status").onValueChange(""));
    const date = app.all((e) => e.localName === "input" && e.type === "date")[0];
    await app.fire(date, "onChange", { target: { value: "2026-10-20" } });
    const clear = app.all((e) => e.getAttribute("aria-label") === "Clear deadline")[0];
    await app.fire(clear, "onClick");
    assert.deepEqual(app.said("setMeta"), [
      [ACME, "priority", "low"],
      [ACME, "status", ""],
      [ACME, "deadline", "2026-10-20"],
      [ACME, "deadline", ""],
    ]);

    // Its to-dos.
    await app.set({ tab: "todo" });
    const box = app.all((e) => e.localName === "input" && e.type === "checkbox")[0];
    await app.fire(box, "onChange", { target: { checked: true } });
    assert.deepEqual(app.said("toggleTodo"), [[ACME, "Fix checkout total on mobile Safari", true]]);
    await app.fire(app.all((e) => e.getAttribute("aria-label") === "Delete")[1], "onClick");
    assert.deepEqual(app.said("deleteTodo"), [[ACME, "Send staging link to the client"]]);
    const add = () => app.all((e) => e.getAttribute("aria-label") === "New to-do")[0];
    await app.fire(add(), "onChange", { target: { value: "  Write the tests  " } });
    await app.fire(app.all((e) => e.localName === "form")[0], "onSubmit");
    await app.settle();
    assert.deepEqual(app.said("addTodo"), [[ACME, "  Write the tests  "]]);
    assert.deepEqual(app.asked("todo").at(-1), { id: ACME, op: "add", text: "Write the tests" });
    assert.equal(props(add()).value, "", "an added to-do leaves the box empty");

    // Its notes, saved 600 ms after the last key.
    assert.ok(app.said("useNotesDraft").length, "its notes come from hooks.ts");
    assert.ok(app.said("useNotesDraft").every(([id]) => id === ACME));
    const notes = () => app.all((e) => e.localName === "textarea")[0];
    await app.fire(notes(), "onChange", { target: { value: "Launch moved to Friday." } });
    assert.ok(app.container.textContent.includes("Editing…"));
    assert.deepEqual(app.asked("notes"), []);
    await app.timers();
    await app.settle();
    assert.deepEqual(app.asked("notes"), [{ id: ACME, text: "Launch moved to Friday." }]);
    assert.ok(app.container.textContent.includes("Saved"));
    assert.equal(props(notes()).value, "Launch moved to Friday.");
  } finally {
    await app.close();
  }
}

export async function tidyUpAndTheLogChangeThingsThroughTheSharedActions() {
  const app = await detailed({
    edit: (scan) => {
      scan.dismissed = [{ id: "duplicate:old", title: "Two copies of dotfiles" }];
    },
  });
  try {
    app.store.toggleExpanded("space:inactive");
    app.store.toggleExpanded("dismissed");
    await app.draw({ tidy: h(app.Tidy), log: h(app.LogView) });
    const space = app.state().snapshot.proposals.find((p) => p.id === "space:inactive");
    await app.fire(app.buttons("Apply 1 change")[0], "onClick");
    assert.deepEqual(app.said("applyProposal"), [[space]]);
    assert.deepEqual(app.asked("apply"), [{ id: "space:inactive" }]);
    await app.fire(app.buttons("Dismiss")[0], "onClick");
    await app.fire(app.buttons("Suggest again")[0], "onClick");
    assert.deepEqual(app.said("dismissProposal"), [["space:inactive"], ["duplicate:old", true]]);

    const [entry] = fixtures.log.entries;
    const undo = await app.fire(app.buttons("Undo")[0], "onClick");
    assert.ok(undo.propagationStopped, "Undo doesn't open the entry as well");
    assert.deepEqual(app.said("undoLogEntry"), [[entry.id]]);
    assert.deepEqual(app.asked("log/undo"), [{ id: entry.id }]);
  } finally {
    await app.close();
  }
}

// ── Markdown, when it is drawn ──────────────────────────────────────────────────────────────────────

export async function markdownLoadsWhenDrawnAndItsRawTextNeverShows() {
  const app = await detailed({ holdMarkdown: true });
  try {
    // The two views that draw Markdown load without it.
    assert.ok(app.Inspector && app.ReportsView);
    assert.equal(app.required(), 0, "inspector.tsx and views/reports.tsx load without readme.ts");
    await app.set({ selected: ACME, tab: "readme", report: CHECKOUT });
    await app.draw({ inspector: h(app.Shown), reports: h(app.ReportsView) });
    assert.ok(app.required() > 0, "a README on screen asks for it");
    assert.deepEqual(app.asked("reports/read"), [{ id: CHECKOUT }]);

    // The texts are in, and what draws them is not: neither shows.
    const readme = () => app.all((e) => e.getAttribute("class") === "readme")[0];
    const report = () => app.all((e) => e.getAttribute("class") === "readme rp-body")[0];
    assert.equal(readme().innerHTML, "");
    assert.equal(report(), undefined);
    const text = app.container.textContent;
    assert.ok(text.includes("Reading the report…"));
    // Lines of the README and of the report that nothing else on screen says.
    for (const raw of [
      "## Setup",
      "pnpm install",
      "## What was done",
      "Production still rounds per line",
    ])
      assert.ok(!text.includes(raw), `no raw text: ${raw}`);

    await app.releaseMarkdown();
    assert.equal(readme().innerHTML, DRAWN);
    assert.equal(report().innerHTML, DRAWN);
    assert.ok(!app.container.textContent.includes("Reading the report…"));

    // A README drawn later has it at once, in its first draw.
    await app.set({ selected: null });
    await act(() => app.store.useApp.setState({ selected: ACME }));
    assert.equal(readme().innerHTML, DRAWN);
  } finally {
    await app.close();
  }
}

export async function theDetailsPanelLoadsMarkdownAheadForAProjectWithAReadme() {
  const app = await detailed({ holdMarkdown: true });
  try {
    await app.set({ selected: ACME, tab: "health" });
    await app.draw({ inspector: h(app.Shown) });
    assert.ok(app.required() > 0, "asked for while the health tab shows");
    await app.releaseMarkdown();
    await act(() => app.store.useApp.setState({ tab: "readme" }));
    const readme = app.all((e) => e.getAttribute("class") === "readme")[0];
    assert.equal(readme.innerHTML, DRAWN, "the README tab draws it at once");
  } finally {
    await app.close();
  }
}
