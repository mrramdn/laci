// Detailed's Archive view (ui/src/views/archive.tsx): the projects in the archive say where they came
// from, and why they can't go back there by themselves when the engine says so; the projects only
// marked archived are listed apart, at their own place. Drawn to HTML on a server, for scans made here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";

const { createElement: h } = requireUi("react");
const { renderToStaticMarkup } = requireUi("react-dom/server");
const { detailedArchive: words, unlinkStep } = load("words.ts");
const HOME = "/home/demo";
const none = () => null;

/** An archived project: in the archive, unless `place` says it stayed where it is. */
const project = (name, more = {}) => ({
  id: `${HOME}/project/_archive/${name}`,
  path: `${HOME}/project/_archive/${name}`,
  kind: "project",
  name,
  label: name,
  archived: true,
  inArchive: true,
  meta: { status: "archived", archivedAt: "2026-08-14" },
  size: { total: 4096, reclaimable: 0, parts: [] },
  ...more,
});
const cant = (reason, dest) => ({
  error: `The engine's own words for ${reason}`,
  reason,
  ...(dest ? { dest } : {}),
  ops: [],
  checks: [],
});

/** The Archive view drawn for a scan of `nodes`. */
function draw(nodes) {
  const state = {
    snapshot: { home: HOME, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) },
    selected: null,
    historyPending: false,
  };
  const useApp = Object.assign((select) => (select ? select(state) : state), {
    getState: () => ({ ...state, select: none }),
    setState: none,
  });
  const { ArchiveView } = load("views/archive.tsx", {
    "../store": { useApp, external: none },
    "../api": { api: () => new Promise(none) },
    "../common": {
      Icon: none,
      Group: ({ title, hint, children }) =>
        h("section", { "data-title": title, "data-hint": hint }, children),
    },
  });
  return renderToStaticMarkup(h(ArchiveView));
}
/** The words of each row, by project name. */
function rows(html) {
  const found = {};
  for (const [, name, from] of html.matchAll(
    /<span class="name">([^<]+)<\/span><span class="d mono"[^>]*>([^<]*)<\/span>/g,
  ))
    found[name] = from;
  return found;
}

export function archiveRowsSayWhereEachProjectCameFromAndWhyItCantGoBack() {
  const html = draw([
    project("old-portfolio", {
      restorePlan: { dest: `${HOME}/project/old-portfolio`, ops: [], checks: [] },
    }),
    project("notes", { restorePlan: cant("occupied", `${HOME}/project/notes`) }),
    project("mystery", { restorePlan: cant("unknown") }),
    project("zine", {
      id: `${HOME}/project/side/zine`,
      path: `${HOME}/project/side/zine`,
      inArchive: false,
      meta: { status: "archived" },
      restorePlan: { dest: `${HOME}/project/side/zine`, ops: [], checks: [] },
    }),
  ]);
  assert.deepEqual(rows(html), {
    "old-portfolio": words.from("~/project/old-portfolio"),
    notes: `${words.from("~/project/notes")} · ${words.why.occupied}`,
    mystery: words.unknown,
    // Only marked archived: its own place, under a group of its own, with no Restore.
    zine: "~/project/side/zine",
  });
  assert.equal(rows(html).notes, "From ~/project/notes · something is there now");
  assert.match(html, /data-title="In the archive"/);
  assert.match(html, /data-title="Marked archived, still in place"/);
  // "Origin unknown" is for the project Laci knows no origin of, and only for it.
  assert.equal(html.split(`>${words.unknown}<`).length - 1, 1);
  assert.match(html, /with its agent history/);
  assert.doesNotMatch(html, /AI history/);
}

