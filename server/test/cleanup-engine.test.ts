// The post-merge cleanup engine on real git repositories in a temp directory,
// with docker/gh/tmux/psql faked behind the injected Runner.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLEANUP_GROUPS, CleanupError, matchesSlug, parseCleanupConfig, parseCleanupInclude, planCleanup, runCleanup, shouldAutoClean, slugOf, type CleanupConfig, type CleanupGroup, type CleanupPlan } from "../src/cleanup.ts";
import { BRANCH, PR, SLUG, URL77, makeWorld, put, read, type World } from "./cleanupFixture.ts";

let w: World;
afterEach(() => w?.cleanup());

const SERVICE_DIR = (wt: string) => `com.docker.compose.project=orbit,com.docker.compose.project.working_dir=${wt}`;

/** A world with a bit of everything the steps look at. */
function busyWorld(): { cfg: CleanupConfig } {
  w = makeWorld();
  w.containers = [
    { name: "orbit-run-a1b2", state: "running", image: "orbit-django:orbit-1042" },
    { name: "orbit-db", state: "running", image: "postgres:16", labels: SERVICE_DIR(w.wt) },
    { name: "orbit-run-c3d4", state: "exited", image: "orbit-django:orbit-2000" },
  ];
  w.images = [
    { repo: "orbit-django", tag: "orbit-1042", id: "aaa111aaa111", size: "6.14GB" },
    { repo: "orbit-django", tag: "0d03deb80f2", id: "bbb222bbb222", size: "6.1GB" },
    { repo: "orbit-django", tag: "orbit-2000", id: "ccc333ccc333", size: "6.1GB" },
  ];
  w.volumes = ["orbit-pycache-ORBIT-1042", "orbit-pycache-checkout-12"];
  w.dbs = ["postgres", "acme_test_ORBIT-1042", "acme_test_ORBIT-2000", "other_ORBIT-1042"];
  const ev = join(w.home, "evidence"), notes = join(w.home, "notes"), briefs = join(w.home, "briefs");
  put(join(ev, "ORBIT-1042-pol-fix", "shot.png"), "x".repeat(2000)); put(join(ev, "ORBIT-10420-pol", "a.png")); put(join(ev, "ORBIT-2000-pol", "a.png"));
  put(join(notes, "ORBIT-1042-ci-run.md")); put(join(notes, "ORBIT-1042-design.md")); put(join(notes, "ORBIT-2000-ci-x.md"));
  put(join(briefs, "ORBIT-1042-brief.md"), "brief"); put(join(briefs, "ORBIT-2000-brief.md"));
  return {
    cfg: w.cfg({
      sharedContainerNames: ["orbit-db"], testDbPrefix: "acme_test_", testDbCommand: "psql -h localhost -U dev",
      evidenceDirs: [join(ev, "{slug}-pol")], notesDirs: [notes], transientMarkers: ["-ci-", "-rerun-"], briefsDir: briefs, worklogDir: join(w.home, "worklog"),
    }),
  };
}

