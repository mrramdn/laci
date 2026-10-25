// Every word Simple shows, by area, so the wording can be read, changed and later translated in one
// place. Detailed keeps its own words; Help, shared by both, takes its words from here too.
//
// Writing rules (design-research §3.4): plain words with the Git term one ⓘ away, sentence case,
// times in words ("23 minutes ago", never "23 min"), and no idioms, so the text translates well.
// Pure: it imports nothing, so the tests read it as it is.

/** "1 project", "2 projects"; `many` for words that don't just take an s. */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A big number with its thousands apart: "1,785". */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

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
  /** The check of the project folders, at the foot of the sidebar and of Home: never of Laci's version. */
  upToDate: "Projects checked",
  checking: "Checking projects…",
  checkFailed: "Couldn’t check projects",
  checkAgain: (status: string) =>
    `${status}. Check your project folders again`,
  checkedAt: (when: string) =>
    `Laci checked your project folders ${when}. It watches them and updates by itself.`,
  search: "Search",
  searchLabel: (keys: string) => `Search and actions (${keys})`,
  searchKey: "Ctrl K",
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
  groupBy: "Group by folder",
  noGroup: "Not in a group",
  groupCount: (n: number) => `· ${count(n, "project")}`,
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
    /** What the list leaves out: the chats past the first few, and the quick ones. */
    rest: (more: number, quick: number) =>
      `and ${[more ? count(more, "more chat") : "", quick ? count(quick, "quick chat") : ""].filter(Boolean).join(" and ")}`,
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
    term: "Move to Trash",
    info: "Laci can’t undo this. Restore it from the Trash.",
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
    info: "Claude Code deletes chats after 30 days by default. Laci keeps a copy, packed small, in its own folder or in one you choose.",
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
    info: `One search box for every project, chat and action. Open it with Ctrl K.`,
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
    "What can’t be undone, like moving a project to the Trash, waits 5 seconds first, so you can cancel.",
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
  /** On that card, under `updatesSends`: what checking does and doesn't do, as `updatesNotes.daily` says it. */
  updatesNoInstall:
    "Laci tells you when a new version is ready, and installs nothing until you choose to.",
  /**
   * The card that asks the same question once of a setup from before 3.0, whose config.json has no
   * choice yet: on Detailed's Today and Simple's Home, under `updatesTitle`, `updatesSends` and
   * `updatesNoInstall`.
   */
  updatesAsk: {
    daily: "Check daily",
    off: "Don’t check",
  },
  /** After a choice on that card, below what Settings says once a choice is saved. */
  updatesLater: "You can change it in Settings.",
  installTitle: (program: string) => `Install ${program}`,
  installBody: (program: string) =>
    `Laci reads the saved versions of your projects with ${program}, a free program that isn’t on this computer yet.`,
  installLink: "How to install it",
};

/** Search and actions (Ctrl K) in Simple: its groups, its actions and its hints. */
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
    trash: "Move to the Trash instead…",
    trashCounting: "Moving these AI chats to the Trash",
    trashDoing: "Moving the AI chats to the Trash…",
    trashDone: "AI chats moved to the Trash",
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
    /** The total once the copy of AI chats is kept in a folder of its own, where it isn't counted. */
    totalOwn: (size: string) => `${size} in all, without the copy of AI chats`,
    reading: "Reading the space Laci uses…",
    failed: "Laci couldn’t read how much space it uses.",
    tryAgain: "Try again",
    where: "Where it is",
    /** Where the copy of AI chats is, under its row. */
    keptIn: (dir: string) => `In ${dir}`,
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
          "Laci’s own copy of your AI chats, packed to take little space, so a tool that deletes old chats can’t lose them. It can be in any folder, also on another drive. Laci never removes anything from it.",
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
  /**
   * Each kind of change as one sentence, for its row, its Undo and the filled button. The engine's
   * own title, in Detailed's words, waits behind What changed.
   */
  changes: {
    undid: (what: string) => `Undid: ${what}`,
    undidAny: "Undid a change",
    settings: "Changed settings",
    status: (name: string, status: string) => `Set the status of ${name} to ${status}`,
    statusByLaci: (name: string) => `Let Laci set the status of ${name}`,
    priority: (name: string, priority: string) =>
      `Set the priority of ${name} to ${priority}`,
    priorities: { high: "high", medium: "medium", low: "low" } as Record<
      string,
      string | undefined
    >,
    noPriority: (name: string) => `Removed the priority of ${name}`,
    due: (name: string, day: string) => `Set the due date of ${name} to ${day}`,
    noDue: (name: string) => `Removed the due date of ${name}`,
    hidWarning: (name: string) => `Hid a warning about ${name}`,
    warnAgain: (name: string) => `Asked Laci to warn about ${name} again`,
    hiddenWarnings: (name: string) => `Changed the hidden warnings of ${name}`,
    addedStep: (name: string) => `Added a next step to ${name}`,
    ticked: (name: string) => `Ticked a to-do in ${name}`,
    unticked: (name: string) => `Unticked a to-do in ${name}`,
    editedTodo: (name: string) => `Edited a to-do in ${name}`,
    deletedStep: (name: string) => `Deleted a next step from ${name}`,
    notes: (name: string) => `Edited the notes of ${name}`,
    showsChats: (ai: string) => `Laci shows the chats of ${ai}`,
    hidesChats: (ai: string) => `Laci no longer shows the chats of ${ai}`,
    addedTool: (ai: string) => `Added ${ai}`,
    removedTool: (ai: string) => `Removed ${ai}`,
    closedItem: (summary: string) => `Closed an item of the summary “${summary}”`,
    openedItem: (summary: string) =>
      `Opened an item of the summary “${summary}” again`,
    keptOut: (files: number, name: string) =>
      `Kept ${count(files, "file")} of ${name} out of saved versions`,
    archived: (name: string) => `Archived ${name}`,
    moved: (name: string) => `Moved ${name}`,
    reconnected: (name: string) => `Reconnected the AI chats of ${name}`,
    finishedMoves: (moves: number) => `Finished ${count(moves, "unfinished move")}`,
    freed: (size: string, projects: number) =>
      `Freed ${size} in ${count(projects, "project")}`,
    freedIn: (name: string) => `Freed up space in ${name}`,
    setAside: (name: string) => `Set aside the AI chats left from ${name}`,
    setAsideAny: "Set aside leftover AI chats",
    trashedChats: (name: string) =>
      `Moved the AI chats left from ${name} to the Trash`,
    trashedChatsAny: "Moved leftover AI chats to the Trash",
    deletedChat: (title: string) => `Deleted the chat “${title}”`,
    deletedChats: (n: number) => `Deleted ${count(n, "chat")}`,
    trashed: (name: string) => `Moved ${name} to the Trash`,
    hidSuggestion: "Hid a suggestion for 90 days",
    suggestedAgain: "Brought back a hidden suggestion",
    copied: (n: number) => `Copied ${count(n, "chat file")}`,
    copyUpToDate: "The copy of AI chats was up to date",
    /** The first copy after the upgrade to Laci 3.1 packs the files an older copy kept plain. */
    packedCopy: (files: number, before: string, after: string) =>
      `Packed the copy of AI chats: ${grouped(files)} ${files === 1 ? "file" : "files"}, ${before} → ${after}`,
    copyOn: "Laci now copies new chats by itself",
    copyOff: "Laci now copies chats only when you ask",
    putBack: (ai: string) => `Put back a ${ai} chat from Laci’s copy`,
    putBackAny: "Put back a chat from Laci’s copy",
    movedCopy: (dir: string) => `Moved the copy of AI chats to ${dir}`,
    movedCopyOwn: "Moved the copy of AI chats to Laci’s own folder",
    keptCopyIn: (dir: string) => `Laci keeps the copy of AI chats in ${dir} from now on`,
    keptCopyInOwn: "Laci keeps the copy of AI chats in its own folder from now on",
    emptiedKept: "Emptied Kept for Undo",
    removedOldUndo: "Removed the old undo records",
    removedLaci1: "Removed the leftovers of Laci 1",
    letUse: (ai: string) => `Let ${ai} use Laci`,
    stoppedUse: (ai: string) => `Stopped ${ai} from using Laci`,
    created: (name: string) => `Created ${name}`,
  },
};

