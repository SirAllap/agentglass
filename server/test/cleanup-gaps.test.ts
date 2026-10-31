// Evidence roots, the agent's own folders per checkout, and the build cache,
// on real git in a temp directory with a fake home and fake docker.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentPaths, branchSlug, evidenceNameMatches, parseCleanupEvidenceRoots, planCleanup, runCleanup, runItem, type CleanupPlan } from "../src/cleanup.ts";
import { buildCacheSize, pruneBuildCache } from "../src/buildCache.ts";
import type { Runner } from "../src/diskclean.ts";
import { BRANCH, PR, fakeProcess, makeWorld, put, type World } from "./cleanupFixture.ts";

let w: World;
afterEach(() => w?.cleanup());
const UID = 1234;
const kinds = (p: CleanupPlan) => p.items.map((i) => i.kind);
const runIt = (cfg = w.cfg(), over = {}) => planCleanup(w.main, PR, cfg, w.ctx({ uid: UID, ...over })).then((p) => runCleanup(w.main, PR, cfg, w.ctx({ uid: UID, ...over }), { planId: p.id }));

describe("evidence roots", () => {
  const root = () => join(w.home, "Documents", "projects", "orbit");

  test("the name rule: card id (case-insensitive, not glued to another digit) or the branch slug", () => {
    expect(evidenceNameMatches("ORBIT-1042-PoL-checkout-timeout", "ORBIT-1042", "ORBIT-1042-fix-x")).toBe(true);
    expect(evidenceNameMatches("orbit-1042", "ORBIT-1042", "ORBIT-1042-fix-x")).toBe(true);
    expect(evidenceNameMatches("ORBIT-10420-PoL", "ORBIT-1042", "ORBIT-1042-fix-x")).toBe(false);
    expect(evidenceNameMatches("my-ORBIT-1042", "ORBIT-1042", "ORBIT-1042-fix-x")).toBe(false);
    expect(evidenceNameMatches("Fix-Cleanup-Gaps-shots", null, "fix/cleanup-gaps")).toBe(true);
    expect(evidenceNameMatches("fix-cleanup-gapsXL", null, "fix/cleanup-gaps")).toBe(false);
    expect(branchSlug("fix")).toBeNull();
    expect(evidenceNameMatches("fix-anything", null, "fix")).toBe(false);
  });

  test("a folder named by the card id (any case) or by the branch is found and removed; the others and the root stay", async () => {
    w = makeWorld();
    put(join(root(), "orbit-1042-pol-checkout", "a.png"), "x".repeat(500));
    put(join(root(), "ORBIT-1042-fix-x-extra", "b.png"));
    put(join(root(), "ORBIT-10420-pol", "c.png")); put(join(root(), "ORBIT-2000-pol", "d.png")); put(join(root(), "README.md"));
    const cfg = w.cfg({ evidenceRoots: [root()] });
    const plan = await planCleanup(w.main, PR, cfg, w.ctx());
    const ev = plan.items.filter((i) => i.kind === "evidence");
    expect(ev.map((i) => i.target).sort()).toEqual([join(root(), "ORBIT-1042-fix-x-extra"), join(root(), "orbit-1042-pol-checkout")]);
    expect(ev.find((i) => i.target.endsWith("pol-checkout"))!.bytes).toBeGreaterThan(0);
    const r = await runCleanup(w.main, PR, cfg, w.ctx(), { planId: plan.id });
    expect(r.items.filter((i) => i.kind === "evidence").map((i) => i.status)).toEqual(["done", "done"]);
    expect(existsSync(root())).toBe(true);
    expect(existsSync(join(root(), "ORBIT-10420-pol"))).toBe(true);
    expect(existsSync(join(root(), "ORBIT-2000-pol"))).toBe(true);
    expect(existsSync(join(root(), "orbit-1042-pol-checkout"))).toBe(false);
  });

  test("an empty folder named by the card beside the worktree (a container's baseline dir) goes; one with a file, or another card's, stays", async () => {
    w = makeWorld();
    const beside = dirname(w.wt);
    mkdirSync(join(beside, "ORBIT-1042-master", "compose"), { recursive: true });
    put(join(beside, "ORBIT-1042-notes", "keep.txt")); mkdirSync(join(beside, "ORBIT-2000-master", "compose"), { recursive: true });
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx({ home: join(w.root, "h", "me") }));
    expect(plan.items.filter((i) => i.kind === "evidence").map((i) => i.target)).toEqual([join(beside, "ORBIT-1042-master")]);
    await runCleanup(w.main, PR, w.cfg(), w.ctx({ home: join(w.root, "h", "me") }), { planId: plan.id });
    expect(existsSync(join(beside, "ORBIT-1042-master"))).toBe(false);
    expect(existsSync(join(beside, "ORBIT-1042-notes"))).toBe(true);
    expect(existsSync(join(beside, "ORBIT-2000-master"))).toBe(true);
  });

  test("nothing configured finds nothing and says why in one line; a root with no match says what it looked at", async () => {
    w = makeWorld();
    put(join(root(), "ORBIT-1042-pol", "a.png"));
    const none = await planCleanup(w.main, PR, w.cfg(), w.ctx());
    expect(kinds(none)).not.toContain("evidence");
    expect(none.notes.filter((n) => /evidence/.test(n))).toHaveLength(1);
    const miss = await planCleanup(w.main, PR, w.cfg({ evidenceRoots: [join(w.home, "elsewhere")] }), w.ctx());
    expect(miss.notes.find((n) => /no evidence folder found/.test(n))).toContain("elsewhere");
  });

  test("the run refuses a folder outside every root, a root itself, and a name that is not the card's, even from a forged plan item", async () => {
    w = makeWorld();
    put(join(root(), "ORBIT-1042-pol", "a.png"));
    put(join(w.home, "other", "ORBIT-1042-pol", "a.png"));
    const cfg = w.cfg({ evidenceRoots: [root()] });
    const plan = await planCleanup(w.main, PR, cfg, w.ctx());
    // the plan only lists the folder inside the root
    expect(plan.items.filter((i) => i.kind === "evidence").map((i) => i.target)).toEqual([join(root(), "ORBIT-1042-pol")]);
    // a root named like the card is never listed as a match of itself: the root's own children only
    const nested = join(w.home, "ORBIT-1042-root");
    put(join(nested, "ORBIT-1042-inside", "a.png"));
    const p2 = await planCleanup(w.main, PR, w.cfg({ evidenceRoots: [nested] }), w.ctx());
    expect(p2.items.filter((i) => i.kind === "evidence").map((i) => i.target)).toEqual([join(nested, "ORBIT-1042-inside")]);
    await runCleanup(w.main, PR, w.cfg({ evidenceRoots: [nested] }), w.ctx(), { planId: p2.id });
    expect(existsSync(nested)).toBe(true);
    // forged items, straight to the removal: outside the root, the root itself, a name that is not the card's
    const forge = (target: string) => runItem({ id: `evidence:${target}`, kind: "evidence", target, detail: "" }, plan, cfg, w.ctx());
    put(join(root(), "ORBIT-2000-pol", "d.png"));
    for (const t of [join(w.home, "other", "ORBIT-1042-pol"), root(), join(root(), "ORBIT-2000-pol")]) expect((await forge(t)).status).toBe("failed");
    expect(existsSync(join(w.home, "other", "ORBIT-1042-pol"))).toBe(true);
    expect(existsSync(root())).toBe(true);
    expect(existsSync(join(root(), "ORBIT-2000-pol"))).toBe(true);
  });

  test("a link inside a root is removed as a link, never followed", async () => {
    w = makeWorld();
    put(join(w.home, "precious", "keep.txt"));
    mkdirSync(root(), { recursive: true });
    symlinkSync(join(w.home, "precious"), join(root(), "ORBIT-1042-link"));
    const cfg = w.cfg({ evidenceRoots: [root()] });
    await runIt(cfg);
    expect(existsSync(join(w.home, "precious", "keep.txt"))).toBe(true);
    expect(existsSync(join(root(), "ORBIT-1042-link"))).toBe(false);
  });

  test("the setting value refuses relative paths, the filesystem root and a bare top folder", () => {
    for (const bad of [["rel/ev"], ["/"], ["/home"], ["~"], ["/a/../b/c"], "x", [""]]) expect(parseCleanupEvidenceRoots(bad)).toHaveProperty("error");
    expect(parseCleanupEvidenceRoots(["~/Documents/projects/orbit/", "~/Documents/projects/orbit"])).toEqual({ value: ["~/Documents/projects/orbit"] });
  });
});

