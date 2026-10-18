// Every word Simple shows, by area, so the wording can be read, changed and later translated in one
// place. Detailed keeps its own words; Help, shared by both, takes its words from here too. The
// system's own names (Trash or Recycle Bin, ⌘ or Ctrl) come from platform.ts.
//
// Writing rules (design-research §3.4): plain words with the Git term one ⓘ away, sentence case,
// times in words ("23 minutes ago", never "23 min"), and no idioms, so the text translates well.
// Pure: it imports only platform.ts, so the tests read it as it is.
import { TRASH, withMod } from "./platform";

/** "1 project", "2 projects"; `many` for words that don't just take an s. */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "a.md", "a.md and b.md", "a.md, b.md and c.md". */
export function listed(items: string[]) {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const DAY = 864e5;
/** Whole local days from `then` to `now`: 0 the same day, 1 yesterday. */
function daysBetween(then: Date, now: Date) {
  const midnight = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(now) - midnight(then)) / DAY);
}

/**
 * How long ago `at` was, in words: "just now", "23 minutes ago", "3 hours ago", "yesterday",
 * "4 days ago", "2 weeks ago", "5 months ago", "a year ago". Empty when there is no time.
 */
export function ago(at: string | undefined, now = Date.now()) {
  const then = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(then)) return "";
  const seconds = (now - then) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  }
  const days = daysBetween(new Date(then), new Date(now));
  if (days === 0) {
    const hours = Math.floor(seconds / 3600);
    return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) {
    const months = Math.floor(days / 30.4);
    return months === 1 ? "a month ago" : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "a year ago" : `${years} years ago`;
}

/** Time spent, in words: "40 minutes", "2 hours 10 minutes". Empty under a minute. */
export function spent(seconds?: number) {
  if (!seconds || seconds < 60) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? `${count(hours, "hour")} ${count(rest, "minute")}`
    : count(hours, "hour");
}

/** The window: the places, its footer and the check of the project folders. */
export const shell = {
  name: "laci",
  nav: "Laci",
  home: "Home",
  projects: "Projects",
  helpers: "AI helpers",
  cleanup: "Clean up",
  activity: "Activity",
  settings: "Settings",
  help: "Help",
  needYou: (n: number) => `${count(n, "project")} ${n === 1 ? "needs" : "need"} you`,
  suggestions: (n: number) => count(n, "suggestion"),
  view: "View",
  simple: "Simple",
  detailed: "Detailed",
  simpleNow: "Simple view is on",
  detailedSwitch: "Switch to Detailed view",
  theme: "Theme",
  themes: { system: "Like the system", light: "Light", dark: "Dark" },
  upToDate: "Up to date",
  checking: "Checking…",
  checkFailed: "Couldn’t check",
  checkAgain: (status: string) =>
    `${status}. Check your project folders again`,
  checkedAt: (when: string) =>
    `Laci checked your project folders ${when}. It watches them and updates by itself.`,
  search: "Search",
  searchLabel: (keys: string) => `Search and actions (${keys})`,
  searchKey: withMod("K"),
};

/** The parts every screen is built from. */
export const blocks = {
  more: "More",
  moreFor: (what: string) => `More for ${what}`,
  showDetails: "Show details",
  hideDetails: "Hide details",
  close: "Close",
  cancel: "Cancel",
  info: (term: string) => `What “${term}” means`,
  countdown: (what: string, seconds: number) =>
    `${what} in ${count(seconds, "second")}.`,
  countdownHint: "Cancel or press Esc to stop it. Nothing happens before then.",
  cancelled: "Cancelled. Nothing changed.",
};

/** How safe a project is: the four tones, and each check in plain words. */
export const safety = {
  tones: { safe: "Safe", soon: "Soon", act: "Act now", fyi: "Good to know" },
  safe: "Safe",
  safeTitle: "Safe",
  safeOnline: (host: string) => `Saved as versions and uploaded to ${host}.`,
  safeHere: "Saved as versions, with an online copy.",
  noHistory: "No version history",
  noHistoryBody:
    "This folder has no version history, so Laci can’t keep versions of it. That is fine for notes.",
  /** Each check the engine raises, by its code: a short title, one sentence, and the ⓘ term. */
  issues: {
    "no-remote": {
      title: "Only on this computer",
      body: (versions: number) =>
        `${count(versions, "saved version")} ${versions === 1 ? "isn’t" : "aren’t"} online. If this computer breaks, ${versions === 1 ? "it’s" : "they’re"} gone.`,
      term: "online-copy",
    },
    "no-commits": {
      title: "Nothing saved yet",
      body: (files: number) =>
        files
          ? `${count(files, "file")} ${files === 1 ? "isn’t" : "aren’t"} in any saved version, so there is nothing to go back to.`
          : "There are no saved versions to go back to.",
      term: "saved-version",
    },
    dirty: {
      title: "Changes not saved as a version",
      body: (files: number) =>
        `${count(files, "file")} changed since the last saved version.`,
      term: "changes",
    },
    unpushed: {
      title: "Not uploaded yet",
      body: (versions: number) =>
        `${count(versions, "saved version")} only ${versions === 1 ? "exists" : "exist"} on this computer.`,
      term: "upload",
    },
    diverged: {
      title: "Out of sync",
      body: () =>
        "This computer and the online copy both have new versions. Uploading or downloading alone won’t fix it.",
      term: "out-of-sync",
    },
    stash: {
      title: "Changes set aside",
      body: (sets: number) =>
        `${count(sets, "set")} of changes ${sets === 1 ? "is" : "are"} put aside. ${sets === 1 ? "It is" : "They are"} easy to lose and never uploaded.`,
      term: "set-aside",
    },
    behind: {
      title: "Newer version online",
      body: (versions: number) =>
        `${count(versions, "saved version")} online ${versions === 1 ? "isn’t" : "aren’t"} on this computer yet.`,
      term: "upload",
    },
    "no-git": {
      title: "No version history",
      body: () => "Laci can’t keep versions until history is on.",
      term: "history",
    },
    "stale-cwd": {
      title: "AI chats point to an old place",
      body: () =>
        "Some AI chats still point to where this project used to be. Clean up can reconnect them.",
      term: "reconnect",
    },
  } as Record<
    string,
    { title: string; body: (n: number) => string; term: string } | undefined
  >,
  /** The button that fixes a check. "…" when it opens a sheet first. */
  fixes: {
    "no-remote": "Back up online…",
    "no-commits": "Save a first version…",
    dirty: "Save a version…",
    unpushed: "Upload…",
    diverged: "Ask AI to combine",
    stash: "Look at it…",
    "no-git": "Turn on history…",
    behind: "Download…",
  } as Record<string, string | undefined>,
  askAi: (ai: string) => `Ask ${ai} to do it`,
  askAnyAi: "Ask your AI to do it",
  reconnect: "Open Clean up",
  hide: "Don’t warn me here",
  hidden: "Hidden warnings",
  unhide: "Warn me again",
  hiddenNote: "You asked Laci not to warn about these here.",
  hiddenDone: "Laci won’t warn about this here",
  unhiddenDone: "Laci warns about this here again",
};

