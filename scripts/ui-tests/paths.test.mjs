// How ui/src/helpers.ts reads a path: a POSIX one, with "/" as its only separator. store.ts keeps a
// copy of the part `cd` needs; it must agree.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../ui-module.mjs";

const helpers = load("helpers.ts");
const {
  base,
  breadcrumbs,
  expandHome,
  isAbsolutePath,
  isWholeDisk,
  joinPath,
  parentOf,
  rootOf,
  segments,
  tilde,
  trimSep,
  within,
} = helpers;

/** The functions as they were before paths knew drives, to show that a path reads the same. */
const before = {
  base: (p) => p.slice(p.lastIndexOf("/") + 1) || "/",
  parentOf: (p) => p.slice(0, p.lastIndexOf("/")) || "/",
  within: (p, root) =>
    p === root || p.startsWith(root.endsWith("/") ? root : root + "/"),
  tilde: (p, home) =>
    p === home
      ? "~"
      : p?.startsWith(home + "/")
        ? "~" + p.slice(home.length)
        : (p ?? ""),
};

const POSIX = [
  "/",
  "//",
  "/a",
  "/a/",
  "/a/b",
  "/a//b",
  "/a/b/c.txt",
  "/home/demo",
  "/home/demonic",
  "/home/demo/",
  "/home/demo/project/app",
  "/mnt/My Drive/x",
  "/ünï/çodé",
  "",
  "a",
  "a/b",
  "./a",
  "../a",
  "~",
  "~/a",
];
/** Every kind of string a path field may hold, for the checks that compare two implementations. */
const CORPUS = [
  ...POSIX,
  "/home/me/a\\b",
  "/home/me/a\\",
  "/home/me\\x/y",
  "C:\\Users\\me",
  "c:/Users/me/x",
  "\\\\nas\\files\\a",
  "//nas/files/a",
];

export async function aPosixPathReadsAsItAlwaysDid() {
  for (const p of POSIX) {
    assert.equal(base(p), before.base(p), `base ${p}`);
    assert.equal(parentOf(p), before.parentOf(p), `parentOf ${p}`);
    for (const root of POSIX) {
      assert.equal(within(p, root), before.within(p, root), `${p} in ${root}`);
      assert.equal(tilde(p, root), before.tilde(p, root), `${p} from ${root}`);
    }
  }
  assert.equal(tilde(undefined, "/home/demo"), "");
  assert.equal(rootOf("/home/demo"), "/");
  assert.equal(rootOf("relative/dir"), "");
  assert.equal(isAbsolutePath("/home/demo"), true);
  assert.equal(isAbsolutePath("relative/dir"), false);
  assert.equal(isAbsolutePath("~/work"), false);
  assert.deepEqual(segments("/a//b/"), ["a", "b"]);
  assert.deepEqual(segments("/"), []);
  assert.equal(parentOf("//nas/files/a"), "//nas/files");
}

export async function aBackslashIsAnOrdinaryCharacterInAName() {
  assert.equal(base("/home/me/a\\b"), "a\\b");
  assert.equal(parentOf("/home/me/a\\b"), "/home/me");
  assert.deepEqual(segments("/home/me/a\\b"), ["home", "me", "a\\b"]);
  assert.equal(trimSep("/home/me/a\\"), "/home/me/a\\");
  assert.equal(joinPath("/home/me", "a\\b"), "/home/me/a\\b");
  assert.ok(!within("/home/me/a\\b", "/home/me/a"));
  assert.ok(within("/home/me/a\\b", "/home/me"));
  assert.equal(tilde("/home/me\\x/y", "/home/me"), "/home/me\\x/y");
  // A drive letter names nothing here: such a path is relative.
  for (const p of ["C:\\Users", "c:/x", "C:\\", "\\\\nas\\files"]) {
    assert.equal(isAbsolutePath(p), false, p);
    assert.equal(rootOf(p), "", p);
    assert.equal(isWholeDisk(p), false, p);
  }
}

export async function aWholeDiskIsTheRoot() {
  // What Settings and Home refuse as a place to keep projects.
  for (const disk of ["/", "//"]) assert.equal(isWholeDisk(disk), true, disk);
  for (const folder of ["", "/home", "/mnt/data", "~", "projects"])
    assert.equal(isWholeDisk(folder), false, folder);
}