/**
 * The sentence for each form of change the engine records with a Log entry since Laci 3.0 (its
 * "say": the form and its parts, laci-core's service.rs and what it calls), keyed by the form.
 * Activity hands each the parts it needs. Most say what `activity.changes` says for the same change
 * found in an older entry's title.
 */
const told = activity.changes;
export const logForms = {
  undid: told.undidAny,
  moved: told.moved,
  archived: told.archived,
  reconnected: told.reconnected,
  chatsForGone: { kept: told.setAsideAny, trashed: told.trashedChatsAny },
  chatsForDeleted: { kept: told.setAside, trashed: told.trashedChats },
  finishedMoves: told.finishedMoves,
  freed: told.freed,
  clearedBuild: told.freedIn,
  deletedChat: told.deletedChat,
  deletedChats: told.deletedChats,
  keptOut: told.keptOut,
  setStatus: told.status,
  clearedStatus: told.statusByLaci,
  setPriority: told.priority,
  clearedPriority: told.noPriority,
  setDeadline: told.due,
  clearedDeadline: told.noDue,
  setClient: (name: string, client: string) => `Set the client of ${name} to ${client}`,
  clearedClient: (name: string) => `Removed the client of ${name}`,
  muted: told.hidWarning,
  unmuted: told.warnAgain,
  changedMuted: told.hiddenWarnings,
  addedStep: told.addedStep,
  ticked: told.ticked,
  unticked: told.unticked,
  editedTodo: told.editedTodo,
  deletedStep: told.deletedStep,
  editedNotes: told.notes,
  addedHistory: told.showsChats,
  removedHistory: told.hidesChats,
  addedTool: told.addedTool,
  removedTool: told.removedTool,
  closedItem: told.closedItem,
  reopenedItem: told.openedItem,
  trashed: told.trashed,
  dismissed: told.hidSuggestion,
  suggestedAgain: told.suggestedAgain,
  backedUp: told.copied,
  backupUpToDate: told.copyUpToDate,
  packedCopy: told.packedCopy,
  autoBackupOn: told.copyOn,
  autoBackupOff: told.copyOff,
  restoredChat: told.putBack,
  restoredChatAny: told.putBackAny,
  movedCopy: told.movedCopy,
  keptCopyIn: told.keptCopyIn,
  emptiedKept: told.emptiedKept,
  removedOldUndo: told.removedOldUndo,
  removedLaci1: told.removedLaci1,
  letUse: told.letUse,
  stoppedUse: told.stoppedUse,
  created: told.created,
  changedSettings: told.settings,
};

