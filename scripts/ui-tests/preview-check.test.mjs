// scripts/ui-preview-check.mjs: its options, the shots they make, the file server, the image diff,
// and the checks that run in the page. Those need a browser and are skipped without one.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import {
  SCREENS,
  SIZES,
  UsageError,
  diffImages,
  fileOf,
  findBrowser,
  loadPixels,
  main,
  measureOverflow,
  nameOf,
  pageRules,
  parseArgs,
  parseSize,
  probe,
  runAxe,
  serve,
  shotsOf,
  untilFonts,
  untilQuiet,
  visitPage,
} from "../ui-preview-check.mjs";

const requireUi = createRequire(new URL("../../ui/package.json", import.meta.url));

/** A folder that is gone after `body`, with `files` written into it. */
async function inFolder(files, body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "laci-preview-check-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One browser for the tests that need one, started when the first does and closed after the last. */
let browser;
after(async () => {
  try {
    await (await browser)?.close();
  } catch {
    /* It never started. */
  }
});

/** Runs `body(page, browser)` in a real browser, or skips the test when there is none. */
async function inBrowser(t, body) {
  const executablePath = findBrowser();
  if (!executablePath) return t.skip("no Chromium to open a page in");
  browser ??= requireUi("playwright-core").chromium.launch({ executablePath, headless: true });
  const context = await (await browser).newContext({ viewport: { width: 800, height: 600 } });
  try {
    return await body(await context.newPage(), await browser);
  } finally {
    await context.close();
  }
}

/** What `pageRules` finds on `html`, only for `rule`: every rule has a say about any page. */
const rulesOf = async (page, html, rule) => {
  await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`);
  const found = await page.evaluate(pageRules);
  return found.filter((item) => item.rule === rule);
};

/**
 * A stand-in for the Simple shell, made as design-research §3.2 and §3.3 describe it: five places
 * in the navigation with Settings at its foot, the palette, a project page with ⋯ More, and an
 * Archive dialog. It has the hook that ui:S1 is to give: `data-ui="primary"`. The tabs and the
 * Archive button are 20 px high on purpose, and the rest are big enough.
 */
const FAKE_SIMPLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Simple</title>
<style>
  body { font: 15px sans-serif; margin: 0; display: flex; }
  button, input { box-sizing: border-box; }
  nav { width: 200px; } nav button { display: block; width: 100%; height: 32px; text-align: left; }
  #tabs button, [data-ui=primary] { height: 20px; }
  #more button, #pal-in { height: 32px; }
  .scrim { position: fixed; inset: 0; background: #0003; }
</style></head><body>
<nav aria-label="Main">
  <button>Home</button><button>Projects</button><button>AI helpers</button>
  <button>Clean up</button><button>Activity</button><button>Settings</button>
</nav>
<main><h1 id="title">Home</h1>
  <div id="tabs" hidden><button role="tab">Chats</button><button role="tab">Summaries</button></div>
  <div id="more"></div></main>
<script>
  // As the preview does: the address says which design and theme, on <html>.
  const query = new URLSearchParams(location.search);
  Object.assign(document.documentElement.dataset, {
    design: query.get("design"),
    theme: query.get("theme"),
    os: "linux",
  });
  const title = document.getElementById("title");
  const places = [...document.querySelectorAll("nav button")];
  const go = (name) => {
    places.forEach((b) => b.removeAttribute("aria-current"));
    places.find((b) => b.textContent === name).setAttribute("aria-current", "page");
    title.textContent = name;
    document.getElementById("tabs").hidden = name !== "AI helpers";
  };
  places.forEach((b) => (b.onclick = () => go(b.textContent)));
  go("Home");
  addEventListener("keydown", (e) => e.ctrlKey && e.key === "k" && openPalette());
  function openPalette() {
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Jump to"><input id="pal-in" role="combobox" aria-label="Search"><div role="listbox"></div></div>';
    document.body.append(scrim);
    const input = scrim.querySelector("input");
    const list = scrim.querySelector("[role=listbox]");
    input.focus();
    input.oninput = () => {
      list.innerHTML = "";
      if (input.value && "acme-store".includes(input.value)) {
        const option = document.createElement("div");
        option.setAttribute("role", "option");
        option.textContent = "acme-store ~/project/clients/acme-store";
        option.onclick = () => { scrim.remove(); showProject(); };
        list.append(option);
      }
    };
  }
  function showProject() {
    title.textContent = "acme-store";
    const more = document.getElementById("more");
    more.innerHTML = '<button aria-haspopup="menu">⋯ More</button>';
    more.querySelector("button").onclick = () => {
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.innerHTML = '<button role="menuitem">Archive…</button>';
      more.append(menu);
      menu.firstChild.onclick = () => {
        menu.remove();
        const dialog = document.createElement("div");
        dialog.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Archive acme-store?</h2><button data-ui="primary">Archive</button></div>';
        document.body.append(dialog);
      };
    };
  }
</script></body></html>`;

// --- Options and shots --------------------------------------------------------------------------

export async function theMatrixIsEveryScreenAtTheFourTiersAndTheAppsWindow() {
  const options = parseArgs([]);
  assert.deepEqual(options.design, ["detailed", "simple"]);
  assert.deepEqual(options.themes, ["light", "dark"]);
  assert.deepEqual(options.screens, SCREENS);
  assert.deepEqual(
    options.sizes.map((size) => size.width),
    [720, 840, 1200, 1440, 1600],
  );
  assert.ok(options.sizes.every((size) => size.height === 900));
  assert.equal(SIZES.length, options.sizes.length);
  assert.equal(SCREENS.length, 10);
  assert.deepEqual(
    [options.compare, options.axe, options.overflow, options.rules, options.strict],
    [undefined, false, false, false, false],
  );
  assert.ok(options.jobs >= 1);
}

export async function listsAndSizesAreRead() {
  const options = parseArgs([
    "--design=simple",
    "--screens",
    "today,log",
    "--widths",
    "720x560,1200,720x560",
    "--themes",
    "dark",
    "--compare",
    "main",
    "--out=/tmp/shots",
    "--axe",
    "--overflow",
    "--rules",
    "--strict",
    "--jobs",
    "2",
  ]);
  assert.deepEqual(options.design, ["simple"]);
  assert.deepEqual(options.screens, ["today", "log"]);
  assert.deepEqual(options.sizes, [
    { width: 720, height: 560 },
    { width: 1200, height: 900 },
  ]);
  assert.deepEqual(options.themes, ["dark"]);
  assert.equal(options.compare, "main");
  assert.equal(options.out, "/tmp/shots");
  assert.deepEqual(
    [options.axe, options.overflow, options.rules, options.strict, options.jobs],
    [true, true, true, true, 2],
  );
  assert.deepEqual(parseSize("1600"), { width: 1600, height: 900 });
}

export async function aMistakeInTheOptionsIsRefusedInPlainWords() {
  const refused = (args, text) =>
    assert.throws(
      () => parseArgs(args),
      (error) => error instanceof UsageError && text.test(error.message),
      args.join(" "),
    );
  refused(["--design", "classic"], /"classic" is not one of detailed, simple/);
  refused(["--screens", "today,home"], /"home" is not one of/);
  refused(["--themes", "sepia"], /"sepia" is not one of light, dark/);
  refused(["--widths", "wide"], /"wide" is not a size/);
  refused(["--compare"], /--compare needs a value/);
  refused(["--compare", "--design", "detailed"], /--compare needs a value/);
  refused(["--out="], /--out needs a value/);
  refused(["--jobs", "0"], /--jobs needs a whole number/);
  refused(["--jobs", "two"], /--jobs needs a whole number/);
  refused(["--colour"], /Unknown option --colour/);
  refused(["screens"], /Unexpected "screens"/);
  assert.equal(parseArgs(["--help"]).help, true);
}

export async function everyShotIsADesignThemeSizeAndScreenWithAFileOfItsOwn() {
  const options = parseArgs([]);
  const shots = shotsOf(options);
  assert.equal(shots.length, 2 * 2 * 5 * 10);
  assert.equal(shotsOf(options, ["detailed"]).length, 100);
  assert.equal(shotsOf(options, []).length, 0);
  const files = new Set(shots.map(fileOf));
  assert.equal(files.size, shots.length, "no two shots share a file");
  for (const file of files) assert.match(file, /^[a-z]+-(detailed|simple)-(light|dark)-\d+x\d+\.png$/);
  const [first] = shots;
  assert.equal(nameOf(first), "today detailed light 720x900");
  assert.equal(fileOf(first), "today-detailed-light-720x900.png");
}

// --- The file server ----------------------------------------------------------------------------

/** What a server answers to `path` sent as it is, without the client tidying `..` away. */
const ask = (url, rawPath) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    http
      .get({ hostname, port, path: rawPath }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, type: response.headers["content-type"], body }));
      })
      .on("error", reject);
  });

