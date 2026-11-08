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
  const dev = `${ROOT}/clients/acme`;
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
    ["clients / acme", ["portal"]],
    ["clients / acme / apps", ["mobile"]],
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
  assert.deepEqual(labels({ filter: "needs" }), [
    "clients",
    "side",
    "thesis",
    "_archive",
    "_archive / old-clients",
  ]);
  // The archived group old-clients is a section of its own, under its path.
  assert.deepEqual(sectionsOf(s, { filter: "archived" }), [
    ["side", ["zine"]],
    ["_archive", ["old-portfolio"]],
    ["_archive / old-clients", ["batik-shop", "warung-pos"]],
  ]);
  // The one project of a folder archived: its section goes with it.
  node(s, "thesis/campus-lms").archived = true;
  assert.deepEqual(labels({}), ["clients", "project", "side"]);
  assert.deepEqual(labels({ filter: "archived", sort: "name" }), [
    "_archive",
    "_archive / old-clients",
    "side",
    "thesis",
  ]);
}

export async function theFolderFilterNarrowsTheSections() {
  const s = nested();
  // A folder shows itself and what is inside it, each folder as a section of its own.
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/clients`, sort: "name" }), [
    ["clients", ["acme-store", "kopi-landing"]],
    ["clients / acme", ["portal"]],
    ["clients / acme / apps", ["mobile"]],
  ]);
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/clients/acme/apps` }), [
    ["clients / acme / apps", ["mobile"]],
  ]);
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/side` }), [["side", ["dotfiles", "habit-app"]]]);
  // The folder with the search.
  assert.deepEqual(sectionsOf(s, { folder: `${ROOT}/clients`, query: "portal" }), [
    ["clients / acme", ["portal"]],
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
  assert.deepEqual(counts, { all: 2, needs: 2, active: 1, archived: 1 });
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
  const app = page.store({ snapshot, apps: {}, modal: null });
  const { Projects } = load("simple/Projects.tsx", {
    react: page.react,
    "../clock": { useNow: () => NOW.getTime() },
    "../common": { Icon: () => null },
    "../store": {
      external: () => {},
      goToProject: () => {},
      useApp: app,
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
  return { page, simple, app };
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
  // side holds zine too, archived, which Archive group… moves with the others: its heading says both.
  assert.deepEqual(heads(page).map(headCount), [
    "· 2 projects",
    "· 1 project",
    "· 2 of 3 projects",
    "· 1 project",
  ]);
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
  assert.equal(headCount(heads(page)[2]), "· 2 of 3 projects");
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

// ── An archived group ──────────────────────────────────────────────────────────────────────────────

/** The demo's archived group: two projects whose old place, ~/project/old-clients, is a link to it. */
const GROUP = `${ROOT}/_archive/old-clients`;
const groupRestores = (page) =>
  page.all(
    (n) =>
      n.type === "button" &&
      String(n.props["aria-label"] ?? "").startsWith(words.projects.restoreGroupFor("")),
  );
const menuItem = (host, label) =>
  host.descendants().find((n) => n.props.role === "menuitem" && n.textContent === label);

export async function anArchivedGroupsHeadingRestoresTheWholeGroup() {
  const { page, app } = projectsPage(scan(), { filter: "archived" });
  assert.deepEqual(heads(page).map(headName), ["side", "_archive", "_archive / old-clients"]);
  assert.equal(headCount(heads(page)[2]), "· 2 projects");
  // Only the archived group's heading has Restore: _archive and side only hold archived projects.
  const [restore, ...more] = groupRestores(page);
  assert.deepEqual(more, []);
  assert.equal(restore.props["aria-label"], words.projects.restoreGroupFor("old-clients"));
  assert.equal(restore.textContent, words.projects.restore);
  click(page, restore);
  assert.deepEqual(app.getState().modal, { kind: "restore", id: GROUP });
  // Alone in the list, the group keeps its heading, which holds its Restore.
  const alone = projectsPage(scan(), { filter: "archived", query: "batik" });
  assert.deepEqual(heads(alone.page).map(headName), ["_archive / old-clients"]);
  assert.equal(groupRestores(alone.page).length, 1);
  // Grouped by nothing, there are no headings, and no group Restore beside the cards.
  const flat = projectsPage(scan(), { filter: "archived", grouped: false });
  assert.deepEqual([heads(flat.page).length, groupRestores(flat.page).length], [0, 0]);
}

export async function aProjectThatGoesBackWithItsGroupSaysSoAndRestoresTheGroup() {
  const { page, app } = projectsPage(scan(), { filter: "archived", grouped: false });
  const card = page.find((n) => n.props["data-id"] === `${GROUP}/batik-shop`);
  const text = card.textContent;
  assert.ok(text.includes(words.projects.inGroup("old-clients")), text);
  assert.ok(!text.includes(words.projects.from("~/project/old-clients/batik-shop")), text);
  // A project the engine can put back alone says where it came from, and its menu restores it.
  const old = page.find((n) => n.props["data-id"] === `${ROOT}/_archive/old-portfolio`);
  assert.ok(old.textContent.includes(words.projects.from("~/project/old-portfolio")));
  click(page, menuItem(old, words.projects.restore));
  assert.deepEqual(app.getState().modal, { kind: "restore", id: `${ROOT}/_archive/old-portfolio` });
  // In the group's project's menu, Restore is the group's.
  assert.equal(menuItem(card, words.projects.restore), undefined);
  click(page, menuItem(card, words.projects.restoreGroup));
  assert.deepEqual(app.getState().modal, { kind: "restore", id: GROUP });
}

// ── Archive a group, and a folder only marked archived ────────────────────────────────────────────

const groupArchives = (page) =>
  page.all(
    (n) =>
      n.type === "button" &&
      String(n.props["aria-label"] ?? "").startsWith(words.projects.archiveGroupFor("")),
  );

export async function aFoldersHeadingArchivesTheWholeGroup() {
  const { page, app } = projectsPage();
  // clients, side and thesis have a plan to archive them whole; ~/project, a scan location, has none.
  assert.deepEqual(
    groupArchives(page).map((n) => n.props["aria-label"]),
    ["clients", "side", "thesis"].map(words.projects.archiveGroupFor),
  );
  const [clients] = groupArchives(page);
  assert.equal(clients.textContent, words.projects.archiveGroup);
  assert.equal(words.projects.archiveGroup, "Archive group…");
  click(page, clients);
  assert.deepEqual(app.getState().modal, { kind: "archive", id: `${ROOT}/clients` });
  // Among what is archived already, no heading offers Archive group: side holds zine there.
  const archived = projectsPage(scan(), { filter: "archived" });
  assert.equal(groupArchives(archived.page).length, 0);
}

export async function aHeadingCountsWhatItsArchiveGroupMoves() {
  // side holds 3 projects (the engine's projectCount): dotfiles, habit-app and zine, archived where
  // it is. All shows 2 cards; Archive group… moves the 3, and the heading says so.
  const s = scan();
  assert.equal(node(s, "side").projectCount, 3);
  assert.equal(words.projects.groupCountOf(2, 3), "· 2 of 3 projects");
  const { page } = projectsPage(s);
  const side = heads(page).find((head) => headName(head) === "side");
  assert.equal(headCount(side), words.projects.groupCountOf(2, 3));
  // A search leaves one card of clients' 2: the heading still says what the group holds.
  const search = projectsPage(scan(), { query: "acme" });
  assert.deepEqual(heads(search.page).map(headCount), []);
  const two = projectsPage(scan(), { query: "a" });
  const clients = heads(two.page).find((head) => headName(head) === "clients");
  const shown = cardNames(two.page).filter((name) => ["acme-store", "kopi-landing"].includes(name));
  assert.equal(
    headCount(clients),
    shown.length === 2 ? words.projects.groupCount(2) : words.projects.groupCountOf(shown.length, 2),
  );
  // A folder whose heading moves nothing counts its cards alone.
  const archived = projectsPage(scan(), { filter: "archived" });
  const sideArchived = heads(archived.page).find((head) => headName(head) === "side");
  assert.equal(headCount(sideArchived), words.projects.groupCount(1));
}

export async function aHeadingsButtonsAreNamedByWhatTheyShow() {
  // Each button beside a folder's heading has a name that starts with its own words, so that it is
  // found by what it shows (Archive group…, Restore…), and then says which folder.
  const named = (page) =>
    page
      .all(
        (n) =>
          n.type === "button" &&
          n.props["aria-label"] &&
          [words.projects.archiveGroup, words.projects.restore].includes(n.textContent),
      )
      .map((n) => [n.textContent, n.props["aria-label"]]);
  const all = named(projectsPage().page);
  const archived = named(projectsPage(scan(), { filter: "archived" }).page);
  const marked = named(projectsPage(markedThesis(), { filter: "archived" }).page);
  assert.ok(all.length && archived.length && marked.length);
  for (const [shows, name] of [...all, ...archived, ...marked])
    assert.ok(name.startsWith(shows), `"${name}" starts with "${shows}"`);
  assert.deepEqual(all[0], [words.projects.archiveGroup, "Archive group… clients"]);
  assert.deepEqual(archived[0], [words.projects.restore, "Restore… the group old-clients"]);
  assert.ok(marked.some(([, name]) => name === "Restore… thesis: take the archived mark off"));
}

/** The demo home with an archived group, 2024, inside old-clients, holding a project of its own. */
function nestedArchive() {
  const s = scan();
  const outer = `${GROUP}`;
  const inner = `${GROUP}/2024`;
  const template = s.nodes[GROUP];
  add(s, inner, "folder", {
    parent: outer,
    ...structuredClone(template),
    id: inner,
    path: inner,
    name: "2024",
    label: "2024",
    children: [],
    restorePlan: {
      error: "2024 is in the archived group old-clients, which goes back whole.",
      reason: "inGroup",
      dest: `${ROOT}/old-clients/2024`,
      group: outer,
      ops: [],
      checks: [],
    },
  });
  s.nodes[inner].parent = outer;
  const mobile = `${inner}/mobile`;
  add(s, mobile, "project", {
    parent: inner,
    ...structuredClone(s.nodes[`${GROUP}/batik-shop`]),
    id: mobile,
    path: mobile,
    name: "mobile",
    label: "mobile",
    restorePlan: { ...s.nodes[inner].restorePlan, dest: `${ROOT}/old-clients/2024/mobile` },
  });
  s.nodes[mobile].parent = inner;
  return s;
}

export async function aProjectInAnArchivedGroupInsideAnotherIsUnderTheOuterGroup() {
  // The engine puts back the outermost archived group: old-clients' heading holds mobile too, and its
  // Restore… is the only one; 2024 has no heading of its own.
  const s = nestedArchive();
  assert.deepEqual(sectionsOf(s, { filter: "archived", sort: "name" }), [
    ["_archive", ["old-portfolio"]],
    ["_archive / old-clients", ["batik-shop", "mobile", "warung-pos"]],
    ["side", ["zine"]],
  ]);
  const { page, app } = projectsPage(s, { filter: "archived", sort: "name" });
  const [restore, ...more] = groupRestores(page);
  assert.deepEqual(more, []);
  assert.equal(restore.props["aria-label"], words.projects.restoreGroupFor("old-clients"));
  // Its count is what Restore… puts back: the 3 projects at any depth.
  const outer = heads(page).find((head) => headName(head) === "_archive / old-clients");
  assert.equal(headCount(outer), words.projects.groupCount(3));
  click(page, restore);
  assert.deepEqual(app.getState().modal, { kind: "restore", id: GROUP });
}

/** The demo home with thesis marked archived in its own .laci.md, where it is. */
function markedThesis() {
  const s = scan();
  const thesis = node(s, "thesis");
  delete thesis.archivePlan;
  Object.assign(thesis, {
    archived: true,
    inArchive: false,
    meta: { ...thesis.meta, status: "archived" },
    status: { value: "archived", auto: false },
    restorePlan: {
      dest: thesis.path,
      checks: [],
      ops: [{ kind: "write", label: "Clear status: archived", to: "~/project/thesis/.laci.md" }],
    },
  });
  return s;
}

export async function aFolderOnlyMarkedArchivedIsUnderArchivedWithItsRestore() {
  const s = markedThesis();
  // Its projects aren't archived themselves, and Archived lists them under the folder.
  assert.deepEqual(sectionsOf(s, { filter: "archived", sort: "name" }), [
    ["_archive", ["old-portfolio"]],
    ["_archive / old-clients", ["batik-shop", "warung-pos"]],
    ["side", ["zine"]],
    ["thesis", ["campus-lms"]],
  ]);
  assert.equal(model.projectsModel(s, query({ filter: "archived" }), NOW).counts.archived, 5);
  const { page, app } = projectsPage(s, { filter: "archived" });
  const restore = page.find(
    (n) => n.type === "button" && n.props["aria-label"] === words.projects.unmarkGroupFor("thesis"),
  );
  assert.ok(restore, "the folder's heading has Restore");
  assert.equal(restore.textContent, words.projects.restore);
  click(page, restore);
  assert.deepEqual(app.getState().modal, { kind: "restore", id: `${ROOT}/thesis` });
  // Alone in the list, it keeps its heading, which holds its Restore.
  const alone = projectsPage(s, { filter: "archived", query: "campus" });
  assert.deepEqual(heads(alone.page).map(headName), ["thesis"]);
  // A marked folder has no plan to archive it again.
  assert.deepEqual(groupArchives(projectsPage(s).page).map((n) => n.props["aria-label"]), [
    words.projects.archiveGroupFor("clients"),
    words.projects.archiveGroupFor("side"),
  ]);
}

export async function aLinkedProjectWhoseGroupTheEngineDoesntNameSaysToRemoveTheLink() {
  // The engine names no group for batik-shop: its card says the link has to go, and its menu
  // offers its own Restore, where another place can be chosen.
  const s = scan();
  delete s.nodes[`${GROUP}/batik-shop`].restorePlan.group;
  const { page, app } = projectsPage(s, { filter: "archived", grouped: false });
  const card = page.find((n) => n.props["data-id"] === `${GROUP}/batik-shop`);
  assert.ok(card.textContent.includes(words.projects.linkedAlone), card.textContent);
  assert.ok(!card.textContent.includes(words.projects.inGroup("old-clients")), card.textContent);
  assert.equal(menuItem(card, words.projects.restoreGroup), undefined);
  click(page, menuItem(card, words.projects.restore));
  assert.deepEqual(app.getState().modal, { kind: "restore", id: `${GROUP}/batik-shop` });
}

export async function aProjectInsideAnArchivedGroupRestoresTheGroupOrItselfInAPlaceOfItsOwn() {
  // The engine refuses batik-shop alone without a place (reason "inGroup"), naming its group.
  const s = scan();
  const batik = s.nodes[`${GROUP}/batik-shop`];
  batik.restorePlan = {
    error: "batik-shop is in the archived group old-clients, which goes back whole. Restore old-clients, or choose another place for it.",
    reason: "inGroup",
    dest: `${ROOT}/old-clients/batik-shop`,
    group: GROUP,
    ops: [],
    checks: [],
  };
  const { page, app } = projectsPage(s, { filter: "archived", grouped: false });
  const card = page.find((n) => n.props["data-id"] === `${GROUP}/batik-shop`);
  assert.ok(card.textContent.includes(words.projects.inGroup("old-clients")), card.textContent);
  assert.equal(menuItem(card, words.projects.restore), undefined);
  click(page, menuItem(card, words.projects.restoreGroup));
  assert.deepEqual(app.getState().modal, { kind: "restore", id: GROUP });
  // Alone: its own sheet, where a place of its own is chosen.
  click(page, menuItem(card, words.projects.restoreAlone));
  assert.deepEqual(app.getState().modal, { kind: "restore", id: `${GROUP}/batik-shop` });
  // A project the engine puts back by itself has no Restore it alone.
  const old = page.find((n) => n.props["data-id"] === `${ROOT}/_archive/old-portfolio`);
  assert.equal(menuItem(old, words.projects.restoreAlone), undefined);
  // Simple's words don't say "agent".
  assert.doesNotMatch(words.projects.restoreAlone, /agent/i);
  assert.doesNotMatch(words.dialogs.restore.inGroup("old-clients"), /agent/i);
}

/** The declarations of the rule for `selector` in Simple's sheet. */
function simpleRule(selector) {
  const css = readFileSync(new URL("../../ui/src/simple/simple.css", import.meta.url), "utf8");
  const quoted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`\\n\\s*${quoted}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  assert.ok(body !== undefined, `simple.css has a rule for ${selector}`);
  return Object.fromEntries(
    body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((declaration) => declaration.split(":").map((part) => part.trim()))
      .filter(([property, value]) => property && value),
  );
}

export function aFolderHeadingStaysOnOneLineWhenThereIsRoomForIt() {
  // The heading is as wide as its toggle, so the toggle fills it and its words keep one line at
  // 1280x800. A toggle pulled 8px left inside it would be 8px short of its words, and "clients"
  // would break mid-word: the heading takes the offset that lines the words up with the cards.
  const head = simpleRule(".s-group-head");
  const toggle = simpleRule(".s-group-toggle");
  const name = simpleRule(".s-group-name");
  assert.equal(head.margin, "0 0 0 -8px");
  assert.equal(head["min-width"], "0");
  assert.equal(toggle["max-width"], "100%");
  for (const property of ["margin", "margin-left", "margin-inline", "margin-inline-start"])
    assert.equal(toggle[property], undefined, `the toggle has no ${property} of its own`);
  // A long name still wraps where the heading is narrower than it.
  assert.equal(name["overflow-wrap"], "anywhere");
  assert.equal(name["min-width"], "0");
}
