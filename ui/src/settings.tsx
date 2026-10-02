import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { APP_NAMES, cap, plural, tilde, within } from "./helpers";
import { Icon } from "./common";
import { useApp, toast } from "./store";
import type { Apps, SetupInfo, Snapshot } from "./types";
export function Settings({ first = false }: { first?: boolean }) {
  const s = useApp();
  const snapshot = s.snapshot!;
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [roots, setRoots] = useState<Set<string>>(new Set());
  const [presets, setPresets] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<string[]>([]);
  const [apps, setApps] = useState<Apps>(s.apps);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void api<SetupInfo>("setup/info").then(
      (info) => {
        if (!live) return;
        setInfo(info);
        setRoots(new Set(info.roots));
        setPresets(new Set(info.presets));
        setApps(info.apps);
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
  ];
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
    setSaving(true);
    setError("");
    useApp.setState({
      working: first ? "Scanning your projects…" : "Saving and scanning…",
    });
    try {
      const result = await api<Snapshot>("setup/save", {
        roots: [...roots],
        presets: [...presets],
        apps,
      });
      s.load(result);
      useApp.setState({ apps, view: first ? "today" : s.view });
      toast(
        first ? "All set" : "Settings saved",
        `${plural(Object.values(result.nodes).filter((n) => n.kind === "project").length, "project")} in ${result.roots.map((path) => tilde(path, result.home)).join(", ")}`,
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
      useApp.setState({ working: "" });
    }
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
        <div className="empty">
          {error || "Looking around your home folder…"}
        </div>
      ) : (
        <>
          <section className="sset">
            <h2>
              <span className="num">1</span>Where do you keep projects?
            </h2>
            <p>
              laci looks for projects in these folders. You can still browse
              everything else from Home.
            </p>
            {candidates.map((c) => (
              <label className="opt" key={c.path}>
                <input
                  type="checkbox"
                  className="cb"
                  checked={roots.has(c.path)}
                  onChange={() => toggle(roots, c.path, setRoots)}
                />
                <span className="mono">{tilde(c.path, snapshot.home)}</span>
                <span className={`r ${c.repos ? "ok" : ""}`}>
                  {c.repos === null
                    ? "added by you"
                    : c.repos
                      ? plural(c.repos, "git repo")
                      : "no repos"}
                </span>
              </label>
            ))}
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
                if (!within(path, snapshot.home)) {
                  setError("Pick a folder inside your home folder");
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
                placeholder="~/somewhere/else"
                autoComplete="off"
                aria-label="Another folder"
              />
              <button className="btn">Add folder</button>
            </form>
          </section>
          <section className="sset">
            <h2>
              <span className="num">2</span>Which AI tools do you use?
            </h2>
            <p>
              Their sessions show on each project and move with it. Other tools
              can be added in Agent history.
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
          </section>
          <section className="sset">
            <h2>
              <span className="num">3</span>Open things with
            </h2>
            <p>What the Editor, Files and external terminal buttons launch.</p>
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
                  <select
                    className="inp"
                    value={apps[key]}
                    onChange={(e) =>
                      setApps({ ...apps, [key]: e.target.value })
                    }
                  >
                    {[...new Set([...info.installed[key], apps[key]])].map(
                      (app) => (
                        <option key={app} value={app}>
                          {APP_NAMES[app] ?? cap(app)}
                          {info.installed[key].includes(app)
                            ? ""
                            : " (not installed)"}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              ))}
            </div>
          </section>
        </>
      )}
      <div className="setup-foot">
        {error ? (
          <p className="err" role="alert">
            {error}
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
          disabled={!info || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : first ? "Start using laci" : "Save and rescan"}
        </button>
      </div>
    </div>
  );
  return first ? (
    <div className="setup">{content}</div>
  ) : (
    <>
      <div className="head">
        <h1>Settings</h1>
      </div>
      <div className="body">{content}</div>
    </>
  );
}
