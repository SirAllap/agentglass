/*
 * Settings ▸ Browser, "Who may drive the browser": the card's source.
 *
 * There is no renderer in this project, so a rule about a screen is asserted
 * against the source that draws it. The behaviour behind the card — which
 * engine or role is off, and what an agent's widening does — is
 * server/test/browser-workers.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");

/** The card's own text: from its function to the next top-level `function `. */
const from = src.indexOf("function WhoMayDriveBrowser(");
const card = from < 0 ? "" : src.slice(from, (() => {
  const next = src.slice(from + 10).search(/\n(?:export )?function [\w]/);
  return next < 0 ? src.length : from + 10 + next;
})());

describe("the card", () => {
  test("is drawn in Settings ▸ Browser, after Where it opens", () => {
    expect(card).not.toBe("");
    expect(src).toContain("<WhoMayDriveBrowser show={showBrowserView} />");
    expect(src.indexOf("<WhoMayDriveBrowser")).toBeGreaterThan(src.indexOf('title="Where it opens"'));
    expect(src.indexOf("<WhoMayDriveBrowser")).toBeGreaterThan(src.indexOf('{show("browser") &&'));
  });

  test("names the setting the server holds, on both lists", () => {
    expect(card).toContain('title="Who may drive the browser"');
    expect(card.match(/settingId="browser\.workers"/g)).toHaveLength(2);
    expect(card).toContain('api.settingAtGlobal("browser.workers")');
    expect(card).toContain('api.settingsDoorSet("browser.workers"');
  });

  test("offers every engine and role the app knows, from the shared lists", () => {
    expect(card).toContain("BROWSER_ENGINES");
    expect(card).toContain("BROWSER_ROLES");
    expect(card).toContain("BROWSER_ENGINES : BROWSER_ROLES");
    // One toggle per member, drawn with the house toggle so it reads as on/off.
    expect(card).toContain("aria-pressed={on}");
    expect(card).toContain("on={on}");
  });

  test("states the floor and that a widening waits", () => {
    expect(card).toContain("agent:<name>");
    expect(card).toContain("never reachable");
    expect(card).toContain("Adding one back is one request that waits for you");
    // One rule, the container, not a second weaker one.
    expect(card).not.toContain("Localhost only.");
    expect(card).toContain("through the local relay");
  });

  test("says a tokenless server cannot enforce the list, and names the way out", () => {
    expect(card).toContain("serverIsTokenless");
    expect(card).toContain("This server has no token, so this list cannot be enforced");
    expect(card).toContain("AGENTGLASS_TOKEN");
    expect(card).toContain("Settings ▸ Remote");
  });

  test("says what off means, and what it does not", () => {
    expect(card).toContain("the app hands no credential and the supplied CLI and MCP server refuse");
    expect(card).toContain("hand-written process running as the same operating-system user");
    expect(card).toContain("the worker envelope (sandbox) is what limits that");
    // It does not claim more than the credential: the file is still readable by the same user.
    expect(card).not.toContain("cannot read");
  });

  test("Show it opens the Browser view outside Settings", () => {
    expect(card).toContain(">Show it</Button>");
    expect(src).toContain('emitControl({ cmd: "view", to: "browser" })');
    expect(src).toContain("closeSettings()");
  });

  test("no word this project keeps out of its screens is in it", () => {
    // Whole words, so "threshold" is not "hold".
    const banned = /\b(babysit|shepherd|tick|nudge|held|hold|batch|spinoff|in-flight|meta PR|non-gating|infra-rerun|pre-existing|unclassified)\b/i;
    expect(card.match(banned)).toBeNull();
  });
});