/** AI helpers: the chats of every project, the summaries your AI writes, and the AI tools Laci knows. */
export const aiHelpers = {
  title: "AI helpers",
  lead: "Your chats with AI tools, the summaries they write, and the tools themselves.",
  start: "Start a chat",
  startWith: (ai: string) => `With ${ai}…`,
  tabsLabel: "What AI helpers shows",
  tabs: { chats: "Chats", summaries: "Summaries", tools: "Tools" },

  // Chats
  search: "Search chats",
  show: "Show",
  filters: {
    all: "All",
    week: "This week",
    old: "Older than 30 days",
    outside: "Not in a project",
    kept: "Kept",
    backup: "Only in Laci’s copy",
  },
  select: "Select",
  selectLabel: "Chats you select",
  selectNone: "Choose the chats to keep or delete.",
  selected: (n: number, size: string) => `${count(n, "chat")} selected, ${size}`,
  selectAll: (n: number) => `Select all ${n}`,
  clear: "Clear",
  done: "Done",
  pick: (title: string) => `Select: ${title}`,
  keep: "Keep",
  dontKeep: "Don’t keep",
  delete: "Delete…",
  notInProject: "Not in a project",
  openProject: (name: string) => `Open ${name}`,
  chatCount: (n: number) => count(n, "chat"),
  by: (ai: string, when: string) => `${ai}, ${when}`,
  messages: (n: number) => count(n, "message"),
  files: (n: number) => `${count(n, "file")} changed`,
  quick: (n: number) => count(n, "quick chat"),
  quickNote: "A message or two each, and no file changed.",
  showMore: (n: number) => `Show ${count(n, "more chat")}`,
  showFewer: "Show fewer",
  continue: "Continue",
  continueFor: (title: string) => `Continue: ${title}`,
  restore: "Put it back",
  restoreFor: (title: string) => `Put it back: ${title}`,
  restoring: "Putting the chat back…",
  restored: "Chat put back",
  kept: "Kept",
  onlyCopy: "Only in Laci’s copy",
  emptyTitle: "No AI chats yet",
  emptyBody:
    "Chats with your AI tools show up here, by project. Laci finds them by itself.",
  seeTools: "See the AI tools",
  noneTitle: "No chats here",
  noMatch: (query: string) => `No chat matches “${query}”.`,
  none: {
    all: "There are no chats to show.",
    week: "No chat changed in the last 7 days.",
    old: "No chat is older than 30 days.",
    outside: "Every chat belongs to a project.",
    kept: "You keep no chat yet.",
    backup: "No chat is only in Laci’s copy.",
  },
  clearSearch: "Clear the search",
  showAll: "Show all chats",

  // One chat
  chatAbout: (ai: string, place: string, when: string) => `${ai} · ${place} · ${when}`,
  noFolder: "No folder written down",
  inIt: "In it",
  when: "When",
  size: "Size",
  span: (from: string, to: string) => `${from} to ${to}`,
  notWritten: "Not written down",
  firstMessage: "Your first message",
  lastMessage: "Your last message",
  lastReply: (ai: string) => `The last reply from ${ai}`,
  keptNote: "Laci won’t suggest cleaning it up.",
  onlyCopyNote:
    "Its AI tool deleted it, and this is Laci’s copy. Put it back to continue it.",
  readSummary: "Read its summary",
  folder: "Folder",
  chatId: "Chat ID",
  file: "File",

  // Deleting chats
  deleteOne: "Delete this chat?",
  deleteMany: (n: number) => `Delete ${count(n, "chat")}?`,
  deleteNote: (n: number, size: string) =>
    `${n === 1 ? "It moves" : "They move"} to Kept for Undo (${size}). Undo in Activity puts ${n === 1 ? "it" : "them"} back, until you empty Kept for Undo in Clean up.`,
  deleteStay: (n: number) =>
    `${count(n, "chat")} ${n === 1 ? "stays" : "stay"}: kept, in use, or not one Laci can delete.`,
  deleteMore: (n: number) => `and ${count(n, "more chat")}`,
  deleteNow: "Delete",
  deleting: "Deleting…",
  deleted: (n: number) => (n === 1 ? "Chat deleted" : `${count(n, "chat")} deleted`),
  deletedNote: (n: number) => (n === 1 ? "Undo puts it back." : "Undo puts them back."),
  keeping: "Keeping…",
  keptDone: (n: number) =>
    n === 1 ? "Laci keeps this chat" : `Laci keeps ${count(n, "chat")}`,
  keptDoneNote: (n: number) => `Clean up won’t suggest deleting ${n === 1 ? "it" : "them"}.`,
  unkeptDone: (n: number) =>
    n === 1 ? "Laci no longer keeps this chat" : `Laci no longer keeps ${count(n, "chat")}`,

  // The copy of AI chats
  copyTitle: "Keep a copy of AI chats",
  copyWarn: (ai: string, days?: number) =>
    days
      ? `${ai} deletes chats after ${count(days, "day")}. Without a copy, older chats are gone for good.`
      : `${ai} deletes its old chats. Without a copy, they are gone for good.`,
  copyAuto: "Copy new chats by itself",
  copyAutoNote: "At most once an hour. Laci never removes anything from its copy.",
  copyOn: "Laci copies new chats by itself",
  copyOff: "Laci copies chats only when you ask",
  copyLast: (when: string, chats: number, size: string) =>
    `Last copy ${when}: ${count(chats, "chat")}, ${size}.`,
  copyNone: "Laci hasn’t made a copy yet.",
  copyNow: "Copy now",
  copying: "Copying AI chats…",
  copied: (n: number) => `Copied ${count(n, "chat file")}`,
  copyUpToDate: "The copy is up to date",
  copyWhere: (chats: number, where: string) => `${count(chats, "chat")} kept in ${where}`,
  openFolder: "Open folder",
  copyPlace: "Where Laci keeps the copy",
  copyPlaceOwn: "In Laci’s own folder",
  copyPlaceNote:
    "Laci packs the copy to take little space. It can be in any folder, also on another drive.",
  copyPlaceChange: "Change…",
  /** What a screen reader calls Change…: it starts with the button's own word. */
  copyPlaceChangeName: "Change where Laci keeps the copy",
  copyPlaceTitle: "Choose where Laci keeps the copy of your AI chats",
  copyPlaceBack: "Use Laci’s own folder",
  copyPlaceOwnName: "Laci’s own folder",
  /** The question before a move; the size only once every file is packed, as after a backup by Laci 3.1. */
  copyMoveAsk: (where: string, size?: string) =>
    size
      ? `Move the copy of your AI chats (${size}) to ${where}?`
      : `Keep the copy of your AI chats in ${where} from now on?`,
  /** The question before a move of a copy that still holds chats as earlier versions of Laci kept them. */
  copyMovePlainAsk: (where: string) =>
    `Move the copy of your AI chats to ${where}? Laci packs it small first.`,
  copyMoveNote: "Undo in Activity moves it back.",
  copyMove: "Move the copy",
  copyMoving: "Moving the copy of your AI chats…",
  copyMoved: (where: string) => `The copy of your AI chats is now in ${where}`,
  copyKept: (where: string) => `Laci keeps the copy of your AI chats in ${where} from now on`,
  /** The copy can't be reached now, as on a drive that isn't connected: a new one can start elsewhere. */
  copyFreshAsk: (where: string) =>
    `Laci can’t reach the copy of your AI chats now, so it can’t move it. Start a new copy in ${where} instead? The old one stays where it is.`,
  copyFreshNote: "Undo in Activity goes back to the old folder.",
  copyFresh: "Start a new copy",

  // Summaries
  searchSummaries: "Search summaries",
  summaryList: "Summaries",
  forChat: (title: string) => `For “${title}”`,
  forOneChat: "For one chat",
  forProject: (name: string) => `For ${name}`,
  showAllSummaries: "Show all summaries",
  newTag: "New",
  noProject: "No project",
  stillToDoCount: (n: number) => `${n} still to do`,
  showAllRows: (n: number) => `Show all ${n}`,
  searchingInside: "Searching inside the summaries…",
  searchFailed:
    "Laci couldn’t search inside the summaries. Titles and short texts still match.",
  noSummaryMatch: (query: string) => `No summary matches “${query}”.`,
  noneForThis: "No summary names this yet.",
  noFolderTitle: "Summaries aren’t set up yet",
  noFolderBody:
    "Your AI can write a short summary when a chat ends. Choose the folder it writes them in, and Laci lists them here with their projects.",
  chooseFolder: "Choose folder…",
  chooseFolderTitle: "Choose the folder your AI writes summaries in",
  savingFolder: "Saving the folder…",
  folderSaved: "Summaries folder chosen",
  unreadableTitle: "Laci can’t read the summaries folder",
  checkAgain: "Check again",
  chooseAnother: "Choose another folder…",
  noSummariesTitle: "No summaries yet",
  noSummariesBody:
    "Your AI writes one when a chat ends, once it has the instruction. Paste the instruction where your AI reads its own instructions.",
  copyInstruction: "Copy the instruction for your AI",
  instructionCopied: "Instruction copied",
  instructionHint: "Paste it where your AI reads its instructions.",
  back: "Summaries",
  updated: (when: string) => `Updated ${when}`,
  fromChat: (title: string) => `Chat: ${title}`,
  stillToDo: "Still to do",
  stillToDoNote: "Marking an item here changes nothing in the summary file.",
  itemDone: "Done",
  itemDoneFor: (item: string) => `Done: ${item}`,
  notNeeded: "Not needed",
  notNeededFor: (item: string) => `Not needed: ${item}`,
  nothingLeft: "Nothing left to do.",
  moreInSummary: (n: number) => `and ${count(n, "more item")} in the summary`,
  closedItems: (n: number) => `Done or not needed: ${n}`,
  openAgain: "Open again",
  openAgainFor: (item: string) => `Open again: ${item}`,
  openIn: (app: string) => `Open in ${app}`,
  location: "Location",
  copyLocation: "Copy location",
  locationCopied: "Location copied",
  reading: "Reading the summary…",
  tryAgain: "Try again",
  large: (size: string) => `This summary is ${size}, so showing it can take a moment.`,
  showIt: "Show it",
  remoteImages: (n: number) =>
    `${count(n, "picture")} from the web ${n === 1 ? "isn’t" : "aren’t"} shown.`,
  loadImages: "Show pictures",
  linkBlocked: "A summary can open web and mail links, and other summaries in its folder.",
  linkNotOpened: "Link not opened",
  linkNotOpenedNote: "Only another summary in the same folder opens here.",
  goneTitle: "This summary isn’t here any more",
  goneBody: "It was renamed, moved or deleted since Laci listed it.",
  showNewest: "Show the newest",

  // Tools
  yourOwn: "Your own",
  install: {
    installed: "Installed",
    "cant-start": "Installed, but Laci can’t start it",
    missing: "Not installed",
  },
  showChats: "Show its chats in Laci",
  canUse: "Can use Laci:",
  canUseWords: {
    yes: "Yes",
    "not-yet": "Not yet",
    other: "Uses another Laci",
    off: "Turned off",
  },
  canUseAction: {
    yes: "Change…",
    "not-yet": "Let it use Laci…",
    other: "Use this Laci…",
    off: "Turn it on…",
  },
  /** Said after a button or a box that each AI tool's card has, so each one is told apart. */
  forTool: (ai: string) => `, for ${ai}`,
  startsWith: (model: string, effort: string) =>
    model && effort
      ? `Starts with ${model}, with ${effort} thinking effort.`
      : model
        ? `Starts with ${model}, with its own thinking effort.`
        : effort
          ? `Starts with its own model, with ${effort} thinking effort.`
          : "Starts with its own model and thinking effort.",
  startsNote:
    "As you started it last time. Choose another under Options when you start a chat.",
  toolChats: (n: number, when: string) => `${count(n, "chat")}, the newest ${when}`,
  noChats: "No chats yet",
  startOnly: "Laci only starts it: it keeps no chats Laci can read.",
  notAdded: "Laci knows this AI tool. Show its chats to see them on your projects.",
  keepsChatsIn: "Keeps its chats in",
  program: "Program",
  chatsShown: (ai: string) => `Laci shows the chats of ${ai}`,
  chatsHidden: (ai: string) => `Laci no longer shows the chats of ${ai}`,
  chatsHiddenNote: "Its files stay where they are. Undo in Activity brings them back.",
  showingChats: "Laci shows its chats",
  removeOwn: "Remove",
  ownRemoved: (ai: string) => `${ai} removed`,
  ownRemovedNote: "Its files stay where they are. Undo in Activity brings it back.",
  adding: "Adding…",
  removing: "Removing…",
  missingTool: "Is your AI tool missing?",
  addInSettings: "Add it in Settings",

  // Letting an AI use Laci
  useTitle: {
    yes: (ai: string) => `${ai} can use Laci`,
    "not-yet": (ai: string) => `Let ${ai} use Laci`,
    other: (ai: string) => `${ai} uses another Laci`,
    off: (ai: string) => `Laci is turned off in ${ai}`,
  },
  useIntro: (ai: string) =>
    `With it, ${ai} can ask Laci which projects you have, and move, archive or start them the safe way. Each change it makes shows in Activity, with Undo.`,
  useState: {
    yes: (ai: string) => `${ai} starts this Laci when it needs it.`,
    "not-yet": (ai: string) => `${ai} doesn’t know Laci yet.`,
    other: (ai: string) => `${ai} starts another program under Laci’s name:`,
    off: (ai: string) => `${ai} knows Laci, but it is turned off there.`,
  },
  useAction: {
    "not-yet": "Let it use Laci",
    other: "Use this Laci instead",
    off: "Turn it on",
  },
  stopUsing: "Stop it using Laci",
  readingSettings: (ai: string) => `Reading the settings of ${ai}…`,
  whatChanges: "What exactly changes",
  runsCommand: (ai: string) => `Laci runs this ${ai} command:`,
  editsFile: (file: string) => `Laci adds this to ${file}:`,
  takesOut: (file: string) => `Laci takes itself out of ${file}.`,
  copyChange: "Copy",
  changeCopied: "Copied",
  keepsCopy: (file: string) =>
    `This changes ${file}. Laci keeps a copy of that file in its own folder first.`,
  useBlocked: (program: string) =>
    `Laci can’t find the program ${program} on this computer, so it can’t make this change. Install it, or run the command yourself.`,
  letting: "Letting it use Laci…",
  stopping: "Stopping…",
  letDone: (ai: string) => `${ai} can use Laci now`,
  stopDone: (ai: string) => `${ai} no longer uses Laci`,
};

