/*
 * A flight-plan builder's file writes stay inside the worktree it was cut, through the
 * pre-tool-call check every agent already goes through: the real PreToolUse hook as a
 * child process against a booted server. A shell command out of the tree is not held
 * (worktreeVerdict names that limit), and a server that does not answer in 2 s lets the
 * call through like any other rule.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "tok-worktree-hook-example";
const HOOK = new URL("../../hooks/send_event.py", import.meta.url).pathname;
const have = !!Bun.which("python3");
let dir = "", scratch = "", tree = "", other = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;

/** The hook as Claude Code runs it, in a builder's tab (`bound` in the environment) or not. */
async function hook(tool: string, input: Record<string, unknown>, bound?: string): Promise<Record<string, any> | null> {
  const p = Bun.spawn(["python3", HOOK, "--server", base, "--event-type", "PreToolUse", "--source-app", "orbit"], {
    cwd: tree,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_PORT: new URL(base).port, ...(bound ? { AGENTGLASS_BUILDER_WORKTREE: bound } : {}) },
    stdin: new Blob([JSON.stringify({ session_id: "s-builder-1", cwd: tree, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input })]),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const last = stdout.trim().split("\n").pop();
  return last ? JSON.parse(last) : null;
}
const denied = (out: Record<string, any> | null) => out?.hookSpecificOutput?.permissionDecision === "deny";

beforeAll(async () => {
  if (!have) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-wt-hook-")));
  tree = join(dir, "orbit-fp-footer"); other = join(dir, "acme", "elsewhere");
  scratch = join(dir, "scratch"); mkdirSync(scratch);
  mkdirSync(tree, { recursive: true }); mkdirSync(other, { recursive: true });
  symlinkSync(other, join(tree, "link-out"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMPDIR: scratch,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  // The launched plan whose worktree this is: its row goes straight into the server's database, a launch needing a real tmux.
  const db = new Database(join(dir, "d.db"));
  db.query(`INSERT INTO flight_plan (id, root, title, request, state, launched, created_at, updated_at) VALUES ('fp_00000000000000cc', ?, 'Footer', 'r', 'launched', ?, 1, 1)`)
    .run(join(dir, "orbit"), JSON.stringify({ at: 1, title: "Footer", branch: "flight-plan/footer", worktree: tree }));
  db.close();
}, SERVER_BOOT_MS);
afterAll(() => { proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!have)("a builder's file writes stay in its worktree", () => {
  test("inside the tree, relative or absolute, nothing is said", async () => {
    expect(await hook("Edit", { file_path: join(tree, "src", "a.ts"), old_string: "a", new_string: "b" }, tree)).toBeNull();
    expect(await hook("Write", { file_path: "notes/b.md", content: "x" }, tree)).toBeNull();
  });

  test("Edit, Write, MultiEdit and NotebookEdit outside it are denied with the worktree named", async () => {
    for (const [tool, input] of [
      ["Edit", { file_path: join(other, "a.ts") }], ["Write", { file_path: join(other, "b.ts") }],
      ["MultiEdit", { file_path: join(other, "c.ts") }], ["NotebookEdit", { notebook_path: join(other, "d.ipynb") }],
      ["Write", { file_path: "../acme/elsewhere/e.ts" }], ["Write", { file_path: join(tree, "..", "..", "etc-orbit") }],
      ["Write", { file_path: join(tree, "link-out", "f.ts") }],
    ] as const) {
      const out = await hook(tool, input, tree);
      expect(denied(out)).toBe(true);
      expect(out!.hookSpecificOutput.permissionDecisionReason).toContain(tree);
    }
  });

  test("the builder's own scratch directory is allowed, and reading is never held", async () => {
    expect(await hook("Write", { file_path: join(scratch, "agx-builder-orbit-fp-footer", "note.txt"), content: "x" }, tree)).toBeNull();
    // Its own scratch directory only, not everything under TMPDIR.
    expect(denied(await hook("Write", { file_path: join(scratch, "someone-elses.txt"), content: "x" }, tree))).toBe(true);
    expect(await hook("Read", { file_path: join(other, "a.ts") }, tree)).toBeNull();
  });

  test("a tab with no worktree in its environment, or one no launched plan was cut at, is not held", async () => {
    expect(await hook("Write", { file_path: join(other, "a.ts"), content: "x" })).toBeNull();
    expect(await hook("Write", { file_path: join(other, "a.ts"), content: "x" }, join(dir, "never-launched"))).toBeNull();
  });

  test("the shell is read too: a push, a write out of the tree and a wrapped push are denied; a script file is the named limit", async () => {
    for (const command of ["git push origin HEAD", "git -C . push", "env git push", "sh -c 'git push'", `echo x > ${join(other, "g.txt")}`, `sed -i s/a/b/ ${join(other, "g.txt")}`, "gh pr create"]) {
      const out = await hook("Bash", { command }, tree);
      expect(denied(out)).toBe(true);
    }
    expect(await hook("Bash", { command: "git rebase main && bun test 2>&1 | tail -3" }, tree)).toBeNull();
    expect(await hook("Bash", { command: "sh ./push-it.sh" }, tree)).toBeNull();   // a script the builder wrote: not seen
  });

  test("the same line from a tab that is not a builder's is nobody's business here", async () => {
    expect(await hook("Bash", { command: "git push origin HEAD" })).toBeNull();
  });
});
