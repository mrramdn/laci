// ui/src/words.ts: Simple's words follow its writing rules (design-research §3.4), every ⓘ has its
// glossary entry, and times read as words.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "../ui-module.mjs";

const words = load("words.ts");

/**
 * Every text the areas of words.ts can give, with where it is: each string, and what each function
 * gives for sample values. Text that only reaches the AI (a prompt) or a browser (an address) is
 * left out, as are the glossary, which names the Git words on purpose, and its helpers.
 */
function texts() {
  const found = [];
  const skip = new Set(["glossary", "termOf", "findTerms", "count", "listed", "ago", "spent", "engineSays"]);
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

export async function homeNeverCallsAFolderWithoutVersionHistorySavedAndOnline() {
  const body = words.home.safeBody;
  // Every project has its history: the sentence is the one it always was.
  assert.equal(body(1), "Your project is saved and online.");
  assert.equal(body(6), "All 6 projects are saved and online.");
  assert.equal(body(6, 0), "All 6 projects are saved and online.");
  // A folder of notes is named apart from the projects that are saved.
  assert.equal(body(6, 1), "5 projects are saved and online. 1 project has no version history.");
  assert.equal(body(3, 2), "1 project is saved and online. 2 projects have no version history.");
  // With nothing but notes, nothing is saved and online.
  assert.equal(body(1, 1), "Your project has no version history.");
  assert.equal(body(4, 4), "All 4 projects have no version history.");
  for (const [projects, noHistory] of [[1, 1], [4, 4], [6, 1], [3, 2], [2, 3]])
    assert.doesNotMatch(
      body(projects, noHistory),
      /^(All \d+ projects|Your project) (is|are) saved and online/,
      `${projects} projects, ${noHistory} without history`,
    );
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

export async function theTrashAndTheSearchKeyHaveTheirNames() {
  assert.equal(words.termOf("trash").term, "Move to Trash");
  assert.match(words.termOf("trash").info, /Restore it from the Trash\./);
  assert.equal(words.shell.searchKey, "Ctrl K");
  assert.match(words.help.safe.join(" "), /moving a project to the Trash/);
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

/** A source file of the engine, its strings continued over lines (`\` at a line's end) joined. */
const engine = (file) =>
  readFileSync(new URL(`../../crates/laci-core/src/${file}`, import.meta.url), "utf8").replace(/\\\n\s*/g, "");

export async function theEnginesReasonsAboutTheCopyAreSaidInEachDesignsWords() {
  // Every reason backup.rs gives why the copy's folder can't be used now, with the folder it names.
  const reasons = [...engine("backup.rs").matchAll(/"(The folder for the copy of AI chats [^"]*)"/g)].map(([, text]) =>
    text.replace("{shown}", "/mnt/archive/ai-chats"),
  );
  assert.equal(reasons.length, 5, reasons.join("\n"));
  for (const reason of reasons) {
    const detailed = words.engineSays(reason, "detailed");
    const simple = words.engineSays(reason, "simple");
    // Detailed's words call it the history backup and say where its folder is chosen.
    assert.match(detailed, /^The history backup's folder .*: \/mnt\/archive\/ai-chats\. .* in Settings › Backup folder\.$/, detailed);
    // Simple's say where it shows the copy's place, with its own apostrophes.
    assert.match(simple, /^The folder for the copy of your AI chats .*: \/mnt\/archive\/ai-chats\. .* in AI helpers › Where Laci keeps the copy\.$/, simple);
    assert.doesNotMatch(simple, /'/, simple);
    // Also inside a longer message, as when a move can't start.
    const longer = `Connect the drive first, so Laci can move the copy. ${reason}`;
    assert.equal(words.engineSays(longer, "simple"), `Connect the drive first, so Laci can move the copy. ${simple}`);
  }
  assert.equal(
    words.engineSays(
      "The folder for the copy of AI chats isn't there: /mnt/archive/ai-chats. Connect its drive, or choose another folder for the copy.",
      "simple",
    ),
    "The folder for the copy of your AI chats isn’t there: /mnt/archive/ai-chats. Connect its drive, or choose another folder in AI helpers › Where Laci keeps the copy.",
  );
  assert.equal(
    words.engineSays(
      "The folder for the copy of AI chats isn't there: /mnt/archive/ai-chats. Connect its drive, or choose another folder for the copy.",
      "detailed",
    ),
    "The history backup's folder isn't there: /mnt/archive/ai-chats. Connect its drive, or choose another folder in Settings › Backup folder.",
  );
  // What it doesn't know stays as the engine said it.
  assert.equal(words.engineSays("That folder already holds files.", "simple"), "That folder already holds files.");
}

export async function aFailureIsSaidInTheWordsOfTheDesignOnThePage() {
  const page = { documentElement: { dataset: { design: "simple" } } };
  const { errorText } = load("api.ts", { "@tauri-apps/api/core": { invoke: async () => ({}) } }, { document: page });
  const why =
    "The folder for the copy of AI chats isn't there: /mnt/archive/ai-chats. Connect its drive, or choose another folder for the copy.";
  assert.equal(errorText(new Error(why)), words.engineWords.simple.copyMissing("/mnt/archive/ai-chats"));
  page.documentElement.dataset.design = "detailed";
  assert.equal(errorText(why), words.engineWords.detailed.copyMissing("/mnt/archive/ai-chats"));
  assert.equal(errorText(new Error("Something else")), "Something else");
  assert.equal(errorText({ code: 1 }), '{"code":1}');
}
