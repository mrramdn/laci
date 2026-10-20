// Draws a README or a report. Views load this file only when they draw one, with import() (see
// useMarkdown in hooks.ts), so marked and DOMPurify stay out of the code a window starts with: a
// static import of it from a view would bring them back.
import type { MouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { joinPath, segments } from "./helpers";
import { toast, urlOpen } from "./store";

// A README comes with the project, so it is not trusted. Only text structure gets through: no styles, classes,
// ids, forms or media, so it cannot restyle or cover Laci's own interface.
const TAGS = [
  ..."a abbr b blockquote br caption center code col colgroup dd del details div dl dt em".split(
    " ",
  ),
  ..."figcaption figure h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p pre q s samp".split(
    " ",
  ),
  ..."small span strike strong sub summary sup table tbody td tfoot th thead tr u ul var".split(
    " ",
  ),
];
const ATTRS = [
  ..."href src alt title width height align colspan rowspan start".split(" "),
  ..."type checked disabled open lang dir".split(" "),
];

/** The anchor a code host gives a heading: "Getting Started!" becomes "getting-started". */
export const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
export const anchorId = (name: string) => `readme-${slug(name)}`;
/** The id a link such as `#getting-started` points at. */
export function anchorOf(fragment: string) {
  try {
    return anchorId(decodeURIComponent(fragment));
  } catch {
    return anchorId(fragment);
  }
}

/**
 * The file in `project` that a README's relative image path names, or nothing for a path that leads
 * elsewhere or is none. The path is resolved as a link on a made-up host, which settles `.`, `..` and `\`;
 * the project's own folder names go into that link so that a path may climb out and back in.
 */
export function imageFile(project: string, src: string) {
  const inside = segments(project);
  try {
    const folders = inside.map((name) => `${encodeURIComponent(name)}/`);
    const url = new URL(src, `https://local.invalid/${folders.join("")}`);
    if (url.host !== "local.invalid") return undefined;
    const names = url.pathname
      .split("/")
      .filter(Boolean)
      .map((name) => decodeURIComponent(name));
    const rest = names.slice(inside.length);
    if (!rest.length || !inside.every((name, i) => name === names[i]))
      return undefined;
    // A name that holds a separator would lead out of the project once it is joined to its path.
    if (rest.some((name) => name.includes("/"))) return undefined;
    return joinPath(project, ...rest);
  } catch {
    // Not a usable path.
    return undefined;
  }
}
export function renderReadme(
  raw: string,
  project: string,
  loadRemote: boolean,
) {
  const clean = DOMPurify.sanitize(marked.parse(raw, { async: false }), {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  let remote = 0;
  for (const image of doc.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (/^(https?:)?\/\//i.test(src)) {
      // Fetching it would tell that server this README was opened, so the user decides.
      remote++;
      if (loadRemote) {
        if (src.startsWith("//")) image.setAttribute("src", `https:${src}`);
        continue;
      }
      const host = new URL(src, "https://local.invalid").host;
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "readme-remote";
      chip.dataset.remote = "";
      chip.title = `Load images from the web. This one is at ${host}`;
      chip.textContent = image.alt ? `${image.alt} · ${host}` : host;
      image.replaceWith(chip);
    } else if (!/^data:image\//i.test(src)) {
      image.removeAttribute("src");
      const file = imageFile(project, src);
      if (file) image.src = convertFileSrc(file);
    }
  }
  const taken = new Map<string, number>();
  const headings: { id: string; text: string; level: number }[] = [];
  for (const heading of doc.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const id = anchorId(heading.textContent ?? "");
    const seen = taken.get(id) ?? 0;
    taken.set(id, seen + 1);
    heading.id = seen ? `${id}-${seen}` : id;
    headings.push({
      id: heading.id,
      text: heading.textContent?.trim() ?? "",
      level: Number(heading.tagName.slice(1)),
    });
  }
  // The text of a link can promise one place and lead to another.
  for (const link of doc.querySelectorAll("a[href]"))
    link.setAttribute("title", link.getAttribute("href") ?? "");
  for (const input of doc.querySelectorAll("input")) {
    if (input.getAttribute("type") === "checkbox")
      input.setAttribute("disabled", "");
    else input.remove();
  }
  return { html: doc.body.innerHTML, remote, headings };
}

/** Clicks in rendered Markdown: web and mail links open outside, `#` links scroll, `relative` takes the
 * rest. A clicked placeholder for a web image calls `remote`. */
export function proseClick(
  event: MouseEvent<HTMLElement>,
  how: { remote: () => void; relative: (href: string) => void; blocked: string },
) {
  const target = event.target as HTMLElement;
  const link = target.closest("a");
  if (target.closest("[data-remote]")) {
    event.preventDefault();
    how.remote();
  } else if (link) {
    event.preventDefault();
    const href = (link.getAttribute("href") ?? "").trim();
    if (/^(https?:\/\/|mailto:)/i.test(href)) urlOpen(href);
    else if (href.startsWith("//")) urlOpen(`https:${href}`);
    else if (href.startsWith("#"))
      event.currentTarget
        .querySelector(`#${CSS.escape(anchorOf(href.slice(1)))}`)
        ?.scrollIntoView();
    // The cleaner drops addresses it does not allow, leaving a link with nowhere to go.
    else if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href))
      toast("Link not opened", how.blocked);
    else how.relative(href);
  }
}
