// Simple's Projects under their folders (ui/src/simple/model.ts `sections`, ui/src/simple/state.ts and
// ui/src/simple/Projects.tsx), on the preview's demo home: ~/project holds clients/, side/ and thesis/,
// and infra-notes sits in ~/project itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";
import { event, simpleBlocks, standIn } from "./react-stand-in.mjs";

const { createElement } = requireUi("react");
const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);
const model = load("simple/model.ts");
const words = load("words.ts");
const ROOT = "/home/demo/project";
const NOW = new Date(fixtures.meta.now);
const scan = () => structuredClone(fixtures.snapshot);
const node = (snapshot, path) => snapshot.nodes[`${ROOT}/${path}`];

/** A node like a real one of its kind, at `path`, below `parent` when it has one. */
function add(snapshot, path, kind, { parent, ...own } = {}) {
  const template = node(snapshot, kind === "folder" ? "clients" : "clients/kopi-landing");
  const name = path.split("/").pop();
  snapshot.nodes[path] = {
    ...structuredClone(template),
    id: path,
    kind,
    name,
    label: name,
    path,
    parent,
    children: [],
    archived: false,
    ...own,
  };
  snapshot.nodes[parent]?.children.push(path);
}

const query = (more) => ({ filter: "all", query: "", sort: "recent", folder: null, ...more });
const sectionsOf = (snapshot, more) =>
  model
    .projectsModel(snapshot, query(more), NOW)
    .sections.map((s) => [s.label, s.projects.map((n) => n.label)]);

/** The demo home with two groups inside `clients/`, one inside the other. */
function nested() {
  const s = scan();
  const dev = `${ROOT}/clients/devstudio`;
  add(s, dev, "folder", { parent: `${ROOT}/clients` });
  add(s, `${dev}/portal`, "project", { parent: dev });
  add(s, `${dev}/apps`, "folder", { parent: dev });
  add(s, `${dev}/apps/mobile`, "project", { parent: `${dev}/apps` });
  return s;
}

export async function everyProjectIsInTheSectionOfItsFolder() {
  const s = scan();
  const { shown, sections } = model.projectsModel(s, query(), NOW);
  assert.deepEqual(sectionsOf(s), [
    ["clients", ["acme-store", "kopi-landing"]],
    // A scan root that holds projects is a group too, and goes by its own name.
    ["project", ["infra-notes"]],
    ["side", ["dotfiles", "habit-app"]],
    ["thesis", ["campus-lms"]],
  ]);
  assert.deepEqual(
    sections.map((section) => section.group?.path),
    [`${ROOT}/clients`, ROOT, `${ROOT}/side`, `${ROOT}/thesis`],
  );
  // Nothing is lost or counted twice, and `shown` is still the flat list.
  const inSections = sections.flatMap((section) => section.projects).map((n) => n.id);
  assert.deepEqual(inSections.sort(), shown.map((n) => n.id).sort());
  assert.equal(shown.length, 6);
}

export async function aNestedFolderIsASectionNamedByItsPathBelowTheRoot() {
  assert.deepEqual(sectionsOf(nested(), { sort: "name" }), [
    ["clients", ["acme-store", "kopi-landing"]],
    ["clients / devstudio", ["portal"]],
    ["clients / devstudio / apps", ["mobile"]],
    ["project", ["infra-notes"]],
    ["side", ["dotfiles", "habit-app"]],
    ["thesis", ["campus-lms"]],
  ]);
}

export async function eachScanRootNamesItsGroupsFromItsOwnFolder() {
  const s = scan();
  const work = "/home/demo/work";
  s.roots = [ROOT, work];
  add(s, work, "folder");
  add(s, `${work}/team`, "folder", { parent: work });
  add(s, `${work}/team/api`, "project", { parent: `${work}/team` });
  add(s, `${work}/tool`, "project", { parent: work });
  // "team", not "home / demo / work / team": the path is cut at the root that holds it.
  const labels = sectionsOf(s, { sort: "name" }).filter(([label]) => label === "team" || label === "work");
  assert.deepEqual(labels, [
    ["team", ["api"]],
    ["work", ["tool"]],
  ]);
}

export async function aProjectOutsideEveryFolderIsInTheLastSection() {
  const s = scan();
  // One the scan found with no folder above it, and one whose folder is not in the scan.
  add(s, "/home/demo/loose/scratch", "project", { parent: undefined });
  add(s, "/home/demo/loose/ghost", "project", { parent: "/home/demo/loose" });
  for (const sort of ["recent", "name", "size"]) {
    const sections = model.projectsModel(s, query({ sort }), NOW).sections;
    const last = sections.at(-1);
    assert.equal(last.group, null, sort);
    assert.equal(last.label, words.projects.noGroup);
    assert.deepEqual(last.projects.map((n) => n.label).sort(), ["ghost", "scratch"], sort);
    assert.equal(sections.filter((section) => !section.group).length, 1, sort);
  }
  // Without them there is no such section.
  const plain = model.projectsModel(scan(), query(), NOW).sections;
  assert.ok(plain.every((section) => section.group));
  // What remembers a section: its folder, or "none".
  assert.equal(model.sectionKey({ group: null, label: "", projects: [] }), "none");
  assert.equal(model.sectionKey(plain[0]), `${ROOT}/clients`);
}

