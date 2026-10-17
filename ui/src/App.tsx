import { useEffect, useState, type ComponentType } from "react";
import { useApp } from "./store";
import { useLaciSync } from "./sync";
import { useGlobalHotkeys } from "./hotkeys";
import { Settings } from "./settings";
import { Dialogs } from "./dialogs";
import { Palette } from "./palette";
import { Overlays } from "./overlays";
import type { Design } from "./types";
/**
 * A design's window, in a chunk of its own: loaded the first time it is needed, and drawn at once
 * after that. Not React.lazy: that shows its fallback on the first render even when the code is
 * already in, and React then keeps the fallback up for at least 300 ms.
 */
function shell(load: () => Promise<{ default: ComponentType }>) {
  let loaded: ComponentType | undefined;
  let loading: Promise<ComponentType> | undefined;
  return {
    get: () => loaded,
    load: () =>
      (loading ??= load().then(({ default: Shell }) => (loaded = Shell))),
  };
}
const shells: Record<Design, ReturnType<typeof shell>> = {
  detailed: shell(() => import("./detailed/DetailedShell")),
  simple: shell(() => import("./simple/SimpleShell")),
};
/** The window for `design` once its code is in. It loads while the first scan is on its way. */
function useShell(design: Design) {
  const [, setLoaded] = useState<ComponentType>();
  const [failed, setFailed] = useState<{ error: unknown }>();
  useEffect(() => {
    let live = true;
    shells[design].load().then(
      (Shell) => {
        if (live) setLoaded(() => Shell);
      },
      (error) => {
        if (live) setFailed({ error });
      },
    );
    return () => {
      live = false;
    };
  }, [design]);
  // As with React.lazy, code that didn't load is an error, not a boot screen that never ends.
  if (failed) throw failed.error;
  return shells[design].get();
}
/** What the window shows until the first scan, the saved choices and the design's code are in. */
function Boot() {
  // A scan that failed before there was anything to show. Later failures are a toast.
  const error = useApp((s) => (s.snapshot ? null : s.error));
  return (
    <div className="boot">
      <div>
        <b>{error ? "Scan failed" : "Looking for your projects…"}</b>
        {error ? (
          <>
            <p>{error}</p>
            <button className="btn" onClick={() => window.location.reload()}>
              Try again
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
export default function App() {
  useLaciSync();
  useGlobalHotkeys();
  const ready = useApp((s) => Boolean(s.snapshot) && s.prefsReady);
  const firstRun = useApp(
    (s) => (!s.snapshot?.configured || s.setupPending) && !s.skipSetup,
  );
  const design = useApp((s) => s.design);
  const palette = useApp((s) => s.palette);
  const Shell = useShell(design);
  const main = firstRun ? <Settings first /> : Shell ? <Shell /> : null;
  if (!ready || !main) return <Boot />;
  return (
    <>
      {main}
      <Dialogs />
      {palette ? <Palette /> : null}
      <Overlays />
    </>
  );
}
