/*
 * THE FLOW AS DATA — the steps a project's orchestrator follows, before any
 * screen draws them.
 *
 * Two halves. The first is in this process: the record, the template, the
 * paragraph the seat is told, and that the policy and the flow cannot overwrite
 * each other. The second boots a server, because the routes are the only way a
 * person reaches this, and who may write them is a promise and not a comment.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { allowed } from "../src/auth.ts";
import { NEVER_LIFTABLE } from "../../shared/workerRoles.ts";
import type { Flow } from "../../shared/flow.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-flow-"));
const restore = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AGENTGLASS_DOCTRINE: process.env.AGENTGLASS_DOCTRINE,
  AGENTGLASS_DB: process.env.AGENTGLASS_DB,
};
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DOCTRINE = join(dir, "doctrine");
process.env.AGENTGLASS_DB = join(dir, "flow.db");

const { readFlow, writeFlow, deleteFlow, renderFlowForOrchestrator, roleLines, ROLE_LINES_MAX } = await import("../src/flow.ts");
const { readStoredFlow } = await import("../src/config.ts");
const { readPolicy, writePolicy } = await import("../src/orchestration.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { validateFlow, FLOW_ICONS, FLOW_HUES } = await import("../../shared/flow.ts");
const Seat = await import("../src/seat.ts");
const { putSetting } = await import("../src/preflightStore.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The template with QA between the Inspector and the Verifier, as the owner asked for it. */
function withQa(): Flow {
  const f = templateFlow();
  const after = f.path.indexOf("inspector") + 1;
  f.path = [...f.path.slice(0, after), "qa-only", ...f.path.slice(after)];
  f.roster = f.roster.map((r) => (r.id === "qa-only" ? { ...r, required: true } : r));
  f.blocks = f.path.map((id, i) => ({ id, x: i * 240, y: 0 }));
  f.edges = [
    ...f.edges,
    { from: "inspector", to: "qa-only", on: "pass" },
    { from: "qa-only", to: "verifier", on: "pass" },
    { from: "qa-only", to: "builder", on: "fail", maxRounds: 2 },
  ];
  return f;
}

describe("the flow a project has when it saved none", () => {
  test("is the template, and it is data rather than a picture", () => {
    const v = readFlow(join(dir, "proj-template"));
    expect(v.scope).toBe("template");
    expect(v.flow.path).toEqual(["planner", "builder", "inspector", "verifier", "landing"]);
    expect(v.flow.roster.map((r) => r.id)).toContain("qa-only");
    expect(v.flow.roster.every((r) => r.required === false)).toBe(true);
  });

  /* The mockup is the contract for the shape: every stage word, role name and
     prompt the editor draws comes from here, and a screen may not need a field
     that this data does not carry. */
  test("carries every stage, role and prompt the approved mockup draws", () => {
    const f = templateFlow();
    expect(f.stages.map((s) => s.label)).toEqual(["Shaping", "In development", "In code review", "QA", "Verifier", "Ready to land"]);
    expect(f.roster.map((r) => r.name)).toEqual([
      "Planner", "Builder", "Inspector", "Verifier", "Landing",
      "QA-only", "Continuous development", "DevOps · server", "Security",
      "Frontend", "Backend · Node", "CI", "Deployment", "Docs",
    ]);
    for (const r of f.roster) {
      expect(r.does.length).toBeGreaterThan(10);
      expect(r.prompt.length).toBeGreaterThan(40);
      expect(f.stages.some((s) => s.id === r.stage)).toBe(true);
      expect(FLOW_ICONS).toContain(r.ico as (typeof FLOW_ICONS)[number]);
      expect(FLOW_HUES).toContain(r.hue as (typeof FLOW_HUES)[number]);
    }
    /* The QA column the editor's board draws: QA-only sits in it, not in the
       Verifier's, so the board and the roster agree on the stage's name. */
    expect(f.roster.find((r) => r.id === "qa-only")!.stage).toBe("qa");
    const landing = f.roster.find((r) => r.id === "landing")!;
    expect(landing.actor).toBe("person");
    expect(landing.chain).toEqual([]);
    expect(landing.hue).toBe("warning");
    expect(f.roster.find((r) => r.id === "qa-only")!.chain.length).toBeGreaterThan(0);
    expect(f.edges.find((e) => e.from === "verifier" && e.on === "fail")!.maxRounds).toBe(2);
  });

  test("gives every built-in role its chain from the policy, read and never saved", () => {
    const root = join(dir, "proj-chains");
    const v = readFlow(root);
    const planner = v.flow.roster.find((r) => r.id === "planner")!;
    expect(planner.policyRole).toBe("scout");
    expect(planner.chain).toEqual([]);
    expect(planner.resolvedChain!.length).toBeGreaterThan(0);
    // A role a person's team owns keeps its own chain, resolved as itself.
    const qa = v.flow.roster.find((r) => r.id === "qa-only")!;
    expect(qa.resolvedChain).toEqual(qa.chain);
  });

  test("a save that carries the resolved chains back does not store them", () => {
    const root = join(dir, "proj-no-resolved");
    const v = readFlow(root);
    expect(writeFlow(root, v.flow).ok).toBe(true);
    const stored = readStoredFlow(root)!;
    for (const r of stored.roster) expect(r.resolvedChain).toBeUndefined();
    expect(stored.roster.find((r) => r.id === "planner")!.chain).toEqual([]);
  });
});

