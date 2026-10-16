/**
 * Native desktop integration checks using tauri-driver and W3C WebDriver.
 *
 * Start tauri-driver with an isolated LACI_HOME that contains scripts/demo.ts
 * fixtures, then run: LACI_HOME=/tmp/laci-demo node scripts/desktop-smoke.mjs
 * LACI_BINARY overrides target/debug/laci; LACI_WEBDRIVER defaults to :4444.
 * LACI_SCREENSHOTS optionally receives screenshots from the real app window.
 * LACI_SMOKE_DIAGNOSTICS receives a screenshot, the page text, the app status and the end of its debug log when a
 * check fails; without it they go to a new laci-smoke-diagnostics-* folder in the temp folder. Not inside LACI_HOME.
 * LACI_ONBOARDING_ONLY=1 checks the first-run wizard on an unconfigured fixture.
 * LACI_WATCHER_ONLY=1 checks archived/worktree Git and continuously written session logs.
 * LACI_MODULAR_ONLY=1 checks external scan and archive folders, project Trash, and session reports.
 * LACI_KEYBOARD_ONLY=1 checks modal, connector, row and terminal keyboard behavior.
 * LACI_PATCH_ONLY=1 checks themed selects, empty roots after reload, and isolated generator cancellation/failure.
 * LACI_AGENT_ONLY=1 uses fixture bin scripts and LACI_AGENT_CAPTURE; driver PATH must be fixture/bin:/usr/bin:/bin.
 * LACI_STARTUP_PROJECT/TEXT optionally check a README changed after a cached scan.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
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
const patchOnly = process.env.LACI_PATCH_ONLY === "1";
const agentOnly = process.env.LACI_AGENT_ONLY === "1";
const fakeAgentProcesses = new Map();
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
  }).catch((error) => {
    throw new Error(`${method} ${route}: ${error.message ?? error}`, {
      cause: error,
    });
  });
  const reply = await response.json();
  if (!response.ok || reply.value?.error) {
    throw new Error(
      `${method} ${route}: ${reply.value?.message || JSON.stringify(reply)}`,
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
async function saveSetup(body) {
  await wait(
    "settings history ready",
    async () => !(await api("status")).historyPending,
  );
  const result = await api("setup/save", body);
  await wait(
    "settings refresh complete",
    async () => !(await api("status")).historyPending,
  );
  return result;
}
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
/**
 * Waits until no scan, history refresh or project Git check has run for 1.2 s, so the next click is not dropped.
 * Longer than the 900 ms the app's watcher holds file events (src-tauri/src/app/mod.rs) before it starts a refresh.
 */