/** Home: the main card, Needs you, Pick up, Next up and Coming up. */
export const home = {
  greeting: (hour: number) =>
    hour < 5
      ? "Good evening"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening",
  /** The main card for a safety problem, by its code. */
  problems: {
    "no-remote": (name: string) => `${name} is only on this computer`,
    "no-commits": (name: string) => `${name} has nothing saved yet`,
    dirty: (name: string) => `${name} has changes not saved as a version`,
    unpushed: (name: string) => `${name} isn’t fully uploaded`,
    diverged: (name: string) => `${name} is out of sync`,
    stash: (name: string) => `${name} has changes set aside`,
    "no-git": (name: string) => `${name} has no version history`,
    behind: (name: string) => `${name} has a newer version online`,
  } as Record<string, ((name: string) => string) | undefined>,
  problem: (name: string) => `${name} needs a look`,
  backUp: (name: string) => `Back up ${name}…`,
  due: (name: string, days: number) =>
    days < 0
      ? `${name} is overdue by ${count(-days, "day")}`
      : `${name} is due today`,
  nextStep: (text: string) => `Next step: ${text}`,
  noNextStep: "There is no next step written down yet.",
  open: (name: string) => `Open ${name}`,
  safeTitle: "Everything is safe.",
  /** What makes it safe: the projects saved and online, and the ones with no version history. */
  safeBody: (projects: number, noHistory = 0) => {
    const bare = Math.min(noHistory, projects);
    const saved = projects - bare;
    const some = (n: number) =>
      n < projects
        ? count(n, "project")
        : n === 1
          ? "Your project"
          : `All ${n} projects`;
    return [
      saved
        ? `${some(saved)} ${saved === 1 ? "is" : "are"} saved and online.`
        : "",
      bare
        ? `${some(bare)} ${bare === 1 ? "has" : "have"} no version history.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  },
  continue: (name: string) => `Continue ${name}`,
  askAi: (ai: string) => `Ask ${ai} to do it`,
  notNow: "Not now",
  notNowDone: "Hidden until tomorrow",
  notNowNote: "It is back on Home tomorrow. Projects still shows it.",
  quietTitle: "Nothing else needs you today.",
  quietBody: (hidden: number) =>
    `You hid ${count(hidden, "reminder")} until tomorrow.`,
  showHidden: "Show them now",
  needsYou: "Needs you",
  seeAll: (n: number) => `See all ${n}`,
  pickUp: "Pick up where you left off",
  morePickUp: (n: number) => `Show ${count(n, "more project")}`,
  lastChange: (when: string) => `Last change ${when}`,
  lastChat: (title: string) => `Last chat: ${title}`,
  stillToDo: (text: string) => `Still to do: ${text}`,
  markDone: (text: string) => `Mark as done: ${text}`,
  continueChat: "Continue",
  nextUp: "Next up",
  planWeek: "Plan my week with AI…",
  doWithAi: "Do this with AI",
  doWithAiFor: (text: string) => `Do this with AI: ${text}`,
  inProject: (name: string) => `In ${name}`,
  noTodos: "Nothing to do next. Add a next step on a project’s page.",
  comingUp: "Coming up",
  copied: (when: string) => `AI chats copied ${when}`,
  notCopied: "AI chats aren’t copied yet",
  noFoldersTitle: "Where do you keep your projects?",
  noFoldersBody:
    "Pick the folder where you keep projects. Laci only reads it, and changes nothing until you ask.",
  chooseFolder: "Choose folder…",
  chooseTitle: "Choose the folder where you keep projects",
  addingFolder: "Adding the folder…",
  addedFolder: "Folder added",
  noProjectsTitle: "No projects yet",
  noProjectsBody:
    "Laci found no projects in your project folders. Start one, and it shows up here.",
};

/** Projects: the cards, search, filters and sorting. */
export const projects = {
  title: "Projects",
  newProject: "New project",
  search: "Search projects",
  show: "Show",
  filters: {
    all: "All",
    needs: "Needs you",
    active: "Active",
    archived: "Archived",
  },
  sort: "Sort",
  sortBy: (how: string) => `Sort: ${how}`,
  sorts: {
    recent: "Recently changed",
    name: "Name",
    due: "Due date",
    size: "Size",
  },
  inAll: "All folders",
  inLabel: (folder: string) => `In: ${folder}`,
  lastChange: (when: string) => `Last change ${when}`,
  noChange: "No changes yet",
  chats: (n: number) => count(n, "AI chat"),
  noDescription: "No description yet",
  priority: {
    high: "High priority",
    medium: "Medium priority",
    low: "Low priority",
  } as Record<string, string | undefined>,
  continueAi: "Continue with AI",
  showIn: (app: string) => `Show in ${app}`,
  archive: "Archive…",
  noneTitle: "No projects here",
  none: {
    all: "Laci found no projects in your project folders yet.",
    needs: "Nothing needs you. Every project is safe.",
    active: "No project changed in the last 14 days.",
    archived: "You haven’t archived a project yet.",
  },
  noMatch: (query: string) => `No project matches “${query}”.`,
  clearSearch: "Clear the search",
  shown: (n: number) => count(n, "project"),
};

/** A project's own page, and its cards. */
export const project = {
  back: "Projects",
  none: "This project isn’t here any more",
  noneBody: "It may have moved or been deleted. Activity shows what changed.",
  status: {
    active: "Active",
    idle: "Quiet",
    dormant: "Inactive",
    archived: "Archived",
    paused: "Paused",
    done: "Done",
    idea: "Idea",
  } as Record<string, string | undefined>,
  setByLaci: "set by Laci",
  statusBy: (status: string) => `${status}, set by Laci`,
  continueAi: "Continue with AI",
  continueLast: "Continue the last chat",
  newChat: (ai: string) => `New chat with ${ai}`,
  options: "Choose the AI and options…",
  openIn: (app: string) => `Open in ${app}`,
  moreActions: "More actions",
  archive: "Archive…",
  delete: "Delete project…",
  freeSpace: "Free up space here…",
  terminal: "Open terminal here",
  copy: "Copy location",
  copied: "Location copied",
  showIn: (app: string) => `Show in ${app}`,
  detailed: "Open in Detailed view",
  safe: {
    title: "Is it safe?",
    allGood: "Nothing here can be lost.",
    line: "Line of work",
    online: "Online copy",
    noOnline: "None. It is only on this computer.",
    lastVersion: "Last saved version",
    noVersion: "None yet",
    changed: "Changed files",
    changedMore: (n: number) => `and ${count(n, "more file")}`,
    notUploaded: "Saved versions not uploaded",
    recent: "Recent saved versions",
    setAside: "Changes set aside",
    noDetails: "Laci couldn’t read the details just now.",
    loading: "Reading the details…",
    moreFor: (title: string) => `More for “${title}”`,
    tags: {
      M: "edited",
      A: "added",
      D: "deleted",
      R: "renamed",
      "??": "new",
    } as Record<string, string | undefined>,
  },
  todo: {
    title: "To-do",
    add: "Add a next step",
    addPlaceholder: "Add a next step…",
    addButton: "Add",
    delete: (text: string) => `Delete: ${text}`,
    handover: "Hand-over notes",
    handoverFrom: (file: string, when: string) => `${file}, changed ${when}`,
    more: (n: number) => `and ${count(n, "more")}`,
    done: (n: number) => `${count(n, "done item")}`,
    notes: "Notes for future you",
    notesHint:
      "What were you in the middle of? What should the next AI chat know?",
    empty: "No to-dos yet.",
  },
  chats: {
    title: "AI chats",
    seeAll: "See all in AI helpers",
    by: (ai: string, when: string) => `${ai}, ${when}`,
    messages: (n: number) => count(n, "message"),
    files: (n: number) => `${count(n, "file")} changed`,
    quick: (n: number) => `and ${count(n, "quick chat")}`,
    continue: "Continue",
    continueFor: (title: string) => `Continue: ${title}`,
    read: "Read",
    readFor: (title: string) => `Read: ${title}`,
    emptyTitle: "No AI chats yet",
    emptyBody: "Chats with your AI about this project show up here.",
    start: "Start a chat",
  },
  about: {
    title: "About",
    builtWith: "Built with",
    size: "Size",
    sizeFree: (total: string, free: string) =>
      `${total}, of which ${free} can be freed`,
    lastChange: "Last change",
    location: "Location",
    read: "Read description",
    noReadme: "No description yet.",
    askSummary: "Ask AI to write a description",
    summaryPrompt:
      "Read this project's README, package files and recent commits. Save a two-sentence project summary under ## Summary in .laci.md. Change nothing else.",
    remoteImages: (n: number) =>
      `${count(n, "picture")} from the web ${n === 1 ? "isn’t" : "aren’t"} shown.`,
    loadImages: "Show pictures",
    linkBlocked: "A description can open web, mail and project links only",
    loading: "Reading the description…",
    opened: "Opened",
  },
  recent: {
    title: "Recent changes",
    undo: "Undo",
    undoThis: (title: string) => `Undo: ${title}`,
    undone: "Undone",
    you: "You",
    byAi: "Your AI",
    empty: "No changes yet. What you or your AI change here shows up in Activity.",
    loading: "Reading Activity…",
    failed: "Laci couldn’t read Activity just now.",
    all: "See all in Activity",
  },
};

/** Fixing a safety check: the sheet that checks for secrets first, then hands over. */
export const fix = {
  titles: {
    "no-remote": (name: string) => `Back up ${name} online`,
    "no-commits": (name: string) => `Save a first version of ${name}`,
    dirty: (name: string) => `Save a version of ${name}`,
    unpushed: (name: string) => `Upload ${name}`,
    "no-git": (name: string) => `Turn on history for ${name}`,
    diverged: (name: string) => `Combine the versions of ${name}`,
    stash: (name: string) => `Look at the changes set aside in ${name}`,
    behind: (name: string) => `Download the newer version of ${name}`,
  } as Record<string, ((name: string) => string) | undefined>,
  intros: {
    "no-remote":
      "Laci makes a private copy on GitHub and uploads your saved versions to it. Only you can see a private copy.",
    "no-commits":
      "A saved version is a snapshot of every file, so you can go back to it later.",
    dirty:
      "Saving a version keeps today’s changes in the history, so you can go back to them later.",
    unpushed:
      "Uploading sends your saved versions to the online copy, so they are safe if this computer breaks.",
    "no-git":
      "History lets Laci keep versions of this project. Nothing is uploaded.",
    diverged:
      "Your AI can combine both sets of versions. It shows each command first and never forces an upload.",
    stash:
      "Changes set aside are easy to forget. Look at them, then keep them or let your AI help.",
    behind:
      "The online copy has saved versions this computer doesn’t have yet. Downloading brings them here.",
  } as Record<string, string | undefined>,
  secretsTitle: "Files that look like passwords or keys",
  checking: "Looking for files that look like passwords or keys…",
  clean: "No files that look like passwords or keys.",
  found:
    "These files look like passwords or keys. Keep them out of saved versions:",
  tracked:
    "These files look like passwords or keys, and they are already in a saved version:",
  trackedNext:
    "Ask your AI for help first. Taking a file out of the history needs care.",
  more: (n: number) => `and ${count(n, "more file")}`,
  keepOut: "Keep these out",
  keeping: "Keeping them out…",
  keptOut: "Kept out of saved versions",
  failed: "Laci couldn’t look for secret files.",
  tryAgain: "Try again",
  askAi: (ai: string) => `Ask ${ai} to do it`,
  askAnyAi: "Ask your AI to do it",
  recommended: "Recommended",
  aiNote:
    "Your AI shows each command first and checks for secret files again. It never forces an upload or deletes a line of work.",
  myself: "Do it myself in the terminal",
  myselfFor: {
    stash: "Look at it in the terminal",
    behind: "Download in the terminal",
  } as Record<string, string | undefined>,
  myselfNote:
    "Laci types the command in the terminal. Read it, then press Enter there to run it.",
  blocked: "Keep the files above out first.",
  blockedTracked: "Ask your AI first.",
  blockedFailed: "Laci needs to look for secret files first.",
  noAi: "Connect an AI tool in AI helpers to let it do this.",
  whatChanged: "See what changed",
  started: "The command is ready in the terminal",
  startedHint: "Read it, then press Enter to run it.",
};

/** Places that arrive in the next build: for now, a calm card and a way to Detailed view. */
export const later = {
  titles: {
    helpers: "AI helpers",
    cleanup: "Clean up",
    activity: "Activity",
    settings: "Settings",
  },
  bodies: {
    helpers:
      "Your AI chats, the summaries your AI writes and the AI tools Laci knows will be here.",
    cleanup:
      "Suggestions that free up space and tidy your AI history, one at a time, will be here.",
    activity: "Every change by you or your AI, with Undo, will be here.",
    settings: "Your project folders, apps and how Laci looks will be here.",
  },
  soon: "This part comes in the next build of Simple view. Until then, Detailed view has all of it.",
  open: "Open in Detailed view",
};

export interface Term {
  id: string;
  /** What Simple calls it. */
  term: string;
  /** Other words Simple uses for it, if any. */
  also?: string;
  /** What the ⓘ says. It names the Git term where there is one. */
  info: string;
  /** The word Detailed and the AI use. */
  was: string;
}

/** Words Laci uses (design-research §3.4): the vocabulary Help lists and every ⓘ explains. */
export const glossary: Term[] = [
  {
    id: "online-copy",
    term: "Online copy",
    also: "Only on this computer",
    info: "A copy of the project on GitHub or a similar site. Without one, a broken computer means the work is gone. (Git: remote)",
    was: "Remote, no remote",
  },
  {
    id: "saved-version",
    term: "Saved version",
    also: "Nothing saved yet",
    info: "A snapshot you can go back to. With none yet, there is nothing to go back to. (Git: commit)",
    was: "Commit, no commits yet",
  },
  {
    id: "changes",
    term: "Changes not saved as a version",
    info: "Files changed since the last saved version. They are on disk, but not in the history. (Git: uncommitted changes)",
    was: "Uncommitted changes",
  },
  {
    id: "upload",
    term: "Upload, download",
    also: "Not uploaded yet, Newer version online",
    info: "Send saved versions to your online copy, or get them from it. (Git: push, pull, ahead, behind)",
    was: "Push, pull, unpushed",
  },
  {
    id: "out-of-sync",
    term: "Out of sync",
    info: "This computer and the online copy both have new versions. Uploading or downloading alone won’t fix it; your AI can combine them. (Git: diverged)",
    was: "Diverged",
  },
  {
    id: "set-aside",
    term: "Changes set aside",
    info: "Changes put aside to finish later. Easy to lose, never uploaded. (Git: stash)",
    was: "Stash",
  },
  {
    id: "history",
    term: "Version history",
    also: "Turn on history",
    info: "Laci can’t keep versions until history is on. (Git: git init)",
    was: "No Git, start tracking",
  },
  {
    id: "line-of-work",
    term: "Line of work",
    info: "A separate line of saved versions; main is the usual one. (Git: branch)",
    was: "Branch, upstream, HEAD",
  },
  {
    id: "copy-from-link",
    term: "Copy from a link",
    info: "Download a project from GitHub or another site. (Git: clone)",
    was: "Clone",
  },
  {
    id: "safety",
    term: "Safety",
    also: "Act now, Soon, Good to know",
    info: "How safe your work is. Act now: you could lose work. Soon: worth doing this week. Good to know: nothing is at risk. Each has its own icon and words, not only a colour.",
    was: "Health, checks, severity",
  },
  {
    id: "hidden-warning",
    term: "Hidden warning",
    info: "You asked Laci not to warn about this here. Show details lists them, so you can turn them back on.",
    was: "Muted check",
  },
  {
    id: "project-folders",
    term: "Project folders",
    also: "Check again",
    info: "Laci only reads these folders. It changes nothing until you ask.",
    was: "Scan roots, Places, Scan again",
  },
  {
    id: "status",
    term: "Active, Quiet, Inactive",
    also: "set by Laci",
    info: "Active: changed in the last 14 days. Quiet: 15 to 60 days. Inactive: over 60 days. Laci sets it unless you choose one.",
    was: "Status: active, idle, dormant, auto",
  },
  {
    id: "notes-file",
    term: "Laci notes file",
    also: "Has Laci notes",
    info: "A small file in the project with your status, due date, to-dos and notes. It moves with the project and stays out of the history. (File: .laci.md)",
    was: ".laci.md, Uses laci",
  },
  {
    id: "packages",
    term: "Downloaded packages and build files",
    also: "Free up space",
    info: "Your tools can make these again. Removing them frees space; the next install or build brings them back. You need the internet to install again. (node_modules, build output)",
    was: "node_modules, build output, Free space",
  },
  {
    id: "archive",
    term: "Archive",
    info: "Moves the project, with its AI chats, to your archive folder. Undo any time in Activity.",
    was: "Archive",
  },
  {
    id: "trash",
    term: `Move to ${TRASH}`,
    info: `Laci can’t undo this. Restore it from the ${TRASH}.`,
    was: "Move to Trash",
  },
  {
    id: "activity",
    term: "Activity",
    also: "undo record",
    info: "Every change by you or your AI, with Undo.",
    was: "Log, journal",
  },
  {
    id: "changed-later",
    term: "Can’t undo: changed again later",
    info: "Something changed it after this. Undo the newer change first.",
    was: "Changed since",
  },
  {
    id: "kept-for-undo",
    term: "Kept for Undo",
    info: "Deleted AI chats kept so you can undo. Empty it to free the space for good.",
    was: "Quarantine",
  },
  {
    id: "leftover",
    term: "Leftover AI chats",
    info: "AI chats whose project folder no longer exists.",
    was: "Orphan, orphaned",
  },
  {
    id: "reconnect",
    term: "Reconnect AI chats",
    also: "unfinished move, old location",
    info: "A folder moved, but its AI chats still point to the old place.",
    was: "Reconnect, half-done move, former location",
  },
  {
    id: "same-twice",
    term: "Same project twice",
    info: "Two folders that hold the same project.",
    was: "Duplicates",
  },
  {
    id: "sure",
    term: "Sure, Likely, Check first",
    info: "How sure Laci is that a suggestion is right.",
    was: "Confidence high, med, low",
  },
  {
    id: "hide-90",
    term: "Hide for 90 days",
    info: "Laci stops suggesting it for 90 days.",
    was: "Dismiss",
  },
  {
    id: "in-use",
    term: "In use",
    also: "Laci is finishing another change",
    info: "A program, such as an AI chat or a dev server, is working in this folder. Close it, then try again.",
    was: "Busy folder, lock",
  },
  {
    id: "ai",
    term: "AI, chat",
    also: "Quick chats, helper chat",
    info: "An AI tool such as Claude Code or Codex, and one conversation with it. Quick chats are short ones that changed no file.",
    was: "Agent, session, conversation, short chats, subagent log",
  },
  {
    id: "continue",
    term: "Continue",
    also: "Do this with AI, Plan my week with AI",
    info: "Pick up an AI chat where it stopped, start one for a to-do, or go through everything open with your AI.",
    was: "Resume, Work on it, Review with an agent",
  },
  {
    id: "memory",
    term: "What the AI remembers",
    also: "AI plans",
    info: "Notes and plans an AI tool keeps for a project between chats.",
    was: "Memory, plans",
  },
  {
    id: "summary",
    term: "Summary",
    also: "Still to do, Done, Not needed",
    info: "A short note your AI writes at the end of a chat, with what is still to do.",
    was: "Report, open items, close: done, dropped",
  },
  {
    id: "handover",
    term: "Hand-over notes",
    info: "A file like HANDOFF.md or TODO.md that lists what to do next.",
    was: "Handoff",
  },
  {
    id: "tool-link",
    term: "AI tool link",
    also: "built-in, your own",
    info: "Tells Laci where an AI tool keeps its chats, so they show on the right project and move with it.",
    was: "Connector, preset, custom",
  },
  {
    id: "showing-chats",
    term: "Showing its chats",
    info: "Laci shows this AI tool’s chats on your projects.",
    was: "Connected, connect",
  },
  {
    id: "can-use-laci",
    term: "Can use Laci",
    also: "Yes, Not yet, Uses another Laci, Turned off",
    info: "Lets your AI ask Laci about projects and move them safely; its changes appear in Activity. (MCP server)",
    was: "MCP server: set up, not set up, points elsewhere, switched off",
  },
  {
    id: "cant-start",
    term: "Installed, but Laci can’t start it",
    info: "The AI tool is on this computer, but Laci can’t find its program. Help shows how to fix it. (Not on PATH)",
    was: "Not on PATH",
  },
  {
    id: "thinking",
    term: "Model, thinking effort",
    info: "Which AI model a tool uses, and how long it thinks before it answers. Both are under Options.",
    was: "Model, effort",
  },
  {
    id: "copy-chats",
    term: "Copy AI chats",
    also: "only in Laci’s copy, AI chats without a project",
    info: "Claude Code deletes chats after 30 days by default. Laci keeps a copy on this computer.",
    was: "Back up logs, backup only, detached history",
  },
  {
    id: "kept",
    term: "Kept",
    info: "Laci won’t suggest cleaning it up.",
    was: "Kept (session)",
  },
  {
    id: "terminal",
    term: "Terminal",
    also: "Laci’s terminal, my terminal app",
    info: "A window where commands run. AI chats open in Laci’s own terminal or in your terminal app.",
    was: "Terminal, terminal target",
  },
  {
    id: "search",
    term: "Search and actions",
    info: `One search box for every project, chat and action. Open it with ${withMod("K")}.`,
    was: "Command palette",
  },
  {
    id: "diagnostics",
    term: "Diagnostics log",
    info: "A technical record of what Laci did. It helps when you report a problem.",
    was: "Debug log",
  },
];

/** The glossary entry with this id. */
export const termOf = (id: string) => glossary.find((t) => t.id === id);

/** The glossary entries with every word of `query` in them: Help's "Find a word". */
export function findTerms(query: string, terms: readonly Term[] = glossary) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...terms];
  return terms.filter((t) => {
    const text = `${t.term} ${t.also ?? ""} ${t.info} ${t.was}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Help, in both designs. */
export const help = {
  title: "Help",
  intro:
    "Laci keeps your projects in one place, with their AI chats. Here is how it keeps your work safe, the words it uses, and its keys.",
  safeTitle: "How Laci keeps your work safe",
  safe: [
    "Laci only reads your project folders. It changes nothing until you ask.",
    "Every change, by you or by your AI, is listed in Activity. Most can be undone there.",
    "Archive comes before deleting. An archived project keeps its AI chats and can come back.",
    `What can’t be undone, like moving a project to the ${TRASH}, waits 5 seconds first, so you can cancel.`,
    "Before a first saved version or an upload, Laci looks for files that look like passwords or keys, so they stay off the internet.",
    "When you ask your AI to fix something, Laci asks it to show each command first, and never to force an upload, rewrite the history or delete a line of work.",
    "What Laci learns about your projects stays on this computer.",
  ],
  wordsTitle: "Words Laci uses",
  wordsIntro:
    "Laci uses plain words. Your AI may use the Git words, so each one is listed too.",
  wordsWas: (was: string) => `Also called: ${was}.`,
  find: "Find a word",
  noTerm: (query: string) => `No word matches “${query}”.`,
  keysTitle: "Keyboard shortcuts",
  keysIntro: "Every button also works with Tab and Enter.",
  reportTitle: "Report a problem",
  reportBody:
    "Tell us what happened and what you expected. Leave out passwords and private files.",
  reportLink: "Open Laci’s list of problems on GitHub",
  reportUrl: "https://github.com/mrramdn/laci/issues",
  done: "Done",
};

/**
 * Simple and Detailed, and the ways between them: the toggle at the foot of both sidebars, Search
 * and actions, Settings › Appearance, and the card that offers Simple to someone who set Laci up
 * before it had two designs. The words Simple's own toggle and theme menu use come from `shell`,
 * so both designs say them the same way.
 */
export const views = {
  names: { simple: shell.simple, detailed: shell.detailed },
  /** What each design is, beside its picture. */
  about: {
    simple: "Calm and guided, in plain words.",
    detailed: "Everything at once: paths, version details and long lists.",
  },
  recommended: "Recommended",
  shown: "Shown now",
  switchTo: {
    simple: "Switch to Simple view",
    detailed: shell.detailedSwitch,
  },
  /** Said where a design is chosen. */
  anyTime: "You can switch any time at the bottom of the sidebar.",
  appearance: "Appearance",
  appearanceIntro: "How Laci looks. A change here shows at once and needs no saving.",
  view: shell.view,
  theme: shell.theme,
  themes: shell.themes,
  offerTitle: "New: Simple view",
  offerBody:
    "The same projects, AI chats and Undo, in a calmer layout with plain words.",
  offerTry: "Try Simple view",
  offerNo: "No thanks",
};

/**
 * The first-run screen, in both designs: its welcome, the two questions after the folders, the AI
 * tools and the apps, and what this computer needs first. A program to install is named by the
 * caller, as the system's own words are, so the words around it stay plain.
 */
export const firstRun = {
  welcome: "Welcome to Laci",
  start: "Start using Laci",
  lookTitle: "How should Laci look?",
  updatesTitle: "New versions of Laci",
  /** What a check sends, in one sentence. */
  updatesSends:
    "A check only asks GitHub which version is newest: like any visit to a website it shows your internet address, and it sends nothing about your projects.",
  updates: {
    daily: "Look for new versions once a day",
    off: "Don’t look for new versions",
  },
  updatesNotes: {
    daily:
      "Recommended. Laci tells you when one is ready, and installs nothing until you choose to.",
    off: "Laci won’t look by itself.",
  },
  updatesFailed: "Laci couldn’t save your choice about new versions",
  folderAccessTitle: "macOS asks first",
  folderAccess:
    "The first time Laci looks in Documents, Desktop, Downloads or a drive, macOS asks whether it may. Choose Allow, so Laci can find your projects there. You can change it later in System Settings, under Privacy & Security, then Files and Folders.",
  moveTitle: "Move Laci to Applications",
  moveBody:
    "Laci is running from where it was downloaded. Move it to the Applications folder and open it from there, so your AI tools can always find it.",
  installTitle: (program: string) => `Install ${program}`,
  installBody: (program: string) =>
    `Laci reads the saved versions of your projects with ${program}, a free program that isn’t on this computer yet.`,
  /** Followed by the line to type. */
  installMac:
    "macOS installs it with Apple’s command line tools. Open Terminal, type this line and press Enter:",
  installLink: "How to install it",
};

/** Search and actions (Ctrl K, ⌘K on a Mac) in Simple: its groups, its actions and its hints. */
export const search = {
  label: "Search and actions",
  placeholder: (summaries: boolean) =>
    summaries
      ? "Search projects, AI chats, summaries, to-dos and actions…"
      : "Search projects, AI chats, to-dos and actions…",
  groups: {
    projects: "Projects",
    folders: "Folders",
    chats: "AI chats",
    summaries: "Summaries",
    todos: "To-dos",
    actions: "Actions",
  },
  actions: {
    home: "Go to Home",
    projects: "Go to Projects",
    helpers: "Go to AI helpers",
    cleanup: "Go to Clean up",
    activity: "Go to Activity",
    settings: "Go to Settings",
    help: "Help and keyboard shortcuts",
    newProject: "New project",
    checkAgain: "Check your project folders again",
    theme: "Switch between light and dark",
  },
  none: "Nothing matches your search.",
  hints: { open: "Open", move: "Move", close: "Close" },
};

/** Clean up: what Laci suggests tidying, one suggestion at a time, and the space Laci uses itself. */
export const cleanup = {
  title: "Clean up",
  lead: "Laci shows every change before it happens, and makes one change at a time.",
  couldFree: (size: string) => `Could free ${size}`,
  tilesLabel: "What there is to clean up",
  tiles: {
    history: "Fix AI history",
    space: "Free up space",
    archive: "Archive old projects",
    leftover: "Leftover AI chats",
    twice: "Same project twice",
    laci: "Space Laci uses",
  },
  tileCount: (n: number) => count(n, "suggestion"),
  tileReading: "Reading…",
  suggestions: "Suggestions",
  review: "Review",
  sure: { high: "Sure", med: "Likely", low: "Check first" } as Record<
    string,
    string | undefined
  >,
  canUndo: "Can be undone",
  forGood: "Deleted for good",
  leftAlone: "Laci changes nothing",
  whatChanges: "What will change",
  moreFor: (title: string) => `More for “${title}”`,
  open: (name: string) => `Open ${name}`,
  hide: "Hide for 90 days",
  hidden: "Hidden for 90 days",
  hiddenNote: "Laci won’t suggest it again for 90 days.",
  hiddenList: (n: number) => count(n, "hidden suggestion"),
  suggestAgain: "Suggest again",
  suggestAgainFor: (title: string) => `Suggest again: ${title}`,
  suggestedAgain: "Laci suggests it again",
  checking: "Laci is looking again after the last change…",
  emptyTitle: "Nothing to clean up",
  emptyBody:
    "Your AI chats point to the right folders, and nothing takes up space for no reason. Laci keeps watching.",
  /** AI chats that still point to where a project used to be. */
  reconnect: {
    title: (name: string) => `Reconnect the AI chats of ${name}`,
    titleAny: "Reconnect AI chats",
    why: (name: string) =>
      `${name} moved, but some of its AI chats still point to the old folder, so your AI can’t find them.`,
    unsure: (name: string) =>
      `No folder is at the old place any more. ${name} has the same name, so these AI chats probably belong to it.`,
    whyAny:
      "A folder moved, but some of its AI chats still point to the old place, so your AI can’t find them.",
    button: "Reconnect",
    doing: "Reconnecting the AI chats…",
    done: "AI chats reconnected",
  },
  /** Folders that moved while their AI chats still name the old place. */
  migration: {
    title: (moves: number) => `Finish ${count(moves, "unfinished move")}`,
    why: "These folders moved, but their AI chats still name the old place, so search and the next move would get them wrong.",
    button: (moves: number) =>
      moves === 1 ? "Finish the move" : "Finish the moves",
    doing: "Finishing the moves…",
    done: "Moves finished",
  },
  /** Downloaded packages and build files in projects nobody works on any more. */
  space: {
    title: (size: string, where: string) => `Free ${size} in ${where}`,
    titleAny: "Free up space",
    projects: (n: number) => count(n, "project"),
    why: "Downloaded packages and build files in projects you haven’t used for a while. They are deleted for good: the next install or build brings them back, and that needs the internet.",
    button: (size: string) => `Free ${size}…`,
    buttonAny: "Free up space…",
    counting: (size: string) => `Freeing ${size}`,
    countingAny: "Freeing space",
    doing: (size: string) => `Freeing ${size}…`,
    doingAny: "Freeing space…",
    done: (size: string) => `Freed ${size}`,
    doneAny: "Space freed",
  },
  /** Projects nobody has changed for a long time. */
  archive: {
    title: (name: string) => `Archive ${name}`,
    titleAny: "Archive an old project",
    why: (name: string, when: string) => `${name} last changed ${when}.`,
    never: (name: string) => `Laci has never seen ${name} change.`,
    what: "Archiving moves it, with its AI chats, to your archive folder. Undo any time in Activity.",
    button: (name: string) => `Archive ${name}…`,
    buttonAny: "Archive…",
  },
  /** AI chats whose project folder is gone. */
  leftover: {
    title: (names: string) => `AI chats left from ${names}`,
    titleAny: "Leftover AI chats",
    why: (names: string, folders: number) =>
      `${names} no longer ${folders === 1 ? "exists" : "exist"}, so these AI chats belong to no project.`,
    whyAny:
      "Their project folder no longer exists, so these AI chats belong to no project.",
    aside:
      "Setting them aside moves them to Kept for Undo, so Undo can bring them back.",
    button: "Set aside",
    doing: "Setting the AI chats aside…",
    done: "AI chats set aside",
    trash: `Move to the ${TRASH} instead…`,
    trashCounting: `Moving these AI chats to the ${TRASH}`,
    trashDoing: `Moving the AI chats to the ${TRASH}…`,
    trashDone: `AI chats moved to the ${TRASH}`,
    blockedTitle: "AI chats Laci can’t check",
    blocked:
      "Laci can’t confirm that their project folder is gone, so it leaves them alone.",
  },
  /** One project in two folders. */
  twice: {
    title: (name: string, places: number) =>
      `${name} is in ${count(places, "place")}`,
    titleAny: "Same project twice",
    why: "These folders hold the same project, so one is probably an old copy. Laci can’t tell which one you use, so it changes nothing: open both and decide.",
  },
  /** The space Laci uses itself, from the `storage` request. */
  laci: {
    title: "Space Laci uses",
    total: (size: string) => `${size} in all`,
    reading: "Reading the space Laci uses…",
    failed: "Laci couldn’t read how much space it uses.",
    tryAgain: "Try again",
    where: "Where it is",
    none: "Empty",
    freeable: (size: string) =>
      `${size} can be freed. This can’t be undone.`,
    freed: (size: string) => `Freed ${size}`,
    /** Each part, by its id: its name, what it is, and for the parts Laci can empty, the button. */
    parts: {
      removed: {
        label: "Kept for Undo",
        about:
          "AI chats you deleted or set aside, kept so Undo can bring them back. Emptying it makes those deletions final.",
        button: "Empty Kept for Undo…",
        counting: "Emptying Kept for Undo",
        term: "kept-for-undo",
      },
      undo: {
        label: "Old undo records",
        about:
          "Copies Laci made before it moved projects. Those older than a week can go, and those moves can then no longer be undone.",
        button: "Remove the old records…",
        counting: "Removing the old undo records",
      },
      legacy: {
        label: "Leftovers from Laci 1",
        about:
          "Files the first Laci left in its settings folder. This Laci doesn’t read them.",
        button: "Remove the leftovers…",
        counting: "Removing the leftovers of Laci 1",
      },
      history: {
        label: "Copy of AI chats",
        about:
          "Laci’s own copy of your AI chats, so a tool that deletes old chats can’t lose them. Laci never removes anything from it.",
        term: "copy-chats",
      },
      journal: {
        label: "Undo records and Activity",
        about: "What Undo needs to know about each change.",
      },
      cache: {
        label: "Saved check results",
        about: "Laci makes these again the next time it checks your folders.",
      },
    } as Record<
      string,
      | {
          label: string;
          about: string;
          button?: string;
          counting?: string;
          term?: string;
        }
      | undefined
    >,
  },
};

/** Activity: every change by you or your AI, one sentence each, with Undo. */
export const activity = {
  title: "Activity",
  lead: "Every change by you or your AI. Most can be undone here.",
  undo: (what: string) => `Undo: ${what}`,
  undoButton: "Undo",
  undoing: "Undoing…",
  undone: "Undone",
  show: "Show",
  filters: { all: "All", mine: "By me", ai: "By AI", undo: "Can be undone" },
  search: "Search Activity",
  who: { you: "You", ai: "Your AI", laci: "Laci, by itself" },
  by: (who: string, when: string) => `${who}, ${when}`,
  /** A day's heading: "Today", "Yesterday", else the weekday and the date, the month in full. */
  day: (at: string, now = Date.now()) => {
    const day = new Date(at);
    const back = daysBetween(day, new Date(now));
    if (back === 0) return "Today";
    if (back === 1) return "Yesterday";
    return day.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(day.getFullYear() === new Date(now).getFullYear()
        ? {}
        : { year: "numeric" }),
    });
  },
  changedLater: "Can’t undo: changed again later",
  showNewer: "Show the newer change",
  didNotFinish: "Didn’t finish",
  whatChanged: "What changed",
  more: "More",
  diagnostics: "Open the diagnostics log",
  reading: "Reading Activity…",
  failed: "Laci couldn’t read Activity just now.",
  tryAgain: "Try again",
  emptyTitle: "Nothing changed yet",
  emptyBody: "Every change by you or your AI shows up here, with Undo.",
  noneTitle: "Nothing to show",
  none: {
    all: "Nothing changed yet.",
    mine: "You haven’t changed anything yet.",
    ai: "Your AI hasn’t changed anything yet.",
    undo: "Nothing here can be undone now.",
  },
  noMatch: (query: string) => `No change matches “${query}”.`,
  clearSearch: "Clear the search",
  showAll: "Show all",
};
