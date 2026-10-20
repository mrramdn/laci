// A project's Recent changes (ui/src/simple/ProjectPage.tsx) tell a change Laci 3.0 recorded from
// the parts the engine writes with it ("say"), with Activity's sentence for its form, and an older
// change from its title as before.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";
import { heldDate, simpleBlocks, standIn } from "./react-stand-in.mjs";

const { createElement, Fragment } = requireUi("react");
const nothing = () => null;
const NOW = new Date(2026, 9, 8, 15).toISOString();
const words = load("words.ts", {}, { Date: heldDate(NOW) });
const KOPI = "/home/demo/project/clients/kopi-landing";

/** What the engine logged, as the `log` reply has it. */
const entry = (id, minutes, more) => ({
  id,
  at: new Date(Date.parse(NOW) - minutes * 60_000).toISOString(),
  by: "app",
  state: "applied",
  canUndo: false,
  superseded: false,
  path: KOPI,
  ...more,
});

// The project's page, compiled once: its hooks ask the stand-in the test draws on.
const now = { page: null, app: null };
const react = { Fragment };
for (const hook of ["useState", "useRef", "useId", "useMemo", "useCallback", "useEffect", "useLayoutEffect"])
  react[hook] = (...args) => now.page.react[hook](...args);
const appNow = Object.assign((select) => now.app(select), {
  getState: () => now.app.getState(),
  setState: (change) => now.app.setState(change),
});
const projectPage = load(
  "simple/ProjectPage.tsx",
  {
    react,
    "../words": words,
    "../actions": { undoLogEntry: nothing },
    "../agent-launch": {},
    "../api": {},
    "../clock": { useNow: () => Date.parse(NOW) },
    "../common": { Icon: nothing },
    "../hooks": {},
    "../session-ui": {},
    "../store": { refreshLog: nothing, run: nothing, useApp: appNow, changed: nothing },
    "../terminal-api": {},
    "./act": {},
    "./fix": {},
    "./cleanup-activity.css": {},
    "./ui": simpleBlocks({
      Card: ({ title, children, footer }) => createElement("section", null, title, children, footer),
    }),
  },
  { Date: heldDate(NOW), document: {} },
);

/** The sentences of the project's Recent changes card, newest first. */
function recent(entries) {
  const page = standIn();
  Object.assign(now, { page, app: page.store({ activity: { entries }, historyPending: false }) });
  page.mount(createElement(projectPage.RecentCard, { n: { id: KOPI, path: KOPI } }));
  return page.all((n) => n.type === "li").map((li) => li.descendants().find((n) => n.type === "span").textContent);
}

export async function aProjectsRecentChangesAreToldFromThePartsTheEngineRecorded() {
  assert.deepEqual(
    recent([
      entry("u1", 5, { title: "Undid: Archive kopi-landing", undoes: "e4", say: { form: "undid" } }),
      entry("e5", 10, {
        title: "Added a next step to kopi-landing",
        say: { form: "addedStep", name: "kopi-landing" },
      }),
      entry("e4", 20, {
        title: "Archive kopi-landing",
        journal: "j4",
        state: "undone",
        say: { form: "archived", name: "kopi-landing" },
      }),
      entry("e3", 30, {
        title: "Client of kopi-landing set to Kopi Co",
        say: { form: "setClient", name: "kopi-landing", client: "Kopi Co" },
      }),
      // Written by Laci 2.5: no parts, so its title tells it as before.
      entry("e2", 40, { title: "Backed up 3 agent history files", by: "auto" }),
    ]),
    [
      "Undid: Archived kopi-landing",
      "Added a next step to kopi-landing",
      "Archived kopi-landing",
      "Set the client of kopi-landing to Kopi Co",
      "Copied 3 chat files",
    ],
  );
}
