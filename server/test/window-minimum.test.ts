/**
 * The main window has a floor. Below 640 px the dashboard has no layout to fall
 * back to (the Settings sidebar does not collapse), so the shell refuses to go
 * narrower than the width the panels were measured readable at. A rule about
 * source is asserted against source: there is no Electron in the test run.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const main = await Bun.file(join(import.meta.dir, "../../electron/main.js")).text();

test("the main window cannot be dragged narrower than 640 px or shorter than 480 px", () => {
  const start = main.indexOf("const win = new BrowserWindow({");
  expect(start).toBeGreaterThan(-1);
  const body = main.slice(start, main.indexOf("\n  });", start));
  expect(body).toMatch(/minWidth:\s*640\b/);
  expect(body).toMatch(/minHeight:\s*480\b/);
});
