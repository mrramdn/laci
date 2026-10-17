// What only Simple keeps: the sheets open over its window, how Projects is filtered and sorted, the
// fix sheet, and what Home hides until tomorrow. The engine's data stays in the shared store.
import { create } from "zustand";
import { pref, savePref, useApp } from "../store";
import { hiddenToday, PROJECT_SORTS } from "./model";
import type { ProjectFilter, ProjectSort } from "./model";

interface SimpleState {
  /** Sheets open over the window. The window is inert while any is. */
  sheets: number;
  filter: ProjectFilter;
  sort: ProjectSort;
  query: string;
  /** Projects in this folder only; null for every project folder. */
  folder: string | null;
  /** The problem the fix sheet is open for. */
  fixing: { id: string; code: string } | null;
  /** Counts the changes to what "Not now" hides, so Home and its count in the sidebar draw again. */
  notNow: number;
}

const savedSort = pref<string>("simple-sort", "recent");

export const useSimple = create<SimpleState>(() => ({
  sheets: 0,
  filter: "all",
  sort: PROJECT_SORTS.find((sort) => sort === savedSort) ?? "recent",
  query: "",
  folder: null,
  fixing: null,
  notNow: 0,
}));

export function setSort(sort: ProjectSort) {
  savePref("simple-sort", sort);
  useSimple.setState({ sort });
}

/** Shows Projects with this filter, as "See all" on Home does. */
export function showProjects(filter: ProjectFilter) {
  useSimple.setState({ filter, query: "", folder: null });
  useApp.getState().navigate("folder");
}

/** Opens the fix sheet for a project's problem. */
export function openFix(id: string, code: string) {
  useSimple.setState({ fixing: { id, code } });
}

// A folder chosen in the palette lands on Projects (the store's `cd`): show that folder's projects.
useApp.subscribe((state, previous) => {
  if (state.design !== "simple" || state.view !== "folder") return;
  if (state.cwd === previous.cwd) return;
  const roots = state.snapshot?.roots ?? [];
  const node = state.snapshot?.nodes[state.cwd];
  const onlyRoot = roots.length === 1 && roots[0] === state.cwd;
  useSimple.setState({
    folder: node?.kind === "folder" && !onlyRoot ? state.cwd : null,
    filter: "all",
  });
});

// --- Not now ---------------------------------------------------------------------------------------

const NOT_NOW = "simple-not-now";

/**
 * The needs hidden on `day` ("2026-10-08"). Kept on this computer only. A view that shows them
 * subscribes to `notNow`, which changes with them.
 */
export function readNotNow(day: string): Set<string> {
  return hiddenToday(pref<unknown>(NOT_NOW, null), day);
}

/** Hides a need until the day after `day`. */
export function hideUntilTomorrow(key: string, day: string) {
  const keys = readNotNow(day);
  keys.add(key);
  savePref(NOT_NOW, { day, keys: [...keys] });
  useSimple.setState((s) => ({ notNow: s.notNow + 1 }));
}

/** Shows every hidden need again. */
export function clearNotNow() {
  savePref(NOT_NOW, null);
  useSimple.setState((s) => ({ notNow: s.notNow + 1 }));
}
