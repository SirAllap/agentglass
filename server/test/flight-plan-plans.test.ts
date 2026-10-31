/*
 * Flight plans through a booted, isolated server: the master switch, the state
 * machine (draft, ready, go, no-go, launched), Go / No-go / Launch as the
 * person's alone, a Preflight over the plan that never holds Go, the counters.
 * The reviewer is preflightStub.ts, as in flight-plan-route.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { BUILDER_DENY, authorPrompt, builderLaunch, builderWindowName, cutBuilderWorktree, launchPrompt, reportingBlock } from "../src/flightPlan.ts";
import type { Plan } from "../src/flightPlanStore.ts";

// Launch opens a real tab: on a tmux socket of this file's own, killed when it ends.
const SOCKET = `agx-fplaunch-${process.pid}`;
const TOKEN = "tok-flight-plans-example";
let dir: string, base: string, ROOT: string, shot: string, proc: ReturnType<typeof Bun.spawn> | null = null;
const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
const fromAgent = { ...auth, "Content-Type": "application/json" };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = fromAgent) => {
  const r = await fetch(base + path, { method, headers: method === "GET" ? auth : headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const person = (method: string, path: string, body?: unknown) => call(method, path, body, fromApp());
const makePlan = async (extra: Record<string, unknown> = {}) => (await person("POST", "/flight-plan/plans", { root: ROOT, request: "Cap webhooks per tenant", ...extra })).body.plan as Plan;
const uses = async (id: string) => ((await call("GET", "/usage/opens")).body.opens as { id: string; count: number }[]).find((o) => o.id === id)?.count ?? 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-flightplans-"));
  ROOT = join(dir, "root"); mkdirSync(ROOT);
  // Launch cuts a worktree from the project's main branch, so the project is a repository with one commit.
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) Bun.spawnSync(["git", ...a], { cwd: ROOT, env: { ...process.env, HOME: dir } });
  shot = join(dir, "screen.png"); writeFileSync(shot, Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(dir, "reply.txt"), "### F1 - Major - Unclear limit\nQuote: q\nEvidence: e");
  // A stand-in `claude` first on PATH: Launch opens a real tmux tab with it, and the tab must not start the real agent.
  mkdirSync(join(dir, "bin")); writeFileSync(join(dir, "bin", "claude"), "#!/bin/sh\ncase \"$1\" in --help|--version) echo \"--name --model --effort\"; exit 0;; esac\nexec sleep 30\n", { mode: 0o755 });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, NODE_ENV: "test",
      AGENTGLASS_PREFLIGHT_BIN: new URL("./preflightStub.ts", import.meta.url).pathname, STUB_REPLY_FILE: join(dir, "reply.txt"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, AGENTGLASS_TMUX_SOCKET: SOCKET,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: ROOT, AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);
afterAll(async () => { proc?.kill(); await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore" }).exited; rmSync(dir, { recursive: true, force: true }); });

describe("the master switch", () => {
  test("off by default: no plan is created, and the list says so", async () => {
    expect((await call("GET", "/flight-plan/plans")).body).toMatchObject({ ok: true, enabled: false, plans: [] });
    const r = await person("POST", "/flight-plan/plans", { root: ROOT, request: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("Flight plan is off");
  });
  test("an agent cannot turn it on; the person can, and an agent can turn it off", async () => {
    const q = "/settings/door?id=flightPlan.enabled";
    expect((await call("POST", "/settings/door", { id: "flightPlan.enabled", value: true })).status).toBe(202);
    expect((await call("GET", q)).body.value).toBe(false);
    expect((await person("POST", "/settings/door", { id: "flightPlan.enabled", value: true })).status).toBe(200);
    expect((await call("GET", q)).body.value).toBe(true);
    expect((await call("POST", "/settings/door", { id: "flightPlan.enabled", value: false })).status).toBe(200);
    expect((await person("POST", "/settings/door", { id: "flightPlan.enabled", value: true })).status).toBe(200);
  });
});

// Go waits for a finished Preflight when the project reviews plans: tests about something else run in a project that does not.
const noReviews = () => person("POST", "/settings/door", { id: "flightPlan.preflight.reviews", value: [], root: ROOT });

describe("the state machine", () => {
  beforeAll(noReviews);
  test("a new plan is a draft; the person's press starts the author tab, an agent's does not", async () => {
    const before = await uses("flightPlan:created");
    const r = await person("POST", "/flight-plan/plans", { root: ROOT, request: "Cap webhooks per tenant.\nUse the plan table.", visual: true });
    expect(r.body.plan).toMatchObject({ state: "draft", visual: true, title: "Cap webhooks per tenant.", planMd: "", mockups: [] });
    expect(typeof r.body.ticket).toBe("string");
    const a = await call("POST", "/flight-plan/plans", { root: ROOT, request: "From an agent", title: "Agent made" });
    expect(a.body).toMatchObject({ ok: true, ticket: null });
    expect(await uses("flightPlan:created")).toBe(before + 2);
  });

  test("size is S, M or L, M by default; set on create and by PATCH, refused otherwise", async () => {
    expect((await makePlan()).size).toBe("M");
    const l = await makePlan({ size: "L" });
    expect(l.size).toBe("L");
    // An agent may raise a size, never lower it; the person may do both.
    expect((await call("PATCH", `/flight-plan/plans/${l.id}`, { size: "S" })).status).toBe(403);
    expect((await person("PATCH", `/flight-plan/plans/${l.id}`, { size: "S" })).body.plan.size).toBe("S");
    expect((await call("PATCH", `/flight-plan/plans/${l.id}`, { size: "M" })).body.plan.size).toBe("M");
    expect((await person("PATCH", `/flight-plan/plans/${l.id}`, { size: "S" })).body.plan.size).toBe("S");
    expect((await call("GET", `/flight-plan/plans/${l.id}`)).body.plan.size).toBe("S");
    expect((await call("PATCH", `/flight-plan/plans/${l.id}`, { size: "XL" })).status).toBe(400);
    expect((await person("POST", "/flight-plan/plans", { root: ROOT, request: "x", size: "m" })).status).toBe(400);
  });

  test("bad input is refused", async () => {
    const bad = async (b: Record<string, unknown>) => (await person("POST", "/flight-plan/plans", { root: ROOT, request: "x", ...b })).status;
    expect(await bad({ request: " " })).toBe(400);
    expect(await bad({ root: join(dir, "elsewhere") })).toBe(400);
    expect(await bad({ visual: "yes" })).toBe(400);
  });

  test("saving the plan makes it ready; Go needs a mockup when visual; findings never hold it", async () => {
    // The review is part of the point here: Go waits for it.
    expect((await person("POST", "/settings/door", { id: "flightPlan.preflight.reviews", value: ["plan"], root: ROOT })).status).toBe(200);
    const p = await makePlan({ visual: true });
    const set = await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# The plan\nCap per tenant." });
    expect(set.body.plan.state).toBe("ready");
    // Saving the text already started a review (the project reviews plans); wait for it, so the press below is a new one that carries the mockup.
    const settled = async () => { let r: Record<string, any> = {}; for (let i = 0; i < 100; i++) { r = (await call("GET", `/flight-plan/plans/${p.id}`)).body; if (r.run?.state === "done") break; await Bun.sleep(50); } return r; };
    await settled();
    const noShot = await person("POST", `/flight-plan/plans/${p.id}/go`, {});
    expect(noShot.status).toBe(409);
    expect(noShot.body.error).toContain("needs a mockup");
    expect((await call("PATCH", `/flight-plan/plans/${p.id}`, { mockups: [join(dir, "reply.txt")] })).status).toBe(400);
    expect((await call("PATCH", `/flight-plan/plans/${p.id}`, { mockups: [shot] })).body.plan.mockups).toEqual([{ path: shot, kind: "image" }]);
    // a Preflight with an open finding: the plan still goes
    const pf = await call("POST", `/flight-plan/plans/${p.id}/preflight`, {});
    expect(pf.body.run.state).toBe("running");
    const shown = await settled();
    expect(shown.run.certificate.mockups).toHaveLength(1);
    expect(shown.openFindings).toBe(1);
    const before = await uses("flightPlan:go");
    const go = await person("POST", `/flight-plan/plans/${p.id}/go`, {});
    expect(go.body.plan.state).toBe("launched");   // Go launches the builder
    expect(go.body.plan.decision.by).toBe("you");
    expect(await uses("flightPlan:go")).toBe(before + 1);
    await noReviews();
  });

  test("Go on a draft is refused; No-go needs a reason and sends the plan back to be edited", async () => {
    const d = await makePlan();
    expect((await person("POST", `/flight-plan/plans/${d.id}/go`, {})).status).toBe(409);
    await call("PATCH", `/flight-plan/plans/${d.id}`, { plan_md: "# v1" });
    const noReason = await person("POST", `/flight-plan/plans/${d.id}/no-go`, { reason: "  " });
    expect(noReason.status).toBe(400);
    const before = await uses("flightPlan:no-go");
    const no = await person("POST", `/flight-plan/plans/${d.id}/no-go`, { reason: "Split it: retries first" });
    expect(no.body.plan).toMatchObject({ state: "no-go", decision: { reason: "Split it: retries first" } });
    expect(await uses("flightPlan:no-go")).toBe(before + 1);
    expect((await person("POST", `/flight-plan/plans/${d.id}/go`, {})).status).toBe(409);
    // the author edits: back to ready, the reason stays for it to read
    const fixed = await call("PATCH", `/flight-plan/plans/${d.id}`, { plan_md: "# v2" });
    expect(fixed.body.plan).toMatchObject({ state: "ready", decision: { reason: "Split it: retries first" } });
    expect((await person("POST", `/flight-plan/plans/${d.id}/go`, {})).body.plan.state).toBe("launched");
  });

  test("a change after Go takes the Go back: it belonged to the plan the person saw", async () => {
    // Go launches at once, so the Go has to be one that cannot: a held project keeps the plan at Go.
    expect((await person("POST", "/flight-plan/hold", { root: ROOT })).status).toBe(200);
    try {
      const p = await makePlan();
      await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# v1" });
      const go = await person("POST", `/flight-plan/plans/${p.id}/go`, {});
      expect(go.body).toMatchObject({ ok: true, plan: { state: "go" }, launchError: expect.stringContaining("held") });
      const r = await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# v1 but sneakier" });
      expect(r.body.plan).toMatchObject({ state: "ready", decision: null });
      expect((await person("POST", `/flight-plan/plans/${p.id}/launch`, {})).status).toBe(409);
    } finally { expect((await person("POST", "/flight-plan/resume", { root: ROOT })).status).toBe(200); }
  });

  test("a plan over the size ceiling is refused", async () => {
    const p = await makePlan();
    expect((await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "x".repeat(200_001) })).status).toBe(413);
  });
});

describe("the person's alone: Go, No-go, Launch", () => {
  test("an agent is refused all three and the plan does not move", async () => {
    const p = await makePlan();
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# plan" });
    for (const verb of ["go", "no-go", "launch"]) {
      const r = await call("POST", `/flight-plan/plans/${p.id}/${verb}`, { reason: "because" });
      expect(r.status).toBe(403);
      expect(r.body.error).toContain("the person's");
    }
    expect((await call("GET", `/flight-plan/plans/${p.id}`)).body.plan.state).toBe("ready");
  });
});

/** Go on a plan without the launch Go now does: the project is held for the moment, so the plan stays at Go for the Launch route to take. */
const goOnly = async (id: string) => {
  expect((await person("POST", "/flight-plan/hold", { root: ROOT })).status).toBe(200);
  try { expect((await person("POST", `/flight-plan/plans/${id}/go`, {})).body.launchError).toContain("held"); }
  finally { expect((await person("POST", "/flight-plan/resume", { root: ROOT })).status).toBe(200); }
};