describe("merged pull request, everything configured", () => {
  test("the dry run lists the steps in order, touching nothing", async () => {
    const { cfg } = busyWorld();
    const plan = await planCleanup(w.main, PR, cfg, w.ctx());
    expect(plan.blocks).toEqual([]);
    expect(plan.slug).toBe(SLUG);
    expect(plan.items.map((i) => i.kind)).toEqual([
      "docker-container", "docker-volume", "docker-image", "test-db", "worktree", "branch", "fetch-prune", "stash", "evidence", "note", "brief", "own-state", "worklog",
    ]);
    expect(plan.items.map((i) => i.target)).toContain("orbit-run-a1b2");
    expect(plan.items.find((i) => i.kind === "evidence")!.target).toEndWith("ORBIT-1042-pol-fix");
    expect(existsSync(w.wt)).toBe(true);
    expect(w.calls.some((c) => /^docker (stop|rm|rmi)/.test(c))).toBe(false);
  });

  test("a run removes exactly the plan, saves the stash patch before dropping it, and reports the disk freed", async () => {
    const { cfg } = busyWorld();
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(rep.items.filter((i) => i.status === "failed")).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.freedBytes).toBeGreaterThan(0);

    expect(existsSync(w.wt)).toBe(false);
    expect(w.git(w.main, "branch", "--list", BRANCH)).toBe("");
    expect(w.git(w.main, "stash", "list")).toBe("");
    const archive = join(w.state, "cleanup-archive", "orbit");
    const patch = readdirSync(archive).map((f) => read(join(archive, f))).join("");
    expect(patch).toContain("scratch idea");

    expect(w.containers.map((c) => c.name)).toEqual(["orbit-db", "orbit-run-c3d4"]);
    expect(w.images.map((i) => `${i.repo}:${i.tag}`)).toEqual(["orbit-django:0d03deb80f2", "orbit-django:orbit-2000"]);
    expect(w.volumes).toEqual(["orbit-pycache-checkout-12"]);
    expect(w.dbs).toEqual(["postgres", "acme_test_ORBIT-2000", "other_ORBIT-1042"]);
    const stop = w.calls.indexOf("docker stop orbit-run-a1b2"), rm = w.calls.indexOf("docker rm orbit-run-a1b2"), rmi = w.calls.indexOf("docker rmi orbit-django:orbit-1042");
    expect(stop).toBeGreaterThan(-1); expect(rm).toBeGreaterThan(stop); expect(rmi).toBeGreaterThan(rm);
    expect(w.calls.filter((c) => /compose|network|prune|system/.test(c))).toEqual([]);

    const ev = join(w.home, "evidence");
    expect(readdirSync(ev).sort()).toEqual(["ORBIT-10420-pol", "ORBIT-2000-pol"]);
    expect(readdirSync(join(w.home, "notes")).sort()).toEqual(["ORBIT-1042-design.md", "ORBIT-2000-ci-x.md"]);
    expect(readdirSync(join(w.home, "briefs")).sort()).toEqual(["ORBIT-2000-brief.md", "archive"]);
    expect(read(join(w.home, "briefs", "archive", "ORBIT-1042-brief.md"))).toBe("brief");
    expect(read(join(w.home, "worklog", "2026-10-29.md"))).toBe(`- PR merged: Fix the thing ${URL77}\n`);
    expect(w.forgot).toEqual([{ repo: w.main, pr: PR, worktree: w.wt }]);
  });

  test("a second plan finds the pull request already in the worklog", async () => {
    const { cfg } = busyWorld();
    put(join(w.home, "worklog", "2026-10-29.md"), `- Working x\n- PR merged: Fix ${URL77}\n`);
    const plan = await planCleanup(w.main, PR, cfg, w.ctx());
    expect(plan.items.some((i) => i.kind === "worklog")).toBe(false);
  });

  test("an unticked item is left alone; an id that is not in the plan is refused", async () => {
    const { cfg } = busyWorld();
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    await expect(runCleanup(w.main, PR, cfg, ctx, { planId: plan.id, exclude: ["docker-container:nope"] })).rejects.toThrow(/no such plan item/);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id, exclude: ["docker-container:orbit-run-a1b2", "note:" + join(w.home, "notes", "ORBIT-1042-ci-run.md")] });
    expect(rep.items.filter((i) => i.status === "skipped").map((i) => i.kind)).toEqual(["docker-container", "note"]);
    expect(w.containers.map((c) => c.name)).toContain("orbit-run-a1b2");
    expect(existsSync(join(w.home, "notes", "ORBIT-1042-ci-run.md"))).toBe(true);
    expect(existsSync(w.wt)).toBe(false);
  });

  test("a plan id from before the state changed is refused and nothing runs", async () => {
    const { cfg } = busyWorld();
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    w.containers.push({ name: "orbit-run-new", state: "running", image: "orbit-django:orbit-1042" });
    const err = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id }).catch((e) => e);
    expect(err).toBeInstanceOf(CleanupError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/state changed/);
    expect(existsSync(w.wt)).toBe(true);
    expect(w.calls.some((c) => /^docker (stop|rm|rmi)/.test(c))).toBe(false);
    await expect(runCleanup(w.main, PR, cfg, ctx, { planId: "" })).rejects.toThrow(/state changed/);
    // a new commit in the checkout changes the id too
    const second = await planCleanup(w.main, PR, cfg, ctx);
    w.git(w.wt, "commit", "-q", "--allow-empty", "-m", "late");
    expect((await planCleanup(w.main, PR, cfg, ctx)).id).not.toBe(second.id);
  });

  test("the plan is the same whichever checkout of the repository is named", async () => {
    const { cfg } = busyWorld();
    const a = await planCleanup(w.main, PR, cfg, w.ctx()), b = await planCleanup(w.wt, PR, cfg, w.ctx());
    expect(b.id).toBe(a.id);
  });
});

