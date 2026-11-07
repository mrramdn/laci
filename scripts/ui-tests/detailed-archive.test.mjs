// Detailed's Archive view (ui/src/views/archive.tsx): the projects in the archive say where they came
// from, and why they can't go back there by themselves when the engine says so; the projects only
// marked archived are listed apart, at their own place. Drawn to HTML on a server, for scans made here.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";

const { createElement: h } = requireUi("react");
const { renderToStaticMarkup } = requireUi("react-dom/server");
const words = load("words.ts").detailedArchive;
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