/** Simple's Settings: how Laci looks, the project folders, AI, apps, updates and the rest. */
export const settings = {
  title: "Settings",
  lead: "How Laci looks, where it looks for projects, and the AI tools and apps it works with.",
  loading: "Reading your settings…",
  failed: "Laci couldn’t read your settings.",
  tryAgain: "Try again",

  // Appearance
  appearance: "Appearance",
  appearanceNote: "A change here shows at once and needs no saving.",
  view: "View",
  designs: { simple: "Simple", detailed: "Detailed" },
  designNotes: {
    simple: "Calm and guided, in plain words.",
    detailed: "Everything at once: paths, version details and long lists.",
  },
  viewNote:
    "Both show the same projects, chats and Activity. Switch any time at the bottom of the sidebar.",
  theme: "Theme",

  // Projects
  projects: "Projects",
  folders: "Project folders",
  foldersNote: "Laci looks for projects in these folders, and only reads them.",
  noFolders: "No project folder yet. Add the folder where you keep projects.",
  unavailable: "Can’t be reached now",
  remove: "Remove",
  removeFor: (folder: string) => `Remove ${folder}`,
  addFolder: "Add a folder…",
  /**
   * What a screen reader calls this button, which says which folder it chooses. Like
   * chooseArchiveName and chooseSummariesName, it starts with the button's own words.
   */
  addFolderName: "Add a folder where you keep projects",
  addFolderTitle: "Choose a folder where you keep projects",
  /** A whole disk chosen as a project folder, here or on Home: Laci doesn’t take it. */
  wholeDisk: "Laci doesn’t look through a whole disk",
  wholeDiskNote: "Choose the folder where you keep projects.",
  suggest: "Suggest folders",
  suggesting: "Looking for folders…",
  suggestions: "Folders with projects in them",
  holds: (n: number) => (n ? `${count(n, "project")} inside` : "No projects found inside"),
  add: "Add",
  addFor: (folder: string) => `Add ${folder}`,
  noSuggestions: "Laci found no other folders with projects in them.",
  archive: "Archive folder",
  archiveNearest: "Each project goes to the nearest folder named _archive.",
  chooseArchive: "Choose folder…",
  chooseArchiveName: "Choose folder for archived projects",
  chooseArchiveTitle: "Choose your archive folder",
  useNearest: "Use the nearest _archive folder",

  // AI
  ai: "AI",
  aiTools: "AI tools",
  aiToolsNote:
    "Laci shows the chats of these tools on your projects, and moves them with a project.",
  found: "Found on this computer",
  notFound: "Not found on this computer",
  summaries: "Summaries folder",
  summariesNote:
    "Your AI can write a short summary when a chat ends. Laci lists the ones in this folder, and changes nothing in it.",
  summariesFolder: {
    unsaved: "Save your changes to use this folder.",
    off: "None chosen, so summaries stay hidden.",
    unreadable: (why: string) => `Laci can’t read this folder: ${why}`,
    read: (n: number) => `${count(n, "summary", "summaries")} found.`,
  },
  chooseSummaries: "Choose folder…",
  chooseSummariesName: "Choose folder for summaries",
  chooseSummariesTitle: "Choose the folder your AI writes summaries in",
  stopSummaries: "Stop showing summaries",
  models: "Model and thinking effort",
  modelsNote:
    "Each AI starts with the choice you made the last time you started it. Choose another under Options when you start a chat.",
  seeTools: "See each AI tool in AI helpers",

  // Apps
  apps: "Apps",
  appsNote: "The apps that the Open in and Show in buttons open.",
  appNames: { editor: "Editor", files: "File manager", terminal: "Terminal app" },
  notInstalledApp: (name: string) => `${name} (not installed)`,
  chatsOpenIn: "Open AI chats in",
  targets: { internal: "Laci’s terminal", external: "My terminal app" },
  targetNotes: {
    internal: "At the bottom of this window.",
    external: "In a window of its own.",
  },

  // Updates, in the words of the first run's question about them
  updates: "Updates",
  updatesQuestion: "New versions of Laci",
  updateChoices: {
    daily: "Look for new versions once a day",
    off: "Don’t look for new versions",
  },
  updateNotes: {
    daily:
      "Laci tells you when a new version is ready, and installs nothing until you choose to.",
    off: "Laci won’t look by itself. Use Check now to look once.",
  },
  /** The same note while a version found has Install or Restart where Check now was. */
  updateNoteOffFound: "Laci won’t look by itself.",
  updatesUnset: "You haven’t chosen yet, so Laci doesn’t look.",
  updatesPrivacy:
    "A check only asks GitHub which version is newest: like any visit to a website it shows your internet address, and it sends nothing about your projects.",
  updatesSaved: {
    daily: "Laci looks for new versions once a day",
    off: "Laci won’t look for new versions",
  },

  // The technical part, folded away (design-research's "Advanced"; Simple keeps that word for no part)
  technical: "Technical settings",
  technicalNote: "Your own AI tool, the diagnostics log and where Laci keeps its settings.",
  showTechnical: "Show technical settings",
  hideTechnical: "Hide technical settings",
  addTool: "Your own AI tool",
  addToolNote:
    "For an AI tool Laci doesn’t know yet: say where it keeps its chats, or how to start it.",
  addToolButton: "Add another AI tool…",
  diagnostics: "Diagnostics log",
  diagnosticsNote: "A technical record of what Laci did. It helps when you report a problem.",
  openDiagnostics: "Open the diagnostics log",
  settingsFile: "Settings file",
  settingsFileNote: "Laci keeps your settings in this file.",
  copyLocation: "Copy location",
  locationCopied: "Location copied",

  // About
  about: "About",
  name: "Laci",
  version: (version: string) => `Version ${version}`,
  aboutLine:
    "Laci keeps your projects in one place, with their AI chats. What it learns about them stays on this computer.",
  openHelp: "Help",
  report: "Report a problem",

  // Saving
  unsaved: "You have changes that aren’t saved yet.",
  discard: "Discard",
  save: "Save changes",
  saving: "Saving…",
  saved: "Settings saved",
  savedNote: "Undo in Activity puts the old ones back.",
};

