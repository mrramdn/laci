// What reads a path in the interface once helpers.ts knows drives and shares: where a README's images
// are, which report a link names, and where a terminal starts.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const noop = () => {};

// ── README images ──────────────────────────────────────────────────────────────────────────────────

const { imageFile } = load("readme.ts", {
  "@tauri-apps/api/core": { convertFileSrc: (file) => `asset:${file}` },
  marked: { marked: { parse: () => "" } },
  dompurify: { default: { sanitize: () => "" } },
  "./store": { toast: noop, urlOpen: noop },
});

export async function aReadmeImageIsAFileInsideTheProject() {
  const project = "/home/me/proj";
  const at = (src) => imageFile(project, src);
  assert.equal(at("docs/a.png"), "/home/me/proj/docs/a.png");
  assert.equal(at("./a.png"), "/home/me/proj/a.png");
  assert.equal(at("a%20b.png"), "/home/me/proj/a b.png");
  assert.equal(at("docs/a.png?raw=true#top"), "/home/me/proj/docs/a.png");
  assert.equal(at("a//b.png"), "/home/me/proj/a/b.png");
  // A path may climb out and come back in.
  assert.equal(at("../proj/a.png"), "/home/me/proj/a.png");
  assert.equal(at("docs/../a.png"), "/home/me/proj/a.png");
}

export async function aReadmeImageNeverLeadsOutOfTheProject() {
  const projects = [
    "/home/me/proj",
    "C:\\Users\\me\\proj",
    "\\\\nas\\files\\proj",
  ];
  for (const project of projects)
    for (const src of [
      "../x.png",
      "../../etc/passwd",
      "docs/../../x.png",
      "/etc/passwd",
      "/x.png",
      "",
      ".",
      "docs/..%2F..%2Fx.png",
      "docs/%2e%2e/%2e%2e/x.png",
      "https://example.test/a.png",
      "file:///etc/x.png",
      "C:/x.png",
      "C:\\x.png",
      "javascript:alert(1)",
      "%",
    ])
      assert.equal(imageFile(project, src), undefined, `${project} ← ${src}`);
  // An encoded backslash separates names on Windows, and on POSIX it is a name.
  for (const project of projects.slice(1))
    assert.equal(
      imageFile(project, "docs/..%5C..%5Cx.png"),
      undefined,
      project,
    );
  assert.equal(
    imageFile(projects[0], "docs/..%5C..%5Cx.png"),
    "/home/me/proj/docs/..\\..\\x.png",
  );
}

export async function aReadmeImageIsFoundInAProjectOnADriveOrShare() {
  const at = (project, src) => imageFile(project, src);
  assert.equal(
    at("C:\\Users\\me\\proj", "docs/a.png"),
    "C:\\Users\\me\\proj\\docs\\a.png",
  );
  assert.equal(
    at("C:\\Users\\me\\proj", "docs\\a b.png"),
    "C:\\Users\\me\\proj\\docs\\a b.png",
    "a backslash in a README is a separator",
  );
  assert.equal(
    at("C:\\Users\\me\\proj", "../proj/a.png"),
    "C:\\Users\\me\\proj\\a.png",
  );
  assert.equal(
    at("C:\\Users\\Me\\Proj", "../proj/a.png"),
    "C:\\Users\\Me\\Proj\\a.png",
    "without case",
  );
  assert.equal(
    at("C:/Users/me/proj", "a.png"),
    "C:/Users/me/proj/a.png",
    "its own separator",
  );
  assert.equal(at("D:\\", "a.png"), "D:\\a.png");
  assert.equal(
    at("\\\\nas\\files\\proj", "a.png"),
    "\\\\nas\\files\\proj\\a.png",
  );
  // A name with a colon is a stream or a drive on Windows, and a plain name elsewhere.
  assert.equal(at("C:\\Users\\me\\proj", "docs/a:b.png"), undefined);
  assert.equal(
    at("/home/me/proj", "docs/a:b.png"),
    "/home/me/proj/docs/a:b.png",
  );
  // A folder that a link treats specially.
  assert.equal(
    at("/home/me/my #proj%/app", "docs/a.png"),
    "/home/me/my #proj%/app/docs/a.png",
  );
  assert.equal(at("/", "a.png"), "/a.png");
}