describe("the round cap is the setting, not the arrow", () => {
  const cap = (v: ReturnType<typeof readFlow>, from: string) => v.flow.edges.find((e) => e.on === "fail" && e.from === from)!.maxRounds;

  test("the reviewer's fail arrow reads the setting, the other arrows keep their own", () => {
    const root = join(dir, "proj-rounds-read");
    putSetting(root, "orchestration.review.rounds", 5);
    const v = readFlow(root);
    expect(cap(v, "inspector")).toBe(5);
    expect(cap(v, "verifier")).toBe(2);
  });

  test("a write that edits that arrow is ignored, and the setting moves it instead", () => {
    const root = join(dir, "proj-rounds-write");
    putSetting(root, "orchestration.review.rounds", 4);
    const flow = readFlow(root).flow;
    flow.edges = flow.edges.map((e) => (e.on === "fail" && e.from === "inspector" ? { ...e, maxRounds: 9 } : e));
    expect(writeFlow(root, flow).ok).toBe(true);
    const stored = readStoredFlow(root)!;
    expect(stored.edges.find((e) => e.on === "fail" && e.from === "inspector")!.maxRounds).not.toBe(9);
    expect(cap(readFlow(root), "inspector")).toBe(4);
    putSetting(root, "orchestration.review.rounds", 2);
    expect(cap(readFlow(root), "inspector")).toBe(2);
  });

  test("a write that edits another fail arrow is kept", () => {
    const root = join(dir, "proj-rounds-other");
    const flow = readFlow(root).flow;
    flow.edges = flow.edges.map((e) => (e.on === "fail" && e.from === "verifier" ? { ...e, maxRounds: 7 } : e));
    expect(writeFlow(root, flow).ok).toBe(true);
    expect(cap(readFlow(root), "verifier")).toBe(7);
  });

  test("the orchestrator is told the one number", () => {
    const root = join(dir, "proj-rounds-brief");
    putSetting(root, "orchestration.review.rounds", 6);
    expect(renderFlowForOrchestrator(readFlow(root).flow)).toContain("up to 6 times");
  });
});

describe("a step a person adds", () => {
  test("QA between the Inspector and the Verifier survives a write and a read", () => {
    const root = join(dir, "proj-orbit");
    const r = writeFlow(root, withQa());
    expect(r.ok).toBe(true);
    const v = readFlow(root);
    expect(v.scope).toBe("project");
    expect(v.flow.path).toEqual(["planner", "builder", "inspector", "qa-only", "verifier", "landing"]);
    expect(v.flow.roster.find((x) => x.id === "qa-only")!.required).toBe(true);
    expect(v.flow.edges.find((e) => e.from === "qa-only" && e.on === "fail")!.maxRounds).toBe(2);
  });

  test("and a second project keeps the template while the first keeps its own", () => {
    const mine = join(dir, "proj-orbit");
    const other = join(dir, "proj-acme");
    expect(writeFlow(mine, withQa()).ok).toBe(true);
    expect(readFlow(mine).flow.path).toContain("qa-only");
    expect(readFlow(other).scope).toBe("template");
    expect(readFlow(other).flow.path).not.toContain("qa-only");
  });

  test("removing the saved flow falls back to the template", () => {
    const root = join(dir, "proj-reset");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    expect(readFlow(root).scope).toBe("project");
    const r = deleteFlow(root);
    expect(r.ok).toBe(true);
    expect(r.ok && r.view.scope).toBe("template");
    expect(readFlow(root).flow.path).toEqual(["planner", "builder", "inspector", "verifier", "landing"]);
  });
});

