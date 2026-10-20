// Opens the browser preview (ui/preview.html) in a real browser and checks the interface from the
// outside: every screen draws without an error and, when asked, how it differs from another commit,
// what axe finds, whether it scrolls sideways and whether Simple keeps its layout rules.
//
// Every shot is a fresh session at a fixed size, theme, locale (en-GB) and time (the fixtures'
// clock, held still), with motion off and the fonts loaded, so two runs of the same code give the
// same pixels. The preview is built as the app is (vite build) and served from a folder.
// Usage: node scripts/ui-preview-check.mjs [options]; --help lists them.
//
// Simple's screens are driven by what a person sees: the five places Home, Projects, AI helpers,
// Clean up and Activity in the sidebar, Settings at its foot, and a project found with the palette,
// whose ⋯ More holds Archive, Delete and Free up space. Its checks lean on two hooks that the shell
// gives (ui:S1):
//   data-ui="primary"  the one filled button of a screen (`.btn.primary` counts too)
//   data-ui="status"   every status chip: an svg, img or [data-icon] inside, and words
// A build without Simple's shell skips `--design simple`. AI helpers shows the reports screen as its
// Summaries tab. Change the `designs.simple` table when the DOM it relies on changes.
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export const DESIGNS = ["detailed", "simple"];
export const THEMES = ["light", "dark"];
export const SCREENS = [
  "today",
  "folder",
  "tidy",
  "agents",
  "reports",
  "log",
  "settings",
  "project",
  "palette",
  "archive",
  "delete",
  "clean",
];
/** The first width of each of Simple's tiers, and the window the app opens in. All 900 high. */
export const SIZES = ["720x900", "840x900", "1200x900", "1440x900", "1600x900"];

const defaultJobs = () => Math.max(1, Math.min(3, os.availableParallelism() - 1));
const USAGE = `Usage: node scripts/ui-preview-check.mjs [options]

A shot is a screen at a size in a theme, in a design. With no mode below, each is only checked
for drawing without an error, and the screenshots are kept.

  --design <list>    ${DESIGNS.join(", ")} (default: both; Simple is skipped until its shell draws)
  --screens <list>   ${SCREENS.join(", ")}
  --widths <list>    720,840,1200,1440,1600 (default), or WxH for another height: 720x560
  --themes <list>    ${THEMES.join(", ")} (default: both)
  --out <dir>        keep the screenshots here (default: node_modules/.cache/laci-preview-check/shots,
                     started again each run; none when only --axe, --overflow or --rules ask)
  --compare <ref>    build the preview from <ref> in a temporary git worktree and from the working
                     tree, shoot both and diff them: <dir>/ref, <dir>/new and <dir>/diff. Any
                     changed pixel fails.
  --axe              inject axe-core. Serious and critical findings fail Simple; Detailed is only
                     reported
  --overflow         fails when the document, or a box that scrolls by itself such as a sidebar,
                     scrolls sideways
  --scrollbars       scrollbars that take room, as GTK's classic ones do (GTK_OVERLAY_SCROLLING=0).
                     Headless Chromium hides them otherwise, so a page looks as with GTK's
                     default ones, which float
  --rules            Simple only: one filled button per screen, no text under 13 px, an icon and
                     words on every status, targets of at least 24x24 px
  --strict           a screen that Simple does not show yet fails, instead of being skipped
  --jobs <n>         shots at a time (default: ${defaultJobs()})
  --browser <path>   a Chromium (or set LACI_BROWSER)
  --help`;

export class UsageError extends Error {}

// --- Options ------------------------------------------------------------------------------------

/** `720` or `720x560` as a window size; a bare width is 900 high. */
export function parseSize(text) {
  const match = /^(\d{3,4})(?:x(\d{3,4}))?$/.exec(text);
  if (!match) throw new UsageError(`"${text}" is not a size: write 720 or 720x560`);
  return { width: Number(match[1]), height: Number(match[2] ?? 900) };
}

function pick(flag, value, allowed) {
  const items = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  const wrong = items.find((item) => !allowed.includes(item));
  if (!items.length || wrong)
    throw new UsageError(
      `${flag}: ${wrong ? `"${wrong}" is not` : "give"} one of ${allowed.join(", ")}`,
    );
  return items;
}

/** The options of a command line, with the defaults filled in. Throws a UsageError for a bad one. */
export function parseArgs(argv) {
  const options = {
    design: [...DESIGNS],
    screens: [...SCREENS],
    sizes: SIZES.map(parseSize),
    themes: [...THEMES],
    out: undefined,
    compare: undefined,
    axe: false,
    overflow: false,
    scrollbars: false,
    rules: false,
    strict: false,
    jobs: defaultJobs(),
    browser: undefined,
    help: false,
  };
  const switches = ["axe", "overflow", "scrollbars", "rules", "strict", "help"];
  const valued = ["design", "screens", "widths", "themes", "out", "compare", "jobs", "browser"];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!name) throw new UsageError(`Unexpected "${argv[i]}"`);
    if (switches.includes(name)) {
      options[name] = true;
      continue;
    }
    if (!valued.includes(name)) throw new UsageError(`Unknown option ${flag}`);
    const value = inline ?? argv[++i];
    // Another option where the value should be: the value is missing.
    if (value === undefined || value === "" || (inline === undefined && value.startsWith("--")))
      throw new UsageError(`${flag} needs a value`);
    if (name === "design") options.design = pick(flag, value, DESIGNS);
    else if (name === "screens") options.screens = pick(flag, value, SCREENS);
    else if (name === "themes") options.themes = pick(flag, value, THEMES);
    else if (name === "widths")
      options.sizes = [...new Set(value.split(",").filter(Boolean))].map(parseSize);
    else if (name === "jobs") {
      options.jobs = Number(value);
      if (!Number.isInteger(options.jobs) || options.jobs < 1)
        throw new UsageError("--jobs needs a whole number, 1 or more");
    } else options[name] = value;
  }
  return options;
}

