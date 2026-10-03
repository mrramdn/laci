import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { run, useApp } from "./store";
import type { TerminalInfo } from "./types";
import { parentOf } from "./helpers";
interface TerminalState {
  tabs: TerminalInfo[];
  active: string | null;
  shown: boolean;
  max: boolean;
  height: number;
}
export const useTerms = create<TerminalState>(() => ({
  tabs: [],
  active: null,
  shown: false,
  max: false,
  height: 280,
}));
export async function openTerminal(
  id: string | null,
  what = "shell",
  arg?: string,
) {
  return run(async () => {
    const info = await invoke<TerminalInfo>("term_open", {
      id,
      what,
      arg: arg ?? null,
    });
    useTerms.setState((s) => ({
      tabs: s.tabs.some((t) => t.id === info.id) ? s.tabs : [...s.tabs, info],
      active: info.id,
      shown: true,
    }));
    return info;
  });
}
export async function closeTerminal(id: string) {
  return run(async () => {
    await invoke("term_close", { id });
    useTerms.setState((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        active: s.active === id ? (tabs.at(-1)?.id ?? null) : s.active,
        shown: tabs.length ? s.shown : false,
      };
    });
    return true;
  }, "Closing terminal…");
}
export function requestTerminalClose(id: string) {
  const terminal = useTerms.getState().tabs.find((tab) => tab.id === id);
  if (!terminal) return;
  if (terminal.exited !== undefined && terminal.exited !== false)
    void closeTerminal(id);
  else useApp.setState({ modal: { kind: "terminal-close", id } });
}
export function toggleTerminal() {
  const terms = useTerms.getState();
  const state = useApp.getState();
  if (!terms.tabs.length)
    void openTerminal(
      state.fileSelected
        ? parentOf(state.fileSelected)
        : state.selected || state.cwd || null,
    );
  else useTerms.setState({ shown: !terms.shown });
}

export async function restoreTerminals() {
  try {
    const tabs = await invoke<TerminalInfo[]>("term_list");
    useTerms.setState((s) => ({
      tabs: [
        ...tabs,
        ...s.tabs.filter((t) => !tabs.some((tab) => tab.id === t.id)),
      ],
      active: s.active ?? tabs.at(-1)?.id ?? null,
    }));
  } catch {
    /* A failed restoration does not prevent opening a new terminal. */
  }
}
