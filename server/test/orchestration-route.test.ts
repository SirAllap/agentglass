/*
 * GET and POST /orchestration through a booted server: what is stored, who may
 * store it, and that the settings the policy sits on top of do not move when it
 * is written. The server runs with a machine token, so "an agent on this
 * machine" is a real caller here and not an absent one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { allowed } from "../src/auth.ts";
import type { Policy } from "../../shared/orchestration.ts";

const TOKEN = "tok-orchestration-example";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { Authorization: `Bearer ${TOKEN}` };
// What the app's own window sends: the machine token and its own origin.
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
const fromAgent = { ...auth, "Content-Type": "application/json" };

const get = async <T,>(path: string): Promise<T> => (await fetch(base + path, { headers: auth })).json() as Promise<T>;
const save = (policy: unknown, root?: string, headers: Record<string, string> = fromApp()) =>
  fetch(base + "/orchestration", { method: "POST", headers, body: JSON.stringify({ root, policy }) });
type View = { ok: boolean; scope: "project" | "global"; overrides: string[]; policy: Policy };
const current = async (root?: string) => get<View>(`/orchestration${root ? `?root=${encodeURIComponent(root)}` : ""}`);
const roles = () => get<{ roles: Record<string, { provider: string; model: string }> }>("/agents/roles");

const rule = (id: string) => ({
  id, name: `Rule ${id}`, enabled: true, when: [{ kind: "always" }],
  workers: { builder: [{ engine: "opencode", model: "opencode/big-pickle" }] },
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-orch-route-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "o.db"),
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

describe("/orchestration", () => {
  test("with nothing stored it answers today's base and no rules", async () => {
    const v = await current();
    const r = await roles();
    expect(v.ok).toBe(true);
    expect(v.scope).toBe("global");
    expect(v.policy.rules).toEqual([]);
    for (const [id, c] of Object.entries(r.roles)) {
      expect(v.policy.base.workers[id as "scout"].value).toEqual([{ engine: c.provider, model: c.model }]);
    }
    expect(v.policy.base.orchestrator.value[0]!.engine).toBe("claude");
  });

  test("an agent with the machine token is refused, and nothing is written", async () => {
    const before = await current();
    const res = await save({ ...before.policy, rules: [rule("agent-wrote-this")] }, undefined, fromAgent);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("only the person");
    expect((await current()).policy.rules).toEqual([]);
  });

  test("a refusal is logged, with the caller", async () => {
    const { actions } = await get<{ actions: { action: string; ok: boolean }[] }>("/actions?limit=50");
    expect(actions.some((a) => a.action === "/orchestration" && !a.ok)).toBe(true);
  });

  test("the person's own window can store a policy, and it comes back", async () => {
    const before = await current();
    const res = await save({ ...before.policy, rules: [rule("a")] });
    expect(res.status).toBe(200);
    const v = await current();
    expect(v.policy.rules.map((r) => r.id)).toEqual(["a"]);
  });

  test("a refused policy names the field and writes nothing", async () => {
    const before = await current();
    const res = await save({ ...before.policy, rules: [rule("a"), { ...rule("b"), workers: { builder: [] } }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("policy.rules[1].workers.builder");
    expect((await current()).policy.rules.map((r) => r.id)).toEqual(["a"]);
  });

  test("a body with no policy is refused, not read as empty", async () => {
    const res = await fetch(base + "/orchestration", { method: "POST", headers: fromApp(), body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  test("a project override replaces the global policy whole, and removing it gives the global one back", async () => {
    const root = join(dir, "project-orbit");
    const g = await current();
    const res = await save({ ...g.policy, rules: [rule("p1"), rule("p2")] }, root);
    expect(res.status).toBe(200);
    const mine = await current(root);
    expect(mine.scope).toBe("project");
    expect(mine.policy.rules.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(mine.overrides).toContain(root);
    expect((await current()).policy.rules.map((r) => r.id)).toEqual(["a"]);
    expect((await current(join(dir, "other-project"))).policy.rules.map((r) => r.id)).toEqual(["a"]);
    const gone = await save(null, root);
    expect(gone.status).toBe(200);
    expect((await current(root)).scope).toBe("global");
  });

  test("a relative root is refused", async () => {
    const res = await fetch(base + "/orchestration?root=orbit", { headers: auth });
    expect(res.status).toBe(400);
  });

  test("storing a policy leaves /agents/roles exactly as it was", async () => {
    const before = JSON.stringify(await roles());
    const g = await current();
    expect((await save({ ...g.policy, rules: [rule("z")], limits: { maxWorkers: 5, turnMinutes: 45, maxRetries: 2 } })).status).toBe(200);
    expect(JSON.stringify(await roles())).toBe(before);
  });

  test("a base that differs writes through to the worker roles; one they cannot hold is refused first", async () => {
    const g = await current();
    const bad = structuredClone(g.policy);
    bad.base.workers.builder.value = [{ engine: "hermes", model: "" }];
    const before = JSON.stringify(await roles());
    const refused = await save(bad);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("policy.base.workers.builder");
    expect(JSON.stringify(await roles())).toBe(before);

    const good = structuredClone(g.policy);
    good.base.workers.builder.value = [{ engine: "opencode", model: "opencode/big-pickle" }];
    expect((await save(good)).status).toBe(200);
    expect((await roles()).roles.builder).toEqual({ provider: "opencode", model: "opencode/big-pickle" });
  });

  test("a fallback chain in the base is refused: it holds one choice", async () => {
    const g = await current();
    const p = structuredClone(g.policy);
    p.base.workers.scout.value = [...p.base.workers.scout.value, { engine: "codex", model: "" }];
    const res = await save(p);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("holds one choice");
  });

  test("a worker role moved on a project policy is refused: roles are global", async () => {
    const g = await current();
    const p = structuredClone(g.policy);
    p.base.workers.verifier.value = [{ engine: "opencode", model: "" }];
    const res = await save(p, join(dir, "project-orbit"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("global");
  });
});

describe("/orchestration/state", () => {
  type State = { ok: boolean; rules: { scope: string; ruleId: string; active: boolean; holding: string }[]; wakeups: unknown[] };
  // A stored rule is listed before its first evaluation writes the row, so
  // "listed" is not "settled": under load a poll caught it with active false
  // and no holding yet. Wait for the row to say something about itself.
  const settled = async (ruleId: string): Promise<State["rules"][number] | undefined> => {
    for (let i = 0; i < 100; i++) {
      const st = await get<State>("/orchestration/state");
      const r = st.rules.find((x) => x.ruleId === ruleId && x.scope === "global");
      if (r && (r.active || r.holding)) return r;
      await Bun.sleep(50);
    }
    return undefined;
  };

  test("storing a rule that says always turns it on, and the state says so", async () => {
    const g = await current();
    expect((await save({ ...g.policy, rules: [{ ...rule("on-now"), when: [{ kind: "always" }] }] })).status).toBe(200);
    const r = await settled("on-now");
    expect(r?.active).toBe(true);
  });

  test("a usage rule with no reading yet holds, and says so", async () => {
    const g = await current();
    const usage = { ...rule("watch"), when: [{ kind: "usage", provider: "codex", window: "5h", remainingAtMost: 10 }] };
    expect((await save({ ...g.policy, rules: [usage] })).status).toBe(200);
    const r = await settled("watch");
    expect(r?.active).toBe(false);
    expect(r?.holding).toMatch(/^holding: /);
  });
});

describe("who may write, at the door and in the handler", () => {
  const seat = { kind: "machine", scope: "full", principal: "seat", seat: { root: "/orbit", powers: "assign" } } as const;
  const understudy = { kind: "machine", scope: "full", principal: "understudy" } as const;

  test("a seat's token is turned away by the central gate at every power, and may still read", () => {
    for (const powers of ["speak", "nudge", "assign"] as const) {
      expect(allowed({ ...seat, seat: { root: "/orbit", powers } }, "POST", "/orchestration")).toBe(false);
    }
    expect(allowed(seat, "GET", "/orchestration")).toBe(true);
  });
  test("the understudy cannot write either", () => {
    expect(allowed(understudy, "POST", "/orchestration")).toBe(false);
  });

  test("the handler's own gate names every credential an agent can hold, so a change to the door alone does not open it", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const start = src.indexOf("function mayChangePolicy(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("caller?.principal");
    expect(body).toContain('caller?.kind === "plugin"');
    expect(body).toContain("mayHostBrowser(req)");
    expect(body).not.toContain('kind === "machine"');
  });
});
