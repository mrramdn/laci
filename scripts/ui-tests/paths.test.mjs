// How ui/src/helpers.ts reads a path: a POSIX one as it always did, a Windows drive or share by its own
// separators and without case. store.ts keeps a copy of the part `cd` needs; it must agree.
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
  isWindowsPath,
  joinPath,
  parentOf,
  pathKey,
  rootOf,
  segments,
  tilde,
  trimSep,
  windowsNameProblem,
  within,
} = helpers;

/** The functions as they were before paths knew drives, to show that a POSIX path reads the same. */
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
const DRIVE = "C:\\Users\\me";
const SHARE = "\\\\nas\\files";
/** Every kind of string a path field may hold, for the checks that compare two implementations. */
const CORPUS = [
  ...POSIX,
  "C:\\",
  "C:/",
  "c:\\",
  "C:\\Users",
  DRIVE,
  `${DRIVE}\\`,
  "C:\\Users\\\\me",
  "c:/Users/me/x",
  "c:/Users/me/project",
  "D:/work/Clients/acme/",
  "C:/a/b/c/d",
  "C:\\a/b\\c",
  "C:\\a/bb\\cc/dd",
  "C:",
  "C:x",
  "\\Users",
  "\\\\",
  "\\\\nas",
  "\\\\nas\\",
  SHARE,
  `${SHARE}\\`,
  `${SHARE}\\a`,
  `${SHARE}\\a\\b\\`,
  `${SHARE}/sub/dir`,
  "\\\\nas/files\\sub",
  "\\\\NAS//files\\a",
  "\\\\?\\C:\\Users",
  "//nas/files/a",
];

