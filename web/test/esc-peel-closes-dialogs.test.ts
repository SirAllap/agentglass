/*
 * The remote `esc` door peeled the palette, help, stats, skills, search,
 * session and settings, and left the Machine dialog, the project picker and
 * the window switcher on screen: an agent that opened one of them could not
 * close it, and a walk through the doors stacked three dialogs on top of one
 * another. Asserted against source, as there is no renderer here.
 * Ceiling: the Finder and the bench are not peeled yet.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url).pathname, "utf8");
const start = app.indexOf("peel: () => {");
const peel = app.slice(start, app.indexOf("\n      },", start));

test("peel closes every dialog a door can open", () => {
  expect(start).toBeGreaterThan(0);
  for (const call of ["setMachine(null)", "setProjectOpen(false)", "setAwaitingPick(false)", "setWindowsOpen(false)"]) {
    expect(peel).toContain(call);
  }
});
