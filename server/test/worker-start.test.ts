/*
 * Who may start a worker, with what, and what the envelope still refuses.
 * Pure parts only: the decision (workerstart.ts), the envelope per engine
 * (envelope.ts), the argv of a headless turn and the wrapper around it
 * (headless.ts). The route and the window are worker-start-route.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentProvider } from "../../shared/agentKinds.ts";
import {
  composePolicy, defaultStored, type Envelope, type EngineChoice, type Policy, type PolicyRule,
} from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { DENIED_COMMANDS, WORKER_ROLES, roleLaunch, workerRole } from "../../shared/workerRoles.ts";
import { LIFTS, WORKER_DENIED, compileEnvelope, deniedFor } from "../src/agents/envelope.ts";
import { headlessRefusal, headlessTurn, prepareRun, runFiles, sessionIdOf, turnResult, wrapped } from "../src/agents/headless.ts";
import { planWorker } from "../src/agents/workerstart.ts";

const tmp: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agx-wstart-")); tmp.push(d); return d; };
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const NARROW: Envelope = { write: "worktree", network: false, commit: false, deny: [] };
const WIDE: Envelope = { write: "worktree", network: true, commit: true, deny: [] };
const builder = workerRole("builder")!;
const scout = workerRole("scout")!;

// ── the envelope ─────────────────────────────────────────────────────────

describe("the envelope: what can be lifted from the floor", () => {
  test("the narrow default denies every command of the floor and the app's own doors", () => {
    const d = deniedFor(NARROW);
    for (const c of DENIED_COMMANDS) expect(d).toContain(c);
    for (const c of WORKER_DENIED) expect(d).toContain(c);
  });

  test("the two lifts, entry by entry: nothing else leaves the floor, in any combination", () => {
    expect(LIFTS.commit).toEqual(["git commit"]);
    expect(LIFTS.network).toEqual(["curl", "wget"]);
    for (const commit of [false, true]) for (const network of [false, true]) {
      const d = deniedFor({ write: "worktree", commit, network, deny: [] });
      const lifted = DENIED_COMMANDS.filter((c) => !d.includes(c));
      expect(lifted.sort()).toEqual([...(commit ? LIFTS.commit : []), ...(network ? LIFTS.network : [])].sort());
      for (const never of ["git push", "gh", "ssh", "scp", "sudo", "rm", "git merge", "git rebase", "git reset", "git tag", "docker", "aws"]) {
        expect(d).toContain(never);
      }
    }
  });

  test("deny can only add", () => {
    expect(deniedFor({ ...WIDE, deny: ["make deploy"] })).toContain("make deploy");
    expect(deniedFor({ ...NARROW, deny: ["curl"] }).filter((c) => c === "curl")).toHaveLength(1);
  });

  test("with the default envelope the lock is the one the role has always had, plus only the app's own doors and the network tools", () => {
    // The role path (roleLaunch with no list) is unchanged byte for byte.
    const claude = agentProvider("claude")!;
    expect(roleLaunch(claude, builder, "sonnet")).toEqual(roleLaunch(claude, builder, "sonnet", DENIED_COMMANDS));
    const old = JSON.parse(roleLaunch(claude, builder, "sonnet")!.args[1]!).permissions.deny as string[];
    const now = JSON.parse(compileEnvelope("claude", builder, NARROW, "sonnet", scratch()).ok ? (compileEnvelope("claude", builder, NARROW, "sonnet", scratch()) as { args: string[] }).args[1]! : "{}").permissions.deny as string[];
    expect(now.filter((d) => !old.includes(d)).sort()).toEqual([...WORKER_DENIED.map((c) => `Bash(${c}:*)`), "WebFetch", "WebSearch"].sort());
    expect(old.every((d) => now.includes(d))).toBe(true);
  });
});

describe("the envelope compiled for each engine", () => {
  const dir = scratch();
  const claudeDeny = (e: Envelope) => {
    const c = compileEnvelope("claude", builder, e, "sonnet", dir);
    if (!c.ok) throw new Error(c.error);
    return (JSON.parse(c.args[c.args.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;
  };
  const opencode = (e: Envelope) => {
    const c = compileEnvelope("opencode", builder, e, "opencode/big-pickle", dir);
    if (!c.ok) throw new Error(c.error);
    return JSON.parse(c.env.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: Record<string, string>; webfetch?: string } };
  };

  test("Claude: git push and gh are denied under every flag; commit lifts only git commit", () => {
    for (const e of [NARROW, WIDE, { ...NARROW, commit: true }, { ...NARROW, network: true }]) {
      const d = claudeDeny(e);
      for (const c of ["git push", "gh", "ssh", "sudo", "rm"]) expect(d).toContain(`Bash(${c}:*)`);
      expect(d.includes("Bash(git commit:*)")).toBe(!e.commit);
      expect(d.includes("Bash(curl:*)")).toBe(!e.network);
    }
  });

  test("OpenCode: bash denies the floor, and webfetch is denied unless the envelope lets the worker out", () => {
    const narrow = opencode(NARROW);
    for (const c of ["git push", "gh", "ssh"]) expect(narrow.permission.bash[c]).toBe("deny");
    expect(narrow.permission.bash["git commit"]).toBe("deny");
    expect(narrow.permission.webfetch).toBe("deny");
    const wide = opencode(WIDE);
    expect(wide.permission.bash["git commit"]).toBeUndefined();
    expect(wide.permission.bash["git push"]).toBe("deny");
    expect(wide.permission.bash["curl"]).toBeUndefined();
    expect(wide.permission.webfetch).toBeUndefined();
  });

  test("OpenCode: the environment layers are pinned and no flag asks for --auto", () => {
    const c = compileEnvelope("opencode", builder, NARROW, "opencode/big-pickle", dir);
    expect(c.ok && Object.keys(c.env)).toEqual(expect.arrayContaining(["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_PERMISSION"]));
    expect(c.ok && c.args.join(" ")).not.toContain("--auto");
  });

  test("Claude: the network tools are denied unless the envelope lets the worker out", () => {
    expect(claudeDeny(NARROW)).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(claudeDeny({ ...NARROW, network: true })).not.toContain("WebFetch");
    expect(claudeDeny({ ...NARROW, network: true })).not.toContain("WebSearch");
  });

  test("OpenCode: the deny list also catches the command wrapped, pathed or run through a shell", () => {
    const bash = opencode(NARROW).permission.bash;
    for (const g of ["*git*push*", "*agentglass-agent*", "*agentglass-ui*", "* gh *", "*/gh *", "* sudo *"]) expect(bash[g]).toBe("deny");
    // The lifts stay lifted in the wide forms too.
    const wide = opencode(WIDE).permission.bash;
    expect(wide["*git*commit*"]).toBeUndefined();
    expect(wide["* curl *"]).toBeUndefined();
    expect(wide["*git*push*"]).toBe("deny");
  });

  test("Qwen: the lock is a 0600 file the engine is pointed at, denying the floor", () => {
    const d = scratch();
    const c = compileEnvelope("qwen", builder, NARROW, "qwen3", d);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const path = Object.values(c.env)[0]!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("Bash(git push)");
  });

  test("Codex and Hermes write nothing and say so: the sandbox and the person's deny list are the limit", () => {
    for (const id of ["codex", "hermes"]) {
      const c = compileEnvelope(id, builder, NARROW, "m", dir);
      expect(c.ok && c.partly).toBeTruthy();
      expect(c.ok && c.args).toEqual([]);
    }
  });

  test("a read-only role, and an envelope that writes nothing, deny edits", () => {
    const d = (r: typeof builder, w: "none" | "worktree") => {
      const c = compileEnvelope("claude", r, { ...NARROW, write: w }, "haiku", dir);
      return c.ok ? (JSON.parse(c.args[c.args.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny : [];
    };
    expect(d(scout, "worktree")).toContain("Edit");
    expect(d(builder, "none")).toContain("Write");
    expect(d(builder, "worktree")).not.toContain("Edit");
  });

  test("an engine that has no lock is refused, never started unlocked", () => {
    const c = compileEnvelope("gemini", builder, NARROW, "m", dir);
    expect(c.ok).toBe(false);
  });
});

// ── the decision ─────────────────────────────────────────────────────────

const ready = (id: string, ok = true, why?: string): EngineReadiness => ({
  id, title: agentProvider(id)?.title ?? id, found: true, path: `/x/${id}`, version: "1", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: ok ? { ok } : { ok, why }, orchestrator: { ok: false } }, missing: [], envelope: { via: null, enforced: "yes", note: "" },
});
const FLEET = [ready("claude"), ready("opencode"), ready("hermes", false, "Hermes 0.21.0 is older than 0.21.4. Run: hermes update"), ready("codex"), ready("gemini")];

