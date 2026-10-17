// Opens the browser preview (ui/preview.html) in a real browser and checks that it draws: the Today
// screen shows, nothing logs an error, and a screenshot of each theme is saved. A Vite dev server
// runs on a free port meanwhile.
// Usage: node scripts/ui-preview-check.mjs [--out <folder>] [--browser <chromium>]
// The browser is the system's Chromium, headless. Pass --browser, or set LACI_BROWSER, when it is
// somewhere else.
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importUi, requireUi } from "./ui-module.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const out = path.resolve(
  option("--out") ?? mkdtempSync(path.join(os.tmpdir(), "laci-preview-")),
);
const browserPath = [
  option("--browser"),
  process.env.LACI_BROWSER,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].find((candidate) => candidate && existsSync(candidate));
if (!browserPath)
  throw new Error("No Chromium found. Install it, or pass --browser <path>");

/** What the preview is opened in. Fixed, so a screenshot is the same on another day or machine. */
const size = { width: 1440, height: 900 };
const themes = ["light", "dark"];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function check(browser, base, theme, problems) {
  const context = await browser.newContext({
    viewport: size,
    locale: "en-GB",
    timezoneId: "UTC",
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const problem = (text) => problems.push(`${theme}: ${text}`);
  page.on(
    "console",
    (message) =>
      message.type() === "error" && problem(`console error: ${message.text()}`),
  );
  page.on("pageerror", (error) => problem(`page error: ${error.message}`));
  page.on(
    "response",
    (response) =>
      response.status() >= 400 &&
      problem(`${response.status()} ${response.url()}`),
  );
  try {
    await page.goto(`${base}/preview.html?design=detailed&theme=${theme}`);
    await page
      .getByRole("heading", { name: "Today", level: 1 })
      .waitFor({ timeout: 30_000 });
    // The preview's clock stands at the time the fixtures were made for, whatever day this runs.
    await page
      .getByText("Thursday 8 October")
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => problem('Today does not say "Thursday 8 October"'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    const html = await page.evaluate(() => ({
      ...document.documentElement.dataset,
    }));
    for (const [key, want] of Object.entries({
      design: "detailed",
      theme,
      os: "linux",
    }))
      if (html[key] !== want)
        problem(`<html> has data-${key}=${html[key]}, wanted ${want}`);
    const file = path.join(
      out,
      `preview-detailed-${theme}-${size.width}x${size.height}.png`,
    );
    await page.screenshot({ path: file, animations: "disabled" });
    console.log(`Wrote ${file}`);
  } catch (error) {
    problem(`the Today screen did not show: ${error.message.split("\n")[0]}`);
    await page
      .screenshot({ path: path.join(out, `preview-failed-${theme}.png`) })
      .catch(() => {});
  } finally {
    await context.close();
  }
}

mkdirSync(out, { recursive: true });
const { createServer } = await importUi("vite");
const port = await freePort();
const server = await createServer({
  root: path.join(root, "ui"),
  logLevel: "warn",
  clearScreen: false,
  server: { host: "127.0.0.1", port, strictPort: true },
});
await server.listen();
const { chromium } = requireUi("playwright-core");
const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
});
const problems = [];
try {
  for (const theme of themes)
    await check(browser, `http://127.0.0.1:${port}`, theme, problems);
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) {
  console.error(
    `The preview has ${problems.length} problem${problems.length === 1 ? "" : "s"}:`,
  );
  for (const text of problems) console.error(`  ${text}`);
  process.exit(1);
}
console.log("The preview draws, in both themes, without an error.");
process.exit(0);
