// The window in a browser, without the desktop: `pnpm -C ui dev`, then open /preview.html. It is not
// part of the build. ?design=detailed|simple, ?theme=light|dark|system and ?os=linux|macos|windows
// say how it looks.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "../style.css";
import { freezeClock } from "./clock";
import {
  emitEvent,
  fixtureNow,
  installIpc,
  type Design,
  type Os,
  type Theme,
} from "./ipc";

declare global {
  interface Window {
    /** For checks: fire an event as the desktop would, or let a day pass. */
    __preview?: {
      emit: (name: string, payload?: unknown) => Promise<void>;
      advance: (ms: number) => void;
    };
  }
}

const params = new URLSearchParams(location.search);
const choose = <T extends string>(key: string, allowed: readonly T[]): T => {
  const value = params.get(key);
  return allowed.find((choice) => choice === value) ?? allowed[0];
};
const design = choose<Design>("design", ["detailed", "simple"]);
const theme = choose<Theme>("theme", ["system", "light", "dark"]);
const os = choose<Os>("os", ["linux", "macos", "windows"]);

const root = document.documentElement;
root.dataset.design = design;
root.dataset.os = os;
if (theme === "system") delete root.dataset.theme;
else root.dataset.theme = theme;
const clock = freezeClock(fixtureNow);
installIpc({ design, theme, os });
window.__preview = { emit: emitEvent, advance: clock.advance };

// The window reads the theme when it loads, so it comes after the settings above.
void import("../App").then(({ default: App }) =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