export async function aPosixPathReadsAsItAlwaysDid() {
  for (const p of POSIX) {
    assert.equal(base(p), before.base(p), `base ${p}`);
    assert.equal(parentOf(p), before.parentOf(p), `parentOf ${p}`);
    assert.equal(pathKey(p), p, `a POSIX path is its own key: ${p}`);
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
  // A UNC path written with slashes is POSIX here: the desktop writes `\\server\share`.
  assert.equal(isWindowsPath("//nas/files/a"), false);
  assert.equal(parentOf("//nas/files/a"), "//nas/files");
}

export async function aWindowsDriveHasItsOwnRootAndTakesBothSeparators() {
  assert.equal(rootOf(`${DRIVE}\\x`), "C:\\");
  assert.equal(rootOf("c:/x"), "c:/");
  assert.equal(rootOf("C:\\"), "C:\\");
  for (const notAPath of ["C:", "C:x", "\\Users\\me", "\\\\nas", "c"])
    assert.equal(rootOf(notAPath), "", notAPath);
  assert.equal(isAbsolutePath("C:\\"), true);
  assert.equal(isAbsolutePath("d:/work"), true);
  assert.equal(isAbsolutePath("C:"), false, "a drive alone is its folder");
  assert.equal(
    isAbsolutePath("\\Users"),
    false,
    "no drive: it depends on where you are",
  );
  assert.deepEqual(segments(`${DRIVE}\\project\\app`), [
    "Users",
    "me",
    "project",
    "app",
  ]);
  assert.deepEqual(segments("c:/x//y/"), ["x", "y"]);
  assert.deepEqual(segments("C:\\a/b\\c"), ["a", "b", "c"]);
  assert.deepEqual(segments("C:\\"), []);
  assert.equal(base(`${DRIVE}\\project`), "project");
  assert.equal(base(`${DRIVE}\\`), "me", "a closing separator is not a name");
  assert.equal(base("C:\\"), "C:\\", "a root is its own name");
  assert.equal(parentOf(`${DRIVE}\\project`), DRIVE);
  assert.equal(parentOf(DRIVE), "C:\\Users");
  assert.equal(parentOf("C:\\Users"), "C:\\");
  assert.equal(parentOf("C:\\"), "C:\\", "a root is its own parent");
  assert.equal(
    parentOf("c:/x/y"),
    "c:/x",
    "the separators it was written with",
  );
  assert.equal(parentOf("C:\\a/b\\c"), "C:\\a/b");
  assert.equal(parentOf(`${DRIVE}\\`), "C:\\Users");
  assert.equal(parentOf("C:\\Users\\\\me"), "C:\\Users");
}

export async function aShareIsARootLikeADrive() {
  assert.equal(rootOf(`${SHARE}\\a`), `${SHARE}\\`);
  assert.equal(rootOf(SHARE), SHARE);
  assert.equal(isAbsolutePath(SHARE), true);
  assert.deepEqual(segments(`${SHARE}\\clients\\acme`), ["clients", "acme"]);
  assert.deepEqual(segments(SHARE), []);
  assert.equal(base(`${SHARE}\\clients`), "clients");
  assert.equal(base(SHARE), SHARE);
  assert.equal(parentOf(`${SHARE}\\clients\\acme`), `${SHARE}\\clients`);
  assert.equal(parentOf(`${SHARE}\\clients`), `${SHARE}\\`);
  assert.equal(parentOf(`${SHARE}\\`), `${SHARE}\\`);
  assert.equal(parentOf(SHARE), SHARE);
  // A server with no share is nothing to open.
  assert.equal(isAbsolutePath("\\\\nas"), false);
  assert.equal(isAbsolutePath("\\\\nas\\"), false);
}

export async function windowsPathsAreComparedWithoutCaseAndWithEitherSeparator() {
  assert.equal(pathKey("C:\\Users\\Me"), "c:/users/me");
  assert.equal(pathKey("c:/users/me/"), "c:/users/me");
  assert.equal(pathKey("C:\\"), "c:/");
  assert.equal(pathKey("\\\\NAS\\Files\\A"), "//nas/files/a");
  assert.equal(pathKey("\\\\NAS//Files"), "//nas/files/");
  assert.equal(pathKey("/Home/Me"), "/Home/Me", "a POSIX path keeps its case");
  assert.ok(within("c:/users/ME/project", DRIVE));
  assert.ok(within(DRIVE, `${DRIVE}\\`));
  assert.ok(within(`${DRIVE}\\`, DRIVE));
  assert.ok(within(DRIVE, "C:\\"));
  assert.ok(within("C:\\", "C:\\"));
  assert.ok(within("\\\\NAS\\files\\x", "\\\\nas\\Files"));
  assert.ok(within(`${SHARE}\\x`, `${SHARE}\\`));
  assert.ok(
    !within("C:\\Users\\mehmet", DRIVE),
    "a name that starts like another is not inside it",
  );
  assert.ok(!within("C:\\Users", DRIVE), "a parent is not inside its child");
  assert.ok(!within("D:\\Users\\me", DRIVE));
  assert.ok(!within(DRIVE, "D:\\"));
  assert.ok(!within("\\\\nas\\files2\\x", SHARE));
  assert.ok(!within(`${SHARE}\\x`, "\\\\nas\\other"));
  assert.ok(!within(`${SHARE}\\x`, "C:\\"));
  // A drive and a POSIX path never hold each other.
  assert.ok(!within("/home/me", "C:\\"));
  assert.ok(!within(DRIVE, "/"));
  assert.ok(!within("C:\\x", ""));
}

export async function theHomeFolderBecomesATildeOnAWindowsPathToo() {
  assert.equal(tilde(DRIVE, DRIVE), "~");
  assert.equal(tilde("c:/users/ME/", DRIVE), "~");
  assert.equal(tilde(`${DRIVE}\\project\\app`, DRIVE), "~\\project\\app");
  assert.equal(
    tilde("c:/users/me/project", DRIVE),
    "~/project",
    "the rest as written",
  );
  assert.equal(tilde("C:\\Users\\mehmet\\x", DRIVE), "C:\\Users\\mehmet\\x");
  assert.equal(tilde("D:\\work", DRIVE), "D:\\work");
  assert.equal(tilde(`${DRIVE}\\project`, `${DRIVE}\\`), "~\\project");
  assert.equal(tilde(undefined, DRIVE), "");
  assert.equal(tilde("/home/me/x", DRIVE), "/home/me/x");
  assert.equal(tilde(`${DRIVE}\\x`, "/home/me"), `${DRIVE}\\x`);
}

export async function pathsAreJoinedWithTheSeparatorTheFolderUses() {
  assert.equal(joinPath("/mnt", "backup", "archive"), "/mnt/backup/archive");
  assert.equal(joinPath("/", "a"), "/a");
  assert.equal(joinPath("/mnt/", "a"), "/mnt/a");
  assert.equal(joinPath("/mnt"), "/mnt");
  assert.equal(joinPath("D:\\", "backup", "archive"), "D:\\backup\\archive");
  assert.equal(joinPath(DRIVE, "x"), `${DRIVE}\\x`);
  assert.equal(joinPath(`${DRIVE}\\`, "x"), `${DRIVE}\\x`);
  assert.equal(joinPath("C:/Users/me", "x"), "C:/Users/me/x");
  assert.equal(joinPath(SHARE, "a", "b"), `${SHARE}\\a\\b`);
}

export async function aClosingSeparatorGoesButTheRootKeepsItsOwn() {
  assert.equal(trimSep("/mnt/x///"), "/mnt/x");
  assert.equal(trimSep("/mnt/x"), "/mnt/x");
  assert.equal(trimSep("/"), "/");
  assert.equal(trimSep("//"), "/");
  assert.equal(trimSep("~/"), "~");
  assert.equal(trimSep("D:\\work\\\\"), "D:\\work");
  assert.equal(trimSep("D:/work/"), "D:/work");
  assert.equal(trimSep("D:\\"), "D:\\");
  assert.equal(trimSep(`${SHARE}\\`), `${SHARE}\\`);
  assert.equal(trimSep(`${SHARE}\\a\\`), `${SHARE}\\a`);
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
  assert.equal(expandHome("~", DRIVE), DRIVE);
  assert.equal(expandHome("~/work", DRIVE), `${DRIVE}\\work`);
  assert.equal(expandHome("~\\work\\sub", DRIVE), `${DRIVE}\\work\\sub`);
  assert.equal(expandHome("~/a\\b//c", DRIVE), `${DRIVE}\\a\\b\\c`);
  assert.equal(expandHome("~/", DRIVE), DRIVE);
  assert.equal(expandHome("~work", DRIVE), "~work");
  assert.equal(expandHome("D:\\x", DRIVE), "D:\\x");
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

export async function breadcrumbsStartAtHomeThenAScannedFolderThenTheDrive() {
  const roots = ["D:\\work", "D:\\work\\clients"];
  assert.deepEqual(breadcrumbs(`${DRIVE}\\project\\app`, DRIVE, roots), [
    DRIVE,
    `${DRIVE}\\project`,
    `${DRIVE}\\project\\app`,
  ]);
  assert.deepEqual(breadcrumbs(DRIVE, DRIVE, roots), [DRIVE]);
  assert.deepEqual(breadcrumbs("D:\\work\\clients\\acme\\web", DRIVE, roots), [
    "D:\\work\\clients",
    "D:\\work\\clients\\acme",
    "D:\\work\\clients\\acme\\web",
  ]);
  assert.deepEqual(breadcrumbs("D:\\work\\other", DRIVE, roots), [
    "D:\\work",
    "D:\\work\\other",
  ]);
  assert.deepEqual(breadcrumbs("E:\\data\\x", DRIVE, roots), [
    "E:\\",
    "E:\\data",
    "E:\\data\\x",
  ]);
  assert.deepEqual(breadcrumbs("E:\\", DRIVE, roots), ["E:\\"]);
  assert.deepEqual(breadcrumbs(`${SHARE}\\a\\b`, DRIVE, []), [
    `${SHARE}\\`,
    `${SHARE}\\a`,
    `${SHARE}\\a\\b`,
  ]);
  assert.deepEqual(breadcrumbs(`${SHARE}\\a`, DRIVE, [SHARE]), [
    SHARE,
    `${SHARE}\\a`,
  ]);
  // Spelled another way, the trail goes on from the folder as the snapshot writes it.
  assert.deepEqual(breadcrumbs("c:/users/ME/x", DRIVE, []), [
    DRIVE,
    `${DRIVE}\\x`,
  ]);
  // A POSIX trail is not mistaken for a drive's.
  assert.deepEqual(breadcrumbs("/home/me/x", DRIVE, roots), [
    "/",
    "/home",
    "/home/me",
    "/home/me/x",
  ]);
}

export async function windowsReservedNamesAreNamed() {
  for (const name of [
    "con",
    "CON",
    "Prn",
    "aux",
    "NUL",
    "com1",
    "COM9",
    "lpt1",
    "LPT9",
    "com0",
    "con.txt",
    "aux.tar.gz",
    "Nul.md",
  ])
    assert.match(
      windowsNameProblem(name),
      new RegExp(
        `^Windows doesn't allow “${name.replace(/\./g, "\\.")}” as a folder name`,
      ),
      name,
    );
  for (const name of ["app.", "app ", "a..", "x. ", "con."])
    assert.match(
      windowsNameProblem(name),
      /can't end with a dot or a space/,
      name,
    );
  for (const name of [
    "my-app",
    "console",
    "connect",
    "com10",
    "lpt",
    "comx",
    "nulled",
    "aux1",
    "a.b",
    "con-x",
    "prn_",
    "CONFIG",
    "",
  ])
    assert.equal(windowsNameProblem(name), "", name);
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

export async function sessionsFindTheirProjectOnWindowsPaths() {
  const app = node("C:\\work\\app");
  const longer = node("C:\\work\\app2");
  const folder = node("C:\\work");
  const share = node(`${SHARE}\\proj`);
  const data = {
    home: DRIVE,
    nodes: {
      [app.id]: app,
      [longer.id]: longer,
      [folder.id]: folder,
      [share.id]: share,
    },
    claude: {},
    items: {},
    connectors: [],
    sessions: [
      session("nested", "C:\\work\\app\\src\\deep"),
      session("spelled", "c:/work/APP"),
      session("sibling", "C:\\work\\app2\\x"),
      session("parent", "C:\\work\\notes"),
      session("home", DRIVE),
      session("home-spelled", "c:/users/ME"),
      session("share", `${SHARE}\\proj\\sub`),
      session("elsewhere", "D:\\elsewhere\\deep"),
      session("nowhere", undefined),
    ],
  };
  const ids = (n) =>
    helpers
      .sessionsOf(n, data)
      .map((s) => s.sessionId)
      .sort();
  assert.deepEqual(ids(app), ["nested", "spelled"]);
  assert.deepEqual(ids(longer), ["sibling"], "app2 is not app");
  assert.deepEqual(ids(folder), ["parent"]);
  assert.deepEqual(ids(share), ["share"]);
  assert.deepEqual(
    helpers
      .globalSessions(data)
      .map((s) => s.sessionId)
      .sort(),
    ["elsewhere", "home", "home-spelled", "nowhere"],
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
  assert.equal(
    helpers.allSessions(
      claude("C:\\Users\\me\\.claude\\projects\\C--work-app", "C:\\work\\app"),
    )[0].file,
    "C:\\Users\\me\\.claude\\projects\\C--work-app\\abc.jsonl",
  );
}

export async function reportsAreFoundByProjectWhateverTheSpelling() {
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
  const data = {
    reports: [
      report("win.md", ["C:\\work\\app"]),
      report("posix.md", ["/work/app"]),
    ],
  };
  assert.deepEqual(
    helpers.reportsOfProject(data, "c:/WORK/app/").map((r) => r.id),
    ["win.md"],
  );
  assert.deepEqual(
    helpers.reportsOfProject(data, "C:\\work\\app").map((r) => r.id),
    ["win.md"],
  );
  assert.deepEqual(
    helpers.reportsOfProject(data, "/work/app").map((r) => r.id),
    ["posix.md"],
  );
  assert.deepEqual(
    helpers.reportsOfProject(data, "/WORK/app"),
    [],
    "POSIX keeps its case",
  );
  assert.equal(helpers.latestReport(data, "c:/work/app").id, "win.md");
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

/** The store's own parentOf, pathKey, segments and within, which only it can reach. */
function storeCopy() {
  const file = fileURLToPath(new URL("../../ui/src/store.ts", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "laci-paths-"));
  try {
    const copy = path.join(dir, "store.ts");
    writeFileSync(
      copy,
      `${readFileSync(file, "utf8")}\nexport const __paths = { parentOf, pathKey, segments, within };\n`,
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
    assert.equal(copy.pathKey(p), pathKey(p), `pathKey ${p}`);
    assert.deepEqual(copy.segments(p), segments(p), `segments ${p}`);
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

export async function cdOpensTheTreeDownToHomeOrTheRootOnWindows() {
  const roots = ["D:\\work", "\\\\nas\\files", "E:\\"];
  assert.deepEqual(opened(DRIVE, roots, `${DRIVE}\\project\\app`), [
    DRIVE,
    `${DRIVE}\\project`,
  ]);
  assert.deepEqual(opened(DRIVE, roots, "D:\\work\\clients\\acme"), [
    "D:\\work",
    "D:\\work\\clients",
  ]);
  // Spelled another way, the top is still the root as the snapshot writes it.
  assert.deepEqual(opened(DRIVE, roots, "d:/WORK/clients/acme"), [
    "D:\\work",
    "d:/WORK/clients",
  ]);
  assert.deepEqual(opened(DRIVE, roots, "c:/users/ME/project/x"), [
    DRIVE,
    "c:/users/ME/project",
  ]);
  assert.deepEqual(opened(DRIVE, roots, `${SHARE}\\a\\b`), [
    SHARE,
    `${SHARE}\\a`,
  ]);
  assert.deepEqual(opened(DRIVE, roots, `${SHARE}\\a`), [SHARE]);
  assert.deepEqual(opened(DRIVE, roots, "E:\\a\\b"), ["E:\\", "E:\\a"]);
  assert.deepEqual(opened(DRIVE, roots, "E:\\a"), ["E:\\"]);
  assert.deepEqual(
    opened(DRIVE, roots, "D:\\worker\\x"),
    [],
    "worker is not work",
  );
  assert.deepEqual(opened(DRIVE, roots, "F:\\x"), []);
  assert.deepEqual(opened(DRIVE, roots, DRIVE), []);
  // A drive that is its own parent must end the walk.
  assert.deepEqual(opened("E:\\", [], "E:\\a"), ["E:\\"]);
}