export async function sectionsFollowTheNewestProjectOrTheNames() {
  const s = scan();
  // habit-app is the newest: its folder comes first, and the folders keep their cards by recency.
  node(s, "side/habit-app").lastActivity.at = "2026-10-09T09:00:00.000Z";
  assert.deepEqual(sectionsOf(s, { sort: "recent" }), [
    ["side", ["habit-app", "dotfiles"]],
    ["clients", ["acme-store", "kopi-landing"]],
    ["project", ["infra-notes"]],
    ["thesis", ["campus-lms"]],
  ]);
  // By name the folders and the cards are both alphabetical, whatever is newest.
  assert.deepEqual(sectionsOf(s, { sort: "name" }), [
    ["clients", ["acme-store", "kopi-landing"]],
    ["project", ["infra-notes"]],
    ["side", ["dotfiles", "habit-app"]],
    ["thesis", ["campus-lms"]],
  ]);
}

export async function sectionsFollowTheMostDueOrTheBiggestProject() {
  const s = scan();
  node(s, "thesis/campus-lms").meta.deadline = "2026-10-09";
  const due = sectionsOf(s, { sort: "due" });
  assert.deepEqual(due[0], ["thesis", ["campus-lms"]]);
  assert.equal(due[1][0], "clients");
  const habit = node(s, "side/habit-app");
  habit.size = { ...habit.size, total: 9e12 };
  assert.deepEqual(sectionsOf(s, { sort: "size" })[0], ["side", ["habit-app", "dotfiles"]]);
}

export async function cardsInASectionKeepTheOrderOfTheFlatList() {
  const s = nested();
  for (const sort of ["recent", "name", "due", "size"]) {
    const { shown, sections } = model.projectsModel(s, query({ sort }), NOW);
    for (const section of sections) {
      const flat = shown.filter((n) => section.projects.includes(n));
      assert.deepEqual(section.projects, flat, `${sort}: ${section.label}`);
    }
  }
}

export async function filtersAndSearchLeaveNoEmptySection() {
  const s = scan();
  const labels = (more) => sectionsOf(s, more).map(([label]) => label);
  // The search reaches one project, or two in one folder: only their folders are left.
  assert.deepEqual(sectionsOf(s, { query: "habit" }), [["side", ["habit-app"]]]);
  assert.deepEqual(sectionsOf(s, { query: "coffee" }), [["clients", ["acme-store", "kopi-landing"]]]);
  assert.deepEqual(sectionsOf(s, { query: "nothing like it" }), []);
  // Active leaves out thesis and habit-app: its folder is gone, and side keeps one card.
  assert.deepEqual(sectionsOf(s, { filter: "active" }), [
    ["clients", ["acme-store", "kopi-landing"]],
    ["project", ["infra-notes"]],
    ["side", ["dotfiles"]],
  ]);
  // Needs you has no infra-notes, so ~/project is gone; the archived project still needing it is not.
  assert.deepEqual(labels({ filter: "needs" }), ["clients", "side", "thesis", "_archive"]);
  assert.deepEqual(sectionsOf(s, { filter: "archived" }), [["_archive", ["old-portfolio"]]]);
  // The one project of a folder archived: its section goes with it.
  node(s, "thesis/campus-lms").archived = true;
  assert.deepEqual(labels({}), ["clients", "project", "side"]);
  assert.deepEqual(labels({ filter: "archived", sort: "name" }), ["_archive", "thesis"]);
}