const base = (builderChoice: EngineChoice): Policy =>
  composePolicy(defaultStored(), {
    orchestrator: { engine: "claude", model: "opus" },
    workers: { scout: { engine: "claude", model: "haiku" }, builder: builderChoice, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
  });
const withRule = (p: Policy, rule: Partial<PolicyRule>): Policy => ({
  ...p, rules: [{ id: "r1", name: "Plan nearly used", when: [{ kind: "always" }], enabled: true, ...rule } as PolicyRule],
});
const none = { on: () => false };
const on = { on: (id: string) => id === "r1" };
const view = (policy: Policy) => ({ policy, scope: "global" as const });
const CLAUDE = { engine: "claude", model: "sonnet" };

describe("planWorker: every refusal is a sentence that names the thing refused", () => {
  const p = base(CLAUDE);

  test("no policy rule on: the base applies, narrow envelope, stamped with why", () => {
    const r = planWorker({ role: "builder" }, view(p), none, FLEET, null);
    expect(r.ok && r.choice).toEqual(CLAUDE);
    expect(r.ok && r.envelope).toEqual(NARROW);
    expect(r.ok && r.startedBy).toMatchObject({ rule: "base", role: "builder", engine: "claude", model: "sonnet", headless: true });
  });

  test("a rule that is on sends the role to its chain", () => {
    const r = planWorker({ role: "builder" }, view(withRule(p, { workers: { builder: [{ engine: "opencode", model: "opencode/big-pickle" }] } })), on, FLEET, null);
    expect(r.ok && r.choice).toEqual({ engine: "opencode", model: "opencode/big-pickle" });
    expect(r.ok && r.startedBy.rule).toBe("Plan nearly used");
  });

  test("an OpenCode entry with no model runs the engine's own default, and the stamp says so", () => {
    const q = withRule(p, { workers: { builder: [{ engine: "opencode", model: "" }] } });
    const r = planWorker({ role: "builder" }, view(q), on, FLEET, null);
    expect(r.ok && r.choice).toEqual({ engine: "opencode", model: agentProvider("opencode")!.seatModel! });
    expect(r.ok && r.startedBy.model).toBe("opencode/big-pickle");
    expect(r.ok && r.startedBy.because.join(" ")).toContain("so it ran its default, opencode/big-pickle");
    // A picked engine takes the same road.
    const asked = planWorker({ role: "builder", engine: "opencode" }, view(q), on, FLEET, null);
    expect(asked.ok && asked.choice.model).toBe("opencode/big-pickle");
  });

  test("an explicit model is kept, and an engine that picks its own is untouched", () => {
    const named = planWorker({ role: "builder" }, view(withRule(p, { workers: { builder: [{ engine: "opencode", model: "acme/orbit-1" }] } })), on, FLEET, null);
    expect(named.ok && named.choice.model).toBe("acme/orbit-1");
    expect(named.ok && named.startedBy.because.join(" ")).not.toContain("default");
    const claude = planWorker({ role: "builder" }, view(base({ engine: "claude", model: "" })), none, FLEET, null);
    expect(claude.ok && claude.choice.model).toBe("");
  });

  test("a bad explicit value is still refused by the turn, naming the value", () => {
    const q = withRule(p, { workers: { builder: [{ engine: "opencode", model: "orbit-1" }] } });
    const r = planWorker({ role: "builder" }, view(q), on, FLEET, null);
    expect(r.ok && r.choice.model).toBe("orbit-1");
    const t = headlessTurn({ engine: "opencode", bin: "/bin/true", model: "orbit-1", role: builder, envelope: NARROW, limits: { turnMinutes: 5 } as never, prompt: "x" });
    expect(!t.ok && t.error).toContain(`"orbit-1" is not one`);
  });

  test("no such role", () => {
    const r = planWorker({ role: "janitor" }, view(p), none, FLEET, null);
    expect(!r.ok && r.error).toBe("no such role");
  });

  test("an engine outside the chain is refused, naming the chain", () => {
    const r = planWorker({ role: "builder", engine: "codex" }, view(p), none, FLEET, null);
    expect(!r.ok && r.error).toContain("codex is not in the chain for the builder role");
    expect(!r.ok && r.error).toContain("Claude Code (sonnet)");
  });

  test("a model that is not that chain entry's is refused too", () => {
    const r = planWorker({ role: "builder", engine: "claude", model: "opus" }, view(p), none, FLEET, null);
    expect(!r.ok && r.error).toContain("claude (opus) is not in the chain");
    expect(planWorker({ role: "builder", model: "opus" }, view(p), none, FLEET, null)).toMatchObject({ ok: false, error: expect.stringContaining("--engine") });
  });

  test("an engine in the chain that this machine cannot run is refused with its reason (Hermes too old)", () => {
    const q = withRule(p, { workers: { builder: [{ engine: "hermes", model: "" }] } });
    const r = planWorker({ role: "builder", engine: "hermes" }, view(q), on, FLEET, null);
    expect(!r.ok && r.error).toContain("older than 0.21.4");
  });

  test("the chain ran out: refused, and flagged as a need for the person", () => {
    const q = withRule(p, { workers: { builder: [{ engine: "hermes", model: "" }] } });
    const r = planWorker({ role: "builder" }, view(q), on, FLEET, null);
    expect(r).toMatchObject({ ok: false, need: true });
    expect(!r.ok && r.error).toContain("older than 0.21.4");
  });

  test("never an engine outside the chain: a chain of one that is not ready does not fall to the base", () => {
    const q = withRule(p, { workers: { builder: [{ engine: "gemini", model: "" }] } });
    const r = planWorker({ role: "builder" }, view(q), on, [ready("claude"), ready("gemini", false, "Gemini cannot run headless yet")], null);
    expect(r.ok).toBe(false);
  });

  test("ask: set and no --engine is refused with the ready choices; naming one satisfies it", () => {
    const asked = { ...p, base: { ...p.base, workers: { ...p.base.workers, builder: { ...p.base.workers.builder, ask: true } } } };
    const a = planWorker({ role: "builder" }, view(asked), none, FLEET, null);
    expect(!a.ok && a.error).toContain("pick one with --engine");
    expect(!a.ok && a.error).toContain("Claude Code (sonnet)");
    expect(planWorker({ role: "builder", engine: "claude" }, view(asked), none, FLEET, null).ok).toBe(true);
  });

  test("--allow: only network and commit exist, and each stops at the ceiling", () => {
    const bad = planWorker({ role: "builder", allow: ["push"] }, view(p), none, FLEET, null);
    expect(!bad.ok && bad.error).toContain("never granted to a worker");
    // The default ceiling lets a worker commit and not use the network.
    const commit = planWorker({ role: "builder", allow: ["commit"] }, view(p), none, FLEET, null);
    expect(commit.ok && commit.envelope).toEqual({ ...NARROW, commit: true });
    const net = planWorker({ role: "builder", allow: ["network"] }, view(p), none, FLEET, null);
    expect(!net.ok && net.error).toContain("beyond this project's ceiling");
    expect(!net.ok && net.error).toContain("Nothing was started");
    const open = { ...p, ceiling: { ...WIDE } };
    expect(planWorker({ role: "builder", allow: ["network", "commit"] }, view(open), none, FLEET, null)).toMatchObject({ ok: true, envelope: { network: true, commit: true } });
    expect(planWorker({ role: "builder", allow: "network" }, view(open), none, FLEET, null).ok).toBe(false);
  });

  test("a model that is not a string is refused, not ignored", () => {
    const r = planWorker({ role: "builder", engine: "claude", model: 5 }, view(p), none, FLEET, null);
    expect(!r.ok && r.error).toContain("model:");
  });

  test("too many workers for the seat", () => {
    const r = planWorker({ role: "builder" }, view(p), none, FLEET, p.limits.maxWorkers);
    expect(!r.ok && r.error).toContain(`limit is ${p.limits.maxWorkers}`);
    expect(planWorker({ role: "builder" }, view(p), none, FLEET, p.limits.maxWorkers - 1).ok).toBe(true);
    // A person asking is not a seat with a count.
    expect(planWorker({ role: "builder" }, view(p), none, FLEET, null).ok).toBe(true);
  });

  test("an engine whose envelope has not been measured is not offered as a worker", () => {
    const q = withRule(p, { workers: { builder: [{ engine: "antigravity", model: "m" }] } });
    const r = planWorker({ role: "builder", engine: "antigravity" }, view(q), on, [...FLEET, ready("antigravity")], null);
    expect(r.ok).toBe(false);
  });
});

// ── a headless turn ──────────────────────────────────────────────────────

const turn = (engine: string, o: Partial<Parameters<typeof headlessTurn>[0]> = {}) =>
  headlessTurn({ engine, bin: `/x/${engine}`, model: "m", role: builder, envelope: NARROW, limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "-m evil", ...o });

describe("the argv of one headless turn", () => {
  test("Claude: prompt on stdin, nothing waits on a terminal, a session chosen up front", () => {
    const t = turn("claude", { model: "sonnet" });
    if (!t.ok) throw new Error(t.error);
    expect(t.stdin).toBe("prompt");
    expect(t.argv.slice(0, 5)).toEqual(["/x/claude", "-p", "--output-format", "stream-json", "--verbose"]);
    expect(t.argv).toContain("--settings");
    expect(t.argv.join(" ")).toContain("--permission-prompts none");
    expect(t.argv).toContain("--permission-mode");
    expect(t.argv[t.argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(t.argv).toContain("--session-id");
    expect(t.argv).not.toContain("-m evil");
    expect(t.argv.join(" ")).not.toMatch(/dangerously|bypass/);
    expect((turn("claude", { role: scout }) as { argv: string[] }).argv).toContain("plan");
    const again = turn("claude", { resume: "abc-123" }) as { argv: string[] };
    expect(again.argv.slice(-2)).toEqual(["--resume", "abc-123"]);
  });

  test("OpenCode: provider/model in --model, the prompt one element after --, never --auto", () => {
    const t = turn("opencode", { model: "opencode/big-pickle" });
    if (!t.ok) throw new Error(t.error);
    expect(t.argv.slice(0, 4)).toEqual(["/x/opencode", "run", "--format", "json"]);
    expect(t.argv.slice(t.argv.indexOf("--model"), t.argv.indexOf("--model") + 2)).toEqual(["--model", "opencode/big-pickle"]);
    expect(t.argv.slice(-2)).toEqual(["--", "-m evil"]);
    expect(t.argv).not.toContain("--auto");
    expect(t.env.OPENCODE_CONFIG_CONTENT).toContain("webfetch");
    expect(turn("opencode", { model: "big-pickle" })).toMatchObject({ ok: false, error: expect.stringContaining("provider/model") });
    expect((turn("opencode", { model: "opencode/big-pickle", resume: "ses_1" }) as { argv: string[] }).argv).toContain("ses_1");
  });

  test("Codex: the sandbox decides, read-only for a scout, the prompt on stdin", () => {
    const b = turn("codex") as { argv: string[]; stdin: string };
    expect(b.argv.join(" ")).toContain("sandbox_mode=workspace-write");
    expect(b.argv.join(" ")).toContain("approval_policy=never");
    expect(b.argv.at(-1)).toBe("-");
    expect(b.stdin).toBe("prompt");
    expect((turn("codex", { role: scout }) as { argv: string[] }).argv.join(" ")).toContain("sandbox_mode=read-only");
    expect((turn("codex", { model: "" }) as { ok: boolean }).ok).toBe(false);
  });

  test("Hermes: --query as one element, no --yolo, a run budget from the policy", () => {
    const t = turn("hermes") as { argv: string[] };
    expect(t.argv).toContain("--query=-m evil");
    expect(t.argv).not.toContain("--yolo");
    expect(t.argv.slice(-2)).toEqual(["--run-budget", "1800"]);
  });

  test("an engine with no measured envelope or no headless form is refused with a sentence", () => {
    expect(headlessRefusal("gemini")).toContain("no headless form");
    expect(headlessRefusal("antigravity")).toContain("has not been measured");
    expect(headlessRefusal("emacs")).toContain("not an engine");
    expect(turn("gemini")).toMatchObject({ ok: false });
    expect(headlessRefusal("claude")).toBeNull();
  });
});

describe("the wrapper around a turn", () => {
  test("it keeps the exit code, tees what was printed, shows stderr last and drops this app's credentials", async () => {
    const f = prepareRun("w-wrap", "the prompt", "prompt");
    tmp.push(f.dir);
    const script = join(f.dir, "engine.sh");
    writeFileSync(script, '#!/bin/sh\nread p; printf "got:%s\\n" "$p"; printf "env:%s|%s\\n" "${AGENTGLASS_TOKEN-gone}" "${AGENTGLASS_SEAT-gone}"; echo "boom: out of plan" >&2; exit 3\n', { mode: 0o755 });
    const p = Bun.spawn(wrapped(f, ["/bin/sh", script]), { env: { PATH: process.env.PATH ?? "", AGENTGLASS_TOKEN: "machine-secret", AGENTGLASS_SEAT: "/p" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(3);
    expect(out).toContain("got:the prompt");
    expect(out).toContain("env:gone|gone");
    expect(err.trim()).toBe("boom: out of plan");
    expect(readFileSync(f.out, "utf8")).toBe(out);
    expect(turnResult(f, "claude")).toMatchObject({ exitCode: 3, line: "boom: out of plan" });
    expect(statSync(f.dir).mode & 0o777).toBe(0o700);
  });

  test("Hermes's inherited bypass and gateway markers are dropped, and its tools start in the worktree", async () => {
    const f = prepareRun("w-hermes", "x", "none");
    tmp.push(f.dir);
    const script = join(f.dir, "engine.sh");
    writeFileSync(script, '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "${HERMES_YOLO_MODE-gone}" "${_HERMES_GATEWAY-gone}" "${HERMES_CRON_SESSION-gone}" "$TERMINAL_CWD"\n', { mode: 0o755 });
    const cwd = scratch();
    const p = Bun.spawn(wrapped(f, ["/bin/sh", script]), { cwd, env: { PATH: process.env.PATH ?? "", HERMES_YOLO_MODE: "1", _HERMES_GATEWAY: "1", HERMES_CRON_SESSION: "1", TERMINAL_CWD: "/elsewhere" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out.trim()).toBe(`gone|gone|gone|${cwd}`);
  });

  test("while the turn runs there is no result; a token-shaped stderr line is cut down", () => {
    const f = prepareRun("w-wait", "x", "none");
    tmp.push(f.dir);
    expect(turnResult(f, "claude")).toBeNull();
    writeFileSync(f.rc, "1\n");
    writeFileSync(f.err, "auth failed for sk-ant-api03-AbCdEf0123456789AbCdEf0123456789xyz\n");
    expect(turnResult(f, "claude")?.line).toBe("auth failed for [redacted]");
  });

  test("a new turn clears the last one's files", () => {
    const f = prepareRun("w-clear", "x", "none");
    tmp.push(f.dir);
    writeFileSync(f.rc, "0\n");
    prepareRun("w-clear", "y", "none");
    expect(existsSync(f.rc)).toBe(false);
    expect(runFiles("w-clear").dir).toBe(f.dir);
  });

  test("the engine's session is read off what it printed", () => {
    expect(sessionIdOf("opencode", '{"type":"step_start","sessionID":"ses_fake0001","part":{}}\n', "")).toBe("ses_fake0001");
    expect(sessionIdOf("codex", '{"type":"thread.started","thread_id":"t-1"}\n', "")).toBe("t-1");
    expect(sessionIdOf("hermes", "", "warming up\nsession_id: 20260917_104709_fdc54d\n")).toBe("20260917_104709_fdc54d");
    expect(sessionIdOf("opencode", "not a frame\n", "")).toBeNull();
  });
});

test("every role is covered above", () => {
  expect(WORKER_ROLES.map((r) => r.id)).toEqual(["scout", "builder", "reviewer", "verifier"]);
});