// ── A link in a report ─────────────────────────────────────────────────────────────────────────────

const { reportLink } = load("views/reports.tsx", {
  "../api": { api: noop, errorText: String },
  "../clock": { useNow: noop },
  "../common": {
    Expand: noop,
    Group: noop,
    Highlight: noop,
    Icon: noop,
    KindIcon: noop,
    Time: noop,
  },
  "../readme": { proseClick: noop, renderReadme: noop },
  "../store": {
    copyText: noop,
    goToProject: noop,
    markReportsSeen: noop,
    rescan: noop,
    run: noop,
    toast: noop,
    useApp: noop,
  },
});
const reports = ["other.md", "other x.md", "a\\b.md"].map((id) => ({ id }));
const link = (href, folder) => reportLink(href, reports, folder)?.id;

export async function aReportLinksToAnotherReportInItsOwnFolder() {
  const folder = "/home/me/notes/reports";
  assert.equal(link("other.md", folder), "other.md");
  assert.equal(link("./other.md", folder), "other.md");
  assert.equal(link("other.md#top", folder), "other.md");
  assert.equal(link("other%20x.md", folder), "other x.md");
  assert.equal(link(`${folder}/other.md`, folder), "other.md");
  assert.equal(link("sub/other.md", folder), undefined);
  assert.equal(link("../other.md", folder), undefined);
  assert.equal(link("missing.md", folder), undefined);
  // On POSIX a backslash is part of a name.
  assert.equal(link("a\\b.md", folder), "a\\b.md");
}

export async function aWindowsReportMayWriteItsLinksWithBackslashes() {
  const folder = "C:\\notes\\reports";
  assert.equal(link("other.md", folder), "other.md");
  assert.equal(link("./other.md", folder), "other.md");
  assert.equal(link(".\\other.md", folder), "other.md");
  assert.equal(link("sub\\other.md", folder), undefined);
  assert.equal(link("..\\other.md", folder), undefined);
  assert.equal(link("other%20x.md", folder), "other x.md");
}

// ── Where a terminal starts ────────────────────────────────────────────────────────────────────────

/** terminal-api.ts with the desktop's reply stubbed, and the app state it is to read. */
function terminals(state) {
  const calls = [];
  const exports = load("terminal-api.ts", {
    "@tauri-apps/api/core": {
      invoke: async (command, args) => {
        calls.push([command, args]);
        return { id: "t1", cwd: args.id ?? "", title: "shell" };
      },
    },
    "./store": {
      run: (work) => work(),
      useApp: { getState: () => state, setState: noop },
    },
  });
  return { ...exports, calls };
}

export async function aTerminalOpensInTheFolderOfTheSelectedFile() {
  const opened = (state) => {
    const { toggleTerminal, calls } = terminals(state);
    toggleTerminal();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "term_open");
    return calls[0][1].id;
  };
  const none = { selected: null, cwd: "" };
  assert.equal(
    opened({ ...none, fileSelected: "/home/me/proj/notes.txt" }),
    "/home/me/proj",
  );
  assert.equal(opened({ ...none, fileSelected: "/notes.txt" }), "/");
  assert.equal(
    opened({ ...none, fileSelected: "C:\\Users\\me\\proj\\notes.txt" }),
    "C:\\Users\\me\\proj",
  );
  assert.equal(opened({ ...none, fileSelected: "C:\\notes.txt" }), "C:\\");
  assert.equal(
    opened({ ...none, fileSelected: "c:/Users/me/proj/notes.txt" }),
    "c:/Users/me/proj",
  );
  assert.equal(
    opened({ ...none, fileSelected: "\\\\nas\\files\\a\\notes.txt" }),
    "\\\\nas\\files\\a",
  );
  // With no file, the selected project or the folder shown.
  assert.equal(
    opened({ fileSelected: null, selected: "C:\\work\\app", cwd: "C:\\work" }),
    "C:\\work\\app",
  );
  assert.equal(
    opened({ fileSelected: null, selected: null, cwd: "D:\\work" }),
    "D:\\work",
  );
  assert.equal(opened({ fileSelected: null, selected: null, cwd: "" }), null);
}
