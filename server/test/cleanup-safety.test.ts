// Every reason the cleanup refuses or keeps something, one test each. Each
// guard was also broken on purpose to watch its test go red (see the commit).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CleanupError, planCleanup, removeUnder, runCleanup, type CleanupPlan } from "../src/cleanup.ts";
import { BRANCH, PR, fakeProcess, makeWorld, put, type FakePane, type World } from "./cleanupFixture.ts";

let w: World;
afterEach(() => w?.cleanup());

/** A pane in a tab called `window`, standing in the card's checkout. */
const pane = (w: World, window: string, windowId: string, cmd: string, over: Partial<FakePane> = {}): FakePane =>
  ({ session: "work", windowId, window, cwd: w.wt, cmd, pid: String(900 + Number(windowId.slice(1))), ...over });
const kinds = (p: CleanupPlan) => p.blocks.map((b) => b.kind);
/** The plan, and the proof that a run on its id is refused and removes nothing. */
async function refused(cfg = w.cfg()): Promise<CleanupPlan> {
  const ctx = w.ctx();
  const plan = await planCleanup(w.main, PR, cfg, ctx);
  expect(plan.blocks.length).toBeGreaterThan(0);
  const err = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id }).catch((e) => e);
  expect(err).toBeInstanceOf(CleanupError);
  expect(err.message).toMatch(/^refused:/);
  expect(w.git(w.main, "branch", "--list", BRANCH)).toContain(BRANCH);
  expect(w.git(w.main, "stash", "list")).not.toBe("");
  expect(w.calls.filter((c) => /^docker (stop|rm|rmi|run)/.test(c))).toEqual([]);
  return plan;
}

describe("blocks: the run refuses and names why", () => {
  test("uncommitted changes in the worktree list the files", async () => {
    w = makeWorld();
    writeFileSync(join(w.wt, "feature.txt"), "edited\n");
    writeFileSync(join(w.wt, "new.txt"), "x");
    const plan = await refused();
    expect(kinds(plan)).toEqual(["dirty"]);
    expect(plan.blocks[0]!.files).toEqual(["feature.txt", "new.txt"]);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("a local commit that is not in the pull request lists the commit", async () => {
    w = makeWorld();
    w.git(w.wt, "commit", "-q", "--allow-empty", "-m", "never pushed");
    const plan = await refused();
    expect(kinds(plan)).toEqual(["unpushed"]);
    expect(plan.blocks[0]!.files![0]).toContain("never pushed");
  });

  test("a commit that is in the merge commit is not unpushed (the branch was squashed or deleted on GitHub)", async () => {
    w = makeWorld();
    w.git(w.wt, "commit", "-q", "--allow-empty", "-m", "on the way");
    w.pr.mergeCommit = { oid: w.git(w.wt, "rev-parse", "HEAD") };
    w.git(w.main, "fetch", "-q", "origin");
    expect(kinds(await planCleanup(w.main, PR, w.cfg(), w.ctx()))).toEqual([]);
  });

  test("another open pull request with the branch as its head", async () => {
    w = makeWorld();
    w.openPrs.push({ number: 90, headRefName: BRANCH, baseRefName: "main" });
    expect(kinds(await refused())).toEqual(["open-pr-on-branch"]);
  });

  test("a stacked pull request that has the branch as its base", async () => {
    w = makeWorld();
    w.openPrs.push({ number: 91, headRefName: "ORBIT-1043-next", baseRefName: BRANCH });
    const plan = await refused();
    expect(kinds(plan)).toEqual(["stacked-pr"]);
    expect(plan.blocks[0]!.why).toContain("#91");
  });

  test("gh unable to list the open pull requests blocks, since the stack cannot be ruled out", async () => {
    w = makeWorld();
    const ctx = w.ctx({ gh: async (a) => (a[1] === "list" ? { code: 1, stdout: "", stderr: "offline" } : { code: 0, stdout: JSON.stringify(w.pr), stderr: "" }) });
    expect(kinds(await planCleanup(w.main, PR, w.cfg(), ctx))).toEqual(["unreadable"]);
  });

  test("a process whose cwd is inside the worktree", async () => {
    w = makeWorld();
    mkdirSync(join(w.wt, "sub"), { recursive: true });
    fakeProcess(w, 4242, join(w.wt, "sub"));
    const plan = await refused();
    expect(kinds(plan)).toEqual(["live-session"]);
    expect(plan.blocks[0]!.files![0]).toContain(join(w.wt, "sub"));
  });

  test("a tmux window named after the card", async () => {
    w = makeWorld();
    w.panes = [pane(w, "ORBIT-1042", "@5", "node"), pane(w, "ORBIT-10420", "@6", "node")];
    const plan = await refused();
    expect(plan.blocks[0]!.files).toContain("tmux window work:ORBIT-1042");
    expect(plan.blocks[0]!.files!.join()).not.toContain("ORBIT-10420 ");
  });

  test("the pull request's branch checked out in the main checkout", async () => {
    w = makeWorld({ mainOnBranch: true });
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx());
    expect(kinds(plan)).toEqual(["main-checkout"]);
    expect(plan.items.some((i) => i.kind === "worktree")).toBe(false);
    await expect(runCleanup(w.main, PR, w.cfg(), w.ctx(), { planId: plan.id })).rejects.toThrow(/main checkout/);
    expect(existsSync(w.main)).toBe(true);
  });

  test("the repository's default branch", async () => {
    w = makeWorld();
    w.pr.headRefName = "main";
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx());
    expect(kinds(plan)).toContain("default-branch");
    expect(plan.items.some((i) => i.kind === "branch")).toBe(false);
    await expect(runCleanup(w.main, PR, w.cfg(), w.ctx(), { planId: plan.id })).rejects.toThrow(/default branch/);
    expect(w.git(w.main, "branch", "--list", "main")).toContain("main");
  });

  test("an open pull request is not cleaned up", async () => {
    w = makeWorld();
    w.pr.state = "OPEN"; w.pr.mergedAt = null;
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx());
    expect(kinds(plan)).toEqual(["pr-open"]);
    expect(plan.items).toEqual([]);
  });
});

