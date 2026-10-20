// The upgraders' card about new versions (PLAN.md's updater, plan-critique conflict 8): someone who set
// Laci up before 3.0 has a config.json without `updates`, and is asked once, on Detailed's Today
// (ui/src/views/today.tsx, beside the card that offers Simple and apart from it) and on Simple's Home
// (ui/src/simple/updates.tsx, drawn by Home.tsx):
// - the card shows while `prefs` says `updates: null`, and never once a choice is saved, wherever;
// - it says what a check sends, and that nothing installs until the user chooses to;
// - Check daily and Don't check each send one `updates` request with their value, through the update
//   store as Settings › About & updates does, and the card is gone for good;
// - a refusal keeps the card, with the desktop's sentence;
// - Simple's buttons are outlined: the screen's one filled button is Home's own;
// - Today's refusal is text that can be read on the card, light and dark, as detailed.css draws it.
// The real components are drawn into the stand-in for React, on the real update store, with the
// desktop answered by the test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  colorOf,
  contrast,
  detailedCss,
  MIN,
  parseColor,
  readTokens,
  show,
} from "../contrast-check.mjs";
import { load, requireUi } from "../ui-module.mjs";
import { simpleBlocks, standIn } from "./react-stand-in.mjs";

const { createElement } = requireUi("react");
const noop = () => {};
const nothing = () => null;
const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);
const NOW = fixtures.meta.now;
const words = load("words.ts");
const ask = words.firstRun;
const REFUSED = "Laci is busy with a change. Update when it's done.";
const errorText = (error) => (error instanceof Error ? error.message : String(error));

/** What `prefs` answers: an upgrade from 2.x has no choice about new versions. */
const prefsWith = (updates) => ({
  theme: null,
  design: "detailed",
  updates,
  configured: true,
  configPath: "~/.config/laci/config.json",
  os: "linux",
});

/**
 * A desktop that answers `prefs` with `prefs`, saves a choice unless it says `refusal`, and tells of
 * the update as Laci 3.0's does. `asked` lists every request with its body; `emit` sends the news of
 * the update that follows a saved choice, as the desktop does. With `unreadAfter`, config.json can't be
 * read once a choice is saved.
 */
function desktop({ prefs, refusal, unreadAfter = false }) {
  const asked = [];
  const listeners = [];
  const desk = {
    prefs: prefs instanceof Error ? prefs : { ...prefs },
    status: { enabled: false, state: "idle", current: "3.0.0", install: "click" },
  };
  const answers = {
    prefs: () => (desk.prefs instanceof Error ? Promise.reject(desk.prefs) : { ...desk.prefs }),
    updates: (body) => {
      if (refusal) throw new Error(refusal);
      const saved = { ...desk.prefs, updates: body.updates };
      desk.prefs = unreadAfter ? new Error("config.json can't be read") : saved;
      desk.status = { ...desk.status, enabled: body.updates === "daily" };
      return saved;
    },
    "update/status": () => ({ ...desk.status }),
  };
  const api = async (name, body = {}) => {
    asked.push([name, body]);
    if (!answers[name]) throw new Error(`No answer for ${name}`);
    return answers[name](body);
  };
  const update = load("update.ts", {
    "./api": { api, errorText },
    "@tauri-apps/api/event": {
      listen: (name, handler) => {
        listeners.push({ name, handler });
        return Promise.resolve(noop);
      },
    },
  });
  return {
    desk,
    api,
    update,
    named: (name) => asked.filter(([request]) => request === name),
    /** The desktop tells the window how the update stands, as it does after a saved choice. */
    emit() {
      for (const { name, handler } of listeners)
        if (name === "laci") handler({ payload: { type: "update", ...desk.status } });
    },
  };
}

const card = (page) => page.find((n) => n.props["data-ui"] === "updates-offer");
const buttons = (page) => card(page).descendants().filter((n) => n.type === "button");

// --- Detailed's Today ------------------------------------------------------------------------------

/**
 * views/today.tsx on the app's own store (a stand-in store of the page), with what Today draws beside
 * its own lists left out. `offer` is whether it offers Simple; `roots` the project folders.
 */
