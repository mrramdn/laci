/**
 * Screenshots of the real window for review: the first-run screen, then Simple and Detailed in light and dark at
 * 720×560, 840×640, 1200×800 and 1600×1000 (the floors of Simple's tiers). Designs and themes are switched through
 * the window's own controls where it has them, else with the `design` and `theme` requests and a reload.
 *
 * It drives a build with the `e2e` feature over W3C WebDriver, through tauri-driver (TAURI_DRIVER, else on PATH),
 * whose native driver LACI_NATIVE_DRIVER can name. LACI_WINDOW_DRIVER=embedded uses the WebDriver server inside the
 * app instead, which this script starts on LACI_WEBDRIVER_PORT (4445). Under tauri-driver that server runs as well, and
 * resizes the window when the native driver can't.
 *
 *   cargo build -p laci --features custom-protocol,e2e
 *   node scripts/demo.ts "$LACI_HOME"
 *   LACI_HOME=<throwaway home> node scripts/window-smoke.mjs [binary] [screenshot folder]
 *
 * LACI_HOME must be a throwaway home such as the demo's: the script saves the demo's setup in it. The window's own web
 * storage (the theme and design it paints first) and caches go inside it too, as in native-smoke.sh.
 * The screenshots go to the folder (LACI_SCREENSHOTS, else laci-window-smoke in the temp folder) as
 * <design>-<theme>-<width>x<height>.png, with window-smoke.json listing them and anything worth a look.
 *
 * LACI_WINDOW_DRIVER=preview checks this script against the browser preview instead, without a desktop window: start
 * a chromedriver and `pnpm -C ui dev`, then set LACI_WEBDRIVER (the chromedriver's address, as for desktop-smoke.mjs)
 * and LACI_PREVIEW_URL (.../preview.html).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = path.resolve(
  process.argv[2] ?? process.env.LACI_BINARY ?? path.join(root, "target/debug", "laci"),
);
const out = path.resolve(
  process.argv[3] ??
    process.env.LACI_SCREENSHOTS ??
    path.join(tmpdir(), "laci-window-smoke"),
);
const mode = process.env.LACI_WINDOW_DRIVER ?? "tauri-driver";
const embeddedPort = Number(process.env.LACI_WEBDRIVER_PORT ?? 4445);
/** The WebDriver server inside the e2e build, which tauri-driver's native driver leaves running beside it. */
const ownServer = `http://127.0.0.1:${embeddedPort}`;
/** What a session on that server asks for: the main window. */
const OWN_WINDOW = { "wdio:tauriServiceOptions": { windowLabel: "main" } };
const DESIGNS = ["simple", "detailed"];
const THEMES = ["light", "dark"];
const SIZES = [
  [720, 560],
  [840, 640],
  [1200, 800],
  [1600, 1000],
];
/** The demo's setup, as the preview's fixtures have it (crates/laci-core/examples/ui_fixtures.rs). */
const SETUP = {
  roots: ["~/project"],
  archiveDir: "",
  reportsDir: "~/Documents/agent-reports",
  presets: ["claude", "codex"],
  apps: {},
  terminalTarget: "internal",
};
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

const shots = [];
const notes = [];
let server;
let session;
/** A session on the app's own server, opened only when the session's driver can't resize the window. */
let ownSession;
/** The driver or the app this script started, and what it said. */
let started;
let startedLog = "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Something worth a look in window-smoke.json, once however often it happens. */
function note(text) {
  if (notes.includes(text)) return;
  notes.push(text);
  console.log(`note: ${text}`);
}

async function request(method, route, body, timeout = 180_000, base = server) {
  const response = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  }).catch((error) => {
    throw new Error(`${method} ${route}: ${error.message ?? error}`, {
      cause: error,
    });
  });
  const reply = await response.json();
  if (!response.ok || reply.value?.error)
    throw new Error(
      `${method} ${route}: ${reply.value?.message || JSON.stringify(reply)}`,
    );
  return reply.value;
}
const command = (method, route, body) =>
  request(method, `/session/${session}${route}`, body);
