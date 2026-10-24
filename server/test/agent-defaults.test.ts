/*
 * The Agents page's server settings: who is told when the gate holds an action,
 * what a held action does when nobody answers, and the rules every chat turn is
 * denied. Each is stored in config.json, reachable through the settings door
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
let chat: typeof import("../src/chat.ts");
let cc: typeof import("../src/agents/claudecode.ts");
beforeAll(async () => {
  mkdirSync(join(HOME, "agentglass"), { recursive: true });
  cfg = await import("../src/config.ts");
  defsOf = (await import("../src/serverSettings.ts")).serverSettingDefs;
  chat = await import("../src/chat.ts");
  cc = await import("../src/agents/claudecode.ts");
});
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const def = (id: string) => defsOf({ terminalEnabled: false, budgetWrites: false, policyChanged() {} }).find((d) => d.id === id)!;

describe("stored and read back", () => {
  test("a fresh install: the gate tells only the person and drops, chats start where they did", () => {
    rmSync(join(HOME, "agentglass", "config.json"), { force: true });
    expect([cfg.gateAnswerer(), cfg.gateOnTimeout(), cfg.chatStartIn(), cfg.chatMode(), cfg.chatDeny()]).toEqual(["me", "drop", "last", "inherit", []]);
  });
  test("each value is checked against its own list, and one bad field saves nothing", () => {
    expect(cfg.writeAgentDefaults({ gateAnswerer: "orchestrator", gateOnTimeout: "ask", chatStartIn: "open", chatMode: "plan" }).ok).toBe(true);
    expect([cfg.gateAnswerer(), cfg.gateOnTimeout(), cfg.chatStartIn(), cfg.chatMode()]).toEqual(["orchestrator", "ask", "open", "plan"]);
    expect(cfg.writeAgentDefaults({ chatMode: "bypassPermissions" }).ok).toBe(false);
    expect(cfg.writeAgentDefaults({ gateAnswerer: "everybody" }).ok).toBe(false);
    expect(cfg.chatMode()).toBe("plan");
  });
  test("deny rules: one per line, a rule that does not parse refuses the whole list", () => {
    expect(cfg.writeAgentDefaults({ chatDeny: "Bash(gh pr merge:*)\nEdit" }).ok).toBe(true);
    expect(cfg.chatDeny()).toEqual(["Bash(gh pr merge:*)", "Edit"]);
    expect(cfg.writeAgentDefaults({ chatDeny: ["Edit", "rm -rf /"] }).ok).toBe(false);
    expect(cfg.chatDeny()).toEqual(["Bash(gh pr merge:*)", "Edit"]);
  });
});

describe("the settings door", () => {
  test("every one is a def on the Agents page with a class", () => {
    for (const id of ["gate.answerer", "gate.onTimeout", "chats.startIn", "chats.mode", "chats.deny"]) {
      expect(def(id)?.page, id).toBe("hooks");
      expect(classOf(id), id).not.toBeNull();
    }
  });
  test("a def refuses what the list does not hold, in words", () => {
    expect(def("gate.answerer").validate("nobody")).toEqual({ error: "me or orchestrator" });
    expect(def("chats.mode").validate("bypassPermissions")).toHaveProperty("error");
    expect(def("chats.deny").validate(["Bash(curl:*)"])).toEqual({ value: ["Bash(curl:*)"] });
    expect(def("chats.deny").validate("not a rule")).toHaveProperty("error");
  });
  test("an agent: the safe direction applies at once, the wider one waits for the person", () => {
    expect(agentVerdict("gate.answerer", "me", "orchestrator", false)).toBe("ask");
    expect(agentVerdict("gate.answerer", "orchestrator", "me", false)).toBe("apply");
    expect(agentVerdict("gate.onTimeout", "drop", "ask", false)).toBe("apply");
    expect(agentVerdict("chats.startIn", "last", "open", false)).toBe("apply");
    expect(agentVerdict("chats.mode", "plan", "acceptEdits", false)).toBe("ask");
    expect(agentVerdict("chats.mode", "inherit", "default", false)).toBe("apply");
    expect(agentVerdict("chats.mode", "acceptEdits", "inherit", false)).toBe("ask");
    expect(agentVerdict("chats.deny", ["Edit"], ["Edit", "Bash(rm:*)"], false)).toBe("apply");
    expect(agentVerdict("chats.deny", ["Edit", "Bash(rm:*)"], ["Edit"], false)).toBe("ask");
  });
  test("applying through the def writes the same file the page reads", async () => {
    expect(await def("gate.onTimeout").apply("drop")).toEqual({ ok: true });
    expect(cfg.gateOnTimeout()).toBe("drop");
    expect(def("gate.onTimeout").read()).toBe("drop");
  });
});

describe("applied", () => {
  const plan: Parameters<typeof chat.turnArgv>[1] = { ok: true, dir: "/repo", text: "hi", model: "claude-opus-5", mode: "default", effort: "", resumeId: "", images: [], allow: [] };
  test("a chat turn carries the rules as one element ahead of the flag that closes the list", () => {
    cfg.writeAgentDefaults({ chatDeny: "Bash(gh pr merge:*)\nEdit" });
    const a = chat.turnArgv("claude", plan);
    const i = a.indexOf("--disallowedTools");
    expect(a[i + 1]).toBe("Bash(gh pr merge:*) Edit");
    expect(a[i + 2]).toBe("--permission-mode");
  });
  test("no rules, no flag", () => {
    cfg.writeAgentDefaults({ chatDeny: [] });
    expect(chat.turnArgv("claude", plan)).not.toContain("--disallowedTools");
  });
  test("a chat in a pane gets them too, and a launch that sets none gets none", () => {
    const spec = { sessionId: "s", cwd: "/repo", model: "m", effort: "", mode: "default", fresh: true };
    const a = cc.claudeCode.argv({ ...spec, deny: ["Edit"] });
    expect(a[a.indexOf("--disallowedTools") + 1]).toBe("Edit");
    expect(a.indexOf("--disallowedTools")).toBeLessThan(a.indexOf("--permission-mode"));
    expect(cc.claudeCode.argv(spec)).not.toContain("--disallowedTools");
  });
});