export async function aFolderIsServedAndNothingOutsideIt() {
  await inFolder(
    {
      "site/preview.html": "<p>hello</p>",
      "site/assets/app.css": "p { color: red }",
      "site/assets/font.woff2": "font",
      "secret.txt": "not for the site",
    },
    async (dir) => {
      const site = await serve(path.join(dir, "site"));
      try {
        const page = await ask(site.url, "/preview.html");
        assert.deepEqual([page.status, page.type, page.body], [200, "text/html; charset=utf-8", "<p>hello</p>"]);
        assert.equal((await ask(site.url, "/assets/app.css")).type, "text/css; charset=utf-8");
        assert.equal((await ask(site.url, "/assets/font.woff2")).type, "font/woff2");
        assert.equal((await ask(site.url, "/missing.js")).status, 404);
        assert.equal((await ask(site.url, "/assets")).status, 404, "no folder listings");
        assert.equal((await ask(site.url, "/")).status, 404);
        assert.equal((await ask(site.url, "/../secret.txt")).status, 404);
        assert.equal((await ask(site.url, "/%2e%2e/secret.txt")).status, 404);
        assert.equal((await ask(site.url, "/assets/%2e%2e/%2e%2e/secret.txt")).status, 404);
        assert.equal((await ask(site.url, "/%")).status, 404, "an address that cannot be read");
      } finally {
        await site.close();
      }
    },
  );
}

