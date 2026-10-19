import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, errorText } from "./api";
import {
  agentInstruction,
  APP_NAMES,
  cap,
  expandHome,
  isAbsolutePath,
  joinPath,
  pathKey,
  plural,
  reportList,
  shortDay,
  tilde,
  trimSep,
} from "./helpers";
import { OS } from "./platform";
import { Select } from "./select";
import { LaciMark } from "./brand";
import { Icon } from "./common";
import { useMarkdown } from "./hooks";
import { LookPicker } from "./looks";
import { ChooseFolder } from "./pick";
import {
  useApp,
  acknowledge,
  changed,
  chooseDesign,
  copyText,
  rescan,
  run,
  setDesign,
  setTheme,
  toast,
  urlOpen,
} from "./store";
import type { Theme } from "./store";
import { useNow } from "./clock";
import { useUpdate } from "./update";
import type { UpdateStatus } from "./update";
import type {
  Apps,
  Change,
  Design,
  Prefs,
  SetupInfo,
  Snapshot,
  TerminalTarget,
} from "./types";
import { ago, detailedSettings as said, firstRun, views } from "./words";
/** Where another drive is found, for the examples of a path. */
const OTHER_DRIVE =
  OS === "windows" ? "D:\\" : OS === "macos" ? "/Volumes" : "/mnt";
/** Where config.json is without LACI_HOME or XDG_CONFIG_HOME, for the moment before the desktop says. */
const USUAL_CONFIG_PATH =
  OS === "windows"
    ? "~\\AppData\\Local\\io.github.mrramdn.laci\\config.json"
    : "~/.config/laci/config.json";
let prefsSaid: Prefs | undefined;
/**
 * The saved choices, as the desktop gave them when first asked; undefined until it answers. `fresh`
 * asks again: first run can come back in the same session (an Undo of its setup), after the choices
 * it preselects were saved.
 */
function usePrefs(fresh = false) {
  const [said, setSaid] = useState(fresh ? undefined : prefsSaid);
  useEffect(() => {
    if (said !== undefined) return;
    let live = true;
    void api<Prefs>("prefs").then(
      (prefs) => {
        prefsSaid = prefs;
        if (live) setSaid(prefs);
      },
      () => {
        // Nothing to show instead: every use of it is only a hint.
      },
    );
    return () => {
      live = false;
    };
  }, [said]);
  return said;
}
/** Where config.json is, as the desktop says. It keeps the file's usual place until it has. */
export function useConfigPath() {
  return usePrefs()?.configPath || USUAL_CONFIG_PATH;
}
type Updates = NonNullable<Prefs["updates"]>;
/**
 * What first run says about this computer, once the desktop tells `setup/info`: `git` is false when
 * no Git can be run (on macOS, without Apple's command line tools), and `translocated` is true when
 * macOS runs Laci from where it was downloaded instead of from Applications. The engine sends `git`
 * (the port's step P6); `translocated` comes with step P10, and until then its note never shows.
 */
type ThisComputer = { git?: boolean; translocated?: boolean };
/** The program a missing `git` asks for, where to get it, and how macOS installs it. */
const GIT = "Git";
const GIT_DOWNLOADS = "https://git-scm.com/downloads";
const MAC_INSTALL = "xcode-select --install";
/** The settings Save and rescan sends, the folders as full paths. */
interface Setup {
  roots: Set<string>;
  archiveDir: string;
  reportsDir: string;
  presets: Set<string>;
  apps: Apps;
  terminalTarget: TerminalTarget;
}
/**
 * Whether saving `now` would change what `saved` holds. The order of folders and tools doesn't
 * count.
 */
function changedSetup(now: Setup, saved: Setup) {
  const same = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((value) => b.has(value));
  return (
    !same(now.roots, saved.roots) ||
    now.archiveDir !== saved.archiveDir ||
    now.reportsDir !== saved.reportsDir ||
    !same(now.presets, saved.presets) ||
    now.apps.editor !== saved.apps.editor ||
    now.apps.files !== saved.apps.files ||
    now.apps.terminal !== saved.apps.terminal ||
    now.terminalTarget !== saved.terminalTarget
  );
}
/** Saves whether Laci looks for new versions. Returns why it couldn't, or "" once it has. */
async function saveUpdates(updates: Updates) {
  try {
    await api<Prefs>("updates", { updates });
    return "";
  } catch (error) {
    return `${firstRun.updatesFailed}: ${errorText(error)}`;
  }
}
/**
 * First run gives way to the window once it is saved or skipped, and the button that did it goes
 * with it. The focus then goes to the window's page as soon as it is drawn (its code may still be
 * loading), unless something has taken it meanwhile.
 */