describe("agent folders per checkout", () => {
  const seed = () => {
    const p = agentPaths(w.wt, w.home, UID);
    for (const d of [...p.scratch, ...p.history]) put(join(d, "f.bin"), "x".repeat(1000));
    // a neighbour with a longer key and a parent that must survive
    put(join(w.home, ".cache", "claude-cli-nodejs", `${w.wt.replaceAll("/", "-")}-other`, "f.bin"));
    put(join(w.home, ".claude", "projects", "-some-other-checkout", "f.bin"));
    return p;
  };

  test("the paths are the exact key of the checkout, three folders, the home injected", () => {
    const p = agentPaths("/work/orbit-ORBIT-1042", "/h", 7);
    expect(p).toEqual({ scratch: ["/h/.cache/claude-cli-nodejs/-work-orbit-ORBIT-1042", "/h/.cache/claude-tmp/7/-work-orbit-ORBIT-1042"], history: ["/h/.claude/projects/-work-orbit-ORBIT-1042"] });
    expect(agentPaths("/", "/h", 7)).toEqual({ scratch: [], history: [] });
    expect(agentPaths("relative/x", "/h", 7)).toEqual({ scratch: [], history: [] });
  });

  test("scratch is in the default plan with sizes, history only when ticked, and a run removes exactly those", async () => {
    w = makeWorld();
    const p = seed();
    const def = await planCleanup(w.main, PR, w.cfg(), w.ctx({ uid: UID }));
    expect(def.items.filter((i) => i.kind === "agent-scratch").map((i) => i.target)).toEqual(p.scratch);
    expect(def.items.find((i) => i.kind === "agent-scratch")!.bytes).toBeGreaterThan(0);
    expect(kinds(def)).not.toContain("agent-history");

    const all = w.cfg({ include: [...w.cfg().include, "agent-history"] });
    const plan = await planCleanup(w.main, PR, all, w.ctx({ uid: UID }));
    const hist = plan.items.find((i) => i.kind === "agent-history")!;
    expect(hist.target).toBe(p.history[0]!);
    expect(hist.detail).toBe("Kept so you can resume or read what the agent did");
    const r = await runCleanup(w.main, PR, all, w.ctx({ uid: UID }), { planId: plan.id });
    expect(r.items.filter((i) => i.kind.startsWith("agent-")).map((i) => i.status)).toEqual(["done", "done", "done"]);
    for (const d of [...p.scratch, ...p.history]) expect(existsSync(d)).toBe(false);
    // neither a longer key, another checkout's folder, nor a parent went
    expect(existsSync(join(w.home, ".cache", "claude-cli-nodejs", `${w.wt.replaceAll("/", "-")}-other`))).toBe(true);
    expect(existsSync(join(w.home, ".claude", "projects", "-some-other-checkout"))).toBe(true);
    for (const d of [join(w.home, ".claude", "projects"), join(w.home, ".cache", "claude-tmp", String(UID))]) expect(existsSync(d)).toBe(true);
  });

  test("history unticked is left alone when the scratch goes", async () => {
    w = makeWorld();
    const p = seed();
    const r = await runIt();
    expect(r.ok).toBe(true);
    expect(existsSync(p.history[0]!)).toBe(true);
    expect(existsSync(p.scratch[0]!)).toBe(false);
  });

  test("a live session in the checkout holds the plan, so the agent folders stay", async () => {
    w = makeWorld();
    const p = seed();
    fakeProcess(w, 4242, join(w.wt, "sub"));
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx({ uid: UID }));
    expect(plan.blocks.map((b) => b.kind)).toContain("live-session");
    await expect(runCleanup(w.main, PR, w.cfg(), w.ctx({ uid: UID }), { planId: plan.id })).rejects.toThrow(/refused/);
    expect(existsSync(p.scratch[0]!)).toBe(true);
  });

  test("a folder that is not the checkout's own derived path is refused by the run, whatever the plan says", async () => {
    w = makeWorld();
    seed();
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx({ uid: UID }));
    const forge = (kind: "agent-scratch" | "agent-history", target: string) => runItem({ id: `${kind}:${target}`, kind, target, detail: "" }, plan, w.cfg(), w.ctx({ uid: UID }));
    const p = agentPaths(w.wt, w.home, UID);
    for (const t of [join(w.home, ".cache", "claude-cli-nodejs"), join(w.home, ".claude", "projects"), join(w.home, ".cache", "claude-cli-nodejs", `${w.wt.replaceAll("/", "-")}-other`), p.history[0]!]) {
      expect((await forge("agent-scratch", t)).status).toBe("failed");
    }
    expect((await forge("agent-history", p.scratch[0]!)).status).toBe("failed");
    expect(existsSync(join(w.home, ".cache", "claude-cli-nodejs", `${w.wt.replaceAll("/", "-")}-other`))).toBe(true);
    expect(existsSync(p.scratch[0]!)).toBe(true);
    expect(existsSync(p.history[0]!)).toBe(true);
    // the checkout's own derived path is removed
    expect((await forge("agent-scratch", p.scratch[1]!)).status).toBe("done");
  });

  test("with no checkout (already removed) nothing is derived", async () => {
    w = makeWorld();
    seed();
    w.git(w.main, "worktree", "remove", "--force", w.wt);
    const plan = await planCleanup(w.main, PR, w.cfg(), w.ctx({ uid: UID }));
    expect(kinds(plan).filter((k) => k.startsWith("agent-"))).toEqual([]);
  });
});

