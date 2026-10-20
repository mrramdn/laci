import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, errorText } from "./api";

/** Where an update stands. "ready" waits for a restart. */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

/**
 * What `update/status` and `update/check` answer, and what the desktop's `laci` event of type
 * "update" carries. Only the desktop talks to the update server.
 */
export interface UpdateStatus {
  /** Laci looks for a new version once a day by itself: config.json says `updates: "daily"`. */
  enabled: boolean;
  state: UpdatePhase;
  /** The version running now. */
  current: string;
  /** The newer version, once a check found one. */
  version?: string;
  /** Its release notes, in Markdown. */
  notes?: string;
  /** When it was published (RFC 3339). */
  date?: string;
  /**
   * "click": Laci downloads and installs it after a click (the AppImage). "notice": a package
   * manager or a script put this copy in place, so the window links to `url` instead.
   */
  install: "click" | "notice";
  /** The release page of `version`. */
  url?: string;
  /** Whole percent downloaded, while the size is known. */
  progress?: number;
  /** Why the last check, download or restart failed. */
  error?: string;
  /** When Laci last looked (RFC 3339). */
  checkedAt?: string;
}

interface UpdateStore {
  /** Null until the desktop first answers. */
  status: UpdateStatus | null;
  /** What the desktop refused, such as an install while a change runs. The next request clears it. */
  refusal: string | null;
  /** Asks where the update stands. */
  refresh: () => Promise<void>;
  /** Looks for a new version now, whatever the daily choice. */
  check: () => Promise<void>;
  /** Downloads and installs the version found. Its progress arrives as events. */
  install: () => Promise<void>;
  /** Restarts into the installed version. Terminals and the agents in them close. */
  restart: () => Promise<void>;
  /** Saves whether Laci looks once a day by itself; true once saved. */
  choose: (updates: "daily" | "off") => Promise<boolean>;
}

type UpdateEvent = { type: string } & UpdateStatus;

/** The desktop's update events heard so far: a reply asked for before the latest one is older than it. */
let heard = 0;
let following: Promise<void> | null = null;
/** Listens to the desktop from the first request on, for as long as the window lives. */
function follow(): Promise<void> {
  following ??= listen<UpdateEvent>("laci", (event) => {
    const { type, ...status } = event.payload;
    if (type !== "update") return;
    heard++;
    useUpdate.setState({ status });
  }).then(
    () => undefined,
    () => {
      // Without events the replies still tell the window; the next request tries again.
      following = null;
    },
  );
  return following;
}

/** Sends a request after the listener is in place. A refusal lands in `refusal`. */
async function ask<T>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<T | undefined> {
  await follow();
  useUpdate.setState({ refusal: null });
  try {
    return await api<T>(name, body);
  } catch (error) {
    useUpdate.setState({ refusal: errorText(error) });
    return undefined;
  }
}

/** Shows a status reply, unless an event came in while it was on its way: that one is newer. */
async function settle(name: string) {
  await follow();
  // Counted once nothing stands between this and the request: events only arrive between tasks.
  const before = heard;
  const status = await ask<UpdateStatus>(name);
  if (status && heard === before) useUpdate.setState({ status });
}

export const useUpdate = create<UpdateStore>(() => ({
  status: null,
  refusal: null,
  refresh: () => settle("update/status"),
  check: () => settle("update/check"),
  install: async () => {
    await ask<{ started: boolean }>("update/install");
  },
  restart: async () => {
    await ask<Record<string, never>>("update/restart");
  },
  choose: async (updates) => {
    const saved = await ask("updates", { updates });
    // The desktop also sends the new choice as an event; this covers a window that missed it.
    if (saved !== undefined) await settle("update/status");
    return saved !== undefined;
  },
}));
