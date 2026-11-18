/* Lot 7: Permissions. The five pages exist, every moved control keeps its key, the link rows lots 3 and 4 left are live. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";
import { SWITCHABLE_COMMANDS } from "../../shared/workerRoles.ts";

const read = (p: string) => readFileSync(new URL(`../src/components/${p}`, import.meta.url), "utf8");
const pane = read("orchestration/OrchestrationPane.tsx");
const rows = (id: string) => SETTINGS_ROWS.filter((r) => r.pane === id);

describe("Permissions pages", () => {
  test("Permissions is one page with rows; each moved key has one home", () => {
    // The old permMain, permWorkers, permBrowser and permOut routes are gone (the alias map sends them to perm), so the rows are on perm.
    expect(rows("perm").length).toBeGreaterThan(0);
    // The machine-wide worker sandbox keys live on Advanced; the Gate is on Permissions.
    const home = (sid: string) => SETTINGS_ROWS.filter((r) => r.settingId === sid).map((r) => r.pane);
    for (const sid of ["workers.gitInternals", "workers.unixSockets", "agents.permissionMode"]) expect(home(sid), sid).toEqual(["advanced"]);
    expect(home("hooks.gate")).toEqual(["perm"]);
    expect(read("settings/pages/PermissionsPage.tsx")).toContain('api.settingAtGlobal("browser.workerVerbs")');
  });
  test("the 18 command switches are all drawn on Workers, none on Flow", () => {
    expect(pane).toContain("SWITCHABLE_COMMANDS.filter((c) => c.startsWith(\"git \"))");
    const flowPart = pane.slice(pane.indexOf("\n  return (\n    <div className=\"agx-orch agx-flow\" style", pane.indexOf('if (p.part === "limits")')));
    expect(flowPart).not.toContain("WorkerCommandToggle");
    expect(SWITCHABLE_COMMANDS.length).toBe(18);
  });
  test("a command switch starts Open and is locked until the server has answered", () => {
    const at = pane.indexOf("function WorkerCommandToggle");
    const fn = pane.slice(at, pane.indexOf("function OrchestratorTimingRows"));
    expect(fn).toContain("useState(true)");
    expect(fn).toContain("r.value !== false");
    expect(fn).toContain("disabled={busy || !read}");
  });
  test("the link rows lots 3 and 4 left are live", () => {
    // The Terminal page no longer carries pointer rows: each setting has one home (ia.md).
    expect(read("settings/pages/TerminalPage.tsx")).not.toContain("permMain");
    // The Browser page's link row to Permissions lives on the Browser page now.
    expect(read("settings/pages/BrowserPage.tsx")).toContain('setPane("permBrowser"');
  });
  test("the Gate is one control, on Changes outside", () => {
    expect(read("orchestration/flow/FlowSections.tsx")).not.toContain("GateRow");
    expect(read("SettingsModal.tsx")).not.toContain("<GateCard");
  });
});