/**
 * Simple's own sheets for Archive, Delete and Free up space (design-research §3.7): Archive comes
 * before the system's bin, and what can't be undone says so before its Countdown.
 */
export const dialogs = {
  /** How to get a folder back from the Trash. */
  restoreSteps: "To get it back, open the Trash in your file manager and choose Restore.",
  busy: "Laci is finishing another change. Try again in a moment.",
  checkAgain: "Check again",
  /** What "Show details" holds. */
  details: {
    found: "What Laci found",
    onlyHere: "Only on this computer",
    location: "Location",
    steps: "What Laci does",
    goesTo: "Goes to",
    hidden: "Hidden warnings",
  },
  delete: {
    title: (name: string) => `Delete ${name}?`,
    intro: "Archiving is the safer choice: you can undo it. Laci can’t undo a move to the Trash.",
    introArchived: "It is in your archive folder already. Laci can’t undo a move to the Trash.",
    lost: "What could be lost",
    checking: "Checking that nothing would be lost…",
    allSaved: "Everything in it is saved and online.",
    onlyHere:
      "Only this computer has these files. Your online copy can’t give them back:",
    more: (n: number) => `and ${count(n, "more file")}`,
    blocked: (name: string) => `Laci can’t move ${name} to the Trash yet.`,
    blockedWhy:
      "Laci does it only once every saved version is online, every change is saved as a version, nothing is set aside, and no program is using the folder. Show details says what stopped it.",
    noHistory:
      "This folder has no version history, so Laci can’t check what would be lost. Archive it instead.",
    checkFailed: (name: string) => `Laci couldn’t check ${name}.`,
    archiveInstead: "Archive instead",
    archiveNote: (name: string) =>
      `Laci moves ${name}, with its AI chats, to your archive folder. You can undo it in Activity.`,
    typeName: (name: string) =>
      `Type ${name} to move it to the Trash with these files`,
    trash: "Move to Trash",
    trashNote: "Laci can’t undo this.",
    notYet: "Not possible yet. The reason is above.",
    typeFirst: "Type the name above first.",
    counting: (name: string) => `Moving ${name} to the Trash`,
    moving: (name: string) => `Moving ${name} to the Trash…`,
    moved: (name: string) => `Moved ${name} to the Trash`,
    moveFailed: (name: string) => `Laci couldn’t move ${name} to the Trash.`,
  },
  archive: {
    title: (name: string) => `Archive ${name}?`,
    intro: "Laci moves it, with its AI chats, to your archive folder.",
    checking: "Checking where it goes…",
    unsafe:
      "Back it up first. Archiving moves it as it is, and an archived project is easy to forget.",
    onlyHidden: (n: number) =>
      `You hid ${count(n, "warning")} about this project. Show details lists ${n === 1 ? "it" : "them"}.`,
    backUpFirst: "Back up first",
    backUpNote: (problem: string) =>
      `Laci helps you with “${problem}” first. Archive it after that.`,
    anyway: "Archive anyway",
    anywayNote: "It goes to the archive as it is. You can undo it in Activity.",
    archive: "Archive",
    note: "You can undo it any time in Activity.",
    cant: (name: string) => `Laci can’t archive ${name} there.`,
    elsewhere:
      "To archive it somewhere else, change “Goes to” under Show details.",
    fullPath: "Write the full location, such as ~/archive/my-project.",
    archiving: (name: string) => `Archiving ${name}…`,
    archived: (name: string) => `Archived ${name}`,
    archivedNote: "Find it in Projects, under Archived.",
    failed: (name: string) => `Laci couldn’t archive ${name}.`,
  },
  clean: {
    title: (name: string) => `Free up space in ${name}?`,
    intro:
      "Laci deletes the downloaded packages and build files in it. Your tools can make them again.",
    whatGoes: "What goes",
    forGood: "Deleted for good",
    frees: (size: string) => `Frees ${size}.`,
    comesBack:
      "The next install or build brings them back. You need the internet to install them again.",
    nothing: (name: string) => `There is nothing to free up in ${name} now.`,
    free: (size: string) => `Free ${size}`,
    freeNote: "Laci can’t undo this.",
    counting: (name: string) =>
      `Deleting the downloaded packages and build files in ${name}`,
    freeing: (name: string) => `Freeing up space in ${name}…`,
    freed: (size: string, name: string) => `Freed ${size} in ${name}`,
    failed: (name: string) => `Laci couldn’t free up space in ${name}.`,
  },
};

