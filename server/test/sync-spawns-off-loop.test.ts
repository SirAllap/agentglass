import { test, expect } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const src = (f: string) => readFileSync(join(import.meta.dir, "../src", f), "utf8");

test("socket close restores windows async; only shutdown keeps the sync call", () => {
  const t = src("terminal.ts");
  const put = t.slice(t.indexOf("const put = () => Promise.race"), t.indexOf("const put = () => Promise.race") + 400);
  expect(put).toContain("restoreWindowsAsync(");
  expect(put).not.toMatch(/[^c]restoreWindows\(/);
  expect(t).toMatch(/for \(const p of back\) \{ try \{ restoreWindows\(/);
});

test("restoreWindowsAsync spawns nothing synchronously", () => {
  const s = src("tmuxctl.ts");
  const a = s.indexOf("export async function restoreWindowsAsync");
  const body = s.slice(a, s.indexOf("/** Servers whose leftover marks", a));
  expect(body).not.toMatch(/[^c.]tmux\(socket/);
  expect(body).not.toContain("clearSizeMark(");
  expect(body).toContain("Promise.all");
});

test("tmuxServerName is not cached (a restarted or dead server must not keep an old name)", () => {
  expect(src("tmuxctl.ts")).not.toContain("serverNames");
});

test("restoreWindowsAsync re-checks the claim and phones before writing, and clears the mark only if unchanged", () => {
  const s = src("tmuxctl.ts");
  const a = s.indexOf("export async function restoreWindowsAsync");
  const body = s.slice(a, s.indexOf("async function phoneWindowsAsync", a));
  const resize = body.indexOf('"resize-window"');
  expect(body.lastIndexOf("deskClaimed(", resize)).toBeGreaterThan(body.indexOf("mark0"));
  expect(body.lastIndexOf("phoneWindowsAsync(", resize)).toBeGreaterThan(0);
  expect(body).toContain("clearIfUnchanged(socket, id, mark0)");
  expect(s).toMatch(/nowMark !== mark0\) return/);
});

test("the 1.5 s and 3 s restores are chained and bounded; owed clears in finally", () => {
  const t = src("terminal.ts");
  expect(t).toContain("first.then(put).finally(() => owed.delete(back))");
  expect(t).toContain("RESTORE_BOUND_MS");
  expect(t).toContain("Promise.race");
});

test("inScope's re-list is keyed on the worktrees mtime, not forced per check", () => {
  expect(src("config.ts")).not.toContain("forgetWorktreeFamily(root)");
  expect(src("config.ts")).toContain("worktreeFamilyFresh");
});

test("worktreeFamilyFresh finds a worktree cut after the first listing, and does not re-list otherwise", async () => {
  const { worktreeFamilyFresh } = await import("../src/worktree.ts");
  const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "wt-"));
  try {
    const run = (...a: string[]) => spawnSync("git", ["-C", d, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a" } });
    run("init", "-q");
    run("commit", "-q", "--allow-empty", "-m", "x");
    const before = worktreeFamilyFresh(d);
    const other = join(d + "-wt1");
    run("worktree", "add", "-q", other, "-b", "b1");
    const after = worktreeFamilyFresh(d);
    expect(after).toContain(other);
    expect(before).not.toContain(other);
    // A mark younger than the settle window is never trusted (same-tick cuts), so
    // age it; after that the cached array is reused with no second spawn.
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(d, ".git", "worktrees"), old, old);
    worktreeFamilyFresh(d); // re-lists once, records the aged mark
    const a = worktreeFamilyFresh(d), b = worktreeFamilyFresh(d);
    expect(b).toBe(a); // same cached array: no second spawn
    rmSync(other, { recursive: true, force: true });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("worktreeFamilyFresh re-lists once the entry is past the old 5 s TTL, and not on a fresh mark", () => {
  const w = src("worktree.ts");
  expect(w).toContain("age < FAMILY_CACHE_MS");
  expect(w).toContain("MARK_SETTLE_MS");
});