async function today({
  prefs = prefsWith(null),
  refusal,
  unreadAfter,
  offer = false,
  roots,
  part = "UpdatesOffer",
} = {}) {
  const page = standIn();
  const d = desktop({ prefs, refusal, unreadAfter });
  const toasts = [];
  const main = { focused: 0, focus: () => void main.focused++ };
  page.document.documentElement = { dataset: { os: "linux", design: "detailed" } };
  page.document.getElementById = (id) => (id === "main" ? main : null);
  const snapshot = structuredClone(fixtures.snapshot);
  const app = page.store({
    snapshot: roots ? { ...snapshot, roots } : snapshot,
    selected: null,
    selectedRow: null,
    expanded: {},
    designOffer: offer,
  });
  const drawn = load(
    "views/today.tsx",
    {
      react: page.react,
      "../api": { api: d.api, errorText },
      "../update": d.update,
      "../store": {
        useApp: app,
        run: noop,
        setDesign: noop,
        toast: (...args) => void toasts.push(args),
      },
      "../common": {
        Icon: nothing,
        StatusGlyph: nothing,
        SeverityGlyph: nothing,
        PriorityGlyph: nothing,
        Time: nothing,
        FixButton: nothing,
        Group: ({ children }) => createElement("section", null, children),
        Expand: nothing,
      },
      "../clock": { useNow: () => Date.parse(NOW) },
      "../backup": { BackupNotice: nothing },
      "../looks": { LookThumb: nothing },
      "../deadline": { DeadlinePill: nothing },
      "../actions": { closeReportItem: noop, toggleTodo: noop },
      "../session-ui": { requestResume: noop },
      "../agent-launch": { askAgent: noop },
    },
    { document: page.document },
  );
  page.mount(createElement(drawn[part]));
  await page.settle();
  return { ...page, d, toasts, main };
}

export async function todaysCardAsksOnlyWhileNoChoiceIsSaved() {
  const asked = await today();
  assert.ok(card(asked), "an upgrade from 2.x is asked");
  assert.equal(card(asked).props.role, "group");
  const text = card(asked).textContent;
  assert.ok(text.startsWith(ask.updatesTitle), text);
  assert.ok(text.includes(ask.updatesSends), "what a check sends, in first run's words");
  assert.match(ask.updatesNoInstall, /installs nothing until you choose/);
  assert.ok(text.includes(ask.updatesNoInstall), "that nothing installs without a click");
  assert.deepEqual(
    buttons(asked).map((b) => [b.textContent, b.props.className]),
    [
      [ask.updatesAsk.daily, "btn sm"],
      [ask.updatesAsk.off, "btn sm"],
    ],
    "the two weigh the same",
  );
  for (const updates of ["daily", "off"]) {
    const chosen = await today({ prefs: prefsWith(updates) });
    assert.equal(card(chosen), undefined, updates);
    assert.equal(chosen.text(), "", updates);
  }
  // An answer without the key, or none at all, asks nothing: Settings has the question.
  const older = prefsWith(null);
  delete older.updates;
  assert.equal(card(await today({ prefs: older })), undefined);
  const unread = await today({ prefs: new Error("config.json can't be read") });
  assert.equal(card(unread), undefined);
}

export async function todaysCardSitsBesideTheOfferOfSimpleAndApartFromIt() {
  for (const roots of [undefined, []]) {
    const page = await today({ offer: true, roots, part: "Today" });
    const offer = page.find((n) => n.props["data-ui"] === "design-offer");
    const updates = card(page);
    assert.ok(offer && updates, `both cards, with ${roots ? "no" : "the"} project folders`);
    assert.notEqual(offer, updates);
    assert.ok(!offer.contains(updates) && !updates.contains(offer), "neither holds the other");
    const row = offer.parent.children;
    assert.equal(updates.parent, offer.parent);
    assert.equal(row.indexOf(updates), row.indexOf(offer) + 1, "right after it");
    // Each goes by its own choice: the design has nothing to do with new versions.
    assert.ok(!offer.textContent.includes(ask.updatesTitle));
    assert.ok(!updates.textContent.includes(words.views.offerTitle));
  }
  // Without the offer of Simple, the question still comes.
  const alone = await today({ part: "Today" });
  assert.equal(alone.find((n) => n.props["data-ui"] === "design-offer"), undefined);
  assert.ok(card(alone));
}

