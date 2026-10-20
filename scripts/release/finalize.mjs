// Assembles a release from the signed packages: checks the updater signature, writes latest.json and checks it the
// way the updater reads it, writes provenance.json and SHA256SUMS of every asset, and the release's notes.
//   node scripts/release/finalize.mjs --packages <dir> --out <dir> --version <version> [--tag <tag>] [--dry-run]
//     [--public-key <file>] --commit <sha> --runner <label> --glibc <version> --run-url <url> --artifact <name>
// <dir> holds the AppImage, its .sig, the deb and the rpm, and nothing else. The assets go to <out>/assets and the
// release text to <out>/notes.md. Without --public-key the signature must verify under tauri.conf.json's key.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  checkLatestJson,
  checkSums,
  downloadBase,
  latestJson,
  packageNames,
  provenance,
  rfc3339,
  sha256,
  sha256sums,
} from "./assets.mjs";
import { shippedPublicKey, verifyUpdate } from "./minisign.mjs";
import { releaseBody, releaseNotes } from "./notes.mjs";
import { parseTag, root } from "./version.mjs";

/** Builds the release in `out`. Answers what it checked, line by line. */
export function finalize(options, { changelog, now = new Date() }) {
  const { version, packages, out, dryRun } = options;
  const tag = options.tag ?? `v${version}`;
  if (parseTag(tag).version !== version) throw new Error(`Tag ${tag} doesn't name version ${version}`);
  const names = packageNames(version);
  const expected = [names.appImage, names.signature, names.deb, names.rpm];
  const found = readdirSync(packages).sort();
  if (JSON.stringify(found) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${packages} should hold exactly ${expected.join(", ")}; it holds ${found.join(", ") || "nothing"}`);
  }
  const publicKey = options.publicKey ?? shippedPublicKey();
  const log = [];

  // The updater's signature first: nothing else is written when it is wrong.
  const signature = readFileSync(path.join(packages, names.signature), "utf8");
  const { keyId } = verifyUpdate(readFileSync(path.join(packages, names.appImage)), signature, publicKey, version);
  log.push(`${names.signature}: good signature by key ${keyId} for version ${version}`);

  const assets = path.join(out, "assets");
  mkdirSync(assets, { recursive: true });
  for (const name of expected) copyFileSync(path.join(packages, name), path.join(assets, name));

  const section = releaseNotes(changelog, version);
  const baseUrl = downloadBase(tag);
  const feed = latestJson({
    version,
    notes: section.body,
    pubDate: rfc3339(now),
    baseUrl,
    appImage: names.appImage,
    signature,
  });
  writeFileSync(path.join(assets, "latest.json"), `${JSON.stringify(feed, null, 2)}\n`);
  for (const line of checkLatestJson(readFileSync(path.join(assets, "latest.json"), "utf8"), {
    dir: assets,
    publicKey,
    version,
    baseUrl,
  })) {
    log.push(`latest.json ${line}`);
  }

  const hashed = [...expected, "latest.json"];
  const prov = provenance({
    version,
    commit: options.commit,
    tag,
    dryRun,
    runner: options.runner,
    glibc: options.glibc,
    runUrl: options.runUrl,
    artifact: options.artifact,
    keyId,
    sums: Object.fromEntries(hashed.sort().map((name) => [name, sha256(path.join(assets, name))])),
  });
  writeFileSync(path.join(assets, "provenance.json"), `${JSON.stringify(prov, null, 1)}\n`);

  const all = [...hashed, "provenance.json"];
  writeFileSync(path.join(assets, "SHA256SUMS"), sha256sums(assets, all));
  const checked = checkSums(assets, readFileSync(path.join(assets, "SHA256SUMS"), "utf8"));
  log.push(`SHA256SUMS: ${checked.length} files, all match`);

  writeFileSync(
    path.join(out, "notes.md"),
    releaseBody(section.body, { runUrl: options.runUrl, runner: options.runner, glibc: options.glibc }),
  );
  log.push(`notes.md: from "${section.heading}"`);
  return log;
}

function main() {
  const { values } = parseArgs({
    options: {
      packages: { type: "string" },
      out: { type: "string" },
      version: { type: "string" },
      tag: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "public-key": { type: "string" },
      commit: { type: "string" },
      runner: { type: "string" },
      glibc: { type: "string" },
      "run-url": { type: "string" },
      artifact: { type: "string" },
    },
  });
  for (const required of ["packages", "out", "version", "commit", "runner", "glibc", "run-url", "artifact"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  if (values["dry-run"] !== Boolean(values["public-key"])) {
    throw new Error("A dry run takes its throwaway --public-key; a release uses tauri.conf.json's key");
  }
  const log = finalize(
    {
      version: values.version,
      tag: values.tag,
      dryRun: values["dry-run"],
      packages: values.packages,
      out: values.out,
      publicKey: values["public-key"] && readFileSync(values["public-key"], "utf8").trim(),
      commit: values.commit,
      runner: values.runner,
      glibc: values.glibc,
      runUrl: values["run-url"],
      artifact: values.artifact,
    },
    { changelog: readFileSync(path.join(root, "CHANGELOG.md"), "utf8") },
  );
  for (const line of log) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