describe("what a flow refuses, in sentences", () => {
  const errorOf = (f: unknown): string => {
    const v = validateFlow(f);
    return v.ok ? "" : v.error;
  };

  test("a failing arrow needs a target and a round cap", () => {
    const noCap = withQa();
    noCap.edges = noCap.edges.map((e) => (e.from === "qa-only" && e.on === "fail" ? { from: e.from, to: e.to, on: e.on } : e));
    expect(errorOf(noCap)).toContain("maxRounds");

    const noTarget = withQa();
    noTarget.edges = [...noTarget.edges, { from: "qa-only", on: "fail", maxRounds: 2 } as never];
    expect(errorOf(noTarget)).toMatch(/flow\.edges\[\d+\]\.to: is missing/);

    const offPath = withQa();
    offPath.edges = [...offPath.edges, { from: "qa-only", to: "docs", on: "fail", maxRounds: 2 }];
    expect(errorOf(offPath)).toContain("not on the suggested path");
  });

  test("a passing arrow carries no round cap", () => {
    const f = withQa();
    f.edges = [...f.edges, { from: "planner", to: "builder", on: "pass", maxRounds: 2 } as never];
    expect(errorOf(f)).toContain("belongs to a failing arrow");
  });

  test("two roles cannot share an id", () => {
    const f = withQa();
    f.roster = [...f.roster, { ...f.roster.find((r) => r.id === "qa-only")!, name: "QA again" }];
    expect(errorOf(f)).toContain("already another role");
  });

  test("a block's icon and colour come from the drawn set", () => {
    const icon = withQa();
    icon.roster = icon.roster.map((r) => (r.id === "qa-only" ? { ...r, ico: "bogus" } : r));
    expect(errorOf(icon)).toContain(".ico: is not one of the icons");

    const hue = withQa();
    hue.roster = hue.roster.map((r) => (r.id === "qa-only" ? { ...r, hue: "pink" } : r));
    expect(errorOf(hue)).toContain(".hue: is not one of the colour tokens");
  });

  test("a role needs its one line, and a second role cannot go without it", () => {
    const f = withQa();
    const { does: _drop, ...without } = f.roster.find((r) => r.id === "docs")!;
    f.roster = f.roster.map((r) => (r.id === "docs" ? (without as typeof r) : r));
    expect(errorOf(f)).toContain("flow.roster[13].does");
  });

  test("a step nobody runs cannot be required", () => {
    const f = withQa();
    f.path = f.path.filter((id) => id !== "qa-only");
    expect(errorOf(f)).toContain("cannot be required");
  });

  test("a built-in role does not carry a chain of its own", () => {
    const f = withQa();
    f.roster = f.roster.map((r) => (r.id === "planner" ? { ...r, chain: [{ engine: "claude", model: "haiku" }] } : r));
    expect(errorOf(f)).toContain("policy's");
  });

  test("no sentence says true or false", () => {
    const f = withQa();
    const messages = [
      errorOf({ ...f, version: 2 }),
      errorOf({ ...f, roster: f.roster.map((r) => (r.id === "qa-only" ? { ...r, readsOnly: "yes" } : r)) }),
      errorOf({ ...f, roster: f.roster.map((r) => (r.id === "qa-only" ? { ...r, required: 1 } : r)) }),
      errorOf({ ...f, edges: [{ from: "planner", to: "builder", on: true }] }),
      errorOf({ ...f, path: [] }),
    ];
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(0);
      expect(m).not.toMatch(/\btrue\b|\bfalse\b/i);
    }
  });

  test("a role may be granted a command the floor refuses, and never one it keeps for a person", () => {
    const granted = withQa();
    granted.roster = granted.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["docker", "make deploy"] } : r));
    const v = validateFlow(granted);
    expect(v.ok).toBe(true);
    expect(v.ok && v.value.roster.find((r) => r.id === "qa-only")!.allow).toEqual(["docker", "make deploy"]);

    for (const never of NEVER_LIFTABLE) {
      const f = withQa();
      f.roster = f.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: [never] } : r));
      expect(errorOf(f)).toContain(`"${never}" is never granted to a worker`);
    }
    const force = withQa();
    force.roster = force.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["git push --force"] } : r));
    expect(errorOf(force)).toContain('"git push" is never granted to a worker');

    const shaped = withQa();
    shaped.roster = shaped.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["$(whoami)"] } : r));
    expect(errorOf(shaped)).toContain("is not a command prefix");

    const twice = withQa();
    twice.roster = twice.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["docker", "docker"] } : r));
    expect(errorOf(twice)).toContain("repeats a command the role already has");
  });

  test("a role id keeps its kind, so QA cannot become a reviewer under the same name", () => {
    const root = join(dir, "proj-kind");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    const next = readStoredFlow(root)!;
    next.roster = next.roster.map((r) => (r.id === "qa-only" ? { ...r, policyRole: "reviewer" as const, chain: [] } : r));
    const r = writeFlow(root, next);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("keeps its kind");
    expect(readFlow(root).flow.roster.find((x) => x.id === "qa-only")!.policyRole).toBeUndefined();
  });
});