export async function todaysCardSavesEachChoiceWithOneRequestAndGoes() {
  for (const updates of ["daily", "off"]) {
    const page = await today();
    const before = page.d.named("prefs").length;
    const at = updates === "daily" ? 0 : 1;
    page.act(() => buttons(page)[at].props.onClick());
    // Busy, and not disabled, so the focus stays; a second click, of either, sends nothing more.
    assert.equal(card(page).props["aria-busy"], true, updates);
    assert.ok(buttons(page).every((b) => !b.props.disabled), updates);
    page.act(() => buttons(page)[1 - at].props.onClick());
    await page.settle();
    await page.settle();
    assert.deepEqual(page.d.named("updates"), [["updates", { updates }]], updates);
    assert.equal(card(page), undefined, `${updates}: the card is gone`);
    assert.deepEqual(page.toasts, [[words.detailedSettings.updatesSaved[updates], ask.updatesLater]]);
    assert.equal(page.main.focused, 1, `${updates}: the focus is on Today, not lost with the card`);
    // It goes as the update store says, as Settings' choice does, and it stays gone.
    assert.equal(page.d.update.useUpdate.getState().status.enabled, updates === "daily");
    page.d.emit();
    await page.settle();
    assert.equal(card(page), undefined);
    assert.ok(page.d.named("prefs").length <= before + 1, `${updates}: it stops asking once it knows`);
  }
  // It goes once the choice is saved, whatever the desktop can say of config.json after that.
  const page = await today({ unreadAfter: true });
  page.act(() => buttons(page)[1].props.onClick());
  await page.settle();
  await page.settle();
  assert.deepEqual(page.d.named("updates"), [["updates", { updates: "off" }]]);
  assert.equal(card(page), undefined);
}

export async function todaysCardKeepsAskingWhenTheChoiceIsRefused() {
  const page = await today({ refusal: REFUSED });
  page.act(() => buttons(page)[0].props.onClick());
  await page.settle();
  await page.settle();
  assert.equal(page.d.named("updates").length, 1);
  assert.ok(card(page), "nothing was saved");
  assert.equal(page.find((n) => n.props.role === "alert")?.textContent, REFUSED);
  assert.equal(card(page).props["aria-busy"], undefined, "it can be tried again");
  assert.deepEqual(page.toasts, []);
  page.act(() => buttons(page)[1].props.onClick());
  await page.settle();
  await page.settle();
  assert.deepEqual(page.d.named("updates").at(-1), ["updates", { updates: "off" }]);
}

/**
 * The rules of `css` that sit in no at-rule, one for each selector of a list, in the order written:
 * `{ selector, body }`.
 */
function plainRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  let depth = 0;
  let start = 0;
  let from = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") {
      if (depth++ === 0) from = i;
    } else if (char === "}" && depth > 0 && --depth === 0) {
      const prelude = text.slice(start, from).trim();
      if (!prelude.startsWith("@"))
        for (const selector of prelude.split(","))
          found.push({
            selector: selector.trim().replace(/\s+/g, " "),
            body: text.slice(from + 1, i),
          });
      start = i + 1;
    } else if (char === ";" && depth === 0) start = i + 1;
  }
  return found;
}

/** Whether `compound`, a tag, classes or both (`p`, `.callout`, `small.rp-status.bad`), fits `node`. */
function fits(compound, node) {
  const [, tag, dotted] = /^([a-z][a-z0-9]*)?((?:\.[\w-]+)*)$/i.exec(compound) ?? [];
  if (!tag && !dotted) return false;
  const classes = String(node?.props?.className ?? "").split(/\s+/);
  return (
    (!tag || node.type === tag) &&
    dotted.split(".").slice(1).every((name) => classes.includes(name))
  );
}