describe("things that are kept, with the rest still done", () => {
  test("a shared container name is never stopped, even when its image names the card", async () => {
    w = makeWorld();
    w.containers = [{ name: "orbit-shared", state: "running", image: "orbit-django:orbit-1042" }, { name: "orbit-run-1", state: "exited", image: "orbit-django:orbit-1042" }];
    const cfg = w.cfg({ sharedContainerNames: ["orbit-shared"] });
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(w.containers.map((c) => c.name)).toEqual(["orbit-shared"]);
    expect(w.containers[0]!.state).toBe("running");
    expect(w.calls.filter((c) => c.includes("orbit-shared"))).toEqual([]);
  });

  test("an image a running container outside the plan uses is not removed", async () => {
    w = makeWorld();
    w.containers = [{ name: "orbit-keep", state: "running", image: "orbit-django:orbit-1042" }];
    w.images = [{ repo: "orbit-django", tag: "orbit-1042", id: "aaa111aaa111", size: "1GB" }];
    // the container's name carries no card id and its image does, so only the shared list keeps it
    const cfg = w.cfg({ sharedContainerNames: ["orbit-keep"] });
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(w.images).toHaveLength(1);
    expect(w.calls.filter((c) => c.startsWith("docker rmi"))).toEqual([]);
  });

  test("a stash whose patch cannot be saved is not dropped", async () => {
    w = makeWorld();
    const blocked = join(w.root, "archive-is-a-file");
    writeFileSync(blocked, "not a directory");
    const cfg = w.cfg({ stashArchiveDir: blocked });
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    const stash = rep.items.find((i) => i.kind === "stash")!;
    expect(stash.status).toBe("failed");
    expect(stash.detail).toMatch(/stash is kept/);
    expect(w.git(w.main, "stash", "list")).toContain(BRANCH);
    expect(rep.ok).toBe(false);
  });

  test("the stash patch is written before the stash goes", async () => {
    w = makeWorld();
    const cfg = w.cfg({ stashArchiveDir: join(w.root, "archive") });
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(rep.items.find((i) => i.kind === "stash")!.detail).toMatch(/patch saved to .*\.patch; stash dropped/);
    const dir = join(w.root, "archive", "orbit");
    expect(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")).toContain("+scratch idea");
  });

  test("a failing fetch --prune is reported as a warning and nothing else is undone", async () => {
    w = makeWorld();
    w.git(w.main, "remote", "set-url", "origin", join(w.root, "gone.git"));
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, w.cfg(), ctx);
    const rep = await runCleanup(w.main, PR, w.cfg(), ctx, { planId: plan.id });
    expect(rep.items.find((i) => i.kind === "fetch-prune")!.status).toBe("warn");
    expect(rep.ok).toBe(true);
    expect(existsSync(w.wt)).toBe(false);
  });
});