/** An archived group: a folder in the archive whose own .laci.md says archived, with a restore plan. */
const group = (name, more = {}) => ({
  id: `${HOME}/project/_archive/${name}`,
  path: `${HOME}/project/_archive/${name}`,
  kind: "folder",
  name,
  label: name,
  children: [],
  archived: true,
  inArchive: true,
  meta: { status: "archived", archivedAt: "2026-08-29", archivedFrom: `~/project/${name}` },
  restorePlan: {
    dest: `${HOME}/project/${name}`,
    ops: [
      {
        kind: "unlink",
        label: "Remove the old link",
        from: `~/project/${name}`,
        to: `~/project/_archive/${name}`,
      },
    ],
    checks: [],
  },
  ...more,
});
/** A project in the archived group `of`. */
const member = (of, name, plan) =>
  project(`${of.name}/${name}`, {
    name,
    label: name,
    parent: of.id,
    meta: { status: "archived" },
    restorePlan: plan,
  });
/** Every row of the Archive, in order: its id, its classes, and what it says beside the name. */
function rowsInOrder(html) {
  return [
    ...html.matchAll(
      /<div class="([^"]+)" tabindex="0" data-id="([^"]+)" data-kind="(\w+)"[^>]*><span class="name">([^<]+)<\/span><span class="d[^"]*"[^>]*>([^<]*)<\/span>/g,
    ),
  ].map(([, classes, id, kind, name, said]) => ({ classes, id, kind, name, said }));
}

export function anArchivedGroupIsARowWithWhatItHoldsUnderIt() {
  const clients = group("old-clients");
  const linked = (name) =>
    cant("linked", `${HOME}/project/old-clients/${name}`);
  const html = draw([
    project("old-portfolio", {
      restorePlan: { dest: `${HOME}/project/old-portfolio`, ops: [], checks: [] },
    }),
    member(clients, "warung-pos", linked("warung-pos")),
    member(clients, "batik-shop", linked("batik-shop")),
    clients,
  ]);
  // Newest first: the group, archived last, then what it holds by name, then old-portfolio.
  assert.deepEqual(
    rowsInOrder(html).map(({ classes, kind, name, said }) => [classes, kind, name, said]),
    [
      ["item", "group", "old-clients", words.from("~/project/old-clients")],
      ["item in-group", "project", "batik-shop", words.inside("old-clients")],
      ["item in-group", "project", "warung-pos", words.inside("old-clients")],
      ["item", "project", "old-portfolio", words.from("~/project/old-portfolio")],
    ],
  );
  assert.equal(words.inside("old-clients"), "Inside old-clients · restore the group");
  // The group says how many projects it holds, and has Restore and Open folder.
  assert.equal(words.group(2), "Group of 2 projects");
  const row = html.slice(html.indexOf('data-kind="group"'), html.indexOf('data-id="' + `${clients.id}/batik-shop`));
  assert.match(row, />Group of 2 projects</);
  assert.match(row, />Restore<\/button>/);
  assert.match(row, />Open folder<\/button>/);
  // Each project in it offers the group instead of a Restore of its own, which the engine refuses.
  assert.equal(html.split(`>${words.restoreGroup}</button>`).length - 1, 2);
  assert.equal(html.split(`title="${words.restoreGroupFor("old-clients")}"`).length - 1, 2);
  assert.equal(html.split(">Restore</button>").length - 1, 2, "the group's and old-portfolio's");
  // The view counts projects; the rows count the group too.
  assert.match(html, />3 projects</);
}

export function aLinkedProjectWithNoArchivedGroupSaysWhyAndKeepsItsRestore() {
  // Its folder isn't marked archived, so there is no group to put back: the row says the link.
  const html = draw([
    project("plain/batik-shop", {
      name: "batik-shop",
      label: "batik-shop",
      parent: `${HOME}/project/_archive/plain`,
      restorePlan: cant("linked", `${HOME}/project/plain/batik-shop`),
    }),
  ]);
  assert.deepEqual(rows(html), {
    "batik-shop": `${words.from("~/project/plain/batik-shop")} · ${words.why.linked}`,
  });
  assert.match(html, />Restore<\/button>/);
  assert.doesNotMatch(html, new RegExp(words.restoreGroup));
}