/** Every shot of `designs`: a design, theme, size and screen. */
export function shotsOf(options, designs = options.design) {
  const shots = [];
  for (const design of designs)
    for (const theme of options.themes)
      for (const size of options.sizes)
        for (const screen of options.screens) shots.push({ design, theme, size, screen });
  return shots;
}
export const nameOf = ({ design, theme, size, screen }) =>
  `${screen} ${design} ${theme} ${size.width}x${size.height}`;
export const fileOf = (shot) => `${nameOf(shot).replaceAll(" ", "-")}.png`;

export function findBrowser(explicit) {
  return [
    explicit,
    process.env.LACI_BROWSER,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].find((candidate) => candidate && existsSync(candidate));
}

// --- A folder as a site, and a build in it ------------------------------------------------------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Serves `dir` on a free local port, and nothing outside it. Resolves to `{ url, close }`. */
export function serve(dir) {
  const base = path.resolve(dir);
  const server = http.createServer((request, response) => {
    let file = "";
    try {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      file = path.join(base, decodeURIComponent(pathname));
    } catch {
      /* An address that cannot be read is not found. */
    }
    if (!file.startsWith(base + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}

/** Builds ui/preview.html of the checkout `tree` into `outDir`, with that checkout's own Vite. */
export async function buildPreview(tree, outDir) {
  const input = path.join(tree, "ui", "preview.html");
  if (!existsSync(input))
    throw new UsageError(`${tree} has no ui/preview.html: it is older than the browser preview`);
  const need = createRequire(path.join(tree, "ui", "package.json"));
  let viteFile;
  try {
    viteFile = need.resolve("vite");
  } catch {
    throw new UsageError(`${tree} has no Vite in ui/node_modules: run pnpm install there`);
  }
  const vite = await import(pathToFileURL(viteFile).href);
  await vite.build({
    root: path.join(tree, "ui"),
    logLevel: "error",
    build: { outDir, emptyOutDir: true, rollupOptions: { input } },
  });
}

function git(args) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.trim();
}

/** The time the fixtures were made for. */
function fixtureNow(tree) {
  try {
    const file = path.join(tree, "ui", "src", "preview", "fixtures.json");
    return new Date(JSON.parse(readFileSync(file, "utf8")).meta.now);
  } catch {
    return new Date("2026-10-08T09:00:00.000Z");
  }
}

// --- Screens ------------------------------------------------------------------------------------

/** A project the fixtures have health, an archive plan and to-dos for. */
const PROJECT = "acme-store";
/** The project with downloaded packages to delete: Free up space is offered for it. */
const HEAVY = "habit-app";
/** A folder with two projects in it. */
const FOLDER = "clients";

const startingWith = (text) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const heading = (page, name, level = 1) => page.getByRole("heading", { level, name }).first();

async function openPalette(page, query = "") {
  await page.keyboard.press("Control+k");
  await page.locator("#pal-in").waitFor();
  if (query) await page.locator("#pal-in").fill(query);
}
/** Waits for a dialog to have what it asked the engine for. */
async function dialogShown(page) {
  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor();
  await dialog.getByText(/^(Checking|Loading)/).waitFor({ state: "detached" });
}

const detailedNav = (label) => async (page) => {
  await page.locator("#side .sb-item").filter({ hasText: startingWith(label) }).first().click();
  await heading(page, label).waitFor();
};
async function detailedProject(page, name = PROJECT) {
  await openPalette(page, name.slice(0, 4));
  await page.getByRole("option", { name: startingWith(name) }).click();
  await heading(page, name, 2).waitFor();
}

const SIMPLE_PLACES = [
  "nav a",
  "nav button",
  "aside a",
  "aside button",
  "[role=navigation] a",
  "[role=navigation] button",
].join(", ");
const simplePlace = (page, label) =>
  page.locator(SIMPLE_PLACES).filter({ hasText: startingWith(label) }).first();
const simpleNav = (label, then) => async (page) => {
  await simplePlace(page, label).click();
  await page
    .locator('[aria-current="page"]')
    .filter({ hasText: startingWith(label) })
    .first()
    .waitFor();
  await then?.(page);
};
async function simpleProject(page, name = PROJECT) {
  await openPalette(page, name.slice(0, 4));
  await page.getByRole("option", { name: startingWith(name) }).click();
  await heading(page, name).waitFor();
}
/** Picks `item` in the project's ⋯ More, and waits for its sheet to have its plan. */
async function simpleMore(page, item) {
  await page.getByRole("button", { name: /^(⋯|More)/ }).first().click();
  await page.getByRole("menuitem", { name: startingWith(item) }).click();
  await dialogShown(page);
}

/**
 * How each design gets to each screen from the page it draws first. `home` is what shows once the
 * design has drawn at all. A screen's function ends when the screen is up.
 */
const designs = {
  detailed: {
    home: (page) => heading(page, "Today"),
    screens: {
      today: async () => {},
      // The palette lists projects first, so pick the folder itself.
      folder: async (page) => {
        await openPalette(page, FOLDER);
        await page
          .getByRole("option", { name: new RegExp(`^${FOLDER}\\s+~/project/${FOLDER}`) })
          .click();
        await heading(page, FOLDER).waitFor();
      },
      tidy: detailedNav("Tidy up"),
      agents: detailedNav("Agents"),
      reports: detailedNav("Reports"),
      log: detailedNav("Log"),
      settings: detailedNav("Settings"),
      project: detailedProject,
      palette: (page) => openPalette(page),
      archive: async (page) => {
        await detailedProject(page);
        await page.locator("#insp").getByRole("button", { name: "Archive" }).click();
        await dialogShown(page);
      },
      delete: async (page) => {
        await detailedProject(page);
        await page.locator("#insp").getByRole("button", { name: "Move to Trash" }).click();
        await dialogShown(page);
      },
      clean: async (page) => {
        await detailedProject(page, HEAVY);
        await page.locator("#insp").getByRole("button", { name: "Delete build output…" }).click();
        await dialogShown(page);
      },
    },
  },
  // The five places, Settings, and a project's Archive, Delete and Free up space sheets through
  // ⋯ More (ui:S1, ui:20).
  simple: {
    // Detailed has a "Home" in its Places, so look for a place that only Simple has.
    home: (page) => simplePlace(page, "AI helpers"),
    screens: {
      today: async () => {},
      folder: simpleNav("Projects"),
      // Clean up and Activity ask the engine for the space Laci uses and the log once they show.
      tidy: simpleNav("Clean up", (page) =>
        page.getByText(/^Reading the space Laci uses/).waitFor({ state: "detached" }),
      ),
      agents: simpleNav("AI helpers", (page) => heading(page, "AI helpers").waitFor()),
      // The newest summary opens beside the list, on a wide window, once its text is read.
      reports: simpleNav("AI helpers", async (page) => {
        await page.getByRole("tab", { name: startingWith("Summaries") }).click();
        await page.getByText("Reading the summary…").first().waitFor({ state: "detached" });
      }),
      log: simpleNav("Activity", (page) =>
        page.getByText(/^Reading Activity/).waitFor({ state: "detached" }),
      ),
      settings: simpleNav("Settings", (page) =>
        page.getByText("Reading your settings…").first().waitFor({ state: "detached" }),
      ),
      project: simpleProject,
      palette: (page) => openPalette(page),
      archive: async (page) => {
        await simpleProject(page);
        await simpleMore(page, "Archive");
      },
      delete: async (page) => {
        await simpleProject(page);
        await simpleMore(page, "Delete");
      },
      clean: async (page) => {
        await simpleProject(page, HEAVY);
        await simpleMore(page, "Free up space");
      },
    },
  },
};

// --- What runs in the page ----------------------------------------------------------------------
// These are sent to the browser as text, so each stands alone: nothing outside it may be used.

/** Resolves when the page has not changed for `quietMs`, or after `maxMs`. */
export function untilQuiet([quietMs, maxMs]) {
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    timer = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
  });
}

/**
 * Waits for the fonts. Text drawn for the first time asks for its font only after layout, so this
 * looks again until none is loading. Returns the names of the fonts that failed.
 */
export async function untilFonts() {
  const frames = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (let round = 0; round < 5; round++) {
    await frames();
    await document.fonts.ready;
    if (document.fonts.status === "loaded") break;
  }
  return [...document.fonts].filter((face) => face.status === "error").map((face) => face.family);
}

/** How much wider the document is than the window, and what reaches past the edge. */
export function measureOverflow() {
  const html = document.documentElement;
  const scrollWidth = Math.max(html.scrollWidth, document.body.scrollWidth);
  const clientWidth = html.clientWidth;
  const offenders = [];
  if (scrollWidth > clientWidth)
    for (const el of document.body.querySelectorAll("*")) {
      const box = el.getBoundingClientRect();
      if (!box.width || box.right <= clientWidth + 0.5) continue;
      const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/) : [];
      const named = classes.filter(Boolean).slice(0, 2).join(".");
      offenders.push(
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${named ? `.${named}` : ""}` +
          ` ends at ${Math.round(box.right)} px`,
      );
      if (offenders.length === 5) break;
    }
  return { scrollWidth, clientWidth, offenders };
}

/**
 * The boxes that scroll sideways by themselves, as a sidebar does when its own scrollbar squeezes
 * it: `{ where, scrollWidth, clientWidth }` for the first five. The document is measureOverflow's.
 * Code keeps its lines, a text field scrolls its own text and the terminal is its own, so those are
 * left out, as desktop-smoke leaves them out of its check of a narrow window.
 */
export function measureBoxes() {
  const found = [];
  for (const box of document.body.querySelectorAll("*")) {
    if (box.closest("pre, code, input, textarea, select, .xterm")) continue;
    if (!box.getClientRects().length) continue;
    if (!["auto", "scroll"].includes(getComputedStyle(box).overflowX)) continue;
    if (box.scrollWidth <= box.clientWidth + 1) continue;
    const classes = typeof box.className === "string" ? box.className.trim().split(/\s+/) : [];
    const named = classes.filter(Boolean).slice(0, 2).join(".");
    found.push({
      where: `${box.tagName.toLowerCase()}${box.id ? `#${box.id}` : ""}${named ? `.${named}` : ""}`,
      scrollWidth: box.scrollWidth,
      clientWidth: box.clientWidth,
    });
    if (found.length === 5) break;
  }
  return found;
}

/**
 * Simple's layout rules for what is on screen: when a dialog is open it is all there is. Returns
 * `{ rule, text, where }` for each break.
 */
export function pageRules() {
  const found = [];
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const describe = (el) => {
    const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/) : [];
    const named = classes.filter(Boolean).slice(0, 2).join(".");
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${named ? `.${named}` : ""}`;
  };
  // A page can break one rule many times: the first 20 of each are listed, and the rest counted.
  const seen = {};
  const add = (rule, el, text) => {
    seen[rule] = (seen[rule] ?? 0) + 1;
    if (seen[rule] <= 20)
      found.push({ rule, text, where: `${describe(el)} "${words(el).slice(0, 30)}"` });
  };
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.visibility !== "visible" || Number(style.opacity) === 0) return false;
    // A box of one pixel is how text is left to a screen reader alone.
    const box = el.getBoundingClientRect();
    return box.width > 1 || box.height > 1;
  };
  const modal = [...document.querySelectorAll('[aria-modal="true"], dialog[open]')]
    .filter(visible)
    .pop();
  const scope = modal ?? document.body;
  const live = (el) => scope.contains(el) && !el.closest("[inert]");
  const shown = (el) => live(el) && visible(el);

  // One filled button.
  const primary = [...scope.querySelectorAll('[data-ui="primary"], .btn.primary')].filter(shown);
  if (primary.length > 1) {
    const names = primary.map((el) => `"${words(el)}"`).join(", ");
    add("one-primary", primary[1], `${primary.length} filled buttons: ${names}`);
  }

  // Text of at least 13 px.
  const small = new Map();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.nodeValue.trim() || small.has(el)) continue;
    if (el.closest("svg, script, style, noscript, template") || !shown(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 12.99) small.set(el, size);
  }
  const fields = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select";
  for (const el of scope.querySelectorAll(fields)) {
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (shown(el) && size < 12.99) small.set(el, size);
  }
  for (const [el, size] of small)
    add("text-size", el, `${Math.round(size * 10) / 10} px, under 13 px`);

  // An icon and words on every status.
  for (const el of scope.querySelectorAll('[data-ui="status"]')) {
    if (!shown(el)) continue;
    if (!el.querySelector('svg, img, [data-icon], [role="img"]'))
      add("status", el, "a status needs an icon");
    if (!/\p{L}{2,}/u.test(words(el))) add("status", el, "a status needs words");
  }

  // Targets of at least 24 x 24 px.
  const roles = "button link tab menuitem menuitemcheckbox menuitemradio switch checkbox radio";
  const targets = [
    "a[href]",
    "button",
    'input:not([type="hidden"])',
    "select",
    "textarea",
    "summary",
    ...`${roles} combobox option treeitem`.split(" ").map((role) => `[role="${role}"]`),
  ].join(",");
  for (const el of scope.querySelectorAll(targets)) {
    if (!live(el) || el.matches(':disabled, [aria-disabled="true"]')) continue;
    // A checkbox or radio drawn by its label is clicked on the label.
    const box = visible(el) ? el : [...(el.labels ?? [])].find((label) => visible(label));
    if (!box) continue;
    // A link inside a sentence is as big as its text.
    const inline = box.matches("a[href]") && getComputedStyle(box).display === "inline";
    if (inline && words(box.parentElement) !== words(box)) continue;
    const { width, height } = box.getBoundingClientRect();
    if (width < 23.5 || height < 23.5)
      add("target", el, `${Math.round(width)}x${Math.round(height)} px, under 24x24`);
  }
  for (const [rule, n] of Object.entries(seen))
    if (n > 20) found.push({ rule, text: `and ${n - 20} more`, where: "" });
  return found;
}