function focusTheWindowOnceDrawn() {
  if (typeof MutationObserver === "undefined") return;
  const land = () => {
    const main = document.getElementById("main");
    if (!main || main.classList.contains("setup")) return false;
    const focused = document.activeElement;
    if (!focused || focused === document.body || !focused.isConnected)
      main.focus({ preventScroll: true });
    return true;
  };
  if (land()) return;
  const observer = new MutationObserver(() => {
    if (land()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
export function Settings({ first = false }: { first?: boolean }) {
  const s = useApp();
  const snapshot = s.snapshot!;
  // When first run goes, the focus goes to the window drawn in its place.
  useEffect(() => (first ? focusTheWindowOnceDrawn : undefined), [first]);
  const prefs = usePrefs(first);
  const configPath = prefs?.configPath || USUAL_CONFIG_PATH;
  // First run: until one is picked, the design is the one the window shows (Simple for a new install,
  // or another the palette switched to), and the choice about new versions the saved one, else once
  // a day.
  const [lookPicked, setLook] = useState<Design | null>(null);
  const look = lookPicked ?? s.design;
  const [updatesPicked, setUpdates] = useState<Updates | null>(null);
  const updates = updatesPicked ?? prefs?.updates ?? "daily";
  const lookTitle = useId();
  const updatesTitle = useId();
  const [info, setInfo] = useState<(SetupInfo & ThisComputer) | null>(null);
  const [roots, setRoots] = useState<Set<string>>(new Set());
  const [presets, setPresets] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<string[]>([]);
  const [apps, setApps] = useState<Apps>(s.apps);
  const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>(
    s.terminalTarget,
  );
  const [discovering, setDiscovering] = useState(false);
  const [folder, setFolder] = useState("");
  const [archiveDir, setArchiveDir] = useState("");
  const [reportsDir, setReportsDir] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  /** What is saved, as this page last read or saved it. */
  const [saved, setSaved] = useState<Setup | null>(null);
  const retryScan = first && s.setupPending && Boolean(s.error);
  /** A typed folder as an absolute path, with ~ expanded. */
  const full = (raw: string) => expandHome(trimSep(raw.trim()), snapshot.home);
  useEffect(() => {
    let live = true;
    void api<SetupInfo>("setup/info").then(
      (info) => {
        if (!live) return;
        setInfo(info);
        setSaved({
          roots: new Set(info.roots),
          archiveDir: full(info.archiveDir ?? ""),
          reportsDir: full(info.reportsDir ?? ""),
          presets: new Set(info.presets),
          apps: info.apps,
          terminalTarget: info.terminalTarget ?? "internal",
        });
        setRoots(new Set(info.roots));
        setArchiveDir(info.archiveDir ?? "");
        setReportsDir(info.reportsDir ?? "");
        setPresets(
          new Set([
            ...info.presets,
            ...(first
              ? snapshot.suggestions.filter((c) => c.found).map((c) => c.id)
              : []),
          ]),
        );
        setApps(info.apps);
        setTerminalTarget(info.terminalTarget ?? "internal");
        setExtra(
          info.roots.filter(
            (root) => !info.candidates.some((c) => c.path === root),
          ),
        );
      },
      (error) => live && setError(errorText(error)),
    );
    return () => {
      live = false;
    };
    // Runs once on mount: first-run ticks are a one-time default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const catalog = [
    ...snapshot.connectors
      .filter((c) => c.builtin)
      .map((c) => ({
        id: c.id,
        name: c.name,
        about: c.about,
        found: c.present,
      })),
    ...snapshot.suggestions,
  ].sort((a, b) => a.name.localeCompare(b.name));
  const candidates = [
    ...(info?.candidates ?? []),
    ...extra
      .filter((path) => !info?.candidates.some((c) => c.path === path))
      .map((path) => ({ path, repos: null })),
  ];
  function toggle(
    set: Set<string>,
    value: string,
    setter: (set: Set<string>) => void,
  ) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }
  /**
   * Puts a folder among those Laci looks in, ticked: one typed in the box, or one chosen with the
   * system's picker, whose own button is `chosen`.
   */
  function addFolder(raw: string, chosen = false) {
    let path = trimSep(raw.trim());
    // Not "/", which was never taken as a folder to scan. A typed one is passed over; a chosen one
    // says why nothing was added.
    if (!path || path === "/") {
      if (path && chosen) setError(said.wholeDisk);
      return;
    }
    path = expandHome(path, snapshot.home);
    if (!isAbsolutePath(path)) {
      setError("Use a full path like ~/work");
      return;
    }
    // On Windows another spelling of a folder in the list (its case, or / for \) is that folder.
    const listed = candidates.find((c) => pathKey(c.path) === pathKey(path));
    const added = listed?.path ?? path;
    // A chosen folder arrives after the picker closes, so these take the lists as they are by then.
    if (!listed)
      setExtra((now) => (now.includes(added) ? now : [...now, added]));
    setRoots((now) => new Set([...now, added]));
    setFolder("");
    setError("");
  }
  // Changes waiting for Save and rescan: a switch of design draws the other design's Settings
  // without them, so it waits for them. First run stays on the screen through a switch.
  const unsaved =
    !first &&
    saved !== null &&
    changedSetup(
      {
        roots,
        archiveDir: full(archiveDir),
        reportsDir: full(reportsDir),
        presets,
        apps,
        terminalTarget,
      },
      saved,
    );
  useEffect(() => {
    useApp.setState({ settingsDirty: unsaved });
    return () => useApp.setState({ settingsDirty: false });
  }, [unsaved]);
  async function save() {
    const archivePath = full(archiveDir);
    if (archivePath && !isAbsolutePath(archivePath)) {
      setError(
        `Use a full archive folder path like ~/archive or ${joinPath(OTHER_DRIVE, "backup", "archive")}`,
      );
      return;
    }
    const reportsPath = full(reportsDir);
    if (!first && reportsPath && !isAbsolutePath(reportsPath)) {
      setError("Use a full reports folder path like ~/notes/agent-reports");
      return;
    }
    // The design is saved before the setup, so the window first run opens on is the one picked.
    if (first && !chooseDesign(look)) return;
    await run(
      async () => {
        setSaving(true);
        setError("");
        if (first) useApp.setState({ setupPending: true });
        try {
          const result = await api<Change>("setup/save", {
            roots: [...roots],
            archiveDir: archivePath,
            // First-run setup does not show this field, so it keeps whatever is saved.
            ...(first ? {} : { reportsDir: reportsPath }),
            presets: [...presets],
            apps,
            terminalTarget,
          });
          // The choice about new versions is the person's own: saved with the setup, never by Skip.
          // A refusal joins the setup's toast, which keeps its Undo.
          const refused = first ? await saveUpdates(updates) : "";
          changed(
            refused
              ? { ...result, warnings: [...(result.warnings ?? []), refused] }
              : result,
            first ? "All set" : "Settings saved",
          );
          setSaved({
            roots,
            archiveDir: archivePath,
            reportsDir: reportsPath,
            presets,
            apps,
            terminalTarget,
          });
          useApp.setState({
            apps,
            terminalTarget,
            ...(first ? { view: "today" as const } : {}),
          });
        } catch (error) {
          if (first) useApp.setState({ setupPending: false });
          throw error;
        } finally {
          setSaving(false);
        }
      },
      first ? "Scanning your projects…" : "Saving and scanning…",
      {
        history: true,
        onError: (error) => setError(errorText(error)),
      },
    );
  }
  const content = (
    <div className={`setup-in ${first ? "" : "in-app"}`}>
      {first ? (
        <>
          <span className="logo">
            <LaciMark size={64} />
          </span>
          <h1>{firstRun.welcome}</h1>
          <p className="lead">
            Laci is a file manager that knows which folders are projects: their
            git state, README, to-dos and the AI sessions that worked on them.
            Tell it where to look.
          </p>
        </>
      ) : null}
      {!info ? (
        <div className="empty">{error || "Loading your settings…"}</div>
      ) : (
        <>
          {first && OS === "macos" && info.translocated ? (
            <Note warn title={firstRun.moveTitle}>
              <p>{firstRun.moveBody}</p>
            </Note>
          ) : null}
          {first && info.git === false ? (
            <Note warn title={firstRun.installTitle(GIT)}>
              <p>{firstRun.installBody(GIT)}</p>
              {OS === "macos" ? (
                <p>
                  {firstRun.installMac}{" "}
                  <code className="mono">{MAC_INSTALL}</code>
                </p>
              ) : null}
              <button
                className="linkbtn"
                onClick={() => urlOpen(GIT_DOWNLOADS)}
              >
                {firstRun.installLink}
              </button>
            </Note>
          ) : null}
          <section className="sset">
            <h2>
              <span className="num">1</span>Where do you keep projects?
            </h2>
            <p>
              {/* First run writes the name as a name; Detailed's Settings stay as they were. */}
              {first ? "Laci" : "laci"} looks for projects in these folders,
              including mounted drives. You can leave every folder unchecked and
              browse without scanning.
            </p>
            {first && OS === "macos" ? (
              <Note title={firstRun.folderAccessTitle}>
                <p>{firstRun.folderAccess}</p>
              </Note>
            ) : null}
            {candidates.map((c) => {
              const unavailable = info.rootStatus?.find(
                (root) => root.path === c.path && !root.available,
              );
              return (
                <label className="opt" key={c.path}>
                  <input
                    type="checkbox"
                    className="cb"
                    checked={roots.has(c.path)}
                    onChange={() => toggle(roots, c.path, setRoots)}
                  />
                  <span className="mono">{tilde(c.path, snapshot.home)}</span>
                  <span
                    className={`r ${c.repos && !unavailable ? "ok" : ""}`}
                    title={unavailable?.reason}
                  >
                    {unavailable
                      ? "Unavailable"
                      : c.repos === null
                        ? "added by you"
                        : c.repos
                          ? plural(c.repos, "git repo")
                          : "no repos"}
                  </span>
                </label>
              );
            })}
            <button
              className="btn sm"
              disabled={discovering}
              onClick={() => {
                setDiscovering(true);
                setError("");
                void api<Pick<SetupInfo, "candidates">>("setup/discover")
                  .then(
                    (result) =>
                      setInfo((current) =>
                        current
                          ? { ...current, candidates: result.candidates }
                          : current,
                      ),
                    (error) => setError(errorText(error)),
                  )
                  .finally(() => setDiscovering(false));
              }}
            >
              {discovering ? "Looking for folders…" : "Suggest folders"}
            </button>
            <form
              className="addrow"
              onSubmit={(e) => {
                e.preventDefault();
                addFolder(folder);
              }}
            >
              <input
                className="inp mono"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder={`~/work or ${joinPath(OTHER_DRIVE, "projects")}`}
                autoComplete="off"
                aria-label="Another folder"
              />
              {/* A folder chosen is added at once: nothing is left in the box to add after it. */}
              <ChooseFolder
                label={said.choose}
                title={said.addFolderTitle}
                defaultPath={folder.trim() || "~"}
                onPick={(path) => addFolder(path, true)}
              />
              <button className="btn">Add folder</button>
            </form>
            <label className="fld">
              <span>Default archive folder</span>
              {/* A box and its button in a row, spaced as the box was alone in its field. */}
              <div className="addrow" style={{ margin: 0 }}>
                <input
                  className="inp mono"
                  value={archiveDir}
                  onChange={(e) => setArchiveDir(e.target.value)}
                  placeholder="Nearest _archive folder"
                  autoComplete="off"
                  aria-label="Default archive folder"
                />
                <ChooseFolder
                  label={said.choose}
                  title={said.archiveFolderTitle}
                  defaultPath={archiveDir.trim() || "~"}
                  onPick={(path) => setArchiveDir(tilde(path, snapshot.home))}
                />
              </div>
              <small>
                Leave empty to use the nearest _archive folder. A custom folder
                can be on another drive; each project gets its own subfolder.
                You can choose a different destination when archiving.
              </small>
            </label>
          </section>
          <section className="sset">
            <h2>
              <span className="num">2</span>Which AI tools do you use?
            </h2>
            <p>
              Their sessions show on each project and move with it. Other tools
              can be added in Agents.
            </p>
            {catalog.map((c) => (
              <label className="opt" key={c.id}>
                <input
                  type="checkbox"
                  className="cb"
                  checked={presets.has(c.id)}
                  onChange={() => toggle(presets, c.id, setPresets)}
                />
                <span>{c.name}</span>
                <span className="sub">{c.about}</span>
                <span className={`r ${c.found ? "ok" : ""}`}>
                  {c.found ? "found on this PC" : "no history here yet"}
                </span>
              </label>
            ))}
            {!first && snapshot.backup ? (
              <label className="opt">
                <input
                  type="checkbox"
                  className="cb"
                  checked={snapshot.backup.auto}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void run(async () => {
                      const result = await api<{ snapshot?: Snapshot }>(
                        "backup/auto",
                        { on },
                      );
                      if (result.snapshot)
                        acknowledge({ snapshot: result.snapshot });
                    });
                  }}
                />
                <span>Back up agent history automatically</span>
                <span className="sub">
                  Copies new and changed session logs to Laci's own folder at
                  most once an hour. Nothing is ever removed from the backup.
                </span>
              </label>
            ) : null}
          </section>
          <section className="sset">
            <h2>
              <span className="num">3</span>Open things with
            </h2>
            <p>What the Editor, Files and external terminal buttons launch.</p>
            <label className="fld">
              <span>Default terminal target</span>
              <Select
                label="Default terminal target"
                value={terminalTarget}
                onValueChange={(value) =>
                  setTerminalTarget(value as TerminalTarget)
                }
                options={[
                  { value: "internal", label: "Laci terminal" },
                  { value: "external", label: "External terminal" },
                ]}
              />
              <small>You can choose a different target for each launch.</small>
            </label>
            <div className="apps">
              {(
                [
                  ["editor", "Editor"],
                  ["files", "File manager"],
                  ["terminal", "Terminal"],
                ] as const
              ).map(([key, label]) => (
                <label className="fld" key={key}>
                  <span>{label}</span>
                  <Select
                    label={label}
                    value={apps[key]}
                    onValueChange={(value) =>
                      setApps({ ...apps, [key]: value })
                    }
                    options={[
                      ...new Set([...info.installed[key], apps[key]]),
                    ].map((app) => ({
                      value: app,
                      label: `${APP_NAMES[app] ?? cap(app)}${info.installed[key].includes(app) ? "" : " (not installed)"}`,
                    }))}
                  />
                </label>
              ))}
            </div>
          </section>
          {first ? (
            <>
              <section className="sset">
                <h2 id={updatesTitle}>
                  <span className="num">4</span>
                  {firstRun.updatesTitle}
                </h2>
                <p>{firstRun.updatesSends}</p>
                <div
                  className="choices"
                  role="radiogroup"
                  aria-labelledby={updatesTitle}
                  data-ui="updates-choice"
                >
                  {(["daily", "off"] as const).map((value) => (
                    <label className="choice" key={value}>
                      <input
                        type="radio"
                        name="updates"
                        value={value}
                        checked={updates === value}
                        onChange={() => setUpdates(value)}
                      />
                      <div>
                        <b>{firstRun.updates[value]}</b>
                        <p>{firstRun.updatesNotes[value]}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </section>
              <section className="sset">
                <h2 id={lookTitle}>
                  <span className="num">5</span>
                  {firstRun.lookTitle}
                </h2>
                <p>{views.anyTime}</p>
                <LookPicker
                  form
                  value={look}
                  onChange={setLook}
                  labelledBy={lookTitle}
                />
              </section>
            </>
          ) : (
            <>
              <ReportsSetting
                value={reportsDir}
                onChange={setReportsDir}
                draft={full(reportsDir)}
              />
              <Appearance />
              <UpdatesSetting />
            </>
          )}
        </>
      )}
      <div className="setup-foot">
        {error || (first && s.error) ? (
          <p className="err" role="alert">
            {error || s.error}
          </p>
        ) : (
          <p>
            Saved in {configPath}.
            {first ? " Change it any time in Settings." : ""}
          </p>
        )}
        {first ? (
          <button
            className="btn ghost"
            disabled={saving}
            onClick={() => {
              // Skipping keeps the design picked, so the first save in Settings can't change it.
              if (chooseDesign(look)) useApp.setState({ skipSetup: true });
            }}
          >
            Skip for now
          </button>
        ) : null}
        <button
          className="btn primary"
          disabled={
            !info ||
            saving ||
            (!retryScan && (s.historyPending || s.setupPending))
          }
          onClick={() => (retryScan ? rescan() : void save())}
        >
          {saving
            ? "Saving…"
            : retryScan
              ? "Try again"
              : s.setupPending
                ? "Scanning your projects…"
                : first
                  ? firstRun.start
                  : "Save and rescan"}
        </button>
      </div>
    </div>
  );
  // First run is the whole window, so it is the page's main landmark.
  return first ? (
    <main
      className="setup"
      id="main"
      tabIndex={-1}
      inert={Boolean(s.modal || s.palette || s.working)}
    >
      {content}
    </main>
  ) : (
    <>
      <div className="head">
        <h1>Settings</h1>
      </div>
      <div className="body">{content}</div>
    </>
  );
}
function ReportsSetting({
  value,
  onChange,
  draft,
}: {
  value: string;
  onChange: (value: string) => void;
  draft: string;
}) {
  const snapshot = useApp((s) => s.snapshot!);
  useNow();
  const saved = snapshot.reportsDir;
  const newest = reportList(snapshot)[0];
  const [tone, status] =
    draft !== (saved?.path ?? "")
      ? [
          "",
          draft
            ? "Save to read reports from this folder."
            : "Save to stop showing reports.",
        ]
      : saved?.error
        ? ["bad", `Laci can’t read this folder: ${saved.error}`]
        : saved
          ? [
              "ok",
              `${plural(saved.total ?? 0, "report")} found${newest ? ` · newest ${shortDay(newest.date)}` : ""}`,
            ]
          : ["", "Leave empty to keep Reports hidden."];
  return (
    <section className="sset">
      <h2>
        <span className="num">4</span>Session reports
      </h2>
      <p>
        Agents can write a short report when a session ends. Laci lists them in
        Reports, links each to its session and projects, shows what they left
        open on Today, and lets agents read them through its MCP tools. Laci
        never changes the folder.
      </p>
      <label className="fld">
        <span>Reports folder</span>
        <div className="addrow" style={{ margin: 0 }}>
          <input
            className="inp mono"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="~/notes/agent-reports"
            autoComplete="off"
            aria-label="Reports folder"
          />
          <ChooseFolder
            label={said.choose}
            title={said.reportsFolderTitle}
            defaultPath={value.trim() || "~"}
            onPick={(path) => onChange(tilde(path, snapshot.home))}
          />
        </div>
        <small className={`rp-status ${tone}`}>{status}</small>
      </label>
      <div className="rp-copy">
        <button
          className="btn sm"
          disabled={!isAbsolutePath(draft)}
          onClick={() =>
            copyText(
              agentInstruction(tilde(draft, snapshot.home)),
              "Agent instruction copied",
              "Paste it into CLAUDE.md, AGENTS.md or GEMINI.md",
            )
          }
        >
          <Icon name="copy" className="sm" />
          Copy agent instruction
        </button>
        <small className="faint">
          The rule that makes an agent write these reports, with this folder
          filled in. Paste it where your agent reads its instructions:
          CLAUDE.md, AGENTS.md or GEMINI.md.
        </small>
      </div>
    </section>
  );
}
/**
 * A note first run shows for this computer. What is missing is amber, with the sign Simple gives
 * "Soon", so the colour is never the only sign; the rest is plain information.
 */
function Note({
  title,
  warn = false,
  children,
}: {
  title: string;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`setup-note${warn ? " warn" : ""}`} data-ui="status">
      <Icon name={warn ? "circle-alert" : "info"} />
      <div>
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}
const THEMES: [Theme, string][] = [
  ["system", "monitor"],
  ["light", "sun"],
  ["dark", "moon"],
];
/**
 * Settings › Appearance: the design and the theme. Both change at once, as the toggles at the foot
 * of the sidebar do; the rest of Settings waits for Save and rescan.
 */
function Appearance() {
  const design = useApp((s) => s.design);
  const theme = useApp((s) => s.theme);
  const title = useId();
  const view = useId();
  const themes = useId();
  return (
    <section className="sset" aria-labelledby={title} data-ui="appearance">
      <h2 id={title}>
        <span className="num">5</span>
        {views.appearance}
      </h2>
      <p>{views.appearanceIntro}</p>
      <div className="fld">
        <span id={view}>{views.view}</span>
        <LookPicker value={design} onChange={setDesign} labelledBy={view} />
      </div>
      <div className="fld">
        <span id={themes}>{views.theme}</span>
        <div className="look-themes" role="group" aria-labelledby={themes}>
          {THEMES.map(([value, icon]) => (
            <button
              type="button"
              key={value}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              <Icon name={icon} />
              {views.themes[value]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
/** The one button of About & updates, by what it does. */
type UpdateAction = "check" | "install" | "restart" | "release";
/** Where an update stands as About & updates says it, and the one button that moves it on. */
export interface UpdateView {
  /** Where it stands, in a sentence. */
  line: string;
  /** The sentence tells of a failure. */
  bad: boolean;
  action: { kind: UpdateAction; label: string; busy: boolean };
  /** What the button's choice needs said beside it; empty when nothing does. */
  hint: string;
}
/**
 * Where an update stands, from what the desktop last said (null before it said anything), at `now`.
 * The button looks for a new version, installs the one found, restarts to finish it, or, for a copy
 * Laci can't replace itself, opens the page of the release.
 */
export function updateView(
  status: UpdateStatus | null,
  now = Date.now(),
): UpdateView {
  const check: UpdateView["action"] = {
    kind: "check",
    label: said.check,
    busy: false,
  };
  if (!status)
    return { line: said.reading, bad: false, action: check, hint: "" };
  const version = status.version ?? "";
  // A copy that can't install an update links to its release; with no address to link, all the
  // button can do is look again.
  const install: UpdateView["action"] =
    status.install === "click"
      ? { kind: "install", label: said.install, busy: false }
      : status.url
        ? { kind: "release", label: said.releasePage, busy: false }
        : check;
  const hint = status.install === "notice" && version ? said.noticeNote : "";
  switch (status.state) {
    case "checking":
      return {
        line: said.looking,
        bad: false,
        action: { ...check, label: said.checking, busy: true },
        hint: "",
      };
    case "available":
      return {
        line: said.available(version, ago(status.date, now)),
        bad: false,
        action: install,
        hint,
      };
    case "downloading":
      return {
        line: said.downloading(version, status.progress),
        bad: false,
        action: { kind: "install", label: said.installing, busy: true },
        hint: "",
      };
    case "ready":
      return {
        line: said.ready(version),
        bad: false,
        action: { kind: "restart", label: said.restart, busy: false },
        hint: said.restartNote,
      };
    case "error":
      // A download that failed keeps its version, so the same button tries it again.
      return {
        line: status.error || said.failed,
        bad: true,
        action: !version
          ? check
          : install.kind === "install"
            ? { ...install, label: said.retry }
            : install,
        hint,
      };
    default:
      return {
        line: status.checkedAt
          ? said.upToDate(ago(status.checkedAt, now))
          : said.neverLooked,
        bad: false,
        action: check,
        hint: "",
      };
  }
}
/**
 * Settings › About & updates: the version, where an update stands with the one button that moves it
 * on, the notes of a new version, and how often Laci looks. The desktop does all of it (update.ts).
 * Like Appearance it changes at once; the rest of Settings waits for Save and rescan.
 */
function UpdatesSetting() {
  const status = useUpdate((s) => s.status);
  const refusal = useUpdate((s) => s.refusal);
  const prefs = usePrefs(true);
  const now = useNow();
  const [pending, setPending] = useState(false);
  // The choice just made, which is newer than what the saved choices said when this opened.
  const [picked, setPicked] = useState<Updates | null>(null);
  const title = useId();
  const choiceTitle = useId();
  const macNote = useId();
  useEffect(() => {
    void useUpdate.getState().refresh();
  }, []);
  const view = updateView(status, now);
  const busy = pending || view.action.busy;
  // Undefined until the desktop says; null while nothing is chosen.
  const saved = picked ?? (status?.enabled ? "daily" : prefs?.updates);
  // An app signed ad hoc is a new app to macOS after each update, so it asks again for the folders.
  const mac = OS === "macos" && Boolean(status?.version);
  function act() {
    if (busy) return;
    const { kind } = view.action;
    if (kind === "release") {
      if (status?.url) urlOpen(status.url);
      return;
    }
    const update = useUpdate.getState();
    setPending(true);
    void update[kind]().finally(() => setPending(false));
  }
  async function choose(updates: Updates) {
    if (!(await useUpdate.getState().choose(updates))) return;
    setPicked(updates);
    toast(said.updatesSaved[updates]);
  }
  return (
    <section
      className="sset"
      id="settings-updates"
      tabIndex={-1}
      aria-labelledby={title}
      data-ui="updates"
    >
      <h2 id={title}>
        <span className="num">6</span>
        {said.updatesTitle}
      </h2>
      <p>{said.updatesIntro}</p>
      {status ? (
        <p data-ui="update-version">{said.version(status.current)}</p>
      ) : null}
      <p
        role="status"
        className={view.bad ? "rp-status bad" : undefined}
        data-ui="update-status"
      >
        {view.line}
      </p>
      {mac ? (
        <Note title={said.macTitle}>
          <p id={macNote}>{said.macBody}</p>
        </Note>
      ) : null}
      <div className="rp-copy">
        <button
          type="button"
          className="btn"
          data-ui="update-action"
          aria-busy={busy || undefined}
          aria-describedby={mac ? macNote : undefined}
          onClick={act}
        >
          {view.action.label}
        </button>
        {refusal ? (
          <small className="rp-status bad" role="alert">
            {refusal}
          </small>
        ) : view.hint ? (
          <small className="faint">{view.hint}</small>
        ) : null}
      </div>
      {status?.version && status.notes ? (
        <ReleaseNotes version={status.version} notes={status.notes} />
      ) : null}
      <div className="fld">
        <span id={choiceTitle}>{said.updatesChoice}</span>
        <div
          className="choices"
          role="radiogroup"
          aria-labelledby={choiceTitle}
          data-ui="updates-choice"
        >
          {(["daily", "off"] as const).map((value) => (
            <label className="choice" key={value}>
              <input
                type="radio"
                name="updates"
                value={value}
                checked={saved === value}
                onChange={() => void choose(value)}
              />
              <div>
                <b>{firstRun.updates[value]}</b>
                <p>{firstRun.updatesNotes[value]}</p>
              </div>
            </label>
          ))}
        </div>
        {saved === null ? <small>{said.updatesUnset}</small> : null}
        <small>{firstRun.updatesSends}</small>
      </div>
    </section>
  );
}
/** The folder a README is read in. Release notes have none: an image they name by a path is nowhere. */
const NOTES_FOLDER = "/release-notes";
/**
 * The notes of a new version, drawn as a README is: marked and DOMPurify load when they are first
 * needed, and the text is never shown raw while they do. Images from the web wait for a click.
 */
function ReleaseNotes({ version, notes }: { version: string; notes: string }) {
  const markdown = useMarkdown();
  const [remoteFor, setRemoteFor] = useState<string>();
  const loadRemote = remoteFor === version;
  const { html, remote } = useMemo(
    () =>
      markdown?.renderReadme(notes, NOTES_FOLDER, loadRemote) ?? {
        html: "",
        remote: 0,
      },
    [markdown, notes, loadRemote],
  );
  return (
    <>
      <h3 className="sec-t">{said.whatsNew(version)}</h3>
      {remote && !loadRemote ? (
        <div className="readme-note">
          <span>{said.remoteImages(remote)}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => setRemoteFor(version)}
          >
            {said.loadImages}
          </button>
        </div>
      ) : null}
      <div
        className="readme"
        data-ui="release-notes"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) =>
          markdown?.proseClick(e, {
            remote: () => setRemoteFor(version),
            blocked: said.notesBlocked,
            relative: () => toast("Link not opened", said.notesBlocked),
          })
        }
      />
    </>
  );
}
