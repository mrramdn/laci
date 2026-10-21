// Simple's Settings (design-research §3.3): how Laci looks, the project folders, AI, apps, updates,
// the technical part and About. How Laci looks, the update choice and the copy of AI chats change at
// once, each through its own request; the project folders, AI tools, summaries folder and apps wait
// for the filled "Save changes", which sends them all through `setup/save` as Detailed's Settings
// does, with Undo in Activity. Updates also says where the update stands, with the one button that
// moves it on (updates.tsx).
import "./settings.css";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, SetStateAction, SyntheticEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api, errorText } from "../api";
import { LaciMark } from "../brand";
import { Icon } from "../common";
import { agentInstruction, base, isWholeDisk, tilde } from "../helpers";
import { ChooseFolder } from "../pick";
import {
  changed,
  copyText,
  refreshLog,
  run,
  setDesign,
  setTheme,
  toast,
  urlOpen,
  useApp,
} from "../store";
import type { Theme } from "../store";
import type { Apps, Change, Prefs, SetupInfo, Snapshot } from "../types";
import { aiHelpers, help, settings as said, shell } from "../words";
import { aiTools } from "./act";
import {
  setCopying,
  showTools,
  useCapabilities,
  useFocusStays,
  useHelpers,
} from "./AiHelpers";
import {
  appChoices,
  catalogTools,
  draftChanged,
  draftOf,
  startsWith,
  suggestedFolders,
  summariesFolder,
  UPDATE_CHOICES,
  withoutRoot,
  withRoot,
  withTool,
} from "./model";
import type { SettingsDraft, UpdateChoice } from "./model";
import { Button, Callout, Card, Info, StatusChip } from "./ui";
import { refreshUpdate, UpdatePanel, useCheckNowShown } from "./updates";

/** A change to the draft, as a value or from the draft as it is then. */
type Edit = (change: SetStateAction<SettingsDraft>) => void;
/** The controls a click or a change on the page comes from. */
const CONTROL = "button, input, select, textarea, a[href]";

