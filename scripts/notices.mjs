// Write THIRD_PARTY_NOTICES.md: the licenses of the icons, fonts, npm packages and Rust crates Laci ships with.
// Run `pnpm install --frozen-lockfile` and `cargo fetch --locked` first, then `pnpm notices`.
//   --check            exit with an error when the file is out of date, and write nothing
//   --target <triple>  list the crates built for this Rust target; repeat it for more
//                      (default x86_64-unknown-linux-gnu)
// The output is sorted and holds no dates or paths, so the same lockfiles always give the same file.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "THIRD_PARTY_NOTICES.md");

const args = process.argv.slice(2);
const check = args.includes("--check");
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target" && args[i + 1]) targets.push(args[++i]);
  else if (args[i] !== "--check") {
    console.error("Usage: node scripts/notices.mjs [--check] [--target <rust triple>]...");
    process.exit(2);
  }
}
if (!targets.length) targets.push("x86_64-unknown-linux-gnu");

// Fonts are npm packages, but they get their own section. The OFL text comes from each package.
const FONTS = [
  { family: "Geist", package: "@fontsource/geist", source: "https://github.com/vercel/geist-font" },
  { family: "Geist Mono", package: "@fontsource/geist-mono", source: "https://github.com/vercel/geist-font" },
  {
    family: "Plus Jakarta Sans",
    package: "@fontsource-variable/plus-jakarta-sans",
    source: "https://github.com/tokotype/PlusJakartaSans",
  },
];

// ui/public/icons.svg is drawn from Lucide. Both texts are Lucide's own LICENSE file, split in two.
const LUCIDE = `ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

const FEATHER = `The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// A few packages ship no license file. They get the standard text of the license they declare.
const mit = (holders) => `MIT License

Copyright (c) ${holders}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const bsd3 = (holders) => `BSD 3-Clause License

Copyright (c) ${holders}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

// Names a text for its heading. A text that holds two licenses says so instead of guessing.
// Phrases match across line breaks, because every project wraps the same license text differently.
const phrase = (text) =>
  text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
const kind = (name, ...phrases) => [name, new RegExp(phrases.map(phrase).join("[\\s\\S]+"), "i")];
const KINDS = [
  kind("Apache License 2.0", "Apache License Version 2.0"),
  kind("Mozilla Public License 2.0", "Mozilla Public License Version 2.0"),
  kind("MIT License", "Permission is hereby granted, free of charge, to any person obtaining a copy of this software"),
  kind(
    "ISC License",
    "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that",
  ),
  kind(
    "BSD Zero Clause License",
    "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.",
  ),
  kind("BSD 3-Clause License", "Redistribution and use in source and binary forms", "Neither the name"),
  kind("BSD 2-Clause License", "Redistribution and use in source and binary forms"),
  kind("Unicode License v3", "UNICODE LICENSE V3"),
  kind("The Unlicense", "free and unencumbered software released into the public domain"),
  kind("SIL Open Font License 1.1", "SIL OPEN FONT LICENSE Version 1.1"),
  kind("zlib License", "provided 'as-is', without any express or implied warranty"),
  kind("CC0 1.0 Universal", "CC0 1.0 Universal"),
];

// What counts as a license file in a package folder. Machine-readable manifests and code do not.
const LICENSE_FILE = /^(?:licen[cs]e|copying|copyright|copyrightnotice|notice|notices|unlicense)(?:[-_. ].*)?$/i;
const NOT_TEXT = /\.(?:spdx|rs|toml|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|c|h|cc|cpp|hpp|html|css|map|lock)$/i;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a, b) => compare(a.name, b.name) || compare(a.version, b.version);
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });

// Same text, whatever the editor or the platform did to the line ends and the edges.
function clean(buffer) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = buffer.toString("latin1");
  }
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");
}

function licenseFiles(dir) {
  const texts = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name) && !NOT_TEXT.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => clean(readFileSync(path.join(dir, name))))
    .filter(Boolean);
  return [...new Set(texts)];
}

// A repository field can be git+https, git://, ssh or scp style. Only a plain web address is linked.
function webUrl(url) {
  const plain = String(url ?? "")
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/#readme$/, "")
    .replace(/\.git$/, "");
  return /^https?:\/\/[^\s()|<>]+$/.test(plain) ? plain : null;
}

// Drops everything between "<" and ">" (the addresses in "Name <name@example.com>"), the brackets themselves, and
// the rest of the string after a "<" that never closes. A scan, not a replace, so nothing it removes can rejoin into
// a new "<...>".
const withoutAddresses = (text) => {
  let out = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "<") depth += 1;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
};

// Authors for the standard texts: names only, no addresses or links in brackets.
const holders = (names, fallback) =>
  names
    .map((name) => withoutAddresses(name).replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(", ") || `the authors of ${fallback}`;

// "MIT OR Apache-2.0", "MIT/Apache-2.0" and "(MIT OR Apache-2.0) AND Unicode-3.0" all become a list of ids.
const licenseIds = (expression) =>
  expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND|WITH)\s+|\s*\/\s*/)
    .map((id) => id.trim())
    .filter(Boolean);