/**
 * Detailed's words for a new version of Laci, at the foot of its sidebar and in its palette, and for
 * the look for secret files before a fix that saves or uploads versions. Its buttons keep their Git
 * names (FIX_LABEL in helpers.ts); what they open says it plainly.
 */
export const detailedData = {
  /** The scan of the project folders, at the foot of the sidebar beside the update's badge. */
  scan: {
    checked: "Projects checked",
    checking: "Checking projects…",
    failed: "Couldn’t check projects",
  },
  update: {
    /** The badge: what it says beside the new version, or beside how much of it has arrived. */
    badge: {
      available: "Update available",
      downloading: "Downloading update",
      ready: "Update ready",
    },
    /** What the badge says when it is pointed at, and to a screen reader after its words. */
    badgeNote: {
      available: (version: string) =>
        `Laci ${version} is available. Settings shows how to get it.`,
      downloading: (version: string) =>
        `Laci is downloading ${version}. Settings shows how far it is.`,
      ready: (version: string) =>
        `Laci ${version} is installed. Restart Laci from Settings to use it.`,
    },
    check: "Check for updates",
    install: "Install update",
    restart: "Restart to update",
    page: "Open the release page",
    /** Beside a command: the version it brings. */
    version: (version: string) => `Laci ${version}`,
    /** Beside Restart to update while terminals are open: they close with Laci. */
    closes: (n: number) => `closes ${count(n, "open terminal")}`,
    checking: "Checking for updates…",
    upToDate: "Laci is up to date",
    current: (version: string) => `Version ${version} is the newest.`,
    found: (version: string) => `Laci ${version} is available`,
    foundClick: "Install it in Settings, or search for Install update.",
    foundNotice: "Settings links to its release page.",
    checkFailed: "Couldn’t check for updates",
    downloading: (version: string) => `Downloading Laci ${version}…`,
    downloadingNote: "Nothing changes until Laci restarts.",
    installFailed: "Couldn’t install the update",
    restartFailed: "Couldn’t restart",
  },
  secrets: {
    title: (name: string) => `Files in ${name} look like passwords or keys`,
    /** The title while Laci looks again, or when it couldn't look: nothing is known to be found. */
    checkTitle: (name: string) => `Check ${name} for passwords or keys`,
    /** `fix` is the button that was pressed. */
    intro: (fix: string) =>
      `Laci looked at the names of the files before “${fix}”. It never opens them.`,
    checking: "Looking for files that look like passwords or keys…",
    loose: "Not in .gitignore yet",
    tracked: "Already in the history",
    trackedNote:
      ".gitignore can’t take a file out of the history. Ask your AI to stop tracking it first.",
    more: (n: number) => `and ${count(n, "more file")}`,
    failed: "Laci couldn’t look for files like these.",
    checkAgain: "Check again",
    keepOut: "Keep these out",
    keepNote:
      "Keep these out adds them to .gitignore, then goes on. The Log can undo it.",
    goOnFailed: "Continue goes on without the check.",
    keeping: "Keeping them out…",
    keptOut: "Added to .gitignore",
    goOn: "Continue",
    cancel: "Cancel",
  },
};

