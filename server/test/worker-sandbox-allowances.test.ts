/*
 * What a builder's sandbox allows so it can finish its own job, and what stays
 * out: the browser relay on loopback (browser-door roles only), a commit in a
 * linked worktree (its gitdir plus the common refs/objects/logs), and deps
 * linked from the main checkout. The real tmux socket and the main checkout's
 * working tree are never in the box.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxFor } from "../src/agents/headless.ts";
import { mcpConfigFor } from "../src/agents/headless.ts";
import { hasCommitDoor } from "../src/agents/envelope.ts";
import { __between, commitForWorker, commitOwnBranch, forgetWorktreeBranch, recordWorkerBranch, recordedWorker } from "../src/ownBranchCommit.ts";
import { ensureCheckoutDeps, nodeModulesGap } from "../src/checkoutDeps.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import type { Envelope } from "../../shared/orchestration.ts";

const env: Envelope = { write: "worktree", commit: true, network: false, docker: false, deny: [] };
const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });

function repo() {
  const base = mkdtempSync(join(tmpdir(), "agx-allow-"));
  const main = join(base, "main");
  const wt = join(base, "wt");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "a@b.c");
  git(main, "config", "user.name", "a");
  git(main, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x");
  git(main, "worktree", "add", "-q", wt, "-b", "feat");
  return { base, main, wt };
}

describe("relay", () => {
  const { base, wt } = repo();
  const net = (id: string) => (sandboxFor(workerRole(id)!, env, wt) as { network: { allowedDomains: string[] } }).network;
  // The sandbox names hosts, not ports: the loopback host would open every
  // local service, the agentglass API among them. The MCP tools are the door.
  test("a browser-door role gets no network either: the loopback is not opened for the relay", async () => {
    expect(net("builder").allowedDomains).toEqual([]);
  });
  test("a role with no browser door keeps the empty list", async () => {
    expect(net("scout").allowedDomains).toEqual([]);
  });
  test("no unix socket is opened by default, so the real tmux socket stays out", async () => {
    const n = (sandboxFor(workerRole("builder")!, env, wt) as { network: Record<string, unknown> }).network;
    expect(n.allowAllUnixSockets).toBeUndefined();
  });
  test("cleanup", () => rmSync(base, { recursive: true, force: true }));
});

describe("git in a linked worktree: no ref path is open, the server commits", () => {
  const { base, main, wt } = repo();
  const fs = (e: Envelope) => (sandboxFor(workerRole("builder")!, e, wt) as { filesystem: { allowWrite: string[]; denyWrite?: string[] } }).filesystem;
  test("writes: the worktree, its own gitdir and common objects only", async () => {
    const w = fs(env).allowWrite;
    expect(w).toContain(wt);
    expect(w).toContain(join(main, ".git", "objects"));
    expect(w.some((p) => p.startsWith(join(main, ".git", "worktrees")))).toBe(true);
    for (const d of ["refs", "logs", "packed-refs", "refs/heads"]) expect(w).not.toContain(join(main, ".git", d));
  });
  test("refs, logs, packed-refs and hooks are denied, commit or not", async () => {
    for (const e of [env, { ...env, commit: false }]) {
      const f = fs(e);
      for (const d of ["refs", "logs", "packed-refs", "hooks"]) expect(f.denyWrite).toContain(join(main, ".git", d));
    }
  });
  test("the main checkout's working tree and .git are not writable", async () => {
    const f = fs(env);
    expect(f.allowWrite).not.toContain(main);
    expect(f.allowWrite).not.toContain(join(main, ".git"));
  });
  test("the server commits onto the worktree's own branch", async () => {
    writeFileSync(join(wt, "a.txt"), "a");
    git(wt, "add", "a.txt");
    const before = git(main, "rev-parse", "main").stdout;
    const r = (await commitOwnBranch(wt, "add a", "feat"));
    expect(JSON.stringify(r)).toContain('"ok":true');
    expect(git(wt, "log", "-1", "--format=%s").stdout.trim()).toBe("add a");
    expect(git(main, "rev-parse", "main").stdout).toBe(before);
  });
  test("two commits at once: both land, none fails on a stale tip", async () => {
    git(wt, "symbolic-ref", "HEAD", "refs/heads/feat");
    writeFileSync(join(wt, "b.txt"), "b");
    git(wt, "add", "b.txt");
    const [x, y] = await Promise.all([commitOwnBranch(wt, "race one", "feat"), commitOwnBranch(wt, "race two", "feat")]);
    expect(x.ok).toBe(true);
    expect(JSON.stringify(y)).not.toContain("update-ref failed"); // the second sees the index equals the branch
    expect(JSON.stringify(y)).toContain("nothing to commit");
  });
  test("a commit whose index moved underneath it is refused, and the branch does not move", async () => {
    git(wt, "symbolic-ref", "HEAD", "refs/heads/feat");
    writeFileSync(join(wt, "c.txt"), "c");
    git(wt, "add", "c.txt");
    writeFileSync(join(wt, "d.txt"), "d");
    const tip = git(wt, "rev-parse", "feat").stdout;
    // The worker stages d.txt after the tree was written, before the ref moves.
    __between.run = () => { git(wt, "add", "d.txt"); };
    let r;
    try { r = await commitOwnBranch(wt, "moving", "feat"); } finally { __between.run = null; }
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("index changed");
    expect(git(wt, "rev-parse", "feat").stdout).toBe(tip);
  });
  test("a worktree on main is refused, and main does not move", async () => {
    const before = git(main, "rev-parse", "main").stdout;
    git(wt, "symbolic-ref", "HEAD", "refs/heads/main");
    const r = (await commitOwnBranch(wt, "x", "feat"));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("A worker may move only the branch its own worktree has checked out");
    expect(git(main, "rev-parse", "main").stdout).toBe(before);
  });
  test("the main checkout, a detached HEAD and an empty message are refused", async () => {
    expect((await commitOwnBranch(main, "x", "main")).ok).toBe(false);
    git(wt, "symbolic-ref", "HEAD", "refs/heads/feat");
    expect((await commitOwnBranch(wt, "  ", "feat")).ok).toBe(false);
    git(wt, "checkout", "-q", "--detach");
    expect(JSON.stringify((await commitOwnBranch(wt, "x", "feat")))).toContain("detached");
  });
  test("a branch another worktree has checked out is refused", async () => {
    const other = join(base, "other");
    git(main, "worktree", "add", "-q", other, "-b", "theirs");
    git(wt, "checkout", "-q", "-B", "theirs2");
    git(wt, "symbolic-ref", "HEAD", "refs/heads/theirs");
    expect(JSON.stringify((await commitOwnBranch(wt, "x", "theirs")))).toContain("another worktree");
  });
  test("a worker that rewrote HEAD to another branch is refused, and no ref outside its branch moves", async () => {
    git(wt, "checkout", "-q", "feat");
    const rec = (await recordWorkerBranch("rewriter", wt));
    expect(rec?.branch).toBe("feat");
    writeFileSync(join(wt, "c.txt"), "c");
    git(wt, "add", "c.txt");
    // What the worker can do inside its sandbox: point its own HEAD at main.
    git(wt, "symbolic-ref", "HEAD", "refs/heads/main");
    const refs = () => git(main, "for-each-ref", "--format=%(refname) %(objectname)").stdout;
    const before = refs();
    const r = (await commitForWorker({ principal: "worker", worker: "rewriter" }, "sneak", recordedWorker));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("started on feat");
    expect(refs()).toBe(before);
    // Detached is refused too, naming the record.
    git(wt, "checkout", "-q", "--detach");
    expect(JSON.stringify((await commitForWorker({ principal: "worker", worker: "rewriter" }, "x", recordedWorker)))).toContain("started on feat");
    expect(refs()).toBe(before);
    git(wt, "checkout", "-q", "feat");
  });
  test("a worktree reached through a symlinked cwd still finds its own block", async () => {
    git(wt, "checkout", "-q", "feat");
    const link = join(base, "wt-link");
    symlinkSync(wt, link);
    expect((await recordWorkerBranch("viaLink", link))?.branch).toBe("feat");
    forgetWorktreeBranch(link);
    expect(recordedWorker("viaLink")).toBeUndefined(); // the same key, so forgetting by the link drops the real record
  });
  test("a cwd that is gone records nothing instead of throwing", async () => {
    expect(await recordWorkerBranch("gone", join(base, "no-such-dir"))).toBeNull();
  });
  test("first start wins: a reused worktree keeps the original record after HEAD is rewritten", async () => {
    git(wt, "checkout", "-q", "feat");
    git(main, "branch", "free2");
    expect((await recordWorkerBranch("wa", wt))?.branch).toBe("feat");
    git(wt, "symbolic-ref", "HEAD", "refs/heads/free2");
    expect((await recordWorkerBranch("wb", wt))?.branch).toBe("feat");
    writeFileSync(join(wt, "d.txt"), "d");
    git(wt, "add", "d.txt");
    const r = (await commitForWorker({ principal: "worker", worker: "wb" }, "x", recordedWorker));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("started on feat");
    forgetWorktreeBranch(wt);
    expect(recordedWorker("wb")).toBeUndefined();
    git(wt, "symbolic-ref", "HEAD", "refs/heads/feat");
  });
  test("the commit door needs a builder that can write", async () => {
    // No envelope is no door: the door opens only for an envelope that says it may write (fails closed).
    expect(hasCommitDoor({ id: "builder" })).toBe(false);
    expect(hasCommitDoor({ id: "builder" }, { write: "worktree" })).toBe(true);
    expect(hasCommitDoor({ id: "builder", readOnly: true })).toBe(false);
    expect(hasCommitDoor({ id: "builder" }, { write: "none" })).toBe(false);
    const names = (e?: { write?: string }) => Object.keys(mcpConfigFor({ id: "builder" } as never, [], e).mcpServers);
    expect(names({ write: "worktree" })).toContain("agentglass-commit");
    expect(names({ write: "none" })).not.toContain("agentglass-commit");
  });
  test("the door commits only in the calling worker's own recorded folder", async () => {
    const other = join(base, "other");
    writeFileSync(join(other, "b.txt"), "b");
    git(other, "add", "b.txt");
    const cwds: Record<string, { cwd: string; branch: string }> = { mine: { cwd: wt, branch: "feat" }, theirs: { cwd: other, branch: "theirs" } };
    const lookup = (n: string) => cwds[n];
    const before = git(other, "rev-parse", "HEAD").stdout;
    // The caller names no folder: whatever a body says, "mine" reaches only wt.
    git(wt, "checkout", "-q", "feat");
    const r = (await commitForWorker({ principal: "worker", worker: "mine" }, "from mine", lookup));
    expect(JSON.stringify(r)).not.toContain("refused");
    expect(git(other, "rev-parse", "HEAD").stdout).toBe(before);
    expect((await commitForWorker({ principal: "worker", worker: "ghost" }, "x", lookup)).ok).toBe(false);
    // Without a worker credential, or with another worker's, nothing moves in `mine`.
    const mineBefore = git(wt, "rev-parse", "feat").stdout;
    expect((await commitForWorker(undefined, "x", lookup)).ok).toBe(false);
    expect(git(wt, "rev-parse", "feat").stdout).toBe(mineBefore);
    expect((await commitForWorker({ principal: "seat", worker: "mine" }, "x", lookup)).ok).toBe(false);
    expect((await commitForWorker(null, "x", lookup)).ok).toBe(false);
    expect(git(other, "rev-parse", "HEAD").stdout).toBe(before);
  });
  test("cleanup", () => rmSync(base, { recursive: true, force: true }));
});

describe("deps before the first turn", () => {
  test("a worktree with the same lockfile links the main checkout's node_modules", async () => {
    const { base, main, wt } = repo();
    for (const d of [main, wt]) {
      writeFileSync(join(d, "package.json"), '{"name":"x","dependencies":{"a":"1"}}');
      writeFileSync(join(d, "bun.lock"), "lock1");
    }
    mkdirSync(join(main, "node_modules"));
    expect(nodeModulesGap(wt)).not.toBeNull();
    expect((await ensureCheckoutDeps(wt))).toBe("linked");
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(nodeModulesGap(wt)).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });
  test("a different lockfile is never linked", async () => {
    const { base, main, wt } = repo();
    writeFileSync(join(main, "package.json"), '{"name":"x","dependencies":{"a":"1"}}');
    writeFileSync(join(wt, "package.json"), '{"name":"x","dependencies":{"a":"1"}}');
    writeFileSync(join(main, "bun.lock"), "lock1");
    writeFileSync(join(wt, "bun.lock"), "lock2");
    mkdirSync(join(main, "node_modules"));
    expect((await ensureCheckoutDeps(wt))).not.toBe("linked");
    expect(existsSync(join(wt, "node_modules")) && lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
  test("nothing missing: nothing done", async () => {
    const { base, wt } = repo();
    expect((await ensureCheckoutDeps(wt))).toBe("none");
    rmSync(base, { recursive: true, force: true });
  });
});

describe("the install the server runs for a worktree", () => {
  test("bun install runs with --ignore-scripts: no lifecycle script runs outside the sandbox", async () => {
    const base = mkdtempSync(join(tmpdir(), "agx-bun-"));
    const wt = join(base, "wt");
    const bin = join(base, "bin");
    mkdirSync(wt);
    mkdirSync(bin);
    writeFileSync(join(wt, "package.json"), '{"name":"x","dependencies":{"a":"1"}}');
    writeFileSync(join(wt, "bun.lock"), "lock1");
    const argvFile = join(base, "argv");
    writeFileSync(join(bin, "bun"), `#!/bin/sh\necho "$@" > ${argvFile}\nmkdir -p node_modules\n`);
    chmodSync(join(bin, "bun"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      expect((await ensureCheckoutDeps(wt))).toBe("installed");
    } finally {
      process.env.PATH = path;
    }
    expect(readFileSync(argvFile, "utf8").trim()).toBe("install --frozen-lockfile --ignore-scripts");
    rmSync(base, { recursive: true, force: true });
  });
});