export async function theFolderFilterNarrowsTheSections() {
  const s = nested();
  // A folder shows itself and what is inside it, each folder as a section of its own.
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/clients`, sort: "name" }), [
    ["clients", ["acme-store", "kopi-landing"]],
    ["clients / devstudio", ["portal"]],
    ["clients / devstudio / apps", ["mobile"]],
  ]);
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/clients/devstudio/apps` }), [
    ["clients / devstudio / apps", ["mobile"]],
  ]);
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/side` }), [["side", ["dotfiles", "habit-app"]]]);
  // The folder with the search.
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/clients`, query: "portal" }), [
    ["clients / devstudio", ["portal"]],
  ]);
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/side`, query: "coffee" }), []);
  // The root as the folder shows every section, the same as no folder.
  assert.deepEqual(sectionsOf(s, { folder: ROOT }), sectionsOf(s));
}

export async function shownStaysTheFlatListInTheChosenOrder() {
  const s = nested();
  const labelsOf = (sort) =>
    model.projectsModel(s, query({ sort }), NOW).shown.map((n) => n.label);
  // By name the folders don't matter: it is one alphabet.
  assert.deepEqual(labelsOf("name"), [
    "acme-store",
    "campus-lms",
    "dotfiles",
    "habit-app",
    "infra-notes",
    "kopi-landing",
    "mobile",
    "portal",
  ]);
  assert.equal(labelsOf("recent").length, 8);
  // The counts are of the folder, as before.
  const { counts } = model.projectsModel(s, query({ folder: `${ROOT}/side` }), NOW);
  assert.deepEqual(counts, { all: 2, needs: 2, active: 1, archived: 0 });
}

// ── What Simple keeps ──────────────────────────────────────────────────────────────────────────────

/** Simple's state on the app's store, over a storage that holds what it is given, or refuses it all. */
function kept(shelf = new Map(), broken = false) {
  const store = load(
    "store.ts",
    { "./api": { api: async () => ({}), errorText: String } },
    {
      document: { documentElement: { dataset: {} } },
      localStorage: {
        getItem: (key) => {
          if (broken) throw new Error("no storage");
          return shelf.get(key) ?? null;
        },
        setItem: (key, value) => {
          if (broken) throw new Error("no storage");
          shelf.set(key, value);
        },
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  );
  const state = load("simple/state.ts", { "../store": store });
  const now = () => {
    const { grouped, collapsed } = state.useSimple.getState();
    return { grouped, collapsed };
  };
  return { shelf, now, ...state };
}

export async function groupingIsOnFromTheStartAndWhatIsChosenIsKept() {
  const first = kept();
  assert.deepEqual(first.now(), { grouped: true, collapsed: [] });
  first.toggleCollapsed(`${ROOT}/side`);
  first.toggleCollapsed("none");
  first.toggleCollapsed(`${ROOT}/side`);
  assert.deepEqual(first.now().collapsed, ["none"]);
  first.setGrouped(false);
  // The next start has what was chosen.
  const next = kept(first.shelf);
  assert.deepEqual(next.now(), { grouped: false, collapsed: ["none"] });
  next.setGrouped(true);
  assert.equal(kept(first.shelf).now().grouped, true);
}

export async function unreadableSavedChoicesAreTheDefaultsAndABrokenStorageIsNoError() {
  const odd = kept(
    new Map([
      ["laci:simple-grouped", '"maybe"'],
      ["laci:simple-collapsed", '{"side":1}'],
    ]),
  );
  assert.deepEqual(odd.now(), { grouped: true, collapsed: [] });
  const mixed = kept(new Map([["laci:simple-collapsed", '["a",3,null,"b"]']]));
  assert.deepEqual(mixed.now().collapsed, ["a", "b"]);
  // Nothing can be stored: the choice still holds in this window.
  const none = kept(new Map(), true);
  assert.deepEqual(none.now(), { grouped: true, collapsed: [] });
  none.setGrouped(false);
  none.toggleCollapsed("none");
  assert.deepEqual(none.now(), { grouped: false, collapsed: ["none"] });
}

// ── The page ───────────────────────────────────────────────────────────────────────────────────────

/** Projects drawn on the stand-in, over `snapshot`, with Simple's state as a plain store. */
function projectsPage(snapshot = scan(), start = {}) {
  const page = standIn();
  const simple = page.store({
    filter: "all",
    sort: "recent",
    query: "",
    folder: null,
    grouped: true,
    collapsed: [],
    ...start,
  });
  const { Projects } = load("simple/Projects.tsx", {
    react: page.react,
    "../clock": { useNow: () => NOW.getTime() },
    "../common": { Icon: () => null },
    "../store": {
      external: () => {},
      goToProject: () => {},
      useApp: page.store({ snapshot, apps: {} }),
    },
    "./act": { continueWithAi: () => {}, fileManagerName: () => "Files" },
    "./state": {
      useSimple: simple,
      setSort: (sort) => simple.setState({ sort }),
      setGrouped: (grouped) => simple.setState({ grouped }),
      toggleCollapsed: (key) =>
        simple.setState((s) => ({
          collapsed: s.collapsed.includes(key)
            ? s.collapsed.filter((k) => k !== key)
            : [...s.collapsed, key],
        })),
    },
    "./ui": simpleBlocks({ SafetyBadge: () => null }),
  });
  page.mount(createElement(Projects));
  return { page, simple };
}

const heads = (page) => page.all((n) => n.props.className === "s-group-toggle");
const headName = (head) =>
  head.descendants().find((n) => n.props.className === "s-group-name").textContent;
const headCount = (head) =>
  head.descendants().find((n) => n.props.className === "s-group-count").textContent;
const cardNames = (page) =>
  page
    .all((n) => n.props["data-ui"] === "project-card")
    .map((n) => n.props["data-id"].split("/").pop());
const switchOf = (page) => page.find((n) => n.props.role === "switch");
const click = (page, host) => page.act(() => page.dispatch(host, "onClick", event({ target: host })));

export async function theProjectsPageHasAHeaderForEachFolderAndASwitchThatIsOn() {
  const { page } = projectsPage();
  const group = switchOf(page);
  assert.equal(group.textContent, words.projects.groupBy);
  assert.equal(group.props["aria-checked"], true);
  assert.deepEqual(heads(page).map(headName), ["clients", "project", "side", "thesis"]);
  assert.deepEqual(heads(page).map(headCount), ["· 2 projects", "· 1 project", "· 2 projects", "· 1 project"]);
  // A folder's heading says whether its cards are shown, and what they are.
  assert.ok(heads(page).every((h) => h.props["aria-expanded"] === true));
  const first = heads(page)[0];
  const region = page.find((n) => n.props.id === first.props["aria-controls"]);
  assert.ok(region, "aria-controls names the cards");
  assert.deepEqual(cardNames(page), [
    "acme-store",
    "kopi-landing",
    "infra-notes",
    "dotfiles",
    "habit-app",
    "campus-lms",
  ]);
  // The cards are one level under the headings, which are under the page's.
  assert.deepEqual(
    page.all((n) => n.props.className === "s-pcard-name").map((n) => n.type),
    Array(6).fill("h3"),
  );
  assert.deepEqual(
    page.all((n) => n.props.className === "s-group-head").map((n) => n.type),
    Array(4).fill("h2"),
  );
}

export async function aFoldedSectionHidesItsCardsAndSaysSo() {
  const { page, simple } = projectsPage();
  click(page, heads(page)[2]);
  assert.deepEqual(simple.getState().collapsed, [`${ROOT}/side`]);
  assert.deepEqual(heads(page).map((h) => h.props["aria-expanded"]), [true, true, false, true]);
  assert.deepEqual(cardNames(page), ["acme-store", "kopi-landing", "infra-notes", "campus-lms"]);
  // The heading stays, with how many it holds.
  assert.equal(headName(heads(page)[2]), "side");
  assert.equal(headCount(heads(page)[2]), "· 2 projects");
  click(page, heads(page)[2]);
  assert.ok(heads(page).every((h) => h.props["aria-expanded"] === true));
  assert.equal(cardNames(page).length, 6);
  // What was folded before is folded when the page opens.
  const again = projectsPage(scan(), { collapsed: [`${ROOT}/clients`, "none"] });
  assert.deepEqual(heads(again.page).map((h) => h.props["aria-expanded"]), [false, true, true, true]);
  assert.deepEqual(cardNames(again.page), ["infra-notes", "dotfiles", "habit-app", "campus-lms"]);
}

export async function theSwitchGivesTheFlatListBack() {
  const { page, simple } = projectsPage();
  click(page, switchOf(page));
  assert.equal(simple.getState().grouped, false);
  assert.equal(switchOf(page).props["aria-checked"], false);
  assert.equal(heads(page).length, 0);
  const lists = page.all((n) => n.type === "ul");
  assert.equal(lists.length, 1);
  assert.equal(lists[0].props["aria-label"], words.projects.title);
  // The order of the flat list, the folders ignored, and a card's heading is a page's second level.
  const { shown } = load("simple/model.ts").projectsModel(scan(), query(), NOW);
  assert.deepEqual(cardNames(page), shown.map((n) => n.label));
  assert.deepEqual(
    page.all((n) => n.props.className === "s-pcard-name").map((n) => n.type),
    Array(6).fill("h2"),
  );
  click(page, switchOf(page));
  assert.equal(heads(page).length, 4);
}

export async function oneSectionAloneHasNoHeader() {
  const { page } = projectsPage(scan(), { query: "habit" });
  assert.equal(heads(page).length, 0);
  assert.deepEqual(cardNames(page), ["habit-app"]);
  // Narrowed to one folder, its cards are the page.
  const side = projectsPage(scan(), { folder: `${ROOT}/side` });
  assert.equal(heads(side.page).length, 0);
  assert.deepEqual(cardNames(side.page), ["dotfiles", "habit-app"]);
  // Even folded before: with no header there is nothing to unfold.
  const folded = projectsPage(scan(), { query: "habit", collapsed: [`${ROOT}/side`] });
  assert.deepEqual(cardNames(folded.page), ["habit-app"]);
  // And the switch is still there.
  assert.ok(switchOf(page));
}

export async function aSearchWithNoMatchStillSaysSoWhenGrouped() {
  const { page } = projectsPage(scan(), { query: "nothing like it" });
  assert.equal(heads(page).length, 0);
  assert.ok(page.text().includes(words.projects.noMatch("nothing like it")));
}
