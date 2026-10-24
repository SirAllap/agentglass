/*
 * The Quick setup presets, through a booted server: what a preset stores is
 * exactly the rule the copy says, "Back to what it was" restores the stored
 * policy to the byte, a preset that would be wider than the ceiling is refused
 * with the server's own sentence and changes nothing, and an agent cannot write
 * one. The presets themselves are the page's pure functions, so this is the
 * page's save, end to end, without a renderer.
 *
 * The rules below are written out by hand on purpose: they are the documented
 * policy, and web/test/orchestration-presets.test.ts asserts that the page's
 * `applyPreset` produces these same objects. (The server's typecheck does not
 * read the web's sources, so the page's function is not imported here.)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { Policy } from "../../shared/orchestration.ts";

const TOKEN = "tok-orchestration-presets-example";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
const get = async <T,>(path: string): Promise<T> => (await fetch(base + path, { headers: auth })).json() as Promise<T>;
const save = (policy: unknown, headers: Record<string, string> = fromApp()) =>
  fetch(base + "/orchestration", { method: "POST", headers, body: JSON.stringify({ policy }) });
type View = { ok: boolean; policy: Policy };
const current = async () => (await get<View>("/orchestration")).policy;
const roles = () => get<{ roles: unknown }>("/agents/roles");
/** What config.json holds for the global policy, as bytes. */
const stored = () => JSON.stringify((JSON.parse(readFileSync(join(dir, "agentglass", "config.json"), "utf8")) as { orchestration?: { global?: unknown } }).orchestration?.global);

const oc = [{ engine: "opencode", model: "" }];
const cl = [{ engine: "claude", model: "" }];
const ALWAYS = [{ kind: "always" }] as const;
const every = (c: typeof oc) => ({ scout: c, builder: c, reviewer: c, verifier: c });
const RULES = {
  "claude-orchestrates": { id: "preset-claude-orchestrates", name: "Quick setup: Claude Code orchestrates", enabled: true, when: ALWAYS, workers: every(oc) },
  "all-on-claude": { id: "preset-all-on-claude", name: "Quick setup: all workers on Claude Code", enabled: true, when: ALWAYS, workers: every(cl) },
  "save-my-plan": {
    id: "preset-save-my-plan", name: "Quick setup: save my Claude Code plan", enabled: true,
    when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 }], workers: { builder: oc },
  },
} as const;
const PRESET_IDS = Object.keys(RULES) as (keyof typeof RULES)[];
const presetRuleId = (id: keyof typeof RULES) => RULES[id].id;
/** Adds the rule the way the page does: the usage rule first, the always rules last, never twice. */
const applyPreset = (p: Policy, id: keyof typeof RULES): Policy => {
  const drop: string[] = id === "save-my-plan" ? [RULES[id].id] : [RULES["claude-orchestrates"].id, RULES["all-on-claude"].id];
  const rest = p.rules.filter((r) => !drop.includes(r.id));
  return { ...p, rules: id === "save-my-plan" ? [RULES[id] as never, ...rest] : [...rest, RULES[id] as never] };
};
// The page's undo: the policy as it is now, without the rule the preset added.
const undo = (now: Policy, id: keyof typeof RULES): Policy => ({ ...now, rules: now.rules.filter((r) => r.id !== RULES[id].id) });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-orch-presets-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "p.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("a preset, stored", () => {
  test("each one stores exactly the rule it names and leaves the rest of the policy and the worker roles alone", async () => {
    for (const id of PRESET_IDS) {
      const before = await current();
      const rolesBefore = JSON.stringify(await roles());
      const next = applyPreset(before, id);
      const res = await save(next);
      expect(res.status).toBe(200);
      const now = await current();
      const mine = now.rules.find((r) => r.id === presetRuleId(id));
      expect(mine).toEqual(next.rules.find((r) => r.id === presetRuleId(id))!);
      expect({ ...now, rules: [] }).toEqual({ ...before, rules: [] });
      expect(JSON.stringify(await roles())).toBe(rolesBefore);
      expect((await save(before)).status).toBe(200);
    }
  });

  test("Back to what it was restores the stored policy byte for byte when nothing else changed", async () => {
    const before = await current();
    const bytes = stored();
    const next = applyPreset(before, "claude-orchestrates");
    expect((await save(next)).status).toBe(200);
    expect(stored()).not.toBe(bytes);
    expect((await save(undo(await current(), "claude-orchestrates"))).status).toBe(200);
    expect(stored()).toBe(bytes);
    expect(JSON.stringify(await current())).toBe(JSON.stringify(before));
  });

  test("Back to what it was keeps a limit changed after the preset", async () => {
    const before = await current();
    const bytes = stored();
    expect((await save(applyPreset(before, "all-on-claude"))).status).toBe(200);
    const edited = await current();
    const limits = { ...edited.limits, maxWorkers: edited.limits.maxWorkers + 1 };
    expect((await save({ ...edited, limits })).status).toBe(200);
    expect((await save(undo(await current(), "all-on-claude"))).status).toBe(200);
    const now = await current();
    expect(now.limits).toEqual(limits);
    expect(now.rules.find((r) => r.id === RULES["all-on-claude"].id)).toBeUndefined();
    expect((await save(before)).status).toBe(200);
    expect(stored()).toBe(bytes);
  });

  test("a preset wider than the ceiling shows the server's sentence and changes nothing", async () => {
    const before = await current();
    const bytes = stored();
    // A ceiling that has been narrowed below what the worker default holds: the
    // person's own earlier choice, which no preset may widen or hide.
    const wide = { ...applyPreset(before, "all-on-claude"), workerDefault: { ...before.workerDefault, network: true }, ceiling: { ...before.ceiling, network: false } };
    const res = await save(wide);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("is wider than the most the main agent may allow");
    expect(stored()).toBe(bytes);
  });

  test("an agent with the machine token cannot apply one: it waits for the person, and nothing is stored", async () => {
    const before = await current();
    const bytes = stored();
    const res = await save(applyPreset(before, "all-on-claude"), { ...auth, "Content-Type": "application/json" });
    expect(res.status).toBe(202);
    expect(stored()).toBe(bytes);
  });

  test("applying twice stores the preset once", async () => {
    const before = await current();
    const once = applyPreset(before, "save-my-plan");
    await save(once);
    await save(applyPreset(await current(), "save-my-plan"));
    expect((await current()).rules.filter((r) => r.id === presetRuleId("save-my-plan")).length).toBe(1);
    await save(before);
  });

  test("a read of the policy and of the rules' state writes nothing", async () => {
    const bytes = stored();
    const actions = async () => (await get<{ actions: unknown[] }>("/actions?limit=200")).actions.length;
    const log = await actions();
    await current();
    await get("/orchestration/state");
    expect(stored()).toBe(bytes);
    expect(await actions()).toBe(log);
  });
});
