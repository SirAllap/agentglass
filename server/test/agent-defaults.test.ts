/*
 * The Agents page's server settings: who is told when the gate holds an action,
 * and what a held action does when nobody answers. Each is stored in config.json, reachable through the settings door
 * with a class, and applied somewhere a person can see it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentVerdict, classOf } from "../../shared/settingClass.ts";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = join(tmpdir(), `agx-agent-defaults-${process.pid}`);
process.env.XDG_CONFIG_HOME = HOME;

let cfg: typeof import("../src/config.ts");
let defsOf: typeof import("../src/serverSettings.ts").serverSettingDefs;
let cc: typeof import("../src/agents/claudecode.ts");
beforeAll(async () => {
  mkdirSync(join(HOME, "agentglass"), { recursive: true });
  cfg = await import("../src/config.ts");
  defsOf = (await import("../src/serverSettings.ts")).serverSettingDefs;
  cc = await import("../src/agents/claudecode.ts");
});
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const def = (id: string) => defsOf({ terminalEnabled: false, budgetWrites: false, policyChanged() {} }).find((d) => d.id === id)!;

describe("stored and read back", () => {
  test("a fresh install: the gate tells only the person and drops", () => {
    rmSync(join(HOME, "agentglass", "config.json"), { force: true });
    expect([cfg.gateAnswerer(), cfg.gateOnTimeout()]).toEqual(["me", "drop"]);
  });
  test("each value is checked against its own list, and one bad field saves nothing", () => {
    expect(cfg.writeAgentDefaults({ gateAnswerer: "orchestrator", gateOnTimeout: "ask" }).ok).toBe(true);
    expect([cfg.gateAnswerer(), cfg.gateOnTimeout()]).toEqual(["orchestrator", "ask"]);
    expect(cfg.writeAgentDefaults({ gateOnTimeout: "never", gateAnswerer: "me" }).ok).toBe(false);
    expect(cfg.writeAgentDefaults({ gateAnswerer: "everybody" }).ok).toBe(false);
    expect(cfg.gateAnswerer()).toBe("orchestrator");
  });
});

describe("the settings door", () => {
  test("every one is a def on the Agents page with a class", () => {
    for (const id of ["gate.answerer", "gate.onTimeout"]) {
      expect(def(id)?.page, id).toBe("hooks");
      expect(classOf(id), id).not.toBeNull();
    }
  });
  test("a def refuses what the list does not hold, in words", () => {
    expect(def("gate.answerer").validate("nobody")).toEqual({ error: "me or orchestrator" });
    expect(def("gate.onTimeout").validate("later")).toHaveProperty("error");
  });
  test("an agent: the safe direction applies at once, the wider one waits for the person", () => {
    expect(agentVerdict("gate.answerer", "me", "orchestrator", false)).toBe("ask");
    expect(agentVerdict("gate.answerer", "orchestrator", "me", false)).toBe("apply");
    expect(agentVerdict("gate.onTimeout", "drop", "ask", false)).toBe("apply");
  });
  test("applying through the def writes the same file the page reads", async () => {
    expect(await def("gate.onTimeout").apply("drop")).toEqual({ ok: true });
    expect(cfg.gateOnTimeout()).toBe("drop");
    expect(def("gate.onTimeout").read()).toBe("drop");
  });
});

describe("applied", () => {
  test("a launch that carries deny rules puts them ahead of the flag that closes the list, and one that sets none gets none", () => {
    const spec = { sessionId: "s", cwd: "/repo", model: "m", effort: "", mode: "default", fresh: true };
    const a = cc.claudeCode.argv({ ...spec, deny: ["Edit"] });
    expect(a[a.indexOf("--disallowedTools") + 1]).toBe("Edit");
    expect(a.indexOf("--disallowedTools")).toBeLessThan(a.indexOf("--permission-mode"));
    expect(cc.claudeCode.argv(spec)).not.toContain("--disallowedTools");
  });
});
