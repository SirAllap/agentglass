/* An existing project is open too: the build that made worker commands open by default closes nothing at boot. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-cmdopen-"));
process.env.XDG_CONFIG_HOME = HOME;
mkdirSync(join(HOME, "agentglass"), { recursive: true });
const Store = await import("../src/preflightStore.ts");
afterAll(() => { if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG; rmSync(HOME, { recursive: true, force: true }); });

describe("worker commands on an existing project", () => {
  test("a project the store already knew, with no stored command keys, reads open after boot", () => {
    Store.putSetting("/work/orbit", "workers.gitInternals", false);
    expect((Store as Record<string, unknown>).migrateWorkerCommands).toBeUndefined();
    expect(Store.workerClosedCommands("/work/orbit")).toEqual([]);
    expect(Store.getSetting("/work/orbit", "workers.commands.git-push")).toBe(true);
  });
  test("a pin somebody stored is kept, and a project can still close one", () => {
    Store.putSetting("/work/orbit", "workers.commands.ssh", false);
    expect(Store.workerClosedCommands("/work/orbit")).toEqual(["ssh"]);
    expect(Store.workerClosedCommands("/work/acme")).toEqual([]);
  });
});