describe("removing a checkout", () => {
  test("root-owned files: the container fallback removes it with a guarded rm, then git prunes", async () => {
    w = makeWorld();
    w.denyWorktreeRemove = true;
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, w.cfg(), ctx);
    const rep = await runCleanup(w.main, PR, w.cfg(), ctx, { planId: plan.id });
    expect(rep.items.find((i) => i.kind === "worktree")!.detail).toMatch(/by a container/);
    const run = w.calls.find((c) => c.startsWith("docker run"))!;
    expect(run).toContain(`-e D=orbit-${BRANCH} -v ${w.root}:/c alpine sh -c rm -rf "/c/\${D:?}"`);
    expect(existsSync(w.wt)).toBe(false);
    expect(w.git(w.main, "worktree", "list")).not.toContain(BRANCH);
  });

  test("the rm built from a variable keeps its ${VAR:?} guard in the source", () => {
    const src = readFileSync(new URL("../src/cleanup.ts", import.meta.url), "utf8");
    expect(src).toContain(`'rm -rf "/c/\${D:?}"'`);
    expect(src.split("\n").filter((l) => /rm -rf/.test(l) && !l.trim().startsWith("//") && !l.includes("${D:?}"))).toEqual([]);
  });

  test("removeUnder takes one plain name under an absolute parent and nothing else", () => {
    w = makeWorld();
    const keep = put(join(w.root, "keep", "a.txt"));
    for (const [parent, name] of [["/", "x"], ["relative", "x"], [w.root, ""], [w.root, "."], [w.root, ".."], [w.root, "keep/a.txt"], [w.root, "../keep"]] as const) {
      expect(() => removeUnder(parent, name)).toThrow(/refusing/);
    }
    expect(existsSync(keep)).toBe(true);
    removeUnder(join(w.root, "keep"), "a.txt");
    expect(existsSync(keep)).toBe(false);
  });

  test("a link in an evidence folder is removed as a link, never followed", async () => {
    w = makeWorld();
    const precious = put(join(w.root, "elsewhere", "precious.txt"), "keep me");
    const ev = join(w.home, "evidence");
    mkdirSync(ev, { recursive: true });
    symlinkSync(join(w.root, "elsewhere"), join(ev, "ORBIT-1042-pol-link"));
    const cfg = w.cfg({ evidenceDirs: [join(ev, "{slug}-pol")] });
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(existsSync(join(ev, "ORBIT-1042-pol-link"))).toBe(false);
    expect(readFileSync(precious, "utf8")).toBe("keep me");
  });

  test("a folder that is the home or the root is never listed for evidence, notes or briefs", async () => {
    w = makeWorld();
    put(join(w.home, "ORBIT-1042-ci-x.md"));
    const plan = await planCleanup(w.main, PR, w.cfg({ notesDirs: [w.home], transientMarkers: ["-ci-"], briefsDir: w.home }), w.ctx());
    expect(plan.items.filter((i) => ["note", "brief", "evidence"].includes(i.kind))).toEqual([]);
  });

  test("a run touches nothing but what the plan names: bystander checkouts, folders and files are intact", async () => {
    w = makeWorld();
    const other = join(w.root, "orbit-ORBIT-2000-other");
    w.git(w.main, "worktree", "add", "-q", other, "-b", "ORBIT-2000-other");
    const notes = join(w.home, "notes");
    const bystanders = [put(join(other, "work.txt")), put(join(notes, "ORBIT-2000-ci-x.md")), put(join(w.home, "evidence", "ORBIT-2000-pol", "a.png"))];
    const before = readdirSync(w.root).sort();
    const cfg = w.cfg({ notesDirs: [notes], transientMarkers: ["-ci-"], evidenceDirs: [join(w.home, "evidence", "{slug}-pol")] });
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(rep.ok).toBe(true);
    for (const b of bystanders) expect(existsSync(b)).toBe(true);
    expect(w.git(w.main, "branch", "--list", "ORBIT-2000-other")).toContain("ORBIT-2000-other");
    expect(readdirSync(w.root).sort()).toEqual(before.filter((n) => n !== `orbit-${BRANCH}`));
    // every path the report names is under the temp machine
    for (const i of rep.items) if (i.target.startsWith("/")) expect(i.target.startsWith(w.root)).toBe(true);
  });
});

