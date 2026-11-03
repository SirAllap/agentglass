/*
 * One place chooses a model: the Reviewer role, in Orchestration. Preflight
 * reads it, a model stored at the old per-project key is adopted into it once,
 * and a Reviewer on another CLI does not make Preflight hand Claude a foreign
 * model name.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyRule } from "../../shared/orchestration.ts";

const HOME = mkdtempSync(join(tmpdir(), "agx-one-place-"));
process.env.XDG_CONFIG_HOME = HOME;
mkdirSync(join(HOME, "agentglass"), { recursive: true });

const Flight = await import("../src/flightPlan.ts");
const Store = await import("../src/preflightStore.ts");
const Config = await import("../src/config.ts");
const Orch = await import("../src/orchestration.ts");
const PolicyEval = await import("../src/orchpolicy.ts");

const { db } = await import("../src/db.ts");

const ROOT = "/work/orbit";
const CONFIG = join(HOME, "agentglass", "config.json");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** The retired key, written the way a build before this change wrote it. */
const putOld = (root: string, model: string) =>
  db.query(`INSERT INTO flight_plan_setting (root, key, value) VALUES (?, ?, ?) ON CONFLICT (root, key) DO UPDATE SET value = excluded.value`)
    .run(root, Store.PREFLIGHT_MODEL_ALIAS, JSON.stringify(model));
const oldModel = (root: string) => Store.retiredSetting(root, Store.PREFLIGHT_MODEL_ALIAS);

describe("the Preflight model is the Reviewer role's", () => {
  test("writing the role moves what Preflight will use", () => {
    Config.writeWorkerRole("reviewer", { provider: "claude", model: "haiku" });
    expect(Config.workerRoles().reviewer.model).toBe("haiku");
    expect(Flight.preflightModel(ROOT)).toBe("haiku");
  });

  test("a model stored at the old key is adopted into the role, once", () => {
    Config.writeWorkerRole("reviewer", { provider: "claude", model: "sonnet" });
    putOld(ROOT, "opus");

    expect(Flight.preflightModel(ROOT)).toBe("opus");
    expect(Config.workerRoles().reviewer.model).toBe("opus");
    expect(oldModel(ROOT)).toBe("");
  });

  test("a role it could not write keeps the old model instead of losing it", () => {
    Config.writeWorkerRole("reviewer", { provider: "claude", model: "sonnet" });
    putOld(ROOT, "opus");
    const good = readFileSync(CONFIG, "utf8");
    writeFileSync(CONFIG, "{ not json");

    try {
      expect(Flight.preflightModel(ROOT)).toBe("sonnet");
      expect(oldModel(ROOT)).toBe("opus");
    } finally {
      writeFileSync(CONFIG, good);
    }

    expect(Flight.preflightModel(ROOT)).toBe("opus");
    expect(oldModel(ROOT)).toBe("");
  });

  test("the run a request creates reviews with the Reviewer role's model", async () => {
    Config.writeWorkerRole("reviewer", { provider: "claude", model: "haiku" });
    Flight.__setPreflightDeps({ bin: [process.execPath, new URL("./preflightStub.ts", import.meta.url).pathname], env: { STUB_REPLY: "No findings." } });
    try {
      const r = Flight.request({ root: ROOT, moment: "manual", by: "acme" });
      if (!r.ok) throw new Error(r.error);
      expect(r.run.input.model).toBe("haiku");
      await r.done;
      expect(Store.getRun(r.run.id)?.input.model).toBe("haiku");
    } finally {
      Flight.__setPreflightDeps(null);
    }
  });

  test("a Reviewer on OpenCode reviews with its own model; any other CLI leaves Preflight on Sonnet, and the old key cannot smuggle a model in", () => {
    Config.writeWorkerRole("reviewer", { provider: "opencode", model: "opencode/big-pickle" });
    expect(Flight.preflightModel(ROOT)).toBe("opencode/big-pickle");
    expect(Flight.preflightTargetFor(ROOT).engine).toBe("opencode");
    Config.writeWorkerRole("reviewer", { provider: "qwen", model: "qwen-plus" });
    putOld(ROOT, "opus");
    expect(Flight.preflightModel(ROOT)).toBe("sonnet");
    expect(Flight.preflightTargetFor(ROOT).engine).toBe("claude");
    expect(oldModel(ROOT)).toBe("");
  });
});

describe("a project's rule moves what Preflight runs on", () => {
  const WITH_RULE = "/work/orbit-with-rule";
  const PLAIN = "/work/orbit-plain";
  const rule = (workers: PolicyRule["workers"]): PolicyRule => ({
    id: "agx-opencode-workers", name: "Orbit workers on OpenCode Go", enabled: true,
    when: [{ kind: "always" }], workers,
  });
  const store = async (root: string, r: PolicyRule) => {
    const base = Orch.readPolicy(root).policy;
    const written = Orch.writePolicy(root, { ...base, rules: [...base.rules.filter((x) => x.id !== r.id), r] });
    if (!written.ok) throw new Error(written.error);
    await PolicyEval.evaluate();
  };

  test("the global Reviewer on Claude does not beat the project's rule: the first engine of its chain is the target", async () => {
    Config.writeWorkerRole("reviewer", { provider: "claude", model: "sonnet" });
    await store(WITH_RULE, rule({ reviewer: [
      { engine: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      { engine: "opencode", model: "glm-5.3-flash-free" },
      { engine: "opencode", model: "big-pickle" },
    ] }));
    const t = Flight.preflightTargetFor(WITH_RULE);
    expect(t.engine).toBe("opencode");
    expect(t.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(t.fellBack).toBe(false);
    expect(Flight.preflightModel(WITH_RULE)).toBe("opencode-go/deepseek-v4.1-flash");
  });

  test("a project with no rule keeps the global Reviewer role", async () => {
    Config.writeWorkerRole("reviewer", { provider: "claude", model: "sonnet" });
    await PolicyEval.evaluate();
    expect(Flight.preflightTargetFor(PLAIN)).toEqual({ engine: "claude", model: "sonnet", fellBack: false, reviewer: "claude" });
  });

  test("a project rule on an engine a Preflight cannot run keeps the honest fallback", async () => {
    Config.writeWorkerRole("reviewer", { provider: "claude", model: "sonnet" });
    await store("/work/orbit-codex", rule({ reviewer: [{ engine: "codex", model: "gpt-5.5-codex" }] }));
    expect(Flight.preflightTargetFor("/work/orbit-codex")).toEqual({ engine: "claude", model: "sonnet", fellBack: true, reviewer: "codex" });
  });

  test("the run itself reviews on the project's engine, and its receipt names it", async () => {
    Config.writeWorkerRole("reviewer", { provider: "claude", model: "sonnet" });
    await store(WITH_RULE, rule({ reviewer: [{ engine: "opencode", model: "opencode-go/deepseek-v4.1-flash" }] }));
    Flight.__setPreflightDeps({ bin: [process.execPath, new URL("./opencodePreflightStub.ts", import.meta.url).pathname], env: {} });
    try {
      const r = Flight.request({ root: WITH_RULE, moment: "manual", by: "acme" });
      if (!r.ok) throw new Error(r.error);
      expect(r.run.input.engine).toBe("opencode");
      expect(r.run.input.model).toBe("opencode-go/deepseek-v4.1-flash");
      await r.done;
      const cert = Store.getRun(r.run.id)?.certificate;
      expect(cert?.engine).toBe("opencode");
      expect(cert?.model).toBe("deepseek-v4.1-flash");
    } finally {
      Flight.__setPreflightDeps(null);
    }
  });
});
