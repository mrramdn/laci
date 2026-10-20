// The system's folder picker, opened by the desktop over the window (`pick/folder`).
import { useState } from "react";
import { api, errorText } from "./api";
import { Icon } from "./common";
import { toast } from "./store";

export interface PickOptions {
  /** The picker's title, such as "Choose a project folder". */
  title?: string;
  /** The folder it opens in, when that exists; `~` is the home folder. */
  defaultPath?: string;
}

/**
 * Asks the user for a folder: its path, or null when they cancel. A picker that can't open, such as
 * one that is already open, is an error and rejects with the reason.
 */
export async function pickFolder({
  title,
  defaultPath,
}: PickOptions = {}): Promise<string | null> {
  const { path } = await api<{ path: string | null }>("pick/folder", {
    title,
    defaultPath,
  });
  return path ?? null;
}

/** What a click on ChooseFolder does: a folder chosen goes to `onPick`, and an error to a toast. */
export async function chooseFolder(
  options: PickOptions,
  onPick: (path: string) => void,
) {
  let path: string | null;
  try {
    path = await pickFolder(options);
  } catch (error) {
    toast("Couldn’t open the folder picker", errorText(error), {
      error: true,
    });
    return;
  }
  if (path !== null) onPick(path);
}

/**
 * A button that opens the folder picker. While the picker is open a click does nothing, and the
 * button keeps its focus for when the picker closes.
 */
export function ChooseFolder({
  onPick,
  label = "Choose folder…",
  name,
  className = "btn",
  disabled = false,
  ...options
}: PickOptions & {
  onPick: (path: string) => void;
  label?: string;
  /**
   * The button's name for a screen reader, when its words don't say which folder it chooses. It
   * starts with those words, so it is the name a voice command uses too.
   */
  name?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      aria-label={name}
      aria-busy={open || undefined}
      onClick={() => {
        if (open) return;
        setOpen(true);
        void chooseFolder(options, onPick).finally(() => setOpen(false));
      }}
    >
      <Icon name="folder" className="sm" />
      {label}
    </button>
  );
}