export function theUnlinkStepHasItsIconAndTheEnginesWordsInBothDesigns() {
  const op = {
    kind: "unlink",
    label: unlinkStep.done,
    from: "~/project/old-clients",
    to: "~/project/_archive/old-clients",
  };
  assert.equal(unlinkStep.plan, "Remove the old link");
  assert.equal(unlinkStep.done, "Removed the old link");
  // The icon is in the set both designs draw from.
  const icons = readFileSync(new URL("../../ui/public/icons.svg", import.meta.url), "utf8");
  assert.match(icons, /id="unlink"/);
  // Detailed's Log and dialogs draw steps with Ops, named by their kind.
  const { Ops } = load("common.tsx", {
    "./api": { api: none, errorText: String },
    "./store": { useApp: none, changed: none, run: none, toggleExpanded: none },
    "./clock": { useNow: () => 0 },
    "./terminal-api": { openTerminal: none },
    "./dialogs": { DialogFrame: none },
  });
  const detailed = renderToStaticMarkup(h(Ops, { ops: [op] }));
  assert.match(detailed, /class="k-unlink"/);
  assert.match(detailed, /icons\.svg#unlink/);
  assert.match(detailed, />Removed the old link</);
  assert.match(detailed, /~\/project\/old-clients<span class="arr">→<\/span>~\/project\/_archive\/old-clients/);
  // Simple's Activity draws them with Steps.
  const { Steps } = load("simple/steps.tsx", {
    "../common": { Icon: ({ name }) => h("i", { "data-icon": name }) },
  });
  const simple = renderToStaticMarkup(h(Steps, { ops: [op] }));
  assert.match(simple, /data-icon="unlink"/);
  assert.match(simple, />Removed the old link</);
  assert.match(simple, />~\/project\/old-clients → ~\/project\/_archive\/old-clients</);
}

export function detailedsRestoreDialogNamesTheGroup() {
  const clients = group("old-clients");
  const state = {
    design: "detailed",
    modal: { kind: "restore", id: clients.id },
    snapshot: { home: HOME, nodes: { [clients.id]: clients }, proposals: [] },
    historyPending: false,
    working: "",
    palette: false,
  };
  const useApp = Object.assign((select) => (select ? select(state) : state), {
    getState: () => state,
    setState: none,
  });
  const { Dialogs } = load(
    "dialogs.tsx",
    {
      "./api": { api: () => new Promise(none), errorText: String },
      "./store": { useApp, changed: none, run: none, selectWhenReady: none },
      "./common": { Icon: none, Ops: none, restoreFocus: none, SeverityGlyph: none },
      "./terminal-api": { closeTerminal: none, useTerms: () => undefined },
      "./session-ui": { AgentDialog: none, DeleteSessions: none, SessionDialog: none },
      "./mcp-setup": { McpDialog: none },
      "./select": {
        Select: none,
        SelectPortal: requireUi("react").createContext(null),
        selectIsOpen: () => false,
      },
      "./settings": { useConfigPath: () => "~/.config/laci/config.json" },
    },
    {
      document: { documentElement: { dataset: {} }, activeElement: null },
      HTMLElement: class {},
    },
  );
  const html = renderToStaticMarkup(h(Dialogs));
  assert.match(html, /Restore the group old-clients\?/);
  assert.equal(words.restoreGroupTitle("old-clients"), "Restore the group old-clients?");
  assert.match(html, />~\/project\/old-clients<\/span> with every project in it and their agent history\. Undo is in the Log\./);
}

export function aPlaceThatCantBeUsedStillShowsTheOrigin() {
  const html = draw([
    project("inside", { restorePlan: cant("inArchive", `${HOME}/project/_archive/inside`) }),
    project("away", { restorePlan: cant("outside", "/srv/away") }),
    // An engine that doesn't say why: the origin, and that it can't go back there.
    project("quiet", {
      restorePlan: { error: "No", dest: `${HOME}/project/quiet`, ops: [], checks: [] },
    }),
  ]);
  assert.deepEqual(rows(html), {
    inside: `${words.from("~/project/_archive/inside")} · ${words.why.inArchive}`,
    away: `${words.from("/srv/away")} · ${words.why.outside}`,
    quiet: `${words.from("~/project/quiet")} · ${words.cant}`,
  });
}
