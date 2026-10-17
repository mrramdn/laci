// Simple's eight illustrations: the open drawer of Laci's mark, in two tones. They are drawn inline,
// so their colours come from Simple's tokens and follow the theme; the colours written in each file
// are only what a viewer outside the app shows.
import allSafe from "./art/all-safe.svg?raw";
import backUp from "./art/back-up.svg?raw";
import noChats from "./art/no-chats.svg?raw";
import noProjects from "./art/no-projects.svg?raw";
import noSummaries from "./art/no-summaries.svg?raw";
import nothingToClean from "./art/nothing-to-clean.svg?raw";
import welcome from "./art/welcome.svg?raw";
import wentWrong from "./art/went-wrong.svg?raw";

const ART = {
  welcome,
  "all-safe": allSafe,
  "back-up": backUp,
  "nothing-to-clean": nothingToClean,
  "no-chats": noChats,
  "no-summaries": noSummaries,
  "no-projects": noProjects,
  "went-wrong": wentWrong,
};
export type ArtName = keyof typeof ART;

/** An illustration. It only decorates: the words beside it say everything. */
export function Art({ name }: { name: ArtName }) {
  return (
    <span
      className="s-art"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ART[name] }}
    />
  );
}
