/*
 * The worker permission mode is read per project, like the Orchestration page
 * that shows it under a project picker: picking Bypass for one project must not
 * start another project's workers bypassed. A project with no value of its own
 * takes the app-wide one, and with neither, the Flight plan builder setting.
 *
 * In-process, on the scratch database `bun test` gives every file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-permproj-")));
const saved = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

const { APP, putSetting, workerPermissionMode } = await import("../src/preflightStore.ts");

afterAll(() => {
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.cfg], ["XDG_DATA_HOME", saved.data], ["AGENTGLASS_STATE_DIR", saved.state]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("worker permission mode per project", () => {
  const orbit = "/home/acme/code/orbit";
  const other = "/home/acme/code/acme-v2";

  test("one project's Bypass leaves another project as it was", () => {
    putSetting(APP, "agents.permissionMode", "");
    putSetting(APP, "flightPlan.builder.permissions", "default");
    putSetting(orbit, "agents.permissionMode", "bypassPermissions");
    expect(workerPermissionMode(orbit)).toBe("bypassPermissions");
    expect(workerPermissionMode(other)).toBe("dontAsk");
  });

  test("a project with no value of its own takes the app-wide one", () => {
    putSetting(APP, "agents.permissionMode", "bypassPermissions");
    expect(workerPermissionMode(other)).toBe("bypassPermissions");
    putSetting(orbit, "agents.permissionMode", "dontAsk");
    expect(workerPermissionMode(orbit)).toBe("dontAsk");
  });
});