/**
 * Whether `selector`, compounds with a space between (`.callout p`), fits `node`: the last one on it,
 * and each one before it on an element further out. A selector with more than that fits nothing here.
 */
function selects(selector, node) {
  const parts = selector.split(" ");
  if (!fits(parts.at(-1), node)) return false;
  let at = node.parent;
  for (const part of parts.slice(0, -1).reverse()) {
    while (at && !fits(part, at)) at = at.parent;
    if (!at) return false;
    at = at.parent;
  }
  return true;
}

/** A selector's weight in the cascade, for one of tags and classes: a class outweighs any tags. */
const weight = (selector) =>
  selector
    .split(" ")
    .reduce(
      (sum, part) => sum + 100 * (part.match(/\./g)?.length ?? 0) + (/^[a-z]/i.test(part) ? 1 : 0),
      0,
    );

/** The last value that the rule `body` gives one of `properties`. */
function declared(body, properties) {
  let value;
  for (const [, name, text] of body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g))
    if (properties.includes(name)) value = text.trim();
  return value;
}

/**
 * What the stylesheet's `rules` give `node` for one of `properties`, as far as rules of tags and
 * classes go: its own `style` first, then the weightiest rule that fits it, the later of two that
 * weigh the same. Undefined when none sets it.
 */
function given(node, properties, rules) {
  for (const name of properties) {
    const own = node.props.style?.[name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase())];
    if (own !== undefined) return String(own);
  }
  let best;
  for (const rule of rules) {
    const value = declared(rule.body, properties);
    if (value === undefined || !selects(rule.selector, node)) continue;
    const heft = weight(rule.selector);
    if (!best || heft >= best.heft) best = { heft, value };
  }
  return best?.value;
}

/**
 * What a reader sees of `node` as written in the stylesheet's `rules`: the colour it has from itself
 * or the nearest element around it that sets one, on the background of the nearest that paints one.
 */
