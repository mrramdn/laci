// ui/src/words.ts: Simple's words follow its writing rules (design-research §3.4), every ⓘ has its
// glossary entry, times read as words, and the system's own words come from platform.ts.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const words = load("words.ts");
const on = (os) =>
  load("words.ts", {}, { document: { documentElement: { dataset: { os } } } });

/**
 * Every text the areas of words.ts can give, with where it is: each string, and what each function
 * gives for sample values. Text that only reaches the AI (a prompt) or a browser (an address) is
 * left out, as are the glossary, which names the Git words on purpose, and its helpers.
 */
function texts() {
  const found = [];
  const skip = new Set(["glossary", "termOf", "findTerms", "count", "listed", "ago", "spent"]);
  // Help says that the glossary lists the Git words; that sentence may name them.
  const quiet = /summaryPrompt|reportUrl|wordsWas|wordsIntro/;
  const walk = (value, where) => {
    if (quiet.test(where)) return;
    if (typeof value === "string") found.push([where, value]);
    else if (typeof value === "function") {
      const said = value(2, 3, 4);
      if (typeof said === "string") found.push([where, said]);
    } else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${where}[${i}]`));
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
  };
  for (const [name, value] of Object.entries(words)) if (!skip.has(name)) walk(value, name);
  return found;
}

export async function simpleSaysItInPlainWords() {
  const all = texts();
  assert.ok(all.length > 250, `${all.length} texts`);
  // The words an AI and Detailed use; Simple keeps them for the ⓘ and Help's glossary.
  const jargon =
    /\b(commits?|committed|push(ed|es)?|pull|remotes?|stash(es)?|branch(es)?|repo|repository|merge|rebase|upstream|HEAD|diverged|uncommitted|unpushed|orphan(ed)?|quarantine|agents?|sessions?|MCP|connectors?|scan(s|ned)?|severity|git)\b/i;
  const found = all
    .filter(([, text]) => jargon.test(text.replaceAll("GitHub", "")))
    .map(([where, text]) => `${where}: ${text}`);
  assert.deepEqual(found, []);
}

export async function simpleFollowsItsWritingRules() {
  for (const [where, text] of texts()) {
    // Times in words: never "23 min", "2 wk" or "3 mo".
    assert.doesNotMatch(text, /\b\d+ ?(min|h|hr|d|wk|mo|yr)\b/, `${where}: ${text}`);
    // Sentence case, without capitals for emphasis.
    assert.doesNotMatch(text, /\b[A-Z]{4,}\b/, `${where}: ${text}`);
    // The designs are Simple and Detailed: never a word that sounds like a level or a retirement.
    assert.doesNotMatch(text, /\b(Classic|Advanced|Pro)\b/, `${where}: ${text}`);
    // No idioms or slang that won't translate, and no exclamation.
    assert.doesNotMatch(text, /!|\b(just kidding|oops|uh-oh|piece of cake)\b/i, `${where}: ${text}`);
  }
}

export async function everyInfoHasItsGlossaryEntry() {
  const ids = words.glossary.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "glossary ids are unique");
  const terms = words.glossary.map((t) => t.term);
  assert.equal(new Set(terms).size, terms.length, "glossary terms are unique");
  for (const t of words.glossary) {
    for (const key of ["id", "term", "info", "was"])
      assert.ok(typeof t[key] === "string" && t[key].trim(), `${t.id}: ${key}`);
    assert.equal(words.termOf(t.id), t);
  }
  // Each check the "Is it safe?" card explains points at an entry, and those name the Git word.
  for (const [code, issue] of Object.entries(words.safety.issues)) {
    const entry = words.termOf(issue.term);
    assert.ok(entry, `${code}: no glossary entry "${issue.term}"`);
    assert.equal(typeof issue.body(2), "string");
  }
  for (const id of ["online-copy", "saved-version", "upload", "out-of-sync", "set-aside", "history", "line-of-work"])
    assert.match(words.termOf(id).info, /\(Git: [^)]+\)$/, id);
}

export async function everyCheckThatCanLoseWorkHasItsWords() {
  for (const code of ["no-remote", "no-commits", "dirty", "unpushed", "diverged", "stash", "no-git"]) {
    assert.ok(words.safety.issues[code]?.title, code);
    assert.ok(words.safety.fixes[code], `${code}: a fix button`);
    assert.ok(words.home.problems[code]?.("kopi-landing").includes("kopi-landing"), code);
    assert.ok(words.fix.titles[code]?.("kopi-landing"), `${code}: a sheet title`);
    assert.ok(words.fix.intros[code], `${code}: what the sheet says first`);
  }
  // One, or more than one, reads right.
  assert.equal(
    words.safety.issues["no-remote"].body(1),
    "1 saved version isn’t online. If this computer breaks, it’s gone.",
  );
  assert.equal(
    words.safety.issues["no-remote"].body(3),
    "3 saved versions aren’t online. If this computer breaks, they’re gone.",
  );
  assert.equal(words.safety.issues.stash.body(1), "1 set of changes is put aside. It is easy to lose and never uploaded.");
}

export async function timesReadAsWords() {
  // Three in the afternoon, local time: an hour before is still today wherever the test runs.
  const now = new Date(2026, 9, 8, 15, 0).getTime();
  const at = (ms) => new Date(now - ms).toISOString();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  assert.equal(words.ago(undefined, now), "");
  assert.equal(words.ago("not a time", now), "");
  assert.equal(words.ago(at(10_000), now), "just now");
  assert.equal(words.ago(at(MINUTE), now), "a minute ago");
  assert.equal(words.ago(at(23 * MINUTE), now), "23 minutes ago");
  assert.equal(words.ago(at(HOUR), now), "an hour ago");
  assert.equal(words.ago(at(2 * DAY), now), "2 days ago");
  assert.equal(words.ago(at(15 * DAY), now), "2 weeks ago");
  assert.equal(words.ago(at(45 * DAY), now), "6 weeks ago");
  assert.equal(words.ago(at(70 * DAY), now), "2 months ago");
  assert.equal(words.ago(at(400 * DAY), now), "a year ago");
  assert.equal(words.spent(30), "");
  assert.equal(words.spent(40 * 60), "40 minutes");
  assert.equal(words.spent(130 * 60), "2 hours 10 minutes");
  assert.equal(words.spent(60 * 60), "1 hour");
  assert.equal(words.count(1, "project"), "1 project");
  assert.equal(words.count(2, "set of changes", "sets of changes"), "2 sets of changes");
  assert.equal(words.listed(["a.md", "b.md", "c.md"]), "a.md, b.md and c.md");
  assert.equal(words.listed([]), "");
}

export async function yesterdayIsTheDayBeforeNotTwentyFourHoursAgo() {
  // Under an hour reads in minutes, even across midnight.
  const late = new Date(2026, 9, 7, 23, 50).toISOString();
  assert.equal(words.ago(late, new Date(2026, 9, 8, 0, 20).getTime()), "30 minutes ago");
  // Longer than that, the local day decides: three hours ago, but before midnight, is yesterday.
  const evening = new Date(2026, 9, 7, 22, 0).toISOString();
  assert.equal(words.ago(evening, new Date(2026, 9, 8, 1, 0).getTime()), "yesterday");
  assert.equal(words.ago(evening, new Date(2026, 9, 7, 23, 30).getTime()), "an hour ago");
}

export async function eachSystemGetsItsOwnWords() {
  const trash = (os) => on(os).termOf("trash");
  assert.equal(trash("windows").term, "Move to Recycle Bin");
  assert.match(trash("windows").info, /Restore it from the Recycle Bin\./);
  assert.equal(trash("macos").term, "Move to Trash");
  assert.equal(trash("linux").term, "Move to Trash");
  assert.equal(on("macos").shell.searchKey, "⌘K");
  assert.equal(on("windows").shell.searchKey, "Ctrl K");
  assert.match(on("windows").help.safe.join(" "), /Recycle Bin/);
}

export async function helpFindsAWordByAnyOfItsNames() {
  const find = (query) => words.findTerms(query).map((t) => t.id);
  assert.equal(find("").length, words.glossary.length);
  // The plain word, the Git word and words of the explanation all find it.
  assert.ok(find("online copy").includes("online-copy"));
  assert.ok(find("remote").includes("online-copy"));
  assert.ok(find("STASH").includes("set-aside"));
  assert.deepEqual(find("nothing like this anywhere"), []);
}
