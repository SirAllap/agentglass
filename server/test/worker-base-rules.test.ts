/*
 * The base rules that replaced the worker floor: a push to the trunk is never,
 * a force push asks, sudo asks, for the seat and for a worker alike. An install
 * that seeded its base before they existed gets them added once.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-base-rules-")));
const saved = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

const store = await import("../src/agentRulesStore.ts");
const { db } = await import("../src/db.ts");

const ROOT = join(dir, "acme", "orbit");
mkdirSync(ROOT, { recursive: true });
Bun.spawnSync(["git", "init", "-q", ROOT]);

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { const key = k === "cfg" ? "XDG_CONFIG_HOME" : k === "data" ? "XDG_DATA_HOME" : "AGENTGLASS_STATE_DIR"; if (v === undefined) delete process.env[key]; else process.env[key] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const verdict = (cmd: string, role?: "seat") => store.check(ROOT, "Bash", { command: cmd }, undefined, role).decision;

describe("base rules, seat and worker alike", () => {
  for (const role of [undefined, "seat"] as const) {
    test(`as ${role ?? "worker"}: trunk push never, branch push allowed, merge never, sudo asks`, () => {
      expect(verdict("git push origin master", role)).toBe("never");
      expect(verdict("git push origin main", role)).toBe("never");
      expect(verdict("git push origin orbit-1042", role)).toBe("allow");
      expect(verdict("gh pr merge 12", role)).toBe("never");
      expect(verdict("sudo ls", role)).toBe("ask");
      expect(verdict("rm -rf /", role)).toBe("never");
      expect(verdict("rm -rf ~", role)).toBe("never");
      expect(verdict("rm -rf /tmp/x", role)).not.toBe("never");
    });
  }
  test("an install seeded before these rules gets them added once, and a row the person set is left alone", () => {
    store.ensureBase();
    db.query("DELETE FROM agent_rules WHERE match = 'Bash(git push origin main:*)'").run();
    db.query("UPDATE agent_rules SET setting = 'allow' WHERE match = 'Bash(sudo:*)'").run();
    store.topUpBase();
    expect(verdict("git push origin main")).toBe("never");
    expect((db.query("SELECT setting FROM agent_rules WHERE match = 'Bash(sudo:*)'").get() as { setting: string }).setting).toBe("allow");
  });
});

describe("never rules reach the OpenCode lock", () => {
  test("a never prefix and an exact never line are denied in its bash map; ask is not", async () => {
    const { compileEnvelope } = await import("../src/agents/envelope.ts");
    const { DEFAULT_WORKER_ENVELOPE } = await import("../../shared/orchestration.ts");
    const { workerRole } = await import("../../shared/workerRoles.ts");
    const never = store.neverBash(ROOT);
    expect(never.prefixes).toContain("git push origin main");
    expect(never.exact).toContain("rm -rf /");
    expect(never.prefixes).not.toContain("sudo");
    const role = workerRole("builder")!;
    const c = compileEnvelope("opencode", role, DEFAULT_WORKER_ENVELOPE, "m", join(dir, "env"), [], [], never);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const cfg = JSON.parse(Object.values(c.env).find((v) => v.includes('"permission"')) ?? "{}");
    const bash = cfg.permission.bash;
    expect(bash["rm -rf /"]).toBe("deny");
    expect(bash["rm -rf /tmp/x"]).toBeUndefined();
    expect(Object.keys(bash).some((k) => k.includes("git*push*origin*main"))).toBe(true);
  });
});

describe("other spellings of the same never", () => {
  test("a push to the trunk written another way, and rm -rf of a root glob, are never", () => {
    for (const c of ["git push -u origin main", "git push origin HEAD:main", "git push origin HEAD:master"]) {
      expect(verdict(c), c).toBe("never");
    }
    expect(verdict("rm -rf /tmp/x")).not.toBe("never");
  });
});