describe("docker build cache", () => {
  const fake = (calls: string[], over: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}): Runner => async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const o = over[args.slice(0, 2).join(" ")];
    if (o) return { code: o.code ?? 0, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
    return { code: 127, stdout: "", stderr: "unexpected", missing: true };
  };
  const DU = "ID  RECLAIMABLE  SIZE\nabc  true  1GB\n\nShared:\t3GB\nPrivate:\t1GB\nReclaimable:\t49.12GB\nTotal:\t52.3GB\n";

  // Real shape: Reclaimable counts the shared records too, which only `--all` frees (plain prune keeps what a tagged image still references).
  test("the offered size is what the prune frees: --all, then what remains is read again", async () => {
    const calls: string[] = [];
    let pruned = false;
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args[1] === "prune") { pruned = true; return { code: 0, stdout: "Total:\t31.58GB\n", stderr: "" }; }
      return { code: 0, stdout: pruned ? "Reclaimable:\t0B\nTotal:\t90MB\n" : "Shared:\t31.53GB\nPrivate:\t43.11MB\nReclaimable:\t31.58GB\nTotal:\t31.67GB\n", stderr: "" };
    };
    expect((await buildCacheSize(run) as { reclaimableBytes: number }).reclaimableBytes).toBe(31_580_000_000);
    expect(await pruneBuildCache(run)).toEqual({ ok: true, freedBytes: 31_580_000_000, remainingBytes: 90_000_000 });
    expect(calls[1]).toBe("docker builder prune -a -f");
  });

  test("the size is read from buildx du and the prune is builder prune -a -f, then a second read", async () => {
    const calls: string[] = [];
    const run = fake(calls, { "buildx du": { stdout: DU }, "builder prune": { stdout: "Deleted build cache objects:\nabc\nTotal:\t12.3GB\n" } });
    expect(await buildCacheSize(run)).toEqual({ ok: true, reclaimableBytes: 49_120_000_000, totalBytes: 52_300_000_000 });
    expect(await pruneBuildCache(run)).toEqual({ ok: true, freedBytes: 12_300_000_000, remainingBytes: 52_300_000_000 });
    expect(calls).toEqual(["docker buildx du", "docker builder prune -a -f", "docker buildx du"]);
  });

  test("docker that fails is an error with the reason, not zero bytes", async () => {
    const run = fake([], { "buildx du": { code: 1, stderr: "Cannot connect to the Docker daemon\nmore" }, "builder prune": { code: 1, stderr: "boom" } });
    expect(await buildCacheSize(run)).toEqual({ ok: false, status: 502, error: "docker could not read the build cache: Cannot connect to the Docker daemon" });
    expect(await pruneBuildCache(run)).toMatchObject({ ok: false });
  });

  test("an empty cache with no trailer is zero", async () => {
    expect(await buildCacheSize(fake([], { "buildx du": { stdout: "ID RECLAIMABLE SIZE\n" } }))).toEqual({ ok: true, reclaimableBytes: 0, totalBytes: 0 });
  });
});
