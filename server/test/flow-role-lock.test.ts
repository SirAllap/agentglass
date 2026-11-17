/*
 * A saved flow role's "reads only" and "tools" narrow a worker's lock at start,
 * and its "allow" grants that role's workers a command the floor refuses — the
 * only widening a flow has, bounded by the project's ceiling and never over a
 * never-liftable one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-role-lock-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "lock.db");

const { roleLockFor } = await import("../src/rolePrompt.ts");
const { allowedToolsFor } = await import("../src/agents/headless.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { readPolicy, writePolicy } = await import("../src/orchestration.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { compileEnvelope, narrowEnvelope, toolsDeniedFor, ALWAYS_ALLOWED, withBrowserCliNote } = await import("../src/agents/envelope.ts");
const { mcpConfigFor } = await import("../src/agents/headless.ts");
const { DEFAULT_WORKER_ENVELOPE } = await import("../../shared/orchestration.ts");
const { workerRole } = await import("../../shared/workerRoles.ts");
const ops = await import("../src/agentops.ts");
const FlightPlan = await import("../src/flightPlan.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const WRITES = ["Edit", "Write", "NotebookEdit"];
const save = (root: string, role: string, patch: { readsOnly?: boolean; tools?: string[]; allow?: string[]; mayStartSubagents?: boolean }) => {
  const f = templateFlow();
  f.roster = f.roster.map((r) => (r.policyRole === role ? { ...r, ...patch } : r));
  expect(writeStoredFlow(root, f).ok).toBe(true);
};
const claudeDeny = (role: string, lock: ReturnType<typeof roleLockFor>, dirOut = dir) => {
  const r = workerRole(role)!;
  const c = compileEnvelope("claude", r, narrowEnvelope(DEFAULT_WORKER_ENVELOPE, lock), "sonnet", dirOut);
  if (!c.ok) throw new Error(c.error);
  return (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
};

describe("roleLockFor", () => {
  test("no saved flow: null", () => expect(roleLockFor("/home/a/orbit-none", "builder")).toBeNull());
  test("not a built-in role: null", () => {
    save("/home/a/orbit-x", "builder", { readsOnly: true });
    expect(roleLockFor("/home/a/orbit-x", "custom")).toBeNull();
  });
  test("saved flow: the role's readsOnly and tools", () => {
    save("/home/a/orbit-y", "verifier", { tools: ["read"] });
    expect(roleLockFor("/home/a/orbit-y", "verifier")).toEqual({ readsOnly: true, tools: ["read"], allow: [], mayStartSubagents: false });
  });
});

const SANDBOXED = { ...DEFAULT_WORKER_ENVELOPE, network: false, docker: false };
const NARROW = (patch: Record<string, boolean>) => ({ ...DEFAULT_WORKER_ENVELOPE, ...patch });
const narrowCeiling = (root: string, patch: Record<string, boolean>) => {
  const p = readPolicy(root).policy;
  expect(writePolicy(root, { ...p, ceiling: { ...p.ceiling, ...patch }, workerDefault: { ...p.workerDefault, ...patch } }).ok).toBe(true);
};

describe("allow", () => {
  test("a grant the ceiling does not lift stays off the lock: docker under a ceiling that closed it", () => {
    save("/home/a/orbit-allow", "builder", { allow: ["docker"] });
    narrowCeiling("/home/a/orbit-allow", { docker: false });
    const lock = roleLockFor("/home/a/orbit-allow", "builder")!;
    expect(lock.allow).toEqual([]);
    const c = compileEnvelope("claude", { ...workerRole("builder")!, allow: lock.allow }, narrowEnvelope(NARROW({ docker: false }), lock), "sonnet", dir);
    if (!c.ok) throw new Error(c.error);
    const deny = (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain("Bash(docker:*)");
    expect(deny).toContain("Bash(sudo:*)");
    // What the answer says and what the lock does are the same thing.
    expect(narrowEnvelope(NARROW({ docker: false }), lock).docker).toBe(false);
  });
  test("only what a ceiling flag lifts is granted: a merge has no field to lift it", () => {
    save("/home/a/orbit-allow-merge", "builder", { allow: ["git commit", "git merge", "curl", "aws"] });
    narrowCeiling("/home/a/orbit-allow-merge", { network: false });
    // Commit is on; the network is closed by the ceiling, and no ceiling flag names a merge.
    expect(roleLockFor("/home/a/orbit-allow-merge", "builder")!.allow).toEqual(["git commit"]);
  });
  test("a ceiling that lifts docker does not let the grant outrun the worker's envelope", () => {
    const root = "/home/a/orbit-allow-docker";
    save(root, "builder", { allow: ["docker"] });
    narrowCeiling(root, { docker: true });
    const lock = roleLockFor(root, "builder")!;
    // The ceiling still permits the grant…
    expect(lock.allow).toEqual(["docker"]);
    // …but the worker's own envelope is the bound: no docker lift, docker stays denied.
    const held = compileEnvelope("claude", { ...workerRole("builder")!, allow: lock.allow }, narrowEnvelope(NARROW({ docker: false }), lock), "sonnet", dir);
    if (!held.ok) throw new Error(held.error);
    expect((JSON.parse(held.args[1]!) as { permissions: { deny: string[] } }).permissions.deny).toContain("Bash(docker:*)");
    // Asked for, the same grant and the same lock agree.
    const asked = compileEnvelope("claude", { ...workerRole("builder")!, allow: lock.allow }, NARROW({ docker: true }), "sonnet", dir);
    if (!asked.ok) throw new Error(asked.error);
    expect((JSON.parse(asked.args[1]!) as { permissions: { deny: string[] } }).permissions.deny).not.toContain("Bash(docker:*)");
  });
  test("every other role keeps the lock", () => {
    save("/home/a/orbit-allow2", "builder", { allow: ["docker"] });
    const theirs = compileEnvelope("claude", workerRole("reviewer")!, narrowEnvelope(NARROW({ docker: false }), roleLockFor("/home/a/orbit-allow2", "reviewer")), "sonnet", dir);
    if (!theirs.ok) throw new Error(theirs.error);
    expect((JSON.parse(theirs.args[1]!) as { permissions: { deny: string[] } }).permissions.deny).toContain("Bash(docker:*)");
  });
});

describe("readsOnly", () => {
  test("a builder set to reads only loses every write tool (red without the change)", () => {
    expect(claudeDeny("builder", null)).not.toContain("Edit");
    save("/home/a/orbit-b", "builder", { readsOnly: true });
    const deny = claudeDeny("builder", roleLockFor("/home/a/orbit-b", "builder"));
    for (const w of ["Edit", "Write", "NotebookEdit"]) expect(deny).toContain(w);
  });
  test("a scout with readsOnly true is narrowed to write none", () => {
    const e = narrowEnvelope(DEFAULT_WORKER_ENVELOPE, { readsOnly: true, tools: [] });
    expect(e.write).toBe("none");
  });
  test("readsOnly false on the reviewer keeps the built-in lock (narrowing only)", () => {
    save("/home/a/orbit-r", "reviewer", { readsOnly: false });
    const deny = claudeDeny("reviewer", roleLockFor("/home/a/orbit-r", "reviewer"));
    for (const w of ["Edit", "Write", "NotebookEdit"]) expect(deny).toContain(w);
  });
});

describe("tools", () => {
  test("a list denies the tools outside it, never the reporting ones", () => {
    const denied = toolsDeniedFor(["read"]);
    for (const w of [...WRITES, "WebFetch", "Task"]) expect(denied).toContain(w);
    for (const k of ALWAYS_ALLOWED) expect(denied).not.toContain(k);
    expect(denied).not.toContain("Grep");
  });
  test("a verifier's list is rendered into the Claude lock", () => {
    save("/home/a/orbit-v", "verifier", { tools: ["read"] });
    const deny = claudeDeny("verifier", roleLockFor("/home/a/orbit-v", "verifier"));
    for (const w of WRITES) expect(deny).toContain(w);
  });
  test("an empty list adds no denial", () => {
    expect(toolsDeniedFor([])).toEqual([]);
    expect(narrowEnvelope(DEFAULT_WORKER_ENVELOPE, { readsOnly: false, tools: [] })).toEqual(DEFAULT_WORKER_ENVELOPE);
  });
  test("run keeps the shell, write keeps the edit tools", () => {
    expect(toolsDeniedFor(["write"])).not.toContain("Edit");
    expect(toolsDeniedFor(["write"])).not.toContain("MultiEdit");
  });
});

describe("no lock: byte for byte", () => {
  test("envelope and compiled lock equal the old ones", () => {
    expect(narrowEnvelope(DEFAULT_WORKER_ENVELOPE, null)).toBe(DEFAULT_WORKER_ENVELOPE);
    const a = compileEnvelope("claude", workerRole("builder")!, DEFAULT_WORKER_ENVELOPE, "sonnet", dir);
    const b = compileEnvelope("claude", workerRole("builder")!, narrowEnvelope(DEFAULT_WORKER_ENVELOPE, null), "sonnet", dir);
    expect(b).toEqual(a);
  });
  test("a saved flow with empty tools and readsOnly false changes nothing", () => {
    save("/home/a/orbit-e", "builder", { readsOnly: false, tools: [] });
    const lock = roleLockFor("/home/a/orbit-e", "builder");
    expect(narrowEnvelope(DEFAULT_WORKER_ENVELOPE, lock)).toEqual(DEFAULT_WORKER_ENVELOPE);
  });
  test("plain roleStart is unchanged by a null lock", () => {
    const roles = (ops as any).workerRoles?.() ;
    const a = ops.roleStart("builder", roles, dir);
    const b = ops.roleStart("builder", roles, dir, null);
    expect(b).toEqual(a);
  });
});

describe("plain roleStart (no stored policy) carries the browser door too", () => {
  // Before the fix this path never called mcpConfigFor at all: a plain
  // `agentglass-agent start --role builder` (no orchestration policy stored)
  // got no --mcp-config, so a builder had zero mcp__agentglass-browser__*
  // tools despite DOORS_FOR_ROLE giving it that door — the CLI's own deny
  // list never named it either, so the worker was simply never told the
  // server existed.
  test("builder: --mcp-config loads agentglass-browser, without --strict-mcp-config", () => {
    const r = ops.roleStart("builder");
    if (!r.ok) throw new Error(r.error);
    if (r.kind !== "claude") throw new Error("expected claude");
    expect(r.args).not.toContain("--strict-mcp-config");
    const at = r.args.indexOf("--mcp-config");
    expect(at).toBeGreaterThan(-1);
    expect(JSON.parse(r.args[at + 1]!).mcpServers["agentglass-browser"]).toEqual({ command: "agentglass-browser-mcp" });
  });
  test("scout: no door, no --mcp-config at all", () => {
    const r = ops.roleStart("scout");
    if (!r.ok) throw new Error(r.error);
    expect(r.args).not.toContain("--mcp-config");
  });
  test("a custom flow role's base carries the door here too", () => {
    const lock = { readsOnly: false, tools: [], allow: [] };
    const r = ops.roleStart("builder", undefined, dir, lock);
    if (!r.ok) throw new Error(r.error);
    expect(r.args).toContain("--mcp-config");
  });
});

describe("the other start paths", () => {
  test("plain start: roleStart's grant is bounded by the envelope it compiles under", () => {
    const roles = { builder: { provider: "claude", model: "sonnet" }, scout: "claude", reviewer: "claude", verifier: "claude" } as any;
    const r = ops.roleStart("builder", roles, dir, { readsOnly: false, tools: [], allow: ["docker"] });
    if (!r.ok) throw new Error(r.error);
    const deny = (JSON.parse(r.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    // The default envelope keeps docker off (it would drop the sandbox), and a grant cannot take it back.
    expect(deny).toContain("Bash(docker:*)");
    expect(deny).not.toContain("Bash(git push:*)");
    expect(deny).toContain("Bash(sudo:*)");
  });
  test("plain start: roleStart with a read-only lock denies the writes", () => {
    const r = ops.roleStart("builder", undefined, dir, { readsOnly: true, tools: [] });
    if (!r.ok) throw new Error(r.error);
    const txt = r.args.join(" ") + (r.env.CLAUDE_SETTINGS ?? "");
    if (r.kind === "claude") for (const w of ["Edit", "Write", "NotebookEdit"]) expect(txt).toContain(w);
  });
  test("builder launch: BUILDER_DENY stays the base, the flow lock is appended", () => {
    expect(FlightPlan.builderDenyFor("/home/a/orbit-none")).toBe(FlightPlan.BUILDER_DENY);
    save("/home/a/orbit-l", "builder", { readsOnly: true });
    const d = FlightPlan.builderDenyFor("/home/a/orbit-l");
    for (const x of FlightPlan.BUILDER_DENY) expect(d).toContain(x);
    for (const w of WRITES) expect(d).toContain(w);
  });
  test("start, resume and switch read one stamped envelope", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/agents/policystart.ts")).text();
    const start = src.slice(src.indexOf("narrowEnvelope(planned.envelope"));
    expect(start).toContain("const stamp0 = { ...planned.startedBy, envelope");
    expect(start).toContain("const plan = { ...planned, envelope, startedBy: stamp0 }");
    expect(start).toContain("startedBy: asTui({ ...stamped, turnMinutes");
    // The engine-fallback retry still reuses the stamped envelope untouched.
    expect(src.match(/envelope: by\.envelope/g)?.length).toBe(1);
    const resume = src.slice(src.indexOf("async function resumeTurn("));
    const resumeBody = resume.slice(0, resume.indexOf("\n}\n"));
    // A plain resume (no role switch) also reuses it untouched, not re-narrowed.
    expect(resumeBody).toContain("envelope = by.envelope");
    // Switching role narrows through `planRoleSwitch`, never by re-locking inline here.
    expect(resumeBody).not.toContain("roleLockFor");
    expect(resumeBody).toContain("planRoleSwitch(");
  });
});

describe("mayStartSubagents", () => {
  test("off by default: the lock says so, Task stays off --allowedTools", () => {
    save("/home/a/orbit-sub-off", "builder", {});
    const lock = roleLockFor("/home/a/orbit-sub-off", "builder")!;
    expect(lock.mayStartSubagents).toBe(false);
    const role = { ...workerRole("builder")!, allow: lock.allow };
    expect(allowedToolsFor(role, DEFAULT_WORKER_ENVELOPE)).not.toContain("Task");
  });
  test("on: the lock carries it, and Task joins --allowedTools", () => {
    save("/home/a/orbit-sub-on", "builder", { mayStartSubagents: true });
    const lock = roleLockFor("/home/a/orbit-sub-on", "builder")!;
    expect(lock.mayStartSubagents).toBe(true);
    const role = { ...workerRole("builder")!, allow: lock.allow, mayStartSubagents: true };
    expect(allowedToolsFor(role, DEFAULT_WORKER_ENVELOPE)).toContain("Task");
  });
  test("a role that also narrows tools keeps Task out of the Claude deny list only when the switch is on", () => {
    save("/home/a/orbit-sub-narrow-off", "builder", { tools: ["read"] });
    const offLock = roleLockFor("/home/a/orbit-sub-narrow-off", "builder")!;
    const offRole = { ...workerRole("builder")!, allow: offLock.allow, mayStartSubagents: offLock.mayStartSubagents };
    const off = compileEnvelope("claude", offRole, narrowEnvelope(DEFAULT_WORKER_ENVELOPE, offLock), "sonnet", dir);
    if (!off.ok) throw new Error(off.error);
    expect((JSON.parse(off.args[1]!) as { permissions: { deny: string[] } }).permissions.deny).toContain("Task");

    save("/home/a/orbit-sub-narrow-on", "builder", { tools: ["read"], mayStartSubagents: true });
    const onLock = roleLockFor("/home/a/orbit-sub-narrow-on", "builder")!;
    const onRole = { ...workerRole("builder")!, allow: onLock.allow, mayStartSubagents: onLock.mayStartSubagents };
    const on = compileEnvelope("claude", onRole, narrowEnvelope(DEFAULT_WORKER_ENVELOPE, onLock), "sonnet", dir);
    if (!on.ok) throw new Error(on.error);
    expect((JSON.parse(on.args[1]!) as { permissions: { deny: string[] } }).permissions.deny).not.toContain("Task");
  });
  test("plain roleStart: the lock's switch keeps Task off the deny list too", () => {
    const r = ops.roleStart("builder", undefined, dir, { readsOnly: false, tools: ["read"], mayStartSubagents: true });
    if (!r.ok) throw new Error(r.error);
    const deny = (JSON.parse(r.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).not.toContain("Task");
  });
});

describe("both names of the Agent tool", () => {
  test("a role with the flag: allow list has Agent, deny list has neither name", () => {
    const role = { ...workerRole("builder")!, mayStartSubagents: true };
    expect(allowedToolsFor(role, DEFAULT_WORKER_ENVELOPE)).toContain("Agent");
    const r = compileEnvelope("claude", role, DEFAULT_WORKER_ENVELOPE, "sonnet", dir);
    if (!r.ok) throw new Error(r.error);
    const deny = (JSON.parse(r.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).not.toContain("Agent");
    expect(deny).not.toContain("Task");
  });
  test("a role without it: both names denied, neither allowed", () => {
    const role = workerRole("builder")!;
    expect(allowedToolsFor(role, DEFAULT_WORKER_ENVELOPE)).not.toContain("Agent");
    const r = compileEnvelope("claude", role, DEFAULT_WORKER_ENVELOPE, "sonnet", dir);
    if (!r.ok) throw new Error(r.error);
    const deny = (JSON.parse(r.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain("Agent");
    expect(deny).toContain("Task");
  });
});

describe("the Agent tool follows the subagent switch, not the tools list", () => {
  // An empty tools list denies nothing, so a role saved with no tools used to
  // get Task without the switch or the approval card an agent's write waits on.
  test("a role with no tools list and the switch off is denied Task", () => {
    save("/home/a/orbit-notools", "builder", { tools: [] });
    expect(claudeDeny("builder", roleLockFor("/home/a/orbit-notools", "builder"))).toContain("Task");
  });
  test("the switch on keeps Task, with or without a tools list", () => {
    for (const tools of [[], ["read", "run"]]) {
      const c = compileEnvelope("claude", { ...workerRole("builder")!, mayStartSubagents: true }, { ...DEFAULT_WORKER_ENVELOPE, ...(tools.length ? { tools } : {}) }, "sonnet", dir);
      if (!c.ok) throw new Error(c.error);
      expect((JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny).not.toContain("Task");
    }
  });
});

describe("a custom flow role's own door (its `base`, not its string id)", () => {
  // A flow role's id is the flow's own string (e.g. "verifier-acme"), never a
  // key of DOORS_FOR_ROLE: without `base`, a custom role whose `policyRole` is
  // "verifier" got no browser at all, CLI or MCP (red without the change).
  const custom = { ...workerRole("verifier")!, id: "verifier-acme" as any, base: "verifier" as const };
  const bare = { ...workerRole("verifier")!, id: "verifier-acme" as any };

  test("a custom id with no base opens no door, like scout", () => {
    const c = compileEnvelope("claude", bare, DEFAULT_WORKER_ENVELOPE, "sonnet", dir);
    if (!c.ok) throw new Error(c.error);
    expect((JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny).toContain("Bash(agentglass-browser:*)");
  });

  test("a custom id with `base: verifier` is sandboxed and keeps its CLI (the box reaches the relay)", () => {
    const c = compileEnvelope("claude", custom, SANDBOXED, "sonnet", dir);
    if (!c.ok) throw new Error(c.error);
    const deny = (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).not.toContain("Bash(agentglass-browser:*)");
  });

  test("allowedToolsFor gives the custom id the read-only browser MCP tools", () => {
    const allowed = allowedToolsFor(custom, DEFAULT_WORKER_ENVELOPE);
    expect(allowed).toContain("mcp__agentglass-browser__browser_read");
    expect(allowedToolsFor(bare, DEFAULT_WORKER_ENVELOPE)).not.toContain("mcp__agentglass-browser__browser_read");
  });

  test("mcpConfigFor loads the browser server for the custom id, not for a bare one", () => {
    expect(Object.keys(mcpConfigFor(custom).mcpServers)).toContain("agentglass-browser");
    expect(Object.keys(mcpConfigFor(bare).mcpServers)).not.toContain("agentglass-browser");
  });
});

describe("withBrowserCliNote", () => {
  const builder = workerRole("builder")!;
  test("sandboxed, door open: the note goes after the brief, in one line", () => {
    const said = withBrowserCliNote("do the thing", "claude", builder, SANDBOXED);
    expect(said.startsWith("do the thing\n\n")).toBe(true);
    expect(said.slice("do the thing\n\n".length)).toMatch(/^agentglass-browser is refused[^\n]*$/);
  });
  test("unsandboxed (network lifted): no note, the CLI itself still works", () => {
    const said = withBrowserCliNote("do the thing", "claude", builder, { ...DEFAULT_WORKER_ENVELOPE, network: true });
    expect(said).toBe("do the thing");
  });
  test("a role with no browser door: no note", () => {
    expect(withBrowserCliNote("do the thing", "claude", workerRole("scout")!, DEFAULT_WORKER_ENVELOPE)).toBe("do the thing");
  });
  test("an engine other than Claude Code: no note (its sandbox is not this one)", () => {
    expect(withBrowserCliNote("do the thing", "opencode", builder, DEFAULT_WORKER_ENVELOPE)).toBe("do the thing");
  });
  test("an empty prompt still gets the note alone, not a blank line in front of it", () => {
    expect(withBrowserCliNote("", "claude", builder, DEFAULT_WORKER_ENVELOPE)).not.toMatch(/^\n/);
  });
});

describe("no MultiEdit handed to the CLI", () => {
  test("deny and allow lists never name it", () => {
    expect(toolsDeniedFor(["read"])).not.toContain("MultiEdit");
    expect(allowedToolsFor(workerRole("builder")!, DEFAULT_WORKER_ENVELOPE)).not.toContain("MultiEdit");
  });
});
