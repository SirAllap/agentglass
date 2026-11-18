// An idle server asked `git worktree list` for the same project every five
// seconds. Measured on one quiet project, 10 forks in 180 s; the fork of a big
// process is the stall (perf audit 17). The family now stands while nothing in
// .git/worktrees moved, and still re-lists the moment a worktree is cut.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-fam-idle-")));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB, PATH: process.env.PATH };
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "w.db");
const log = join(dir, "spawns.log");
const realGit = Bun.which("git")!;
mkdirSync(join(dir, "bin"));
writeFileSync(join(dir, "bin", "git"), `#!/bin/sh\necho "$*" >> ${log}\nexec ${realGit} "$@"\n`);
chmodSync(join(dir, "bin", "git"), 0o755);
process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
afterAll(() => { for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const listCalls = () => { try { return readFileSync(log, "utf8").split("\n").filter((l) => l.includes("worktree list")).length; } catch { return 0; } };

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync([realGit, "-c", "user.email=a@b.c", "-c", "user.name=a", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

test("a quiet project is listed once a minute, not once a tick; a new worktree is seen at once", async () => {
  const project = join(dir, "orbit");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  git(project, "commit", "-q", "--allow-empty", "-m", "init");
  const { worktreeFamily } = await import("../src/worktree.ts");
  const real = Date.now;
  let t = real() + 10_000; // past the settle window
  Date.now = () => t;
  try {
    // 12 ticks, five seconds apart = one idle minute. Before: 12 lists.
    for (let i = 0; i < 12; i++) { worktreeFamily(project); t += 5_000; }
    expect(listCalls()).toBeLessThanOrEqual(2);
  } finally { Date.now = real; }
});

test("a worktree cut 20 s after the listing is seen once; no cut means no re-list", async () => {
  const { worktreeFamily } = await import("../src/worktree.ts");
  const project = join(dir, "orbit2");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  git(project, "commit", "-q", "--allow-empty", "-m", "init");
  git(project, "worktree", "add", "-q", "-b", "first", join(dir, "orbit2-ORBIT-1"));
  const real = Date.now;
  let t = real() + 10_000;
  Date.now = () => t;
  try {
    worktreeFamily(project);
    t += 20_000;
    const before = listCalls();
    t += 6_000;
    expect(worktreeFamily(project).length).toBe(2);
    expect(listCalls()).toBe(before); // no cut: no re-list at 26 s
    git(project, "worktree", "add", "-q", "-b", "second", join(dir, "orbit2-ORBIT-2"));
    t += 6_000;
    expect(worktreeFamily(project).length).toBe(3);
    expect(listCalls()).toBe(before + 1);
  } finally { Date.now = real; }
});

// A coarse filesystem clock gives two worktrees cut a few ms apart the same mtime.
test("a worktree cut in the same mtime tick as the listing is seen within 5 s", async () => {
  const { worktreeFamily } = await import("../src/worktree.ts");
  const project = join(dir, "orbit3");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  git(project, "commit", "-q", "--allow-empty", "-m", "init");
  git(project, "worktree", "add", "-q", "-b", "a", join(dir, "orbit3-ORBIT-1"));
  const wtDir = join(project, ".git", "worktrees");
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  try {
    expect(worktreeFamily(project).length).toBe(2); // listed in the tick the mark was set
    const st = statSync(wtDir);
    git(project, "worktree", "add", "-q", "-b", "b", join(dir, "orbit3-ORBIT-2"));
    utimesSync(wtDir, st.atime, st.mtime); // same coarse mtime as before
    t += 6_000;
    expect(worktreeFamily(project).length).toBe(3);
  } finally { Date.now = real; }
});
