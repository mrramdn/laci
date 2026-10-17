// Simple's window: the five places and the footer in the sidebar, the page, the terminal when one is
// open, and the fix sheet. Its layout CSS and Plus Jakarta Sans load with it, so Detailed never
// fetches them.
import "@fontsource-variable/plus-jakarta-sans";
import "./simple.css";
import { lazy, Suspense, useEffect } from "react";
import { LaciMark } from "../brand";
import { useNow } from "../clock";
import { Icon } from "../common";
import { HelpPage } from "../help";
import { isShortcutsKey, namePanes } from "../hotkeys";
import { homeModel, navBadges } from "../selectors";
import { rescan, setDesign, setTheme, useApp } from "../store";
import type { Theme } from "../store";
import { useTerms } from "../terminal-api";
import type { View } from "../types";
import { ago, shell } from "../words";
import { FixSheet } from "./fix";
import { Home } from "./Home";
import { Later } from "./Later";
import { ProjectPage } from "./ProjectPage";
import { Projects } from "./Projects";
import { dayOf, urgentCount } from "./model";
import { readNotNow, useSimple } from "./state";
import { MoreMenu } from "./ui";

const TerminalPanel = lazy(() => import("../TerminalPanel"));
/** The terminal, whose pane gets its name as soon as its code is in. */
function Terminal() {
  useEffect(namePanes);
  return <TerminalPanel />;
}

export default function SimpleShell() {
  const view = useApp((s) => s.view);
  const selected = useApp((s) => s.selected);
  const covered = useApp((s) => Boolean(s.modal || s.palette || s.working));
  const sheet = useSimple((s) => s.sheets > 0);
  const hasTerminals = useTerms((s) => s.tabs.length > 0);
  useSimpleKeys();
  useEffect(namePanes);
  useEffect(() => {
    document.getElementById("main")?.scrollTo(0, 0);
  }, [view, selected]);
  return (
    <div className="s-shell">
      <div className="s-frame" inert={covered || sheet}>
        <Nav view={view} />
        <main id="main" className="s-main" tabIndex={-1}>
          <Page view={view} />
        </main>
        {hasTerminals ? (
          <Suspense fallback={null}>
            <Terminal />
          </Suspense>
        ) : null}
      </div>
      <FixSheet />
    </div>
  );
}

function Page({ view }: { view: View }) {
  switch (view) {
    case "folder":
      return <Projects />;
    case "project":
      return <ProjectPage />;
    case "help":
      return <HelpPage />;
    case "agents":
    case "reports":
      return <Later place="helpers" />;
    case "tidy":
      return <Later place="cleanup" />;
    case "log":
      return <Later place="activity" />;
    case "settings":
      return <Later place="settings" />;
    default:
      return <Home />;
  }
}

/**
 * Simple's own keys, before the window's: ? or Ctrl+/ open Help, and Escape on a page goes no
 * further (in Detailed it closes the details beside the view; here the project is the page). The
 * key keeps its own effect, such as clearing a search field. Menus, sheets and dialogs take their
 * Escape first.
 */
function useSimpleKeys() {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement;
      if (!(target instanceof HTMLElement) || target.closest(".xterm")) return;
      const state = useApp.getState();
      if (state.modal || state.palette || state.working) return;
      if (useSimple.getState().sheets) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        return;
      }
      const typing =
        target.matches('input, textarea, select, [role="combobox"]') ||
        target.isContentEditable;
      if (typing) return;
      if (isShortcutsKey(event)) {
        event.preventDefault();
        state.navigate("help");
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
}

const PLACES: { view: View; label: string; icon: string }[] = [
  { view: "today", label: shell.home, icon: "house" },
  { view: "folder", label: shell.projects, icon: "folder-kanban" },
  { view: "agents", label: shell.helpers, icon: "sparkles" },
  { view: "tidy", label: shell.cleanup, icon: "brush-cleaning" },
  { view: "log", label: shell.activity, icon: "history" },
];
/** The place a view belongs to: a project's page to Projects, Reports to AI helpers. */
const placeOf = (view: View): View =>
  view === "project" ? "folder" : view === "reports" ? "agents" : view;

