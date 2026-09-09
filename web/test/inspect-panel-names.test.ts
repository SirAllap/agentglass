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
  /* A name this front-end does not have is an error that says what it DOES
     have, rather than a switch reported over the panel already up. */
  expect(body).toContain("this front-end has no panel called");
});

/** Just the script injected into the front-end — the handler around it is
 *  ours and may await whatever it likes. */
function injected(): string {
  const body = handler();
  const at = body.indexOf("const script = `");
  expect(at, "the injected script moved").toBeGreaterThan(-1);
  const from = at + "const script = `".length;
  const to = body.indexOf("`;", from);
  expect(to, "the injected script is unterminated").toBeGreaterThan(from);
  return body.slice(from, to);
}

test("the panel switch waits for nothing", () => {
  const body = injected();
  /* The inspector view is hidden, and Chromium freezes the timers of a page
     nobody is showing — so a poll never advances and the verb never answers.
     Measured: twenty seconds and a timeout on every panel, while the panel had
     changed. No timers, no awaits, no dynamic import in there. */
  expect(body).not.toContain("setTimeout");
  expect(body).not.toContain("setInterval");
  expect(body).not.toContain("await ");
  expect(body).not.toContain("import(");
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