// --- Pixels -------------------------------------------------------------------------------------

function image(PNG, width, height, paint = () => [255, 255, 255, 255]) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) png.data.set(paint(x, y), (y * width + x) * 4);
  return PNG.sync.write(png);
}

export async function identicalImagesDifferInNothingAndEveryChangedPixelCounts() {
  const pixels = await loadPixels();
  const { PNG } = pixels;
  const white = image(PNG, 4, 3);
  assert.deepEqual(diffImages(white, image(PNG, 4, 3), pixels), { changed: 0, diff: null });
  // One pixel a shade off is still a change: this check is for changes that must not happen.
  const shade = image(PNG, 4, 3, (x, y) => (x === 2 && y === 1 ? [254, 255, 255, 255] : [255, 255, 255, 255]));
  const one = diffImages(white, shade, pixels);
  assert.equal(one.changed, 1);
  const picture = PNG.sync.read(one.diff);
  assert.deepEqual([picture.width, picture.height], [4, 3]);
  const two = image(PNG, 4, 3, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  assert.equal(diffImages(white, two, pixels).changed, 6);
}

export async function imagesOfTwoSizesDifferInEveryPixel() {
  const pixels = await loadPixels();
  const small = image(pixels.PNG, 4, 3);
  const tall = image(pixels.PNG, 4, 5);
  const verdict = diffImages(small, tall, pixels);
  assert.equal(verdict.changed, 20);
  assert.equal(verdict.diff, null);
  assert.match(verdict.resized, /4x3 became 4x5/);
}

// --- In the page --------------------------------------------------------------------------------

export async function oneFilledButtonIsAllowedAndADialogCountsAlone(t) {
  await inBrowser(t, async (page) => {
    const primary = (html) => rulesOf(page, html, "one-primary");
    assert.deepEqual(await primary('<button class="btn primary">Save</button>'), []);
    assert.deepEqual(await primary('<button data-ui="primary">Save</button><button>Cancel</button>'), []);
    const two = await primary(
      '<button data-ui="primary">Save</button><button class="btn primary">Send</button>',
    );
    assert.equal(two.length, 1);
    assert.match(two[0].text, /2 filled buttons: "Save", "Send"/);
    // The dialog is all there is while it is open: the page behind it is not counted.
    assert.deepEqual(
      await primary(
        `<button data-ui="primary">Behind</button>
         <div role="dialog" aria-modal="true"><button data-ui="primary">Archive</button></div>`,
      ),
      [],
    );
    // What cannot be seen or used does not count.
    assert.deepEqual(
      await primary(
        `<button data-ui="primary">Save</button>
         <button data-ui="primary" hidden>Hidden</button>
         <div inert><button data-ui="primary">Inert</button></div>`,
      ),
      [],
    );
  });
}

export async function textUnderThirteenPixelsIsFound(t) {
  await inBrowser(t, async (page) => {
    const small = (html) => rulesOf(page, html, "text-size");
    assert.deepEqual(
      await small('<p style="font-size:13px">fine</p><p style="font-size:15px">fine</p>'),
      [],
    );
    const found = await small(
      `<p style="font-size:12px">tiny words</p>
       <p style="font-size:12.5px"><span>kbd</span></p>
       <input style="font-size:11px" value="field">
       <p style="font-size:10px" hidden>not drawn</p>
       <svg width="40" height="20"><text style="font-size:9px" y="12">chart</text></svg>
       <span style="font-size:8px;position:absolute;width:1px;height:1px;overflow:hidden">a reader</span>`,
    );
    assert.deepEqual(
      found.map((item) => item.text),
      ["12 px, under 13 px", "12.5 px, under 13 px", "11 px, under 13 px"],
    );
    assert.equal(found[0].where, 'p "tiny words"');
  });
}

export async function everyStatusNeedsAnIconAndWords(t) {
  await inBrowser(t, async (page) => {
    const status = async (html) => (await rulesOf(page, html, "status")).map((item) => item.text);
    const icon = '<svg width="16" height="16"></svg>';
    assert.deepEqual(await status(`<span data-ui="status">${icon} Only on this computer</span>`), []);
    assert.deepEqual(
      await status('<span data-ui="status"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="> Safe</span>'),
      [],
    );
    assert.deepEqual(await status('<span data-ui="status">Only on this computer</span>'), [
      "a status needs an icon",
    ]);
    assert.deepEqual(await status(`<span data-ui="status">${icon}</span>`), ["a status needs words"]);
    // Colour alone is neither.
    assert.deepEqual(await status('<span data-ui="status" style="color:red">3</span>'), [
      "a status needs an icon",
      "a status needs words",
    ]);
    // Anything without the hook is not a status.
    assert.deepEqual(await status('<span class="chip">Safe</span>'), []);
  });
}

export async function targetsUnder24PixelsAreFoundExceptWhereWcagAllowsThem(t) {
  await inBrowser(t, async (page) => {
    const target = (html) => rulesOf(page, html, "target");
    const size = (w, h) => `style="box-sizing:border-box;width:${w}px;height:${h}px;padding:0"`;
    const found = await target(
      `<button ${size(20, 20)}>a</button>
       <button ${size(24, 24)}>b</button>
       <button ${size(32, 16)}>c</button>
       <a href="#x" style="display:inline-block;width:10px;height:10px">d</a>
       <button disabled ${size(10, 10)}>e</button>
       <button aria-disabled="true" ${size(10, 10)}>f</button>
       <div role="tab" ${size(18, 30)}>g</div>`,
    );
    assert.deepEqual(
      found.map((item) => item.text),
      ["20x20 px, under 24x24", "32x16 px, under 24x24", "10x10 px, under 24x24", "18x30 px, under 24x24"],
    );
    // A link in a sentence is as big as its text.
    assert.deepEqual(await target('<p>Read <a href="#docs">the docs</a> first.</p>'), []);
    // A checkbox hidden behind its label is clicked on the label.
    const hidden = 'style="position:absolute;opacity:0;width:1px;height:1px"';
    const labelled = (side) =>
      `<label style="display:block;width:${side}px;height:${side}px"><input type="checkbox" ${hidden}></label>`;
    assert.deepEqual(await target(labelled(30)), []);
    assert.equal((await target(labelled(16))).length, 1);
    // Where it cannot be used it is not asked to be big.
    assert.deepEqual(await target(`<div inert><button ${size(8, 8)}>x</button></div>`), []);
  });
}

export async function aPageThatBreaksARuleManyTimesListsTheFirstAndCountsTheRest(t) {
  await inBrowser(t, async (page) => {
    const found = await rulesOf(page, '<p style="font-size:10px">word</p>'.repeat(25), "text-size");
    assert.equal(found.length, 21);
    assert.deepEqual(found.at(-1), { rule: "text-size", text: "and 5 more", where: "" });
  });
}

export async function aDocumentWiderThanTheWindowIsMeasured(t) {
  await inBrowser(t, async (page) => {
    await page.setContent('<body style="margin:0"><div style="width:700px">fits</div></body>');
    assert.deepEqual(await page.evaluate(measureOverflow), { scrollWidth: 800, clientWidth: 800, offenders: [] });
    await page.setContent('<body style="margin:0"><div id="wide" class="grid big" style="width:1200px">wide</div></body>');
    const wide = await page.evaluate(measureOverflow);
    assert.deepEqual([wide.scrollWidth, wide.clientWidth], [1200, 800]);
    assert.deepEqual(wide.offenders, ["div#wide.grid.big ends at 1200 px"]);
  });
}

export async function axeFindsWhatItIsAskedAbout(t) {
  await inBrowser(t, async (page) => {
    await page.setContent('<!doctype html><html lang="en"><title>t</title><main><button></button></main></html>');
    await page.addScriptTag({ path: requireUi.resolve("axe-core/axe.min.js") });
    const found = await page.evaluate(runAxe, ["wcag2a", "wcag2aa"]);
    const unnamed = found.find((violation) => violation.id === "button-name");
    assert.equal(unnamed.impact, "critical");
    assert.deepEqual(unnamed.nodes, ["button"]);
    await page.setContent('<!doctype html><html lang="en"><title>t</title><main><button>Save</button></main></html>');
    await page.addScriptTag({ path: requireUi.resolve("axe-core/axe.min.js") });
    assert.deepEqual(await page.evaluate(runAxe, ["wcag2a", "wcag2aa"]), []);
  });
}

export async function theWaitForAStillPageEndsWhenTheChangesDo(t) {
  await inBrowser(t, async (page) => {
    await page.setContent('<div id="n">0</div>');
    // A page that changes for 300 ms, then rests.
    await page.evaluate(() => {
      let i = 0;
      const timer = setInterval(() => {
        document.getElementById("n").textContent = String(++i);
        if (i === 6) clearInterval(timer);
      }, 50);
    });
    // The rest it waits for is longer than a busy machine stalls a 50 ms timer.
    await page.evaluate(untilQuiet, [400, 5000]);
    assert.equal(await page.textContent("#n"), "6", "it waited until the changes were over");
    // A page that never rests: it gives up at the cap.
    await page.evaluate(() => setInterval(() => document.getElementById("n").append("."), 20));
    const from = Date.now();
    await page.evaluate(untilQuiet, [200, 500]);
    const waited = Date.now() - from;
    // 500 ms is the cap; a busy machine may be late, but it must not wait for a rest that never comes.
    assert.ok(waited >= 480 && waited < 5000, `gave up after ${waited} ms`);
  });
}

export async function aFontThatCannotBeReadIsNamed(t) {
  await inBrowser(t, async (page) => {
    await page.setContent(
      `<style>@font-face { font-family: "Broken Sans"; src: url(data:font/woff2;base64,AAAA) }
       p { font-family: "Broken Sans", serif }</style><p>words</p>`,
    );
    const failed = await page.evaluate(untilFonts);
    assert.deepEqual(
      failed.map((name) => name.replaceAll('"', "")),
      ["Broken Sans"],
    );
    await page.setContent("<p>words</p>");
    assert.deepEqual(await page.evaluate(untilFonts), []);
  });
}

// --- Simple, before there is a Simple ------------------------------------------------------------

/** The side of a run that is served at `site`, with the clock at the fixtures' time. */
const sideOf = (site) => ({
  name: "new",
  url: site.url,
  now: new Date("2026-10-08T09:00:00.000Z"),
});

export async function everyScreenOfSimpleIsReachedThroughItsPlacesThePaletteAndMore(t) {
  await inBrowser(t, async (_page, browser) => {
    await inFolder({ "site/preview.html": FAKE_SIMPLE }, async (dir) => {
      const site = await serve(path.join(dir, "site"));
      try {
        const side = sideOf(site);
        assert.equal(await probe({ browser, side, design: "simple" }), "yes");
        const want = { shoot: true, overflow: true, rules: true, axe: false };
        const found = await Promise.all(
          SCREENS.map((screen) =>
            visitPage({
              browser,
              side,
              shot: { design: "simple", theme: "light", size: { width: 1200, height: 900 }, screen },
              want,
              axePath: null,
            }),
          ),
        );
        found.forEach((result, i) => {
          assert.equal(result.failed, null, `${SCREENS[i]}: ${result.failed}`);
          assert.deepEqual(result.problems, [], SCREENS[i]);
          assert.ok(result.png.length > 200, `${SCREENS[i]} has a picture`);
          assert.equal(result.overflow.scrollWidth, result.overflow.clientWidth);
          assert.ok(Array.isArray(result.rules));
        });
        // The rules saw each screen as it is: the tabs and Archive are too small and the rest is
        // not, and a dialog is all there is while it is open.
        const broken = (screen) =>
          found[SCREENS.indexOf(screen)].rules.map((item) => `${item.rule}: ${item.where}`);
        assert.deepEqual(broken("today"), []);
        assert.deepEqual(broken("reports"), ['target: button "Chats"', 'target: button "Summaries"']);
        assert.deepEqual(broken("project"), []);
        assert.deepEqual(broken("palette"), []);
        assert.deepEqual(broken("archive"), ['target: button "Archive"']);
      } finally {
        await site.close();
      }
    });
  });
}

export async function aSimpleShellThatLacksAPlaceFailsOnlyThatScreen(t) {
  await inBrowser(t, async (_page, browser) => {
    const without = FAKE_SIMPLE.replace("<button>Activity</button>", "");
    await inFolder({ "site/preview.html": without }, async (dir) => {
      const site = await serve(path.join(dir, "site"));
      try {
        const side = sideOf(site);
        const shot = (screen) => ({
          design: "simple",
          theme: "light",
          size: { width: 1200, height: 900 },
          screen,
        });
        const want = { shoot: true, overflow: false, rules: false, axe: false };
        // The fake has no Activity: asking for it times out after the limit of a step, and says so.
        const log = await visitPage({ browser, side, shot: shot("log"), want, axePath: null, stepMs: 600 });
        assert.match(log.failed, /Timeout 600ms exceeded/);
        assert.ok(log.failure.length > 200, "a picture of where it stopped");
        const tidy = await visitPage({ browser, side, shot: shot("tidy"), want, axePath: null });
        assert.equal(tidy.failed, null);
      } finally {
        await site.close();
      }
    });
  });
}

export async function aBuildThatDrawsDetailedWhenAskedForSimpleIsNotSimple(t) {
  await inBrowser(t, async (_page, browser) => {
    // What a build with no Simple shell draws for ?design=simple: the Detailed Today.
    const detailed = `<!doctype html><html lang="en"><body><nav id="side"><button class="sb-item">Today</button></nav><main><h1>Today</h1></main></body></html>`;
    await inFolder({ "site/preview.html": detailed }, async (dir) => {
      const site = await serve(path.join(dir, "site"));
      try {
        const side = sideOf(site);
        assert.equal(await probe({ browser, side, design: "simple" }), "no");
        assert.equal(await probe({ browser, side, design: "detailed" }), "yes");
      } finally {
        await site.close();
      }
    });
  });
}

// --- The whole run ------------------------------------------------------------------------------

export async function aCommitThatIsNotThereIsRefusedBeforeAnythingIsBuilt(t) {
  if (!findBrowser()) return t.skip("no Chromium");
  await assert.rejects(
    main(["--compare", "no-such-commit-anywhere", "--design", "detailed", "--screens", "today"]),
    (error) => error instanceof UsageError && /not a commit in this repository/.test(error.message),
  );
}

export async function aRunBuildsThePreviewAndDrawsTheScreenInAFreshSession(t) {
  if (!findBrowser()) return t.skip("no Chromium");
  const out = mkdtempSync(path.join(os.tmpdir(), "laci-preview-run-"));
  const lines = [];
  const log = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    const code = await main([
      "--design",
      "detailed",
      "--screens",
      "today",
      "--widths",
      "1440",
      "--themes",
      "light",
      "--overflow",
      "--out",
      out,
      "--jobs",
      "1",
    ]);
    assert.equal(code, 0, lines.join("\n"));
  } finally {
    console.log = log;
  }
  const written = readdirSync(out);
  rmSync(out, { recursive: true, force: true });
  assert.deepEqual(written, ["today-detailed-light-1440x900.png"]);
  assert.match(lines.join("\n"), /Taking 1 shot: detailed/);
  assert.match(lines.join("\n"), /overflow: nothing scrolls sideways\./);
}
