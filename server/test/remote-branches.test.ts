// Browsing a remote, and pulling one of its branches down.
//
// Against a real remote (a bare repo) and a real clone, because everything
// under test is about the difference between refs the clone HAS and refs it
// merely KNOWS ABOUT — a distinction no fixture can fake. The repo this was
// written for has 790 branches on origin and 45 locally, and the panel's whole
// job is to keep those two facts apart on every row.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, origin: string, clone: string, gw: typeof import("../src/gitwork.ts");

const run = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

beforeAll(async () => {
  // realpath: git records the resolved path in a worktree's .git file, and the
  // worktree assertions below compare paths.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-remote-")));
  origin = join(dir, "origin.git");
  clone = join(dir, "clone");
  // The scope guard reads the running machine's real config; point it at the
  // fixture before gitwork is imported, exactly as sync-base.test.ts does.
  process.env.AGENTGLASS_ROOT = dir;

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8" });
  const seed = join(dir, "seed");
  spawnSync("git", ["init", "-q", "-b", "main", seed], { encoding: "utf8" });
  run(seed, "config", "user.email", "t@example.com");
  run(seed, "config", "user.name", "t");
  // Explicit, distinct commit dates: `--sort=-committerdate` has nothing to
  // sort by when four commits land in the same second, and a test that passes
  // on git's tie-break order pins nothing.
  let when = 0;
  const commit = (f: string, msg: string) => {
    writeFileSync(join(seed, f), `${msg}\n`);
    run(seed, "add", "-A");
    const date = `2024-01-0${++when} 12:00:00 +0000`;
    spawnSync("git", ["-C", seed, "commit", "-qm", msg], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  commit("a.txt", "first");
  run(seed, "remote", "add", "origin", origin);
  run(seed, "push", "-q", "-u", "origin", "main");
  // Three ticket branches on the remote, oldest first, so newest-first has
  // something to be right or wrong about.
  for (const b of ["WEB-1-alpha", "WEB-2-beta", "WEB-3-gamma"]) {
    run(seed, "checkout", "-q", "-b", b, "main");
    commit(`${b}.txt`, `work on ${b}`);
    run(seed, "push", "-q", "origin", b);
    run(seed, "checkout", "-q", "main");
  }
  spawnSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
  run(clone, "config", "user.email", "t@example.com");
  run(clone, "config", "user.name", "t");

  gw = await import("../src/gitwork.ts");
});

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

describe("remoteBranches", () => {
  it("lists what is on the remote, newest first", () => {
    const r = gw.remoteBranches(clone, "origin");
    expect(r.ok).toBe(true);
    expect(r.remote).toBe("origin");
    expect(r.branches.map((b) => b.name)).toEqual(["WEB-3-gamma", "WEB-2-beta", "WEB-1-alpha", "main"]);
    const g = r.branches[0];
    expect(g.ref).toBe("origin/WEB-3-gamma");
    expect(g.subject).toBe("work on WEB-3-gamma");
    expect(g.hash).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("drops origin/HEAD — it points at another row in the same list", () => {
    // A fresh clone always has one. Listed, it looks like a branch called HEAD
    // that you could check out.
    expect(run(clone, "symbolic-ref", "refs/remotes/origin/HEAD").stdout.trim()).toBe("refs/remotes/origin/main");
    expect(gw.remoteBranches(clone, "origin").branches.some((b) => b.name === "HEAD")).toBe(false);
  });

  it("marks the ones you already have, and only those", () => {
    // `main` is the clone's own branch; nothing else has been brought down.
    const by = new Map(gw.remoteBranches(clone, "origin").branches.map((b) => [b.name, b]));
    expect(by.get("main")!.local).toBe(true);
    expect(by.get("main")!.tracking).toBe(true);
    expect(by.get("WEB-1-alpha")!.local).toBe(false);
    expect(by.get("WEB-1-alpha")!.tracking).toBe(false);
  });

  it("defaults to the repo's only remote when none is named", () => {
    expect(gw.remoteBranches(clone, "").remote).toBe("origin");
  });

  it("answers nothing rather than everything for a remote that isn't there", () => {
    // The refs/remotes/<name> namespace simply doesn't exist — the danger would
    // be falling back to listing every remote's branches under one name.
    expect(gw.remoteBranches(clone, "upstream").branches).toEqual([]);
  });

  it("refuses a remote name that is really a path", () => {
    expect(gw.remoteBranches(clone, "origin/../../etc").ok).toBe(false);
  });
});

describe("trackRemoteBranch", () => {
  it("creates a local branch tracking the remote one, without moving the checkout", () => {
    const head = run(clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    expect(gw.trackRemoteBranch(clone, "origin/WEB-1-alpha").ok).toBe(true);
    expect(run(clone, "rev-parse", "--verify", "--quiet", "refs/heads/WEB-1-alpha").status).toBe(0);
    expect(run(clone, "config", "--get", "branch.WEB-1-alpha.merge").stdout.trim()).toBe("refs/heads/WEB-1-alpha");
    expect(run(clone, "config", "--get", "branch.WEB-1-alpha.remote").stdout.trim()).toBe("origin");
    // The working tree did NOT move: an agent may be mid-edit in it.
    expect(run(clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe(head);
  });

  it("shows up as local on the very next listing", () => {
    const b = gw.remoteBranches(clone, "origin").branches.find((x) => x.name === "WEB-1-alpha")!;
    expect(b.local).toBe(true);
    expect(b.tracking).toBe(true);
  });

  it("switches the checkout when asked to", () => {
    expect(gw.trackRemoteBranch(clone, "origin/WEB-2-beta", { switch: true }).ok).toBe(true);
    expect(run(clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe("WEB-2-beta");
    run(clone, "checkout", "-q", "main");
  });

  it("refuses when the local name is taken", () => {
    // The existing branch may be a different branch that happens to share a
    // name; quietly reusing it is how you check out the wrong work.
    const r = gw.trackRemoteBranch(clone, "origin/WEB-1-alpha");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already have a local");
  });

  it("refuses a ref whose prefix is not a remote", () => {
    // Without this, a local branch literally called "origin/x" and a branch
    // called "x" on the remote "origin" are indistinguishable.
    expect(gw.trackRemoteBranch(clone, "nope/WEB-3-gamma").ok).toBe(false);
    expect(gw.trackRemoteBranch(clone, "WEB-3-gamma").ok).toBe(false);
  });

  it("refuses a remote branch this clone has never seen", () => {
    const r = gw.trackRemoteBranch(clone, "origin/never-fetched");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("fetch first");
  });
});

/** The sibling path the panel builds: `${root}-${branch}`. */
const sibling = (branch: string) => `${clone}-${branch}`;

describe("a remote branch as a worktree", () => {
  it("cuts the new branch from the remote ref, not from HEAD", () => {
    const path = sibling("WEB-3-gamma");
    expect(gw.addWorktree(clone, path, "WEB-3-gamma", true, "origin/WEB-3-gamma").ok).toBe(true);
    // The point of passing a start point at all: without it the worktree would
    // hold a copy of main under the ticket's name.
    expect(run(path, "rev-parse", "HEAD").stdout.trim())
      .toBe(run(clone, "rev-parse", "origin/WEB-3-gamma").stdout.trim());
    expect(run(path, "log", "-1", "--format=%s").stdout.trim()).toBe("work on WEB-3-gamma");
  });

  it("reports the checkout that has it, so the list can offer to open it", () => {
    const b = gw.remoteBranches(clone, "origin").branches.find((x) => x.name === "WEB-3-gamma")!;
    expect(b.local).toBe(true);
    expect(b.worktree).toBe(sibling("WEB-3-gamma"));
  });

  it("refuses a start point that isn't here", () => {
    const r = gw.addWorktree(clone, sibling("x"), "x", true, "origin/not-a-branch");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("fetch first");
  });
});

describe("where a worktree may be created", () => {
  // The rule and its only caller disagreed from the first release: the panel
  // sends `${root}-${branch}`, and this refused everything but
  // `<repo>/.worktrees/`. Every press of "+ add worktree" failed.
  it("accepts the sibling directory the panel actually asks for", () => {
    expect(gw.addWorktree(clone, sibling("WEB-2-beta-wt"), "WEB-2-beta-wt", true).ok).toBe(true);
  });

  it("still accepts the nested layout", () => {
    expect(gw.addWorktree(clone, join(clone, ".worktrees", "nested"), "nested", true).ok).toBe(true);
  });

  it("refuses anywhere else", () => {
    // A full checkout planted in a served web root or an autostart directory is
    // the thing the confinement exists to prevent.
    for (const p of [join(dir, "elsewhere"), join(dir, "sub", "deep"), "/tmp/agx-not-here", join(clone, "inside")]) {
      const r = gw.addWorktree(clone, p, "nope", true);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("worktree path must be");
    }
  });

  it("refuses a sibling that merely shares the parent", () => {
    // `clone2` is next to `clone` and is not `clone-something`.
    const r = gw.addWorktree(clone, join(dir, "clone2"), "nope", true);
    expect(r.ok).toBe(false);
  });

  it("cannot climb out with ..", () => {
    const r = gw.addWorktree(clone, join(clone, "..", "..", "escape"), "nope", true);
    expect(r.ok).toBe(false);
  });
});

describe("logGraph scope", () => {
  // The complaint this comes from: standing in a worktree on a ticket branch
  // and reading a log whose top commits belonged to other people's branches.
  it("defaults to the history of the checkout you are in", () => {
    run(clone, "checkout", "-q", "main");
    const r = gw.logGraph(clone, 100);
    expect(r.scope).toBe("head");
    expect(r.branch).toBe("main");
    const subjects = r.lines.map((l) => l.subject).filter(Boolean);
    expect(subjects).toContain("first");
    expect(subjects).not.toContain("work on WEB-3-gamma");
  });

  it("reads the whole graph when asked to", () => {
    const subjects = gw.logGraph(clone, 100, "all").lines.map((l) => l.subject).filter(Boolean);
    expect(subjects).toContain("work on WEB-3-gamma");
    expect(subjects).toContain("first");
  });

  it("names the branch it read, from whichever checkout asked", () => {
    // Each worktree is its own HEAD — the pane has to be able to say which one
    // it is showing.
    expect(gw.logGraph(sibling("WEB-3-gamma"), 20).branch).toBe("WEB-3-gamma");
    expect(gw.logGraph(sibling("WEB-3-gamma"), 20).lines.map((l) => l.subject)).toContain("work on WEB-3-gamma");
  });
});

describe("worktreesWithState", () => {
  it("counts what is uncommitted in each checkout, one by one", async () => {
    const wt = sibling("WEB-3-gamma");
    writeFileSync(join(wt, "scratch.txt"), "untracked\n");
    const by = new Map((await gw.worktreesWithState(clone)).map((w) => [w.path, w]));
    // Per checkout, not repo-wide: the whole point is that one worktree being
    // dirty says nothing about the next one.
    expect(by.get(wt)!.dirty).toBe(1);
    expect(by.get(sibling("WEB-2-beta-wt"))!.dirty).toBe(0);
  });

  it("agrees with what syncFromBase will actually do", async () => {
    // The button is disabled off this number, so if the two ever disagree the
    // panel either blocks a merge git would have allowed or offers one it
    // won't.
    const wt = sibling("WEB-3-gamma");
    const dirty = (await gw.worktreesWithState(clone)).find((w) => w.path === wt)!.dirty!;
    expect(dirty).toBeGreaterThan(0);
    const r = gw.syncFromBase(wt, "main");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("commit or stash");
  });
});
