import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "./common";
import { openTerminal, requestTerminalClose, useTerms } from "./terminal-api";
import { external, run, useApp } from "./store";
import { tilde } from "./helpers";
import type { TerminalInfo } from "./types";
const themes: Record<string, ITheme> = {
  dark: {
    background: "#0C0C0D",
    foreground: "#D4D4D8",
    cursor: "#EDEDEF",
    cursorAccent: "#0C0C0D",
    selectionBackground: "#3F3F46",
    black: "#18181B",
    red: "#F87171",
    green: "#4ADE80",
    yellow: "#FACC15",
    blue: "#60A5FA",
    magenta: "#C084FC",
    cyan: "#22D3EE",
    white: "#E4E4E7",
    brightBlack: "#52525B",
    brightRed: "#FCA5A5",
    brightGreen: "#86EFAC",
    brightYellow: "#FDE047",
    brightBlue: "#93C5FD",
    brightMagenta: "#D8B4FE",
    brightCyan: "#67E8F9",
    brightWhite: "#FAFAFA",
  },
  light: {
    background: "#FFFFFF",
    foreground: "#27272A",
    cursor: "#18181B",
    cursorAccent: "#FFFFFF",
    selectionBackground: "#D4D4D8",
    black: "#18181B",
    red: "#DC2626",
    green: "#15803D",
    yellow: "#A16207",
    blue: "#2563EB",
    magenta: "#9333EA",
    cyan: "#0E7490",
    white: "#52525B",
    brightBlack: "#71717A",
    brightRed: "#B91C1C",
    brightGreen: "#166534",
    brightYellow: "#854D0E",
    brightBlue: "#1D4ED8",
    brightMagenta: "#7E22CE",
    brightCyan: "#155E75",
    brightWhite: "#18181B",
  },
};
function terminalTheme() {
  return themes[
    getComputedStyle(document.documentElement).colorScheme === "dark"
      ? "dark"
      : "light"
  ];
}
export default function TerminalPanel() {
  const terms = useTerms();
  const snapshot = useApp((s) => s.snapshot);
  const host = useRef<HTMLElement>(null);
  const current = terms.tabs.find((t) => t.id === terms.active);
  return (
    <section
      ref={host}
      id="term"
      className={`term ${terms.max ? "max" : ""}`}
      aria-label="Terminal"
      hidden={!terms.shown}
      style={{ height: terms.max ? "calc(100vh - 90px)" : terms.height }}
    >
      <div
        className="term-resize"
        onPointerDown={(event) => {
          event.preventDefault();
          const previous = terms.height;
          const initialY = event.clientY;
          const move = (event: PointerEvent) =>
            useTerms.setState({
              height: Math.min(
                window.innerHeight * 0.85,
                Math.max(140, previous + initialY - event.clientY),
              ),
            });
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      />
      <div className="term-bar" role="tablist" aria-label="Terminal tabs">
        {terms.tabs.map((tab) => (
          <button
            className={`ttab ${tab.exited !== undefined && tab.exited !== false ? "ended" : ""}`}
            key={tab.id}
            role="tab"
            aria-selected={tab.id === terms.active}
            title={tilde(tab.cwd, snapshot?.home ?? "")}
            onClick={() => useTerms.setState({ active: tab.id })}
          >
            <Icon name="terminal" className="sm" />
            {tab.title}
            <span
              className="x"
              role="button"
              tabIndex={0}
              aria-label={`Close terminal ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                requestTerminalClose(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  requestTerminalClose(tab.id);
                }
              }}
            >
              <Icon name="x" className="sm" />
            </span>
          </button>
        ))}
        <button
          className="icon-btn"
          title="New terminal here"
          aria-label="New terminal"
          onClick={() =>
            void openTerminal(
              current?.cwd ??
                useApp.getState().selected ??
                useApp.getState().cwd,
            )
          }
        >
          <Icon name="plus" className="sm" />
        </button>
        <span className="grow" />
        <button
          className="icon-btn"
          title="Open in an external terminal"
          aria-label="Open this folder in an external terminal"
          onClick={() =>
            external(current?.cwd ?? useApp.getState().cwd, "terminal")
          }
        >
          <Icon name="open" className="sm" />
        </button>
        <button
          className="icon-btn"
          title={terms.max ? "Restore" : "Maximize"}
          aria-label="Maximize terminal"
          onClick={() => useTerms.setState({ max: !terms.max })}
        >
          <Icon name={terms.max ? "x" : "layers"} className="sm" />
        </button>
        <button
          className="icon-btn"
          title="Hide (F4)"
          aria-label="Hide terminal"
          onClick={() => useTerms.setState({ shown: false })}
        >
          <Icon name="chev" className="sm" />
        </button>
      </div>
      <div className="term-body">
        {terms.tabs.map((tab) => (
          <TerminalTab
            key={tab.id}
            info={tab}
            visible={terms.shown && tab.id === terms.active}
          />
        ))}
      </div>
    </section>
  );
}
function TerminalTab({
  info,
  visible,
}: {
  info: TerminalInfo;
  visible: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const theme = useApp((s) => s.theme);
  useEffect(() => {
    const terminal = new Terminal({
      fontFamily:
        '"Geist Mono", "JetBrainsMono Nerd Font", "Symbols Nerd Font", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    term.current = terminal;
    fit.current = addon;
    terminal.open(host.current!);
    let live = true;
    let queued = "";
    let sending = false;
    async function sendInput() {
      if (sending || !queued) return;
      sending = true;
      try {
        while (queued && live) {
          const data = queued;
          queued = "";
          await invoke("term_input", { id: info.id, data });
        }
      } finally {
        sending = false;
      }
    }
    const input = terminal.onData((data) => {
      queued += data;
      void run(sendInput);
    });
    const channel = new Channel<
      { type: "data"; data: string } | { type: "exit"; code: number }
    >();
    channel.onmessage = (event) => {
      if (!live) return;
      if (event.type === "data") terminal.write(event.data);
      else {
        terminal.write(`\r\n\x1b[2m[Process exited ${event.code}]\x1b[0m\r\n`);
        useTerms.setState((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === info.id ? { ...t, exited: event.code } : t,
          ),
        }));
      }
    };
    void run(() => invoke("term_attach", { id: info.id, output: channel }));
    const resize = () => {
      if (host.current?.offsetWidth && host.current.offsetHeight) {
        addon.fit();
        void invoke("term_resize", {
          id: info.id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => {});
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      terminal.options.theme = terminalTheme();
    };
    media.addEventListener("change", applyTheme);
    return () => {
      live = false;
      channel.onmessage = () => {};
      observer.disconnect();
      media.removeEventListener("change", applyTheme);
      input.dispose();
      terminal.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [info.id]);
  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme();
  }, [theme]);
  useEffect(() => {
    if (visible && host.current) {
      const frame = requestAnimationFrame(() => {
        fit.current?.fit();
        const terminal = term.current;
        if (terminal) {
          void invoke("term_resize", {
            id: info.id,
            cols: terminal.cols,
            rows: terminal.rows,
          }).catch(() => {});
          const state = useApp.getState();
          if (!state.modal && !state.palette && !state.working) terminal.focus();
        }
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [visible, info.id]);
  return <div className="term-host" ref={host} hidden={!visible} />;
}