const execute = (fn, ...args) =>
  command("POST", "/execute/sync", {
    script: `return (${fn.toString()})(...arguments)`,
    args,
  });
async function asyncExecute(fn, ...args) {
  const reply = await command("POST", "/execute/async", {
    script: `const done=arguments[arguments.length-1];const args=Array.from(arguments).slice(0,-1);Promise.resolve((${fn.toString()})(...args)).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}))`,
    args,
  });
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
/** A request to the desktop, as the window makes it. */
const api = (name, body = {}) =>
  asyncExecute(
    (name, body) =>
      window.__TAURI_INTERNALS__.invoke("request", { name, body }),
    name,
    body,
  );
async function wait(label, condition, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out: ${label}${lastError ? ` (${lastError.message})` : ""}`,
  );
}

// --- Starting the driver ------------------------------------------------------------------------

/**
 * What the app gets on top of this script's environment, also through tauri-driver and the native driver: the port
 * of its own WebDriver server, and WebKit's storage inside LACI_HOME.
 */
function appEnv() {
  const env = { TAURI_WEBDRIVER_PORT: String(embeddedPort) };
  const home = process.env.LACI_HOME;
  if (!home) return env;
  return {
    ...env,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
}

function launch(program, args) {
  const child = spawn(program, args, {
    env: { ...process.env, ...appEnv() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => {
    // The end is what explains a failure.
    startedLog = (startedLog + chunk).slice(-20_000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("error", (error) => keep(`\n${program}: ${error.message}\n`));
  return child;
}

/** Starts what the window is driven through and returns the session's capabilities. */
async function startDriver() {
  if (mode === "preview") {
    server = process.env.LACI_WEBDRIVER?.replace(/\/$/, "");
    assert.ok(server, "LACI_WEBDRIVER names the chromedriver to use");
    assert.ok(process.env.LACI_PREVIEW_URL, "LACI_PREVIEW_URL names preview.html");
    return {
      browserName: "chrome",
      "goog:chromeOptions": {
        args: ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1"],
      },
    };
  }
  await stat(binary).catch(() => {
    throw new Error(`No build at ${binary}: cargo build -p laci --features custom-protocol,e2e`);
  });
  if (mode === "embedded") {
    // The app is the server. It listens once its window exists.
    server = ownServer;
    started = launch(binary, []);
    await waitForServer(90_000);
    return OWN_WINDOW;
  }
  assert.equal(mode, "tauri-driver", `Unknown LACI_WINDOW_DRIVER: ${mode}`);
  // The native driver gets a port of its own: 4445 is where the e2e build's own server listens.
  server = "http://127.0.0.1:4444";
  const native = process.env.LACI_NATIVE_DRIVER;
  started = launch(process.env.TAURI_DRIVER ?? "tauri-driver", [
    "--port",
    "4444",
    "--native-port",
    "4446",
    ...(native ? ["--native-driver", native] : []),
  ]);
  await waitForServer(30_000);
  return { "tauri:options": { application: binary } };
}

async function waitForServer(timeout) {
  await wait(
    `WebDriver at ${server}`,
    async () => {
      if (started?.exitCode !== null && started?.exitCode !== undefined)
        throw new Error(`it ended with code ${started.exitCode}`);
      const status = await request("GET", "/status", undefined, 1_500);
      return status?.ready !== false;
    },
    timeout,
  );
}

// --- What runs in the page ----------------------------------------------------------------------
// Sent to the window as text, so each stands alone.

/** Resolves when nothing moved for `quietMs` and no animation runs, or after `maxMs`; true if it went still. */
function untilStill(quietMs, maxMs) {
  return new Promise((resolve) => {
    let timer;
    let cap;
    const finish = (still) => {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve(still);
    };
    const quiet = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const moving = (document.getAnimations?.() ?? []).some(
          (animation) => animation.playState === "running",
        );
        if (moving) quiet();
        else finish(true);
      }, quietMs);
    };
    const observer = new MutationObserver(quiet);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    quiet();
    cap = setTimeout(() => finish(false), maxMs);
  });
}

/** Waits for the fonts: text drawn for the first time asks for its font only after layout. */
async function untilFonts() {
  const frames = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  for (let round = 0; round < 5; round++) {
    await frames();
    await document.fonts.ready;
    if (document.fonts.status === "loaded") break;
  }
  return true;
}

/** What the window shows: the first run, a design's shell, or neither yet, and how it is drawn. */
function shownNow() {
  const root = document.documentElement;
  const drawn = {
    design: root.dataset.design ?? "",
    theme: root.dataset.theme ?? "system",
    toast: Boolean(document.querySelector(".toast")),
    size: [window.innerWidth, window.innerHeight],
    ratio: window.devicePixelRatio,
  };
  if (document.querySelector(".boot")) return { ...drawn, screen: "boot" };
  if (document.querySelector(".setup")) return { ...drawn, screen: "first-run" };
  const simple = Boolean(document.querySelector(".s-shell, [data-ui='nav']"));
  const detailed = Boolean(document.getElementById("app"));
  return {
    ...drawn,
    screen: simple && !detailed ? "simple" : detailed && !simple ? "detailed" : "",
  };
}

// --- Steps --------------------------------------------------------------------------------------

async function untilIpc() {
  await wait("the window's link to the desktop", () =>
    execute(() => Boolean(window.__TAURI_INTERNALS__)),
  );
}

/** Whether `child` is `parent` or inside it. A path on another drive is never inside. */
function within(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * The home the app gets, checked before anything starts: never one that holds someone's real data, as the script
 * saves a setup in it.
 */
async function throwawayHome() {
  const wanted = process.env.LACI_HOME;
  assert.ok(wanted, "Set LACI_HOME to a throwaway home, such as one made by scripts/demo.ts");
  const home = await realpath(wanted);
  const real = await realpath(homedir()).catch(() => homedir());
  assert.ok(!within(real, home), `LACI_HOME (${home}) is or holds the real home folder`);
  return home;
}

/** The window runs on that home. */
async function checkHome(home) {
  const snapshot = await api("snapshot");
  assert.equal(
    await realpath(snapshot.home),
    home,
    "The window must use the LACI_HOME this script was given",
  );
}

/** Waits until no scan or history refresh has run for a second. */
async function idle(label) {
  if (mode === "preview") return;
  let since;
  await wait(label, async () => {
    const status = await api("status");
    if (status.busy || status.historyPending) {
      since = undefined;
      return false;
    }
    since ??= Date.now();
    return Date.now() - since >= 1_000;
  });
}

/** The size the page has once it stopped changing: a resize reaches it a moment after the window. */
async function viewport() {
  let last = [];
  for (let read = 0; read < 10; read++) {
    const size = await execute(() => [window.innerWidth, window.innerHeight]);
    if (size[0] === last[0] && size[1] === last[1]) return size;
    last = size;
    await sleep(100);
  }
  return last;
}

/** The window's rect through the session's driver. */
const sessionRect = (method, rect) => command(method, "/window/rect", rect);
/**
 * The window's rect through the app's own WebDriver server, in a session of its own: a native driver may not move a
 * window that the app, not the driver, opened.
 */
async function ownRect(method, rect) {
  ownSession ??= (
    await request(
      "POST",
      "/session",
      { capabilities: { alwaysMatch: OWN_WINDOW, firstMatch: [{}] } },
      30_000,
      ownServer,
    )
  ).sessionId;
  return request(method, `/session/${ownSession}/window/rect`, rect, 30_000, ownServer);
}
/** What resized the window exactly the last time; until then each way is tried in turn. */
let resizer;

/** Makes the page `width`×`height` CSS pixels: the window's frame is added once it is known. */
async function resize(width, height) {
  const ways = resizer
    ? [resizer]
    : mode === "tauri-driver"
      ? [sessionRect, ownRect]
      : [sessionRect];
  for (const way of ways) {
    try {
      let rect = { width, height };
      for (let attempt = 0; attempt < 3; attempt++) {
        await way("POST", rect);
        const [w, h] = await viewport();
        if (w === width && h === height) {
          if (way !== resizer && way === ownRect)
            note("The window is resized through the app's own WebDriver server.");
          resizer = way;
          return { width, height, exact: true };
        }
        const outer = await way("GET");
        rect = {
          width: outer.width + width - w,
          height: outer.height + height - h,
        };
      }
    } catch (error) {
      const who = way === ownRect ? "The app's own WebDriver server" : "The driver";
      note(`${who} can't resize the window (${error.message}).`);
    }
  }
  const [w, h] = await viewport();
  return { width: w, height: h, exact: w === width && h === height };
}