function npmPackages() {
  const listed = JSON.parse(run("pnpm", ["-C", "ui", "licenses", "list", "--prod", "--json"]));
  const fontPackages = new Set(FONTS.map((font) => font.package));
  const found = new Map();
  for (const [license, packages] of Object.entries(listed)) {
    for (const pkg of packages) {
      if (fontPackages.has(pkg.name)) continue;
      for (const dir of pkg.paths) {
        const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
        found.set(`${pkg.name}@${meta.version}`, {
          name: pkg.name,
          version: meta.version,
          license,
          source:
            webUrl(pkg.homepage) ??
            webUrl(typeof meta.repository === "string" ? meta.repository : meta.repository?.url) ??
            `https://www.npmjs.com/package/${pkg.name}/v/${meta.version}`,
          holders: holders(pkg.author ? [pkg.author] : [], pkg.name),
          texts: licenseFiles(dir),
        });
      }
    }
  }
  return [...found.values()].sort(byName);
}

// Everything the workspace's two crates need for the target, minus what only tests need.
// Crates that run while building (build scripts, proc macros) are kept: they are part of how Laci is made.
function rustCrates() {
  const found = new Map();
  for (const target of targets) {
    const meta = JSON.parse(
      run("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target]),
    );
    const packages = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
    const nodes = new Map(meta.resolve.nodes.map((node) => [node.id, node]));
    const members = new Set(meta.workspace_members);
    const seen = new Set();
    const queue = [...members];
    while (queue.length) {
      const id = queue.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of nodes.get(id).deps) {
        if (dep.dep_kinds.some((kind) => kind.kind !== "dev")) queue.push(dep.pkg);
      }
    }
    for (const id of seen) {
      if (members.has(id)) continue;
      const pkg = packages.get(id);
      found.set(`${pkg.name}@${pkg.version}`, {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? "Unknown",
        source:
          webUrl(pkg.repository) ?? webUrl(pkg.homepage) ?? `https://crates.io/crates/${pkg.name}/${pkg.version}`,
        holders: holders(pkg.authors, pkg.name),
        texts: licenseFiles(path.dirname(pkg.manifest_path)),
      });
    }
  }
  return [...found.values()].sort(byName);
}

function fonts() {
  return FONTS.flatMap((font) => {
    const dir = path.join(root, "ui/node_modules", font.package);
    if (!existsSync(path.join(dir, "package.json"))) return [];
    const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const texts = licenseFiles(dir);
    if (!texts.length) throw new Error(`${font.package} has no license file`);
    return [{ ...font, version: meta.version, license: meta.license, texts }];
  });
}

function labelOf(text) {
  const names = KINDS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  // The 3-clause text contains the 2-clause one.
  const kept = names.includes("BSD 3-Clause License") ? names.filter((name) => name !== "BSD 2-Clause License") : names;
  return kept.length === 1 ? kept[0] : kept.length ? "Several licenses" : "Other notice";
}

// Identical texts become one group that lists its packages. A package without a license file joins the group of
// the standard text of its license (the most used one for long texts, a template with its authors for short ones).
function grouped(entries) {
  const groups = new Map();
  const add = (entry, text) => {
    const key = sha256(text);
    if (!groups.has(key)) groups.set(key, { text, label: labelOf(text), users: [] });
    groups.get(key).users.push(entry);
  };
  for (const entry of entries) for (const text of entry.texts) add(entry, text);
  const standard = new Map();
  for (const group of groups.values()) {
    const best = standard.get(group.label);
    const bigger = best && group.users.length - best.users.length;
    if (!best || bigger > 0 || (bigger === 0 && group.text < best.text)) standard.set(group.label, group);
  }
  const standardTexts = {
    MIT: (entry) => mit(entry.holders),
    "BSD-3-Clause": (entry) => bsd3(entry.holders),
    "Apache-2.0": () => standard.get("Apache License 2.0")?.text,
    "MPL-2.0": () => standard.get("Mozilla Public License 2.0")?.text,
  };
  const missing = [];
  for (const entry of entries) {
    if (entry.texts.length) continue;
    const texts = licenseIds(entry.license)
      .map((id) => standardTexts[id]?.(entry))
      .filter(Boolean);
    if (!texts.length) missing.push(entry);
    entry.noFile = texts.length > 0;
    for (const text of texts) add(entry, text);
  }
  const sorted = [...groups.values()];
  for (const group of sorted) group.users.sort(byName);
  sorted.sort((a, b) => compare(a.label, b.label) || byName(a.users[0], b.users[0]) || compare(a.text, b.text));
  return { groups: sorted, missing };
}

