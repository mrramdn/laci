// Rebuilds ui/src/preview/fixtures.json: what the engine answers on the demo home, at a fixed time.
// Usage: node scripts/ui-fixtures.mjs [--keep]   (--keep leaves the temporary demo home to look at)
// The demo home is made in a temporary folder with LACI_DEMO_NOW fixed, and the engine's clock is
// stopped at that time too, so statuses and "Due in 5 days" come out the same on every day. The
// engine runs with an environment, a PATH and a Git configuration of their own, so nothing of this
// machine reaches the file. Every path in the result starts with /home/demo and the keys are
// sorted: running this twice gives the same bytes.
// It needs Linux and a C compiler (cc, or $CC): a few lines of C are preloaded to stop the clock.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "ui/src/preview/fixtures.json");
/** The time the demo home is made for, and the time the preview's clock starts at. */
const NOW = "2026-10-08T09:00:00Z";
/** Where the demo home is said to be in the fixtures. */
const DEMO_HOME = "/home/demo";
/** What the demo machine has: two agents, GitHub's tool, and two apps of each kind Settings offers. */
const INSTALLED = [
  "claude",
  "codex",
  "gh",
  "kitty",
  "foot",
  "code",
  "zed",
  "dolphin",
  "thunar",
];

/**
 * The engine reads the real clock and cannot be told another. Preloaded, this answers every question
 * about the time with LACI_FAKE_NOW (in seconds), for the engine and for the Git it starts.
 */
const CLOCK = `#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <time.h>
int clock_gettime(clockid_t id, struct timespec *at) {
  static int (*real)(clockid_t, struct timespec *);
  const char *stopped = getenv("LACI_FAKE_NOW");
  if (!real) real = dlsym(RTLD_NEXT, "clock_gettime");
  int result = real(id, at);
  if (result == 0 && stopped && (id == CLOCK_REALTIME || id == CLOCK_REALTIME_COARSE)) {
    at->tv_sec = atol(stopped);
    at->tv_nsec = 0;
  }
  return result;
}
`;

const keep = process.argv.includes("--keep");
const encode = (text) => text.replace(/[^A-Za-z0-9]/g, "-");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function onPath(program) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      const file = path.join(dir, program);
      accessSync(file, constants.X_OK);
      return realpathSync(file);
    } catch {
      /* Try the next folder. */
    }
  }
  throw new Error(`${program} is not on PATH`);
}

/** Only what the engine needs: no tokens, no Git settings, no folders of this machine. */
const sandbox = (home, bin) => ({
  PATH: bin,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  TZ: "UTC",
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file",
  LACI_DEMO_NOW: NOW,
});

function exampleBinary() {
  const messages = execFileSync(
    "cargo",
    [
      "build",
      "-q",
      "-p",
      "laci-core",
      "--example",
      "ui_fixtures",
      "--message-format=json-render-diagnostics",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  for (const line of messages.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line);
    if (
      message.reason === "compiler-artifact" &&
      message.target.name === "ui_fixtures" &&
      message.executable
    )
      return message.executable;
  }
  throw new Error("cargo did not build the ui_fixtures example");
}

/** Makes a key's order independent of how the engine happened to write it. */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort(compare)
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}

function tidy(raw, home, leaks) {
  // The home appears as itself and, in the names of an agent's history folders, with dashes for
  // every character that is not a letter or a digit.
  const swap = (text) =>
    text
      .split(home)
      .join(DEMO_HOME)
      .split(encode(home))
      .join(encode(DEMO_HOME));
  const rewrite = (value) => {
    if (typeof value === "string") return swap(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => [
          swap(key),
          rewrite(field),
        ]),
      );
    return value;
  };
  const result = rewrite(raw);
  // A folder that is not a Git repository is known by a hash of its path: the temporary one.
  for (const node of Object.values(result.snapshot.nodes))
    if (node.stableId.startsWith("p:"))
      node.stableId = `p:${createHash("sha1").update(node.path).digest("hex").slice(0, 12)}`;
  const text = `${JSON.stringify(sorted(result), null, 2)}\n`;
  // Nothing of this machine may be left in a file that goes into the repository.
  for (const secret of leaks) {
    const at = text.indexOf(secret);
    if (at >= 0)
      throw new Error(
        `The fixtures still hold ${JSON.stringify(secret)}: ${text.slice(at - 60, at + 80)}`,
      );
  }
  return text;
}

/**
 * The demo home: a folder of /tmp whose path is as long as /home/demo. A session log holds the path of
 * its project, so its size, and every number made from it, is only what it would be at /home/demo
 * if the two paths are as long.
 */
function makeHome() {
  for (;;) {
    const name = randomBytes(3)
      .toString("hex")
      .slice(0, DEMO_HOME.length - 5);
    try {
      mkdirSync(`/tmp/${name}`);
      const home = realpathSync(`/tmp/${name}`);
      if (home.length === DEMO_HOME.length) return home;
      rmSync(home, { recursive: true });
      throw new Error(`${home} is not as long as ${DEMO_HOME}`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

/** A C compiler is a small thing to ask for, but its absence should say so. */
function compile(source, library) {
  const cc = process.env.CC ?? "cc";
  try {
    execFileSync(
      cc,
      ["-shared", "-fPIC", "-O1", "-o", library, source, "-ldl"],
      {
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
  } catch (error) {
    throw new Error(
      `Stopping the engine's clock needs a C compiler (${cc}): ${error.message}`,
    );
  }
}

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "laci-fixtures-")));
let home;
try {
  home = makeHome();
  const git = onPath("git");
  const tools = path.join(tmp, "tools");
  mkdirSync(tools);
  symlinkSync(git, path.join(tools, "git"));
  execFileSync(process.execPath, [path.join(root, "scripts/demo.ts"), home], {
    env: sandbox(home, tools),
    stdio: ["ignore", "ignore", "inherit"],
  });

  // The engine finds programs on PATH. This one lists only the demo machine's.
  const bin = path.join(home, ".local/bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(git, path.join(bin, "git"));
  for (const program of INSTALLED) {
    writeFileSync(path.join(bin, program), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, program), 0o755);
  }
  const clock = path.join(tmp, "clock.so");
  writeFileSync(path.join(tmp, "clock.c"), CLOCK);
  compile(path.join(tmp, "clock.c"), clock);
  const recorded = path.join(tmp, "recorded.json");
  execFileSync(exampleBinary(), [home, recorded], {
    env: {
      ...sandbox(home, bin),
      LD_PRELOAD: clock,
      LACI_FAKE_NOW: String(Date.parse(NOW) / 1000),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  // A user or host name the committed fixtures already hold ("root" in "roots", "arch" in "archive",
  // "dev" in "pnpm dev") is a word of the demo and can't be told from a leak; the paths still can.
  let known = "";
  try {
    known = readFileSync(output, "utf8");
  } catch {
    /* No fixtures yet: every name is checked. */
  }
  const names = [os.userInfo().username, os.hostname()].filter(
    (name) => name.length > 3 && !known.includes(name),
  );
  const leaks = [home, tmp, os.homedir(), encode(os.homedir()), root, ...names];
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(
    output,
    tidy(JSON.parse(readFileSync(recorded, "utf8")), home, leaks),
  );
  console.log(`Wrote ${path.relative(root, output)}`);
} finally {
  if (keep) console.log(`Kept ${home} and ${tmp}`);
  else
    for (const folder of [home, tmp])
      if (folder) rmSync(folder, { recursive: true, force: true });
}
