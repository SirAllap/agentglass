/*
 * Who may start a worker, with what, and what the envelope still refuses.
 * Pure parts only: the decision (workerstart.ts), the envelope per engine
 * (envelope.ts), the argv of a headless turn and the wrapper around it
 * (headless.ts). The route and the window are worker-start-route.test.ts.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { agentProvider } from "../../shared/agentKinds.ts";
import {
  composePolicy, defaultStored, type Envelope, type EngineChoice, type Policy, type PolicyRule,
} from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { DENIED_COMMANDS, NEVER_LIFTABLE, WORKER_ROLES, roleLaunch, workerRole, type WorkerRole } from "../../shared/workerRoles.ts";
import { LIFTS, WORKER_DENIED, compileEnvelope, deniedFor } from "../src/agents/envelope.ts";
import { checkoutSettings, headlessRefusal, headlessTurn, prepareRun, runFiles, sessionIdOf, turnResult, wrapped } from "../src/agents/headless.ts";
import { planWorker } from "../src/agents/workerstart.ts";

const tmp: string[] = [];
const scratchRoot = join(import.meta.dir, "..", "..", ".agx-tmp", "worker-start");
const scratch = () => {
  mkdirSync(scratchRoot, { recursive: true });
  const d = mkdtempSync(join(scratchRoot, "agx-wstart-"));
  tmp.push(d);
  return d;
};
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

/** OpenCode reads each bash rule key as a glob over the whole command line. A
 *  line runs when none of the deny keys matches it. */
function refusedBy(bash: Record<string, string>, line: string): string | undefined {
  const lit = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Object.keys(bash).find((g) => new RegExp(`^${g.split("*").map(lit).join(".*")}$`).test(line));
}

/** Claude Code and Qwen read a `Bash(...)` rule as a prefix of the line. */
function prefixRefused(deny: readonly string[], line: string): string | undefined {
  return deny.find((r) => {
    const m = /^Bash\((.*?)(:\*|\*)?\)$/.exec(r);
    if (!m) return undefined;
    const pre = m[1]!.replace(/\s*\*$/, "");
    return line === pre || line.startsWith(pre + " ") || line.startsWith(pre + ":") || line.startsWith(pre) ? r : undefined;
  });
}

const NARROW: Envelope = { write: "worktree", network: false, commit: false, docker: false, worktreeOps: false, deny: [] };
const WIDE: Envelope = { write: "worktree", network: true, commit: true, docker: true, worktreeOps: true, deny: [] };
const builder = workerRole("builder")!;
const scout = workerRole("scout")!;

// ── the envelope ─────────────────────────────────────────────────────────

