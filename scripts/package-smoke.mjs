// Extract and exercise the final Linux packages; an optional directory retains them for native QA.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = path.resolve(
  process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
);
const version = JSON.parse(
  readFileSync(path.join(root, "package.json")),
).version;
const output = process.argv[2]
  ? path.resolve(process.argv[2])
  : mkdtempSync(path.join(tmpdir(), "laci-package-smoke-"));
const env = { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" };
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
function buildId(file) {
  const id = run("readelf", ["-n", file]).match(/Build ID: ([a-f0-9]+)/)?.[1];
  assert.ok(id, `Missing build identity: ${file}`);
  return id;
}
function desktopEntry(file) {
  const fields = {};
  let group = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (line.startsWith("[")) group = line;
    else if (group === "[Desktop Entry]" && at > 0)
      fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}
const releaseId = buildId(path.join(target, "release/laci"));
const assets = readdirSync(path.join(root, "ui/dist/assets")).filter((name) =>
  /\.(js|css)$/.test(name),
);
assert.ok(assets.length >= 2, "Build the UI before checking packages");
mkdirSync(output, { recursive: true });
const records = [];
try {
  for (const [kind, name] of [
    ["deb", `laci_${version}_amd64.deb`],
    ["rpm", `laci-${version}-1.x86_64.rpm`],
    ["appimage", `laci_${version}_amd64.AppImage`],
  ]) {
    const archive = path.join(target, "release/bundle", kind, name);
    let extracted = path.join(output, kind);
    // A dedicated empty directory avoids mixing files from different package revisions.
    mkdirSync(extracted);
    if (kind === "deb") {
      run("ar", ["x", archive], { cwd: extracted });
      const members = readdirSync(extracted);
      for (const prefix of ["data.tar", "control.tar"]) {
        const member = members.find((name) => name.startsWith(prefix));
        assert.ok(member, `Missing ${prefix}`);
        const destination =
          prefix === "data.tar" ? extracted : path.join(extracted, "control");
        mkdirSync(destination, { recursive: true });
        run("bsdtar", ["-xf", path.join(extracted, member), "-C", destination]);
      }
      const control = readFileSync(
        path.join(extracted, "control/control"),
        "utf8",
      );
      assert.ok(control.startsWith("Package: laci\n"));
      assert.ok(control.includes(`Version: ${version}\n`));
      for (const dependency of [
        "git",
        "libglib2.0-bin",
        "xdg-utils",
        "libwebkit2gtk-4.1-0",
      ]) {
        assert.ok(
          control.includes(dependency),
          `Missing Debian dependency: ${dependency}`,
        );
      }
    } else if (kind === "rpm") {
      run("bsdtar", ["-xf", archive, "-C", extracted]);
    } else {
      writeFileSync(
        path.join(output, "appimage-extract.log"),
        run(archive, ["--appimage-extract"], { cwd: extracted }),
      );
      extracted = path.join(extracted, "squashfs-root");
    }
    const binary = path.join(extracted, "usr/bin/laci");
    const runner =
      kind === "appimage" ? path.join(extracted, "AppRun") : binary;
    assert.equal(buildId(binary), releaseId);
    const embedded = readFileSync(binary);
    for (const asset of assets) {
      assert.ok(
        embedded.includes(Buffer.from(asset)),
        `Missing embedded UI asset: ${asset}`,
      );
    }
    // The window class and the file, binary and icon names stay "laci"; menus show "Laci".
    const entry = desktopEntry(
      path.join(extracted, "usr/share/applications/laci.desktop"),
    );
    for (const [key, value] of Object.entries({
      Name: "Laci",
      Exec: "laci",
      Icon: "laci",
      StartupWMClass: "laci",
    })) {
      assert.equal(entry[key], value, `${kind} desktop entry: ${key}`);
    }
    assert.ok(
      readdirSync(path.join(extracted, "usr/share/icons/hicolor"), {
        recursive: true,
      }).some((name) => name.endsWith("/laci.png")),
    );
    assert.equal(run(runner, ["--version"]).trim(), `laci ${version}`);
    const fixture = path.join(output, `${kind}-fixture`);
    run(process.execPath, [path.join(root, "scripts/demo.ts"), fixture]);
    mkdirSync(path.join(fixture, ".config/laci"), { recursive: true });
    writeFileSync(
      path.join(fixture, ".config/laci/config.json"),
      JSON.stringify({
        roots: ["~/project"],
        presets: ["claude", "codex"],
        custom: [],
        apps: {},
      }),
    );
    const snapshot = JSON.parse(
      run(runner, ["json"], { env: { ...env, LACI_HOME: fixture } }),
    );
    assert.equal(snapshot.home, fixture);
    assert.equal(
      Object.values(snapshot.nodes).filter((node) => node.kind === "project")
        .length,
      7,
    );
    const mcp = run(process.execPath, [
      path.join(root, "scripts/mcp-smoke.mjs"),
      runner,
    ]);
    writeFileSync(path.join(output, `${kind}-mcp.log`), mcp);
    records.push({
      kind,
      archive,
      sha256: sha256(archive),
      runner,
      buildId: releaseId,
      version,
      projects: 7,
      assets,
    });
    console.log(
      `PASS ${kind}: version, assets, build identity, launcher, icons, CLI and MCP`,
    );
  }
  writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        version,
        checkedAt: new Date().toISOString(),
        packages: records,
        scope:
          "Archive extraction and local execution; no package-manager installation.",
      },
      null,
      2,
    ) + "\n",
  );
  if (process.argv[2])
    console.log(`Package proof: ${path.join(output, "report.json")}`);
} finally {
  if (!process.argv[2]) rmSync(output, { recursive: true, force: true });
}
