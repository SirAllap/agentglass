/*
 * Lot 7 follow-ups: the command, door and write switches are searchable on the
 * page that now holds them; the old "refused" deep link lands on Workers; and
 * "Check a command" asks the server, with no second copy of the decision.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";
import { SWITCHABLE_COMMANDS } from "../../shared/workerRoles.ts";
import { resolvePane } from "../src/lib/openSettings.ts";
import { SETTINGS_PAGE_ALIASES } from "../../shared/uiActions.ts";

const home = (id: string) => SETTINGS_ROWS.filter((r) => r.settingId === id);

describe("searchable rows on the permission pages", () => {
  test("each of the 18 command switches has one row on Workers", () => {
    for (const c of SWITCHABLE_COMMANDS) {
      const rows = home(`workers.commands.${c.replace(/ /g, "-")}`);
      expect(rows.length, c).toBe(1);
      expect(rows[0]!.pane).toBe("permWorkers");
      expect(rows[0]!.label).toContain(c);
    }
  });
  test("the three app doors are on Workers", () => {
    for (const d of ["agentglass-agent", "agentglass-ui", "agentglass-cockpit-mcp"]) expect(home(`workers.appDoors.${d}`).map((r) => r.pane)).toEqual(["permWorkers"]);
  });
  test("Jira's master switch and four kinds, and ClickUp's, are on Changes outside", () => {
    for (const id of ["jira.writes", "jira.writes.move", "jira.writes.comment", "jira.writes.link", "jira.writes.assign", "clickup.writes"]) {
      expect(home(id).map((r) => r.pane), id).toEqual(["perm"]);
    }
  });
  test("the kinds are read from the page's own list: a fifth kind there is indexed without a second edit", () => {
    const src = readFileSync(new URL("../src/components/settings/pages/PermissionsPage.tsx", import.meta.url), "utf8");
    const kinds = [...src.matchAll(/\{ kind: "([a-z]+)", label:/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual(["assign", "comment", "link", "move"]);
  });
});

describe("the old refused section", () => {
  test("every spelling of the deep link lands on Permissions", () => {
    for (const id of ["refused", "orchestration?section=refused", "orchestration#refused", "orchestration:refused", "orchestration/refused"]) expect(resolvePane(id), id).toBe("perm");
  });
  test("other orchestration links are untouched", () => {
    expect(resolvePane("orchestration")).toBe("orchestration");
    expect(resolvePane("flow")).toBe(SETTINGS_PAGE_ALIASES.flow);
  });
});

describe("Check a command", () => {
  const src = readFileSync(new URL("../src/components/settings/pages/PermissionsPage.tsx", import.meta.url), "utf8");
  test("asks the server and keeps no copy of the decision", () => {
    expect(src).toContain("api.seatCan(");
    expect(src).not.toMatch(/permCheck|checkCommand|LIFT_GROUPS|canRun/);
  });
  test("the web mirror of can.ts is gone", () => {
    expect(Bun.file(new URL("../src/lib/permCheck.ts", import.meta.url).pathname).size).toBe(0);
  });
});
