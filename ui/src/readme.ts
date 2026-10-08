import { convertFileSrc } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";

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
      try {
        const url = new URL(src, `https://local.invalid${project}/`);
        const file = decodeURIComponent(url.pathname);
        if (url.host === "local.invalid" && file.startsWith(project + "/"))
          image.src = convertFileSrc(file);
      } catch {
        // Not a usable path: the image stays empty.
      }
    }
  }
  const taken = new Map<string, number>();
  for (const heading of doc.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const id = anchorId(heading.textContent ?? "");
    const seen = taken.get(id) ?? 0;
    taken.set(id, seen + 1);
    heading.id = seen ? `${id}-${seen}` : id;
  }
  // The text of a link can promise one place and lead to another.
  for (const link of doc.querySelectorAll("a[href]"))
    link.setAttribute("title", link.getAttribute("href") ?? "");
  for (const input of doc.querySelectorAll("input")) {
    if (input.getAttribute("type") === "checkbox")
      input.setAttribute("disabled", "");
    else input.remove();
  }
  return { html: doc.body.innerHTML, remote };
}