/**
 * What Detailed's Settings, Archive and New project gained in 3.0: the "Choose…" beside each folder
 * field, and Settings › About & updates. How often Laci looks for a new version is said as first
 * run says it (`firstRun`), so the same question reads the same everywhere. The rest of Detailed
 * keeps its words in its components.
 */
export const detailedSettings = {
  /** The button beside a folder field, which opens the system's folder picker. */
  choose: "Choose…",
  /**
   * The picker's title for each field. It is also what a screen reader calls the field's Choose…
   * button, so each button says which folder it chooses; each starts with the button's own word.
   */
  addFolderTitle: "Choose a folder where you keep projects",
  archiveFolderTitle: "Choose your archive folder",
  reportsFolderTitle: "Choose the folder for reports",
  destinationTitle: (name: string) => `Choose where to archive ${name}`,
  locationTitle: "Choose where the new project goes",
  templateTitle: "Choose a folder to start new projects from",
  backupFolderTitle: "Choose a folder for the history backup",
  /** The row beside the automatic backup switch: where the backup is, and moving it. */
  backupFolder: "Backup folder",
  backupFolderDefault: "Laci's data folder",
  backupFolderNote:
    "The backup is compressed with zstd. It can be on another drive. Laci never makes a chosen folder and never removes anything from the backup.",
  backupFolderChange: "Change…",
  /** What a screen reader calls Change…: it starts with the button's own word. */
  backupFolderChangeName: "Change the folder of the history backup",
  backupFolderDefaultButton: "Use the default",
  /** The question before a move; the size only once every file is packed, as after a backup by Laci 3.1. */
  backupMoveAsk: (where: string, size?: string) =>
    size
      ? `Move the history backup (${size}) to ${where}?`
      : `Keep the history backup in ${where} from now on?`,
  /** The question before a move of a backup that still holds plain files from before Laci 3.1. */
  backupMovePlainAsk: (where: string) =>
    `Move the history backup to ${where}? Laci compresses its files first, so less moves.`,
  backupMoveNote: "Undo in the Log moves it back.",
  backupMove: "Move backup",
  backupMoving: "Moving the history backup…",
  backupMoved: (where: string) => `History backup moved to ${where}`,
  backupKept: (where: string) => `History backup is kept in ${where} from now on`,
  /** The backup can't be reached now, as on a drive that isn't connected: a new one can start elsewhere. */
  backupFreshAsk: (where: string) =>
    `Laci can't reach the history backup now, so it can't move it. Start a new backup in ${where} instead? The old one stays where it is.`,
  backupFreshNote: "Undo in the Log goes back to the old folder.",
  backupFresh: "Start a new backup",
  cancel: "Cancel",
  /** A folder chosen that Laci doesn’t take as a place to keep projects. */
  wholeDisk:
    "Laci doesn’t look through a whole disk. Choose the folder where you keep projects.",

  // Settings › About & updates
  updatesTitle: "About & updates",
  updatesIntro:
    "The version you run, and whether a newer one is out. A change here takes effect at once and needs no saving.",
  version: (version: string) => `Version ${version}`,
  reading: "Reading the update status…",
  neverLooked: "Laci hasn’t looked for a new version yet.",
  /** `when` is "5 minutes ago", or empty. */
  upToDate: (when: string) =>
    `No newer version was found${when ? ` ${when}` : ""}.`,
  looking: "Looking for a new version…",
  available: (version: string, when: string) =>
    `Version ${version} is available${when ? `, published ${when}` : ""}.`,
  downloading: (version: string, percent?: number) =>
    `Downloading version ${version}…${percent === undefined ? "" : ` ${percent}%`}`,
  ready: (version: string) =>
    `Version ${version} is ready. Restart Laci to finish.`,
  /** When the desktop gives no reason for a failure. */
  failed: "Laci couldn’t update.",
  /** The one button, by what it does. */
  check: "Check now",
  checking: "Checking…",
  install: "Install",
  downloadingButton: "Downloading…",
  installing: "Installing…",
  restart: "Restart",
  releasePage: "Open the release page",
  restartNote:
    "Restarting closes Laci’s terminals and the AI chats running in them.",
  /** Why there is a link to the release page and no Install. */
  noticeNote:
    "Laci can’t replace this copy of itself: a package manager or a script put it here. Get the new version from its release page.",
  whatsNew: (version: string) => `What’s new in ${version}`,
  notesBlocked: "Release notes can open web and mail links only",
  remoteImages: (n: number) =>
    `${count(n, "image")} from the web ${n === 1 ? "is" : "are"} not loaded.`,
  loadImages: "Load images",
  /** The question about looking by itself, which Settings asks in a section of its own. */
  updatesChoice: "Looking for new versions",
  updatesUnset: "You haven’t chosen yet, so Laci doesn’t look.",
  updatesSaved: {
    daily: "Laci looks for new versions once a day",
    off: "Laci won’t look for new versions",
  },
};

/**
 * Simple's update parts and the follow-ups from the review of its pages: the panel in Settings ›
 * Updates and the card on Home say each step of an update in these words, and a summary item closed
 * from AI helpers or Home says in Simple's words what it did. The desktop writes its own refusals and
 * failures for the window ("Laci is busy with a change. Update when it's done."), so those show as
 * they come.
 */