function Nav({ view }: { view: View }) {
  const snapshot = useApp((s) => s.snapshot!);
  const reportsSeen = useApp((s) => s.reportsSeen);
  const navigate = useApp((s) => s.navigate);
  const now = new Date(useNow());
  const badges = navBadges(snapshot, reportsSeen, now);
  // What Home leads with, less what "Not now" hides today.
  useSimple((s) => s.notNow);
  const urgent = urgentCount(homeModel(snapshot, now), readNotNow(dayOf(now)));
  const here = placeOf(view);
  const counts: Partial<Record<View, [number, string]>> = {
    today: [urgent, shell.needYou(urgent)],
    tidy: [badges.suggestions, shell.suggestions(badges.suggestions)],
  };
  return (
    <nav
      id="side"
      className="s-nav"
      aria-label={shell.nav}
      data-ui="nav"
      tabIndex={-1}
      onFocus={(event) => {
        // F6 lands on the sidebar itself: go on to the place that is open.
        if (event.target === event.currentTarget)
          event.currentTarget
            .querySelector<HTMLElement>('[aria-current="page"], .s-place')
            ?.focus();
      }}
    >
      <div className="s-brand">
        <LaciMark size={24} />
        <span className="s-wordmark">{shell.name}</span>
      </div>
      <button
        type="button"
        className="s-place s-searchbtn"
        title={shell.searchLabel(shell.searchKey)}
        onClick={() => useApp.setState({ palette: true })}
      >
        <Icon name="search" />
        <span>{shell.search}</span>
        <kbd className="s-kbd">{shell.searchKey}</kbd>
      </button>
      <ul className="s-places">
        {PLACES.map((place) => {
          const [count, what] = counts[place.view] ?? [0, ""];
          return (
            <li key={place.view}>
              <button
                type="button"
                className="s-place"
                data-ui="place"
                data-view={place.view}
                aria-current={here === place.view ? "page" : undefined}
                onClick={() => navigate(place.view)}
              >
                <Icon name={place.icon} />
                <span>{place.label}</span>
                {count ? (
                  <span className={`s-badge${place.view === "today" ? " s-badge-act" : ""}`}>
                    <span aria-hidden="true">{count}</span>
                    <span className="sr-only">, {what}</span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="s-navfoot">
        <button
          type="button"
          className="s-place"
          data-ui="place"
          data-view="settings"
          aria-current={view === "settings" ? "page" : undefined}
          onClick={() => navigate("settings")}
        >
          <Icon name="gear" />
          <span>{shell.settings}</span>
        </button>
        <button
          type="button"
          className="s-place"
          data-ui="place"
          data-view="help"
          aria-current={view === "help" ? "page" : undefined}
          onClick={() => navigate("help")}
        >
          <Icon name="circle-help" />
          <span>{shell.help}</span>
        </button>
        <div
          className="s-seg"
          role="group"
          aria-label={shell.view}
          data-ui="design-toggle"
        >
          <button type="button" className="s-seg-btn" aria-pressed="true">
            {shell.simple}
          </button>
          <button
            type="button"
            className="s-seg-btn"
            aria-pressed="false"
            onClick={() => setDesign("detailed")}
          >
            {shell.detailed}
          </button>
        </div>
        <ThemeMenu />
        <ScanStatus />
      </div>
    </nav>
  );
}

const THEME_ICON: Record<Theme, string> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

function ThemeMenu() {
  const theme = useApp((s) => s.theme);
  return (
    <MoreMenu
      label={shell.theme}
      kind="plain"
      className="s-place"
      icon={THEME_ICON[theme]}
      align="start"
      items={(["system", "light", "dark"] as const).map((choice) => ({
        label: shell.themes[choice],
        checked: theme === choice,
        onSelect: () => setTheme(choice),
      }))}
    >
      <span>{shell.theme}</span>
    </MoreMenu>
  );
}

function ScanStatus() {
  const busy = useApp((s) => s.busy || s.historyPending);
  const error = useApp((s) => s.error);
  const scannedAt = useApp((s) => s.snapshot?.scannedAt);
  useNow();
  const status = error
    ? shell.checkFailed
    : busy
      ? shell.checking
      : shell.upToDate;
  return (
    <button
      type="button"
      className="s-place s-scan"
      title={error ?? shell.checkedAt(ago(scannedAt))}
      aria-label={shell.checkAgain(status)}
      onClick={() => void rescan()}
    >
      {busy && !error ? (
        <span className="s-spinner" aria-hidden="true" />
      ) : (
        <span className={`s-dot${error ? " s-dot-bad" : ""}`} aria-hidden="true" />
      )}
      <span>{status}</span>
    </button>
  );
}