async function findAll(selector) {
  const found = await command("POST", "/elements", {
    using: "css selector",
    value: selector,
  });
  return found.map((element) => element[ELEMENT]);
}
/** Clicks the first match of `selector` whose words or accessible name is `name`, as a person would. */
async function clickNamed(selector, name) {
  const wanted = name.toLowerCase();
  for (const id of await findAll(selector)) {
    const text = (await command("GET", `/element/${id}/text`)).trim();
    const label =
      (await command("GET", `/element/${id}/attribute/aria-label`)) ?? "";
    if (text.toLowerCase() !== wanted && label.toLowerCase() !== wanted)
      continue;
    await command("POST", `/element/${id}/click`, {});
    return true;
  }
  return false;
}

/** The request a control stands in for, then a reload: the window takes the saved choice from `prefs`. */
async function saveAndReload(name, value) {
  if (mode === "preview") {
    // The preview keeps nothing: its address says what it shows.
    const url = new URL(await command("GET", "/url"));
    url.searchParams.set(name, value);
    await command("POST", "/url", { url: url.href });
  } else {
    await api(name, { [name]: value });
    await command("POST", "/refresh", {});
  }
  await untilIpc();
}

/** Shows `design`, through the toggle where the window has one. Says how. */
async function useDesign(design) {
  if ((await execute(shownNow)).screen === design) return "already shown";
  let how = "";
  try {
    if (await clickNamed("[data-ui='design-toggle'] button", design))
      how = "switched with the toggle";
  } catch (error) {
    note(`The ${design} toggle didn't take a click: ${error.message}`);
  }
  if (!how) {
    await saveAndReload("design", design);
    how = "no toggle: switched with the design request and a reload";
  }
  await wait(`the ${design} design`, async () => {
    const shown = await execute(shownNow);
    return shown.screen === design && shown.design === design;
  });
  return how;
}

