/*
 * `agents.permissionMode`, `workers.projectSkills` and `workers.mcpServers` are
 * per-project settings (server/src/preflightStore.ts PER_PROJECT): the page
 * must read and write them with the open project's own root, never the
 * global door that answers for APP no matter which project is open.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PANE = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "OrchestrationPane.tsx"), "utf8");

describe("OrchestrationPane passes the open project's root for every per-project worker setting", () => {
  test("agents.permissionMode reads and writes with root", () => {
    expect(PANE).toContain('api.settingAt("agents.permissionMode", root)');
    expect(PANE).toContain('api.settingAtSet("agents.permissionMode", v, root)');
  });

  test("workers.projectSkills reads and writes with root", () => {
    expect(PANE).toContain('api.settingAt("workers.projectSkills", root)');
    expect(PANE).toContain('api.settingAtSet("workers.projectSkills", v, root)');
  });

  test("workers.mcpServers reads and writes with root", () => {
    expect(PANE).toContain('api.settingAt("workers.mcpServers", root)');
    expect(PANE).toContain('api.settingAtSet("workers.mcpServers", next, root)');
  });

  test("none of the three is still read through the rootless global door", () => {
    for (const id of ["agents.permissionMode", "workers.projectSkills", "workers.mcpServers"]) {
      expect(PANE).not.toContain(`api.settingAtGlobal("${id}")`);
    }
  });
});
