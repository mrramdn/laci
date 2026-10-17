// The words that depend on the system: a Trash or a Recycle Bin in the dialogs, the keys in the list of
// shortcuts, and where config.json is. The dialogs are drawn to text for each system; on Linux
// and macOS they say what they said before.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";

const React = requireUi("react");
const { renderToStaticMarkup } = requireUi("react-dom/server");
const noop = () => {};
const none = () => null;
const SYSTEMS = ["linux", "windows", "macos"];

/** What a person reads in drawn HTML: no tags, and the characters React wrote as entities. */
const plain = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** A store that React can read on a server: a function that also has getState, over what `read` gives. */
function storeOf(read) {
  const useApp = (select) => (select ? select(read()) : read());
  return Object.assign(useApp, {
    getState: read,
    setState: (change) =>
      Object.assign(
        read(),
        typeof change === "function" ? change(read()) : change,
      ),
  });
}

/** What a snapshot needs for the dialogs, with a project and a piece of orphan history. */
function snapshotOf(system) {
  const windows = system === "windows";
  const home = windows ? "C:\\Users\\me" : "/home/me";
  const project = windows
    ? "C:\\Users\\me\\project\\acme"
    : "/home/me/project/acme";
  return {
    home,
    nodes: {
      [project]: {
        id: project,
        path: project,
        name: "acme",
        label: "acme",
        kind: "project",
        size: {
          total: 6e8,
          reclaimable: 5e8,
          parts: [{ path: "node_modules", bytes: 5e8 }],
        },
      },
    },
    proposals: [
      {
        id: "orphan-1",
        why: "No project has this history any more.",
        action: { type: "quarantine", moves: [{ from: `${home}/.claude/x` }] },
      },
    ],
    suggestions: [],
    connectors: [],
  };
}
const projectOf = (snapshot) => Object.keys(snapshot.nodes)[0];

/** The state of the page being drawn. The modules read it, so each loads once for each system. */
let current;
const modules = new Map();
function dialogsOf(system) {
  if (!modules.has(system))
    modules.set(
      system,
      load(
        "dialogs.tsx",
        {
          "./api": { api: async () => ({}), errorText: String },
          "./store": {
            useApp: storeOf(() => current),
            changed: noop,
            run: noop,
            selectWhenReady: noop,
            acknowledge: noop,
            copyText: noop,
            rescan: noop,
          },
          "./common": {
            Icon: none,
            Ops: none,
            restoreFocus: noop,
            SeverityGlyph: none,
          },
          "./terminal-api": {
            closeTerminal: noop,
            toggleTerminal: noop,
            useTerms: storeOf(() => ({ tabs: [] })),
          },
          "./session-ui": {
            AgentDialog: none,
            DeleteSessions: none,
            SessionDialog: none,
          },
          "./mcp-setup": { McpDialog: none },
          "./select": {
            Select: none,
            SelectPortal: React.createContext(null),
            selectIsOpen: () => false,
          },
          "./clock": { useNow: noop },
          "./brand": { LaciMark: none },
        },
        {
          document: {
            documentElement: { dataset: { os: system } },
            activeElement: null,
          },
          HTMLElement: class {},
        },
      ),
    );
  return modules.get(system);
}

/** The dialog `modal` opens on a system, as HTML. */
function render(system, modal) {
  current = {
    modal,
    snapshot: snapshotOf(system),
    historyPending: false,
    working: "",
    palette: false,
  };
  return renderToStaticMarkup(React.createElement(dialogsOf(system).Dialogs));
}
const drawn = (system, modal) => plain(render(system, modal));
const deleting = (system) =>
  drawn(system, { kind: "delete", id: projectOf(snapshotOf(system)) });

export async function deletingAProjectNamesTheTrashOnLinuxAndMac() {
  for (const system of ["linux", "macos"]) {
    const text = deleting(system);
    assert.match(text, /Move acme to Trash\?/, system);
    assert.match(
      text,
      /Moves ~\/project\/acme to the system Trash after checking its Git backup\. Agent history stored outside this project stays where it is\./,
      system,
    );
    assert.match(
      text,
      /Restore the folder from your system Trash if you need it back\./,
      system,
    );
    assert.match(text, /Cancel Move to Trash$/, system);
    assert.doesNotMatch(text, /Recycle/, system);
  }
}

export async function deletingAProjectNamesTheRecycleBinOnWindows() {
  const text = deleting("windows");
  assert.match(text, /Move acme to Recycle Bin\?/);
  assert.match(
    text,
    /Moves ~\\project\\acme to the Recycle Bin after checking its Git backup\. Agent history stored outside this project stays where it is\./,
  );
  assert.match(
    text,
    /Restore the folder from the Recycle Bin if you need it back\./,
  );
  assert.match(text, /Cancel Move to Recycle Bin$/);
  assert.doesNotMatch(text, /Trash/);
}

export async function cleaningBuildOutputSaysWhereItDoesNotGo() {
  for (const system of SYSTEMS) {
    const text = drawn(system, {
      kind: "clean",
      id: projectOf(snapshotOf(system)),
    });
    const bin = system === "windows" ? "Recycle Bin" : "Trash";
    assert.match(
      text,
      new RegExp(
        `They don't go to the ${bin}, which would keep the space taken\\.`,
      ),
      system,
    );
    assert.match(text, /Delete the build output of acme\?/, system);
  }
}

