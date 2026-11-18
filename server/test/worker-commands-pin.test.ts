/*
 * A project can pin a worker command shut and the pin survives. Every command
 * that left the floor has a key; a missing value is open, a stored false is
 * closed; an explicit write equal to the default is still stored.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-pin-")));
const saved = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
afterAll(() => {
  if (saved.cfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.cfg;
  if (saved.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved.data;
  if (saved.state === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = saved.state;
  rmSync(dir, { recursive: true, force: true });
});

const { serverSettingDefs } = await import("../src/serverSettings.ts");
const { makeDoor } = await import("../src/settingsDoor.ts");
const { SWITCHABLE_COMMANDS } = await import("../../shared/workerRoles.ts");
const store = await import("../src/preflightStore.ts");

// A root of its own: the store is one file per run, so a name another test file used would already hold a row.
const ROOT = `/work/acme/orbit-pin-${process.pid}-${Date.now()}`;
const door = makeDoor({
  defs: () => serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged: () => {} }),
  trusted: () => false, applyWindow: async () => ({ ok: true }), changed: () => {}, later: () => {},
});
const seat = { person: false, who: "seat orbit", root: ROOT };
const person = { person: true, who: "the person", root: ROOT };

describe("pinning a worker command", () => {
  test("every command that left the floor has a key, open by default", () => {
    for (const c of ["git push", "gh", "curl", "wget", "aws", "docker"]) {
      expect(SWITCHABLE_COMMANDS).toContain(c);
      expect(store.getSetting("/work/acme/none", `workers.commands.${c.replace(/ /g, "-")}` as never)).toBe(true);
    }
  });
  test("a seat's close is stored, read back closed, and lands in the closed list", async () => {
    const r = await door.change("workers.commands.git-push", false, seat);
    expect(r).toMatchObject({ ok: true, applied: true });
    expect(store.hasSetting(ROOT, "workers.commands.git-push" as never)).toBe(true);
    expect(store.workerClosedCommands(ROOT)).toContain("git push");
    expect(store.workerClosedCommands("/work/acme/other")).not.toContain("git push");
  });
  test("an explicit write equal to the default is stored, not answered unchanged", async () => {
    expect(store.hasSetting(ROOT, "workers.commands.gh" as never)).toBe(false);
    const r = await door.change("workers.commands.gh", true, person);
    expect((r as { unchanged?: true }).unchanged).toBeUndefined();
    expect(store.hasSetting(ROOT, "workers.commands.gh" as never)).toBe(true);
    // A seat's explicit write of the default is not waved through as "nothing to do" either.
    const r2 = await door.change("workers.commands.curl", true, seat);
    expect((r2 as { unchanged?: true }).unchanged).toBeUndefined();
  });
  test("a pin survives a change of default: the stored false is what is read", () => {
    expect(store.getSetting(ROOT, "workers.commands.git-push" as never)).toBe(false);
    expect(store.getSetting("/work/acme/other", "workers.commands.git-push" as never)).toBe(true);
  });
});