describe("Launch", () => {
  beforeAll(noReviews);
  test("only from Go, once: it hands back a ticket and the plan is launched", async () => {
    const p = await makePlan();
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# plan" });
    expect((await person("POST", `/flight-plan/plans/${p.id}/launch`, {})).status).toBe(409);
    await goOnly(p.id);
    const before = await uses("flightPlan:launch");
    const r = await person("POST", `/flight-plan/plans/${p.id}/launch`, {});
    expect(r.status).toBe(200);
    expect(r.body.window).toStartWith("@");
    expect(r.body.plan).toMatchObject({ state: "launched", launched: { title: p.title } });
    expect(await uses("flightPlan:launch")).toBe(before + 1);
    expect((await person("POST", `/flight-plan/plans/${p.id}/launch`, {})).status).toBe(409);
    expect((await call("PATCH", `/flight-plan/plans/${p.id}`, { title: "new" })).status).toBe(409);
  });

  test("the brief a worker starts with is the plan, and the author's is the request and the door verbs", () => {
    const p = { id: "fp_0123456789abcdef", root: "/home/a/orbit", title: "Cap webhooks", request: "Cap outbound webhooks per tenant", planMd: "## Steps\n1. add a ceiling", visual: true,
      mockups: [{ path: "/home/a/orbit/screen.png", kind: "image" }] } as Plan;
    const brief = launchPrompt(p);
    for (const s of ["# Cap webhooks", "Cap outbound webhooks per tenant", "1. add a ceiling", "/home/a/orbit/screen.png"]) expect(brief).toContain(s);
    const author = authorPrompt(p, "/home/a/guide.md");
    for (const s of [p.id, "Cap outbound webhooks per tenant", "flight-plan plan set fp_0123456789abcdef --file", "plan mockup", "/home/a/guide.md"]) expect(author).toContain(s);
    expect(authorPrompt({ ...p, visual: false }, "")).not.toContain("mockup");
  });

  test("the launch builds the brief from the plan, not from the request body", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const at = src.indexOf("async function launchFlightPlan(");
    expect(at).toBeGreaterThan(-1);
    // to the function's own closing brace, never a fixed window
    const route = src.slice(at, src.indexOf("\n}\n", at));
    expect(route).toContain("prompt: FlightPlan.launchPrompt(plan, coordinator)");
    expect(route).toContain("perm: launchPerm(builder.mode");
    // the deny list is part of the argv, so it holds whatever mode and list the person has set
    expect(route).toContain("FlightPlan.BUILDER_DENY");
    expect(route).toContain("model: builder.model");
    // A normal tab in a session, behind what the person is reading: select=false, and not a bench ticket.
    expect(route).toMatch(/engineWindowOutcome\(tree\.path, [^\n]*, false, false\)/);
    expect(route).not.toContain("mintAgentTicket");
    // The coordinator is told only when there is one (the seat answers to `seated`); without one the brief points at needs-you instead.
    expect(route).toMatch(/if \(coordinator\) void SeatWake\.promptSeat\(plan\.root, `A builder was launched for flight plan \$\{plan\.id\}/);
  });

  test("a builder can never push, open a pull request, release, merge, tag or change agentglass settings or rules", () => {
    for (const rule of ["Bash(git push:*)", "Bash(gh pr:*)", "Bash(gh release:*)", "Bash(git merge:*)", "Bash(git tag:*)", "Bash(agentglass-ui settings set:*)", "Bash(agentglass-ui rules set:*)"]) expect(BUILDER_DENY).toContain(rule);
  });

  test("Launch cuts its own worktree off main and says where; a person's Go is recorded as the person's", async () => {
    const p = await makePlan({ title: "Cap webhooks" });
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# plan" });
    const r = await person("POST", `/flight-plan/plans/${p.id}/go`, {});   // Go launches
    expect((await call("GET", `/flight-plan/plans/${p.id}`)).body.plan.decision.by).toBe("you");
    expect(r.status).toBe(200);
    expect(r.body.worktree).toMatch(/root-fp-[a-z0-9-]+$/);
    expect(r.body.worktree).not.toBe(ROOT);
    expect(existsSync(r.body.worktree)).toBe(true);
    expect(r.body.branch).toMatch(/^flight-plan\//);
    // The tab is a window in a tmux session on the test's own socket, named after the plan; no bench session was made.
    const ls = Bun.spawnSync(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "list-windows", "-a", "-F", "#{session_name} #{window_name}"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" } }).stdout.toString();
    expect(ls).toContain(` ${builderWindowName(r.body.branch)}`);
    expect(ls).not.toContain("bench");
  });

  test("a project that cannot give a worktree does not launch on the shared checkout", async () => {
    const plain = mkdtempSync(join(dir, "plain-"));
    const r = cutBuilderWorktree(plain, "Cap webhooks", "main");
    expect(r.ok).toBe(false);
    expect(cutBuilderWorktree(ROOT, "x", null)).toMatchObject({ ok: false });
  });

  test("a second tree for the same title gets a suffix, never the first one's path", () => {
    const a = cutBuilderWorktree(ROOT, "Same title", "main"), b = cutBuilderWorktree(ROOT, "Same title", "main");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) { expect(b.path).not.toBe(a.path); expect(b.branch).toBe(`${a.branch}-2`); }
  });

  test("the builder starts in the chosen permission mode (Auto by default, never an unknown word) and on Sonnet unless the builder role names an alias", () => {
    expect(builderLaunch({ provider: "claude", model: "" }, "auto")).toEqual({ mode: "auto", model: "sonnet" });
    expect(builderLaunch({ provider: "claude", model: "opus" }, "bypassPermissions")).toEqual({ mode: "bypassPermissions", model: "opus" });
    expect(builderLaunch({ provider: "codex", model: "gpt-x" }, "default")).toEqual({ mode: "default", model: "sonnet" });
    expect(builderLaunch({ provider: "claude", model: "claude-opus-5-5" }, "nonsense")).toEqual({ mode: "auto", model: "sonnet" });
  });

  test("the setting: Auto shipped, an agent never raises it to Bypass, it may lower it", async () => {
    const q = "/settings/door?id=flightPlan.builder.permissions";
    expect((await call("GET", q)).body.value).toBe("auto");
    expect((await call("POST", "/settings/door", { id: "flightPlan.builder.permissions", value: "bypassPermissions" })).status).not.toBe(200);
    expect((await call("GET", q)).body.value).toBe("auto");
    expect((await person("POST", "/settings/door", { id: "flightPlan.builder.permissions", value: "bypassPermissions" })).status).toBe(200);
    expect((await call("GET", q)).body.value).toBe("bypassPermissions");
    expect((await call("POST", "/settings/door", { id: "flightPlan.builder.permissions", value: "default" })).status).toBe(200);
    expect((await person("POST", "/settings/door", { id: "flightPlan.builder.permissions", value: "auto" })).status).toBe(200);
  });

  test("the brief ends with who the builder answers to: the coordinator, or the person through needs-you", () => {
    const p = { id: "fp_0123456789abcdef", root: "/home/a/orbit", title: "Cap webhooks", request: "r", planMd: "# p", visual: false, mockups: [] } as unknown as Plan;
    const withCoord = launchPrompt(p, "orchestrator-orbit");
    expect(withCoord.endsWith(reportingBlock("orchestrator-orbit"))).toBe(true);
    expect(withCoord).toContain("report to orchestrator-orbit via SendMessage");
    expect(withCoord).toContain("you never push, open a pull request, merge, tag, release");
    expect(withCoord).toContain("without orchestrator-orbit's order");
    expect(withCoord).toContain("denied, not asked");
    const alone = launchPrompt(p, null);
    expect(alone).toContain("no coordinator");
    expect(alone).toContain("agentglass-agent need");
    expect(alone).not.toContain("SendMessage");
  });
});

describe("listing and the door", () => {
  test("list filters by state and root, and leaves the plan text out", async () => {
    const r = await call("GET", `/flight-plan/plans?state=launched&root=${encodeURIComponent(ROOT)}`);
    expect(r.body.plans.length).toBeGreaterThan(0);
    for (const p of r.body.plans) { expect(p.state).toBe("launched"); expect(p.planMd).toBeUndefined(); expect(p.planBytes).toBeGreaterThan(0); }
    expect((await call("GET", "/flight-plan/plans/fp_ffffffffffffffff")).status).toBe(404);
  });

  test("the CLI: new, set --file, mockup, show and preflight", async () => {
    const file = join(dir, "p.md"); writeFileSync(file, "# From a file");
    const run = async (...args: string[]) => {
      const pr = Bun.spawn(["python3", new URL("../../bin/agentglass-ui", import.meta.url).pathname, "--as", "cli-tester", "flight-plan", "plan", ...args], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, AGENTGLASS_SERVER: base, AGENTGLASS_TOKEN: TOKEN }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(pr.stdout).text(), new Response(pr.stderr).text()]);
      await pr.exited;
      try { return JSON.parse(out) as Record<string, any>; } catch { throw new Error(`no JSON from the CLI: ${(out || err).slice(0, 300)}`); }
    };
    const made = await run("new", "Show the plan", "--root", ROOT);
    expect(made.ok).toBe(true);
    const id = made.plan.id;
    expect((await run("set", id, "--file", file)).plan.state).toBe("ready");
    expect((await run("mockup", id, shot)).plan.mockups).toHaveLength(1);
    expect((await run("set", id, "--size", "L")).plan.size).toBe("L");
    expect((await run("show", id)).plan.planMd).toBe("# From a file");
    expect((await run("set", id)).ok).toBe(false);
  });
});

describe("B3: the server does what the view used to be trusted to do", () => {
  // The door knows the open project only, so each test sets what it needs on ROOT: "auto" is a project that reviews plans, "off" one that reviews nothing.
  const mode = (value: "auto" | "off") => person("POST", "/settings/door", { id: "flightPlan.preflight.reviews", value: value === "auto" ? ["plan"] : [], root: ROOT });
  const settle = async (id: string) => { for (let i = 0; i < 100; i++) { const r = (await call("GET", `/flight-plan/plans/${id}`)).body; if (r.run && r.run.state !== "running") return r; await Bun.sleep(50); } throw new Error("run did not settle"); };

  test("new plan text in a project that reviews plans starts the review, in one that does not does nothing; no view is open", async () => {
    for (const [m, state] of [["auto", "running"], ["off", null]] as const) {
      await mode(m);
      const p = await makePlan();
      expect((await call("GET", `/flight-plan/plans/${p.id}`)).body.run).toBeNull();
      const saved = await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# Plan\nOne." });
      expect(saved.status).toBe(200);
      const got = (await call("GET", `/flight-plan/plans/${p.id}`)).body;
      if (state === null) expect(got.run).toBeNull();
      else expect(got.run.state === state || (state === "running" && got.run.state === "done")).toBe(true);
      // a title change is not new plan text
      const before = got.plan.preflightRunId;
      await call("PATCH", `/flight-plan/plans/${p.id}`, { title: "Renamed" });
      expect((await call("GET", `/flight-plan/plans/${p.id}`)).body.plan.preflightRunId).toBe(before);
    }
  });

  test("an S plan is never reviewed, and a Preflight pressed on it is refused; an M plan is, by default", async () => {
    await mode("auto");
    const s = await makePlan({ size: "S" });
    await call("PATCH", `/flight-plan/plans/${s.id}`, { plan_md: "# Plan\nOne." });
    expect((await call("GET", `/flight-plan/plans/${s.id}`)).body.run).toBeNull();
    const press = await person("POST", `/flight-plan/plans/${s.id}/preflight`, {});
    expect(press.status).toBeGreaterThanOrEqual(400);
    expect(press.body.error).toContain("S plan");
    const m = await makePlan({ size: "M" });
    await call("PATCH", `/flight-plan/plans/${m.id}`, { plan_md: "# Plan\nOne." });
    expect((await call("GET", `/flight-plan/plans/${m.id}`)).body.run).not.toBeNull();
  });

  test("a plan reports its pilot, whether its project is held, why it stops and the budget; Co-pilot is the default", async () => {
    const p = await makePlan();
    expect((await call("GET", `/flight-plan/plans/${p.id}`)).body).toMatchObject({ ok: true, pilot: "copilot", held: false, stopReason: null, budget: expect.any(Object) });
  });

  test("every earlier plan text is kept; the plan reports its version and the revision route returns the old text", async () => {
    const p = await makePlan();
    expect((await call("GET", `/flight-plan/plans/${p.id}`)).body.version).toBe(1);
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "first" });
    expect((await call("GET", `/flight-plan/plans/${p.id}`)).body.version).toBe(1);
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "second", title: "t" });
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "second" });
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "third" });
    expect((await call("GET", `/flight-plan/plans/${p.id}`)).body.version).toBe(3);
    expect((await call("GET", `/flight-plan/plans/${p.id}/revisions/1`)).body.revision.planMd).toBe("first");
    expect((await call("GET", `/flight-plan/plans/${p.id}/revisions/2`)).body.revision.planMd).toBe("second");
    expect((await call("GET", `/flight-plan/plans/${p.id}/revisions/3`)).status).toBe(404);
  });

  test("a one-off cap: the person's, above 0 up to 5, and the certificate records the cap used", async () => {
    await mode("off");
    const p = await makePlan();
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# Plan" });
    await mode("auto");
    expect((await call("POST", `/flight-plan/plans/${p.id}/preflight`, { capUsd: 1 })).status).toBe(403);
    for (const bad of [0, -1, 5.01, "1"]) expect((await person("POST", `/flight-plan/plans/${p.id}/preflight`, { capUsd: bad })).status).toBe(400);
    expect((await person("POST", `/flight-plan/plans/${p.id}/preflight`, { capUsd: 1 })).body.run.state).toBe("running");
    expect((await settle(p.id)).run.certificate.capUsd).toBe(1);
    await person("POST", `/flight-plan/plans/${p.id}/preflight`, {});
    expect((await settle(p.id)).run.certificate.capUsd).toBe(0.5);
  });

  test("the door tells an explicit value from an inherited one", async () => {
    const q = `/settings/door?id=flightPlan.pilot&root=${encodeURIComponent(ROOT)}`;
    expect((await call("GET", q)).body).toMatchObject({ value: "copilot", scopedSet: false });
    // saying Co-pilot again is no change to the door, so the person moves it and puts it back
    for (const value of ["manual", "copilot"]) await person("POST", "/settings/door", { id: "flightPlan.pilot", value, root: ROOT });
    expect((await call("GET", q)).body).toMatchObject({ value: "copilot", scopedSet: true });
    expect((await call("GET", "/settings/door?id=flightPlan.enabled")).body.scopedSet).toBeUndefined();
  });

  test("a mockup is served only if the plan lists it, with a sandbox for HTML, and is checked again at serving", async () => {
    const png = join(dir, "m.png"), html = join(dir, "m.html"), env = join(dir, ".env.png");
    writeFileSync(png, Buffer.from([137, 80, 78, 71])); writeFileSync(html, "<script>1</script>"); writeFileSync(env, "x");
    const p = await makePlan({ visual: true });
    await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# P", mockups: [png, html] });
    const img = await fetch(`${base}/flight-plan/plans/${p.id}/mockups/1`, { headers: auth });
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toBeNull();
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    const page = await fetch(`${base}/flight-plan/plans/${p.id}/mockups/2`, { headers: auth });
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:");
    expect((await call("GET", `/flight-plan/plans/${p.id}/mockups/3`)).status).toBe(404);
    rmSync(png);
    expect((await call("GET", `/flight-plan/plans/${p.id}/mockups/1`)).status).toBe(403);
  });
});

describe("Go launches", () => {
  beforeAll(noReviews);
  test("the person's Go launches the builder in Manual and in Co-pilot, as the coordinator's does in Autopilot", async () => {
    for (const pilot of ["manual", "copilot"]) {
      expect((await person("POST", "/settings/door", { id: "flightPlan.pilot", value: pilot, root: ROOT })).status).toBe(200);
      const p = await makePlan();
      await call("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: `# ${pilot}` });
      const go = await person("POST", `/flight-plan/plans/${p.id}/go`, {});
      expect(go.body).toMatchObject({ ok: true, queued: false, plan: { state: "launched", decision: { by: "you" } }, branch: expect.stringContaining("flight-plan/") });
    }
  });
});
