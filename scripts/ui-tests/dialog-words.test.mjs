// The words in Detailed's dialogs that name a place on this computer: the Trash, the keys in the list
// of shortcuts, and where config.json is. The dialogs are drawn to text.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";

const React = requireUi("react");
const { renderToStaticMarkup } = requireUi("react-dom/server");
const noop = () => {};
const none = () => null;

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
function snapshotOf() {
  const home = "/home/me";
  const project = "/home/me/project/acme";
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

/** The state of the page being drawn. The module reads it, so it loads once. */
let current;
let module;
function dialogsOf() {
  module ??= load(
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
          document: { documentElement: { dataset: {} }, activeElement: null },
          HTMLElement: class {},
        },
      );
  return module;
}

/** The dialog `modal` opens, as HTML. */
function render(modal) {
  current = {
    modal,
    snapshot: snapshotOf(),
    historyPending: false,
    working: "",
    palette: false,
  };
  return renderToStaticMarkup(React.createElement(dialogsOf().Dialogs));
}
const drawn = (modal) => plain(render(modal));

export async function deletingAProjectNamesTheTrash() {
  const text = drawn({ kind: "delete", id: projectOf(snapshotOf()) });
  assert.match(text, /Move acme to Trash\?/);
  assert.match(
    text,
    /Moves ~\/project\/acme to the system Trash after checking its Git backup\. Agent history stored outside this project stays where it is\./,
  );
  assert.match(text, /Restore the folder from your system Trash if you need it back\./);
  assert.match(text, /Cancel Move to Trash$/);
}

export async function cleaningBuildOutputSaysWhereItDoesNotGo() {
  const text = drawn({ kind: "clean", id: projectOf(snapshotOf()) });
  assert.match(text, /They don't go to the Trash, which would keep the space taken\./);
  assert.match(text, /Delete the build output of acme\?/);
}

export async function orphanHistoryOffersTheTrashForRestoringByHand() {
  const text = drawn({ kind: "orphan", id: "orphan-1" });
  assert.match(text, /System Trash Restore manually through your system Trash\./);
  assert.match(text, /Quarantine history$/);
}

export async function theShortcutsDialogListsTheKeys() {
  const rows = () =>
    [
      ...render({ kind: "shortcuts" }).matchAll(
        /<div class="short-row"><span>([^<]*)<\/span><div class="short-keys">(.*?)<\/div><\/div>/g,
      ),
    ].map(([, label, keys]) => [
      label,
      [...keys.matchAll(/<kbd>([^<]*)<\/kbd>/g)].map((key) => key[1]),
    ]);
  assert.deepEqual(rows(), [
    ["Command palette", ["Ctrl", "K"]],
    ["Next / Prev row", ["↓", "↑"]],
    ["Open / Select", ["↵"]],
    ["Parent folder", ["⌫"]],
    ["Next / Prev pane", ["F6", "Shift F6"]],
    ["Close / Dismiss", ["Esc"]],
    ["Toggle terminal", ["F4", "Ctrl `"]],
    ["Toggle hidden files", ["Ctrl", "H"]],
    ["Shortcuts help", ["?", "Ctrl /"]],
  ]);
}

// ── Where config.json is ───────────────────────────────────────────────────────────────────────────

export async function theConnectorDialogSaysWhereItSaves() {
  assert.match(drawn({ kind: "connector" }), /Saved in ~\/\.config\/laci\/config\.json /);
}

/** settings.tsx whose React is a stand-in that runs one component's hooks: a state cell, and effects that run when declared. */
function configPathHook(reply) {
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
    { document: { documentElement: { dataset: {} } } },
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
  const hook = configPathHook(async () => ({
    configPath: "~/work/laci-home/config.json",
  }));
  assert.equal(hook.render(), "~/.config/laci/config.json");
  await settled();
  assert.equal(hook.render(), "~/work/laci-home/config.json");
  // It asked once, and a later screen of the same page asks nothing.
  hook.remount();
  assert.equal(hook.render(), "~/work/laci-home/config.json");
  await settled();
  assert.deepEqual(hook.requests, ["prefs"]);
}

export async function aRefusedAnswerLeavesTheUsualPath() {
  const hook = configPathHook(async () => {
    throw new Error("config.json can't be read");
  });
  assert.equal(hook.render(), "~/.config/laci/config.json");
  await settled();
  assert.equal(hook.render(), "~/.config/laci/config.json");
  assert.deepEqual(hook.requests, ["prefs"]);
}