export const polish = {
  updates: {
    loading: "Reading the update status…",
    unread: "Laci couldn’t read the update status.",
    tryAgain: "Try again",
    checking: "Looking for a new version…",
    upToDate: "Up to date",
    versionNow: (version: string) => `You have version ${version}.`,
    lastChecked: (when: string) => `Last checked ${when}.`,
    neverChecked: "Laci hasn’t looked for a new version yet.",
    checkNow: "Check now",
    checkAgain: "Check again",
    /** Found and not yet downloaded: "ready" waits for the download, as Detailed's words do. */
    isAvailable: (version: string) => `Version ${version} is available.`,
    released: (when: string) => `Released ${when}.`,
    whatsNew: (version: string) => `What’s new in ${version}`,
    install: (version: string) => `Install version ${version}`,
    linkOnly:
      "This copy of Laci can’t install updates itself. Get the new version from the release page.",
    openRelease: "Open the release page",
    downloading: (version: string) => `Downloading version ${version}…`,
    progressLabel: "Download progress",
    percent: (n: number) => `${n}%`,
    readyToRestart: (version: string) => `Version ${version} is ready.`,
    restartNote:
      "Restart Laci to finish the update. Restarting closes the terminals in Laci, and the AI chats running in them.",
    restart: "Restart Laci",
    failed: "Laci couldn’t finish the update.",
    /** At the foot of the sidebar while a new version is known, in the words of Detailed's badge. */
    foot: {
      available: "Update available",
      downloading: "Downloading update",
      ready: "Update ready",
    },
    /** What that place says when it is pointed at, and to a screen reader after its words. */
    footNote: {
      available: (version: string) =>
        `Version ${version} is available. Settings shows how to get it.`,
      downloading: (version: string) =>
        `Laci is downloading version ${version}. Settings shows how far it is.`,
      ready: (version: string) =>
        `Version ${version} is installed. Restart Laci from Settings to use it.`,
    },
    // The release notes come from the web: pictures wait to be asked for, and only web and mail
    // links open.
    picturesHidden: (n: number) =>
      `${count(n, "picture")} from the web ${n === 1 ? "isn’t" : "aren’t"} shown.`,
    showPictures: "Show pictures",
    linkBlocked: "Release notes can open web and mail links only.",
    linkNotOpened: "Link not opened",
  },
  /** Home's card, which says it once for a version and then leaves it to Settings. */
  card: {
    /** Until the new version is downloaded it is available; once it is, it is ready. */
    title: "A new version of Laci is available",
    titleReady: "A new version of Laci is ready",
    canInstall: (version: string) => `Version ${version} can be installed now.`,
    notNow: "Not now",
    hidden: (version: string) =>
      `Laci won’t remind you about version ${version} here`,
    hiddenNote: "You can still update in Settings.",
  },
  /** What closing a summary's item says, in the words of Still to do. */
  summaryItem: {
    done: "Marked as done",
    dropped: "Marked as not needed",
    open: "Back in Still to do",
  },
};

/**
 * What the engine says in a reason or a refusal of its own, in each design's words: why the folder of the copy of
 * AI chats can't be used now (laci-core's backup.rs, `check`), with the folder it names, and why a change is
 * refused while a backup or a move of the copy runs (ops.rs, `COPYING` and `MOVING`). Detailed calls the copy the
 * history backup, chosen in Settings › Backup folder; Simple calls it the copy of your AI chats, chosen in AI
 * helpers › Where Laci keeps the copy. `engineSays` puts them in.
 */
export const engineWords = {
  detailed: {
    copyNotFull: (dir: string) =>
      `The history backup's folder isn't a full path: ${dir}. Choose the folder again in Settings › Backup folder.`,
    copyMissing: (dir: string) =>
      `The history backup's folder isn't there: ${dir}. Connect its drive, or choose another folder in Settings › Backup folder.`,
    copyLink: (dir: string) =>
      `The history backup's folder is reached through a link: ${dir}. Choose the folder itself in Settings › Backup folder.`,
    copyUnknown: (dir: string) =>
      `The history backup's folder isn't the one Laci knows: ${dir}. Connect its drive, or choose the folder again in Settings › Backup folder.`,
    copyNotMade: (dir: string) =>
      `The history backup's folder doesn't hold a backup Laci made: ${dir}. Choose the folder again in Settings › Backup folder.`,
    copying: "Laci is making the history backup. Try again when it's done.",
    moving: "Laci is moving the history backup. Try again when it's done.",
  },
  simple: {
    copyNotFull: (dir: string) =>
      `The folder for the copy of your AI chats isn’t a full path: ${dir}. Choose the folder again in AI helpers › Where Laci keeps the copy.`,
    copyMissing: (dir: string) =>
      `The folder for the copy of your AI chats isn’t there: ${dir}. Connect its drive, or choose another folder in AI helpers › Where Laci keeps the copy.`,
    copyLink: (dir: string) =>
      `The folder for the copy of your AI chats is reached through a link: ${dir}. Choose the folder itself in AI helpers › Where Laci keeps the copy.`,
    copyUnknown: (dir: string) =>
      `The folder for the copy of your AI chats isn’t the one Laci knows: ${dir}. Connect its drive, or choose the folder again in AI helpers › Where Laci keeps the copy.`,
    copyNotMade: (dir: string) =>
      `The folder for the copy of your AI chats doesn’t hold a copy Laci made: ${dir}. Choose the folder again in AI helpers › Where Laci keeps the copy.`,
    copying: "Laci is copying your AI chats. Try again when it’s done.",
    moving: "Laci is moving the copy of your AI chats. Try again when it’s done.",
  },
};

type EngineSaying = Exclude<keyof (typeof engineWords)["simple"], "copying" | "moving">;
/** The engine's sentences, as backup.rs writes them, each with the folder it names. */
const COPY_REASONS: [RegExp, EngineSaying][] = [
  [/The folder for the copy of AI chats isn't a full path: (.+?)\. Choose the folder for the copy again\./g, "copyNotFull"],
  [
    /The folder for the copy of AI chats isn't there: (.+?)\. Connect its drive, or choose another folder for the copy\./g,
    "copyMissing",
  ],
  [
    /The folder for the copy of AI chats is reached through a link: (.+?)\. Choose the folder itself for the copy\./g,
    "copyLink",
  ],
  [
    /The folder for the copy of AI chats isn't the one Laci knows: (.+?)\. Connect its drive, or choose the folder for the copy again\./g,
    "copyUnknown",
  ],
  [
    /The folder for the copy of AI chats doesn't hold a copy Laci made: (.+?)\. Choose the folder for the copy again\./g,
    "copyNotMade",
  ],
];
/** The engine's refusals while a backup or a move of the copy runs, as ops.rs writes them. */
const REFUSALS: [string, "copying" | "moving"][] = [
  ["Laci is copying your AI chats. Try again when it's done.", "copying"],
  ["Laci is moving the copy of your AI chats. Try again when it's done.", "moving"],
];

/**
 * `text`, a reason or an error the engine gave, with each of its sentences that `engineWords` knows said in the
 * words of `design`, also inside a longer message. Anything else stays as the engine said it.
 */
export function engineSays(text: string, design: keyof typeof engineWords): string {
  const words = engineWords[design];
  let said = text;
  for (const [form, key] of COPY_REASONS)
    said = said.replace(form, (_, dir: string) => words[key](dir));
  for (const [refusal, key] of REFUSALS) said = said.split(refusal).join(words[key]);
  return said;
}
