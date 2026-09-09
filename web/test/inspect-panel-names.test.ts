/**
 * A PANEL THAT DID NOT CHANGE MUST NOT REPORT THAT IT DID.
 *
 * Three of the tabs are not named what the front-end calls them — Performance
 * is `timeline`, Memory is `heap-profiler`, Application is `resources` — and
 * `DevToolsAPI.showPanel` on an id it does not know returns without throwing
 * and without switching. So the verb answered "via DevToolsAPI.showPanel" for
 * all three and photographed whatever was already up: measured, the three
 * files came back byte-identical, and identical to the shot before them.
 *
 * Two halves, and both are needed. The names are mapped, so the word on the tab
 * works; and the switch is read back off the front-end's own DOM, so an id
 * nothing knows is an error rather than a success.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../electron/main.js", import.meta.url), "utf8");

/** The panel handler's body, balanced rather than sliced at a fixed length. */
function handler(): string {
  const at = SRC.indexOf('ipcMain.handle("ag:browserDevtoolsPanel"');
  expect(at, "the panel handler moved").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = SRC.indexOf("{", at); i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error("unbalanced");
}

test("the three tabs whose id differs from their name are mapped", () => {
  const body = handler();
  for (const [name, id] of [["performance", "timeline"], ["memory", "heap-profiler"], ["application", "resources"]]) {
    expect(body, `${name} is not mapped to ${id}`).toMatch(new RegExp(`${name}:\\s*"${id}"`));
  }
});

test("the switch is read back rather than assumed", () => {
  const body = handler();
  /* The selected tab, off the front-end's own DOM. Without this the call
     returning IS the answer, which is the bug. */
  expect(body).toContain("tabbed-pane-header-tab.selected");
  /* A success is conditional on that reading... */
  expect(body).toMatch(/if \(await settled\(\)\) return \{ via/);
  /* ...and a name this front-end does not have is an error that says what it
     does have, rather than a switch reported over the panel already up. */
  expect(body).toContain("this front-end has no panel called");
});

test("nothing in the panel switch can hang the verb", () => {
  const body = handler();
  /* A dynamic import inside somebody else's page: measured, a promise that
     never settled there was twenty seconds and a timeout on every panel. */
  expect(body).toMatch(/const soon = \(p, ms\) => Promise\.race/);
  expect(body).toContain('soon(import("./ui/legacy/legacy.js"), 2000)');
  expect(body).toMatch(/soon\(vm\.showView\(id\), 2000\)/);
});

test("the CLI's help names the tabs, not only the internal ids", () => {
  const cli = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");
  const at = cli.indexOf("inspect panel needs a panel");
  expect(at, "the help line moved").toBeGreaterThan(-1);
  const line = cli.slice(at, at + 400);
  for (const w of ["performance", "memory", "application", "timeline", "heap-profiler", "resources"]) {
    expect(line, `${w} is missing from the help`).toContain(w);
  }
});