export async function pathsAreJoinedWithASlash() {
  assert.equal(joinPath("/mnt", "backup", "archive"), "/mnt/backup/archive");
  assert.equal(joinPath("/", "a"), "/a");
  assert.equal(joinPath("/mnt/", "a"), "/mnt/a");
  assert.equal(joinPath("/mnt"), "/mnt");
}

export async function aClosingSlashGoesButTheRootKeepsItsOwn() {
  assert.equal(trimSep("/mnt/x///"), "/mnt/x");
  assert.equal(trimSep("/mnt/x"), "/mnt/x");
  assert.equal(trimSep("/"), "/");
  assert.equal(trimSep("//"), "/");
  assert.equal(trimSep("~/"), "~");
  // The expression the folder boxes in Settings used before, for every POSIX string.
  for (const p of POSIX)
    assert.equal(trimSep(p), p.replace(/(.)\/+$/, "$1"), p);
}

export async function aTypedTildeBecomesTheHomeFolder() {
  const home = "/home/me";
  assert.equal(expandHome("~", home), home);
  assert.equal(expandHome("~/work", home), "/home/me/work");
  assert.equal(expandHome("~/", home), "/home/me/");
  assert.equal(expandHome("~work", home), "~work");
  assert.equal(expandHome("/mnt/x", home), "/mnt/x");
  assert.equal(expandHome("work", home), "work");
  assert.equal(
    expandHome("~\\work", home),
    "~\\work",
    "a backslash is a name here",
  );
  // The expression the folder boxes used before.
  for (const p of POSIX)
    assert.equal(
      expandHome(p, home),
      p === "~" || p.startsWith("~/") ? home + p.slice(1) : p,
      p,
    );
}

/** The trail the Folder view drew before paths knew drives, with its anchor and its slashes. */
function trailBefore(cwd, home, roots) {
  const anchor = before.within(cwd, home)
    ? home
    : ([...roots]
        .filter((root) => before.within(cwd, root))
        .sort((a, b) => b.length - a.length)[0] ?? "/");
  const rel = cwd
    .slice(anchor === "/" ? 1 : anchor.length)
    .split("/")
    .filter(Boolean);
  return [
    anchor,
    ...rel.map(
      (_, i) =>
        `${anchor === "/" ? "" : anchor}/${rel.slice(0, i + 1).join("/")}`,
    ),
  ];
}

export async function breadcrumbsKeepTheirPosixTrail() {
  const home = "/home/demo";
  const roots = ["/home/demo/project", "/mnt/work", "/mnt/work/clients"];
  for (const cwd of [
    "/home/demo",
    "/home/demo/project/app/src",
    "/home/demo/Documents",
    "/mnt/work",
    "/mnt/work/clients/acme/web",
    "/mnt/work/other",
    "/etc/ssh",
    "/",
    "/home",
  ])
    assert.deepEqual(
      breadcrumbs(cwd, home, roots),
      trailBefore(cwd, home, roots),
      cwd,
    );
}

// ── What the sessions and reports of a project depend on ───────────────────────────────────────────

const node = (p) => ({
  id: p,
  path: p,
  agents: { claude: [], items: [] },
});
const session = (id, cwd) => ({
  provider: "claude",
  sessionId: id,
  cwd,
  title: id,
  updatedAt: "2026-10-04",
  file: `/logs/${id}`,
  resumeCapability: "supported",
  sourceKind: "cli",
  titleSource: "provider",
});

export async function sessionsFindTheirProject() {
  const app = node("/work/app");
  const longer = node("/work/app2");
  const folder = node("/work");
  const data = {
    home: "/home/me",
    nodes: {
      [app.id]: app,
      [longer.id]: longer,
      [folder.id]: folder,
    },
    claude: {},
    items: {},
    connectors: [],
    sessions: [
      session("nested", "/work/app/src/deep"),
      session("sibling", "/work/app2/x"),
      session("parent", "/work/notes"),
      session("other-case", "/work/APP"),
      session("home", "/home/me"),
      session("elsewhere", "/elsewhere/deep"),
      session("nowhere", undefined),
    ],
  };
  const ids = (n) =>
    helpers
      .sessionsOf(n, data)
      .map((s) => s.sessionId)
      .sort();
  assert.deepEqual(ids(app), ["nested"]);
  assert.deepEqual(ids(longer), ["sibling"], "app2 is not app");
  assert.deepEqual(ids(folder), ["other-case", "parent"], "APP is not app");
  assert.deepEqual(
    helpers
      .globalSessions(data)
      .map((s) => s.sessionId)
      .sort(),
    ["elsewhere", "home", "nowhere"],
  );
}