export function SettingsPage() {
  const snapshot = useApp((s) => s.snapshot!);
  const revision = useApp((s) => s.revision);
  const busy = useApp((s) => s.historyPending || s.setupPending);
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [saved, setSaved] = useState<SettingsDraft | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [failed, setFailed] = useState("");
  const [saveError, setSaveError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const dirty = Boolean(draft && saved && draftChanged(draft, saved));
  const waiting = useRef(dirty);
  waiting.current = dirty;
  // Detailed's Settings would start without these changes, so a switch of design waits for them.
  useEffect(() => {
    useApp.setState({ settingsDirty: dirty });
    return () => useApp.setState({ settingsDirty: false });
  }, [dirty]);
  const page = useRef<HTMLDivElement>(null);
  // The control you used last: when the bar with Save changes and Discard goes, the focus goes back
  // there rather than on to the last control of the page. Tabbing on to the bar passes everything
  // after that control, so only a click or a change counts; when the control you used goes (a folder
  // you removed), the one the focus moved on to takes its place.
  const before = useRef<HTMLElement | null>(null);
  const used = (event: SyntheticEvent) => {
    const control = (event.target as HTMLElement).closest<HTMLElement>(CONTROL);
    if (control && !control.closest(".s-savebar")) before.current = control;
  };
  useFocusStays(page, (control) => (control.closest(".s-savebar") ? before.current : undefined));
  // What is saved, read again when the engine changes something (an Undo, say), unless changes wait.
  useEffect(() => {
    if (waiting.current) return;
    let live = true;
    api<SetupInfo>("setup/info").then(
      (next) => {
        if (!live) return;
        setInfo(next);
        setFailed("");
        // Changes begun while it was read wait too: what is saved would undo them.
        if (waiting.current) return;
        setSaved(draftOf(next));
        setDraft(draftOf(next));
      },
      (error) => {
        if (live) setFailed(errorText(error));
      },
    );
    return () => {
      live = false;
    };
  }, [revision, attempt]);
  useEffect(() => {
    let live = true;
    api<Prefs>("prefs").then(
      (next) => {
        if (live) setPrefs(next);
      },
      // The update choice and the settings file then show as unknown.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const edit: Edit = (change) =>
    setDraft((current) =>
      current ? (typeof change === "function" ? change(current) : change) : current,
    );
  const save = () => {
    if (!draft) return;
    void run(
      async () => {
        setSaveError("");
        const result = await api<Change>("setup/save", { ...draft });
        useApp.setState({ apps: draft.apps, terminalTarget: draft.terminalTarget });
        changed(result, said.saved, said.savedNote);
        const next = await api<SetupInfo>("setup/info");
        setInfo(next);
        setSaved(draftOf(next));
        setDraft(draftOf(next));
      },
      said.saving,
      { history: true, onError: (error) => setSaveError(errorText(error)) },
    );
  };
  return (
    <div
      ref={page}
      className="s-page s-settings"
      onClick={used}
      onChange={used}
      onFocus={(event) => {
        if (!before.current?.isConnected) used(event);
      }}
    >
      <header className="s-head">
        <h1>{said.title}</h1>
        <p className="s-lead">{said.lead}</p>
      </header>
      <Appearance />
      {info && draft ? (
        <>
          <ProjectsCard snapshot={snapshot} info={info} draft={draft} edit={edit} />
          <AiCard snapshot={snapshot} draft={draft} edit={edit} />
          <AppsCard info={info} draft={draft} edit={edit} />
        </>
      ) : (
        <section className="s-card" aria-busy={!failed}>
          {failed ? (
            <>
              <Callout tone="soon">{said.failed}</Callout>
              <p className="s-quiet">{failed}</p>
              <Button
                kind="outline"
                small
                icon="refresh-cw"
                onClick={() => setAttempt((n) => n + 1)}
              >
                {said.tryAgain}
              </Button>
            </>
          ) : (
            <p className="s-working" role="status">
              <span className="s-spinner" aria-hidden="true" />
              {said.loading}
            </p>
          )}
        </section>
      )}
      <UpdatesCard prefs={prefs} onPrefs={setPrefs} />
      <TechnicalCard prefs={prefs} />
      <AboutCard />
      {/* Said once, as the bar comes: the bar itself is not read out each time it changes. */}
      <p className="sr-only" role="status">
        {dirty ? said.unsaved : ""}
      </p>
      {dirty ? (
        <div className="s-savebar" role="region" aria-label={said.save}>
          {saveError ? (
            <div className="s-savebar-error" role="alert">
              <Callout tone="act">{saveError}</Callout>
            </div>
          ) : (
            <p>{said.unsaved}</p>
          )}
          <div className="s-actions">
            <Button
              kind="text"
              onClick={() => {
                setSaveError("");
                setDraft(saved);
                // What is saved may have changed while the changes waited: read it again.
                setAttempt((n) => n + 1);
              }}
            >
              {said.discard}
            </Button>
            <Button kind="filled" icon="check" disabled={busy} onClick={save}>
              {said.save}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A part of a card: its heading, and the ⓘ that explains it. */
function Subhead({ id, title, info }: { id?: string; title: string; info?: string }) {
  return (
    <div className="s-subhead">
      <h3 id={id}>{title}</h3>
      {info ? <Info term={info} /> : null}
    </div>
  );
}

/**
 * Radio buttons for one choice. The arrow keys move between them and choose, as radios do, so a
 * choice made here must be one that is safe to make on each key.
 */
function Choices<T extends string>({
  title,
  info,
  name,
  value,
  options,
  disabled = false,
  onChange,
  children,
}: {
  title: string;
  info?: string;
  name: string;
  value: T | null;
  options: readonly { value: T; label: string; note?: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className="s-set-group" aria-labelledby={id}>
      <Subhead id={id} title={title} info={info} />
      <div className="s-set-options">
        {options.map((option) => (
          <label key={option.value} className="s-set-option">
            <input
              type="radio"
              className="s-set-radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span>
              <b>{option.label}</b>
              {option.note ? <span className="s-quiet">{option.note}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
}

// --- Appearance ----------------------------------------------------------------------------------

const DESIGNS = ["simple", "detailed"] as const;
const THEMES: readonly Theme[] = ["system", "light", "dark"];

/**
 * The view and the theme, which change at once. The view is a pair of buttons, not radios: an arrow
 * key would switch the whole window while the user only moves through the choices.
 */
function Appearance() {
  const design = useApp((s) => s.design);
  const theme = useApp((s) => s.theme);
  const view = useId();
  return (
    <Card title={said.appearance} icon="sun">
      <p className="s-quiet">{said.appearanceNote}</p>
      <div className="s-set-group" role="group" aria-labelledby={view}>
        <Subhead id={view} title={said.view} />
        <div className="s-set-options">
          {DESIGNS.map((choice) => (
            <button
              key={choice}
              type="button"
              className="s-set-option s-set-view"
              aria-pressed={design === choice}
              onClick={() => setDesign(choice)}
            >
              <span className="s-set-mark" aria-hidden="true">
                <Icon name="check" />
              </span>
              <span>
                <b>{said.designs[choice]}</b>
                <span className="s-quiet">{said.designNotes[choice]}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="s-quiet">{said.viewNote}</p>
      </div>
      <Choices
        title={said.theme}
        name="theme"
        value={theme}
        options={THEMES.map((value) => ({ value, label: shell.themes[value] }))}
        onChange={setTheme}
      />
    </Card>
  );
}

// --- Projects ------------------------------------------------------------------------------------

function ProjectsCard({
  snapshot,
  info,
  draft,
  edit,
}: {
  snapshot: Snapshot;
  info: SetupInfo;
  draft: SettingsDraft;
  edit: Edit;
}) {
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<{ path: string; repos: number }[] | null>(null);
  const home = snapshot.home;
  const unavailable = (path: string) =>
    info.rootStatus?.find((root) => root.path === path && !root.available);
  const suggest = () => {
    setLooking(true);
    void api<Pick<SetupInfo, "candidates">>("setup/discover")
      .then(
        (result) => setFound(result.candidates),
        (error) => toast(said.suggest, errorText(error), { error: true }),
      )
      .finally(() => setLooking(false));
  };
  const offered = found ? suggestedFolders(found, draft.roots) : [];
  return (
    <Card title={said.projects} icon="folder-kanban">
      <Subhead title={said.folders} info="project-folders" />
      <p className="s-quiet">{said.foldersNote}</p>
      {draft.roots.length ? (
        <ul className="s-set-list">
          {draft.roots.map((root) => {
            const away = unavailable(root);
            return (
              <li key={root} className="s-set-row">
                <span className="s-set-row-text">
                  <b>{base(root) || root}</b>
                  <span className="s-mono s-quiet">{tilde(root, home)}</span>
                </span>
                {away ? (
                  <StatusChip tone="soon" title={away.reason}>
                    {said.unavailable}
                  </StatusChip>
                ) : null}
                <Button
                  kind="text"
                  small
                  aria-label={said.removeFor(tilde(root, home))}
                  onClick={() => edit((d) => withoutRoot(d, root))}
                >
                  {said.remove}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>{said.noFolders}</p>
      )}
      <div className="s-actions">
        <ChooseFolder
          className="s-btn s-btn-outline s-btn-small"
          label={said.addFolder}
          name={said.addFolderName}
          title={said.addFolderTitle}
          defaultPath="~"
          onPick={(path) => {
            // A whole disk ("/") isn't a folder Laci looks through.
            if (isWholeDisk(path))
              toast(said.wholeDisk, said.wholeDiskNote, { error: true });
            else edit((d) => withRoot(d, path));
          }}
        />
        <Button kind="text" small icon="search" disabled={looking} onClick={suggest}>
          {looking ? said.suggesting : said.suggest}
        </Button>
      </div>
      {found ? (
        <div className="s-set-found" aria-live="polite">
          <h4>{said.suggestions}</h4>
          {offered.length ? (
            <ul className="s-set-list">
              {offered.map((folder) => (
                <li key={folder.path} className="s-set-row">
                  <span className="s-set-row-text">
                    <b>{base(folder.path) || folder.path}</b>
                    <span className="s-quiet">
                      <span className="s-mono">{tilde(folder.path, home)}</span>
                      {" · "}
                      {said.holds(folder.repos)}
                    </span>
                  </span>
                  <Button
                    kind="outline"
                    small
                    icon="plus"
                    aria-label={said.addFor(tilde(folder.path, home))}
                    onClick={() => edit((d) => withRoot(d, folder.path))}
                  >
                    {said.add}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="s-quiet">{said.noSuggestions}</p>
          )}
        </div>
      ) : null}
      <Subhead title={said.archive} info="archive" />
      <p>
        {draft.archiveDir ? (
          <span className="s-mono">{tilde(draft.archiveDir, home)}</span>
        ) : (
          said.archiveNearest
        )}
      </p>
      <div className="s-actions">
        <ChooseFolder
          className="s-btn s-btn-outline s-btn-small"
          label={said.chooseArchive}
          name={said.chooseArchiveName}
          title={said.chooseArchiveTitle}
          defaultPath={draft.archiveDir || "~"}
          onPick={(path) => edit((d) => ({ ...d, archiveDir: path }))}
        />
        {draft.archiveDir ? (
          <Button kind="text" small onClick={() => edit((d) => ({ ...d, archiveDir: "" }))}>
            {said.useNearest}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

// --- AI ------------------------------------------------------------------------------------------

function AiCard({
  snapshot,
  draft,
  edit,
}: {
  snapshot: Snapshot;
  draft: SettingsDraft;
  edit: Edit;
}) {
  const historyPending = useApp((s) => s.historyPending);
  const launchable = aiTools(snapshot);
  const caps = useCapabilities(launchable.map((tool) => tool.value));
  const home = snapshot.home;
  const backup = snapshot.backup;
  const folder = summariesFolder(draft.reportsDir, snapshot.reportsDir);
  const status =
    folder === "unsaved"
      ? draft.reportsDir
        ? said.summariesFolder.unsaved
        : ""
      : folder === "unreadable"
        ? said.summariesFolder.unreadable(snapshot.reportsDir?.error ?? "")
        : folder === "read"
          ? said.summariesFolder.read(snapshot.reportsDir?.total ?? 0)
          : "";
  return (
    <Card title={said.ai} icon="sparkles">
      <Subhead title={said.aiTools} info="showing-chats" />
      <p className="s-quiet">{said.aiToolsNote}</p>
      <ul className="s-set-list">
        {catalogTools(snapshot).map((tool) => (
          <li key={tool.id} className="s-set-row">
            <label className="s-set-check">
              <input
                type="checkbox"
                className="s-cb"
                checked={draft.presets.includes(tool.id)}
                onChange={(event) => {
                  const on = event.target.checked;
                  edit((d) => withTool(d, tool.id, on));
                }}
              />
              <span className="s-set-row-text">
                <b>{tool.name}</b>
                <span className="s-quiet">{tool.found ? said.found : said.notFound}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {backup ? (
        <>
          <Subhead title={aiHelpers.copyTitle} info="copy-chats" />
          <label className="s-set-check">
            <input
              type="checkbox"
              className="s-cb"
              checked={backup.auto}
              disabled={historyPending}
              onChange={(event) => void setCopying(event.target.checked)}
            />
            <span className="s-set-row-text">
              <b>{aiHelpers.copyAuto}</b>
              <span className="s-quiet">{aiHelpers.copyAutoNote}</span>
            </span>
          </label>
        </>
      ) : null}
      <Subhead title={said.summaries} info="summary" />
      <p className="s-quiet">{said.summariesNote}</p>
      <p>
        {draft.reportsDir ? (
          <span className="s-mono">{tilde(draft.reportsDir, home)}</span>
        ) : (
          said.summariesFolder.off
        )}
      </p>
      {status ? (
        folder === "unreadable" ? (
          <Callout tone="soon">{status}</Callout>
        ) : (
          <p className="s-quiet">{status}</p>
        )
      ) : null}
      <div className="s-actions">
        <ChooseFolder
          className="s-btn s-btn-outline s-btn-small"
          label={said.chooseSummaries}
          name={said.chooseSummariesName}
          title={said.chooseSummariesTitle}
          defaultPath={draft.reportsDir || "~"}
          onPick={(path) => edit((d) => ({ ...d, reportsDir: path }))}
        />
        {draft.reportsDir ? (
          <>
            <Button
              kind="text"
              small
              icon="copy"
              onClick={() =>
                copyText(
                  agentInstruction(tilde(draft.reportsDir, home)),
                  aiHelpers.instructionCopied,
                  aiHelpers.instructionHint,
                )
              }
            >
              {aiHelpers.copyInstruction}
            </Button>
            <Button kind="text" small onClick={() => edit((d) => ({ ...d, reportsDir: "" }))}>
              {said.stopSummaries}
            </Button>
          </>
        ) : null}
      </div>
      {launchable.length ? (
        <>
          <Subhead title={said.models} info="thinking" />
          <p className="s-quiet">{said.modelsNote}</p>
          <ul className="s-set-list">
            {launchable.map((tool) => {
              const known = caps[tool.value];
              const start = startsWith(known);
              return (
                <li key={tool.value} className="s-set-row">
                  <span className="s-set-row-text">
                    <b>{tool.label}</b>
                    {known ? (
                      <span className="s-quiet">
                        {aiHelpers.startsWith(start.model ?? "", start.effort ?? "")}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <Button kind="text" small icon="sparkles" onClick={showTools}>
            {said.seeTools}
          </Button>
        </>
      ) : null}
    </Card>
  );
}

// --- Apps ----------------------------------------------------------------------------------------

const APPS: readonly (keyof Apps)[] = ["editor", "files", "terminal"];
const TARGETS = ["internal", "external"] as const;

function AppsCard({
  info,
  draft,
  edit,
}: {
  info: SetupInfo;
  draft: SettingsDraft;
  edit: Edit;
}) {
  return (
    <Card title={said.apps} icon="panels-top-left">
      <p className="s-quiet">{said.appsNote}</p>
      <div className="s-set-fields">
        {APPS.map((key) => (
          <label key={key} className="s-field">
            <span>{said.appNames[key]}</span>
            <select
              className="s-input s-set-select"
              value={draft.apps[key]}
              onChange={(event) => {
                const app = event.target.value;
                edit((d) => ({ ...d, apps: { ...d.apps, [key]: app } }));
              }}
            >
              {appChoices(info.installed[key], draft.apps[key]).map((choice) => (
                <option key={choice.app} value={choice.app}>
                  {choice.installed ? choice.name : said.notInstalledApp(choice.name)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <Choices
        title={said.chatsOpenIn}
        info="terminal"
        name="terminal-target"
        value={draft.terminalTarget}
        options={TARGETS.map((value) => ({
          value,
          label: said.targets[value],
          note: said.targetNotes[value],
        }))}
        onChange={(terminalTarget) => edit((d) => ({ ...d, terminalTarget }))}
      />
    </Card>
  );
}

// --- Updates -------------------------------------------------------------------------------------

/**
 * Where the update stands, with the one button that moves it on, and how often Laci looks for a new
 * version, which is saved at once through the `updates` request.
 */
function UpdatesCard({
  prefs,
  onPrefs,
}: {
  prefs: Prefs | null;
  onPrefs: (prefs: Prefs) => void;
}) {
  // "Use Check now" only while the panel above shows it.
  const checkNow = useCheckNowShown();
  const choose = (updates: UpdateChoice) =>
    void run(async () => {
      onPrefs(await api<Prefs>("updates", { updates }));
      toast(said.updatesSaved[updates]);
      // The desktop says so itself; this covers a window that missed it.
      refreshUpdate();
    });
  return (
    <Card title={said.updates} icon="refresh-cw">
      <UpdatePanel />
      <Choices
        title={said.updatesQuestion}
        name="updates"
        value={prefs?.updates ?? null}
        disabled={!prefs}
        options={UPDATE_CHOICES.map((value) => ({
          value,
          label: said.updateChoices[value],
          note:
            value === "off" && !checkNow ? said.updateNoteOffFound : said.updateNotes[value],
        }))}
        onChange={choose}
      >
        {prefs && !prefs.updates ? <p className="s-quiet">{said.updatesUnset}</p> : null}
        <p className="s-quiet">{said.updatesPrivacy}</p>
      </Choices>
    </Card>
  );
}

// --- Technical settings --------------------------------------------------------------------------

/**
 * Your own AI tool, the diagnostics log and the settings file, folded away until asked for: the part
 * design-research calls Advanced, a word Simple uses for nothing. AI helpers › Tools opens it when it
 * sends you here to add an AI tool.
 */
function TechnicalCard({ prefs }: { prefs: Prefs | null }) {
  const asked = useHelpers((s) => s.technical);
  const historyPending = useApp((s) => s.historyPending);
  const log = useApp((s) => s.activity?.file);
  const home = useApp((s) => s.snapshot?.home ?? "");
  const [open, setOpen] = useState(asked);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!asked) return;
    useHelpers.setState({ technical: false });
    setOpen(true);
    // After the window has scrolled to the top for the new page: then to here, with the focus.
    requestAnimationFrame(() => heading.current?.focus());
  }, [asked]);
  useEffect(() => {
    if (open && !useApp.getState().activity) void refreshLog();
  }, [open]);
  const configPath = prefs?.configPath;
  return (
    <section className="s-card s-set-technical" aria-labelledby="settings-technical">
      <header className="s-card-head">
        <Icon name="gear" />
        <h2 id="settings-technical" ref={heading} tabIndex={-1}>
          {said.technical}
        </h2>
      </header>
      <p className="s-quiet">{said.technicalNote}</p>
      <button
        type="button"
        className="s-btn s-btn-text s-disclosure-toggle"
        aria-expanded={open}
        aria-controls="settings-technical-body"
        onClick={() => setOpen(!open)}
      >
        {open ? said.hideTechnical : said.showTechnical}
        <Icon name="chevron-down" className={open ? "s-turned" : ""} />
      </button>
      <div id="settings-technical-body" className="s-disclosure-body" hidden={!open}>
        {open ? (
          <>
            <Subhead title={said.addTool} info="tool-link" />
            <p className="s-quiet">{said.addToolNote}</p>
            <Button
              kind="outline"
              small
              icon="plus"
              disabled={historyPending}
              onClick={() => useApp.setState({ modal: { kind: "connector" } })}
            >
              {said.addToolButton}
            </Button>
            <Subhead title={said.diagnostics} info="diagnostics" />
            <p className="s-quiet">{said.diagnosticsNote}</p>
            {log ? <p className="s-mono">{tilde(log, home)}</p> : null}
            <Button
              kind="outline"
              small
              icon="file"
              onClick={() => void run(() => api("log/open"))}
            >
              {said.openDiagnostics}
            </Button>
            <Subhead title={said.settingsFile} />
            <p className="s-quiet">{said.settingsFileNote}</p>
            {configPath ? (
              <>
                <p className="s-mono">{configPath}</p>
                <Button
                  kind="text"
                  small
                  icon="copy"
                  onClick={() => copyText(configPath, said.locationCopied, configPath)}
                >
                  {said.copyLocation}
                </Button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

// --- About ---------------------------------------------------------------------------------------

/** The version, Help and where to report a problem. */
function AboutCard() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    let live = true;
    getVersion().then(
      (value) => {
        if (live) setVersion(value);
      },
      // Without it, About says nothing of the version.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <Card title={said.about} icon="info">
      <div className="s-set-about">
        <LaciMark size={48} />
        <div>
          <p className="s-set-name">{said.name}</p>
          {version ? <p className="s-quiet">{said.version(version)}</p> : null}
        </div>
      </div>
      <p>{said.aboutLine}</p>
      <div className="s-actions">
        <Button
          kind="outline"
          icon="circle-help"
          onClick={() => useApp.getState().navigate("help")}
        >
          {said.openHelp}
        </Button>
        <Button kind="outline" icon="external-link" onClick={() => urlOpen(help.reportUrl)}>
          {said.report}
        </Button>
      </div>
    </Card>
  );
}