/** Shows `theme`, through the theme control of the design shown where it has one. Says how. */
async function useTheme(theme) {
  if ((await execute(shownNow)).theme === theme) return "already shown";
  let how = "";
  try {
    // Detailed: a button per theme at the foot of the sidebar.
    if (await clickNamed("[role='group'][aria-label='Theme'] button", `${theme} theme`))
      how = "switched with the theme buttons";
    // Simple: the Theme menu at the foot of the sidebar.
    else if (await clickNamed("[aria-haspopup='menu']", "Theme")) {
      const item = theme.charAt(0).toUpperCase() + theme.slice(1);
      await sleep(200);
      if (await clickNamed("[role='menu'] [role^='menuitem']", item))
        how = "switched with the theme menu";
      else note(`The theme menu has no ${item}.`);
    }
  } catch (error) {
    note(`The ${theme} theme control didn't take a click: ${error.message}`);
  }
  if (!how) {
    await saveAndReload("theme", theme);
    how = "no control: switched with the theme request and a reload";
  }
  await wait(`the ${theme} theme`, async () => (await execute(shownNow)).theme === theme);
  return how;
}

/** What a PNG says its size is. */
function pngSize(png) {
  return png.length > 24 && png.toString("ascii", 12, 16) === "IHDR"
    ? [png.readUInt32BE(16), png.readUInt32BE(20)]
    : [0, 0];
}