export async function aConversationLogIsFoundInTheFolderTheEngineNamed() {
  const claude = (dir, cwd) => ({
    home: "/home/me",
    nodes: {},
    items: {},
    connectors: [],
    claude: {
      k: { path: cwd, dir, sessions: [{ id: "abc", at: "2026-10-04" }] },
    },
  });
  assert.equal(
    helpers.allSessions(
      claude("/home/me/.claude/projects/-home-me-app", "/home/me/app"),
    )[0].file,
    "/home/me/.claude/projects/-home-me-app/abc.jsonl",
  );
}

export async function reportsAreFoundByTheirProjectsPath() {
  const report = (id, projects) => ({
    id,
    file: `/reports/${id}`,
    title: id,
    date: "2026-10-01",
    modified: "2026-10-01T10:00:00.000Z",
    bytes: 1,
    sessions: [],
    projects,
    open: [],
    openCount: 0,
  });
  const data = { reports: [report("posix.md", ["/work/app"])] };
  assert.deepEqual(
    helpers.reportsOfProject(data, "/work/app").map((r) => r.id),
    ["posix.md"],
  );
  assert.deepEqual(
    helpers.reportsOfProject(data, "/WORK/app"),
    [],
    "POSIX keeps its case",
  );
  assert.equal(helpers.latestReport(data, "/work/app").id, "posix.md");
}

// ── The store's copy ──────────────────────────────────────────────────────────────────────────────

const native = {
  api: async () => ({}),
  errorText: (error) =>
    error instanceof Error ? error.message : String(error),
};
const page = () => ({
  document: { documentElement: { dataset: {} } },
  localStorage: { getItem: () => null, setItem: () => {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
});

/** A store that has a scan of `home` and `roots`, with the sidebar tree closed. */
function storeOf(home, roots) {
  const { useApp } = load("store.ts", { "./api": native }, page());
  useApp.getState().load({
    revision: 1,
    configured: true,
    home,
    roots,
    nodes: {},
    proposals: [],
  });
  useApp.setState({ tree: new Set() });
  return useApp;
}
/** The folders `cd(path)` opens in the tree. */
function opened(home, roots, path) {
  const useApp = storeOf(home, roots);
  useApp.getState().cd(path);
  assert.equal(useApp.getState().cwd, path);
  assert.equal(useApp.getState().view, "folder");
  return [...useApp.getState().tree].sort();
}

/** The store's own parentOf and within, which only it can reach. */
function storeCopy() {
  const file = fileURLToPath(new URL("../../ui/src/store.ts", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "laci-paths-"));
  try {
    const copy = path.join(dir, "store.ts");
    writeFileSync(
      copy,
      `${readFileSync(file, "utf8")}\nexport const __paths = { parentOf, within };\n`,
    );
    return load(copy, { "./api": native }, page()).__paths;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function theStoreReadsPathsAsHelpersDoes() {
  const copy = storeCopy();
  for (const p of CORPUS) {
    assert.equal(copy.parentOf(p), parentOf(p), `parentOf ${p}`);
    for (const root of CORPUS)
      assert.equal(copy.within(p, root), within(p, root), `${p} in ${root}`);
  }
}

export async function cdOpensTheTreeDownToHomeOrTheRootOnPosix() {
  const roots = ["/home/demo/project", "/mnt/work"];
  assert.deepEqual(opened("/home/demo", roots, "/home/demo/project/app/src"), [
    "/home/demo/project",
    "/home/demo/project/app",
  ]);
  assert.deepEqual(opened("/home/demo", roots, "/mnt/work/a/b"), [
    "/mnt/work",
    "/mnt/work/a",
  ]);
  assert.deepEqual(opened("/home/demo", [], "/home/demo/x"), ["/home/demo"]);
  assert.deepEqual(opened("/home/demo", [], "/home/demo/x/y"), [
    "/home/demo",
    "/home/demo/x",
  ]);
  assert.deepEqual(opened("/home/demo", roots, "/home/demo"), []);
  assert.deepEqual(opened("/home/demo", roots, "/etc/ssh"), []);
  assert.deepEqual(opened("/home/demo", roots, "/home/demonic/x"), []);
}
