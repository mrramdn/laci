import { useEffect, useState } from "react";
import { api } from "./api";
import type { Prefs } from "./types";
import { useUpdate } from "./update";

/**
 * Whether config.json holds no choice about new versions yet: a setup from before 3.0, or a first run
 * that was skipped. Detailed's Today and Simple's Home ask then, each with its own card. False until
 * `prefs` says so, and when it can't: Settings asks the same question. The desktop's news of the
 * update follows every saved choice, so each piece of it reads `prefs` again until a choice is known:
 * one that first run saved as the window opened, or one made in Settings. Nothing unsets a choice, so
 * then it stops. A page drawn without a window, as the page tests do in Node, asks nothing.
 */
export function useUpdatesUnset() {
  const [unset, setUnset] = useState<boolean>();
  const known = unset === false;
  useEffect(() => {
    if (known || typeof document === "undefined") return;
    let live = true;
    const read = () =>
      void api<Prefs>("prefs").then(
        (prefs) => {
          if (live) setUnset(prefs?.updates === null);
        },
        () => undefined,
      );
    read();
    const stop = useUpdate.subscribe((now, before) => {
      if (now.status !== before.status) read();
    });
    return () => {
      live = false;
      stop();
    };
  }, [known]);
  return unset === true;
}
