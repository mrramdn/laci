import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { APP_NAMES, cap, plural, tilde } from "./helpers";
import { Select } from "./select";
import { Icon } from "./common";
import { useApp, acknowledge, changed, rescan, run } from "./store";
import type {
  Apps,
  Change,
  SetupInfo,
  Snapshot,
  TerminalTarget,
} from "./types";
export function Settings({ first = false }: { first?: boolean }) {
  const s = useApp();
  const snapshot = s.snapshot!;
  const [info, setInfo] = useState<SetupInfo | null>(null);
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
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const retryScan = first && s.setupPending && Boolean(s.error);
  useEffect(() => {
    let live = true;
    void api<SetupInfo>("setup/info").then(
      (info) => {
        if (!live) return;
        setInfo(info);
        setRoots(new Set(info.roots));
        setArchiveDir(info.archiveDir ?? "");
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
  async function save() {
    let archivePath = archiveDir.trim();
    if (archivePath === "~" || archivePath.startsWith("~/"))
      archivePath = snapshot.home + archivePath.slice(1);
    if (archivePath && !archivePath.startsWith("/")) {
      setError(
        "Use a full archive folder path like ~/archive or /mnt/backup/archive",
      );
      return;
    }
    await run(
      async () => {
        setSaving(true);
        setError("");
        if (first) useApp.setState({ setupPending: true });
        try {
          const result = await api<Change>("setup/save", {
            roots: [...roots],
            archiveDir: archivePath,
            presets: [...presets],
            apps,
            terminalTarget,
          });
          changed(result, first ? "All set" : "Settings saved");
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
          <span
            className="logo"
            style={{ width: 28, height: 28, borderRadius: 7 }}
          >
            <Icon name="archive" />
          </span>
          <h1>Welcome to laci</h1>
          <p className="lead">
            laci is a file manager that knows which folders are projects: their
            git state, README, to-dos and the AI sessions that worked on them.
            Tell it where to look.
          </p>
        </>
      ) : null}
      {!info ? (
        <div className="empty">{error || "Loading your settings…"}</div>
      ) : (
        <>
          <section className="sset">
            <h2>
              <span className="num">1</span>Where do you keep projects?
            </h2>
            <p>
              laci looks for projects in these folders, including mounted
              drives. You can leave every folder unchecked and browse without
              scanning.
            </p>
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
                let path = folder.trim().replace(/\/+$/, "");
                if (!path) return;
                if (path === "~" || path.startsWith("~/"))
                  path = snapshot.home + path.slice(1);
                if (!path.startsWith("/")) {
                  setError("Use a full path like ~/work");
                  return;
                }
                if (!candidates.some((c) => c.path === path))
                  setExtra([...extra, path]);
                setRoots(new Set([...roots, path]));
                setFolder("");
                setError("");
              }}
            >
              <input
                className="inp mono"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="~/work or /mnt/projects"
                autoComplete="off"
                aria-label="Another folder"
              />
              <button className="btn">Add folder</button>
            </form>
            <label className="fld">
              <span>Default archive folder</span>
              <input
                className="inp mono"
                value={archiveDir}
                onChange={(e) => setArchiveDir(e.target.value)}
                placeholder="Nearest _archive folder"
                autoComplete="off"
                aria-label="Default archive folder"
              />
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
                  {c.found ? "found on this PC" : "not found"}
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
        </>
      )}
      <div className="setup-foot">
        {error || (first && s.error) ? (
          <p className="err" role="alert">
            {error || s.error}
          </p>
        ) : (
          <p>
            Saved in ~/.config/laci/config.json.
            {first ? " Change it any time in Settings." : ""}
          </p>
        )}
        {first ? (
          <button
            className="btn ghost"
            disabled={saving}
            onClick={() => useApp.setState({ skipSetup: true })}
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
                  ? "Start using laci"
                  : "Save and rescan"}
        </button>
      </div>
    </div>
  );
  return first ? (
    <div
      className="setup"
      id="main"
      tabIndex={-1}
      inert={Boolean(s.modal || s.palette || s.working)}
    >
      {content}
    </div>
  ) : (
    <>
      <div className="head">
        <h1>Settings</h1>
      </div>
      <div className="body">{content}</div>
    </>
  );
}