async function shoot(name) {
  const file = `${name}.png`;
  if (shots.some((shot) => shot.file === file)) return;
  await idle(`the scan before ${file}`);
  const toast = await wait(
    `no toast over ${file}`,
    async () => !(await execute(shownNow)).toast,
    12_000,
  ).catch(() => false);
  if (!toast) note(`${file} shows a toast.`);
  if (!(await asyncExecute(untilStill, 400, 6_000)))
    note(`${file} was still changing after 6 s.`);
  await asyncExecute(untilFonts);
  const png = Buffer.from(await command("GET", "/screenshot"), "base64");
  await writeFile(path.join(out, file), png);
  const shown = await execute(shownNow);
  const pixels = pngSize(png);
  const page = shown.size.map((side) => Math.round(side * shown.ratio));
  if (pixels[0] !== page[0] || pixels[1] !== page[1])
    note(`${file} has ${pixels.join("×")} pixels, the page ${page.join("×")}.`);
  shots.push({
    file,
    design: shown.design,
    theme: shown.theme,
    viewport: shown.size,
    pixels,
    ratio: shown.ratio,
  });
  console.log(`${file}  ${shown.size.join("×")} at ${shown.ratio}x`);
}

async function main() {
  const home = mode === "preview" ? null : await throwawayHome();
  // Only adds and replaces its own files: the folder may hold anything else.
  await mkdir(out, { recursive: true });
  const capabilities = await startDriver();
  const created = await request("POST", "/session", {
    capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
  });
  session = created.sessionId;
  assert.ok(session, "The driver must return a session");
  await command("POST", "/timeouts", {
    script: 120_000,
    pageLoad: 120_000,
    implicit: 0,
  });
  if (mode === "preview")
    await command("POST", "/url", { url: process.env.LACI_PREVIEW_URL });
  await untilIpc();
  if (home) await checkHome(home);
  console.log(`Window: ${mode === "preview" ? process.env.LACI_PREVIEW_URL : binary} (${mode})`);

  await resize(1200, 800);
  const first = await wait("the first screen", async () => {
    const shown = await execute(shownNow);
    return shown.screen && shown.screen !== "boot" ? shown : false;
  });
  if (first.screen === "first-run") {
    await shoot("first-run-1200x800");
    await idle("the scan before the setup is saved");
    await api("setup/save", SETUP);
    await idle("the scan of the demo's setup");
  }
  for (const design of DESIGNS) {
    // The controls are at the foot of the sidebar, which both designs show at 1200.
    await resize(1200, 800);
    note(`${design}: ${await useDesign(design)}.`);
    for (const theme of THEMES) {
      await resize(1200, 800);
      note(`${design}, ${theme}: ${await useTheme(theme)}.`);
      for (const [width, height] of SIZES) {
        const size = await resize(width, height);
        if (!size.exact)
          note(`Asked for ${width}×${height}, the page is ${size.width}×${size.height}.`);
        await shoot(`${design}-${theme}-${size.width}x${size.height}`);
      }
    }
  }
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  console.error(`window-smoke failed: ${error.stack ?? error}`);
  if (session) {
    const shown = await execute(shownNow).catch(() => null);
    console.error(`The window shows: ${JSON.stringify(shown)}`);
    await command("GET", "/screenshot")
      .then((png) => writeFile(path.join(out, "failure.png"), Buffer.from(png, "base64")))
      .catch(() => {});
  }
  if (startedLog) console.error(`What the driver or the app said last:\n${startedLog}`);
} finally {
  if (ownSession) {
    const route = `/session/${ownSession}`;
    await request("DELETE", route, undefined, 5_000, ownServer).catch(() => {});
  }
  if (session) await command("DELETE", "").catch(() => {});
  if (started && started.exitCode === null) {
    started.kill();
    await new Promise((resolve) => {
      started.once("exit", resolve);
      setTimeout(resolve, 5_000);
    });
  }
  await writeFile(
    path.join(out, "window-smoke.json"),
    `${JSON.stringify({ mode, binary, passed: !failure, shots, notes }, null, 2)}\n`,
  ).catch(() => {});
  console.log(`${shots.length} screenshots in ${out}`);
}
// Something still open, such as a socket or a pipe, kept node running after a run that had passed, until CI's
// limit of an hour ended the job. Say what it is, and end with the result.
const open = process.getActiveResourcesInfo().filter((kind) => kind !== "TTYWrap");
if (open.length) console.log(`Still open at the end, closed by exiting: ${open.join(", ")}`);
process.exit(failure ? 1 : 0);