function seen(node, rules) {
  const nearest = (properties) => {
    for (let at = node; at?.props; at = at.parent) {
      const value = given(at, properties, rules);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  return {
    color: nearest(["color"]) ?? "var(--text)",
    background: nearest(["background-color", "background"]) ?? "var(--bg)",
  };
}

/** A colour as written (`var(--red)`, `#fff`) in one theme's tokens; null when it is none. */
const paint = (value, tokens) => {
  const name = /^var\(\s*--([\w-]+)\s*\)$/.exec(value)?.[1];
  return name ? colorOf(tokens, name) : parseColor(value);
};

export async function todaysRefusalCanBeReadOnTheCard() {
  const page = await today({ refusal: REFUSED });
  page.act(() => buttons(page)[0].props.onClick());
  await page.settle();
  await page.settle();
  const line = page.find((n) => n.props.role === "alert");
  assert.ok(line && card(page).contains(line), "the refusal is on the card");
  const css = readFileSync(detailedCss(), "utf8");
  const { color, background } = seen(line, plainRules(css));
  // A dark block only overrides: whatever it leaves out comes from `:root`.
  const tokens = readTokens(css);
  const themes = {
    light: tokens.light,
    dark: { ...tokens.light, ...tokens.dark },
    "the system's dark": { ...tokens.light, ...tokens.systemDark },
  };
  for (const [theme, set] of Object.entries(themes)) {
    const [fg, bg] = [paint(color, set), paint(background, set)];
    assert.ok(fg && bg, `${theme}: ${color} on ${background} are colours of detailed.css`);
    const ratio = contrast(fg, bg);
    assert.ok(
      ratio >= MIN.text,
      `${theme}: the refusal is ${color} on ${background}, ${show(ratio)} to 1, ` +
        `under the ${MIN.text} text needs`,
    );
  }
}

export async function aChoiceSavedElsewhereTakesTodaysCardAway() {
  const page = await today();
  // The sidebar follows the update's news, as Detailed's does once it has asked how it stands.
  await page.d.update.useUpdate.getState().refresh();
  await page.settle();
  assert.ok(card(page));
  // First run's choice, saved as the window opened, or one made in Settings: the desktop's news of it
  // comes after it.
  page.d.desk.prefs = { ...page.d.desk.prefs, updates: "off" };
  page.d.emit();
  await page.settle();
  assert.equal(card(page), undefined);
  assert.equal(page.d.named("updates").length, 0, "the card saved nothing itself");
  const asked = page.d.named("prefs").length;
  page.d.emit();
  await page.settle();
  assert.equal(page.d.named("prefs").length, asked, "a choice is known: it stops asking");
}

// --- Simple's Home ---------------------------------------------------------------------------------

/** simple/updates.tsx's card, in a window unless `inWindow` is false. */
async function homeCard({ prefs = prefsWith(null), refusal, unreadAfter, inWindow = true } = {}) {
  const page = standIn();
  const d = desktop({ prefs, refusal, unreadAfter });
  const toasts = [];
  const refocused = [];
  const { UpdatesOffer } = load(
    "simple/updates.tsx",
    {
      react: page.react,
      "../api": { api: d.api, errorText },
      "../common": { Icon: nothing, restoreFocus: (to) => void refocused.push(to) },
      "../store": {
        pref: (_key, fallback) => fallback,
        savePref: noop,
        toast: (...args) => void toasts.push(args),
        urlOpen: noop,
      },
      "../update": d.update,
      "./ui": simpleBlocks(),
    },
    inWindow ? { document: { documentElement: { dataset: { os: "linux" } } } } : {},
  );
  page.mount(createElement(UpdatesOffer));
  await page.settle();
  await page.settle();
  return { ...page, d, toasts, refocused };
}

export async function homesCardAsksOnlyWhileNoChoiceIsSaved() {
  const page = await homeCard();
  assert.ok(card(page));
  const text = card(page).textContent;
  assert.ok(text.startsWith(ask.updatesTitle), text);
  assert.ok(text.includes(ask.updatesSends));
  assert.ok(text.includes(ask.updatesNoInstall), "that nothing installs without a click");
  assert.deepEqual(
    buttons(page).map((b) => [b.textContent, b.props["data-kind"]]),
    [
      [ask.updatesAsk.daily, "outline"],
      [ask.updatesAsk.off, "outline"],
    ],
    "outlined, and the two weigh the same",
  );
  for (const updates of ["daily", "off"])
    assert.equal(card(await homeCard({ prefs: prefsWith(updates) })), undefined, updates);
  // An answer without the key, or none at all, asks nothing: Settings has the question.
  const older = prefsWith(null);
  delete older.updates;
  assert.equal(card(await homeCard({ prefs: older })), undefined);
  assert.equal(card(await homeCard({ prefs: new Error("config.json can't be read") })), undefined);
}

export async function homesCardSavesEachChoiceWithOneRequestAndGoes() {
  for (const updates of ["daily", "off"]) {
    const page = await homeCard();
    const at = updates === "daily" ? 0 : 1;
    page.act(() => buttons(page)[at].props.onClick());
    assert.equal(card(page).props["aria-busy"], true, updates);
    assert.ok(buttons(page).every((b) => !b.props.disabled), updates);
    page.act(() => buttons(page)[1 - at].props.onClick());
    await page.settle();
    await page.settle();
    assert.deepEqual(page.d.named("updates"), [["updates", { updates }]], updates);
    assert.equal(card(page), undefined, `${updates}: the card is gone`);
    assert.deepEqual(page.toasts, [[words.settings.updatesSaved[updates], ask.updatesLater]]);
    assert.deepEqual(page.refocused, [null], "the page takes the focus the card had");
    page.d.emit();
    await page.settle();
    assert.equal(card(page), undefined, "and it stays gone");
  }
  // It goes once the choice is saved, whatever the desktop can say of config.json after that.
  const page = await homeCard({ unreadAfter: true });
  page.act(() => buttons(page)[0].props.onClick());
  await page.settle();
  await page.settle();
  assert.deepEqual(page.d.named("updates"), [["updates", { updates: "daily" }]]);
  assert.equal(card(page), undefined);
}

export async function homesCardKeepsAskingWhenTheChoiceIsRefused() {
  const page = await homeCard({ refusal: REFUSED });
  page.act(() => buttons(page)[1].props.onClick());
  await page.settle();
  await page.settle();
  assert.equal(page.d.named("updates").length, 1);
  assert.ok(card(page));
  assert.equal(page.find((n) => n.props.role === "alert")?.textContent, REFUSED);
  assert.deepEqual(page.toasts, []);
}

export async function aChoiceSavedElsewhereTakesHomesCardAway() {
  const page = await homeCard();
  assert.ok(card(page));
  page.d.desk.prefs = { ...page.d.desk.prefs, updates: "daily" };
  page.d.desk.status = { ...page.d.desk.status, enabled: true };
  page.d.emit();
  await page.settle();
  await page.settle();
  assert.equal(card(page), undefined);
}

export async function aHomeDrawnWithoutAWindowAsksNothingAboutUpdates() {
  // The page tests draw Home in Node: a page that asked the desktop there would change what others see.
  const page = await homeCard({ inWindow: false });
  assert.equal(card(page), undefined);
  assert.deepEqual(page.d.named("prefs"), []);
}

/** Home.tsx with its real update parts, on the preview's scan with `roots` as its project folders. */
async function home({ roots } = {}) {
  const page = standIn();
  const d = desktop({ prefs: prefsWith(null) });
  const snapshot = structuredClone(fixtures.snapshot);
  const app = page.store({
    snapshot: roots ? { ...snapshot, roots } : snapshot,
    busy: false,
    historyPending: false,
    error: null,
  });
  const { Home } = load(
    "simple/Home.tsx",
    {
      react: page.react,
      "../api": { api: d.api, errorText },
      "../actions": { closeReportItem: noop, toggleTodo: noop },
      "../agent-launch": { askAgent: noop },
      "../clock": { useNow: () => Date.parse(NOW) },
      "../common": { Icon: nothing, restoreFocus: noop },
      "../pick": { chooseFolder: noop },
      "../store": {
        goToProject: noop,
        run: noop,
        toast: noop,
        useApp: app,
        pref: (_key, fallback) => fallback,
        savePref: noop,
        urlOpen: noop,
      },
      "../update": d.update,
      "./act": {
        addProjectFolder: noop,
        aiName: () => "Claude Code",
        askFix: noop,
        continueWithAi: noop,
      },
      "./art": { Art: nothing },
      "./fix": { fixIcon: () => "cloud-upload", startFix: noop },
      "./state": {
        clearNotNow: noop,
        hideUntilTomorrow: noop,
        readNotNow: () => new Set(),
        showProjects: noop,
        useSimple: page.store({ notNow: 0 }),
      },
      "./ui": simpleBlocks({
        EmptyState: ({ title, action }) => createElement("div", { "data-empty": title }, title, action),
      }),
    },
    { document: { documentElement: { dataset: { os: "linux" } } } },
  );
  page.mount(createElement(Home));
  await page.settle();
  await page.settle();
  return page;
}

const filled = (page) =>
  page.all((n) => n.type === "button" && n.props["data-kind"] === "filled").length;

export async function homeHasTheCardInItsSideColumnAndBelowAnEmptyHome() {
  const page = await home();
  const side = page.find((n) => n.props.className === "s-home-side");
  assert.equal(card(page)?.parent, side, "in the side column");
  // No new version is waiting, so the card about one isn't there and this one leads the column.
  assert.equal(side.children[0], card(page));
  assert.equal(filled(page), 1, "the main card's button alone is filled");
  // With no project folder, Home is the way to choose one, and the question waits below it.
  const empty = await home({ roots: [] });
  const shell = empty.find((n) => String(n.props.className).startsWith("s-page s-home"));
  const start = empty.find((n) => n.props["data-empty"] !== undefined);
  assert.ok(start, "the empty Home");
  assert.equal(card(empty)?.parent, shell);
  assert.equal(shell.children.indexOf(card(empty)), shell.children.indexOf(start) + 1);
  assert.equal(filled(empty), 1);
}
