/*
 * A prompt handed to the person's default engine from a button: which CLI is
 * started, and that nothing but a known agent id can pick an executable.
 *
 * The CLIs are stubs: this runtime linked under the agent's own name (not a
 * renamed coreutils binary, which picks its tool by argv[0]), on a PATH the
 * child process starts with, because Bun.which reads the PATH it began with.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-issue-argv-"));
  mkdirSync(join(dir, "bin"));
  for (const name of ["claude", "codex", "opencode"]) symlinkSync(process.execPath, join(dir, "bin", name));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run issueArgv in a child whose PATH holds the stubs (or nothing), and read what it built. */
async function build(kind: unknown, withStubs = true, defaultKind = "claude"): Promise<{ ok: boolean; argv?: string[]; kind?: string; error?: string }> {
  const code = `
    const { issueArgv } = await import(${JSON.stringify(new URL("../src/agentticket.ts", import.meta.url).pathname)});
    const r = issueArgv({ kind: ${JSON.stringify(kind)}, prompt: "review it", yolo: false, title: "Review 7", model: "opus", effort: "high" },
      { canName: () => true, modelFlags: (m, e) => ["--model", String(m), "--effort", String(e)], defaultKind: ${JSON.stringify(defaultKind)} });
    console.log(JSON.stringify(r));`;
  const p = Bun.spawn([process.execPath, "-e", code], {
    env: { PATH: withStubs ? join(dir, "bin") : join(dir, "nowhere"), HOME: dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (!out.trim()) throw new Error(err);
  return JSON.parse(out.trim().split("\n").pop()!);
}

describe("issueArgv", () => {
  test("Claude is the default, with its model and effort flags and the prompt", async () => {
    const r = await build(undefined);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("claude");
    expect(r.argv![0]).toBe(join(dir, "bin", "claude"));
    expect(r.argv).toContain("--model");
    expect(r.argv).toContain("review it");
  });

  test("another engine starts its own CLI, with the prompt and without Claude's model flags", async () => {
    const r = await build("codex");
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("codex");
    expect(r.argv![0]).toBe(join(dir, "bin", "codex"));
    expect(r.argv).toContain("review it");
    expect(r.argv).not.toContain("--model");
    expect(r.argv).not.toContain("--effort");
  });

  test("a button that names no engine gets the person's default, not Claude", async () => {
    const r = await build(undefined, true, "opencode");
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("opencode");
    expect(r.argv![0]).toBe(join(dir, "bin", "opencode"));
    expect(r.argv).toContain("review it");
    expect(r.argv).not.toContain("--model");
  });

  test("an id that is not in the agent table is Claude, never an executable", async () => {
    const r = await build("../../bin/sh");
    expect(r.kind).toBe("claude");
    expect(r.argv![0]).toBe(join(dir, "bin", "claude"));
  });

  test("an engine that is not installed says so", async () => {
    const r = await build("codex", false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not installed/);
  });

  test("a default that is not in the agent table falls back to Claude", async () => {
    const r = await build(undefined, true, "../../bin/sh");
    expect(r.kind).toBe("claude");
  });
});

/*
 * The hand-off paths on the terminal socket, read as source: each builds its
 * command line through issueArgv with the person's default, and none picks
 * Claude's binary on its own. `resume` is the one that does, on purpose: only
 * Claude continues a transcript by id.
 */
const term = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const within = (open: string) => {
  const from = term.indexOf(open);
  expect(from).toBeGreaterThan(-1);
  return term.slice(from, term.indexOf("\n    }\n", from));
};
describe("the terminal socket's hand-offs follow the default engine", () => {
  test("review builds through issueArgv with the default, not claudeCode.bin()", () => {
    const body = within('if (msg.cmd === "review") {');
    expect(body).toContain("issueArgv(");
    expect(body).toContain("defaultKind: workerRoles().builder.provider");
    expect(body).not.toContain("claudeCode.bin()");
    expect(body).not.toContain("agentArgv(");
  });
  test("issue passes the default to issueArgv", () => {
    expect(term).toMatch(/issueArgv\(\{ kind: msg\.kind[^\n]*defaultKind: workerRoles\(\)\.builder\.provider/);
  });
});