describe("the policy and the flow are two records", () => {
  test("a policy write leaves the flow intact", () => {
    const root = join(dir, "proj-both");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    const p = readPolicy(root).policy;
    const w = writePolicy(root, { ...p, rules: [{ id: "r1", name: "Rule r1", enabled: true, when: [{ kind: "always" }], workers: { builder: p.base.workers.builder.value } }] });
    expect(w.ok).toBe(true);
    expect(readFlow(root).flow.path).toContain("qa-only");
  });

  test("a flow write leaves the policy intact, and an old record with no flow reads the template", () => {
    const root = join(dir, "proj-old");
    const p = readPolicy(root).policy;
    expect(writePolicy(root, { ...p, rules: [{ id: "keep-me", name: "Keep me", enabled: true, when: [{ kind: "always" }], workers: { builder: p.base.workers.builder.value } }] }).ok).toBe(true);
    expect(readFlow(root).scope).toBe("template");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    expect(readPolicy(root).policy.rules.map((r) => r.id)).toEqual(["keep-me"]);
  });
});

describe("the paragraph the orchestrator is told", () => {
  test("names the path, the team and the step that cannot be skipped", () => {
    const text = renderFlowForOrchestrator(withQa());
    expect(text).toContain("Planner → Builder → Inspector → QA-only → Verifier → Landing");
    expect(text).toContain("The team:");
    expect(text).toContain("QA-only cannot be skipped");
    expect(text).toContain("The orchestrator follows this flow; agentglass does not force it step by step.");
    expect(text).not.toMatch(/\btrue\b|\bfalse\b/i);
  });

  test("a roster line shows reads only and tools when set, neither when not", () => {
    const f = templateFlow();
    f.roster = f.roster.map((r) => (r.id === "inspector" ? { ...r, readsOnly: true, tools: ["read", "grep"] } : { ...r, readsOnly: false, tools: [] }));
    const text = renderFlowForOrchestrator(f);
    const line = (n: string) => text.split("\n").find((l) => l.startsWith(`${n}: `))!;
    expect(line("Inspector")).toContain("; reads only; tools: read, grep");
    expect(line("Builder")).not.toMatch(/reads only|tools:/);
    expect(text).toContain("A worker you start with --role gets that role's prompt automatically.");
  });

  test("the role lines hold the cap on a 12-role flow: tools go first, then does, names stay", () => {
    const f = templateFlow();
    const base = f.roster[0]!;
    f.roster = Array.from({ length: 12 }, (_, i) => ({ ...base, id: `r${i}`, name: `Role-${i}`, does: "d".repeat(90), readsOnly: true, tools: ["read", "run", "write", "commit", "notes"] }));
    const lines = roleLines(f.roster);
    expect(lines.length).toBeLessThanOrEqual(ROLE_LINES_MAX);
    for (let i = 0; i < 12; i++) expect(lines).toContain(`Role-${i}`);
    expect(lines).not.toContain("tools:");
    expect(lines).toContain("A worker you start with --role");
  });

  test("says so plainly when nothing is required", () => {
    expect(renderFlowForOrchestrator(templateFlow())).toContain("No step is required");
  });

  test("the real seat brief carries it, and the step a person added is in the brief", async () => {
    const root = join(dir, "proj-brief");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    const { prompt } = await Seat.seatPrompt(root, "speak", 4);
    expect(prompt).toContain("The orchestrator follows this flow; agentglass does not force it step by step.");
    expect(prompt).toContain("Planner → Builder → Inspector → QA-only → Verifier → Landing");
    expect(prompt).toContain("QA-only cannot be skipped");
  });
});

/* ── the routes, on a server of their own ───────────────────────────────── */

