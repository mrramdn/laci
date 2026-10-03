/**
 * Native desktop integration checks using tauri-driver and W3C WebDriver.
 *
 * Start tauri-driver with an isolated LACI_HOME that contains scripts/demo.ts
 * fixtures, then run: LACI_HOME=/tmp/laci-demo node scripts/desktop-smoke.mjs
 * LACI_BINARY overrides target/debug/laci; LACI_WEBDRIVER defaults to :4444.
 * LACI_SCREENSHOTS optionally receives screenshots from the real app window.
 * LACI_ONBOARDING_ONLY=1 checks the first-run wizard on an unconfigured fixture.
 * LACI_WATCHER_ONLY=1 checks archived Git and continuously written session logs.
 * LACI_KEYBOARD_ONLY=1 checks modal, connector, row and terminal keyboard behavior.
 * LACI_STARTUP_PROJECT/TEXT optionally check a README changed after a cached scan.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = path.resolve(
  process.env.LACI_BINARY ??
    process.argv[2] ??
    path.join(root, "target/debug/laci"),
);
const driver = (process.env.LACI_WEBDRIVER ?? "http://127.0.0.1:4444").replace(
  /\/$/,
  "",
);
const screenshotDir =
  process.env.LACI_SCREENSHOTS && path.resolve(process.env.LACI_SCREENSHOTS);
const onboardingOnly = process.env.LACI_ONBOARDING_ONLY === "1";
const watcherOnly = process.env.LACI_WATCHER_ONLY === "1";
const keyboardOnly = process.env.LACI_KEYBOARD_ONLY === "1";
const modularOnly = process.env.LACI_MODULAR_ONLY === "1";
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
const stamp = Date.now().toString(36);
const projectName = `desktop-smoke-${stamp}`;
const todoText = `Verify native desktop ${stamp}`;
const duplicateTodoText = `Repeated native task ${stamp}`;
const notesText = `Notes saved by the native React UI (${stamp}).`;
const watcherText = `Live watcher refreshed this README (${stamp}).`;
const terminalText = `LACI_DESKTOP_SMOKE_TERMINAL_${stamp}`;
const results = [];
const frontendErrors = [];
const keyboardTerminalIds = new Set();
const keyboardFiles = [];
let session;
let fixtureHome;
let originalTheme;
let watchedFile;

async function request(method, route, body, timeout = 180_000) {
  const response = await fetch(driver + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  });
  const reply = await response.json();
  if (!response.ok || reply.value?.error) {
    throw new Error(
      `${method} ${route}: ${reply.value?.message ?? JSON.stringify(reply)}`,
    );
  }
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
const invoke = (name, body = {}) =>
  asyncExecute(
    (name, body) => window.__TAURI_INTERNALS__.invoke(name, body),
    name,
    body,
  );
const api = (name, body = {}) => invoke("request", { name, body });
const snapshot = () => api("snapshot");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(label, condition, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(
    `Timed out: ${label}${lastError ? ` (${lastError.message})` : ""}`,
  );
}
async function check(name, task) {
  const started = Date.now();
  await task();
  results.push({ name, passed: true, tookMs: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function element(selector, text, exact = false) {
  return wait(`element ${selector}${text ? ` “${text}”` : ""}`, () =>
    execute(
      (selector, text, exact) => {
        return (
          [...document.querySelectorAll(selector)].find((element) => {
            const visible = element.getClientRects().length > 0;
            const value = element.textContent.trim();
            return (
              visible &&
              (!text || (exact ? value === text : value.includes(text)))
            );
          }) ?? null
        );
      },
      selector,
      text ?? "",
      exact,
    ),
  );
}
async function click(selector, text, exact = false) {
  const target = await element(selector, text, exact);
  await command("POST", `/element/${target[elementKey]}/click`, {});
}
async function type(selector, value) {
  const target = await element(selector);
  await command("POST", `/element/${target[elementKey]}/clear`, {});
  await command("POST", `/element/${target[elementKey]}/value`, {
    text: value,
  });
}
async function key(value, control = false, shift = false) {
  const actions = [
    ...(control ? [{ type: "keyDown", value: "\uE009" }] : []),
    ...(shift ? [{ type: "keyDown", value: "\uE008" }] : []),
    { type: "keyDown", value },
    { type: "keyUp", value },
    ...(shift ? [{ type: "keyUp", value: "\uE008" }] : []),
    ...(control ? [{ type: "keyUp", value: "\uE009" }] : []),
  ];
  await command("POST", "/actions", {
    actions: [{ type: "key", id: "keyboard", actions }],
  });
}
async function keyboardText(value) {
  await command("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: Array.from(value).flatMap((value) => [
          { type: "keyDown", value },
          { type: "keyUp", value },
        ]),
      },
    ],
  });
}
async function painted() {
  await asyncExecute(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
      ),
  );
}
async function focused(selector, text = "", exact = false) {
  return execute(
    (selector, text, exact) => {
      const active = document.activeElement;
      const value = active?.textContent?.trim() ?? "";
      return Boolean(
        active?.matches(selector) &&
        (!text || (exact ? value === text : value.includes(text))),
      );
    },
    selector,
    text,
    exact,
  );
}
async function tabTo(selector, text = "", exact = false) {
  await element(selector, text, exact);
  for (let count = 0; count < 150; count++) {
    if (await focused(selector, text, exact)) return;
    await key("\uE004");
  }
  throw new Error(`Tab did not reach ${selector} ${text}`);
}
async function terminalFocused() {
  await wait("real keyboard focus in xterm", () =>
    focused(
      ".term:not([hidden]) .term-host:not([hidden]) .xterm-helper-textarea",
    ),
  );
}
async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    assert.ok(fields.length > 19, `Invalid /proc/${pid}/stat`);
    return { state: fields[0], started: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}
const sameLiveProcess = (current, original) =>
  current?.started === original.started && !["Z", "X"].includes(current.state);
const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
async function select(selector, value) {
  await execute(
    (selector, value) => {
      const select = document.querySelector(selector);
      if (!select) throw new Error(`Missing select ${selector}`);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selector,
    value,
  );
}
async function textContains(selector, text) {
  return execute(
    (selector, text) =>
      [...document.querySelectorAll(selector)].some((element) =>
        element.textContent.includes(text),
      ),
    selector,
    text,
  );
}
async function nav(label, heading) {
  await click(".sb-item", label);
  await wait(`${heading} view`, () => textContains(".main .head h1", heading));
}
async function shot(name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await wait(`scan settled before ${name} screenshot`, async () => {
    const status = await api("status");
    return (
      !status.busy &&
      (await execute(() => !document.querySelector(".sb-foot .spin")))
    );
  });
  await asyncExecute(() =>
    document.fonts.ready.then(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(true)),
          ),
        ),
    ),
  );
  const encoded = await command("GET", "/screenshot");
  await writeFile(
    path.join(screenshotDir, `${name}.png`),
    Buffer.from(encoded, "base64"),
  );
}
async function showProject(project) {
  await key("k", true);
  await type("#pal-in", project.path);
  await wait("project search hit", () =>
    textContains(".pal-item", project.name),
  );
  await key("\uE007");
  await wait(`inspector for ${project.name}`, () =>
    textContains(".insp .ititle h2", project.name),
  );
}
async function modularRegressions() {
  const external = await mkdtemp(path.join(path.dirname(fixtureHome), "laci-modular-"));
  const scanRoot = path.join(external, "projects");
  const archiveRoot = path.join(external, "archive");
  const source = path.join(scanRoot, `modular-${stamp}`);
  const backup = path.join(external, "backup.git");
  const original = await api("setup/info");
  const trashRoot = path.join(fixtureHome, ".local/share/Trash");
  const historyDir = path.join(fixtureHome, ".claude/projects", source.replace(/[^A-Za-z0-9]/g, "-"));
  const historyFile = path.join(historyDir, "modular.jsonl");
  const historyBytes = JSON.stringify({ type: "user", cwd: source, sessionId: "modular-history", timestamp: new Date().toISOString(), message: { content: "Keep external history after project Trash" } }) + "\n";
  const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Native Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Native Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let trashPath;
  try {
    await mkdir(source, { recursive: true });
    await mkdir(archiveRoot);
    await mkdir(backup);
    git(backup, ["init", "--bare", "--initial-branch=main"]);
    git(source, ["init", "--initial-branch=main"]);
    await writeFile(path.join(source, "README.md"), "# Modular project\nBacked up on a disposable remote.\n");
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "initial"]);
    git(source, ["remote", "add", "origin", backup]);
    git(source, ["push", "-u", "origin", "main"]);
    await mkdir(historyDir, { recursive: true });
    await writeFile(historyFile, historyBytes);
    await check("Settings select an external scan location and default archive folder", async () => {
      await nav("Settings", "Settings");
      await type('[aria-label="Another folder"]', scanRoot);
      await click(".main button", "Add folder", true);
      await type('[aria-label="Default archive folder"]', archiveRoot);
      await click(".main button", "Save and rescan", true);
      await wait("external root installed", async () => {
        const current = await snapshot();
        return !current.historyPending && current.nodes[source] && current.roots.includes(scanRoot);
      });
      const info = await api("setup/info");
      assert.equal(info.archiveDir, archiveRoot);
      assert.equal((await snapshot()).nodes[source].archivePlan.dest, path.join(archiveRoot, path.basename(source)));
      await shot("modular-settings");
    });
    await check("Custom archive preview, apply and Undo agree outside Home", async () => {
      const project = (await snapshot()).nodes[source];
      await showProject(project);
      await click(".insp .iacts button", "Archive", true);
      const destination = path.join(archiveRoot, `${path.basename(source)}-chosen`);
      await type('[aria-label="Archive destination"]', destination);
      await wait("custom archive preview ready", () => execute(() => {
        const button = [...document.querySelectorAll(".dialog .df button")].find((b) => b.textContent.trim() === "Archive");
        return button && !button.disabled && document.querySelector(".dialog .ops")?.textContent.includes("-chosen");
      }));
      await shot("modular-archive");
      await click(".dialog .df button", "Archive", true);
      await wait("custom archive accepted", async () => {
        const current = await snapshot();
        return !current.historyPending && current.nodes[destination]?.archived && !current.nodes[source];
      });
      assert.ok((await readFile(path.join(destination, "README.md"), "utf8")).includes("Modular project"));
      await click(".toast button", "Undo", true);
      await wait("external archive undone", async () => {
        const current = await snapshot();
        return !current.historyPending && current.nodes[source] && !current.nodes[destination];
      });
      assert.equal(await readFile(historyFile, "utf8"), historyBytes);
    });
    await check("Trash rejects local work added after review, then preserves external history", async () => {
      assert.equal(path.resolve(process.env.XDG_DATA_HOME ?? ""), path.join(fixtureHome, ".local/share"), "Native Trash QA must isolate XDG_DATA_HOME");
      await showProject((await snapshot()).nodes[source]);
      await click(".insp .iacts button", "Move to Trash", true);
      await wait("live remote verified in dialog", () => execute(() => {
        const button = [...document.querySelectorAll(".dialog .df button")].find((b) => b.textContent.trim() === "Move to Trash");
        return button && !button.disabled;
      }));
      await appendFile(path.join(source, "README.md"), "Local work after the review\n");
      await click(".dialog .df button", "Move to Trash", true);
      await wait("fresh execution safety check rejected", () => textContains(".dialog [role=alert]", "local changes"));
      await access(source);
      await shot("modular-trash-blocked");
      await click(".dialog .df button", "Cancel", true);
      git(source, ["restore", "README.md"]);
      await writeFile(path.join(source, ".git/info/exclude"), ".laci.md\nsecret.env\n");
      await writeFile(path.join(source, "secret.env"), "Ignored bytes stay in Trash\n");
      await click(".insp .iacts button", "Move to Trash", true);
      await wait("fresh Trash plan ready", () => execute(() => {
        const button = [...document.querySelectorAll(".dialog .df button")].find((b) => b.textContent.trim() === "Move to Trash");
        return button && !button.disabled;
      }));
      await shot("modular-trash");
      await click(".dialog .df button", "Move to Trash", true);
      await wait("project removed from snapshot", async () => {
        const current = await snapshot();
        return !current.historyPending && !current.nodes[source];
      });
      trashPath = path.join(trashRoot, "files", path.basename(source));
      await access(path.join(trashPath, ".git"));
      assert.equal(await readFile(path.join(trashPath, "secret.env"), "utf8"), "Ignored bytes stay in Trash\n");
      assert.equal(await readFile(historyFile, "utf8"), historyBytes);
      const entry = (await api("log")).entries.find((entry) => entry.path === source && entry.title.includes("system Trash"));
      assert.ok(entry && !entry.undo, "System Trash recovery must not advertise Log Undo");
      // Restore only this disposable fixture, then remove its own Trash metadata.
      await rename(trashPath, source);
      trashPath = null;
      await rm(path.join(trashRoot, "info", `${path.basename(source)}.trashinfo`), { force: true });
    });
  } finally {
    if (await execute(() => Boolean(document.querySelector(".dialog"))))
      await click(".dialog .df button", "Cancel", true).catch(() => {});
    await wait("history settled for settings restore", async () => !(await api("status")).historyPending).catch(() => {});
    await api("setup/save", { roots: original.roots, presets: original.presets, apps: original.apps, archiveDir: original.archiveDir ?? "" }).catch(() => {});
    await wait("settings restored", async () => !(await api("status")).historyPending).catch(() => {});
    await rm(historyDir, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
    if (trashPath) {
      await rm(trashPath, { recursive: true, force: true });
      await rm(path.join(trashRoot, "info", `${path.basename(source)}.trashinfo`), { force: true });
    }
  }
}

async function theme(value) {
  await click(`.seg button[aria-label="${value} theme"]`);
  await wait(`${value} theme applied`, () =>
    execute((value) => document.documentElement.dataset.theme === value, value),
  );
}
async function doubleClick(selector) {
  const target = await element(selector);
  await command("POST", "/actions", {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: target, x: 0, y: 0 },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
          { type: "pause", duration: 70 },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
}

async function installErrorCollection() {
  await execute(() => {
    window.__LACI_SMOKE_ERRORS__ = [];
    addEventListener("error", (event) => {
      if (event.message) window.__LACI_SMOKE_ERRORS__.push(event.message);
    });
    addEventListener("unhandledrejection", (event) =>
      window.__LACI_SMOKE_ERRORS__.push(String(event.reason)),
    );
  });
}

async function newTerminalUI() {
  const before = new Set((await invoke("term_list")).map((term) => term.id));
  if (
    !(await execute(() => document.querySelector("#term")?.hidden === false))
  ) {
    await key("\uE034");
    await wait("terminal shown through F4", () =>
      execute(() => document.querySelector("#term")?.hidden === false),
    );
    if (before.size) await click('.term [aria-label="New terminal"]');
  } else {
    await click('.term [aria-label="New terminal"]');
  }
  const terminal = await wait("new native terminal session", async () => {
    const added = (await invoke("term_list")).filter(
      (term) => !before.has(term.id),
    );
    return added.length === 1 && added[0];
  });
  keyboardTerminalIds.add(terminal.id);
  await terminalFocused();
  return terminal;
}

async function closeExitedTerminalUI(id) {
  await wait(
    "shell exited successfully",
    async () =>
      (await invoke("term_list")).find((term) => term.id === id)?.exited === 0,
  );
  await wait("exited state rendered on the selected terminal tab", () =>
    execute(() =>
      Boolean(document.querySelector('.ttab.ended[aria-selected="true"]')),
    ),
  );
  const count = await execute(() => document.querySelectorAll(".ttab").length);
  await click('.ttab[aria-selected="true"]');
  await wait("keyboard focus moved out of the exited xterm", () =>
    focused('.ttab[aria-selected="true"]'),
  );
  await key("\uE004");
  assert.ok(
    await focused(
      '.ttab[aria-selected="true"] [role="button"][aria-label^="Close terminal "]',
    ),
    "Tab from the terminal tab must reach its close control",
  );
  await key("\uE007");
  await wait(
    "exited terminal removed without confirmation",
    async () => !(await invoke("term_list")).some((term) => term.id === id),
  );
  await wait("exited terminal tab removed", () =>
    execute(
      (count) => document.querySelectorAll(".ttab").length === count - 1,
      count,
    ),
  );
  await painted();
  assert.equal(
    await execute(() =>
      Boolean(document.querySelector('.dialog[role="dialog"]')),
    ),
    false,
  );
  keyboardTerminalIds.delete(id);
}

async function keyboardRegressions() {
  await check(
    "Modal shortcuts preserve draft input and isolate the PTY",
    async () => {
      await nav("Today", "Today");
      const hiddenTerminal = await newTerminalUI();
      await click('.term [aria-label="Hide terminal"]');
      await wait("live terminal hidden before opening a draft", () =>
        execute(() => document.querySelector("#term")?.hidden === true),
      );
      await tabTo('.sb-top [aria-label="New project"]');
      await key("\uE007");
      await wait("New project keyboard focus", () =>
        focused(".dialog input[pattern]"),
      );
      const terminalsBefore = (await invoke("term_list"))
        .map((term) => term.id)
        .sort();
      const terminalWasShown = await execute(
        () => document.querySelector("#term")?.hidden === false,
      );
      let draft = `keyboard-draft-${stamp}`;
      await keyboardText(draft);
      for (const [value, control, suffix] of [
        ["k", true, "-search"],
        ["\uE034", false, "-terminal"],
        ["`", true, "-toggle"],
      ]) {
        await key(value, control);
        await painted();
        assert.equal(
          await execute(() => Boolean(document.querySelector("#pal-in"))),
          false,
          "A modal must not stack the command palette",
        );
        assert.equal(
          await execute(
            () => document.querySelectorAll('.dialog[role="dialog"]').length,
          ),
          1,
        );
        assert.ok(
          await focused(".dialog input[pattern]"),
          "App shortcuts must leave focus in the draft",
        );
        assert.deepEqual(
          (await invoke("term_list")).map((term) => term.id).sort(),
          terminalsBefore,
          "A modal must not create or close a PTY",
        );
        assert.equal(
          await execute(
            () => document.querySelector("#term")?.hidden === false,
          ),
          terminalWasShown,
        );
        await keyboardText(suffix);
        draft += suffix;
        assert.equal(
          await execute(
            () => document.querySelector(".dialog input[pattern]")?.value,
          ),
          draft,
          "Native typing after a shortcut must reach the draft input",
        );
      }
      await key("\uE00C");
      await wait("Escape closed the draft dialog", () =>
        execute(() => !document.querySelector('.dialog[role="dialog"]')),
      );
      assert.equal(
        await execute(() => Boolean(document.querySelector("#pal-in"))),
        false,
      );
      await key("\uE034");
      await terminalFocused();
      await keyboardText("exit");
      await key("\uE007");
      await closeExitedTerminalUI(hiddenTerminal.id);
    },
  );

  await check(
    "Enter on a Today child button opens Review changes",
    async () => {
      await nav("Today", "Today");
      await tabTo(".main .item button", "Review changes", true);
      const project = await execute(
        () => document.activeElement.closest(".item").dataset.id,
      );
      assert.ok(project);
      const before = new Set(
        (await invoke("term_list")).map((term) => term.id),
      );
      await key("\uE007");
      const terminal = await wait(
        "Review changes button created a terminal",
        async () => {
          const added = (await invoke("term_list")).filter(
            (term) => !before.has(term.id),
          );
          return added.length === 1 && added[0];
        },
      );
      keyboardTerminalIds.add(terminal.id);
      assert.equal(terminal.cwd, project);
      await terminalFocused();
      await wait(
        "Review changes command prefilled through the native PTY",
        () =>
          textContains(".term-host:not([hidden]) .xterm", "git status --short"),
      );
      await key("u", true);
      await keyboardText("exit");
      await key("\uE007");
      await closeExitedTerminalUI(terminal.id);
    },
  );

  await check(
    "Connector steps focus Name, trap Tab and restore the opener",
    async () => {
      await nav("Agent history", "Agent history");
      await tabTo(".stat.add, .empty-hero button", "Add a connector");
      const opener = await command("GET", "/element/active");
      await key("\uE007");
      await tabTo(".dialog .pick", "Another tool…");
      await key("\uE007");
      await wait("custom connector form rendered", () =>
        textContains(".dialog .dh h2", "Another tool"),
      );
      await painted();
      assert.ok(
        await focused(".dialog input[name=name]"),
        "Name must receive focus before another key or click",
      );
      const name = `Keyboard connector ${stamp}`;
      await keyboardText(name);
      assert.equal(
        await execute(
          () => document.querySelector(".dialog input[name=name]").value,
        ),
        name,
      );
      await key("\uE004", false, true);
      assert.ok(
        await focused(".dialog .df button", "Add connector", true),
        "Shift+Tab wraps to the dialog footer",
      );
      await key("\uE004");
      assert.ok(await focused(".dialog input[name=name]"), "Tab wraps to Name");
      const controls = await execute(
        () =>
          [
            ...document.querySelectorAll(
              ".dialog button:not([disabled]),.dialog input:not([disabled]),.dialog select:not([disabled])",
            ),
          ].filter((control) => control.getClientRects().length).length,
      );
      for (let index = 0; index < controls + 2; index++) {
        await key("\uE004");
        assert.equal(
          await execute(() =>
            Boolean(document.activeElement?.closest('.dialog[role="dialog"]')),
          ),
          true,
          "Tab must stay inside the custom connector dialog",
        );
      }
      await tabTo(".dialog .df button", "Back", true);
      await key("\uE007");
      await wait("connector picker returned", () =>
        textContains(".dialog .dh h2", "Add a connector"),
      );
      await painted();
      assert.ok(
        await focused(".dialog button:not([disabled])"),
        "Back must focus an enabled picker control",
      );
      await key("\uE00C");
      await wait("connector dialog closed", () =>
        execute(() => !document.querySelector('.dialog[role="dialog"]')),
      );
      await painted();
      assert.equal(
        (await command("GET", "/element/active"))[elementKey],
        opener[elementKey],
        "Closing the dialog must restore its real keyboard opener",
      );
    },
  );

  await check(
    "Focused xterm F4 and terminal close preserve or stop the real job",
    async () => {
      await nav("Today", "Today");
      const reference = Object.values((await snapshot()).nodes).find(
        (node) => node.kind === "project" && !node.archived,
      );
      assert.ok(
        reference,
        "Fixture needs a project for inspector focus restoration",
      );
      await showProject(reference);
      const inspector = await execute(
        () => document.querySelector(".insp .ititle h2")?.textContent,
      );
      const terminal = await newTerminalUI();
      const ids = (await invoke("term_list")).map((term) => term.id).sort();
      await key("\uE034");
      await wait("F4 hides the panel from focused xterm", () =>
        execute(() => document.querySelector("#term")?.hidden === true),
      );
      assert.deepEqual(
        (await invoke("term_list")).map((term) => term.id).sort(),
        ids,
      );
      await key("\uE034");
      await terminalFocused();
      assert.deepEqual(
        (await invoke("term_list")).map((term) => term.id).sort(),
        ids,
      );

      await key("k", true);
      await wait("Ctrl+K from focused xterm focuses the palette", () =>
        focused("#pal-in"),
      );
      await key("\uE034");
      await painted();
      assert.ok(
        await focused("#pal-in"),
        "F4 in the palette must preserve its input focus",
      );
      assert.equal(
        await execute(() => document.querySelector("#term")?.hidden === false),
        true,
      );
      assert.deepEqual(
        (await invoke("term_list")).map((term) => term.id).sort(),
        ids,
      );
      const search = `keyboard-palette-${stamp}`;
      await keyboardText(search);
      assert.equal(
        await execute(() => document.querySelector("#pal-in")?.value),
        search,
      );
      await key("\uE00C");
      await wait("Escape closed only the palette", () =>
        execute(() => !document.querySelector("#pal-in")),
      );
      await terminalFocused();
      assert.equal(
        await execute(
          () => document.querySelector(".insp .ititle h2")?.textContent,
        ),
        inspector,
        "Palette Escape must preserve the selected inspector",
      );

      const shellFile = path.join(fixtureHome, `.keyboard-shell-${stamp}`);
      const jobFile = path.join(fixtureHome, `.keyboard-job-${stamp}`);
      keyboardFiles.push(shellFile, jobFile);
      const jobCommand = `printf '%s\\n' "$$" > ${shellQuote(jobFile)}; exec sleep 120`;
      await keyboardText(
        `printf '%s\\n' "$$" > ${shellQuote(shellFile)}; sh -c ${shellQuote(jobCommand)}`,
      );
      await key("\uE007");
      const pids = await wait(
        "foreground sleep recorded its shell and job PIDs",
        async () => {
          const values = await Promise.all(
            [shellFile, jobFile].map((file) => readFile(file, "utf8")),
          );
          return (
            values.every(
              (value) => /^\d+\s*$/.test(value) && Number(value.trim()) > 1,
            ) && values.map((value) => Number(value.trim()))
          );
        },
      );
      await wait("the foreground wrapper became sleep 120", async () => {
        const args = (await readFile(`/proc/${pids[1]}/cmdline`, "utf8"))
          .split("\0")
          .filter(Boolean);
        return (
          args.length === 2 &&
          path.basename(args[0]) === "sleep" &&
          args[1] === "120"
        );
      });
      const original = await Promise.all(pids.map(processIdentity));
      assert.ok(
        original.every(
          (process) => process && !["Z", "X"].includes(process.state),
        ),
      );
      await click(
        '.ttab[aria-selected="true"] [role="button"][aria-label^="Close terminal "]',
      );
      await wait("live terminal close confirmation", () =>
        textContains(".dialog .dh h2", `Close terminal ${terminal.title}?`),
      );
      assert.ok(
        (await invoke("term_list")).some(
          (term) => term.id === terminal.id && term.exited === undefined,
        ),
      );
      const duringDialog = await Promise.all(pids.map(processIdentity));
      assert.ok(
        duringDialog.every((process, index) =>
          sameLiveProcess(process, original[index]),
        ),
        "Opening confirmation must keep the shell and job alive",
      );
      await shot("terminal-close-confirmation");
      await tabTo(".dialog .df button", "Cancel", true);
      await key("\uE007");
      await wait("Cancel dismissed terminal close confirmation", () =>
        execute(() => !document.querySelector('.dialog[role="dialog"]')),
      );
      assert.ok(
        (await invoke("term_list")).some(
          (term) => term.id === terminal.id && term.exited === undefined,
        ),
      );
      const afterCancel = await Promise.all(pids.map(processIdentity));
      assert.ok(
        afterCancel.every((process, index) =>
          sameLiveProcess(process, original[index]),
        ),
        "Cancel must preserve the same shell and foreground job",
      );
      await click(
        '.ttab[aria-selected="true"] [role="button"][aria-label^="Close terminal "]',
      );
      await wait("live terminal confirmation reopened", () =>
        textContains(".dialog .dh h2", `Close terminal ${terminal.title}?`),
      );
      await key("\uE00C");
      await wait("Escape dismissed terminal close confirmation", () =>
        execute(() => !document.querySelector('.dialog[role="dialog"]')),
      );
      assert.ok(
        (await invoke("term_list")).some(
          (term) => term.id === terminal.id && term.exited === undefined,
        ),
      );
      const afterEscape = await Promise.all(pids.map(processIdentity));
      assert.ok(
        afterEscape.every((process, index) =>
          sameLiveProcess(process, original[index]),
        ),
        "Escape must preserve the same shell and foreground job",
      );
      await click(
        '.ttab[aria-selected="true"] [role="button"][aria-label^="Close terminal "]',
      );
      await wait("terminal close confirmation ready to commit", () =>
        textContains(".dialog .dh h2", `Close terminal ${terminal.title}?`),
      );
      await tabTo(".dialog .df button", "Close terminal", true);
      await key("\uE007");
      await wait(
        "confirmed close removed the native session",
        async () =>
          !(await invoke("term_list")).some((term) => term.id === terminal.id),
      );
      await wait(
        "confirmed close stopped the same shell and foreground job",
        async () => {
          const current = await Promise.all(pids.map(processIdentity));
          return current.every(
            (process, index) => !sameLiveProcess(process, original[index]),
          );
        },
        10_000,
      );
      keyboardTerminalIds.delete(terminal.id);
      await wait("terminal confirmation finished", () =>
        execute(() => !document.querySelector('.dialog[role="dialog"]')),
      );

      const exited = await newTerminalUI();
      await keyboardText("exit");
      await key("\uE007");
      await closeExitedTerminalUI(exited.id);
      await key("\uE00C");
      await wait("keyboard checks leave the inspector closed", () =>
        execute(() => !document.querySelector(".insp")),
      );
    },
  );
}

async function watcherRegressions() {
  await check(
    "Archived Git branch changes reach the native inspector",
    async () => {
      const archived = Object.values((await snapshot()).nodes).find(
        (node) => node.archived && node.git,
      );
      assert.ok(archived, "Fixture needs an archived Git project");
      const originalBranch = archived.git.branch;
      assert.ok(originalBranch, "Archived fixture must be on a named branch");
      const branch = `native-watcher-${stamp}`;
      await nav("Today", "Today");
      await showProject(archived);
      try {
        execFileSync("git", ["-C", archived.path, "checkout", "-qb", branch], {
          stdio: "pipe",
        });
        await wait(
          "archived Git watcher refreshed the branch",
          async () =>
            (await snapshot()).nodes[archived.path]?.git?.branch === branch,
        );
        await wait("React inspector received archived branch", () =>
          textContains(".insp .pval", branch),
        );
        assert.equal((await snapshot()).nodes[archived.path].archived, true);
      } finally {
        execFileSync(
          "git",
          ["-C", archived.path, "checkout", "-q", originalBranch],
          { stdio: "pipe" },
        );
        execFileSync("git", ["-C", archived.path, "branch", "-D", branch], {
          stdio: "pipe",
        });
      }
    },
  );
  await check(
    "Continuously written JSONL refreshes before its writer stops",
    async () => {
      const active = Object.values((await snapshot()).nodes).find(
        (node) => !node.archived && node.agents?.claude?.length,
      );
      assert.ok(active, "Fixture needs a live project with Claude history");
      const key = active.agents.claude[0];
      const sessionId = `native-stream-${stamp}`;
      const title = `Native live JSONL stream ${stamp}`;
      const streamLog = path.join(
        fixtureHome,
        ".claude/projects",
        key,
        `${sessionId}.jsonl`,
      );
      await showProject(active);
      await click('.insp [role="tab"]', "Agents");
      await writeFile(
        streamLog,
        JSON.stringify({
          type: "user",
          cwd: active.path,
          sessionId,
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
      const deadline = Date.now() + 25_000;
      let streaming = true;
      const producer = (async () => {
        while (streaming && Date.now() < deadline) {
          await appendFile(
            streamLog,
            JSON.stringify({ type: "ai-title", aiTitle: title, sessionId }) +
              "\n",
          );
          await sleep(120);
        }
      })();
      try {
        await wait(
          "snapshot refresh during continuous JSONL writes",
          async () =>
            (await snapshot()).claude[key]?.sessions.some(
              (session) => session.id === sessionId && session.title === title,
            ),
          20_000,
        );
        await wait(
          "React rendered the still-streaming session",
          () => textContains(".insp .tabbody", title),
          5_000,
        );
        assert.ok(
          streaming && Date.now() < deadline,
          "Watcher must refresh while the producer is still writing",
        );
      } finally {
        streaming = false;
        await producer;
        await rm(streamLog, { force: true });
      }
    },
  );
}

async function tidyRegressions() {
  await check(
    "Tidy quarantine applies once and Undo preserves session bytes and time",
    async () => {
      const missing = path.join(fixtureHome, "project", `missing-${stamp}`);
      const store = path.join(
        fixtureHome,
        ".claude/projects",
        missing.replace(/[^A-Za-z0-9]/g, "-"),
      );
      const file = path.join(store, `${stamp}.jsonl`);
      await mkdir(store, { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          type: "user",
          cwd: missing,
          sessionId: stamp,
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
      const bytes = await readFile(file);
      const modified = (await stat(file, { bigint: true })).mtimeNs;
      let journal;
      try {
        await api("rescan");
        const proposal = (await snapshot()).proposals.find(
          (item) =>
            item.action?.type === "quarantine" &&
            item.action.moves.some((move) => move.from === store),
        );
        assert.ok(proposal, "Missing fixture should have a quarantine proposal");
        const destination = path.join(
          fixtureHome,
          ".local/share/laci/orphans",
          proposal.action.moves.find((move) => move.from === store).to,
        );
        const count = (log) =>
          log.entries.filter((entry) => entry.title === proposal.title).length;
        const before = await api("log");
        const previous = count(before);
        const beforeIds = new Set(before.entries.map((entry) => entry.id));
        await nav("Tidy up", "Tidy up");
        const row = `.prop-row[data-id=${JSON.stringify(proposal.id)}]`;
        await click(`${row} .item`);
        await element(`${row} .row-acts button`, "Apply");
        // Two clicks in one browser task exercise the guard before React rerenders.
        await execute(
          (selector) => {
            const button = document.querySelector(selector);
            button.click();
            button.click();
          },
          `${row} .row-acts button`,
        );
        journal = await wait("one committed quarantine journal", async () => {
          const log = await api("log");
          assert.ok(count(log) <= previous + 1, "Apply must not submit twice");
          return log.entries.find(
            (entry) =>
              !beforeIds.has(entry.id) &&
              entry.title === proposal.title &&
              entry.journal,
          )?.journal;
        });
        await wait("quarantine overlay resolved", () =>
          execute(() => {
            const toast = document.querySelector(".toast");
            return (
              toast?.textContent.includes("Changes applied") &&
              !toast.inert &&
              !document.querySelector(".busy")
            );
          }),
        );
        assert.equal(
          await execute(
            (selector) => Boolean(document.querySelector(selector)),
            row,
          ),
          false,
          "Applied history proposal must not remain usable",
        );
        await shot("tidy-applied");
        const movedFile = path.join(destination, `${stamp}.jsonl`);
        assert.deepEqual(await readFile(movedFile), bytes);
        assert.equal(
          (await stat(movedFile, { bigint: true })).mtimeNs,
          modified,
        );
        await wait("history refreshed before Undo", async () =>
          !(await api("status")).historyPending,
        );
        assert.equal(count(await api("log")), previous + 1);
        const appliedJournal = journal;
        await wait("quarantine Undo enabled in React", () =>
          execute(() => {
            const button = document.querySelector(".toast button");
            return button && !button.disabled;
          }),
        );
        await click(".toast button", "Undo", true);
        await wait("quarantined session restored", async () => {
          try {
            await access(file);
            return true;
          } catch {
            return false;
          }
        });
        journal = undefined;
        await wait("Undo history refreshed", async () =>
          !(await api("status")).historyPending,
        );
        assert.deepEqual(await readFile(file), bytes);
        assert.equal((await stat(file, { bigint: true })).mtimeNs, modified);
        assert.equal(
          (await api("log")).entries.find(
            (entry) => entry.journal === appliedJournal,
          ).state,
          "undone",
        );
      } finally {
        if (journal) {
          await wait("history ready for fixture recovery", async () =>
            !(await api("status")).historyPending,
          ).catch(() => {});
          await api("undo", { id: journal }).catch(() => {});
        }
        await rm(store, { recursive: true, force: true });
      }
    },
  );
}

try {
  await access(binary);
  await wait(
    "tauri-driver ready",
    async () => {
      const status = await request("GET", "/status", undefined, 1_500);
      return status?.ready !== false;
    },
    15_000,
  );
  const created = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: { "tauri:options": { application: binary } },
      firstMatch: [{}],
    },
  });
  session = created.sessionId;
  assert.ok(session, "tauri-driver must return a session ID");
  await command("POST", "/timeouts", {
    script: 120_000,
    pageLoad: 120_000,
    implicit: 0,
  });
  await command("POST", "/window/rect", { width: 1440, height: 900 });
  await wait("Tauri IPC ready", () =>
    execute(() => Boolean(window.__TAURI_INTERNALS__)),
  );
  await installErrorCollection();
  let current = await snapshot();
  fixtureHome = path.resolve(current.home);
  if (process.env.LACI_HOME) {
    assert.equal(
      fixtureHome,
      path.resolve(process.env.LACI_HOME),
      "Driver and smoke must use the same isolated LACI_HOME",
    );
  } else {
    assert.ok(
      fixtureHome.startsWith(path.resolve(tmpdir()) + path.sep),
      "Run against an isolated LACI_HOME under /tmp",
    );
  }
  assert.notEqual(fixtureHome, path.parse(fixtureHome).root);
  await access(path.join(fixtureHome, "project"));
  console.log(`Native app: ${binary}\nIsolated fixture: ${fixtureHome}`);
  originalTheme = await execute(
    () => document.documentElement.dataset.theme ?? "system",
  );
  if (onboardingOnly) {
    assert.equal(
      current.configured,
      false,
      "First-run fixture must have no config",
    );
    await check(
      "First-run wizard saves roots, presets and apps through React",
      async () => {
        await wait("native onboarding wizard", () =>
          textContains(".setup h1", "Welcome to laci"),
        );
        await wait("onboarding choices loaded", () =>
          textContains(".setup .sset", "Where do you keep projects?"),
        );
        await tabTo('.setup input[type="checkbox"]');
        await key("k", true);
        await wait("onboarding palette keyboard focus", () =>
          focused("#pal-in"),
        );
        await keyboardText("New project");
        await wait("New project palette action", () =>
          textContains(".pal-item", "New project"),
        );
        await key("\uE007");
        await wait("New project dialog opened from onboarding", () =>
          execute(() =>
            Boolean(document.querySelector(".dialog input[pattern]")),
          ),
        );
        await painted();
        assert.ok(
          await focused(".dialog input[pattern]"),
          "A wizard opener must not steal focus from the modal Name input",
        );
        const wizardDraft = `onboarding-draft-${stamp}`;
        await keyboardText(wizardDraft);
        assert.equal(
          await execute(
            () => document.querySelector(".dialog input[pattern]")?.value,
          ),
          wizardDraft,
        );
        await key("\uE00C");
        await wait("onboarding draft cancelled", () =>
          execute(() => !document.querySelector('.dialog[role="dialog"]')),
        );
        await painted();
        assert.equal(
          await execute(() => {
            const active = document.activeElement;
            return Boolean(
              active?.isConnected &&
              active.closest(".setup") &&
              !active.closest("[inert]"),
            );
          }),
          true,
          "Modal close must return focus to a connected, usable wizard control or main fallback",
        );
        assert.equal(
          (await snapshot()).configured,
          false,
          "Opening and cancelling a draft must not configure the wizard",
        );
        await shot("first-run");
        const rootInputs = await execute(() =>
          [...document.querySelectorAll(".setup .sset:first-of-type .opt")].map(
            (label) => ({
              input: label.querySelector("input"),
              text: label.querySelector(".mono")?.textContent,
              checked: label.querySelector("input").checked,
            }),
          ),
        );
        assert.ok(rootInputs.some((root) => root.text === "~/project"));
        for (const root of rootInputs) {
          if (root.checked)
            await command(
              "POST",
              `/element/${root.input[elementKey]}/click`,
              {},
            );
        }
        await click(".setup .sset:first-of-type .opt", "~/project");
        const presets = await execute(() =>
          [
            ...document.querySelectorAll(
              ".setup .sset:nth-of-type(2) .opt input",
            ),
          ].map((input) => ({ input, checked: input.checked })),
        );
        assert.ok(presets.length > 0);
        for (const preset of presets) {
          if (!preset.checked)
            await command(
              "POST",
              `/element/${preset.input[elementKey]}/click`,
              {},
            );
        }
        await command(
          "POST",
          `/element/${presets[0].input[elementKey]}/click`,
          {},
        );
        await command(
          "POST",
          `/element/${presets[0].input[elementKey]}/click`,
          {},
        );
        const selectedApps = {};
        for (const [offset, kind] of [
          "editor",
          "files",
          "terminal",
        ].entries()) {
          const index = offset + 1;
          const selector = `.setup .apps .fld:nth-child(${index}) select`;
          const choices = await execute(
            (selector) => ({
              value: document.querySelector(selector).value,
              options: [...document.querySelector(selector).options].map(
                (option) => option.value,
              ),
            }),
            selector,
          );
          const choice =
            choices.options.find((value) => value !== choices.value) ??
            choices.value;
          assert.ok(choice);
          await select(selector, choice);
          selectedApps[kind] = choice;
        }
        await click(".setup-foot button", "Start using laci", true);
        await wait("wizard finished and Today mounted", () =>
          textContains(".main .head h1", "Today"),
        );
        current = await snapshot();
        assert.equal(current.configured, true);
        assert.deepEqual(current.roots, [path.join(fixtureHome, "project")]);
        assert.equal(
          current.connectors.filter((connector) => connector.builtin).length,
          presets.length,
        );
        const saved = JSON.parse(
          await readFile(
            path.join(fixtureHome, ".config/laci/config.json"),
            "utf8",
          ),
        );
        assert.deepEqual(saved.apps, selectedApps);
        await nav("Settings", "Settings");
        await wait("saved settings loaded", () =>
          textContains(".main .sset", "Where do you keep projects?"),
        );
        await shot("settings");
        assert.deepEqual(
          await execute(() => window.__LACI_SMOKE_ERRORS__ ?? []),
          [],
        );
      },
    );
    console.log(
      JSON.stringify(
        { passed: true, binary, fixtureHome, checks: results },
        null,
        2,
      ),
    );
  } else {
    if (
      !current.configured ||
      current.roots.length !== 1 ||
      current.roots[0] !== path.join(fixtureHome, "project")
    ) {
      const presets = [
        ...new Set([
          ...current.connectors.filter((c) => c.builtin).map((c) => c.id),
          ...current.suggestions.map((c) => c.id),
        ]),
      ];
      await api("setup/save", {
        roots: [path.join(fixtureHome, "project")],
        presets,
        apps: { editor: "code", files: "dolphin", terminal: "kitty" },
      });
      current = await wait("setup history accepted", async () => {
        const latest = await snapshot();
        return latest.configured && !latest.historyPending && latest;
      });
    }
    await wait("React app mounted", () =>
      execute(() => Boolean(document.querySelector(".main"))),
    );

    if (!watcherOnly && !keyboardOnly && !modularOnly) {
      await check(
        "Startup sidebar follows the completed native scan",
        async () => {
          await wait(
            "initial engine scan completed",
            async () => !(await api("status")).busy,
          );
          await wait("sidebar reports the completed scan", () =>
            textContains(".sb-foot button", "Up to date"),
          );
        },
      );
    }
    if (process.env.LACI_STARTUP_PROJECT && process.env.LACI_STARTUP_TEXT) {
      await check(
        "Fresh startup data replaces its cached snapshot in React",
        async () => {
          const projectPath = process.env.LACI_STARTUP_PROJECT;
          const expected = process.env.LACI_STARTUP_TEXT;
          const project = await wait(
            "initial scan refreshed cached README",
            async () => {
              const project = (await snapshot()).nodes[projectPath];
              return project?.readme?.raw.includes(expected) && project;
            },
          );
          await showProject(project);
          await click('.insp [role="tab"]', "README");
          await wait("React renders the fresh startup README", () =>
            textContains(".insp .readme", expected),
          );
          await key("\uE00C");
        },
      );
    }

    if (modularOnly) {
      await modularRegressions();
      assert.deepEqual(await execute(() => window.__LACI_SMOKE_ERRORS__ ?? []), []);
      console.log(JSON.stringify({ passed: true, binary, fixtureHome, checks: results }, null, 2));
    } else if (watcherOnly) {
      await tidyRegressions();
      await watcherRegressions();
      assert.deepEqual(
        await execute(() => window.__LACI_SMOKE_ERRORS__ ?? []),
        [],
      );
      console.log(
        JSON.stringify(
          { passed: true, binary, fixtureHome, checks: results },
          null,
          2,
        ),
      );
    } else if (keyboardOnly) {
      await keyboardRegressions();
      await check("No unhandled frontend errors", async () => {
        assert.deepEqual(
          await execute(() => window.__LACI_SMOKE_ERRORS__ ?? []),
          [],
        );
      });
      console.log(
        JSON.stringify(
          {
            passed: true,
            binary,
            fixtureHome,
            mode: "keyboard",
            checks: results,
          },
          null,
          2,
        ),
      );
    } else {
      const reference =
        Object.values(current.nodes).find(
          (n) =>
            n.kind === "project" &&
            n.readme &&
            n.agents.claude.length &&
            !n.archived,
        ) ??
        Object.values(current.nodes).find(
          (n) => n.kind === "project" && n.readme && !n.archived,
        );
      assert.ok(reference, "Fixture needs at least one project with a README");

      await keyboardRegressions();

      await check("Six views and both themes", async () => {
        await nav("Today", "Today");
        await theme("light");
        await shot("today-light");
        await theme("dark");
        await shot("today-dark");
        await click(
          ".tree-row .tl",
          current.roots[0] === current.home ? "Home" : undefined,
        );
        await wait("folder browser", () =>
          execute(() => Boolean(document.querySelector(".filterbar .chipf"))),
        );
        await shot("browse");
        await nav("Tidy up", "Tidy up");
        const proposal = await execute(() =>
          document.querySelector(".prop-row .item"),
        );
        if (proposal)
          await command("POST", `/element/${proposal[elementKey]}/click`, {});
        await shot("tidy");
        await nav("Agent history", "Agent history");
        await shot("agents");
        await nav("Log", "Log");
        await nav("Settings", "Settings");
        await wait("settings sections loaded", () =>
          textContains(".main .sset", "Where do you keep projects?"),
        );
        assert.ok(
          await textContains(".main .sset", "Which AI tools do you use?"),
        );
        await nav("Today", "Today");
      });

      await check("Palette highlighting and four inspector tabs", async () => {
        await key("k", true);
        await type("#pal-in", reference.name);
        await wait("highlighted project hit", () =>
          execute(() => Boolean(document.querySelector(".pal-item .hl"))),
        );
        await key("\uE00C");
        await showProject(reference);
        for (const label of ["Health", "To-do", "Agents", "README"]) {
          await click('.insp [role="tab"]', label);
          await wait(`${label} inspector tab`, () =>
            execute(
              (label) =>
                [...document.querySelectorAll('.insp [role="tab"]')].some(
                  (tab) =>
                    tab.textContent.includes(label) &&
                    tab.getAttribute("aria-selected") === "true",
                ),
              label,
            ),
          );
        }
        assert.equal(
          await execute(
            () => document.querySelectorAll(".readme script").length,
          ),
          0,
        );
        await click('.insp [role="tab"]', "Health");
        await shot("project");
        const archiveButton = await execute(
          () =>
            [...document.querySelectorAll(".insp .iacts button")].find(
              (button) => button.textContent.trim() === "Archive",
            ) ?? null,
        );
        if (archiveButton) {
          await command(
            "POST",
            `/element/${archiveButton[elementKey]}/click`,
            {},
          );
          await wait("archive preview", () =>
            textContains(".dialog .dh h2", `Archive ${reference.name}?`),
          );
          await shot("archive");
          await click(".dialog button", "Cancel", true);
        }
        await key("?");
        await wait("shortcut help", () =>
          textContains(".dialog .dh h2", "Keyboard shortcuts"),
        );
        await key("\uE00C");
      });

      await check("Heavy archive preview explains trash behavior", async () => {
        const heavyProject = Object.values((await snapshot()).nodes).find(
          (node) =>
            !node.archived && node.size?.reclaimable && node.archivePlan,
        );
        if (!heavyProject) return;
        await showProject(heavyProject);
        await click(".insp .iacts button", "Archive", true);
        await click(".dialog .ops input[type=checkbox]");
        await wait("selected cleanup copy", () =>
          textContains(".dialog .df", "remain in the system trash"),
        );
        await click(".dialog .ops input[type=checkbox]");
        assert.equal(
          await textContains(".dialog .df", "remain in the system trash"),
          false,
        );
        await click(".dialog button", "Cancel", true);
      });

      const newPath = path.join(fixtureHome, "project", projectName);
      await check("New project dialog creates a real project", async () => {
        await click('.sb-top [aria-label="New project"]');
        await type(".dialog input[pattern]", projectName);
        await select(".dialog .row2 select", path.join(fixtureHome, "project"));
        await shot("new-project");
        await click(".dialog .df button", "Create project", true);
        await wait(
          "new project on disk and snapshot",
          async () => (await snapshot()).nodes[newPath],
        );
        await wait("new project inspector", () =>
          textContains(".insp .ititle h2", projectName),
        );
        await access(path.join(newPath, ".git"));
        assert.ok(
          (await readFile(path.join(newPath, "README.md"), "utf8")).includes(
            projectName,
          ),
        );
      });

      await check("Metadata, tasks and notes saved through React", async () => {
        await select('.insp select[aria-label="Status"]', "paused");
        await wait(
          "status persisted",
          async () =>
            (await snapshot()).nodes[newPath]?.meta.status === "paused",
        );
        await select('.insp select[aria-label="Priority"]', "high");
        await wait(
          "priority persisted",
          async () =>
            (await snapshot()).nodes[newPath]?.meta.priority === "high",
        );
        await click('.insp [role="tab"]', "To-do");
        await type(".insp .add input", todoText);
        await key("\uE007");
        await wait("task added", async () =>
          (await snapshot()).nodes[newPath]?.tasks.some(
            (task) => task.text === todoText,
          ),
        );
        const checkbox = await execute(
          (text) =>
            [...document.querySelectorAll(".insp .todo")]
              .find((todo) => todo.textContent.includes(text))
              ?.querySelector('input[type="checkbox"]') ?? null,
          todoText,
        );
        assert.ok(checkbox);
        await command("POST", `/element/${checkbox[elementKey]}/click`, {});
        await wait("task ticked", async () =>
          (await snapshot()).nodes[newPath]?.tasks.some(
            (task) => task.text === todoText && task.done,
          ),
        );
        await type(".insp textarea.notes", notesText);
        await click('.insp [role="tab"]', "Health");
        await wait(
          "notes flushed when tab closes",
          async () => (await snapshot()).nodes[newPath]?.notes === notesText,
        );
        const sidecar = await readFile(path.join(newPath, ".laci.md"), "utf8");
        assert.ok(sidecar.includes("status: paused"));
        assert.ok(sidecar.includes(notesText));
      });

      await check(
        "Duplicate checkboxes keep their identity through delete and Undo",
        async () => {
          await click('.insp [role="tab"]', "To-do");
          for (let index = 0; index < 2; index++) {
            await type(".insp .add input", duplicateTodoText);
            await key("\uE007");
            await wait(
              "repeated task added",
              async () =>
                (await snapshot()).nodes[newPath]?.tasks.filter(
                  (task) => task.text === duplicateTodoText,
                ).length ===
                index + 1,
            );
            await wait("repeated task rendered", () =>
              execute(
                (text, expected) =>
                  [...document.querySelectorAll(".insp .todo .txt")].filter(
                    (element) => element.textContent.trim() === text,
                  ).length === expected,
                duplicateTodoText,
                index + 1,
              ),
            );
          }
          const rows = await execute(
            (text) =>
              [...document.querySelectorAll(".insp .todo")]
                .filter(
                  (row) =>
                    row.querySelector(".txt")?.textContent.trim() === text,
                )
                .map((row) => ({
                  checkbox: row.querySelector('input[type="checkbox"]'),
                  remove: row.querySelector('button[aria-label="Delete"]'),
                })),
            duplicateTodoText,
          );
          assert.equal(rows.length, 2);
          await command(
            "POST",
            `/element/${rows[1].checkbox[elementKey]}/click`,
            {},
          );
          await wait("only the second duplicate ticked", async () => {
            const duplicates = (await snapshot()).nodes[newPath]?.tasks.filter(
              (task) => task.text === duplicateTodoText,
            );
            return (
              duplicates?.length === 2 &&
              !duplicates[0].done &&
              duplicates[1].done
            );
          });
          await command(
            "POST",
            `/element/${rows[0].remove[elementKey]}/click`,
            {},
          );
          await wait("the unticked duplicate was deleted", async () => {
            const duplicates = (await snapshot()).nodes[newPath]?.tasks.filter(
              (task) => task.text === duplicateTodoText,
            );
            return duplicates?.length === 1 && duplicates[0].done;
          });
          await nav("Log", "Log");
          const undo = await wait("deleted duplicate Undo entry", () =>
            execute(
              (project) =>
                [...document.querySelectorAll(".main .prop-row")]
                  .find(
                    (row) =>
                      row.querySelector(".t")?.textContent ===
                      `Deleted a next step from ${project}`,
                  )
                  ?.querySelector("button") ?? null,
              projectName,
            ),
          );
          await command("POST", `/element/${undo[elementKey]}/click`, {});
          await wait(
            "Undo restored the correct duplicate position",
            async () => {
              const duplicates = (await snapshot()).nodes[
                newPath
              ]?.tasks.filter((task) => task.text === duplicateTodoText);
              return (
                duplicates?.length === 2 &&
                !duplicates[0].done &&
                duplicates[1].done
              );
            },
          );
          await showProject((await snapshot()).nodes[newPath]);
        },
      );

      await check(
        "External file changes update snapshot and folder listing",
        async () => {
          await click('.insp [role="tab"]', "README");
          const readme = path.join(newPath, "README.md");
          await writeFile(
            readme,
            (await readFile(readme, "utf8")) + `\n${watcherText}\n`,
          );
          await wait("watcher refreshed README without manual scan", async () =>
            (await snapshot()).nodes[newPath]?.readme?.raw.includes(
              watcherText,
            ),
          );
          await wait("React received changed README", () =>
            textContains(".insp .readme", watcherText),
          );
          await click(".tree-row .tl");
          const selector = `.main .frow[data-id=${JSON.stringify(newPath)}]`;
          await doubleClick(selector);
          await wait("inside new project folder", () =>
            textContains(".main .head h1", projectName),
          );
          watchedFile = path.join(newPath, `watcher-${stamp}.txt`);
          await writeFile(watchedFile, "Watcher file added outside the app.\n");
          await wait("new file appeared in open listing", () =>
            execute(
              (file) =>
                [...document.querySelectorAll(".main .frow")].some(
                  (row) => row.dataset.id === file,
                ),
              watchedFile,
            ),
          );
          await rm(watchedFile);
          await wait("removed file disappeared from listing", () =>
            execute(
              (file) =>
                ![...document.querySelectorAll(".main .frow")].some(
                  (row) => row.dataset.id === file,
                ),
              watchedFile,
            ),
          );
          watchedFile = undefined;
        },
      );

      await check("Custom connector dialog and removal", async () => {
        const name = `Desktop smoke ${stamp}`;
        await nav("Agent history", "Agent history");
        await click(".stat.add, .empty-hero button", "Add a connector");
        await shot("connector-picker");
        await click(".dialog .pick", "Another tool…");
        await type(".dialog input[name=name]", name);
        await click(".dialog input[name=kind][value=inside]");
        await type(".dialog input[name=path]", ".smoke-agent");
        await shot("connector-custom");
        await click(".dialog .df button", "Add connector", true);
        await wait("custom connector saved", async () =>
          (await snapshot()).connectors.some(
            (connector) => connector.name === name && !connector.builtin,
          ),
        );
        const remove = await wait("custom connector removal enabled in React", () =>
          execute(
            (name) => {
              const button = [...document.querySelectorAll(".stat")]
                .find((card) => card.querySelector(".k")?.textContent === name)
                ?.querySelector("button");
              return button && !button.disabled ? button : null;
            },
            name,
          ),
        );
        assert.ok(remove);
        await command("POST", `/element/${remove[elementKey]}/click`, {});
        await wait(
          "custom connector removed",
          async () =>
            !(await snapshot()).connectors.some(
              (connector) => connector.name === name,
            ),
        );
        await click(".tree-row .tl");
        await doubleClick(`.main .frow[data-id=${JSON.stringify(newPath)}]`);
        await wait("returned to project folder", () =>
          textContains(".main .head h1", projectName),
        );
      });

      let termId;
      await check(
        "F4 terminal output, resize, replay and theme after reload",
        async () => {
          await key("\uE034");
          await wait("embedded terminal visible", () =>
            execute(() =>
              Boolean(document.querySelector(".term:not([hidden]) .xterm")),
            ),
          );
          const terminals = await invoke("term_list");
          const terminal =
            terminals.find((term) => term.cwd === newPath) ?? terminals.at(-1);
          assert.ok(terminal);
          termId = terminal.id;
          await invoke("term_input", {
            id: termId,
            data: `printf '\\n${terminalText}\\n'\r`,
          });
          await wait("PTY output reached xterm Channel", () =>
            textContains(".term .xterm", terminalText),
          );
          await shot("terminal");
          await command("POST", "/window/rect", { width: 1100, height: 760 });
          await wait("terminal remains fitted after window resize", () =>
            execute(() => {
              const host = document.querySelector(".term:not([hidden]) .xterm");
              return host && host.getBoundingClientRect().width > 0;
            }),
          );
          await invoke("term_input", {
            id: termId,
            data: "printf 'LACI_RESIZED_OK\\n'\r",
          });
          await wait("input still works after resize", () =>
            textContains(".term .xterm", "LACI_RESIZED_OK"),
          );
          await command("POST", "/window/rect", { width: 1440, height: 900 });
          frontendErrors.push(
            ...(await execute(() => window.__LACI_SMOKE_ERRORS__ ?? [])),
          );
          await command("POST", "/refresh", {});
          await wait("React restored after reload", () =>
            execute(() => Boolean(document.querySelector(".main .head h1"))),
          );
          await installErrorCollection();
          assert.equal(
            await execute(() => document.documentElement.dataset.theme),
            "dark",
          );
          assert.ok(
            (await invoke("term_list")).some((term) => term.id === termId),
          );
          await key("\uE034");
          await wait("terminal tab restored from native process", () =>
            execute(() =>
              Boolean(document.querySelector(".term:not([hidden]) .xterm")),
            ),
          );
          await wait("terminal output replayed after reload", () =>
            textContains(".term .xterm", terminalText),
          );
          await click('.ttab[aria-selected="true"] .x');
          await wait("terminal close confirmation after replay", () =>
            textContains(".dialog .dh h2", `Close terminal ${terminal.title}?`),
          );
          await click(".dialog .df button", "Close terminal", true);
          await wait(
            "terminal closed through UI",
            async () =>
              !(await invoke("term_list")).some((term) => term.id === termId),
          );
          const node = (await snapshot()).nodes[newPath];
          assert.equal(node.meta.status, "paused");
          assert.equal(node.notes, notesText);
          assert.ok(
            node.tasks.some((task) => task.text === todoText && task.done),
          );
        },
      );

      await check(
        "Archive preview, archive and toast Undo preserve project data",
        async () => {
          await nav("Today", "Today");
          const project = (await snapshot()).nodes[newPath];
          assert.ok(project.archivePlan);
          const destination = project.archivePlan.dest;
          const before = await readFile(path.join(newPath, ".laci.md"));
          await showProject(project);
          await click(".insp .iacts button", "Archive", true);
          await wait("archive changes previewed", () =>
            execute(() => Boolean(document.querySelector(".dialog .ops li"))),
          );
          await click(".dialog .df button", "Archive", true);
          await wait("project archived in snapshot", async () => {
            const current = await snapshot();
            return !current.nodes[newPath] && current.nodes[destination];
          });
          await access(destination);
          await click(".toast button", "Undo", true);
          await wait("archive undone in snapshot", async () => {
            const current = await snapshot();
            return current.nodes[newPath] && !current.nodes[destination];
          });
          assert.deepEqual(
            await readFile(path.join(newPath, ".laci.md")),
            before,
          );
          assert.ok(
            (await readFile(path.join(newPath, "README.md"), "utf8")).includes(
              watcherText,
            ),
          );
          await nav("Log", "Log");
          await wait("activity log received archive and undo", () =>
            textContains(".main .body", projectName),
          );
          await click('.main .prop-row .item[aria-expanded="false"]');
          await shot("log");
        },
      );

      await tidyRegressions();
      await watcherRegressions();
      await modularRegressions();

      await check("No unhandled frontend errors", async () => {
        const errors = await execute(() => window.__LACI_SMOKE_ERRORS__ ?? []);
        assert.deepEqual([...frontendErrors, ...errors], []);
      });
      console.log(
        JSON.stringify(
          {
            passed: true,
            binary,
            fixtureHome,
            newProject: newPath,
            checks: results,
          },
          null,
          2,
        ),
      );
    }
  }
} catch (error) {
  console.error(error.stack ?? error);
  if (session) {
    await shot("smoke-failure").catch(() => {});
    const diagnostics = await execute(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 6000),
      errors: window.__LACI_SMOKE_ERRORS__ ?? [],
    })).catch(() => null);
    console.error(
      JSON.stringify({ passed: false, checks: results, diagnostics }, null, 2),
    );
  }
  process.exitCode = 1;
} finally {
  if (watchedFile) await rm(watchedFile, { force: true }).catch(() => {});
  if (session) {
    await command("DELETE", "/actions").catch(() => {});
    for (const id of keyboardTerminalIds) {
      await invoke("term_close", { id }).catch(() => {});
    }
    for (const file of keyboardFiles) {
      await rm(file, { force: true }).catch(() => {});
    }
    if (originalTheme) {
      await execute((theme) => {
        try {
          localStorage.setItem("laci:theme", theme);
        } catch {}
        if (theme === "system") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
      }, originalTheme).catch(() => {});
      await api("theme", {
        theme: originalTheme === "system" ? "" : originalTheme,
      }).catch(() => {});
    }
    await command("DELETE", "").catch(() => {});
  }
}