describe("the envelope: the floor, and only what the seat narrowed", () => {
  test("the narrow envelope denies the floor, the app's own doors and the four narrowed groups", () => {
    const d = deniedFor(NARROW);
    for (const c of DENIED_COMMANDS) expect(d).toContain(c);
    for (const c of WORKER_DENIED) expect(d).toContain(c);
    for (const c of [...LIFTS.commit, ...LIFTS.network, ...LIFTS.docker, ...LIFTS.worktree]) expect(d, c).toContain(c);
  });

  test("the wide envelope denies the floor and the doors, and nothing else of the git, network and docker groups", () => {
    const d = deniedFor(WIDE);
    for (const c of DENIED_COMMANDS) expect(d).toContain(c);
    for (const c of [...LIFTS.commit, ...LIFTS.network, ...LIFTS.docker, ...LIFTS.worktree, "git push", "gh", "aws"]) expect(d, c).not.toContain(c);
  });

  test("each flag narrows exactly its own group, in any combination", () => {
    for (const commit of [false, true]) for (const network of [false, true]) for (const docker of [false, true]) for (const worktreeOps of [false, true]) {
      const d = deniedFor({ write: "worktree", commit, network, docker, worktreeOps, deny: [] });
      const denied = [...LIFTS.commit, ...LIFTS.network, ...LIFTS.docker, ...LIFTS.worktree].filter((c) => d.includes(c));
      expect(denied.sort()).toEqual([...(commit ? [] : LIFTS.commit), ...(network ? [] : LIFTS.network), ...(docker ? [] : LIFTS.docker), ...(worktreeOps ? [] : LIFTS.worktree)].sort());
    }
  });

  test("a sandbox that holds the turn is the wall for curl and wget: they are not denied by name", () => {
    expect(deniedFor(NARROW, undefined, [], true)).not.toContain("curl");
    expect(deniedFor(NARROW, undefined, [], false)).toContain("curl");
  });

  test("deny can only add", () => {
    expect(deniedFor({ ...WIDE, deny: ["make deploy"] })).toContain("make deploy");
    expect(deniedFor({ ...NARROW, deny: ["curl"] }).filter((c) => c === "curl")).toHaveLength(1);
  });

  test("a role's allow cannot take back what the seat narrowed, and the floor never lifts", () => {
    const ci = { ...builder, title: "CI", allow: ["docker", ...NEVER_LIFTABLE] };
    const d = deniedFor(NARROW, ci);
    expect(d).toContain("docker");
    for (const never of NEVER_LIFTABLE) expect(d).toContain(never);
    expect(deniedFor({ ...NARROW, docker: true }, ci)).not.toContain("docker");
  });

  test("OpenCode gets the same list in its map: a narrowed docker is a deny key, an open one is no key", () => {
    const bash = (e: Envelope) => {
      const c = compileEnvelope("opencode", builder, e, "opencode/big-pickle", scratch());
      if (!c.ok) throw new Error(c.error);
      return (JSON.parse(c.env.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: Record<string, string> } }).permission.bash;
    };
    expect(bash(NARROW)["docker"]).toBe("deny");
    expect(bash({ ...NARROW, docker: true })["docker"]).toBeUndefined();
    expect(bash(WIDE)["git push"]).toBe("deny");
    expect(bash(WIDE)["sudo"]).toBe("deny");
    expect(bash(WIDE)["sudo *"]).toBe("deny");
  });

  test("Claude: the worktree commands of another checkout stay denied under every flag; git worktree add is the seat's own", () => {
    const c = compileEnvelope("claude", builder, WIDE, "sonnet", scratch());
    if (!c.ok) throw new Error(c.error);
    const deny = (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    for (const w of ["repair", "lock", "move", "unlock"]) expect(prefixRefused(deny, `git worktree ${w} x`), w).toBeDefined();
    expect(prefixRefused(deny, "git worktree add /tmp/x y")).toBeUndefined();
    expect(prefixRefused(deny, "git push origin x")).toBeUndefined();
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

  test("Claude: the start says which lock holds the turn", () => {
    const partly = (role: typeof builder) => {
      const c = compileEnvelope("claude", role, NARROW, "sonnet", dir);
      if (!c.ok) throw new Error(c.error);
      return c.partly ?? "";
    };
    // Both shells run in the CLI's sandbox: a builder's browser door goes
    // through its MCP server, not the loopback relay a shell has no route to.
    expect(partly(scout)).toContain("sandbox");
    expect(partly(builder)).toContain("sandbox");
    expect(partly(builder)).not.toContain("NOT sandboxed");
  });

  test("Claude: sudo is denied under every flag, gh and git push under none; commit narrows only git commit", () => {
    for (const e of [NARROW, WIDE, { ...NARROW, commit: true }, { ...NARROW, network: true }]) {
      const d = claudeDeny(e);
      expect(d).toContain("Bash(sudo:*)");
      for (const c of ["gh", "ssh", "rm", "git push"]) expect(d, c).not.toContain(`Bash(${c}:*)`);
      expect(d.includes("Bash(git commit:*)")).toBe(!e.commit);
      expect(d.includes("Bash(docker:*)")).toBe(!e.docker);
    }
  });

  test("OpenCode: bash denies the floor, and webfetch is denied unless the envelope lets the worker out", () => {
    const narrow = opencode(NARROW);
    expect(narrow.permission.bash["sudo"]).toBe("deny");
    for (const c of ["gh", "ssh"]) expect(narrow.permission.bash[c]).toBe("deny");
    expect(narrow.permission.bash["git commit"]).toBe("deny");
    expect(narrow.permission.webfetch).toBe("deny");
    const wide = opencode(WIDE);
    expect(wide.permission.bash["git commit"]).toBeUndefined();
    expect(wide.permission.bash["sudo"]).toBe("deny");
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
    for (const g of ["*agentglass-agent*", "*agentglass-ui*", "* sudo *", "*/sudo *"]) expect(bash[g]).toBe("deny");
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
    const path = c.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("Bash(sudo)");
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

// ── the one door a role may use ──────────────────────────────────────────

describe("the app's own doors, per role", () => {
  const dir = scratch();
  const opencodeFor = (id: string, e: Envelope = NARROW) => {
    const c = compileEnvelope("opencode", workerRole(id)!, e, "opencode/big-pickle", dir);
    if (!c.ok) throw new Error(c.error);
    return (JSON.parse(c.env.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: Record<string, string> } }).permission.bash;
  };
  const browserLines = [
    "agentglass-browser --as orbit-1 observe",
    "./bin/agentglass-browser --as orbit-1 observe",
    "bun bin/agentglass-browser --as orbit-1 observe",
    "agentglass-browser --as orbit-1 click e17",
    "agentglass-browser --as orbit-1 read --page t9-ef01",
  ];
  // The flags that leave the worker's own tab, wherever they sit in the line.
  const crossLines = [
    "agentglass-browser --as orbit-1 read --shared",
    "agentglass-browser --as orbit-1 read --active",
    "agentglass-browser --as orbit-1 read --share",
    "agentglass-browser --as orbit-1 read --acti",
  ];

  test("a builder, a reviewer and a verifier run the browser CLI bare, by path and through bun", () => {
    for (const id of ["builder", "reviewer", "verifier"]) {
      const bash = opencodeFor(id);
      for (const line of browserLines) expect(refusedBy(bash, line)).toBeUndefined();
      // Its own named tab only: every way out stays refused, prefix included.
      for (const line of crossLines) expect(refusedBy(bash, line)).toBeTruthy();
    }
  });

  test("a scout keeps the browser closed, and every role keeps the other three doors closed", () => {
    const scoutBash = opencodeFor("scout");
    for (const line of browserLines) expect(refusedBy(scoutBash, line)).toBeTruthy();
    for (const id of ["scout", "builder", "reviewer", "verifier"]) {
      const bash = opencodeFor(id);
      for (const line of ["agentglass-agent start orbit-2", "agentglass-ui settings set theme dark", "agentglass-cockpit-mcp sessions"]) {
        expect(refusedBy(bash, line)).toBeTruthy();
      }
    }
  });

  test("the browser opens nothing else: the network clients stay denied for a turn the sandbox does not hold; a delete and a kill are the seat's own", () => {
    const bash = opencodeFor("builder");
    for (const line of ["curl http://127.0.0.1:4000/health", "wget http://127.0.0.1:4000/x", "sudo ls"]) {
      expect(refusedBy(bash, line), line).toBeTruthy();
    }
    // OpenCode runs none of the person's hooks, so it keeps the old floor: a delete and a kill stay refused.
    for (const line of ["rm -rf .agx-tmp", "kill 1234", "killall5"]) expect(refusedBy(bash, line), line).toBeTruthy();
    // An envelope that lets the worker out lifts the clients, not the rest.
    const wide = opencodeFor("builder", WIDE);
    expect(refusedBy(wide, "curl http://127.0.0.1:4000/health")).toBeUndefined();
    for (const line of ["sudo", "sudo rm x", "/usr/bin/sudo ls"]) {
      expect(refusedBy(wide, line), line).toBeTruthy();
    }
    for (const line of ["rm -rf .agx-tmp", "kill 1234", "aws s3 ls", "gh pr list"]) {
      expect(refusedBy(wide, line), line).toBeTruthy();
    }
  });

  test("Claude: the browser CLI is closed to every role, and the MCP server is the door", () => {
    const denyFor = (id: string) => {
      const c = compileEnvelope("claude", workerRole(id)!, NARROW, "sonnet", dir);
      if (!c.ok) throw new Error(c.error);
      return (JSON.parse(c.args[c.args.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;
    };
    // The sandbox reaches the loopback relay for a role whose door is the
    // browser, so the CLI is open to those; scout has no browser door.
    for (const id of ["builder", "reviewer", "verifier"]) expect(denyFor(id)).not.toContain("Bash(agentglass-browser:*)");
    expect(denyFor("scout")).toContain("Bash(agentglass-browser:*)");
    expect(prefixRefused(denyFor("scout"), "agentglass-browser --as orbit-1 observe")).toBeTruthy();
    for (const c of ["agentglass-agent", "agentglass-ui", "agentglass-cockpit-mcp"]) expect(denyFor("builder")).toContain(`Bash(${c}:*)`);
    expect(denyFor("builder")).toContain("Bash(sudo:*)");
    for (const c of ["rm", "kill", "ssh"]) expect(denyFor("builder")).not.toContain(`Bash(${c}:*)`);
  });

  test("Qwen: the same door and the same flags in the settings file it is pointed at", () => {
    const denyFor = (id: string) => {
      const c = compileEnvelope("qwen", workerRole(id)!, NARROW, "qwen3", dir);
      if (!c.ok) throw new Error(c.error);
      return (JSON.parse(readFileSync(c.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!, "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    };
    for (const id of ["builder", "reviewer", "verifier"]) {
      expect(denyFor(id)).not.toContain("Bash(agentglass-browser)");
      expect(prefixRefused(denyFor(id), "agentglass-browser --as orbit-1 observe")).toBeUndefined();
      for (const flag of ["--shared", "--share", "--active", "--acti"]) {
        expect(prefixRefused(denyFor(id), `agentglass-browser ${flag} read`)).toBeTruthy();
      }
      expect(prefixRefused(denyFor(id), "agentglass-browser --as orbit-1 read --page t9-ef01")).toBeUndefined();
    }
    expect(prefixRefused(denyFor("scout"), "agentglass-browser --as orbit-1 observe")).toBeTruthy();
    expect(denyFor("builder")).toContain("Bash(sudo)");
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
    // The seat's powers, less the two that would drop the sandbox.
    expect(r.ok && r.envelope).toEqual({ ...NARROW, commit: true, worktreeOps: true });
    expect(p.ceiling).toEqual({ ...WIDE });
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
    const t = headlessTurn({ engine: "opencode", bin: "/bin/true", model: "orbit-1", role: builder, envelope: NARROW, limits: { turnMinutes: 5 } as never, prompt: "x", cwd: "/w/tree" });
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

  test("--allow: only network, commit and docker exist, and each stops at the ceiling", () => {
    const bad = planWorker({ role: "builder", allow: ["push"] }, view(p), none, FLEET, null);
    expect(!bad.ok && bad.error).toContain("never granted to a worker");
    // The default ceiling is the seat's: a worker may be given the network and docker at start.
    const commit = planWorker({ role: "builder", allow: ["commit"] }, view(p), none, FLEET, null);
    expect(commit.ok && commit.envelope).toEqual({ ...NARROW, commit: true, worktreeOps: true });
    // A project that narrowed its ceiling still stops a grant at it.
    const tight = { ...p, ceiling: { ...NARROW, commit: true } };
    const net = planWorker({ role: "builder", allow: ["network"] }, view(tight), none, FLEET, null);
    expect(!net.ok && net.error).toContain("beyond this project's ceiling");
    expect(!net.ok && net.error).toContain("Nothing was started");
    const dock = planWorker({ role: "builder", allow: ["docker"] }, view(tight), none, FLEET, null);
    expect(!dock.ok && dock.error).toContain("workers may not use docker here");
    const open = { ...tight, ceiling: { ...WIDE } };
    expect(planWorker({ role: "builder", allow: ["network", "commit", "docker"] }, view(open), none, FLEET, null)).toMatchObject({ ok: true, envelope: { network: true, commit: true, docker: true } });
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

const turn = (engine: string, o: Partial<Parameters<typeof headlessTurn>[0]> = {}) => {
  const cwd = o.cwd ?? "/w/orbit";
  const t = headlessTurn({ engine, bin: `/x/${engine}`, model: "m", role: builder, envelope: NARROW, limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "-m evil", cwd, skillsRoot: cwd, unwalledEngines: true, ...o });
  // Where bwrap works the engine's argv is prefixed by the read wall (worker-bwrap-wall.test.ts owns that); these tests are about the engine's own argv.
  if (t.ok && t.argv[0] === "bwrap") t.argv = t.argv.slice(t.argv.indexOf("--") + 1);
  return t;
};

const sandboxOf = (t: { argv: string[] }) =>
  (JSON.parse(t.argv[t.argv.indexOf("--settings") + 1]!) as {
    sandbox?: { network: { allowedDomains: string[]; strictAllowlist?: boolean; allowLocalBinding?: boolean }; filesystem: { allowWrite: string[]; denyWrite?: string[] } };
  }).sandbox;
const mcpOf = (t: { argv: string[] }) =>
  JSON.parse(t.argv[t.argv.indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, { command: string }> };
const allowOf = (t: { argv: string[] }) => t.argv[t.argv.indexOf("--allowedTools") + 1]!.split(" ");

describe("the argv of one headless turn", () => {
  test("Claude: the real TUI with the brief as its first message, a session chosen up front", () => {
    const t = turn("claude", { model: "sonnet" });
    if (!t.ok) throw new Error(t.error);
    // The person watches this pane: it is the interactive Claude Code, not a
    // summary of its stream. Nothing reads stdin, and the turn's end is the
    // CLI's own transcript marker (agents/tuiturn.ts).
    expect(t.stdin).toBe("none");
    expect(t.tui).toBe(true);
    expect(t.argv).not.toContain("-p");
    expect(t.argv).not.toContain("--output-format");
    expect(t.argv).not.toContain("--verbose");
    // A brief that starts with `-` is not read as a flag: one leading space
    // keeps it a message.
    expect(t.argv.at(-1)).toBe(" -m evil");
    expect(t.argv).toContain("--settings");
    expect(t.argv).toContain("--permission-mode");
    // NEVER A DIALOG: nobody is at that pane (see the test below).
    expect(t.argv[t.argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(t.argv).toContain("--session-id");
    expect(t.argv.join(" ")).not.toMatch(/dangerously|bypass/);
    const again = turn("claude", { resume: "abc-123" }) as { argv: string[] };
    expect(again.argv.slice(-3, -1)).toEqual(["--resume", "abc-123"]);
  });

  test("Claude: the role's permission mode is the caller's choice, dontAsk when it names none", () => {
    const unset = turn("claude", { model: "sonnet" });
    if (!unset.ok) throw new Error(unset.error);
    expect(unset.argv[unset.argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");

    const bypass = turn("claude", { model: "sonnet", permissionMode: "bypassPermissions" });
    if (!bypass.ok) throw new Error(bypass.error);
    expect(bypass.argv[bypass.argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    // Bypass only stops the CLI refusing tools outside the allow list: the
    // sandbox and the deny rules still ride on the turn exactly as before.
    expect(bypass.argv).toContain("--settings");
    expect(sandboxOf(bypass)).toBeTruthy();
    const deny = (JSON.parse(bypass.argv[bypass.argv.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain("Bash(sudo:*)");
  });

  test("Claude: the CLI reads the person's settings only, whatever workers.projectSkills says", () => {
    /* `--setting-sources` never widens to "project": that would also hand the
       CLI the checkout's real hooks, MCP servers and permissions.allow. The
       deny rules and the hooks that name a file in `.claude` are forwarded by
       `checkoutSettings` instead (the describe below), on or off. */
    for (const projectSkills of [undefined, true, false]) {
      const t = turn("claude", { model: "sonnet", projectSkills }) as { argv: string[] };
      expect(t.argv[t.argv.indexOf("--setting-sources") + 1]).toBe("user");
    }
  });

  test("workers.projectSkills: on (the default) stages the checkout's own skills and commands into a session-only plugin, off stages nothing", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".claude", "skills", "deploy-thing"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "deploy-thing", "SKILL.md"), "---\nname: deploy-thing\n---\nDeploy the thing.\n");
    mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "commands", "ship.md"), "Ship it.\n");

    const runDir = scratch();
    const on = turn("claude", { cwd, runDir }) as { argv: string[] };
    expect(on.argv).toContain("--plugin-dir");
    const staged = on.argv[on.argv.indexOf("--plugin-dir") + 1]!;
    expect(readFileSync(join(staged, "skills", "deploy-thing", "SKILL.md"), "utf8")).toContain("Deploy the thing.");
    expect(readFileSync(join(staged, "commands", "ship.md"), "utf8")).toBe("Ship it.\n");
    expect(JSON.parse(readFileSync(join(staged, ".claude-plugin", "plugin.json"), "utf8")).hooks).toBeUndefined();
    expect(on.argv[on.argv.indexOf("--allowedTools") + 1]!.split(" ")).toContain("Skill");

    const off = turn("claude", { cwd, runDir: scratch(), projectSkills: false }) as { argv: string[] };
    expect(off.argv).not.toContain("--plugin-dir");
    expect(off.argv[off.argv.indexOf("--allowedTools") + 1]!.split(" ")).not.toContain("Skill");
  });

  test("workers.projectSkills: a skill directory that is a symlink is never staged", () => {
    /* A worker could otherwise point `.claude/skills/x` at a directory outside
       the checkout and have this read it as the checkout's own. */
    const cwd = scratch();
    const outside = scratch();
    writeFileSync(join(outside, "SKILL.md"), "exfiltrated\n");
    mkdirSync(join(cwd, ".claude", "skills"), { recursive: true });
    symlinkSync(outside, join(cwd, ".claude", "skills", "linked"));
    const t = turn("claude", { cwd, runDir: scratch() }) as { argv: string[] };
    expect(t.argv).not.toContain("--plugin-dir");
  });

  test("workers.projectSkills: staged from the project root, never from the turn's own worktree", () => {
    /* The worktree can be an untrusted checkout (an outside contributor's PR
       branch) reviewed under a worker; its own `.claude/skills` must never be
       the source, whatever it ships. */
    const projectRoot = scratch();
    const worktree = scratch();
    mkdirSync(join(worktree, ".claude", "skills", "lure"), { recursive: true });
    writeFileSync(join(worktree, ".claude", "skills", "lure", "SKILL.md"), "lure\n");
    const t = turn("claude", { cwd: worktree, skillsRoot: projectRoot, runDir: scratch() }) as { argv: string[] };
    expect(t.argv).not.toContain("--plugin-dir");
  });

  test("workers.projectSkills: never staged with no skillsRoot, even with a run folder and a checkout that has skills", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".claude", "skills", "deploy-thing"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "deploy-thing", "SKILL.md"), "Deploy the thing.\n");
    const t = turn("claude", { cwd, skillsRoot: undefined, runDir: scratch() }) as { argv: string[] };
    expect(t.argv).not.toContain("--plugin-dir");
  });

  test("Claude: a turn can never stop on a permission dialog, and the deny list is still the ceiling", () => {
    /* Measured on the CLI's own `--help`: `dontAsk` is a permission mode, and
       anything that would have prompted is refused instead ("anything that
       would prompt is denied automatically"). `acceptEdits` asks for Bash — the
       brief's own `bun test` — and `plan` asks about everything. A turn stopped
       on a dialog writes no `turn_duration`, so it sat until the ceiling, was
       killed with 124, and `saveScoutPlan` refused the plan. */
    const t = turn("claude", { model: "sonnet" });
    if (!t.ok) throw new Error(t.error);
    const argv = t.argv;
    const mode = argv[argv.indexOf("--permission-mode") + 1];
    expect(mode).toBe("dontAsk");
    expect(argv).not.toContain("acceptEdits");
    // The allow list is what a worker must be able to run: the shell that runs
    // `bun test` and `make …`, and the edits of a role that writes.
    const allow = argv[argv.indexOf("--allowedTools") + 1]!.split(" ");
    expect(allow).toContain("Bash");
    for (const tool of ["Edit", "Write"]) expect(allow).toContain(tool);
    // …and the settings deny list outranks it, so a denied command is refused
    // without a dialog rather than allowed by the allow list.
    const deny = (JSON.parse(argv[argv.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain("Bash(sudo:*)");
    expect(deny).not.toContain("Bash(gh:*)");
    // Read as the CLI reads the rules: the brief's own commands match none, and
    // the ones the envelope denies match one.
    expect(prefixRefused(deny, "bun test")).toBeUndefined();
    expect(prefixRefused(deny, "make vart.test")).toBeUndefined();
    expect(prefixRefused(deny, "sudo origin main")).toBe("Bash(sudo:*)");
    // The flag takes a list, so a flag has to close it: otherwise the brief
    // would be read as one more tool name.
    expect(argv[argv.indexOf("--allowedTools") + 2]).toBe("--permission-mode");
  });

  test("Claude: a read-only role asks for no edit tool at all", () => {
    for (const role of [scout, workerRole("reviewer")!, workerRole("verifier")!]) {
      const t = turn("claude", { role }) as { argv: string[] };
      const allow = t.argv[t.argv.indexOf("--allowedTools") + 1]!.split(" ");
      expect(allow).toContain("Bash");
      for (const edit of ["Edit", "Write", "NotebookEdit"]) expect(allow).not.toContain(edit);
      const deny = (JSON.parse(t.argv[t.argv.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;
      for (const edit of ["Edit", "Write", "NotebookEdit"]) expect(deny).toContain(edit);
    }
  });

  test("Claude: the two branches of the allow list are the lock for edits and the web", () => {
    // A role that writes, under an envelope that writes nothing, gets no edit
    // tool: the `write: "none"` half of `allowedToolsFor`, which a read-only
    // role short-circuits.
    const none = turn("claude", { envelope: { ...NARROW, write: "none" } }) as { argv: string[] };
    const noneAllow = none.argv[none.argv.indexOf("--allowedTools") + 1]!.split(" ");
    for (const edit of ["Edit", "Write", "NotebookEdit"]) expect(noneAllow).not.toContain(edit);
    const wide = turn("claude", { envelope: WIDE }) as { argv: string[] };
    const wideAllow = wide.argv[wide.argv.indexOf("--allowedTools") + 1]!.split(" ");
    for (const edit of ["Edit", "Write", "NotebookEdit"]) expect(wideAllow).toContain(edit);
    // The web tools follow `network`, and nothing else does.
    const off = turn("claude", { envelope: NARROW }) as { argv: string[] };
    const offAllow = off.argv[off.argv.indexOf("--allowedTools") + 1]!.split(" ");
    for (const web of ["WebFetch", "WebSearch"]) expect(offAllow).not.toContain(web);
    for (const web of ["WebFetch", "WebSearch"]) expect(wideAllow).toContain(web);
    // The same absent tools are denied by name, so a project settings file
    // cannot allow them back.
    const deny = (JSON.parse(off.argv[off.argv.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;
    for (const web of ["WebFetch", "WebSearch"]) expect(deny).toContain(web);
  });

  test("Claude: a scout's turn runs inside Claude Code's own sandbox, which is what holds the envelope", () => {
    /* `Bash` is allowed whole and the deny list reads command text, so a
       `python3 -c 'urllib.request.urlopen(...)'` matches no rule. The sandbox
       is the lock for that: no network, and writes nowhere but the turn's own
       folder. Measured on the installed CLI (2.1.318): `sandbox.enabled`,
       `network.allowedDomains`, `filesystem.allowWrite`/`denyWrite`, and
       `allowUnsandboxedCommands: false` (the `dangerouslyDisableSandbox` door). */
    const t = turn("claude", { role: scout, runDir: "/state/worker-runs/w1" }) as { argv: string[] };
    const settings = JSON.parse(t.argv[t.argv.indexOf("--settings") + 1]!) as {
      sandbox: Record<string, unknown> & { network: { allowedDomains: string[] }; filesystem: { allowWrite: string[]; denyWrite: string[] } };
      permissions: { deny: string[] };
    };
    expect(settings.sandbox).toMatchObject({
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      // The empty list is authoritative: a domain a project's or a checkout's
      // settings file adds is left out (strictAllowlist, honoured from --settings).
      network: { allowedDomains: [], strictAllowlist: true },
    });
    expect(settings.sandbox.filesystem.denyWrite).toEqual(["/w/orbit"]);
    expect(settings.sandbox.filesystem.allowWrite).toEqual(["/state/worker-runs/w1"]);
    // Bash stays allowed: the sandbox confines it, it does not refuse to run
    // the brief's `bun test`.
    expect(t.argv[t.argv.indexOf("--allowedTools") + 1]!.split(" ")).toContain("Bash");
    // The deny list is still there beside it.
    expect(settings.permissions.deny).toContain("Bash(sudo:*)");
  });

  test("Claude: the sandbox is left out where it cannot hold the envelope, and only there", () => {
    /* Two measured ceilings: `allowedDomains` refuses a bare `*`, so a turn the
       envelope lets out has no sandbox that keeps it out; and a Unix socket
       outside the worktree is refused inside it, so a turn the envelope gives
       docker would lose the daemon. Both keep the prefix lock the start reports
       as "partly". */
    const web = turn("claude", { role: scout, envelope: { ...NARROW, network: true } }) as { argv: string[] };
    expect((JSON.parse(web.argv[web.argv.indexOf("--settings") + 1]!) as { sandbox?: unknown }).sandbox).toBeUndefined();
    const docker = turn("claude", { role: scout, envelope: { ...NARROW, docker: true } }) as { argv: string[] };
    expect((JSON.parse(docker.argv[docker.argv.indexOf("--settings") + 1]!) as { sandbox?: unknown }).sandbox).toBeUndefined();
    // A role with neither is sandboxed whether or not it writes: a flow role
    // is not in DOORS_FOR_ROLE, so a custom builder gets the worktree and its
    // run folder as writable roots.
    const custom = { ...builder, id: "arch" as never };
    const writing = turn("claude", { role: custom, runDir: "/state/worker-runs/w1" }) as { argv: string[] };
    const settings = (JSON.parse(writing.argv[writing.argv.indexOf("--settings") + 1]!) as { sandbox: { filesystem: { allowWrite: string[]; denyWrite?: string[] } } }).sandbox;
    expect(settings.filesystem.allowWrite).toEqual(["/w/orbit", "/state/worker-runs/w1"]);
    // `.claude` is denied whether or not the tree has one yet: a settings file
    // written there is read by the next turn's CLI.
    expect(settings.filesystem.denyWrite).toEqual(["/w/orbit/.claude"]);
  });

  test("Claude: a writing role with the browser door is sandboxed, reaching the browser through MCP", () => {
    /* A builder used to keep the prefix lock alone because its browser door is
       a loopback relay. The relay is only needed by the CLI; the MCP server the
       turn already loads runs outside this shell, so the shell can be sandboxed
       and the CLI denied as a shell command. `allowLocalBinding` keeps a test
       binary that binds 127.0.0.1 working. */
    const t = turn("claude", { role: builder, runDir: "/state/worker-runs/w1" }) as { argv: string[] };
    expect(sandboxOf(t)).toMatchObject({
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true },
      filesystem: { allowWrite: ["/w/orbit", "/state/worker-runs/w1"] },
    });
    const deny = (JSON.parse(t.argv[t.argv.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).not.toContain("Bash(agentglass-browser:*)");
    // The browser is still there, through the server that runs outside the shell.
    expect(Object.keys(mcpOf(t).mcpServers)).toEqual(["agentglass-browser", "agentglass-gh", "agentglass-commit"]);
    expect(allowOf(t)).toContain("mcp__agentglass-browser");
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
    // Codex now gets a read-wall permission profile instead of a sandbox_mode flag: workspace-write
    // would still let the shell read the whole home directory, token included.
    const b = turn("codex") as { argv: string[]; stdin: string };
    expect(b.argv.join(" ")).toContain('default_permissions="agx_worker"');
    expect(b.argv.join(" ")).toContain('"/w/orbit"="write"');
    expect(b.argv.join(" ")).toContain("approval_policy=never");
    expect(b.argv.at(-1)).toBe("-");
    expect(b.stdin).toBe("prompt");
    expect((turn("codex", { role: scout }) as { argv: string[] }).argv.join(" ")).not.toContain('"/w/orbit"="write"');
    expect((turn("codex", { model: "" }) as { ok: boolean }).ok).toBe(false);
  });

  test("Hermes: --query as one element, no --yolo, a run budget from the policy", () => {
    // Hermes has no sandbox of its own: it runs under the bwrap wall, and is refused only where bwrap
    // cannot run (that refusal is asserted in worker-bwrap-wall.test.ts).
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

describe("the checkout's settings, forwarded by the app and not by the project scope", () => {
  const settingsOf = (cwd: string, o: Partial<Parameters<typeof headlessTurn>[0]> = {}) => {
    const t = turn("claude", { cwd, runDir: "/state/worker-runs/w1", ...o });
    if (!t.ok) throw new Error(t.error);
    return JSON.parse(t.argv[t.argv.indexOf("--settings") + 1]!) as {
      env?: unknown;
      permissions: { deny: string[]; allow?: unknown };
      hooks?: Record<string, { matcher?: string; hooks: { command?: string }[] }[]>;
    };
  };
  /** What the checkout's settings forward, read directly: a start that would drop a PreToolUse hook is refused, so the filter is seen here. */
  const viewOf = (cwd: string, o: Partial<Parameters<typeof headlessTurn>[0]> = {}) => {
    void o;
    const r = checkoutSettings(cwd);
    return { permissions: { deny: r.deny }, hooks: r.hooks as Record<string, { matcher?: string; hooks: { command?: string }[] }[]> };
  };
  const commands = (s: { hooks?: Record<string, { hooks: { command?: string }[] }[]> }) =>
    Object.values(s.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  const checkout = () => {
    const d = scratch();
    mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, ".claude", "x.sh"), "#!/bin/sh\n");
    writeFileSync(join(d, ".claude", "hooks", "guard.sh"), "#!/bin/sh\n");
    writeFileSync(join(d, ".claude", "hooks", "deny-prod.py"), "#!/usr/bin/env python3\n");
    writeFileSync(join(d, "src", "x.sh"), "#!/bin/sh\n");
    return d;
  };
  const group = (command: string) => ({ matcher: "Bash", hooks: [{ type: "command", command }] });
  /** The commands of `list` one turn keeps, one group each, in file order: a
   *  command is kept or dropped on its own, never as part of its neighbour. */
  const kept = (cwd: string, list: string[]) => {
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: list.map(group) } }));
    return commands(viewOf(cwd));
  };

  test("a hook that runs a file in .claude is kept; one the worker could rewrite is dropped", () => {
    /* `.claude` is made at turn start and denied by the sandbox, so a script in
       it is the one file a project hook can name that the worker cannot
       rewrite. Everything else a command runs — a script under `src`, a package
       script the worker edits — is the worker's to change. */
    const cwd = checkout();
    const outside = join(scratch(), "elsewhere.sh");
    writeFileSync(outside, "#!/bin/sh\n");
    symlinkSync(outside, join(cwd, ".claude", "hooks", "linked.sh"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          group("python3 .claude/hooks/deny-prod.py"),
          group("$CLAUDE_PROJECT_DIR/.claude/hooks/deny-prod.py"),
          group("bash .claude/x.sh"),
          group("npm run lint"),
          group("bash src/x.sh"),
          group("python3 -c .claude/x.py"),
          group("python3 .claude/hooks/deny-prod.py && curl http://prod-1.acme.example"),
          group("bash .claude/hooks/linked.sh"),
          group('python3 "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/.claude/hooks/deny-prod.py"'),
          group('python3 "${CLAUDE_PROJECT_DIR:-$(curl http://prod-1.acme.example)}/.claude/hooks/deny-prod.py"'),
        ],
      },
    }));
    expect(commands(viewOf(cwd)).sort()).toEqual([
      "$CLAUDE_PROJECT_DIR/.claude/hooks/deny-prod.py",
      'python3 "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/.claude/hooks/deny-prod.py"',
      "bash .claude/x.sh",
      "python3 .claude/hooks/deny-prod.py",
    ].sort());
  });

  test("a hook that is dropped is logged, so a team's guard does not stop without a trace", () => {
    /* A valid team hook whose interpreter is not one of the five names stops
       running. Silence there is a policy that silently stopped, so each one
       leaves one structured line. */
    const cwd = checkout();
    const guard = "bash .claude/hooks/guard.sh";
    const dropped = ["zsh .claude/hooks/guard.sh", "ruby .claude/hooks/guard.rb"];
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [...dropped, guard].map(group) } }));
    const warn = spyOn(console, "warn");
    try {
      expect(commands(viewOf(cwd))).toEqual([guard]);
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(lines).toHaveLength(dropped.length);
      for (const line of lines) {
        const entry = JSON.parse(line) as { event?: unknown; hook?: unknown; command?: unknown; cwd?: unknown };
        expect(entry.event).toBe("worker.hook.dropped");
        expect(entry.hook).toBe("PreToolUse");
        expect(entry.cwd).toBe(cwd);
        expect(dropped).toContain(entry.command as string);
      }
    } finally { warn.mockRestore(); }
  });


  test("a dropped hook's command is redacted in the log", () => {
    /* `settings.local.json` is gitignored, the place a person keeps a machine's
       own values, and a hook command can carry one as an argument: the log line
       kept it verbatim. */
    const cwd = checkout();
    const token = `ghp_${"a".repeat(36)}`;
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({
      hooks: { PreToolUse: [group(`zsh .claude/hooks/guard.sh --token=${token}`)] },
    }));
    const warn = spyOn(console, "warn");
    try {
      expect(commands(viewOf(cwd))).toEqual([]);
      const lines = warn.mock.calls.map((args) => String(args[0])).join("\n");
      expect(lines).toContain("worker.hook.dropped");
      expect(lines).not.toContain(token);
    } finally { warn.mockRestore(); }
  });

  test("an interpreter is a bare name: a path to one is a file the worker wrote", () => {
    /* The command is the team's, but a program reached by a path is a file in
       the tree the worker writes: `vendor/python3 .claude/hooks/guard.sh` ran
       the worker's python with the checkout's guard as its `$1`. The allowlist
       takes the five bare names and nothing that looks like a path. */
    const cwd = checkout();
    const guard = "bash .claude/hooks/guard.sh";
    expect(kept(cwd, [
      guard,
      "vendor/python3 .claude/hooks/guard.sh",
      "./vendor/python3 .claude/hooks/guard.sh",
      "$PWD/x/node .claude/hooks/guard.sh",
      "a/../../elsewhere/bash .claude/hooks/guard.sh",
      "/bin/bash .claude/hooks/guard.sh",
      "python3.11 .claude/hooks/guard.sh",
      "dash .claude/hooks/guard.sh",
      "D:/tools/node .claude/hooks/guard.sh",
    ])).toEqual([guard]);
  });

  test("no interpreter flag: `-m`, `--require` and `--eval` load a file of the worker's", () => {
    /* A hook's argv is the script and nothing else. Every flag that was skipped
       for starting with `-` is a way to have the interpreter load code from the
       tree first: `python3 -m evil` runs `<tree>/evil.py` and never opens the
       `.claude` path at all, and `node --require=./tool.js` runs the worker's
       file before the script. */
    const cwd = checkout();
    const guard = "bash .claude/hooks/guard.sh";
    expect(kept(cwd, [
      guard,
      "python3 -m evil .claude/hooks/guard.sh",
      "python3 -m .claude/x.py",
      "node --require=./tool.js .claude/hooks/guard.sh",
      "node --require ./tool.js .claude/hooks/guard.sh",
      'node --eval \'require("child_process")\' .claude/hooks/guard.sh',
      "perl -I. -Mevil .claude/hooks/guard.sh",
      "bash --rcfile ./rc .claude/hooks/guard.sh",
      "sh -x .claude/hooks/guard.sh",
      "python3 -c .claude/x.py",
      "node --input-type=module .claude/hooks/guard.sh",
    ])).toEqual([guard]);
  });

  test("a newline or a tab is a second command, not the end of one", () => {
    /* The shell runs both lines. `.claude` is the team's promise about one
       file; the second line is a file the worker wrote. */
    const cwd = checkout();
    expect(kept(cwd, [
      "bash .claude/hooks/guard.sh",
      "bash .claude/hooks/guard.sh\nnode tool.js",
      "bash .claude/hooks/guard.sh\r\nnode tool.js",
      "bash .claude/hooks/guard.sh\rnode tool.js",
      "bash\t.claude/hooks/guard.sh",
      "bash .claude/hooks/guard.sh\tnode tool.js",
      "bash .claude/hooks/guard.sh ; node tool.js",
      "bash .claude/hooks/guard.sh & node tool.js",
      "bash .claude/hooks/guard.sh | node tool.js",
    ])).toEqual(["bash .claude/hooks/guard.sh"]);
  });

  test("a NAME=value word before the program is not the program", () => {
    /* `X=a/../.claude/nothing-at-all node tool.js` was taken as a file under
       `.claude` because the token held a `/` and `resolve` normalised the `..`
       away; what ran was `node tool.js`. */
    const cwd = checkout();
    expect(kept(cwd, [
      "bash .claude/hooks/guard.sh",
      "X=a/../.claude/nothing-at-all node tool.js",
      "X=a/../.claude/x ./tool.sh",
      "FOO=1 python3 .claude/hooks/guard.sh",
      "FOO=1 bash .claude/hooks/guard.sh",
      "PATH=/tmp python3 .claude/hooks/guard.sh",
    ])).toEqual(["bash .claude/hooks/guard.sh"]);
  });

  test("a script reached through a link is refused: the command follows it again at run time", () => {
    /* The turn's check resolved the link to its target and the shell resolved
       it again later, after the worker replaced the link with its own script:
       the tree is writable, the link is not `.claude`. So a link anywhere on
       the path is not a script, at the end or in the middle. */
    const cwd = checkout();
    const guard = join(cwd, ".claude", "hooks", "guard.sh");
    symlinkSync(guard, join(cwd, "link.sh"));
    symlinkSync(guard, join(cwd, ".claude", "hooks", "alias.sh"));
    mkdirSync(join(cwd, ".claude", "hooks-real"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "hooks-real", "other.sh"), "#!/bin/sh\n");
    symlinkSync(join(cwd, ".claude", "hooks-real"), join(cwd, ".claude", "hooks-link"));
    const accepted = "bash .claude/hooks/guard.sh";
    expect(kept(cwd, [
      accepted,
      "bash link.sh",
      "bash .claude/hooks/alias.sh",
      "bash .claude/hooks-link/other.sh",
    ])).toEqual([accepted]);
    // The real file, reached by its own path, is still the one a team gets.
    expect(readFileSync(join(cwd, ".claude", "hooks", "guard.sh"), "utf8")).toBe("#!/bin/sh\n");
  });

  test("a script is a `.claude` path segment by segment, and the file has to be there", () => {
    /* `.` and `..` are not segments a `.claude` file is named by: the check
       resolves `..` away, so a command that reads as a `.claude` path can be a
       file elsewhere in the tree. A missing file, a directory, a space and a
       second word are not a script either. */
    const cwd = checkout();
    expect(kept(cwd, [
      "  bash .claude/hooks/guard.sh  ",
      "python3 .claude/hooks/deny-prod.py",
      "bash .claude/../src/x.sh",
      "$CLAUDE_PROJECT_DIR/.claude/../src/x.sh",
      'python3 "$CLAUDE_PROJECT_DIR/.claude/../src/x.sh"',
      "bash .claude/hooks/./guard.sh",
      "bash .claude//hooks/guard.sh",
      "bash .claude/hooks/missing.sh",
      "bash .claude/hooks",
      "bash .claude/",
      "bash .cache/x.sh",
      "bash .claude/hooks/guard.sh extra",
      "bash .claude/hooks/guard.sh --now",
      "bash .claude/hooks/guard.sh\0x",
    ])).toEqual([
      "  bash .claude/hooks/guard.sh  ",
      "python3 .claude/hooks/deny-prod.py",
    ]);
  });

  test("a quoted script is one token, and a quote that closes early is not the path", () => {
    /* Only the double-quoted form is one of the shapes, and only when the
       quote is the last character of the command: the shell reads
       `".claude/x.sh".claude/hooks/guard.sh"` as one word of concatenated
       pieces, which is not the file the check resolved. */
    const cwd = checkout();
    expect(kept(cwd, [
      'python3 ".claude/x.sh"',
      'python3 ".claude/x.sh" .claude/hooks/guard.sh',
      'python3 ".claude/x.sh"x"',
      'python3 ".claude/x.sh".claude/hooks/guard.sh"',
      'python3 ".claude/x.sh',
      'python3 ""',
      "python3 '.claude/x.sh'",
      'python3 ".claude/../src/x.sh"',
    ])).toEqual(['python3 ".claude/x.sh"']);
  });

  test("a settings file that is a link, or lands outside .claude, is not read", () => {
    /* `readFileSync` follows a link, and the sandbox's deny is on `.claude`
       itself: a committed `settings.local.json` that is `../notes.json` hands
       the worker the pen on the next turn's hooks. */
    const cwd = checkout();
    const notes = join(scratch(), "notes.json");
    writeFileSync(notes, JSON.stringify({
      permissions: { deny: ["Bash(ssh prod-9.acme.example:*)"] },
      hooks: { PreToolUse: [group("python3 .claude/hooks/deny-prod.py")] },
    }));
    symlinkSync(notes, join(cwd, ".claude", "settings.local.json"));
    const s = settingsOf(cwd);
    expect(commands(s)).toEqual([]);
    expect(s.permissions.deny).not.toContain("Bash(ssh prod-9.acme.example:*)");
  });

  test("the deny rules of both settings files are forwarded; allow and env never are", () => {
    /* A deny rule can only narrow, so it is the part a team is entitled to. An
       allow would widen what the turn may do without asking, and `env` is
       worse: the browser door's roots are read from AGX_TURN_WRITE_ROOTS in the
       MCP server's environment, so a committed entry naming "/" would make
       record, download and trace unrestricted writers. */
    const cwd = checkout();
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({
      permissions: { deny: ["Bash(ssh prod-1.acme.example:*)"], allow: ["Bash(curl:*)"] },
      env: { AGX_TURN_WRITE_ROOTS: "/", ANTHROPIC_MODEL: "orbit-1" },
    }));
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { deny: ["Bash(ssh prod-2.acme.example:*)"] },
    }));
    const s = settingsOf(cwd);
    expect(s.permissions.deny).toContain("Bash(ssh prod-1.acme.example:*)");
    expect(s.permissions.deny).toContain("Bash(ssh prod-2.acme.example:*)");
    // The envelope's own rules are still there: forwarding adds, never replaces.
    expect(s.permissions.deny).toContain("Bash(sudo:*)");
    expect(s.permissions.allow).toBeUndefined();
    expect(s.env).toBeUndefined();
  });

  test("a missing or malformed settings file forwards nothing and does not fail the turn", () => {
    expect(commands(viewOf(checkout()))).toEqual([]);
    const broken = checkout();
    writeFileSync(join(broken, ".claude", "settings.json"), "{ not json");
    const s = settingsOf(broken);
    expect(commands(s)).toEqual([]);
    expect(s.permissions.deny).toContain("Bash(sudo:*)");
  });

  test("a hook rides an unsandboxed turn too, and the editing tools are kept out of .claude", () => {
    /* A lifted network (which gh needs) has no sandbox. Dropping the project's
       guard there refused the start, so a project with a guard had no worker
       that could reach GitHub at all. The hook rides, and Edit/Write on
       .claude are denied, since nothing else keeps them out on that turn. */
    const cwd = checkout();
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [group("python3 .claude/hooks/deny-prod.py")] },
    }));
    const open = settingsOf(cwd, { envelope: { ...NARROW, network: true } });
    expect(commands(open)).toEqual(["python3 .claude/hooks/deny-prod.py"]);
    expect(open.permissions.deny).toContain("Edit(.claude/**)");
    expect(open.permissions.deny).toContain("Write(.claude/**)");
    const boxed = settingsOf(cwd);
    expect(commands(boxed)).toHaveLength(1);
    expect(boxed.permissions.deny).not.toContain("Edit(.claude/**)");
  });

  /* What a forwarded hook rests on is that `.claude` is read-only inside a
     writable tree: a write inside it has to fail, and so does a rename of the
     directory (which is a write to the parent, and the parent is writable).
     Measured here on the Linux primitive. The seatbelt form on macOS is the
     same measurement and is not made on this machine. */
  const canBind = process.platform === "linux"
    && Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "true"]).exitCode === 0;

  test.skipIf(!canBind)("the premise of a hook: a read-only `.claude` refuses a write and a rename", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "hooks", "guard.sh"), "guard\n");
    const tries = [
      'printf x >> .claude/hooks/guard.sh 2>/dev/null; echo "write=$?"',
      'rm .claude/hooks/guard.sh 2>/dev/null; echo "remove=$?"',
      'mv .claude/hooks/guard.sh .claude/hooks/other.sh 2>/dev/null; echo "move=$?"',
      'mv .claude .claude.gone 2>/dev/null; echo "rename=$?"',
    ].join("\n");
    const p = Bun.spawnSync([
      "bwrap", "--dev-bind", "/", "/",
      "--bind", cwd, cwd,
      "--ro-bind", join(cwd, ".claude"), join(cwd, ".claude"),
      "--chdir", cwd, "/bin/sh", "-c", tries,
    ]);
    const said = p.stdout.toString();
    // A refusal is any non-zero status: dash says 2 for a failed redirect, bash and rm say 1.
    for (const t of ["write", "remove", "move", "rename"]) expect(said).toMatch(new RegExp(`${t}=[1-9]`));
    expect(readFileSync(join(cwd, ".claude", "hooks", "guard.sh"), "utf8")).toBe("guard\n");
    expect(existsSync(join(cwd, ".claude"))).toBe(true);
  });
});

describe("the walls a Claude worker starts with", () => {
  const reviewer = workerRole("reviewer")!;
  const verifier = workerRole("verifier")!;

  test("Claude: only this app's own MCP servers, never the person's or the checkout's", () => {
    /* A worker CLI loads user, project and local MCP servers and merges every
       scope's allow rules; `dontAsk` then runs anything already allowed. None
       of that is inside the bash sandbox, so the turn is given its own config
       and `--strict-mcp-config`, which stops every other source. */
    const cases: [WorkerRole, string[]][] = [[scout, ["agentglass-gh"]], [reviewer, ["agentglass-browser", "agentglass-gh"]], [builder, ["agentglass-browser", "agentglass-gh", "agentglass-commit"]]];
    for (const [role, servers] of cases) {
      const t = turn("claude", { role }) as { argv: string[] };
      expect(t.argv).toContain("--strict-mcp-config");
      expect(Object.keys(mcpOf(t).mcpServers)).toEqual(servers);
      if (servers.includes("agentglass-browser")) expect(mcpOf(t).mcpServers["agentglass-browser"]).toEqual({ command: "agentglass-browser-mcp" });
      expect(mcpOf(t).mcpServers["agentglass-gh"]).toEqual({ command: "agentglass-gh-mcp" });
    }
  });

  test("Claude: workers.mcpServers adds exactly the servers chosen, and a secret in one never rides in argv", () => {
    const none = turn("claude", { role: builder }) as { argv: string[] };
    expect(Object.keys(mcpOf(none).mcpServers)).toEqual(["agentglass-browser", "agentglass-gh", "agentglass-commit"]);
    // The value sat inline (no secret in play), so it is JSON in argv, not a path.
    expect(() => JSON.parse(none.argv[none.argv.indexOf("--mcp-config") + 1]!)).not.toThrow();

    const dir = scratch();
    const chosen = turn("claude", {
      role: builder, runDir: dir,
      mcpServers: [{ name: "atlassian", config: { type: "http", url: "https://mcp.atlassian.com/v2/mcp", env: { TOKEN: "s3cr3t" } } }],
    }) as { argv: string[] };
    const mcpArg = chosen.argv[chosen.argv.indexOf("--mcp-config") + 1]!;
    // A server the person configured can carry a token in its env: the value
    // goes to a file in the turn's own folder, never spelled out in argv.
    expect(mcpArg).not.toContain("s3cr3t");
    const written = JSON.parse(readFileSync(mcpArg, "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["agentglass-browser", "agentglass-gh", "agentglass-commit", "atlassian"]);
    expect(written.mcpServers.atlassian.env.TOKEN).toBe("s3cr3t");
  });

  test("Claude: a chosen server named like the app's own browser door is skipped, never overwrites it", () => {
    const t = turn("claude", { role: builder, mcpServers: [{ name: "agentglass-browser", config: { command: "evil" } }] }) as { argv: string[] };
    expect(mcpOf(t).mcpServers["agentglass-browser"]).toEqual({ command: "agentglass-browser-mcp" });
  });

  test("Claude: a chosen server's config never rides on argv when the turn has no run folder", () => {
    const t = turn("claude", {
      role: builder,
      mcpServers: [{ name: "atlassian", config: { type: "http", url: "https://mcp.atlassian.com/v2/mcp", env: { TOKEN: "s3cr3t" } } }],
    }) as { argv: string[] };
    const mcpArg = t.argv[t.argv.indexOf("--mcp-config") + 1]!;
    expect(mcpArg).not.toContain("s3cr3t");
    expect(Object.keys(JSON.parse(mcpArg).mcpServers)).toEqual(["agentglass-browser", "agentglass-gh", "agentglass-commit"]);
  });

  test("Claude: a read-only role gets the browser's reading tools alone, and a writer gets the server", () => {
    const r = turn("claude", { role: reviewer }) as { argv: string[] };
    const allow = allowOf(r);
    for (const read of ["mcp__agentglass-browser__browser_read", "mcp__agentglass-browser__browser_observe", "mcp__agentglass-browser__browser_shot"]) {
      expect(allow).toContain(read);
    }
    for (const acting of ["mcp__agentglass-browser__browser_click", "mcp__agentglass-browser__browser_eval", "mcp__agentglass-browser__browser_cdp"]) {
      expect(allow).not.toContain(acting);
    }
    // `record` writes frames and a gif from the app's own process, outside the
    // shell: a role that may only look does not get it.
    expect(allow).not.toContain("mcp__agentglass-browser__browser_record");
    expect(allow).not.toContain("mcp__agentglass-browser");
    const b = turn("claude", { role: builder }) as { argv: string[] };
    expect(allowOf(b)).toContain("mcp__agentglass-browser");
    expect(allowOf(b).filter((x) => x.startsWith("mcp__"))).toEqual(["mcp__agentglass-gh", "mcp__agentglass-commit", "mcp__agentglass-browser"]);
    // A scout has no door, so it is given neither the server nor a tool of it.
    const s = turn("claude", { role: scout }) as { argv: string[] };
    expect(allowOf(s).filter((x) => x.startsWith("mcp__"))).toEqual(["mcp__agentglass-gh"]);
  });

  test("Claude: the built-in reviewer and verifier are sandboxed too, and so is the builder", () => {
    for (const role of [scout, reviewer, verifier]) {
      const t = turn("claude", { role, runDir: "/state/worker-runs/w1" }) as { argv: string[] };
      expect(sandboxOf(t)).toMatchObject({
        enabled: true,
        filesystem: { allowWrite: ["/state/worker-runs/w1"], denyWrite: ["/w/orbit"] },
      });
    }
    // A writing role is sandboxed too: the worktree and its run folder are what
    // it may write.
    const b = turn("claude", { role: builder, runDir: "/state/worker-runs/w1" }) as { argv: string[] };
    expect(sandboxOf(b)).toMatchObject({
      enabled: true,
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true },
      filesystem: { allowWrite: ["/w/orbit", "/state/worker-runs/w1"] },
    });
  });

  test("Claude: an envelope the sandbox cannot hold says so, in the answer and the stamp", () => {
    for (const lift of ["network", "docker"] as const) {
      const t = turn("claude", { role: scout, envelope: { ...NARROW, [lift]: true } }) as { argv: string[]; partly: string; unsandboxed?: string };
      expect(sandboxOf(t)).toBeUndefined();
      expect(t.partly).toContain("NOT sandboxed");
      expect(t.partly).toContain("held only by the prefix lock");
      expect(t.partly).toContain(lift === "network" ? "writes and the network" : "writes, the network and docker");
      // The same sentence rides on the row's stamp (policystart `withSandboxNote`).
      expect(t.unsandboxed).toBe(t.partly);
    }
    // A writing role with the browser door is not a third shape: it is
    // sandboxed like any other, and its browser goes through MCP.
    const b = turn("claude", { role: builder }) as { partly: string; unsandboxed?: string };
    expect(b.partly).toContain("sandbox");
    expect(b.partly).not.toContain("NOT sandboxed");
    expect(b.unsandboxed).toBeUndefined();
  });

  test("Claude: a sandboxed writable role may write the linked worktree's git dir and objects, and no ref path, commit or not", () => {
    /* A commit in a `git worktree` writes the main repo's
       `.git/worktrees/<name>` and, for objects and the branch ref, the common
       `.git`. Outside `cwd`, so the sandbox refused it and the commit the
       envelope granted could not happen. A plain checkout keeps `.git` inside
       the worktree and needs nothing added. */
    const root = scratch();
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], {
        cwd,
        env: {
          ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "orbit", GIT_AUTHOR_EMAIL: "orbit@example.invalid",
          GIT_COMMITTER_NAME: "orbit", GIT_COMMITTER_EMAIL: "orbit@example.invalid",
        },
        stdout: "pipe", stderr: "pipe",
      });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    };
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "one");
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const custom = { ...builder, id: "arch" as never };
    const linked = sandboxOf(turn("claude", { role: custom, cwd: wt, runDir: "/state/worker-runs/w1" }) as { argv: string[] });
    // Claude Code opens the whole common .git of a linked worktree on its own,
    // so what must stay shut is in denyWrite: hooks and config (a hook runs
    // in the next unsandboxed commit), another worktree's gitdir, and,
    // without `commit`, the branch refs (`git update-ref` is not on the
    // prefix lock). Objects stay open because `git add` writes them.
    git(root, "worktree", "add", "-q", join(root, "wt-other"), "-b", "orbit-3");
    const g = (...p: string[]) => join(root, ".git", ...p);
    expect(linked!.filesystem.allowWrite).toEqual([wt, "/state/worker-runs/w1", g("worktrees", "wt-orbit"), g("objects")]);
    const denied = sandboxOf(turn("claude", { role: custom, cwd: wt, runDir: "/state/worker-runs/w1" }) as { argv: string[] })!.filesystem.denyWrite!;
    for (const p of [g("refs"), g("logs"), g("hooks"), g("config"), g("HEAD"), g("worktrees", "wt-other")]) expect(denied).toContain(p);
    for (const p of [g("objects"), g("worktrees", "wt-orbit"), g("worktrees")]) expect(denied).not.toContain(p);
    const committing = sandboxOf(turn("claude", { role: custom, cwd: wt, runDir: "/state/worker-runs/w1", envelope: { ...NARROW, commit: true } }) as { argv: string[] })!.filesystem;
    // A worker moves only its own branch, through the server (ownBranchCommit.ts):
    // no ref path is open for a committing role either.
    expect(committing.allowWrite).toEqual([wt, "/state/worker-runs/w1", g("worktrees", "wt-orbit"), g("objects")]);
    for (const p of [g("hooks"), g("refs"), g("logs"), g("packed-refs")]) expect(committing.denyWrite).toContain(p);
    const plain = sandboxOf(turn("claude", { role: custom, cwd: root, runDir: "/state/worker-runs/w1" }) as { argv: string[] });
    expect(plain!.filesystem.allowWrite).toEqual([root, "/state/worker-runs/w1"]);
    // The project's own tree needs no allow path, and its `.git` is shut where
    // git would run something on the next command (see the test below).
    expect(plain!.filesystem.denyWrite).toEqual([g("hooks"), g("config"), g("config.worktree"), g("refs"), g("logs"), g("packed-refs"), g("worktrees"), g("modules"), join(root, ".claude")]);
  });
});

describe("the git directories, read from what cwd/.git is", () => {
  const custom = { ...builder, id: "arch" as never };
  const reviewer = workerRole("reviewer")!;

  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "orbit", GIT_AUTHOR_EMAIL: "orbit@example.invalid",
        GIT_COMMITTER_NAME: "orbit", GIT_COMMITTER_EMAIL: "orbit@example.invalid",
      },
      stdout: "pipe", stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  const repo = (at?: string) => {
    const root = at ?? scratch();
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "one");
    return root;
  };
  const sandboxAt = (cwd: string, runDir: string, o: Partial<Parameters<typeof headlessTurn>[0]> = {}) =>
    sandboxOf(turn("claude", { cwd, runDir, ...o }) as { argv: string[] })!;
  /** The entries of the scratch root, so a test can say nothing appeared beside
   *  the directory the turn was given. */
  const beside = () => new Set(readdirSync(scratchRoot));

  test("a `.git` file is denied, and one whose gitdir holds no commondir allows nothing", () => {
    /* The file is inside the one tree a writing role may write, so its text is
       the worker's: `printf 'gitdir: /home/orbit\n' > .git` used to become an
       allowWrite entry with nothing denied. */
    const root = scratch();
    // Outside the tree, so nothing is made or added: a `.git` file naming a real
    // repository elsewhere used to get this app's files written into it.
    const elsewhere = join(scratch(), "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${elsewhere}\n`);
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.allowWrite).toEqual([root, "/state/worker-runs/w1"]);
    expect(box.filesystem.denyWrite).toEqual([join(root, ".git"), join(root, ".claude")]);
    expect(existsSync(join(elsewhere, "config.worktree"))).toBe(false);
    // The same for a file that does not even claim to be a gitdir.
    writeFileSync(join(root, ".git"), "not a gitdir line\n");
    expect(sandboxAt(root, "/state/worker-runs/w1", { role: custom }).filesystem.denyWrite).toEqual([join(root, ".git"), join(root, ".claude")]);
  });

  test("a commondir that is not `../..` is the worker's, not git's, and allows nothing", () => {
    /* `commondir` sits in `gitdir`, which is in allowWrite, and both the allow
       and the deny list are built from what it says. Pointed at a directory
       that does not exist the read threw, the catch swallowed it, and the deny
       list collapsed to `cwd/.git` — the hook deny the prefix lock does not
       cover. Pointed at one that does, the `refs` of that directory were
       allowed. */
    const root = repo();
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const gitdir = join(root, ".git", "worktrees", "wt-orbit");
    const commondir = join(gitdir, "commondir");
    for (const lie of [join(root, "nowhere-at-all"), join(root, "shadow")]) {
      mkdirSync(join(lie, "refs"), { recursive: true });
      writeFileSync(commondir, `${lie}\n`);
      const box = sandboxAt(wt, "/state/worker-runs/w1", { role: custom });
      expect(box.filesystem.allowWrite).toEqual([wt, "/state/worker-runs/w1"]);
      expect(box.filesystem.denyWrite).toEqual([join(wt, ".git"), commondir, join(wt, ".claude")]);
    }
    // And the honest `../..` is what git writes: it is still the file that
    // decides both lists, so it is shut as well.
    writeFileSync(commondir, "../..\n");
    const honest = sandboxAt(wt, "/state/worker-runs/w1", { role: custom });
    expect(honest.filesystem.denyWrite).toContain(commondir);
    expect(honest.filesystem.allowWrite).toContain(join(root, ".git", "objects"));
  });

  test("a role that writes the project's own tree keeps index, HEAD and objects, and shuts hooks and config", () => {
    /* `cwd/.git` a directory: the sandbox already opens it, so a hook planted
       there, or a `core.*` command in the config, runs in the person's next
       unsandboxed git command. refs and logs join them without `commit`,
       because `git update-ref` is not on the prefix lock. */
    const root = repo();
    const g = (...p: string[]) => join(root, ".git", ...p);
    mkdirSync(join(root, ".claude"), { recursive: true });
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.allowWrite).toEqual([root, "/state/worker-runs/w1"]);
    expect(box.filesystem.denyWrite).toEqual([g("hooks"), g("config"), g("config.worktree"), g("refs"), g("logs"), g("packed-refs"), g("worktrees"), g("modules"), join(root, ".claude")]);
    for (const p of [g("index"), g("HEAD"), g("objects")]) expect(box.filesystem.denyWrite).not.toContain(p);
    // A fresh repo: the turn above made a packed-refs, and a packed repo is
    // denied to every role. A role that may commit gets refs and logs open.
    const packedRoot = repo();
    const committing = sandboxAt(packedRoot, "/state/worker-runs/w1", { role: custom, envelope: { ...NARROW, commit: true } });
    const pg = (...p: string[]) => join(packedRoot, ".git", ...p);
    expect(committing.filesystem.denyWrite).toEqual([pg("hooks"), pg("config"), pg("config.worktree"), pg("worktrees"), pg("modules"), join(packedRoot, ".claude")]);
  });

  test("the per-tree config git reads is shut beside the main one", () => {
    /* `git config --worktree` writes `.git/config.worktree`, which git reads in
       a repo with `extensions.worktreeConfig`; it can name a hooks directory of
       the worker's own choosing. */
    const root = repo();
    git(root, "config", "extensions.worktreeConfig", "true");
    git(root, "config", "--worktree", "core.hooksPath", "hooks-anywhere");
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(join(root, ".git", "config.worktree"));
    // The same file in a linked worktree's own git dir, which is an allow root
    // for a turn that may commit.
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const gitdir = join(root, ".git", "worktrees", "wt-orbit");
    writeFileSync(join(gitdir, "config.worktree"), "[core]\n\thooksPath = hooks-anywhere\n");
    expect(sandboxAt(wt, "/state/worker-runs/w1", { role: custom }).filesystem.denyWrite).toContain(join(gitdir, "config.worktree"));
  });

  test("a submodule's git dirs are shut whole, so nothing under .git/modules is writable", () => {
    /* A submodule's git dir is a directory under the parent's `.git/modules`,
       inside the writable root, and git reads that dir's hooks and config, not
       the parent's. The whole directory is denied: which entry is a module and
       which a container for a name like `vendor/lib` is decided by files a turn
       writes, and a worker turn never needs to write a submodule's git dir. */
    const leaf = repo();
    const sub = repo();
    git(sub, "-c", "protocol.file.allow=always", "submodule", "add", leaf, "leaf");
    git(sub, "add", ".");
    git(sub, "commit", "-q", "-m", "with leaf");
    const root = repo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", sub, "sub");
    git(join(root, "sub"), "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(join(root, ".git", "modules"));
    // The working-tree `.git` files, which are ordinary files in the writable
    // root and decide which git dir the submodule uses.
    expect(box.filesystem.denyWrite).toContain(join(root, "sub", ".git"));
    expect(box.filesystem.denyWrite).toContain(join(root, "sub", "leaf", ".git"));
    // Nothing inside the module is named one path at a time, and the objects of
    // a submodule are inside the deny for the same reason.
    expect(box.filesystem.denyWrite).not.toContain(join(root, ".git", "modules", "sub", "hooks"));
  });

  test("a `.gitmodules` a turn deletes hides neither the module dir nor the boundary file", () => {
    /* `.gitmodules` sits in the writable root and is denied nowhere: a turn
       removes it and the tree still has the submodule. The index's gitlink is
       git's own record of that, and the modules dir is shut without naming any
       entry in it. */
    const source = repo();
    const root = repo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/lib");
    const boundary = join(root, "vendor", "lib", ".git");
    rmSync(boundary, { force: true });
    rmSync(join(root, ".gitmodules"));
    const before = beside();
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(join(root, ".git", "modules"));
    expect(existsSync(boundary)).toBe(true);
    expect(box.filesystem.denyWrite).toContain(boundary);
    expect([...beside()].filter((e) => !before.has(e))).toEqual([]);
  });

  test("a per-tree config the repo has not made yet is made empty and shut, on both layouts", () => {
    /* The switch that makes git read `config.worktree` sits in the denied
       `config`, but the file is in the writable tree: the worker creates it
       during the turn and its hooks-path key names a directory it writes. So it
       is made empty before the turn, beside hooks and packed-refs. */
    const root = repo();
    git(root, "config", "extensions.worktreeConfig", "true");
    const at = join(root, ".git", "config.worktree");
    expect(existsSync(at)).toBe(false);
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(readFileSync(at, "utf8")).toBe("");
    expect(box.filesystem.denyWrite).toContain(at);
    // The same file in a linked worktree's own git dir, which is an allow root.
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const gitdir = join(root, ".git", "worktrees", "wt-orbit");
    rmSync(join(gitdir, "config.worktree"), { force: true });
    const linked = sandboxAt(wt, "/state/worker-runs/w1", { role: custom });
    expect(readFileSync(join(gitdir, "config.worktree"), "utf8")).toBe("");
    expect(linked.filesystem.denyWrite).toContain(join(gitdir, "config.worktree"));
  });

  test("a `.git` file naming a separate git dir shuts that dir's hooks and config, not only the file", () => {
    /* `git init --separate-git-dir`: `.git` is a file, the git dir it names has
       no `commondir`, and git reads its hooks and config. Denying only the file
       left the whole git dir open inside the writable root. */
    const root = scratch();
    const gitdir = join(scratch(), "separate.git");
    git(root, "init", "-q", "-b", "main", `--separate-git-dir=${gitdir}`);
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.allowWrite).toEqual([root, "/state/worker-runs/w1"]);
    expect(box.filesystem.denyWrite).toContain(join(gitdir, "hooks"));
    expect(box.filesystem.denyWrite).toContain(join(gitdir, "config"));
  });

  test("packed-refs is shut too: `git gc` moves the branch there, and the prefix lock does not cover `git update-ref`", () => {
    const root = repo();
    const packed = join(root, ".git", "packed-refs");
    writeFileSync(packed, "# pack-refs with: peeled fully-peeled sorted\n");
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(packed);
  });

  test("a plain checkout with no packed-refs gets an empty one, so the deny is not dropped for a missing path", () => {
    /* A real turn appended a line to `<common>/.git/packed-refs`: the deny list
       drops a path that is not there, and a repo that was never packed has
       none. An empty `packed-refs` is a file git reads as no packed refs. */
    const root = repo();
    const packed = join(root, ".git", "packed-refs");
    expect(existsSync(packed)).toBe(false);
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(existsSync(packed)).toBe(true);
    expect(readFileSync(packed, "utf8")).toBe("");
    expect(box.filesystem.denyWrite).toContain(packed);
    // Nothing is written for a role that may commit: its turn leaves the repo
    // as it found it.
    const other = repo();
    sandboxAt(other, "/state/worker-runs/w1", { role: custom, envelope: { ...NARROW, commit: true } });
    expect(existsSync(join(other, ".git", "packed-refs"))).toBe(false);
  });

  test("a linked worktree with no packed-refs gets an empty one in the common .git, for every role, commit or not", () => {
    /* The common `.git` is not inside `cwd`, so the plain-checkout list does
       not reach it: a real turn appended to `<common>/.git/packed-refs` and
       nothing denied it, because the repo had never been packed. */
    const root = repo();
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const packed = join(root, ".git", "packed-refs");
    expect(existsSync(packed)).toBe(false);
    for (const role of [custom, reviewer]) {
      const box = sandboxAt(wt, "/state/worker-runs/w1", { role });
      expect(existsSync(packed)).toBe(true);
      expect(readFileSync(packed, "utf8")).toBe("");
      expect(box.filesystem.denyWrite).toContain(packed);
    }
    const commit = repo();
    const wtCommit = join(commit, "wt-orbit");
    git(commit, "worktree", "add", "-q", wtCommit, "-b", "orbit-2");
    sandboxAt(wtCommit, "/state/worker-runs/w1", { role: custom, envelope: { ...NARROW, commit: true } });
    expect(readFileSync(join(commit, ".git", "packed-refs"), "utf8")).toBe("");
  });

  test("a git directory with no hooks gets one made, so the hook deny is not dropped for being missing", () => {
    /* `git init --template` with an empty directory leaves no `hooks`, and the
       deny list was `filter(existsSync)`ed: the worker then made `.git/hooks`
       itself and wrote the hook the next unsandboxed commit runs. */
    const root = scratch();
    const template = join(root, "empty-template");
    mkdirSync(template, { recursive: true });
    git(root, "init", "-q", "-b", "main", `--template=${template}`);
    const hooks = join(root, ".git", "hooks");
    expect(existsSync(hooks)).toBe(false);
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(hooks);
    expect(existsSync(hooks)).toBe(true);
  });

  test("`.claude` is denied before the turn that would make it", () => {
    /* The deny list is computed before the turn, so a `.claude` that did not
       exist yet was not on it: turn 1 made the directory and wrote settings
       the next turn's CLI read. */
    const root = repo();
    expect(existsSync(join(root, ".claude"))).toBe(false);
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(join(root, ".claude"));
    // Made first: a deny of a path that is not there is not a bind.
    expect(existsSync(join(root, ".claude"))).toBe(true);
  });

  test("a read-only role gets the shared git metadata denied, so the CLI cannot write it either", () => {    /* Claude Code opens the whole common `.git` of a linked worktree by
       itself, whatever allowWrite says, and a read-only role never reached
       `gitWriteRoots` at all: a reviewer could plant a hook with `git
       update-ref` or by writing the file, from a role whose sandbox allows one
       folder. */
    const root = repo();
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    git(root, "worktree", "add", "-q", join(root, "wt-other"), "-b", "orbit-3");
    const g = (...p: string[]) => join(root, ".git", ...p);
    const box = sandboxAt(wt, "/state/worker-runs/w1", { role: reviewer });
    expect(box.filesystem.allowWrite).toEqual(["/state/worker-runs/w1"]);
    for (const p of [wt, join(wt, ".git"), g("hooks"), g("config"), g("refs"), g("logs"), g("worktrees", "wt-other")]) {
      expect(box.filesystem.denyWrite).toContain(p);
    }
    expect(box.filesystem.denyWrite).not.toContain(g("worktrees", "wt-orbit"));
  });

  test("a read-only turn makes nothing in the checkout: the whole tree is already denied", () => {
    /* `hooks`, `worktrees`, `config.worktree` and `packed-refs` were made for
       every sandboxed turn, a reviewer's included: a turn that may write nothing
       still edited the tree, and a directory it touched became a nested
       repository for the next `git add`. What they give is a path for the deny
       to bind, and a read-only turn's deny is the whole tree. */
    const root = repo();
    const made = ["hooks", "worktrees", "config.worktree", "packed-refs", "modules"].map((p) => join(root, ".git", p));
    for (const p of made) rmSync(p, { recursive: true, force: true });
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: reviewer });
    expect(box.filesystem.allowWrite).toEqual(["/state/worker-runs/w1"]);
    for (const p of made) expect(existsSync(p)).toBe(false);
    // A turn that may write still gets them, so its own deny has paths to bind.
    const writes = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    for (const p of made) {
      expect(existsSync(p)).toBe(true);
      expect(writes.filesystem.denyWrite).toContain(p);
    }
  });

  test("the turn tells the browser door which two roots a write may land in", () => {
    /* The MCP server runs outside the shell, so its `record`, `download` and
       `trace` write with the app's own permissions: headless.ts hands it what
       the sandbox computed for this turn, joined with the runtime separator. */
    const t = turn("claude", { role: builder, cwd: "/w/orbit", runDir: "/state/worker-runs/w1" }) as { env: Record<string, string> };
    expect(t.env.AGX_TURN_WRITE_ROOTS).toBe(["/w/orbit", "/state/worker-runs/w1"].join(delimiter));
    /* A read-only role's sandbox allows the run folder and denies the tree, so
       the door gets that one: the work tree was handed over anyway, inert only
       while no path-taking read tool existed. */
    const r = turn("claude", { role: reviewer, cwd: "/w/orbit", runDir: "/state/worker-runs/w1" }) as { env: Record<string, string> };
    expect(r.env.AGX_TURN_WRITE_ROOTS).toBe("/state/worker-runs/w1");
  });

  test("the door's roots are the work tree and the run folder, never the git dirs the sandbox may write", () => {
    /* The list used to be the sandbox's own `allowWrite`, and a linked
       worktree's carries `<main>/.git/worktrees/<n>` and `<main>/.git/objects`.
       `<gitdir>/commondir` decides the next turn's allow and deny lists, so a
       trace written there reopened what the commondir check closes. */
    const root = repo();
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const runDir = join(scratch(), "worker-runs", "w1");
    const t = turn("claude", { role: custom, cwd: wt, runDir }) as { env: Record<string, string>; argv: string[] };
    expect(t.env.AGX_TURN_WRITE_ROOTS).toBe([wt, runDir].join(delimiter));
    // What the sandbox itself gets is unchanged: a commit still writes objects.
    expect(sandboxOf(t)!.filesystem.allowWrite).toContain(join(root, ".git", "objects"));
    // A role that writes nothing gets its run folder alone, as its sandbox does.
    const r = turn("claude", { role: reviewer, cwd: wt, runDir }) as { env: Record<string, string> };
    expect(r.env.AGX_TURN_WRITE_ROOTS).toBe(runDir);
  });

  test("a `.git` file that names another worktree's gitdir is not an extra allow root", () => {
    /* The text of `.git` is the worker's. A real linked worktree elsewhere has
       a `commondir` reading `../..`, so every check passed and that repo's
       gitdir became an allow root: this turn could write its HEAD, its index
       and its `commondir`, from a worktree it was not given. */
    const mine = repo();
    const wt = join(mine, "wt-orbit");
    git(mine, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const other = repo();
    git(other, "worktree", "add", "-q", join(other, "wt-other"), "-b", "orbit-3");
    const otherGitdir = join(other, ".git", "worktrees", "wt-other");
    writeFileSync(join(wt, ".git"), `gitdir: ${otherGitdir}\n`);
    const box = sandboxAt(wt, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.allowWrite).toEqual([wt, "/state/worker-runs/w1"]);
    expect(box.filesystem.denyWrite).toContain(otherGitdir);
    // git's own layout passes: its gitdir says which worktree it belongs to.
    writeFileSync(join(wt, ".git"), `gitdir: ${join(mine, ".git", "worktrees", "wt-orbit")}\n`);
    expect(sandboxAt(wt, "/state/worker-runs/w1", { role: custom }).filesystem.allowWrite)
      .toContain(join(mine, ".git", "worktrees", "wt-orbit"));
  });

  test("a linked git dir with no back-pointer, or a relative one, is closed rather than opened", () => {
    /* `gitdir` in the worktree's git dir is what proves it belongs to this
       worktree; missing or unreadable it was skipped, and a forged `.git` file
       naming another worktree's git dir became an allow root. git writes an
       absolute path there, so a bare `.git` is the worker's own text. */
    const root = repo();
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const gitdir = join(root, ".git", "worktrees", "wt-orbit");
    const back = join(gitdir, "gitdir");
    rmSync(back);
    const gone = sandboxAt(wt, "/state/worker-runs/w1", { role: custom });
    expect(gone.filesystem.allowWrite).toEqual([wt, "/state/worker-runs/w1"]);
    expect(gone.filesystem.denyWrite).toContain(gitdir);
    writeFileSync(back, ".git\n");
    const relative = sandboxAt(wt, "/state/worker-runs/w1", { role: custom });
    expect(relative.filesystem.allowWrite).toEqual([wt, "/state/worker-runs/w1"]);
    expect(relative.filesystem.denyWrite).toContain(gitdir);
  });

  test("a submodule's checkout path comes from .gitmodules, not from its module dir's name", () => {
    /* A submodule can be registered under one name and checked out at another
       (`--name orbit-lib` at `vendor/lib`). Git keeps the module dir under
       `.git/modules/orbit-lib` and the boundary file at `vendor/lib/.git`, so
       deriving the checkout from the dir's name denied a file that was not
       there and left the one git reads in the writable root open. */
    const source = repo();
    const root = repo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--name", "orbit-lib", source, "vendor/lib");
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(join(root, "vendor", "lib", ".git"));
    expect(box.filesystem.denyWrite).toContain(join(root, ".git", "modules"));
    // The name is not where the checkout is, and nothing is denied under it.
    expect(box.filesystem.denyWrite).not.toContain(join(root, "orbit-lib", ".git"));
  });

  test("the per-tree config is made inside the tree only, and a module dir is shut whole", () => {
    /* `config.worktree` is read when the repo opts into `extensions.worktreeConfig`,
       and that switch sits in the denied `config`: the file is the worker's to
       create, so it is made empty first in a separate git dir inside the tree. A
       module dir is not one git dir named entry by entry any more: `.git/modules`
       is denied whole, so no `config.worktree` is made inside it. */
    const root = scratch();
    const store = join(root, "store");
    git(root, "init", "-q", "-b", "main", `--separate-git-dir=${store}`);
    git(root, "config", "extensions.worktreeConfig", "true");
    const storeConfig = join(store, "config.worktree");
    rmSync(storeConfig, { force: true });
    expect(existsSync(storeConfig)).toBe(false);
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(readFileSync(storeConfig, "utf8")).toBe("");
    expect(box.filesystem.denyWrite).toContain(storeConfig);

    const source = repo();
    const parent = repo();
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", source, "orbit-lib");
    const moduleConfig = join(parent, ".git", "modules", "orbit-lib", "config.worktree");
    rmSync(moduleConfig, { force: true });
    const subBox = sandboxAt(parent, "/state/worker-runs/w1", { role: custom });
    expect(existsSync(moduleConfig)).toBe(false);
    expect(subBox.filesystem.denyWrite).toContain(join(parent, ".git", "modules"));
  });

  test("a plain checkout shuts the worktrees entry, so a sibling worktree's per-tree config is not writable", () => {
    /* The linked-worktree branch denies every sibling worktree entry wholesale.
       The plain checkout denied only its fixed shut list, so the per-tree
       config inside `wt-orbit` — read by git in a tree the worker is not
       sandboxed in — stayed open. The dir is made first when it is missing: a
       deny of a path that is not there binds nothing. */
    const root = repo();
    const wt = join(root, "wt-orbit");
    git(root, "worktree", "add", "-q", wt, "-b", "orbit-2");
    const worktrees = join(root, ".git", "worktrees");
    writeFileSync(join(worktrees, "wt-orbit", "config.worktree"), "[core]\n\thooksPath = hooks-anywhere\n");
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(worktrees);

    const bare = repo();
    const made = join(bare, ".git", "worktrees");
    expect(existsSync(made)).toBe(false);
    const bareBox = sandboxAt(bare, "/state/worker-runs/w1", { role: custom });
    expect(existsSync(made)).toBe(true);
    expect(bareBox.filesystem.denyWrite).toContain(made);
  });

  test("an uninitialised submodule's boundary file is named and written before the worker can make it", () => {
    /* A module dir with a checkout whose `.git` file is not there: the deny
       list filtered on `existsSync`, so nothing was named and the worker wrote
       a `gitdir:` line pointing at a git dir it made. The file git itself
       writes is made first, so the deny has something to bind. */
    const source = repo();
    const root = repo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/lib");
    const boundary = join(root, "vendor", "lib", ".git");
    rmSync(boundary, { force: true });
    expect(existsSync(boundary)).toBe(false);
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(existsSync(boundary)).toBe(true);
    expect(readFileSync(boundary, "utf8")).toBe(`gitdir: ${join("..", "..", ".git", "modules", "vendor", "lib")}\n`);
    expect(box.filesystem.denyWrite).toContain(boundary);
  });

  test("a .gitmodules path that leaves the checkout is refused, and the module's name is used instead", () => {
    /* `.gitmodules` sits in the tree the worker writes, so a turn can set
       `path = ../outside` and have the next turn plant a git dir beside the
       project. `path = .` and an empty one resolve to `cwd/.git`, which denies
       the whole metadata dir. Only a path inside the checkout is used. */
    const parent = scratch();
    const root = join(parent, "repo");
    repo(root);
    mkdirSync(join(root, ".git", "modules", "orbit-lib", "hooks"), { recursive: true });
    mkdirSync(join(root, "orbit-lib"), { recursive: true });
    writeFileSync(join(root, "orbit-lib", ".git"), "gitdir: ../../.git/modules/orbit-lib\n");
    const before = beside();
    for (const declared of ["../outside", "..", ".", "/etc", ""]) {
      writeFileSync(join(root, ".gitmodules"), `[submodule "orbit-lib"]\n\tpath = ${declared}\n`);
      const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
      // Nothing is written outside the checkout the turn was given.
      expect(existsSync(join(parent, "outside"))).toBe(false);
      expect(existsSync(join(parent, ".git"))).toBe(false);
      expect(box.filesystem.denyWrite).not.toContain(join(root, ".git"));
      // The module's name is the fallback, so the boundary file the worker
      // could plant in the checkout it does have is still shut.
      expect(box.filesystem.denyWrite).toContain(join(root, "orbit-lib", ".git"));
      expect(box.filesystem.denyWrite).toContain(join(root, ".git", "modules"));
    }
    // A declared path through a link inside the tree is not a path outside it.
    const target = join(parent, "target");
    mkdirSync(join(target, "lib"), { recursive: true });
    symlinkSync(target, join(root, "vendor"));
    writeFileSync(join(root, ".gitmodules"), '[submodule "orbit-lib"]\n\tpath = vendor/lib\n');
    sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(existsSync(join(target, "lib", ".git"))).toBe(false);
    expect([...beside()].filter((e) => !before.has(e))).toEqual([]);
  });

  test("a declared path is added to the name-derived one, and a decoy on its own plants nothing", () => {
    /* Git accepts a comment after the header and a quoted value, and keeps the
       module dir under the name. An entry the parser misses, or a decoy path,
       must not leave the real boundary file out of the deny. The other way
       round, a `path =` line alone is the worker's text: the index pins no
       gitlink there, so no boundary file is planted in it. */
    const named = repo();
    git(named, "-c", "protocol.file.allow=always", "submodule", "add", "--name", "orbit-lib", repo(), "vendor/lib");
    mkdirSync(join(named, "orbit-lib"), { recursive: true });
    writeFileSync(join(named, "orbit-lib", ".git"), "gitdir: ../../.git/modules/orbit-lib\n");
    writeFileSync(join(named, ".gitmodules"), '[submodule "orbit-lib"] # the vendored tree\n\tpath = "vendor/lib"\n');
    const box = sandboxAt(named, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(join(named, "vendor", "lib", ".git"));
    expect(box.filesystem.denyWrite).toContain(join(named, "orbit-lib", ".git"));

    const decoy = repo();
    git(decoy, "-c", "protocol.file.allow=always", "submodule", "add", repo(), "vendor/lib");
    mkdirSync(join(decoy, "docs"), { recursive: true });
    writeFileSync(join(decoy, ".gitmodules"), '[submodule "vendor/lib"]\n\tpath = docs\n');

    // Git reads a section and a key without regard to case.
    const upper = repo();
    git(upper, "-c", "protocol.file.allow=always", "submodule", "add", "--name", "orbit-lib", repo(), "vendor/lib");
    writeFileSync(join(upper, ".gitmodules"), '[Submodule "orbit-lib"]\n\tPath = vendor/lib\n');

    // A name git quotes because it holds one is read the way git reads it, so a
    // declared path that leaves the tree still falls back to the name.
    const quoted = repo();
    mkdirSync(join(quoted, 'a"b'), { recursive: true });
    writeFileSync(join(quoted, 'a"b', ".git"), "gitdir: ../../.git/modules/none\n");
    writeFileSync(join(quoted, ".gitmodules"), '[submodule "a\\"b"]\n\tpath = ../outside\n');

    const before = beside();
    const other = sandboxAt(decoy, "/state/worker-runs/w1", { role: custom });
    expect(other.filesystem.denyWrite).toContain(join(decoy, "vendor", "lib", ".git"));
    expect(other.filesystem.denyWrite).not.toContain(join(decoy, "docs", ".git"));
    expect(existsSync(join(decoy, "docs", ".git"))).toBe(false);
    const upperBox = sandboxAt(upper, "/state/worker-runs/w1", { role: custom });
    expect(upperBox.filesystem.denyWrite).toContain(join(upper, "vendor", "lib", ".git"));
    expect(sandboxAt(quoted, "/state/worker-runs/w1", { role: custom }).filesystem.denyWrite).toContain(join(quoted, 'a"b', ".git"));
    expect([...beside()].filter((e) => !before.has(e))).toEqual([]);
  });

  test("a decoy config in a container changes nothing: the modules dir is shut whole", () => {
    /* `.git/modules/vendor` is a container for the module `vendor/lib`, and a
       turn can write a `config` in it. The walk then took the container for a
       git dir — or, with `.gitmodules` gone, for nothing — and the module's own
       hooks and config dropped out of the deny. No entry is read now. */
    const root = repo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", repo(), "vendor/lib");
    writeFileSync(join(root, ".git", "modules", "vendor", "config"), "[core]\n\thooksPath = hooks-anywhere\n");
    const before = beside();
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).toContain(join(root, ".git", "modules"));
    expect(box.filesystem.denyWrite).toContain(join(root, "vendor", "lib", ".git"));
    // The container is not a module: no boundary file is planted at its name.
    expect(existsSync(join(root, "vendor", ".git"))).toBe(false);
    expect(box.filesystem.denyWrite).not.toContain(join(root, "vendor", ".git"));
    expect([...beside()].filter((e) => !before.has(e))).toEqual([]);
  });

  test("a modules dir that is a link refuses the turn, and nothing is made behind it", () => {
    /* The modules dir is inside the writable root: a turn replaces it with a
       link, and a deny names the link while the target's hooks and config stay
       open. A deny on a link does not hold, so the turn is refused the way a
       linked `.git` is — for a link to anywhere, not only to outside. */
    const root = repo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", repo(), "vendor/lib");
    const outside = join(scratch(), "outside");
    mkdirSync(join(outside, "orb", "hooks"), { recursive: true });
    writeFileSync(join(outside, "orb", "config"), "[core]\n");
    rmSync(join(root, ".git", "modules"), { recursive: true, force: true });
    symlinkSync(outside, join(root, ".git", "modules"));
    const before = beside();
    const away = turn("claude", { role: custom, cwd: root, runDir: "/state/worker-runs/w1" });
    expect(away.ok).toBe(false);
    expect(!away.ok && away.error).toContain(join(root, ".git", "modules"));
    expect(existsSync(join(outside, "orb", "config.worktree"))).toBe(false);
    expect([...beside()].filter((e) => !before.has(e))).toEqual([]);

    // A link that points inside the tree is the case the walk got wrong: it
    // took the target for the metadata dir and denied nothing under it.
    const inner = join(root, "orb");
    mkdirSync(join(inner, "hooks"), { recursive: true });
    rmSync(join(root, ".git", "modules"), { force: true });
    symlinkSync(inner, join(root, ".git", "modules"));
    const here = turn("claude", { role: custom, cwd: root, runDir: "/state/worker-runs/w1" });
    expect(here.ok).toBe(false);
    expect(!here.ok && here.error).toContain(join(root, ".git", "modules"));
  });

  test("a module dir with no submodule left in the tree does not get a boundary file", () => {
    /* A submodule removed from the project leaves its module dir behind, and an
       ordinary directory can sit at the name. A boundary file written there
       made the person's next `git add` record a nested repository instead of
       the files. */
    const root = repo();
    mkdirSync(join(root, ".git", "modules", "orbit-lib", "hooks"), { recursive: true });
    mkdirSync(join(root, "orbit-lib"), { recursive: true });
    writeFileSync(join(root, "orbit-lib", "source.ts"), "export const orbit = 1;\n");
    git(root, "add", ".");
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(existsSync(join(root, "orbit-lib", ".git"))).toBe(false);
    expect(box.filesystem.denyWrite).not.toContain(join(root, "orbit-lib", ".git"));
    // The module dir itself is still shut: git reads its hooks there.
    expect(box.filesystem.denyWrite).toContain(join(root, ".git", "modules"));

    // A gitlink with no `.gitmodules` entry is still a submodule of this tree:
    // the index is what says so, so the file git would write is made first.
    const pinned = repo();
    mkdirSync(join(pinned, ".git", "modules", "orbit-lib", "hooks"), { recursive: true });
    mkdirSync(join(pinned, "orbit-lib"), { recursive: true });
    git(pinned, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},orbit-lib`);
    const before = beside();
    const pinnedBox = sandboxAt(pinned, "/state/worker-runs/w1", { role: custom });
    expect(existsSync(join(pinned, "orbit-lib", ".git"))).toBe(true);
    expect(pinnedBox.filesystem.denyWrite).toContain(join(pinned, "orbit-lib", ".git"));
    expect([...beside()].filter((e) => !before.has(e))).toEqual([]);
  });

  test("a read-only turn does not write a boundary file into the checkout", () => {
    /* The deny list is built for every sandboxed turn, and the boundary file was
       written there too: a reviewer turn edited a tree it may not write, and a
       directory it touched became a nested repository for the next `git add`. */
    const root = repo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", repo(), "vendor/lib");
    const boundary = join(root, "vendor", "lib", ".git");
    rmSync(boundary, { force: true });
    const before = beside();
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: reviewer });
    expect(box.filesystem.allowWrite).toEqual(["/state/worker-runs/w1"]);
    expect(existsSync(boundary)).toBe(false);
    // A file the worker already planted is still shut.
    writeFileSync(boundary, "gitdir: ../../.git/modules/vendor/lib\n");
    expect(sandboxAt(root, "/state/worker-runs/w1", { role: reviewer }).filesystem.denyWrite).toContain(boundary);
    expect([...beside()].filter((e) => !before.has(e))).toEqual([]);
  });

  test("a per-tree config is not made in the repository a `.git` file names outside the tree", () => {
    /* `.git` is the worker's text, and the directory it names is the turn's
       choice: `gitdir: <elsewhere>` over a directory holding `HEAD` and
       `objects` made this app create `config.worktree` inside a real repository
       elsewhere, which the worker then writes. Only a directory inside the tree
       gets one, and the text is the only thing that says so. */
    const root = scratch();
    const other = join(scratch(), "other");
    mkdirSync(join(other, "modules", "orb", "hooks"), { recursive: true });
    for (const p of ["HEAD", "objects"]) writeFileSync(join(other, p), "");
    writeFileSync(join(root, ".git"), `gitdir: ${other}\n`);
    const before = beside();
    const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
    expect(box.filesystem.denyWrite).not.toContain(join(other, "config.worktree"));
    expect(existsSync(join(other, "config.worktree"))).toBe(false);
    expect(existsSync(join(other, "modules", "orb", "config.worktree"))).toBe(false);
    // The modules dir that is there is shut whole, one level down included.
    expect(box.filesystem.denyWrite).toContain(join(other, "modules"));
    expect([...beside()].filter((e) => !before.has(e))).toEqual([]);
  });

  test("a boundary file the write did not make is not denied: a bind of a missing path fails the sandbox", () => {
    /* A submodule checkout on a read-only mount: the `wx` write throws, the file
       is absent, and the deny named it anyway. */
    const root = repo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", repo(), "vendor/lib");
    const boundary = join(root, "vendor", "lib", ".git");
    rmSync(boundary, { force: true });
    chmodSync(join(root, "vendor", "lib"), 0o555);
    try {
      const box = sandboxAt(root, "/state/worker-runs/w1", { role: custom });
      expect(existsSync(boundary)).toBe(false);
      expect(box.filesystem.denyWrite).not.toContain(boundary);
    } finally {
      chmodSync(join(root, "vendor", "lib"), 0o755);
    }
  });

  test("a `.git` that is a link refuses the turn by name, and nothing is written through it", () => {
    /* Turn 1 may replace `.git` with a link (`mv .git .git.bak`, `ln -s`),
       because `.git` itself is not in the deny list — only its `hooks`,
       `packed-refs`. `ownGitRoots` then made `hooks` and `packed-refs` inside
       the place the link pointed at, which the deny could not hold because it
       named the link. */
    const root = repo();
    const victim = join(scratch(), "elsewhere");
    mkdirSync(join(victim, "proj"), { recursive: true });
    renameSync(join(root, ".git"), join(root, ".git.real"));
    symlinkSync(join(victim, "proj"), join(root, ".git"));
    const t = turn("claude", { role: custom, cwd: root, runDir: "/state/worker-runs/w1" });
    expect(t.ok).toBe(false);
    expect(!t.ok && t.error).toContain(join(root, ".git"));
    expect(readdirSync(join(victim, "proj"))).toEqual([]);
  });

  test("a `.claude` that is a link refuses the turn by name, so no settings are written through it", () => {
    const root = repo();
    const victim = join(scratch(), "settings");
    mkdirSync(victim, { recursive: true });
    symlinkSync(victim, join(root, ".claude"));
    const t = turn("claude", { role: custom, cwd: root, runDir: "/state/worker-runs/w1" });
    expect(t.ok).toBe(false);
    expect(!t.ok && t.error).toContain(join(root, ".claude"));
  });
});

describe("docker, the third lift, from a start to the lock the engine reads", () => {
  const started = (allow: string[]) => {
    const plan = planWorker({ role: "builder", allow }, view({ ...base(CLAUDE), ceiling: { ...WIDE } }), none, FLEET, null);
    if (!plan.ok) throw new Error(plan.error);
    const t = turn("opencode", { model: "opencode/big-pickle", envelope: plan.envelope });
    if (!t.ok) throw new Error(t.error);
    return (JSON.parse(t.env.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: Record<string, string> } }).permission.bash;
  };

  test("allowed: no docker deny in the rendered bash map, and the absolutes stay denied", () => {
    const bash = started(["docker"]);
    expect(bash.docker).toBeUndefined();
    expect(bash["docker *"]).toBeUndefined();
    expect(bash["* docker *"]).toBeUndefined();
    expect(bash["sudo"]).toBe("deny");
    for (const c of ["gh", "ssh", "rm"]) expect(bash[c]).toBe("deny");
  });

  test("not allowed: docker is denied bare, with arguments, and wrapped", () => {
    const bash = started([]);
    expect(bash.docker).toBe("deny");
    expect(bash["docker *"]).toBe("deny");
    expect(bash["* docker *"]).toBe("deny");
  });

  test("a start that asks for one of the absolutes is refused, ceiling or no ceiling", () => {
    for (const a of ["sudo", "gh", "sudo", "rm"]) {
      const r = planWorker({ role: "builder", allow: [a] }, view({ ...base(CLAUDE), ceiling: { ...WIDE } }), none, FLEET, null);
      expect(!r.ok && r.error).toContain("never granted to a worker");
    }
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