async function settled(label) {
  let idleSince;
  await wait(label, async () => {
    const status = await api("status");
    if (status.busy || status.historyPending) {
      idleSince = undefined;
      return false;
    }
    idleSince ??= Date.now();
    return Date.now() - idleSince >= 1_200;
  });
}
/** wait() for what a dialog submits: the dialog's own error alert ends it at once, instead of a timeout hiding it. */
async function waitAccepted(label, condition, timeout) {
  let refusal = "";
  const accepted = await wait(
    label,
    async () => {
      refusal = await execute(
        () =>
          [...document.querySelectorAll(".dialog [role=alert]")]
            .map((alert) => alert.textContent.trim())
            .find(Boolean) ?? "",
      );
      // wait() retries when its condition throws, so a refusal ends it as a value and is thrown below.
      return refusal || condition();
    },
    timeout,
  );
  if (refusal)
    throw new Error(`Dialog error while waiting for “${label}”: ${refusal}`);
  return accepted;
}
/** Gives up on a window that stopped answering, so a failing run does not wait minutes on each diagnostic. */
async function withTimeout(ms, work) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${ms / 1000} s`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/**
 * Keeps what a failing check shows before anything is cleaned up: the end of the debug log, the page text with any
 * open dialog, a screenshot and the app status. They go outside the fixture home, which CI deletes. This never
 * throws, so the error being reported stays the original one.
 */
async function diagnose(name, error) {
  try {
    const reason = String(error?.message ?? error).replace(/\s+/g, " ");
    console.error(`FAIL ${name}: ${reason.slice(0, 300)}`);
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const parent = process.env.LACI_SMOKE_DIAGNOSTICS
      ? path.resolve(process.env.LACI_SMOKE_DIAGNOSTICS)
      : await mkdtemp(path.join(tmpdir(), "laci-smoke-diagnostics-"));
    const folder = path.join(parent, `${stamp}-${slug}`);
    await mkdir(folder, { recursive: true });
    const save = async (file, produce) => {
      try {
        await writeFile(path.join(folder, file), await produce());
      } catch (problem) {
        await writeFile(
          path.join(folder, `${file}.failed.txt`),
          String(problem?.stack ?? problem),
        ).catch(() => {});
      }
    };
    await save("error.txt", () => `${name}\n\n${error?.stack ?? error}\n`);
    if (fixtureHome)
      await save("laci-log-tail.txt", async () => {
        const log = await readFile(
          path.join(fixtureHome, ".local/share/laci/laci.log"),
          "utf8",
        );
        return log.trimEnd().split("\n").slice(-200).join("\n") + "\n";
      });
    if (session) {
      await save("page.txt", () =>
        withTimeout(
          15_000,
          execute(() => {
            const dialog = document.querySelector(".dialog");
            const open = dialog ? `Open dialog:\n${dialog.innerText}\n\n` : "";
            return `${open}Page:\n${document.body.innerText}\n`;
          }),
        ),
      );
      await save("screenshot.png", async () =>
        Buffer.from(
          await withTimeout(15_000, command("GET", "/screenshot")),
          "base64",
        ),
      );
      await save("status.json", async () => {
        const status = await withTimeout(15_000, api("status"));
        return JSON.stringify(status, null, 2) + "\n";
      });
    }
    console.error(`Diagnostics for ${name}: ${folder}`);
  } catch (problem) {
    console.error(`Could not save diagnostics: ${problem?.message ?? problem}`);
  }
}
async function check(name, task) {
  const started = Date.now();
  try {
    await task();
  } catch (error) {
    // Before a surrounding finally closes the dialog and restores the settings the failure happened in.
    await diagnose(name, error);
    throw error;
  }
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
  if (!value) return;
  const lines = value.split("\n");
  for (const [index, line] of lines.entries()) {
    // WebKit's text endpoint drops LF; a real Enter preserves textarea newlines.
    if (index) await key("\uE007");
    if (line)
      await command("POST", `/element/${target[elementKey]}/value`, {
        text: line,
      });
  }
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
async function selectOptions(selector) {
  await click(selector);
  await element("[data-laci-select-popup]");
  return execute(() =>
    [
      ...document.querySelectorAll('[data-laci-select-popup] [role="option"]'),
    ].map((option) => ({
      value: option.getAttribute("data-value"),
      label: option.textContent.trim(),
      selected: option.getAttribute("data-state") === "checked",
      disabled: option.hasAttribute("data-disabled"),
    })),
  );
}
async function select(selector, value) {
  await click(selector);
  await click(
    `[data-laci-select-popup] [role="option"][data-value=${JSON.stringify(value)}]`,
  );
  await wait("selection popup closed", () =>
    execute(() => !document.querySelector("[data-laci-select-popup]")),
  );
}
async function discardDraft() {
  await key("\uE00C");
  await wait("draft retained for an explicit decision", () =>
    textContains(".dialog .df", "Keep editing"),
  );
  await click(".dialog .df button", "Discard draft", true);
  await wait("draft discarded", () =>
    execute(() => !document.querySelector(".dialog")),
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
async function shot(name, settle = true) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  if (settle)
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
  const external = await mkdtemp(
    path.join(path.dirname(fixtureHome), "laci-modular-"),
  );
  const scanRoot = path.join(external, "projects");
  const archiveRoot = path.join(external, "archive");
  const source = path.join(scanRoot, `modular-${stamp}`);
  const backup = path.join(external, "backup.git");
  const original = await api("setup/info");
  const trashRoot = path.join(fixtureHome, ".local/share/Trash");
  const historyDir = path.join(
    fixtureHome,
    ".claude/projects",
    source.replace(/[^A-Za-z0-9]/g, "-"),
  );
  const historyFile = path.join(historyDir, "modular.jsonl");
  const historyBytes =
    JSON.stringify({
      type: "user",
      cwd: source,
      sessionId: "modular-history",
      timestamp: new Date().toISOString(),
      message: { content: "Keep external history after project Trash" },
    }) + "\n";
  const git = (dir, args) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Native Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Native Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let trashPath;
  try {
    await mkdir(source, { recursive: true });
    await mkdir(archiveRoot);
    await mkdir(backup);
    git(backup, ["init", "--bare", "--initial-branch=main"]);
    git(source, ["init", "--initial-branch=main"]);
    await writeFile(
      path.join(source, "README.md"),
      "# Modular project\nBacked up on a disposable remote.\n",
    );
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "initial"]);
    git(source, ["remote", "add", "origin", backup]);
    git(source, ["push", "-u", "origin", "main"]);
    await mkdir(historyDir, { recursive: true });
    await writeFile(historyFile, historyBytes);
    await check(
      "Settings select an external scan location and default archive folder",
      async () => {
        await nav("Settings", "Settings");
        await type('[aria-label="Another folder"]', scanRoot);
        await click(".main button", "Add folder", true);
        await type('[aria-label="Default archive folder"]', archiveRoot);
        await click(".main button", "Save and rescan", true);
        await wait("external root installed", async () => {
          const current = await snapshot();
          return (
            !current.historyPending &&
            current.nodes[source] &&
            current.roots.includes(scanRoot)
          );
        });
        const info = await api("setup/info");
        assert.equal(info.archiveDir, archiveRoot);
        assert.equal(
          (await snapshot()).nodes[source].archivePlan.dest,
          path.join(archiveRoot, path.basename(source)),
        );
        await shot("modular-settings");
      },
    );
    await check(
      "Custom archive preview, apply and Undo agree outside Home",
      async () => {
        const project = (await snapshot()).nodes[source];
        await showProject(project);
        await click(".insp .iacts button", "Archive", true);
        const destination = path.join(
          archiveRoot,
          `${path.basename(source)}-chosen`,
        );
        await type('[aria-label="Archive destination"]', destination);
        await wait("custom archive preview ready", () =>
          execute(() => {
            const button = [
              ...document.querySelectorAll(".dialog .df button"),
            ].find((b) => b.textContent.trim() === "Archive");
            return (
              button &&
              !button.disabled &&
              document
                .querySelector(".dialog .ops")
                ?.textContent.includes("-chosen")
            );
          }),
        );
        await shot("modular-archive");
        await settled("scan and project Git checks settle before Archive");
        await click(".dialog .df button", "Archive", true);
        await waitAccepted("custom archive accepted", async () => {
          const current = await snapshot();
          return (
            !current.historyPending &&
            current.nodes[destination]?.archived &&
            !current.nodes[source]
          );
        });
        assert.ok(
          (
            await readFile(path.join(destination, "README.md"), "utf8")
          ).includes("Modular project"),
        );
        await settled("archive scan and project Git checks settle before Undo");
        await click(".toast button", "Undo", true);
        await wait("external archive undone", async () => {
          const current = await snapshot();
          return (
            !current.historyPending &&
            current.nodes[source] &&
            !current.nodes[destination]
          );
        });
        assert.equal(await readFile(historyFile, "utf8"), historyBytes);
      },
    );
    await check(
      "Trash rejects local work added after review, then preserves external history",
      async () => {
        assert.equal(
          path.resolve(process.env.XDG_DATA_HOME ?? ""),
          path.join(fixtureHome, ".local/share"),
          "Native Trash QA must isolate XDG_DATA_HOME",
        );
        await showProject((await snapshot()).nodes[source]);
        await click(".insp .iacts button", "Move to Trash", true);
        await wait("live remote verified in dialog", () =>
          execute(() => {
            const button = [
              ...document.querySelectorAll(".dialog .df button"),
            ].find((b) => b.textContent.trim() === "Move to Trash");
            return button && !button.disabled;
          }),
        );
        await appendFile(
          path.join(source, "README.md"),
          "Local work after the review\n",
        );
        await settled(
          "scan and project Git checks settle before the blocked Move to Trash",
        );
        await click(".dialog .df button", "Move to Trash", true);
        await wait("fresh execution safety check rejected", () =>
          textContains(".dialog [role=alert]", "local changes"),
        );
        await access(source);
        await shot("modular-trash-blocked");
        await click(".dialog .df button", "Cancel", true);
        git(source, ["restore", "README.md"]);
        await writeFile(
          path.join(source, ".git/info/exclude"),
          ".laci.md\nsecret.env\n",
        );
        await writeFile(
          path.join(source, "secret.env"),
          "Ignored bytes stay in Trash\n",
        );
        // Closing the blocked plan can leave the inspector unselected after its
        // filesystem refresh; explicitly reopen the project before the retry.
        await showProject((await snapshot()).nodes[source]);
        await click(".insp .iacts button", "Move to Trash", true);
        await wait("fresh Trash plan ready", () =>
          execute(() => {
            const button = [
              ...document.querySelectorAll(".dialog .df button"),
            ].find((b) => b.textContent.trim() === "Move to Trash");
            return button && !button.disabled;
          }),
        );
        await shot("modular-trash");
        await settled(
          "scan and project Git checks settle before the final Move to Trash",
        );
        await click(".dialog .df button", "Move to Trash", true);
        await wait("project removed from snapshot", async () => {
          const current = await snapshot();
          return !current.historyPending && !current.nodes[source];
        });
        trashPath = path.join(trashRoot, "files", path.basename(source));
        await access(path.join(trashPath, ".git"));
        assert.equal(
          await readFile(path.join(trashPath, "secret.env"), "utf8"),
          "Ignored bytes stay in Trash\n",
        );
        assert.equal(await readFile(historyFile, "utf8"), historyBytes);
        const entry = (await api("log")).entries.find(
          (entry) =>
            entry.path === source && entry.title.includes("system Trash"),
        );
        assert.ok(
          entry && !entry.undo,
          "System Trash recovery must not advertise Log Undo",
        );
        // Restore only this disposable fixture, then remove its own Trash metadata.
        await rename(trashPath, source);
        trashPath = null;
        await rm(
          path.join(trashRoot, "info", `${path.basename(source)}.trashinfo`),
          { force: true },
        );
      },
    );
  } finally {
    if (await execute(() => Boolean(document.querySelector(".dialog"))))
      await click(".dialog .df button", "Cancel", true).catch(() => {});
    await wait(
      "history settled for settings restore",
      async () => !(await api("status")).historyPending,
    ).catch(() => {});
    await saveSetup({
      roots: original.roots,
      presets: original.presets,
      apps: original.apps,
      archiveDir: original.archiveDir ?? "",
    }).catch(() => {});
    await wait(
      "settings restored",
      async () => !(await api("status")).historyPending,
    ).catch(() => {});
    await rm(historyDir, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
    if (trashPath) {
      await rm(trashPath, { recursive: true, force: true });
      await rm(
        path.join(trashRoot, "info", `${path.basename(source)}.trashinfo`),
        { force: true },
      );
    }
  }
}

/** Session reports: setting the folder, reading, links in from sessions, projects, Today and the palette. */
async function reportRegressions() {
  const original = await api("setup/info");
  const folder = await mkdtemp(
    path.join(path.dirname(fixtureHome), "laci-reports-"),
  );
  const dayOf = (back) => {
    const t = new Date(Date.now() - back * 864e5);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  };
  const titleA = `Report A ${stamp}`;
  const titleB = `Report B ${stamp}`;
  const titleC = `Report C ${stamp}`;
  const sessionTitle = `Report session ${stamp}`;
  const firstOpen = `First open item ${stamp}`;
  const word = `fulltext${stamp}`;
  const fileB = `${dayOf(1)}-report-b-${stamp}.md`;
  const sessionId = crypto.randomUUID();
  let historyFile;
  try {
    await nav("Today", "Today");
    const projectPath = await wait("a recent project on Today", () =>
      execute(
        () =>
          document.querySelector("#sec-recent .item[data-id]")?.dataset.id ??
          null,
      ),
    );
    const project = (await snapshot()).nodes[projectPath];
    historyFile = path.join(
      fixtureHome,
      ".claude/projects",
      projectPath.replace(/[^A-Za-z0-9]/g, "-"),
      `${sessionId}.jsonl`,
    );
    await mkdir(path.dirname(historyFile), { recursive: true });
    await writeFile(
      historyFile,
      JSON.stringify({
        type: "user",
        cwd: projectPath,
        sessionId,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Write the report" },
      }) +
        "\n" +
        JSON.stringify({ type: "ai-title", aiTitle: sessionTitle, sessionId }) +
        "\n",
    );
    await writeFile(path.join(folder, "README.md"), "| Date | Title |\n");
    await writeFile(
      path.join(folder, `${dayOf(0)}-report-a-${stamp}.md`),
      `# ${titleA}\n\n- **Date:** ${dayOf(0)}\n- **Session:** ${projectPath} · ${sessionId}\n- **Projects:** ${projectPath}\n\n## Summary\nThe newest report.\n\nIt continues [the earlier report](${fileB}).\n\n## Open\n- ${firstOpen}\n- Second open item\n- Third open item\n`,
    );
    const filler = "A line of findings that makes the report long. ".repeat(
      12,
    );
    await writeFile(
      path.join(folder, fileB),
      `# ${titleB}\n\n- **Date:** ${dayOf(1)}\n- **Projects:** ${projectPath}\n\n## Summary\nAn older report.\n\n` +
        Array.from(
          { length: 8 },
          (_, i) => `## Part ${i + 1}\n${filler}\n\n`,
        ).join("") +
        `## Hostile\n<script>window.__REPORT_XSS__ = 1</script>\n<img src="x" onerror="window.__REPORT_XSS__ = 1">\n` +
        `[bad](javascript:window.__REPORT_XSS__=1) <div style="position:fixed;inset:0">cover</div>\n` +
        `<form action="https://example.invalid"><input name="x"></form>\n![pixel](https://example.invalid/pixel.png)\n\n` +
        `Only the body says ${word}.\n`,
    );
    await check(
      "Settings choose a reports folder and copy the agent instruction",
      async () => {
        await nav("Settings", "Settings");
        const actual = await realpath(folder);
        await type('[aria-label="Reports folder"]', folder);
        await click(".main button", "Save and rescan", true);
        await wait("reports listed", async () => {
          const current = await snapshot();
          return (
            !current.historyPending &&
            current.reportsDir?.path === actual &&
            current.reports?.length === 2
          );
        });
        await wait("settings report status", () =>
          textContains(".main .sset", "2 reports found"),
        );
        await execute(() => {
          window.__copied = [];
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: (text) => {
                window.__copied.push(text);
                return Promise.resolve();
              },
            },
          });
        });
        await click(".main .rp-copy button", "Copy agent instruction");
        const copied = await wait("instruction copied", () =>
          execute(() => window.__copied[0] ?? null),
        );
        assert.ok(copied.includes(folder) && copied.includes("## Open"));
      },
    );
    await check(
      "Reports list, read, follow a link and stay sanitized",
      async () => {
        await nav("Reports", "Reports");
        await click(".rp-row", titleA);
        await wait("report A open", () =>
          textContains("#report-title", titleA),
        );
        await wait("report A text", () =>
          textContains(".rp-body", "The newest report."),
        );
        assert.ok(
          !(await textContains(".rp-body", sessionId)),
          "the header lines show above the text, not in it",
        );
        await click(".rp-body a", "the earlier report");
        await wait("report B open through its link", () =>
          textContains("#report-title", titleB),
        );
        await wait("report B text", () => textContains(".rp-body", word));
        assert.equal(
          await execute(
            () =>
              document.querySelectorAll(
                '.rp-body script, .rp-body style, .rp-body form, .rp-body [style], .rp-body [onerror], .rp-body a[href^="javascript:"], .rp-body [class]:not(.readme-remote)',
              ).length,
          ),
          0,
          "A report renders as text structure only",
        );
        assert.equal(
          await execute(() => window.__REPORT_XSS__ ?? null),
          null,
        );
        assert.equal(
          await execute(
            () =>
              document.querySelectorAll('.rp-body img[src^="https:"]').length,
          ),
          0,
          "web images wait for Load images",
        );
        const sections = await execute(
          () => document.querySelectorAll(".rp-outline button").length,
        );
        assert.ok(sections >= 4, `outline has ${sections} sections`);
        await click(".rp-outline button", "Hostile");
        await wait("outline scrolled the report", () =>
          execute(() => document.querySelector(".rp-reader").scrollTop > 0),
        );
        await type('[aria-label="Search reports"]', word);
        await wait("full-text match with a snippet", () =>
          execute(
            (title) =>
              [...document.querySelectorAll(".rp-row")].some(
                (row) =>
                  row.textContent.includes(title) &&
                  row.querySelector(".rp-sum .hl"),
              ),
            titleB,
          ),
        );
        // WebDriver's clear empties the field without telling React; Escape is what a person presses.
        await key("\uE00C");
        await element(".rp-row", titleA);
      },
    );
    await check(
      "Sessions, projects, Today and the palette open their report",
      async () => {
        await click(".rp-row", titleA);
        await click(".rp-chip", sessionTitle);
        await wait("session dialog", () =>
          textContains(".dialog .dh h2", sessionTitle),
        );
        await click(".dialog .df button", "Report", true);
        await wait("reports for that session", () =>
          textContains(".rp-filter", sessionTitle),
        );
        await click(".rp-chip", project.label);
        await wait("project details", () =>
          textContains(".insp .ititle h2", project.name),
        );
        await wait("the project's reports", () =>
          textContains(".insp .sec-t", "Reports"),
        );
        await nav("Agents", "Agents");
        const icon = await wait("session row with a report", () =>
          execute((title) => {
            const button = [...document.querySelectorAll(".main .sess")]
              .find((row) => row.textContent.includes(title))
              ?.querySelector(".sess-rep");
            if (!button) return null;
            // Rows far down the list are drawn only once they come near the screen.
            button.scrollIntoView({ block: "center" });
            const box = button.getBoundingClientRect();
            return box.width && box.height ? button : null;
          }, sessionTitle),
        );
        await sleep(200);
        await command("POST", `/element/${icon[elementKey]}/click`, {});
        await wait("report opened from its session", () =>
          textContains("#report-title", titleA),
        );
        await nav("Today", "Today");
        await click(".rep-open", firstOpen);
        await wait("report opened from Today", () =>
          textContains("#report-title", titleA),
        );
        await nav("Today", "Today");
        await key("k", true);
        await type("#pal-in", titleB);
        await click(".pal-item", titleB);
        await wait("report opened from the palette", () =>
          textContains("#report-title", titleB),
        );
      },
    );
    await check(
      "A report item closes from Today and opens again in Reports",
      async () => {
        await nav("Today", "Today");
        // The button shows on hover; a script click reaches it the same way.
        assert.ok(
          await execute((text) => {
            const button = [...document.querySelectorAll(".rep-line")]
              .find((line) => line.textContent.includes(text))
              ?.querySelector(".rep-close");
            button?.click();
            return Boolean(button);
          }, firstOpen),
          "the report line has a close button",
        );
        await wait("the next item shows on Today", () =>
          textContains(".rep-open", "Second open item"),
        );
        await nav("Reports", "Reports");
        await click(".rp-row", titleA);
        await wait("the closed item is listed apart", () =>
          textContains(".rp-closed summary", "Closed (1)"),
        );
        assert.ok(
          await execute(
            (text) =>
              ![...document.querySelectorAll(".rp-items .rp-item:not(.done)")]
                .some((item) => item.textContent.includes(text)),
            firstOpen,
          ),
        );
        await execute(() =>
          document.querySelector(".rp-closed")?.setAttribute("open", ""),
        );
        await click(".rp-closed .btn", "Open again", true);
        await wait("the item is open again", () =>
          execute(
            (text) =>
              !document.querySelector(".rp-closed") &&
              [...document.querySelectorAll(".rp-items .rp-item")].some(
                (item) => item.textContent.includes(text),
              ),
            firstOpen,
          ),
        );
      },
    );
    await check("Review with an agent opens Start with Laci's brief", async () => {
      await nav("Today", "Today");
      await click(".main .head .btn", "Review with an agent", false);
      await wait("start dialog", () =>
        textContains(".dialog .dh h2", "Start an agent"),
      );
      const prompt = await execute(
        () => document.querySelector('textarea[name="agentPrompt"]')?.value ?? null,
      );
      if (prompt !== null) assert.match(prompt, /open_items/);
      await click(".dialog .df button", "Discard draft", true);
      await wait("start dialog closed", () =>
        execute(() => !document.querySelector(".dialog")),
      );
    });
    await check("A new report is counted until Reports is opened", async () => {
      await nav("Today", "Today");
      await writeFile(
        path.join(folder, `${dayOf(0)}-report-c-${stamp}.md`),
        `# ${titleC}\n\n## Summary\nWritten while Laci was open.\n`,
      );
      await wait("watcher counted the new report", () =>
        execute(
          () =>
            [...document.querySelectorAll(".sb-item")]
              .find((item) => item.textContent.includes("Reports"))
              ?.querySelector(".n.new")?.textContent === "1",
        ),
      );
      await nav("Reports", "Reports");
      await wait("new report marked", () =>
        execute(
          (title) =>
            [...document.querySelectorAll(".rp-row")].some(
              (row) =>
                row.textContent.includes(title) && row.querySelector(".dot"),
            ),
          titleC,
        ),
      );
      assert.ok(
        await execute(
          () => !document.querySelector(".sb-item .n.new"),
        ),
        "opening Reports clears the count",
      );
    });
    const demo = path.join(fixtureHome, "Documents/agent-reports");
    if (screenshotDir && (await stat(demo).catch(() => null))) {
      await saveSetup({
        roots: original.roots,
        presets: original.presets,
        apps: original.apps,
        reportsDir: demo,
      });
      await nav("Today", "Today");
      await nav("Reports", "Reports");
      await click(".rp-row", "Checkout total wrong on mobile Safari");
      await wait("demo report open", () =>
        textContains(".rp-body", "Midtrans"),
      );
      await shot("reports");
    }
  } finally {
    await wait(
      "history settled for reports restore",
      async () => !(await api("status")).historyPending,
    ).catch(() => {});
    await saveSetup({
      roots: original.roots,
      presets: original.presets,
      apps: original.apps,
      archiveDir: original.archiveDir ?? "",
      reportsDir: original.reportsDir ?? "",
    }).catch(() => {});
    if (historyFile) await rm(historyFile, { force: true });
    await rm(folder, { recursive: true, force: true });
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
async function reloadApp() {
  frontendErrors.push(
    ...(await execute(() => window.__LACI_SMOKE_ERRORS__ ?? [])),
  );
  await command("POST", "/refresh", {});
  await wait("React restored after reload", () =>
    execute(() => Boolean(document.querySelector(".main .head h1"))),
  );
  await installErrorCollection();
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
      Boolean(
        document.querySelector(
          '.ttab.ended[data-active] .ttab-select[aria-selected="true"]',
        ),
      ),
    ),
  );
  const count = await execute(() => document.querySelectorAll(".ttab").length);
  await click('.ttab-select[aria-selected="true"]');
  await wait("keyboard focus moved out of the exited xterm", () =>
    focused('.ttab-select[aria-selected="true"]'),
  );
  await key("\uE004");
  assert.ok(
    await focused('.ttab[data-active] button.x[aria-label^="Close terminal "]'),
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
      await discardDraft();
      await wait("Explicit discard closed the draft dialog", () =>
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
        "Review changes command shown for confirmation through the native PTY",
        () =>
          textContains(".term-host:not([hidden]) .xterm", "git status --short"),
      );
      await key("\uE007");
      await keyboardText("printf 'LACI_ACTION_%s\\n' SHELL_READY");
      await key("\uE007");
      await wait("confirmed action returned to an interactive shell", () =>
        textContains(
          ".term-host:not([hidden]) .xterm",
          "LACI_ACTION_SHELL_READY",
        ),
      );
      await keyboardText("exit");
      await key("\uE007");
      await closeExitedTerminalUI(terminal.id);
    },
  );

  await check(
    "Connector steps focus Name, trap Tab and restore the opener",
    async () => {
      await nav("Agents", "Agents");
      await tabTo(".stat.add, .empty-hero button", "Add another AI tool");
      const opener = await command("GET", "/element/active");
      await key("\uE007");
      await tabTo(".dialog .more-fields summary", "Something else");
      await key("\uE007");
      await wait("custom connector form rendered", () =>
        element(".dialog input[name=name]"),
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
        await focused(".dialog .more-fields summary", "Something else"),
        "Shift+Tab leaves Name for the Something else disclosure",
      );
      await key("\uE004");
      assert.ok(
        await focused(".dialog input[name=name]"),
        "Tab returns to Name",
      );
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
      await tabTo(".dialog .df button", "Cancel", true);
      await key("\uE007");
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
      await click('.ttab[data-active] button.x[aria-label^="Close terminal "]');
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
      await click('.ttab[data-active] button.x[aria-label^="Close terminal "]');
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
      await click('.ttab[data-active] button.x[aria-label^="Close terminal "]');
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

async function installFakeAgents() {
  const home = path.resolve(process.env.LACI_HOME ?? "");
  assert.ok(
    process.env.LACI_HOME &&
      (home.startsWith("/tmp/") || home.startsWith("/var/tmp/")),
    "Fake agents require an isolated temporary LACI_HOME",
  );
  assert.equal(
    process.env.LACI_AGENT_CAPTURE,
    path.join(home, "agent-capture.jsonl"),
  );
  assert.equal(
    process.env.PATH,
    `${path.join(home, "bin")}:/usr/bin:/bin`,
    "Agent runner must exclude real provider executable directories",
  );
  assert.equal(process.env.LACI_TERMINAL, "kitty");
  await mkdir(path.join(home, "bin"), { recursive: true });
  await writeFile(process.env.LACI_AGENT_CAPTURE, "");
  const fake = `#!/usr/bin/python3
import json, os, signal, sys
name = os.path.basename(sys.argv[0])
record = {"program": name, "argv": sys.argv[1:], "cwd": os.getcwd(), "pid": os.getpid()}
fd = os.open(os.environ["LACI_AGENT_CAPTURE"], os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
os.write(fd, (json.dumps(record) + "\\n").encode())
os.close(fd)
if name == "kitty":
    argv = sys.argv[sys.argv.index("--") + 1:]
    os.chdir(sys.argv[sys.argv.index("--directory") + 1])
    os.execvp(argv[0], argv)
if "--version" in sys.argv:
    print("native-fixture 1.0")
    sys.exit(0)
if "models" in sys.argv or "app-server" in sys.argv:
    sys.exit(9)
print("LACI_FAKE_AGENT_READY", flush=True)
while True:
    signal.pause()
`;
  for (const name of ["codex", "claude", "agy", "kitty"]) {
    const file = path.join(home, "bin", name);
    await writeFile(file, fake);
    await chmod(file, 0o700);
  }
}
async function capturedAgents() {
  return (await readFile(process.env.LACI_AGENT_CAPTURE, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function agentRegressions() {
  const original = await api("setup/info");
  const selection = {
    roots: original.roots,
    presets: ["claude", "codex", "antigravity"],
    apps: { ...original.apps, terminal: "kitty" },
    archiveDir: original.archiveDir ?? "",
    terminalTarget: "internal",
  };
  const projectRoot = path.join(fixtureHome, "project");
  const source = path.join(projectRoot, `native agent source ${stamp}`);
  const target = path.join(projectRoot, `native agent target ${stamp}`);
  const ids = {
    claude: "aaaaaaaa-1111-4111-8111-111111111111",
    codex: "bbbbbbbb-2222-4222-8222-222222222222",
    antigravity: "cccccccc-3333-4333-8333-333333333333",
  };
  const claudeDir = path.join(
    fixtureHome,
    ".claude/projects",
    source.replace(/[^A-Za-z0-9]/g, "-"),
  );
  const codexFile = path.join(
    fixtureHome,
    ".codex/sessions",
    `native-${stamp}.jsonl`,
  );
  const agyFile = path.join(
    fixtureHome,
    ".gemini/antigravity-cli/cache/last_conversations.json",
  );
  const oldAgy = await readFile(agyFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const recipeId = `agent-native-${stamp}`;
  const createdName = `agent-retry-${stamp}`;
  const createdPath = path.join(projectRoot, createdName);
  try {
    for (const dir of [
      source,
      target,
      claudeDir,
      path.dirname(codexFile),
      path.dirname(agyFile),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(source, "README.md"),
      "# Native agent source\nSynthetic routing fixture.\n",
    );
    await writeFile(
      path.join(target, "README.md"),
      "# Native agent target\nExplicit launch destination.\n",
    );
    await writeFile(
      path.join(claudeDir, `${ids.claude}.jsonl`),
      JSON.stringify({
        type: "user",
        cwd: source,
        sessionId: ids.claude,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Native Claude fixture" },
      }) + "\n",
    );
    await writeFile(
      codexFile,
      JSON.stringify({
        type: "session_meta",
        payload: { id: ids.codex, cwd: source },
      }) +
        "\n" +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "Native Codex fixture" },
        }) +
        "\n",
    );
    await writeFile(
      agyFile,
      JSON.stringify({
        ...(oldAgy ? JSON.parse(oldAgy.toString()) : {}),
        [source]: ids.antigravity,
      }),
    );
    await saveSetup(selection);
    await api("rescan");
    await wait("all fixture sessions normalized", async () => {
      const snap = await snapshot();
      return Object.entries(ids).every(([provider, id]) =>
        snap.sessions.some(
          (session) =>
            session.provider === provider && session.sessionId === id,
        ),
      );
    });
    await check(
      "Scan and agent form do not invoke conversations or model discovery",
      async () => {
        assert.deepEqual(await capturedAgents(), []);
        await nav("Settings", "Settings");
        await element('.main [aria-label="Another folder"]');
        await click('.sb-top [aria-label="New project"]');
        await click(".dialog .choice", "Launch an agent after creation");
        await element('.dialog [aria-label="Agent model"]');
        assert.deepEqual(await capturedAgents(), []);
        await discardDraft();
      },
    );
    await check(
      "Native PTY and external terminal transports preserve provider, UUID, cwd and literal prompt argv",
      async () => {
        const prompt = `--literal-leading-dash\nquote ' \" ; $(touch should-not-exist) \`echo not-a-command\` & tail`;
        for (const targetKind of ["internal", "external"]) {
          for (const [provider, sessionId] of Object.entries(ids)) {
            const bin = provider === "antigravity" ? "agy" : provider;
            const args =
              provider === "codex"
                ? ["resume", sessionId, "-C", target, "--", prompt]
                : provider === "claude"
                  ? ["--resume", sessionId, "--", prompt]
                  : [
                      "--conversation",
                      sessionId,
                      `--prompt-interactive=${prompt}`,
                    ];
            const before = (await capturedAgents()).length;
            const result = await api("agent/launch", {
              provider,
              sessionId,
              projectPath: target,
              prompt,
              target: targetKind,
            });
            const record = await wait(
              "fake provider received literal arguments",
              async () =>
                (await capturedAgents())
                  .slice(before)
                  .find((entry) => entry.program === bin),
            );
            assert.equal(record.cwd, target);
            assert.deepEqual(record.argv, args);
            const identity = await processIdentity(record.pid);
            assert.ok(identity && !["Z", "X"].includes(identity.state));
            fakeAgentProcesses.set(record.pid, identity);
            if (targetKind === "internal") {
              assert.equal(result.terminal.cwd, target);
              keyboardTerminalIds.add(result.terminal.id);
              await invoke("term_close", { id: result.terminal.id });
              keyboardTerminalIds.delete(result.terminal.id);
            } else {
              const transport = (await capturedAgents())
                .slice(before)
                .find((entry) => entry.program === "kitty");
              assert.deepEqual(transport.argv, [
                "--directory",
                target,
                "--",
                bin,
                ...args,
              ]);
              if (sameLiveProcess(await processIdentity(record.pid), identity))
                process.kill(record.pid, "SIGTERM");
            }
            await wait(
              "owned fake provider stopped",
              async () =>
                !sameLiveProcess(await processIdentity(record.pid), identity),
            );
            fakeAgentProcesses.delete(record.pid);
          }
        }
        await assert.rejects(access(path.join(target, "should-not-exist")));
        const before = (await capturedAgents()).length;
        await assert.rejects(
          api("agent/launch", {
            provider: "claude",
            sessionId: ids.codex,
            projectPath: target,
            target: "internal",
          }),
        );
        await assert.rejects(
          api("agent/launch", {
            provider: "codex",
            projectPath: path.join(target, "missing"),
            target: "internal",
          }),
        );
        assert.equal((await capturedAgents()).length, before);
      },
    );
    await check(
      "A described tool starts from its own arguments and takes the MCP server",
      async () => {
        await wait(
          "history ready for a new tool",
          async () => !(await api("status")).historyPending,
        );
        await api("connector/add", {
          name: `Fixture tool ${stamp}`,
          agent: {
            command: "claude",
            prompt: "--say {prompt}",
            continue: "--again",
            mcp: { file: "~/.fixture-tool/mcp.json" },
          },
        });
        const tool = await wait("described tool listed", async () =>
          (await snapshot()).connectors.find(
            (connector) => connector.name === `Fixture tool ${stamp}`,
          ),
        );
        try {
          assert.equal(tool.provider, tool.id);
          assert.deepEqual(tool.link, { kind: "none" });
          assert.equal(tool.capabilities.launch, true);
          const before = (await capturedAgents()).length;
          const result = await api("agent/launch", {
            provider: tool.id,
            projectPath: target,
            prompt: "literal $HOME",
            continue: true,
            target: "internal",
          });
          const record = await wait(
            "described tool received its own arguments",
            async () =>
              (await capturedAgents())
                .slice(before)
                .find((entry) => entry.program === "claude"),
          );
          assert.deepEqual(record.argv, ["--again", "--say", "literal $HOME"]);
          assert.equal(record.cwd, target);
          const identity = await processIdentity(record.pid);
          assert.ok(identity && !["Z", "X"].includes(identity.state));
          fakeAgentProcesses.set(record.pid, identity);
          keyboardTerminalIds.add(result.terminal.id);
          await invoke("term_close", { id: result.terminal.id });
          keyboardTerminalIds.delete(result.terminal.id);
          await wait(
            "described tool stopped",
            async () =>
              !sameLiveProcess(await processIdentity(record.pid), identity),
          );
          fakeAgentProcesses.delete(record.pid);

          const status = (await api("agent/mcp")).agents.find(
            (agent) => agent.provider === tool.id,
          );
          assert.equal(status.state, "missing");
          assert.equal(status.how, "file");
          const applied = await api("agent/mcp/apply", { provider: tool.id });
          assert.equal(applied.status.state, "registered");
          const saved = JSON.parse(
            await readFile(
              path.join(fixtureHome, ".fixture-tool/mcp.json"),
              "utf8",
            ),
          );
          assert.deepEqual(saved.mcpServers.laci.args, ["mcp"]);
          assert.equal(saved.mcpServers.laci.command, status.laci);
          const removed = await api("agent/mcp/apply", {
            provider: tool.id,
            remove: true,
          });
          assert.equal(removed.status.state, "missing");
          assert.equal(
            (await capturedAgents()).length,
            before + 1,
            "Editing a settings file starts no program",
          );
        } finally {
          await wait(
            "history ready to remove the tool",
            async () => !(await api("status")).historyPending,
          );
          await api("connector/remove", { id: tool.id });
          await rm(path.join(fixtureHome, ".fixture-tool"), {
            recursive: true,
            force: true,
          });
        }
      },
    );
    await check(
      "Generator success survives missing agent CLI and retry does not recreate or recommit the project",
      async () => {
        await api("new/recipe", {
          recipe: {
            id: recipeId,
            name: "Native successful generator",
            program: "sh",
            args: [
              "-c",
              "printf '# Native generated project\\n' > \"$1/README.md\"; printf 'generator completed\\n'",
              "laci-native-fixture",
              "{name}",
            ],
            download: false,
          },
        });
        await click('.sb-top [aria-label="New project"]');
        await type(".dialog input[pattern]", createdName);
        await select('.dialog [aria-label="Project location"]', projectRoot);
        await click(".dialog .choice", "Generator recipe");
        await select('.dialog [aria-label="Generator recipe"]', recipeId);
        await click(".dialog button", "Preview generator", true);
        await wait("local generator preview", () =>
          textContains(".dialog .generator-preview", "no download requirement"),
        );
        await click(".dialog .choice", "Launch an agent after creation");
        await select('.dialog [aria-label="Agent"]', "antigravity");
        const prompt = `Inspect this generated project\nKeep literal $HOME and 'quotes'.`;
        await type(".dialog .agent-fields textarea", prompt);
        await chmod(path.join(fixtureHome, "bin/agy"), 0o600);
        const before = (await capturedAgents()).length;
        await click(".dialog .df button", "Create project", true);
        await wait("project kept after missing CLI", () =>
          textContains(".dialog .df", "Project created. Agent launch failed:"),
        );
        assert.ok(await textContains(".dialog .df", "not installed"));
        const beforeStat = await stat(createdPath, { bigint: true });
        const gitHead = () =>
          execFileSync("git", ["-C", createdPath, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim();
        const head = gitHead();
        assert.equal((await capturedAgents()).length, before);
        const createCount = async () =>
          (await api("log")).entries.filter(
            (entry) =>
              entry.path === createdPath &&
              entry.title === `Created ${createdName}`,
          ).length;
        assert.equal(await createCount(), 1);
        const failedJob = await api("new/current");
        await reloadApp();
        await wait("failed agent continuation recovered after reload", () =>
          textContains(".dialog .df", "Project created. Agent launch failed:"),
        );
        assert.equal((await api("new/current")).id, failedJob.id);
        assert.equal(
          await execute(
            () =>
              document.querySelector(".dialog .agent-fields textarea").value,
          ),
          prompt,
        );
        assert.equal((await capturedAgents()).length, before);
        await shot("agent-launch-failed-project-kept");
        await chmod(path.join(fixtureHome, "bin/agy"), 0o700);
        const oldTerms = new Set(
          (await invoke("term_list")).map((term) => term.id),
        );
        await click(".dialog .df button", "Retry agent launch", true);
        const record = await wait("retry started only the agent", async () =>
          (await capturedAgents())
            .slice(before)
            .find((entry) => entry.program === "agy"),
        );
        const identity = await processIdentity(record.pid);
        assert.ok(identity && !["Z", "X"].includes(identity.state));
        fakeAgentProcesses.set(record.pid, identity);
        assert.deepEqual(record.argv, [`--prompt-interactive=${prompt}`]);
        assert.equal(record.cwd, createdPath);
        assert.equal(
          (await stat(createdPath, { bigint: true })).ino,
          beforeStat.ino,
        );
        assert.equal(gitHead(), head);
        assert.equal(await createCount(), 1);
        const terminal = await wait(
          "retry PTY visible in native app",
          async () =>
            (await invoke("term_list")).find((term) => !oldTerms.has(term.id)),
        );
        keyboardTerminalIds.add(terminal.id);
        await wait("fake provider output reaches visible xterm", () =>
          textContains(".term .xterm", "LACI_FAKE_AGENT_READY"),
        );
        await shot("agent-launch-retry");
        await reloadApp();
        for (let repeat = 0; repeat < 3; repeat++)
          assert.equal(
            (
              await api("new/continue", {
                id: failedJob.id,
                retryAttempt: failedJob.continuation.attempt,
              })
            ).continuation.result.terminal.id,
            terminal.id,
          );
        assert.equal(
          (await capturedAgents())
            .slice(before)
            .filter((entry) => entry.program === "agy").length,
          1,
        );
        assert.equal(await createCount(), 1);
        assert.equal(
          (await invoke("term_list")).filter((term) => term.id === terminal.id)
            .length,
          1,
        );
        await invoke("term_close", { id: terminal.id });
        keyboardTerminalIds.delete(terminal.id);
        await wait(
          "retry provider stopped",
          async () =>
            !sameLiveProcess(await processIdentity(record.pid), identity),
        );
        fakeAgentProcesses.delete(record.pid);
      },
    );
    await check(
      "Generator completion across repeated WebView reloads launches the requested agent exactly once",
      async () => {
        const name = `agent-reload-${stamp}`;
        const dest = path.join(projectRoot, name);
        const marker = `LACI_GENERATOR_RELOAD_${stamp}`;
        let job;
        try {
          await api("new/recipe", {
            recipe: {
              id: recipeId,
              name: "Native reload generator",
              program: "sh",
              args: [
                "-c",
                `printf '# Reload project\\n' > "$1/README.md"; printf x >> "$1/runs"; printf '%s\\n' '${marker}'; while [ ! -f "$1/continue" ]; do sleep 0.1; done; rm "$1/continue"`,
                "laci-native-fixture",
                "{name}",
              ],
              download: false,
            },
          });
          await click('.sb-top [aria-label="New project"]');
          await type(".dialog input[pattern]", name);
          await select('.dialog [aria-label="Project location"]', projectRoot);
          await click(".dialog .choice", "Generator recipe");
          await select('.dialog [aria-label="Generator recipe"]', recipeId);
          await click(".dialog button", "Preview generator", true);
          await wait("reload generator preview", () =>
            textContains(
              ".dialog .generator-preview",
              "no download requirement",
            ),
          );
          await click(".dialog .choice", "Launch an agent after creation");
          await select('.dialog [aria-label="Agent"]', "antigravity");
          const prompt = `Continue after reload\nKeep literal $HOME and 'quotes'.`;
          await type(".dialog .agent-fields textarea", prompt);
          const before = (await capturedAgents()).length;
          await click(".dialog .df button", "Create project", true);
          await wait("gated generator running", () =>
            textContains(".dialog .generator-progress pre", marker),
          );
          job = await api("new/current");
          const inode = (await stat(dest, { bigint: true })).ino;
          await reloadApp();
          await wait(
            "requested continuation recovered with running generator",
            () => textContains(".dialog .generator-progress pre", marker),
          );
          assert.equal((await api("new/current")).id, job.id);
          assert.equal(
            await execute(
              () =>
                document.querySelector(".dialog .agent-fields textarea").value,
            ),
            prompt,
          );
          assert.equal((await capturedAgents()).length, before);
          await shot("generator-reload-agent-pending", false);
          await writeFile(path.join(dest, "continue"), "");
          await reloadApp();
          await wait(
            "generator completes after reload",
            async () =>
              (await api("new/status", { id: job.id })).status === "completed",
          );
          const completed = await wait(
            "automatic continuation completes after reload",
            async () => {
              const value = await api("new/status", { id: job.id });
              return value.continuation.status === "completed" && value;
            },
          );
          const terminal = completed.continuation.result.terminal;
          keyboardTerminalIds.add(terminal.id);
          const record = await wait(
            "exactly one recovered fake provider",
            async () =>
              (await capturedAgents())
                .slice(before)
                .find((entry) => entry.program === "agy"),
          );
          const identity = await processIdentity(record.pid);
          assert.ok(identity && !["Z", "X"].includes(identity.state));
          fakeAgentProcesses.set(record.pid, identity);
          assert.deepEqual(record.argv, [`--prompt-interactive=${prompt}`]);
          assert.equal(record.cwd, dest);
          await wait(
            "recovered creation acknowledged by UI",
            async () => !(await api("new/current")),
          );
          await wait("creation dialog closed", () =>
            execute(() => !document.querySelector(".dialog")),
          );
          if (
            !(await execute(
              () => document.querySelector("#term")?.hidden === false,
            ))
          )
            await key("\uE034");
          await wait("recovered continuation shows its original terminal", () =>
            textContains(".term:not([hidden]) .xterm", "LACI_FAKE_AGENT_READY"),
          );
          const duplicates = await asyncExecute(
            async (id) =>
              Promise.all(
                Array.from({ length: 4 }, () =>
                  window.__TAURI_INTERNALS__.invoke("request", {
                    name: "new/continue",
                    body: { id },
                  }),
                ),
              ),
            job.id,
          );
          assert.ok(
            duplicates.every(
              (value) => value.continuation.result.terminal.id === terminal.id,
            ),
          );
          assert.equal((await stat(dest, { bigint: true })).ino, inode);
          assert.equal(await readFile(path.join(dest, "runs"), "utf8"), "x");
          assert.equal(
            (await api("log")).entries.filter(
              (entry) =>
                entry.path === dest && entry.title === `Created ${name}`,
            ).length,
            1,
          );
          await shot("generator-reload-agent-once");
          await reloadApp();
          assert.equal(
            (await api("new/continue", { id: job.id })).continuation.result
              .terminal.id,
            terminal.id,
          );
          assert.equal(
            (await capturedAgents())
              .slice(before)
              .filter((entry) => entry.program === "agy").length,
            1,
          );
          assert.equal(
            (await invoke("term_list")).filter(
              (term) => term.id === terminal.id,
            ).length,
            1,
          );
          await invoke("term_close", { id: terminal.id });
          keyboardTerminalIds.delete(terminal.id);
          await wait(
            "recovered provider stopped",
            async () =>
              !sameLiveProcess(await processIdentity(record.pid), identity),
          );
          fakeAgentProcesses.delete(record.pid);
        } finally {
          if (job) {
            await api("new/cancel", { id: job.id });
            await wait(
              "reload generator stopped for cleanup",
              async () =>
                (await api("new/status", { id: job.id })).status !== "running",
            );
            await api("new/ack", { id: job.id });
          }
        }
      },
    );
  } finally {
    await chmod(path.join(fixtureHome, "bin/agy"), 0o700);
    if (await execute(() => Boolean(document.querySelector(".dialog"))))
      await click(".dialog .df button", "Discard draft", true).catch(() => {});
    await saveSetup({
      roots: original.roots,
      presets: original.presets,
      apps: original.apps,
      archiveDir: original.archiveDir ?? "",
      terminalTarget: original.terminalTarget ?? "internal",
    }).catch(() => {});
    if (oldAgy) await writeFile(agyFile, oldAgy);
    else await rm(agyFile, { force: true });
    await rm(codexFile, { force: true });
    await rm(claudeDir, { recursive: true, force: true });
    for (const dir of [source, target])
      await rm(dir, { recursive: true, force: true });
    const configPath = path.join(fixtureHome, ".config/laci/config.json");
    const cfg = JSON.parse(await readFile(configPath, "utf8"));
    cfg.recipes = (cfg.recipes ?? []).filter(
      (recipe) => recipe.id !== recipeId,
    );
    await writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n");
  }
}

async function patchRegressions() {
  const original = await api("setup/info");
  const selection = {
    roots: original.roots,
    presets: original.presets,
    apps: original.apps,
    archiveDir: original.archiveDir ?? "",
    terminalTarget: original.terminalTarget ?? "internal",
  };
  const longRoot = path.join(
    fixtureHome,
    `select-${"long-folder-".repeat(16)}${stamp}`,
  );
  await mkdir(longRoot, { recursive: true });
  try {
    await saveSetup({ ...selection, roots: [...selection.roots, longRoot] });
    await wait("long scan location available", async () =>
      (await snapshot()).roots.includes(longRoot),
    );
    await check(
      "Themed dropdown fits 1280x720, wraps long options and isolates keyboard shortcuts",
      async () => {
        await command("POST", "/window/rect", { width: 1280, height: 720 });
        for (const appearance of ["light", "dark"]) {
          await theme(appearance);
          await click('.sb-top [aria-label="New project"]');
          const draft = `select-draft-${stamp}`;
          await type(".dialog input[pattern]", draft);
          const trigger =
            '.dialog [role="combobox"][aria-label="Project location"]';
          await tabTo(trigger);
          await key("\uE007");
          await element("[data-laci-select-popup]");
          await painted();
          const beforeTerms = (await invoke("term_list"))
            .map((term) => term.id)
            .sort();
          const geometry = await execute((longRoot) => {
            const popup = document.querySelector("[data-laci-select-popup]");
            const rect = popup.getBoundingClientRect();
            const long = [...popup.querySelectorAll('[role="option"]')].find(
              (option) => option.getAttribute("data-value") === longRoot,
            );
            const color = getComputedStyle(popup);
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              viewport: [innerWidth, innerHeight],
              background: color.backgroundColor,
              text: color.color,
              long: long && {
                width: long.clientWidth,
                scrollWidth: long.scrollWidth,
                height: long.getBoundingClientRect().height,
                lineHeight: parseFloat(getComputedStyle(long).lineHeight),
              },
              insideDialog: Boolean(popup.closest(".dialog")),
              inScrollBody: Boolean(popup.closest(".db")),
            };
          }, longRoot);
          assert.ok(
            geometry.left >= 7 && geometry.right <= geometry.viewport[0] - 7,
          );
          assert.ok(
            geometry.top >= 0 && geometry.bottom <= geometry.viewport[1],
          );
          assert.ok(geometry.height <= 281 && geometry.width > 80);
          assert.equal(geometry.insideDialog, true);
          assert.equal(
            geometry.inScrollBody,
            false,
            "Popup must not be clipped by the form scroll body",
          );
          assert.ok(
            geometry.long &&
              geometry.long.scrollWidth <= geometry.long.width + 1,
          );
          assert.ok(
            geometry.long.height > geometry.long.lineHeight * 1.5,
            "Long path labels must wrap",
          );
          const brightness =
            geometry.background
              .match(/\d+/g)
              .slice(0, 3)
              .map(Number)
              .reduce((sum, n) => sum + n, 0) / 3;
          assert.ok(
            appearance === "light" ? brightness > 200 : brightness < 80,
            `${appearance} popup uses app colors: ${geometry.background}`,
          );
          await key("k", true);
          await key("\uE034");
          await painted();
          assert.equal(
            await execute(() => Boolean(document.querySelector("#pal-in"))),
            false,
          );
          assert.deepEqual(
            (await invoke("term_list")).map((term) => term.id).sort(),
            beforeTerms,
          );
          await shot(`select-${appearance}-1280`);
          await key("\uE00C");
          await wait("first Escape closes only the dropdown", () =>
            execute(() => !document.querySelector("[data-laci-select-popup]")),
          );
          assert.equal(
            await execute(
              () => document.querySelector(".dialog input[pattern]")?.value,
            ),
            draft,
          );
          assert.ok(
            await focused(trigger),
            "Dropdown Escape restores its trigger focus",
          );
          assert.equal(
            await textContains(".dialog .df", "Keep editing"),
            false,
          );
          await tabTo(
            '.dialog [role="combobox"][aria-label="Remote repository"]',
          );
          await key("\uE007");
          await keyboardText("Only");
          await key("\uE007");
          await wait("typeahead option selected", () =>
            execute(() => !document.querySelector("[data-laci-select-popup]")),
          );
          await key("\uE00C");
          await wait("second Escape retains the form draft", () =>
            textContains(".dialog .df", "Keep editing"),
          );
          await click(".dialog .df button", "Keep editing", true);
          assert.equal(
            await execute(
              () => document.querySelector(".dialog input[pattern]")?.value,
            ),
            draft,
          );
          await discardDraft();
        }
      },
    );
  } finally {
    if (await execute(() => Boolean(document.querySelector(".dialog"))))
      await click(".dialog .df button", "Discard draft", true).catch(() => {});
    await command("POST", "/window/rect", { width: 1440, height: 900 });
    await saveSetup(selection);
    await rm(longRoot, { recursive: true, force: true });
  }
  await check(
    "Settings allow zero roots and preserve that choice after a native page reload",
    async () => {
      try {
        await nav("Settings", "Settings");
        await element('.main [aria-label="Another folder"]');
        const checked = await execute(() => [
          ...document.querySelectorAll(
            ".main .sset:first-of-type .opt input:checked",
          ),
        ]);
        for (const input of checked)
          await command("POST", `/element/${input[elementKey]}/click`, {});
        await type('.main [aria-label="Default archive folder"]', "");
        await click(".main .setup-foot button", "Save and rescan", true);
        await wait("explicit empty selection reaches engine", async () => {
          const current = await snapshot();
          return (
            current.configured &&
            current.roots.length === 0 &&
            Object.keys(current.nodes).length === 0
          );
        });
        const saved = JSON.parse(
          await readFile(
            path.join(fixtureHome, ".config/laci/config.json"),
            "utf8",
          ),
        );
        assert.deepEqual(saved.roots, []);
        frontendErrors.push(
          ...(await execute(() => window.__LACI_SMOKE_ERRORS__ ?? [])),
        );
        await command("POST", "/refresh", {});
        await wait("configured app restored with no roots", () =>
          execute(
            () =>
              Boolean(document.querySelector(".main")) &&
              !document.querySelector(".setup"),
          ),
        );
        await installErrorCollection();
        assert.deepEqual((await snapshot()).roots, []);
        await nav("Settings", "Settings");
        await element('.main [aria-label="Another folder"]');
        assert.equal(
          await execute(
            () =>
              document.querySelectorAll(
                ".main .sset:first-of-type .opt input:checked",
              ).length,
          ),
          0,
        );
        await shot("settings-no-roots");
      } finally {
        await saveSetup(selection);
      }
    },
  );
  await check(
    "External roots use real breadcrumbs and Backspace, and disconnected folders stay marked unavailable",
    async () => {
      const external = await mkdtemp(
        path.join(path.dirname(fixtureHome), "laci-native-drive-"),
      );
      const drive = path.join(external, "workspace");
      const moved = path.join(external, "disconnected");
      const folder = path.join(drive, "nested");
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(
          path.join(folder, "README.md"),
          "# External navigation fixture\n",
        );
        await saveSetup({ ...selection, roots: [...selection.roots, drive] });
        await wait(
          "external root scanned",
          async () => (await snapshot()).nodes[folder],
        );
        await element(".tree-row .tl", drive);
        assert.ok(
          await execute((drive) => {
            const button = [...document.querySelectorAll(".tree-row .tl")].find(
              (item) => item.textContent.includes(drive),
            );
            return (
              button.getBoundingClientRect().right <=
              document.querySelector(".sb-scroll").getBoundingClientRect().right
            );
          }, drive),
          "Long external paths must not push their click target outside the sidebar",
        );
        await click(".tree-row .tl", drive);
        await wait("external root browser", () =>
          execute(
            (drive) =>
              document
                .querySelector(".main .head h1")
                ?.getAttribute("title") === drive,
            drive,
          ),
        );
        await doubleClick(`.main .frow[data-id=${JSON.stringify(folder)}]`);
        await wait("nested external browser", () =>
          execute(
            (folder) =>
              document
                .querySelector(".main .head h1")
                ?.getAttribute("title") === folder,
            folder,
          ),
        );
        const crumbs = await execute(() =>
          [...document.querySelectorAll(".main .head .crumb")].map((crumb) =>
            crumb.textContent.trim(),
          ),
        );
        assert.ok(crumbs[0].startsWith(drive));
        assert.ok(crumbs.every((crumb) => !["Home", "~"].includes(crumb)));
        await key("\uE003");
        await wait("Backspace returns to selected external root", () =>
          execute(
            (drive) =>
              document
                .querySelector(".main .head h1")
                ?.getAttribute("title") === drive,
            drive,
          ),
        );
        await shot("external-root-navigation");
        await nav("Settings", "Settings");
        await rename(drive, moved);
        await api("rescan");
        await wait("unavailable root stays in snapshot", async () => {
          const snap = await snapshot();
          return (
            snap.roots.includes(drive) &&
            snap.rootStatus.some(
              (root) => root.path === drive && !root.available,
            )
          );
        });
        await nav("Today", "Today");
        await nav("Settings", "Settings");
        await wait("unavailable selected folder shown in Settings", () =>
          execute(
            (drive) =>
              [...document.querySelectorAll(".main .sset .opt")].some(
                (row) =>
                  row.textContent.includes(drive) &&
                  row.textContent.includes("Unavailable") &&
                  row.querySelector("input")?.checked,
              ),
            drive,
          ),
        );
        await shot("offline-selected-root");
      } finally {
        await saveSetup(selection);
        await rm(external, { recursive: true, force: true });
      }
    },
  );
  await check(
    "Generator progress stays responsive; cancel and failure preserve partial output",
    async () => {
      const recipeId = `native-smoke-${stamp}`;
      const names = [`cancelled-${stamp}`, `failed-${stamp}`];
      const projectRoot =
        selection.roots[0] ?? path.join(fixtureHome, "project");
      const configPath = path.join(fixtureHome, ".config/laci/config.json");
      let generatorMayBeRunning = false;
      try {
        for (const [index, name] of names.entries()) {
          const dest = path.join(projectRoot, name);
          const marker = `LACI_GENERATOR_PROGRESS_${index}_${stamp}`;
          const script = `mkdir -p -- "$1"; printf 'partial output\\n' > "$1/partial.txt"; printf '%s\\n' "$$" > "$1/generator.pid"; printf '%s\\n' '${marker}'; ${index ? "exit 7" : "exec sleep 120"}`;
          await api("new/recipe", {
            recipe: {
              id: recipeId,
              name: "Native smoke generator",
              program: "sh",
              args: ["-c", script, "laci-native-fixture", "{name}"],
              download: false,
            },
          });
          await click('.sb-top [aria-label="New project"]');
          await type(".dialog input[pattern]", name);
          await select(
            '.dialog [role="combobox"][aria-label="Project location"]',
            projectRoot,
          );
          await click(".dialog .choice", "Generator recipe");
          await select(
            '.dialog [role="combobox"][aria-label="Generator recipe"]',
            recipeId,
          );
          await click(".dialog button", "Preview generator", true);
          await wait("generator prerequisites previewed", () =>
            textContains(
              ".dialog .generator-preview",
              "no download requirement",
            ),
          );
          assert.ok(
            await textContains(".dialog .generator-preview code", marker),
          );
          const beforeTerms = (await invoke("term_list"))
            .map((term) => term.id)
            .sort();
          generatorMayBeRunning = !index;
          await click(".dialog .df button", "Create project", true);
          await wait("generator output rendered", () =>
            textContains(".dialog .generator-progress pre", marker),
          );
          const pid = Number(
            (await readFile(path.join(dest, "generator.pid"), "utf8")).trim(),
          );
          const originalProcess = await processIdentity(pid);
          if (!index) {
            const job = await api("new/current");
            assert.equal(job.status, "running");
            assert.equal(job.request.name, name);
            const started = Date.now();
            await snapshot();
            assert.ok(
              Date.now() - started < 3000,
              "Long generator must not hold the app request lock",
            );
            await reloadApp();
            await wait("generator progress restored after WebView reload", () =>
              textContains(".dialog .generator-progress pre", marker),
            );
            assert.equal((await api("new/current")).id, job.id);
            assert.equal(
              await execute(
                () => document.querySelector(".dialog input[pattern]").value,
              ),
              name,
            );
            assert.equal(
              await execute(
                () =>
                  [...document.querySelectorAll(".dialog .df button")].find(
                    (button) =>
                      button.textContent.trim() === "Cancel generator",
                  )?.disabled,
              ),
              false,
            );
            assert.ok(
              sameLiveProcess(await processIdentity(pid), originalProcess),
            );
            assert.ok(
              originalProcess && !["Z", "X"].includes(originalProcess.state),
            );
            await key("\uE00C");
            assert.equal(
              await textContains(".dialog .df", "Keep editing"),
              false,
            );
            assert.ok(
              sameLiveProcess(await processIdentity(pid), originalProcess),
              "Escape must not cancel a running generator",
            );
            await execute(() =>
              document
                .querySelector(".generator-progress")
                .scrollIntoView({ block: "end" }),
            );
            await shot("generator-progress", false);
            await click(".dialog .df button", "Cancel generator", true);
            await wait("generator cancellation rendered", () =>
              textContains(".dialog .generator-progress", "Creation cancelled"),
            );
            await wait(
              "owned generator process stopped",
              async () =>
                !sameLiveProcess(await processIdentity(pid), originalProcess),
            );
          } else {
            await wait("generator failure rendered", () =>
              textContains(".dialog .generator-progress", "Creation failed"),
            );
            assert.ok(await textContains(".dialog .df", "Generator exited"));
          }
          assert.equal(
            await readFile(path.join(dest, "partial.txt"), "utf8"),
            "partial output\n",
          );
          await assert.rejects(access(path.join(dest, ".laci.md")));
          await assert.rejects(access(path.join(dest, ".git")));
          assert.deepEqual(
            (await invoke("term_list")).map((term) => term.id).sort(),
            beforeTerms,
          );
          await execute(() =>
            document
              .querySelector(".generator-progress")
              .scrollIntoView({ block: "end" }),
          );
          await shot(index ? "generator-failed" : "generator-cancelled");
          await click(".dialog .df button", "Discard draft", true);
          generatorMayBeRunning = false;
        }
      } finally {
        if (generatorMayBeRunning) {
          const cancel = await execute(
            () =>
              [...document.querySelectorAll(".dialog .df button")].find(
                (button) => button.textContent.trim() === "Cancel generator",
              ) ?? null,
          ).catch(() => null);
          if (cancel) {
            await command(
              "POST",
              `/element/${cancel[elementKey]}/click`,
              {},
            ).catch(() => {});
            generatorMayBeRunning = !(await wait(
              "owned generator stopped during cleanup",
              () =>
                textContains(
                  ".dialog .generator-progress",
                  "Creation cancelled",
                ),
              5000,
            ).catch(() => false));
          }
        }
        if (
          !generatorMayBeRunning &&
          (await execute(() => Boolean(document.querySelector(".dialog"))))
        )
          await click(".dialog .df button", "Discard draft", true).catch(
            () => {},
          );
        const cfg = JSON.parse(await readFile(configPath, "utf8"));
        cfg.recipes = (cfg.recipes ?? []).filter(
          (recipe) => recipe.id !== recipeId,
        );
        await writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n");
        // If the UI failed mid-job, closing the owned native session below cancels it; keep its output for diagnosis.
        if (!generatorMayBeRunning)
          for (const name of names)
            await rm(path.join(projectRoot, name), {
              recursive: true,
              force: true,
            });
      }
    },
  );
  await nav("Today", "Today");
}

async function watcherRegressions() {
  await check(
    "Linked worktree branch switches refresh the native inspector",
    async () => {
      const current = await snapshot();
      const hasHead = (projectPath) => {
        try {
          execFileSync("git", ["-C", projectPath, "rev-parse", "--verify", "HEAD"], {
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      };
      const main = Object.values(current.nodes).find(
        (node) =>
          node.git &&
          !node.git.worktree &&
          !node.archived &&
          current.roots.some((root) => node.path.startsWith(root + "/")) &&
          hasHead(node.path),
      );
      assert.ok(main, "Fixture needs a Git project below a scan root");
      const linked = path.join(
        path.dirname(main.path),
        `native-worktree-${stamp}`,
      );
      const initial = `native-worktree-start-${stamp}`;
      const switched = `native-worktree-next-${stamp}`;
      const git = (args) => execFileSync("git", args, { stdio: "pipe" });
      git(["-C", main.path, "worktree", "add", "-b", initial, linked, "HEAD"]);
      try {
        // Finish discovery and watch installation before changing only Git metadata.
        await api("rescan");
        const project = (await snapshot()).nodes[linked];
        assert.ok(project?.git?.worktree, "Linked checkout must be detected");
        await showProject(project);
        git(["-C", linked, "switch", "-c", switched]);
        await wait(
          "linked Git watcher refreshed the branch",
          async () =>
            (await snapshot()).nodes[linked]?.git?.branch === switched,
        );
        await wait("React inspector received linked worktree branch", () =>
          textContains(".insp .pval", switched),
        );
        await shot("watcher-linked-worktree");
      } finally {
        git(["-C", main.path, "worktree", "remove", "--force", linked]);
        for (const branch of [initial, switched]) {
          try {
            git(["-C", main.path, "branch", "-D", branch]);
          } catch {
            // A failure before switch leaves only the initial fixture branch.
          }
        }
      }
    },
  );
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
        assert.ok(
          proposal,
          "Missing fixture should have a quarantine proposal",
        );
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
        await click(`${row} .row-acts button`, "Review history…");
        await element(".dialog .df button", "Quarantine history", true);
        assert.equal(
          await execute(
            () =>
              document.querySelector('.dialog input[name="recovery"]:checked')
                ?.value,
          ),
          "quarantine",
        );
        assert.ok(await textContains(".dialog .history-paths", store));
        // Two clicks in one browser task exercise the guard before React rerenders.
        await execute((selector) => {
          const button = document.querySelector(selector);
          button.click();
          button.click();
        }, ".dialog .df button.primary");
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
              toast?.textContent.includes("History quarantined") &&
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
        await wait(
          "history refreshed before Undo",
          async () => !(await api("status")).historyPending,
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
        await wait(
          "Undo history refreshed",
          async () => !(await api("status")).historyPending,
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
          await wait(
            "history ready for fixture recovery",
            async () => !(await api("status")).historyPending,
          ).catch(() => {});
          await api("undo", { id: journal }).catch(() => {});
        }
        await rm(store, { recursive: true, force: true });
      }
    },
  );
}

try {
  if (agentOnly) await installFakeAgents();
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
        assert.deepEqual(
          current.roots,
          [],
          "Fresh setup must not choose roots",
        );
        assert.deepEqual(
          current.connectors,
          [],
          "Fresh setup must not activate connectors",
        );
        assert.equal(
          await execute(
            () =>
              document.querySelectorAll(".setup .sset:first-of-type .opt")
                .length,
          ),
          0,
        );
        await tabTo('.setup input[aria-label="Another folder"]');
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
        await discardDraft();
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
        await type(
          '.setup [aria-label="Another folder"]',
          path.join(fixtureHome, "project"),
        );
        await click(".setup button", "Add folder", true);
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
          const selector = `.setup .apps .fld:nth-child(${index}) [role="combobox"]`;
          const choices = await selectOptions(selector);
          const choice =
            choices.find((option) => !option.selected && !option.disabled)
              ?.value ?? choices.find((option) => option.selected)?.value;
          assert.ok(choice);
          await key("\uE00C");
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
        // A LACI_EDITOR, LACI_FILES or LACI_TERMINAL value is for this run only and is never written.
        assert.deepEqual(
          saved.apps,
          Object.fromEntries(
            Object.entries(selectedApps).filter(
              ([kind, value]) =>
                value !== process.env[`LACI_${kind.toUpperCase()}`],
            ),
          ),
        );
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
      await saveSetup({
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

    if (
      !watcherOnly &&
      !keyboardOnly &&
      !modularOnly &&
      !patchOnly &&
      !agentOnly
    ) {
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

    if (agentOnly) {
      await agentRegressions();
      assert.deepEqual(
        await execute(() => window.__LACI_SMOKE_ERRORS__ ?? []),
        [],
      );
      console.log(
        JSON.stringify(
          { passed: true, binary, fixtureHome, mode: "agent", checks: results },
          null,
          2,
        ),
      );
    } else if (patchOnly) {
      await patchRegressions();
      assert.deepEqual(
        [
          ...frontendErrors,
          ...(await execute(() => window.__LACI_SMOKE_ERRORS__ ?? [])),
        ],
        [],
      );
      console.log(
        JSON.stringify(
          { passed: true, binary, fixtureHome, mode: "patch", checks: results },
          null,
          2,
        ),
      );
    } else if (modularOnly) {
      await modularRegressions();
      await reportRegressions();
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
      await patchRegressions();

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
        await nav("Agents", "Agents");
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
            () =>
              document.querySelectorAll(
                ".readme script, .readme style, .readme form, .readme [style], .readme [class]:not(.readme-remote)",
              ).length,
          ),
          0,
          "A README renders as text structure only",
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

      await check("Heavy archive preview says build output is deleted", async () => {
        const heavyProject = Object.values((await snapshot()).nodes).find(
          (node) =>
            !node.archived && node.size?.reclaimable && node.archivePlan,
        );
        if (!heavyProject) return;
        await showProject(heavyProject);
        await click(".insp .iacts button", "Archive", true);
        await click(".dialog .ops input[type=checkbox]");
        await wait("selected cleanup copy", () =>
          textContains(".dialog .df", "come back with the next install or build"),
        );
        await click(".dialog .ops input[type=checkbox]");
        assert.equal(
          await textContains(".dialog .df", "come back with the next install or build"),
          false,
        );
        await click(".dialog button", "Cancel", true);
      });

      const newPath = path.join(fixtureHome, "project", projectName);
      await check("New project dialog creates a real project", async () => {
        await click('.sb-top [aria-label="New project"]');
        await type(".dialog input[pattern]", projectName);
        await select(
          '.dialog [role="combobox"][aria-label="Project location"]',
          path.join(fixtureHome, "project"),
        );
        await shot("new-project");
        await click(".dialog .df button", "Create project", true);
        await wait(
          "new project on disk and snapshot",
          async () => (await snapshot()).nodes[newPath],
        );
        await click(".dialog .df button", "Open project", true);
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
        await select('.insp [role="combobox"][aria-label="Status"]', "paused");
        await wait(
          "status persisted",
          async () =>
            (await snapshot()).nodes[newPath]?.meta.status === "paused",
        );
        await select('.insp [role="combobox"][aria-label="Priority"]', "high");
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
        await nav("Agents", "Agents");
        await click(".stat.add, .empty-hero button", "Add another AI tool");
        await shot("connector-picker");
        await click(".dialog .more-fields summary", "Something else");
        await type(".dialog input[name=name]", name);
        await select(
          '.dialog [aria-label="How Laci finds the project"]',
          "inside",
        );
        await type(".dialog input[name=path]", ".smoke-agent");
        await shot("connector-custom");
        await click(".dialog .df button", "Add tool", true);
        await wait("custom connector saved", async () =>
          (await snapshot()).connectors.some(
            (connector) => connector.name === name && !connector.builtin,
          ),
        );
        const remove = await wait(
          "custom connector removal enabled in React",
          () =>
            execute((name) => {
              const card = [...document.querySelectorAll(".stat")].find(
                (item) => item.querySelector(".k")?.textContent === name,
              );
              if (card) card.querySelector("details").open = true;
              const button = [...(card?.querySelectorAll("button") ?? [])].find(
                (item) => item.textContent === "Remove",
              );
              return button && !button.disabled ? button : null;
            }, name),
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
          await click(".ttab[data-active] button.x");
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
      await reportRegressions();

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
  for (const [pid, identity] of fakeAgentProcesses) {
    if (sameLiveProcess(await processIdentity(pid), identity)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
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