const TOKEN = "tok-flow-example";
let base = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = (b: string) => ({ ...auth, Origin: b, "Content-Type": "application/json" });
const fromAgent = { ...auth, "Content-Type": "application/json" };

const getFlow = async (path: string) => (await fetch(base + path, { headers: auth })).json() as Promise<{ ok: boolean; error?: string; scope?: string; flow?: Flow }>;
const putFlow = (root: string | undefined, body: unknown, headers: Record<string, string>) =>
  fetch(`${base}/flow${root ? `?root=${encodeURIComponent(root)}` : ""}`, { method: "PUT", headers, body: JSON.stringify(body) });
const removeFlow = (root: string, headers: Record<string, string>) =>
  fetch(`${base}/flow?root=${encodeURIComponent(root)}`, { method: "DELETE", headers });

describe("/flow on a server", () => {
  test("boots", async () => {
    mkdirSync(join(dir, "home"), { recursive: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "home", "config"), XDG_DATA_HOME: join(dir, "home", "data"),
        XDG_CACHE_HOME: join(dir, "home", "cache"),
        AGENTGLASS_STATE_DIR: join(dir, "home", "state"),
        AGENTGLASS_ROOT: join(dir, "home"),
        AGENTGLASS_DB: join(dir, "server.db"),
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
    /* And the in-process record, written into a home of its own above. */
  });

  test("with nothing saved it answers the template", async () => {
    const root = join(dir, "route-plain");
    const v = await getFlow(`/flow?root=${encodeURIComponent(root)}`);
    expect(v.ok).toBe(true);
    expect(v.scope).toBe("template");
    expect(v.flow!.path).toEqual(["planner", "builder", "inspector", "verifier", "landing"]);
  });

  test("a root is required, and a relative one is refused with the policy's sentence", async () => {
    const none = (await fetch(`${base}/flow`, { headers: auth })).json() as Promise<{ error: string }>;
    expect((await none).error).toContain("root:");
    const rel = (await fetch(`${base}/flow?root=orbit`, { headers: auth })).json() as Promise<{ error: string }>;
    expect((await rel).error).toContain("has to be an absolute path");
  });

  test("the person's window stores one and reads it back", async () => {
    const root = join(dir, "route-orbit");
    const res = await putFlow(root, withQa(), fromApp(base));
    expect(res.status).toBe(200);
    const v = await getFlow(`/flow?root=${encodeURIComponent(root)}`);
    expect(v.scope).toBe("project");
    expect(v.flow!.path).toContain("qa-only");

    const gone = await removeFlow(root, fromApp(base));
    expect(gone.status).toBe(200);
    expect((await getFlow(`/flow?root=${encodeURIComponent(root)}`)).scope).toBe("template");
  });

  test("an agent is refused on both verbs, and nothing is written", async () => {
    const root = join(dir, "route-agent");
    const put = await putFlow(root, withQa(), fromAgent);
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: string }).error).toContain("the flow is the person's");
    const del = await removeFlow(root, fromAgent);
    expect(del.status).toBe(403);
    expect((await getFlow(`/flow?root=${encodeURIComponent(root)}`)).scope).toBe("template");
  });

  test("a caller that names itself an agent is refused even from the app's origin", async () => {
    const root = join(dir, "route-named");
    const res = await putFlow(root, withQa(), { ...fromApp(base), "x-agentglass-agent": "acme/orbit" });
    expect(res.status).toBe(403);
    expect((await getFlow(`/flow?root=${encodeURIComponent(root)}`)).scope).toBe("template");
  });

  test("a refused body names the field and changes nothing", async () => {
    const root = join(dir, "route-bad");
    const bad = withQa();
    bad.edges = bad.edges.map((e) => (e.from === "qa-only" && e.on === "fail" ? { from: e.from, to: e.to, on: e.on } : e));
    const res = await putFlow(root, bad, fromApp(base));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("flow.edges");
    expect((await getFlow(`/flow?root=${encodeURIComponent(root)}`)).scope).toBe("template");
  });

  test("a seat reaches the flow at no power", () => {
    const seat = { kind: "machine", scope: "full", principal: "seat", seat: { root: "/orbit", powers: "assign" } } as const;
    expect(allowed(seat, "GET", "/flow")).toBe(true);
    expect(allowed(seat, "PUT", "/flow")).toBe(false);
    expect(allowed(seat, "DELETE", "/flow")).toBe(false);
  });
});
