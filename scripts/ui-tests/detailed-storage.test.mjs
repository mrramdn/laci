// Detailed › Agents › Laci's storage (ui/src/storage.tsx): each part's explanation wraps in its row, at
// every width. In a window 1281 px wide the history backup's, beside its size and Open backup folder,
// was cut off mid-word, since only windows up to 880 px wide let it wrap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../../ui/src/${file}`, import.meta.url), "utf8");

/** The rules of a sheet that no @media or other at-rule holds: [selector, body]. */
function topRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const prelude = text.slice(start, open).trim();
        if (!prelude.startsWith("@")) found.push([prelude, text.slice(open + 1, i)]);
        start = i + 1;
      }
    }
  }
  return found;
}

export function aStoragePartsExplanationWrapsAtEveryWidth() {
  // The explanation is the .faint inside the part's .name, which keeps to one line.
  const source = read("storage.tsx");
  assert.match(source, /className="name"[\s\S]{0,200}className="faint"/, "storage.tsx draws it so");
  const rules = topRules(read("styles/detailed.css"));
  const own = rules.filter(([selector]) => selector === ".item .name > .faint");
  assert.equal(own.length, 1, "one rule for it, outside any @media");
  assert.match(own[0][1], /white-space:\s*normal/);
  // .name itself still keeps other rows' names to one line, with an ellipsis.
  const name = rules.find(([selector]) => selector === ".item .name");
  assert.match(name[1], /white-space:\s*nowrap/);
}
