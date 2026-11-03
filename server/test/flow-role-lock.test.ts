/*
 * A saved flow role's "reads only" and "tools" narrow a worker's lock at start,
 * and its "allow" grants that role's workers a command the floor refuses — the
 * only widening a flow has, and never over a never-liftable one.
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
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { compileEnvelope, narrowEnvelope, toolsDeniedFor, ALWAYS_ALLOWED } = await import("../src/agents/envelope.ts");
const { DEFAULT_WORKER_ENVELOPE } = await import("../../shared/orchestration.ts");
const { workerRole } = await import("../../shared/workerRoles.ts");
const ops = await import("../src/agentops.ts");
const FlightPlan = await import("../src/flightPlan.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const WRITES = ["Edit", "Write", "NotebookEdit", "MultiEdit"];
const save = (root: string, role: string, patch: { readsOnly?: boolean; tools?: string[]; allow?: string[] }) => {
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
    expect(roleLockFor("/home/a/orbit-y", "verifier")).toEqual({ readsOnly: true, tools: ["read"], allow: [] });
  });
});

describe("allow", () => {
  test("a builder granted docker keeps a push off, and has docker off its own lock", () => {
    save("/home/a/orbit-allow", "builder", { allow: ["docker"] });
    const lock = roleLockFor("/home/a/orbit-allow", "builder")!;
    expect(lock.allow).toEqual(["docker"]);
    const c = compileEnvelope("claude", { ...workerRole("builder")!, allow: lock.allow }, narrowEnvelope(DEFAULT_WORKER_ENVELOPE, lock), "sonnet", dir);
    if (!c.ok) throw new Error(c.error);
    const deny = (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).not.toContain("Bash(docker:*)");
    expect(deny).toContain("Bash(git push:*)");
  });
  test("every other role keeps the lock", () => {
    save("/home/a/orbit-allow2", "builder", { allow: ["docker"] });
    const theirs = compileEnvelope("claude", workerRole("reviewer")!, narrowEnvelope(DEFAULT_WORKER_ENVELOPE, roleLockFor("/home/a/orbit-allow2", "reviewer")), "sonnet", dir);
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

describe("the other start paths", () => {
  test("plain start: roleStart honours the role's grant, and still denies a push", () => {
    const roles = { builder: { provider: "claude", model: "sonnet" }, scout: "claude", reviewer: "claude", verifier: "claude" } as any;
    const r = ops.roleStart("builder", roles, dir, { readsOnly: false, tools: [], allow: ["docker"] });
    if (!r.ok) throw new Error(r.error);
    const deny = (JSON.parse(r.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).not.toContain("Bash(docker:*)");
    expect(deny).toContain("Bash(git push:*)");
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
    expect(start).toContain("startedBy: { ...planned.startedBy, envelope");
    expect(src.match(/envelope: by\.envelope/g)?.length).toBe(2);
    const resume = src.slice(src.indexOf("async function resumeTurn("));
    expect(resume.slice(0, resume.indexOf("\n}\n"))).not.toContain("roleLockFor");
  });
});