describe("closed without a merge", () => {
  test("the run needs confirmNotMerged, and no worklog line is written", async () => {
    const { cfg } = busyWorld();
    w.pr = { ...w.pr, state: "CLOSED", mergedAt: null, mergeCommit: null };
    const ctx = w.ctx();
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    expect(plan.notMerged).toBe(true);
    expect(plan.items.some((i) => i.kind === "worklog")).toBe(false);
    await expect(runCleanup(w.main, PR, cfg, ctx, { planId: plan.id })).rejects.toThrow(/confirmNotMerged/);
    expect(existsSync(w.wt)).toBe(true);
    const rep = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id, confirmNotMerged: true });
    expect(rep.ok).toBe(true);
    expect(existsSync(w.wt)).toBe(false);
    expect(existsSync(join(w.home, "worklog"))).toBe(false);
  });
});

describe("no card id in the branch", () => {
  test("slug steps are skipped with a visible note; worktree, branch and stash are still planned", async () => {
    w = makeWorld({ branch: "hotfix-login" });
    w.containers = [{ name: "orbit-run-a", state: "running", image: "orbit-django:hotfix-login" }];
    const plan = await planCleanup(w.main, PR, w.cfg({ evidenceDirs: [join(w.home, "evidence", "{slug}")] }), w.ctx());
    expect(plan.slug).toBeNull();
    expect(plan.notes.join("\n")).toMatch(/no card id prefix/);
    expect(plan.items.map((i) => i.kind)).toEqual(["worktree", "branch", "fetch-prune", "stash", "own-state"]);
    expect(w.calls.some((c) => c.startsWith("docker"))).toBe(false);
  });
});

describe("what a name has to look like", () => {
  test("slugOf: a card id prefix of 4 or more characters with a digit", () => {
    expect(slugOf("ORBIT-1042-fix-x")).toBe("ORBIT-1042");
    expect(slugOf("feat/orbit-1042")).toBeNull();
    expect(slugOf("A-1-x")).toBeNull();
    expect(slugOf("hotfix-login")).toBeNull();
  });
  test("matchesSlug: contained, any case, never glued to another digit or letter", () => {
    expect(matchesSlug("orbit-django:orbit-1042", SLUG)).toBe(true);
    expect(matchesSlug("pycache_ORBIT-1042_db", SLUG)).toBe(true);
    expect(matchesSlug("orbit-10420", SLUG)).toBe(false);
    expect(matchesSlug("subORBIT-1042", SLUG)).toBe(false);
    expect(matchesSlug("ORBIT-104", SLUG)).toBe(false);
  });
});