export async function orphanHistoryOffersTheSystemsBinForRestoringByHand() {
  const orphan = { kind: "orphan", id: "orphan-1" };
  for (const system of ["linux", "macos"]) {
    const text = drawn(system, orphan);
    assert.match(
      text,
      /System Trash Restore manually through your system Trash\./,
      system,
    );
    assert.match(text, /Quarantine history$/, system);
  }
  const text = drawn("windows", orphan);
  assert.match(text, /Recycle Bin Restore manually through the Recycle Bin\./);
  assert.doesNotMatch(text, /Trash/);
}

export async function theShortcutsDialogListsTheKeysOfTheSystem() {
  const rows = (system) =>
    [
      ...render(system, { kind: "shortcuts" }).matchAll(
        /<div class="short-row"><span>([^<]*)<\/span><div class="short-keys">(.*?)<\/div><\/div>/g,
      ),
    ].map(([, label, keys]) => [
      label,
      [...keys.matchAll(/<kbd>([^<]*)<\/kbd>/g)].map((key) => key[1]),
    ]);
  const linux = rows("linux");
  assert.deepEqual(rows("windows"), linux);
  assert.deepEqual(linux, [
    ["Command palette", ["Ctrl", "K"]],
    ["Next / Prev row", ["↓", "↑"]],
    ["Open / Select", ["↵"]],
    ["Parent folder", ["⌫"]],
    ["Next / Prev pane", ["F6", "Shift F6"]],
    ["Close / Dismiss", ["Esc"]],
    ["Toggle terminal", ["F4", "Ctrl `"]],
    ["Toggle hidden files", ["Ctrl", "H"]],
    ["Shortcuts help", ["?"]],
  ]);
  const mac = Object.fromEntries(rows("macos"));
  assert.deepEqual(mac["Command palette"], ["⌘", "K"]);
  assert.deepEqual(mac["Parent folder"], ["⌫", "⌘ ↑"]);
  assert.deepEqual(mac["Toggle hidden files"], ["⌘", "⇧", "."]);
  assert.deepEqual(mac["Settings"], ["⌘", ","]);
}

// ── Where config.json is ───────────────────────────────────────────────────────────────────────────

export async function theConnectorDialogSaysWhereItSavesOnEachSystem() {
  const usual = {
    linux: "~/.config/laci/config.json",
    macos: "~/.config/laci/config.json",
    windows: "~\\AppData\\Local\\io.github.mrramdn.laci\\config.json",
  };
  for (const system of SYSTEMS)
    assert.match(
      drawn(system, { kind: "connector" }),
      new RegExp(`Saved in ${usual[system].replace(/[\\.]/g, "\\$&")} `),
      system,
    );
}

/** settings.tsx whose React is a stand-in that runs one component's hooks: a state cell, and effects that run when declared. */
function configPathHook(system, reply) {
  let cells = [];
  let at = 0;
  const requests = [];
  const react = {
    useState(initial) {
      const cell = at++;
      if (!(cell in cells)) cells[cell] = initial;
      return [cells[cell], (value) => void (cells[cell] = value)];
    },
    useEffect(effect, deps) {
      const cell = at++;
      const last = cells[cell];
      if (last && deps && deps.every((dep, i) => dep === last.deps[i])) return;
      last?.cleanup?.();
      cells[cell] = { deps, cleanup: effect() };
    },
  };
  const { useConfigPath } = load(
    "settings.tsx",
    {
      react,
      "./api": {
        api: async (name) => {
          requests.push(name);
          return reply();
        },
        errorText: String,
      },
      "./store": { useApp: noop },
      "./select": { Select: none },
      "./brand": { LaciMark: none },
      "./common": { Icon: none },
      "./clock": { useNow: noop },
    },
    { document: { documentElement: { dataset: { os: system } } } },
  );
  return {
    requests,
    /** Runs the component again: what a render returns. */
    render() {
      at = 0;
      return useConfigPath();
    },
    /** A component that mounts later, on the same page. */
    remount() {
      cells = [];
    },
  };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function theConfigPathIsTheUsualOneUntilTheDesktopSays() {
  for (const system of SYSTEMS) {
    const hook = configPathHook(system, async () => ({
      configPath: "~/work/laci-home/config.json",
    }));
    const usual = hook.render();
    assert.match(
      usual,
      system === "windows"
        ? /^~\\AppData\\Local\\/
        : /^~\/\.config\/laci\/config\.json$/,
      system,
    );
    await settled();
    assert.equal(hook.render(), "~/work/laci-home/config.json", system);
    // It asked once, and a later screen of the same page asks nothing.
    hook.remount();
    assert.equal(hook.render(), "~/work/laci-home/config.json", system);
    await settled();
    assert.deepEqual(hook.requests, ["prefs"], system);
  }
}

export async function aRefusedAnswerLeavesTheUsualPath() {
  const hook = configPathHook("linux", async () => {
    throw new Error("config.json can't be read");
  });
  assert.equal(hook.render(), "~/.config/laci/config.json");
  await settled();
  assert.equal(hook.render(), "~/.config/laci/config.json");
  assert.deepEqual(hook.requests, ["prefs"]);
}