describe("the card's tab", () => {
  test("a tab of idle shells in the checkout is closed, before the checkout goes, and is not a block", async () => {
    w = makeWorld();
    w.panes = [pane(w, "ORBIT-1042", "@5", "bash"), pane(w, "ORBIT-1042", "@5", "zsh", { pid: "951" })];
    fakeProcess(w, 905, w.wt); fakeProcess(w, 951, w.wt);
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, w.cfg(), ctx);
    expect(plan.blocks).toEqual([]);
    expect(plan.items[0]).toMatchObject({ kind: "tab", target: "work:ORBIT-1042 (@5)" });
    const rep = await runCleanup(w.main, PR, w.cfg(), ctx, { planId: plan.id });
    expect(rep.items[0]).toMatchObject({ kind: "tab", status: "done" });
    expect(w.calls).toContain("tmux kill-window -t @5");
    expect(w.panes).toEqual([]);
    expect(existsSync(w.wt)).toBe(false);
  });

  test("a tab with a program running is a live-session block, and nothing is closed", async () => {
    w = makeWorld();
    w.panes = [pane(w, "ORBIT-1042", "@5", "bash"), pane(w, "ORBIT-1042", "@5", "node", { pid: "951" })];
    const plan = await refused();
    expect(kinds(plan)).toEqual(["live-session"]);
    expect(plan.items.some((i) => i.kind === "tab")).toBe(false);
    expect(w.calls.filter((c) => c.includes("kill-window"))).toEqual([]);
  });

  test("a tab with a shell that is not in the checkout is a block", async () => {
    w = makeWorld();
    w.panes = [pane(w, "ORBIT-1042", "@5", "bash", { cwd: w.home })];
    expect(kinds(await refused())).toEqual(["live-session"]);
  });

  test("a tab the plan was told not to close stays a block", async () => {
    w = makeWorld();
    w.panes = [pane(w, "ORBIT-1042", "@5", "bash")];
    const cfg = w.cfg({ include: ["docker", "worktree", "branch", "stashes", "evidence", "notes"] });
    expect(kinds(await planCleanup(w.main, PR, cfg, w.ctx()))).toEqual(["live-session"]);
  });

  test("an idle shell of the card's tab does not hide a program of the same checkout in a process", async () => {
    w = makeWorld();
    w.panes = [pane(w, "ORBIT-1042", "@5", "bash")];
    fakeProcess(w, 905, w.wt);
    fakeProcess(w, 4242, join(w.wt, "."));
    expect(kinds(await planCleanup(w.main, PR, w.cfg(), w.ctx()))).toEqual(["live-session"]);
  });

  test("a pane in another tab with its cwd in the checkout is a block", async () => {
    w = makeWorld();
    w.panes = [pane(w, "scratch", "@9", "bash")];
    expect(kinds(await planCleanup(w.main, PR, w.cfg(), w.ctx()))).toEqual(["live-session"]);
  });
});