describe("Docker selection (measured on a real machine)", () => {
  test("a shared container carrying this checkout's compose working_dir is not selected; a container using the slug image is, whatever its name", async () => {
    w = makeWorld();
    w.containers = [
      { name: "orbit-db", state: "running", image: "postgres:16", labels: SERVICE_DIR(w.wt) },
      { name: "orbit-redis", state: "running", image: "redis:7", labels: SERVICE_DIR(w.wt) },
      { name: "orbit-agent-run-9f8e", state: "exited", image: "orbit-django:orbit-1042", labels: "com.docker.compose.project=orbit" },
    ];
    w.images = [{ repo: "orbit-django", tag: "orbit-1042", id: "aaa111aaa111", size: "1GB" }, { repo: "orbit-django", tag: "9a8b7c6d5e4", id: "ddd444ddd444", size: "1GB" }];
    w.volumes = ["orbit-node-modules-app", "orbit-pycache-checkout-12"];
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx());
    const dockerItems = plan.items.filter((i) => i.kind.startsWith("docker")).map((i) => i.target);
    expect(dockerItems).toEqual(["orbit-agent-run-9f8e", "orbit-django:orbit-1042"]);
    expect(plan.notes.join("\n")).toContain("orbit-db is attached to this checkout by a compose label, not removed");
    expect(w.calls.some((c) => /network/.test(c))).toBe(false);
  });

  test("an image a container that stays is running is kept", async () => {
    w = makeWorld();
    w.containers = [{ name: "orbit-live", state: "running", image: "orbit-django:orbit-1042" }];
    w.images = [{ repo: "orbit-django", tag: "orbit-1042", id: "aaa111aaa111", size: "1GB" }];
    const plan = await planCleanup(w.main, PR, w.cfg({ sharedContainerNames: ["orbit-live"] }), w.ctx());
    expect(plan.items.filter((i) => i.kind.startsWith("docker"))).toEqual([]);
    expect(plan.notes.join("\n")).toMatch(/kept container orbit-live.*\n.*kept image orbit-django:orbit-1042/);
  });

  test("the image tag template adds an exact ref, and only an existing one", async () => {
    w = makeWorld();
    w.images = [{ repo: "acme-app", tag: "orbit1042", id: "aaa111aaa111", size: "1GB" }, { repo: "acme-app", tag: "main", id: "eee555eee555", size: "1GB" }];
    expect((await planCleanup(w.main, PR, w.cfg(), w.ctx())).items.filter((i) => i.kind === "docker-image")).toEqual([]);
    const plan = await planCleanup(w.main, PR, w.cfg({ dockerImageTagTemplate: "acme-app:{slug}" }), w.ctx());
    expect(plan.items.filter((i) => i.kind === "docker-image")).toEqual([]);
    w.images.push({ repo: "acme-app", tag: "orbit-1042", id: "fff666fff666", size: "1GB" });
    const again = await planCleanup(w.main, PR, w.cfg({ dockerImageTagTemplate: "acme-app:{slug}" }), w.ctx());
    expect(again.items.filter((i) => i.kind === "docker-image").map((i) => i.target)).toEqual(["acme-app:orbit-1042"]);
  });

  test("docker not answering is a note, not a failure", async () => {
    w = makeWorld();
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx({ run: async (cmd, args, o) => (cmd === "docker" ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" } : w.ctx().run(cmd, args, o)) }));
    expect(plan.notes.join("\n")).toMatch(/docker did not answer/);
  });
});

describe("empty settings skip their steps", () => {
  test("nothing configured: no database, evidence, notes, briefs or worklog items", async () => {
    w = makeWorld();
    w.dbs = ["acme_test_ORBIT-1042"];
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx());
    expect(plan.items.map((i) => i.kind)).toEqual(["worktree", "branch", "fetch-prune", "stash", "own-state"]);
    expect(w.calls.some((c) => c.startsWith("psql"))).toBe(false);
  });
});

describe("settings", () => {
  test("parseCleanupConfig keeps what is valid and names what is not", () => {
    expect("value" in parseCleanupConfig({ testDbPrefix: "acme_test_" })).toBe(true);
    for (const bad of [
      [], { nope: 1 }, { briefsDir: "relative/dir" }, { evidenceDirs: ["/ev/{slug}/shots"] }, { evidenceDirs: ["/ev/plain"] },
      { testDbPrefix: "a;b" }, { sharedContainerNames: ["a b"] }, { dockerImageTagTemplate: "acme-app:latest" }, { transientMarkers: ["a/b"] },
    ]) expect(parseCleanupConfig(bad)).toHaveProperty("error");
  });
});

describe("include: the kinds a plan holds", () => {
  const only = (...g: CleanupGroup[]) => g;
  test("a kind not ticked is omitted from the plan, not a block, and is never touched", async () => {
    const { cfg } = busyWorld();
    const ctx = w.ctx();
    const full = await planCleanup(w.main, PR, cfg, ctx);
    const calls0 = w.calls.length;
    const slim = await planCleanup(w.main, PR, { ...cfg, include: only("worktree", "branch") }, ctx);
    expect(slim.blocks).toEqual([]);
    expect(slim.items.map((i) => i.kind)).toEqual(["worktree", "branch", "fetch-prune", "own-state", "worklog"]);
    expect(slim.id).not.toBe(full.id);
    expect(w.calls.slice(calls0).some((c) => c.startsWith("docker") || c.startsWith("psql"))).toBe(false);
    const rep = await runCleanup(w.main, PR, { ...cfg, include: only("worktree", "branch") }, ctx, { planId: slim.id });
    expect(rep.ok).toBe(true);
    expect(w.git(w.main, "stash", "list")).not.toBe("");
    expect(w.containers).toHaveLength(3);
    expect(existsSync(join(w.home, "evidence", "ORBIT-1042-pol-fix"))).toBe(true);
  });

  test("the plan id covers the ticks even when they change nothing in the list", async () => {
    w = makeWorld();
    const a = await planCleanup(w.main, PR, w.cfg(), w.ctx());
    const b = await planCleanup(w.main, PR, w.cfg({ include: only("docker", "worktree", "branch", "stashes", "evidence", "notes") }), w.ctx());
    expect(b.items).toEqual(a.items);
    expect(b.id).not.toBe(a.id);
  });

  test("evidence, notes and stashes are three ticks; briefs ride with notes and the database with docker", async () => {
    const { cfg } = busyWorld();
    const kindsFor = async (...g: CleanupGroup[]) => (await planCleanup(w.main, PR, { ...cfg, include: g }, w.ctx())).items.map((i) => i.kind).filter((k) => !["own-state", "worklog"].includes(k));
    expect(await kindsFor("notes")).toEqual(["note", "brief"]);
    expect(await kindsFor("evidence")).toEqual(["evidence"]);
    expect(await kindsFor("stashes")).toEqual(["stash"]);
    expect(await kindsFor("docker")).toEqual(["docker-container", "docker-volume", "docker-image", "test-db"]);
    expect(await kindsFor()).toEqual([]);
  });

  test("include is its own setting: the cleanup.config value refuses it, the include value refuses a stranger", () => {
    expect(parseCleanupConfig({ include: ["docker"] })).toHaveProperty("error");
    expect(parseCleanupInclude([...CLEANUP_GROUPS])).toEqual({ value: [...CLEANUP_GROUPS] });
    expect(parseCleanupInclude(["docker", "docker", "tab"])).toEqual({ value: ["docker", "tab"] });
    for (const bad of ["docker", ["secrets"], [1]]) expect(parseCleanupInclude(bad)).toHaveProperty("error");
  });
});

describe("shouldAutoClean", () => {
  const plan = (over: Partial<CleanupPlan> = {}) => ({ blocks: [], notMerged: false, state: "MERGED" as const, ...over });
  const NOW = Date.parse("2026-10-29T12:00:00Z"), DAY = 86_400_000;
  const dirty = { kind: "dirty" as const, why: "3 files with changes that are not committed" };

  test("auto cleans an unblocked merged plan at once, whatever the age", () => {
    expect(shouldAutoClean("auto", plan(), NOW - 1000, NOW, 0)).toEqual({ clean: true });
    expect(shouldAutoClean("auto", plan(), null, NOW, 7)).toEqual({ clean: true });
  });
  test("a blocked plan is never cleaned, and the answer is the block's own sentence", () => {
    for (const mode of ["auto", "ask", "atMerge"] as const) {
      expect(shouldAutoClean(mode, plan({ blocks: [dirty] }), NOW - 30 * DAY, NOW, 1)).toEqual({ clean: false, reason: dirty.why });
    }
  });
  test("off never cleans, even an old one with a day count", () => {
    expect(shouldAutoClean("off", plan(), NOW - 30 * DAY, NOW, 1)).toMatchObject({ clean: false, reason: expect.stringContaining("turned off") });
  });
  test("a pull request closed without a merge is never automatic", () => {
    expect(shouldAutoClean("auto", plan({ state: "CLOSED", notMerged: true }), null, NOW, 0)).toMatchObject({ clean: false, reason: expect.stringContaining("not merged") });
  });
  test("ask and atMerge clean only on the age rule: autoCleanDays above 0 and the merge that old", () => {
    for (const mode of ["ask", "atMerge"] as const) {
      expect(shouldAutoClean(mode, plan(), NOW - 30 * DAY, NOW, 0)).toMatchObject({ clean: false });
      expect(shouldAutoClean(mode, plan(), NOW - 6 * DAY, NOW, 7)).toMatchObject({ clean: false, reason: expect.stringContaining("after 7") });
      expect(shouldAutoClean(mode, plan(), NOW - 7 * DAY, NOW, 7)).toEqual({ clean: true });
      expect(shouldAutoClean(mode, plan(), null, NOW, 7)).toMatchObject({ clean: false, reason: expect.stringContaining("not known") });
    }
  });
});