// Backslashes first, so a "\" already in the text can't turn the escape of a pipe into a literal backslash.
const cell = (text) => String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
const link = (url) => `[source](${url.replace(/ /g, "%20")})`;
// A fence one backtick longer than any run inside the text, so no license can close it early.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}text`, text, fence];
}
// "Used by" as a paragraph wrapped at 100 columns, so the file reads well as plain text too.
function usedBy(users) {
  const lines = [];
  let line = "Used by:";
  for (const [i, user] of users.entries()) {
    const item = ` \`${user.name}\` ${user.version}${user.noFile ? "*" : ""}${i < users.length - 1 ? "," : ""}`;
    if (line.length + item.length > 100) {
      lines.push(line);
      line = item.trimStart();
    } else line += item;
  }
  return [...lines, line];
}

function table(entries, noun) {
  return [
    `| ${noun} | Version | License | Source |`,
    "| --- | --- | --- | --- |",
    ...entries.map((e) => `| \`${cell(e.name)}\` | ${cell(e.version)} | ${cell(e.license)} | ${link(e.source)} |`),
  ];
}

function licenseSection(entries, noun) {
  const { groups, missing } = grouped(entries);
  const lines = ["### Licenses", ""];
  if (entries.some((entry) => entry.noFile)) {
    lines.push(
      `A * marks a ${noun} that ships no license file. It is listed with the standard text of its license.`,
      "Where that text names the authors, they come from the metadata of the package.",
      "",
    );
  }
  for (const group of groups) {
    lines.push(`#### ${group.label}`, "", ...usedBy(group.users), "", ...fenced(group.text), "");
  }
  if (missing.length) {
    lines.push(
      "#### No license text found",
      "",
      `These ${noun}s declare a license but ship no text of it. See their sources.`,
      "",
      ...missing.map((entry) => `- \`${entry.name}\` ${entry.version}, ${entry.license}: ${entry.source}`),
      "",
    );
    console.warn(`No license text for: ${missing.map((entry) => `${entry.name} ${entry.version}`).join(", ")}`);
  }
  return lines;
}

function document() {
  const npm = npmPackages();
  const crates = rustCrates();
  const bundled = fonts();
  const lines = [
    "# Third-party notices",
    "",
    "Laci's own code is under the [MIT License](LICENSE). Laci also includes the work of others: icons, fonts,",
    "npm packages and Rust crates. This file lists them with their licenses.",
    "",
    "It is made by `node scripts/notices.mjs` from the lockfiles. Please don't edit it by hand.",
    "",
    "## Contents",
    "",
    "- [Icons](#icons)",
    "- [Fonts](#fonts)",
    `- [Interface packages](#interface-packages): ${npm.length} npm packages`,
    `- [Rust crates](#rust-crates): ${crates.length} crates for ${targets.map((target) => `\`${target}\``).join(", ")}`,
    "",
    "## Icons",
    "",
    "The icons in `ui/public/icons.svg` come from [Lucide](https://lucide.dev) (ISC). Lucide took some of its",
    "icons from [Feather](https://feathericons.com) (MIT). Both notices follow.",
    "",
    "### Lucide",
    "",
    ...fenced(LUCIDE),
    "",
    "### Feather",
    "",
    ...fenced(FEATHER),
    "",
    "## Fonts",
    "",
    "Laci bundles these fonts. They are used under the SIL Open Font License 1.1, which follows each one.",
    "",
    "| Font | Package | Version | License | Source |",
    "| --- | --- | --- | --- | --- |",
    ...bundled.map((f) => `| ${f.family} | \`${f.package}\` | ${f.version} | ${cell(f.license)} | ${link(f.source)} |`),
    "",
  ];
  for (const font of bundled) {
    lines.push(`### ${font.family}`, "", ...font.texts.flatMap((text) => [...fenced(text), ""]));
  }
  lines.push(
    "## Interface packages",
    "",
    "The production dependencies of the interface in `ui/`, and what they need. The tools that build it are not",
    "listed. The font packages are under Fonts.",
    "",
    ...table(npm, "Package"),
    "",
    ...licenseSection(npm, "package"),
    "## Rust crates",
    "",
    `The crates that \`laci\` and \`laci-core\` need for ${targets.map((target) => `\`${target}\``).join(", ")}.`,
    "Crates that only run while building are included. Crates that only tests need are not.",
    "",
    ...table(crates, "Crate"),
    "",
    ...licenseSection(crates, "crate"),
  );
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

try {
  const text = document();
  if (check) {
    const current = existsSync(output) ? readFileSync(output, "utf8") : "";
    if (current !== text) {
      console.error("THIRD_PARTY_NOTICES.md is out of date. Run `pnpm notices` and commit the result.");
      process.exit(1);
    }
    console.log("THIRD_PARTY_NOTICES.md is up to date.");
  } else {
    writeFileSync(output, text);
    console.log(`Wrote THIRD_PARTY_NOTICES.md (${Math.round(Buffer.byteLength(text) / 1024)} KiB).`);
  }
} catch (error) {
  console.error(`notices: ${error.message}`);
  process.exit(1);
}
