/*
 * Settings ▸ Permissions, "Who may drive the browser": the card's source.
 *
 * There is no renderer in this project, so a rule about a screen is asserted
 * against the source that draws it. The behaviour behind the card — which
 * engine or role is off, and what an agent's widening does — is
 * server/test/browser-workers.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/components/settings/pages/PermissionsPage.tsx", import.meta.url).pathname, "utf8");
const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");

/** The card's own text: from its function to the next top-level `function `. */
const from = page.indexOf("function BrowserDrivers(");
const card = from < 0 ? "" : page.slice(from, (() => {
  const next = page.slice(from + 10).search(/\n(?:export )?function [\w]/);
  return next < 0 ? page.length : from + 10 + next;
})());

describe("the card", () => {
  test("is drawn by the Permissions page, and the old modal copy is gone", () => {
    expect(card).not.toBe("");
    expect(page).toContain("<BrowserDrivers open={c.open} />");
    expect(modal).not.toContain("function WhoMayDriveBrowser(");
    expect(modal).not.toContain("function WorkerBrowserReach(");
    expect(modal).not.toContain('show("permBrowser")');
  });

  test("reads and writes the setting the server holds", () => {
    expect(card).toContain('api.settingAtGlobal("browser.workers")');
    expect(card).toContain('api.settingsDoorSet("browser.workers"');
    expect(card).toContain("BROWSER_ENGINES");
    expect(card).toContain("BROWSER_ROLES");
    expect(card).toContain("groupFlowRoleRows(flowRows)");
  });

  test("states the floor, and says a tokenless server cannot enforce the list", () => {
    expect(card).toContain('label="The floor"');
    expect(card).toContain("never yours");
    expect(card).toContain("serverIsTokenless");
    expect(card).toContain('label="No token on this server"');
    expect(card).toContain("AGENTGLASS_TOKEN");
  });

  test("no word this project keeps out of its screens is in it", () => {
    // Whole words, so "threshold" is not "hold".
    const banned = /\b(babysit|shepherd|tick|nudge|held|hold|batch|spinoff|in-flight|meta PR|non-gating|infra-rerun|pre-existing|unclassified)\b/i;
    expect(card.match(banned)).toBeNull();
  });
});