/** axe's violations on the page: `{ id, impact, help, nodes: [selector] }`. */
export async function runAxe(tags) {
  const result = await window.axe.run(document, {
    runOnly: { type: "tag", values: tags },
    resultTypes: ["violations"],
  });
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
}
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

// --- A shot -------------------------------------------------------------------------------------

const BOOT_MS = 20_000;
const STEP_MS = 8_000;

/**
 * Opens one screen in a fresh session and measures it as `want` says. Returns what it found:
 * `{ png, problems, overflow, rules, axe }`, or `failed` with why the screen did not show.
 */
export async function visitPage({ browser, side, shot, want, axePath, stepMs = STEP_MS }) {
  const found = {
    png: null,
    problems: [],
    overflow: null,
    rules: null,
    axe: null,
    failed: null,
    failure: null,
  };
  const context = await browser.newContext({
    viewport: shot.size,
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "UTC",
    colorScheme: shot.theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  // Loading, the picture and the checks may take as long as a busy machine needs. Only the steps
  // to a screen have a short limit: a screen that is not there should fail soon.
  page.setDefaultTimeout(BOOT_MS);
  const problem = (text) => found.problems.push(text);
  page.on("console", (message) => {
    // The response below has the address.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
      problem(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => problem(`page error: ${error.message}`));
  page.on(
    "response",
    (response) => response.status() >= 400 && problem(`${response.status()} ${response.url()}`),
  );
  try {
    const design = designs[shot.design];
    // The preview's clock starts at the fixtures' time. Holding Date still keeps "just now" and
    // "3 minutes ago" from changing between two shots.
    await page.clock.setFixedTime(side.now);
    await page.goto(`${side.url}/preview.html?design=${shot.design}&theme=${shot.theme}`);
    await design.home(page).waitFor({ timeout: BOOT_MS });
    page.setDefaultTimeout(stepMs);
    await design.screens[shot.screen](page);
    page.setDefaultTimeout(BOOT_MS);
    for (const font of await page.evaluate(untilFonts)) problem(`font failed to load: ${font}`);
    // The page is what the address asked for, and its clock stands where it was set.
    const state = await page.evaluate(() => ({ ...document.documentElement.dataset, now: Date.now() }));
    for (const [key, wanted] of Object.entries({ design: shot.design, theme: shot.theme }))
      if (state[key] !== wanted) problem(`<html> has data-${key}=${state[key]}, wanted ${wanted}`);
    if (state.now !== side.now.getTime()) problem("the clock is not held at the time of the fixtures");
    await page.evaluate(untilQuiet, [250, 5_000]);
    // A pointer left over a button would draw it hovered.
    await page.mouse.move(-1, -1);
    if (want.shoot) found.png = await page.screenshot({ animations: "disabled" });
    if (want.overflow)
      found.overflow = {
        ...(await page.evaluate(measureOverflow)),
        boxes: await page.evaluate(measureBoxes),
      };
    if (want.rules) found.rules = await page.evaluate(pageRules);
    if (want.axe) {
      await page.addScriptTag({ path: axePath });
      found.axe = await page.evaluate(runAxe, AXE_TAGS);
    }
  } catch (error) {
    found.failed = error.message.split("\n")[0];
    page.setDefaultTimeout(BOOT_MS);
    found.failure = await page.screenshot().catch(() => null);
  } finally {
    await context.close();
  }
  return found;
}

/** Whether `design` draws in `side`: "yes", "no" (the build has no such shell) or "broken". */
export async function probe({ browser, side, design }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.clock.setFixedTime(side.now);
    await page.goto(`${side.url}/preview.html?design=${design}&theme=light`);
    const drawn = designs[design].home(page).waitFor({ timeout: BOOT_MS }).then(() => "yes");
    // A build without a Simple shell draws Detailed when asked for Simple.
    const instead =
      design === "simple"
        ? designs.detailed.home(page).waitFor({ timeout: BOOT_MS }).then(() => "no")
        : new Promise(() => {});
    return await Promise.race([drawn, instead]).catch(() => "broken");
  } finally {
    await context.close();
  }
}

// --- Pixels -------------------------------------------------------------------------------------

/** Finds packages the way the interface does: in ui/node_modules. */
const requireUi = createRequire(path.join(root, "ui", "package.json"));

/** pngjs and pixelmatch, from ui/node_modules. */
export async function loadPixels() {
  const pixelmatch = await import(pathToFileURL(requireUi.resolve("pixelmatch")).href);
  return { PNG: requireUi("pngjs").PNG, pixelmatch: pixelmatch.default };
}

/**
 * The pixels that differ between two PNGs (any difference counts), and an image of where, or none
 * when they are the same. Images of two sizes differ in every pixel.
 */
export function diffImages(first, second, { PNG, pixelmatch }) {
  if (first.equals(second)) return { changed: 0, diff: null };
  const a = PNG.sync.read(first);
  const b = PNG.sync.read(second);
  if (a.width !== b.width || a.height !== b.height)
    return {
      changed: Math.max(a.width * a.height, b.width * b.height),
      diff: null,
      resized: `${a.width}x${a.height} became ${b.width}x${b.height}`,
    };
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: 0,
    includeAA: true,
    alpha: 0.25,
  });
  return { changed, diff: changed ? PNG.sync.write(diff) : null };
}

// --- The run ------------------------------------------------------------------------------------

const count = (n, word) => `${n.toLocaleString("en-GB")} ${word}${n === 1 ? "" : "s"}`;
const duration = (ms) =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(1)} s`
    : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/**
 * Where a run keeps what it makes. Beside the packages that pnpm links from its store, so that the
 * install of a checkout is links and not copies, and on the disk of the checkout, not in /tmp.
 */
const CACHE = path.join(root, "node_modules", ".cache", "laci-preview-check");

/**
 * What the run stands on: the working tree and, for --compare, a checkout of the commit, each
 * built and served. Returns `[ref?, new]`.
 */
async function prepare(options, onExit) {
  mkdirSync(CACHE, { recursive: true });
  // A run that was killed leaves its folder, and its worktree registered with git. Clear the ones
  // from long ago.
  for (const name of readdirSync(CACHE).filter((entry) => entry.startsWith("run-"))) {
    const old = path.join(CACHE, name);
    if (Date.now() - statSync(old).mtimeMs < 2 * 60 * 60 * 1000) continue;
    spawnSync("git", ["worktree", "remove", "--force", path.join(old, "checkout")], { cwd: root });
    rmSync(old, { recursive: true, force: true });
  }
  const scratch = mkdtempSync(path.join(CACHE, "run-"));
  onExit(() => rmSync(scratch, { recursive: true, force: true }));
  const trees = [{ name: "new", label: "the working tree", tree: root }];
  if (options.compare) {
    let sha;
    try {
      sha = git(["rev-parse", "--verify", "--quiet", `${options.compare}^{commit}`]);
    } catch {
      throw new UsageError(`--compare ${options.compare}: not a commit in this repository`);
    }
    const checkout = path.join(scratch, "checkout");
    // Only this run's worktree is removed: a repository-wide prune would forget other worktrees that are
    // just out of reach for a while, such as one on a drive that isn't mounted.
    git(["worktree", "add", "--detach", "--quiet", checkout, sha]);
    onExit(() => {
      spawnSync("git", ["worktree", "remove", "--force", checkout], { cwd: root });
    });
    console.log(`Installing ${options.compare} (${sha.slice(0, 7)}) in a temporary worktree…`);
    const install = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: checkout,
      encoding: "utf8",
    });
    if (install.status !== 0)
      throw new Error(
        `pnpm install failed in the worktree:\n${install.error ?? ""}${install.stdout}${install.stderr}`,
      );
    trees.unshift({ name: "ref", label: `${options.compare} (${sha.slice(0, 7)})`, tree: checkout });
  }
  for (const side of trees) {
    console.log(`Building the preview from ${side.label}…`);
    const dir = path.join(scratch, `build-${side.name}`);
    await buildPreview(side.tree, dir);
    const server = await serve(dir);
    onExit(() => server.close());
    Object.assign(side, { url: server.url, now: fixtureNow(side.tree) });
  }
  return trees;
}

/**
 * What each design draws in each side: the designs that draw everywhere, and the rest. `look` asks
 * whether one design draws in one side; a test gives it another.
 */
export async function drawing({ browser, trees, designs: asked, problems, notes, look = probe }) {
  const drawn = [];
  for (const design of asked) {
    const verdicts = [];
    for (const side of trees) verdicts.push(await look({ browser, side, design }));
    const where = (verdict) =>
      trees.filter((_, i) => verdicts[i] === verdict).map((side) => side.label).join(" and ");
    if (verdicts.every((verdict) => verdict === "yes")) drawn.push(design);
    else if (verdicts.includes("broken"))
      problems.push(`${design} did not draw in ${where("broken")}`);
    else notes.add(`${design}: skipped, there is no shell for it in ${where("no")} yet`);
  }
  return drawn;
}

/**
 * Takes the shots, and gathers what they find into `report`. `visit` opens one screen; a test
 * gives it another.
 */
export async function takeShots({
  options,
  want,
  out,
  trees,
  browser,
  axePath,
  pixels,
  shots,
  problems,
  notes,
  visit = visitPage,
}) {
  const report = {
    compare: new Map(),
    axe: new Map(),
    overflow: [],
    rules: [],
    missing: new Map(),
    changed: 0,
  };
  const several = trees.length > 1;
  const save = (side, shot, png) => {
    const folder = options.compare ? path.join(out, side.name) : out;
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, fileOf(shot)), png);
  };
  // A picture of a screen that did not show goes beside the screenshots, or else to a folder of its
  // own. Returns where.
  const failures = out ?? path.join(CACHE, "failed");
  if (!out) rmSync(failures, { recursive: true, force: true });
  const keep = (side, shot, png) => {
    mkdirSync(failures, { recursive: true });
    const file = path.join(failures, `failed-${side.name}-${fileOf(shot)}`);
    writeFileSync(file, png);
    return file;
  };
  // A Simple screen that failed to show: the rest of its shots are not tried.
  const gone = new Set();
  let done = 0;

  async function take(shot) {
    const key = `${shot.design} ${shot.screen}`;
    if (gone.has(key)) return;
    const found = {};
    for (const side of trees) {
      const mine = side.name === "new";
      const asks = {
        shoot: want.shoot,
        axe: want.axe && mine,
        overflow: want.overflow && mine,
        rules: want.rules && mine && shot.design === "simple",
      };
      // Simple may lack the screen; anything else is tried once more, as a step can time out
      // when the machine is busy.
      const optional = shot.design === "simple" && !options.strict;
      let result = await visit({ browser, side, shot, want: asks, axePath });
      if (result.failed && !optional)
        result = await visit({ browser, side, shot, want: asks, axePath });
      found[side.name] = result;
      const where = `${nameOf(shot)}${several ? ` in ${side.label}` : ""}`;
      if (result.failed) {
        if (optional) {
          gone.add(key);
          report.missing.set(key, result.failed);
        } else {
          const picture = result.failure ? ` (picture: ${keep(side, shot, result.failure)})` : "";
          problems.push(`${where}: the screen did not show: ${result.failed}${picture}`);
        }
      } else if (mine)
        for (const text of new Set(result.problems)) problems.push(`${where}: ${text}`);
      // What the older build logs is not for this change to fix, but it is worth knowing.
      else for (const text of new Set(result.problems)) notes.add(`${where}: ${text}`);
      if (result.png && out) save(side, shot, result.png);
    }
    const { ref, new: now } = found;
    if (ref?.png && now.png) {
      const verdict = diffImages(ref.png, now.png, pixels);
      const row = report.compare.get(shot.screen) ?? { shots: 0, changed: 0, pixels: 0, files: [] };
      row.shots++;
      if (verdict.changed) {
        row.changed++;
        row.pixels += verdict.changed;
        report.changed++;
        const file = fileOf(shot);
        if (verdict.diff) {
          mkdirSync(path.join(out, "diff"), { recursive: true });
          writeFileSync(path.join(out, "diff", file), verdict.diff);
        }
        row.files.push(`${file}: ${verdict.resized ?? count(verdict.changed, "pixel")}`);
      }
      report.compare.set(shot.screen, row);
    }
    if (
      now.overflow &&
      (now.overflow.scrollWidth > now.overflow.clientWidth || now.overflow.boxes?.length)
    )
      report.overflow.push({ shot, ...now.overflow });
    for (const rule of now.rules ?? []) report.rules.push({ shot, ...rule });
    for (const violation of now.axe ?? []) {
      const rules = report.axe.get(shot.design) ?? new Map();
      report.axe.set(shot.design, rules);
      const entry = rules.get(violation.id) ?? {
        impact: violation.impact,
        help: violation.help,
        nodes: 0,
        shots: new Set(),
        example: null,
      };
      entry.nodes += violation.nodes.length;
      entry.shots.add(nameOf(shot));
      // Shots finish in any order; the example is the first by name, so that a run reads the same.
      if (!entry.example || nameOf(shot) < entry.example.shot)
        entry.example = { shot: nameOf(shot), node: violation.nodes[0] };
      rules.set(violation.id, entry);
    }
    if (++done % 10 === 0 || done === shots.length) console.log(`  ${done} of ${shots.length}`);
  }

  const queue = [...shots];
  await Promise.all(
    Array.from({ length: Math.min(options.jobs, queue.length) }, async () => {
      for (let shot = queue.shift(); shot; shot = queue.shift()) await take(shot);
    }),
  );
  return report;
}

const SEVERITY = ["critical", "serious", "moderate", "minor"];

/** Prints what the run found. Adds to `problems` whatever fails it. */
export function print({ options, out, trees, drawn, shots, report, problems, notes }) {
  for (const note of [...notes].sort().slice(0, 10)) console.log(note);
  if (notes.size > 10) console.log(`… and ${notes.size - 10} more notes`);
  for (const [key, why] of [...report.missing].sort())
    console.log(`${key}: not shown yet (${why})`);
  if (report.missing.size)
    console.log(`Simple lacks ${count(report.missing.size, "screen")}. --strict fails on that.`);
  if (out && shots.length) console.log(`Screenshots are in ${out}`);

  if (options.compare) {
    console.log(`\nCompared with ${trees[0].label}:`);
    console.log("  screen       shots  changed       pixels");
    for (const screen of options.screens) {
      const row = report.compare.get(screen);
      if (!row) continue;
      const cells = [row.shots, row.changed].map((n) => String(n).padStart(8));
      const pixels = row.pixels.toLocaleString("en-GB").padStart(12);
      console.log(`  ${screen.padEnd(10)} ${cells.join(" ")} ${pixels}`);
    }
    const files = [...report.compare.values()].flatMap((row) => row.files).sort();
    for (const file of files.slice(0, 30)) console.log(`  changed: ${file}`);
    if (files.length > 30) console.log(`  … and ${files.length - 30} more in ${out}/diff`);
    if (report.changed)
      problems.push(
        `${count(report.changed, "shot")} changed against ${trees[0].label}; see ${out}/diff`,
      );
    else if (report.compare.size) console.log("  No pixel changed.");
  }

  if (options.overflow) {
    const wide = report.overflow.sort((a, b) => nameOf(a.shot).localeCompare(nameOf(b.shot)));
    for (const item of wide.slice(0, 30)) {
      if (item.scrollWidth > item.clientWidth) {
        const what = item.offenders.length ? ` (${item.offenders.join("; ")})` : "";
        console.log(
          `overflow: ${nameOf(item.shot)}: ${item.scrollWidth} px of content in ${item.clientWidth} px${what}`,
        );
      }
      for (const box of item.boxes ?? [])
        console.log(
          `overflow: ${nameOf(item.shot)}: ${box.where} scrolls sideways: ${box.scrollWidth} px of content in ${box.clientWidth} px`,
        );
    }
    if (wide.length > 30) console.log(`overflow: … and ${wide.length - 30} more`);
    if (wide.length) problems.push(`${count(wide.length, "shot")} scroll sideways`);
    else if (shots.length) console.log("overflow: nothing scrolls sideways.");
  }

  if (options.rules) {
    if (!drawn.includes("simple"))
      console.log("rules: these are Simple's, and Simple does not draw yet, so nothing was checked.");
    else {
      const grouped = new Map();
      for (const item of report.rules) {
        const key = `${item.rule}: ${item.text}${item.where ? `, ${item.where}` : ""}`;
        grouped.set(key, [...(grouped.get(key) ?? []), nameOf(item.shot)]);
      }
      for (const [key, where] of [...grouped].sort(([a], [b]) => a.localeCompare(b)).slice(0, 40)) {
        const first = where.sort()[0];
        console.log(`rules: ${key} (${count(where.length, "shot")}, first ${first})`);
      }
      if (grouped.size > 40) console.log(`rules: … and ${grouped.size - 40} more`);
      if (grouped.size) problems.push(`${count(grouped.size, "rule break")} in Simple`);
      else console.log("rules: Simple keeps them.");
    }
  }

  if (options.axe)
    for (const design of drawn) {
      const fails = design === "simple";
      const rows = [...(report.axe.get(design) ?? [])].sort(
        ([, a], [, b]) => SEVERITY.indexOf(a.impact) - SEVERITY.indexOf(b.impact) || b.nodes - a.nodes,
      );
      const rule = fails ? "serious and critical fail" : "report only";
      console.log(`axe, ${design} (${rule}): ${count(rows.length, "rule")}`);
      for (const [id, entry] of rows) {
        const spread = `${count(entry.nodes, "element")} in ${count(entry.shots.size, "shot")}`;
        console.log(`  ${entry.impact.padEnd(8)} ${id}: ${spread}, ${entry.help}`);
        console.log(`           e.g. ${entry.example.node} in ${entry.example.shot}`);
        if (fails && ["serious", "critical"].includes(entry.impact))
          problems.push(`axe ${entry.impact}: ${id}, ${count(entry.nodes, "element")} in Simple`);
      }
    }
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const started = Date.now();
  const browserPath = findBrowser(options.browser);
  if (!browserPath) throw new UsageError("No Chromium found. Install it, or pass --browser <path>");
  let axePath;
  let playwright;
  try {
    axePath = requireUi.resolve("axe-core/axe.min.js");
    playwright = requireUi("playwright-core");
  } catch (error) {
    throw new UsageError(
      `The interface's packages are missing (${error.message.split("\n")[0]}). Run pnpm install`,
    );
  }
  const want = {
    shoot: Boolean(options.compare || options.out || !(options.axe || options.overflow || options.rules)),
    axe: options.axe,
    overflow: options.overflow,
    rules: options.rules,
  };
  // With no --out the screenshots go to a folder of this checkout that each run starts again.
  const out = !want.shoot
    ? null
    : options.out
      ? path.resolve(options.out)
      : path.join(CACHE, "shots");
  if (out && !options.out) rmSync(out, { recursive: true, force: true });

  const exits = [];
  const cleanUp = async () => {
    for (const undo of exits.reverse())
      try {
        await undo();
      } catch {
        /* Cleaning up must not hide the result. */
      }
    exits.length = 0;
  };
  const interrupted = () => void cleanUp().finally(() => process.exit(130));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

  try {
    const trees = await prepare(options, (undo) => exits.push(undo));
    // Partial raster draws only what changed over the picture drawn before, which blends the
    // anti-aliased pixels of a rounded corner a second time. Whether a screen was drawn once or
    // twice depends on timing, so a few corner pixels differ by one unit in some runs and not in
    // others, and "0 changed pixels" could not be told from noise.
    const browser = await playwright.chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--disable-partial-raster"],
      // Playwright hides headless Chromium's scrollbars; --scrollbars keeps them, taking room.
      ...(options.scrollbars ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {}),
    });
    exits.push(() => browser.close());
    const problems = [];
    const notes = new Set();
    const drawn = await drawing({ browser, trees, designs: options.design, problems, notes });
    const shots = shotsOf(options, drawn);
    const pixels = options.compare ? await loadPixels() : null;
    // The pictures of an earlier run would pass for this one's. Only pictures are removed: the
    // folder may be someone's own.
    if (options.compare)
      for (const folder of ["ref", "new", "diff"]) {
        const dir = path.join(out, folder);
        if (existsSync(dir))
          for (const file of readdirSync(dir).filter((name) => name.endsWith(".png")))
            rmSync(path.join(dir, file));
      }

    const sizes = options.sizes.map((size) => `${size.width}x${size.height}`).join(", ");
    console.log(
      `Taking ${count(shots.length, "shot")}: ${drawn.join(" and ") || "none"} · ` +
        `${options.screens.length} screens · ${sizes} · ${options.themes.join(" and ")} · ` +
        `${options.scrollbars ? "scrollbars that take room · " : ""}${options.jobs} at a time`,
    );
    const report = await takeShots({
      options, want, out, trees, browser, axePath, pixels, shots, problems, notes,
    });
    await browser.close();
    print({ options, out, trees, drawn, shots, report, problems, notes });

    console.log(`\nDone in ${duration(Date.now() - started)}.`);
    if (problems.length) {
      console.error(`${count(problems.length, "problem")}:`);
      for (const text of problems.slice(0, 60)) console.error(`  ${text}`);
      if (problems.length > 60) console.error(`  … and ${problems.length - 60} more`);
      return 1;
    }
    console.log(
      !shots.length
        ? "Nothing was checked."
        : options.compare
          ? "The preview is unchanged."
          : "The preview checks out.",
    );
    return 0;
  } finally {
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    await cleanUp();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then(
    (code) => {
      // Leave a moment for what was printed to reach a pipe before the process ends.
      process.exitCode = code;
      setTimeout(() => process.exit(code), 100);
    },
    (error) => {
      console.error(error instanceof UsageError ? error.message : (error.stack ?? error));
      process.exitCode = 2;
      setTimeout(() => process.exit(2), 100);
    },
  );
