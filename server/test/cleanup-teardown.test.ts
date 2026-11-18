// The repo's own teardown script runs from the MAIN checkout before the worktree is removed. Real git in a temp directory;
// the script itself is answered by a stub runner, so no real docker or script is reached.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLEANUP_REPORT_STATUS, TEARDOWN_KEPT, heldByWorktree, parseCleanupConfig, planCleanup, runCleanup, type CleanupPlan } from "../src/cleanup.ts";
import type { RunOut, Runner } from "../src/diskclean.ts";
import { BRANCH, PR, makeWorld, put, type World } from "./cleanupFixture.ts";

let w: World;
afterEach(() => w?.cleanup());
const cx = (over = {}) => w.ctx({ home: "/nonexistent/me", ...over });
const REL = "scripts/teardown.sh";
/** A script file in the main checkout (mode 0755 unless said otherwise). */
function script(rel = REL, mode = 0o755, body = "#!/bin/sh\n") {
  const p = join(w.main, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); chmodSync(p, mode); return p;
}
/** The fixture's runner, except that the script path answers `ans` and is recorded with its argv and cwd. */
function withScript(ans: RunOut | ((a: string[]) => RunOut), seen: { cmd: string; args: string[]; cwd?: string; timeoutMs?: number }[] = []) {
  const base = cx();
  const run: Runner = async (cmd, args, o) => {
    if (cmd.endsWith(REL)) { seen.push({ cmd, args, cwd: o?.cwd, timeoutMs: o?.timeoutMs }); return typeof ans === "function" ? ans(args) : ans; }
    return base.run(cmd, args, o);
  };
  return { ctx: { ...base, run }, seen };
}
const first = (p: CleanupPlan) => p.items[0]!;

describe("the setting", () => {
  test("a repo-relative path is kept; empty is off", () => {
    expect(parseCleanupConfig({ teardownScript: REL })).toEqual({ value: expect.objectContaining({ teardownScript: REL }) });
    expect(parseCleanupConfig({})).toEqual({ value: expect.objectContaining({ teardownScript: "" }) });
  });
  test.each(["../x", "/abs/x.sh", "~/x.sh", "a/../b.sh", "a\0b", "x".repeat(257)])("%j is a parse error with a sentence", (p) => {
    const r = parseCleanupConfig({ teardownScript: p });
    expect("error" in r && r.error.length > 10).toBe(true);
  });
});

describe("plan", () => {
  test("unset: no teardown item and no block", async () => {
    w = makeWorld(); script();
    const plan = await planCleanup(w.main, PR, w.cfg(), cx());
    expect(plan.items.some((i) => i.kind === "teardown-script")).toBe(false);
    expect(plan.blocks).toEqual([]);
  });
  test("set: the item is first, run from the main checkout's copy", async () => {
    w = makeWorld(); const p = script();
    const plan = await planCleanup(w.main, PR, w.cfg({ teardownScript: REL }), cx());
    expect(plan.blocks).toEqual([]);
    expect(first(plan)).toMatchObject({ kind: "teardown-script", target: p });
    expect(plan.items.findIndex((i) => i.kind === "worktree")).toBeGreaterThan(0);
  });
  test("worktree unticked: no teardown", async () => {
    w = makeWorld(); script();
    const plan = await planCleanup(w.main, PR, w.cfg({ teardownScript: REL, include: ["docker", "branch"] }), cx());
    expect(plan.items.some((i) => i.kind === "teardown-script")).toBe(false);
  });
  test("refused as a block, worktree kept: symlink out, missing, directory, not executable", async () => {
    w = makeWorld();
    const out = join(w.root, "outside.sh"); writeFileSync(out, "#!/bin/sh\n"); chmodSync(out, 0o755);
    symlinkSync(out, join(w.main, "link.sh"));
    mkdirSync(join(w.main, "dir.sh"));
    script("noexec.sh", 0o644);
    for (const rel of ["link.sh", "missing.sh", "dir.sh", "noexec.sh"]) {
      const cfg = w.cfg({ teardownScript: rel });
      const plan = await planCleanup(w.main, PR, cfg, cx());
      expect(plan.blocks.map((b) => b.kind)).toEqual(["teardown-refused"]);
      expect(plan.blocks[0]!.why).toMatch(/^teardown script refused: .*; worktree kept$/);
      expect(plan.items.some((i) => i.kind === "teardown-script")).toBe(false);
      await expect(runCleanup(w.main, PR, cfg, cx(), { planId: plan.id })).rejects.toThrow(/refused/);
      expect(existsSync(w.wt)).toBe(true);
    }
  });
  test("a script only in the worktree is never run", async () => {
    w = makeWorld();
    const p = join(w.wt, REL); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, 0o755);
    const plan = await planCleanup(w.main, PR, w.cfg({ teardownScript: REL }), cx());
    expect(plan.blocks.map((b) => b.kind)).toContain("teardown-refused");
    expect(plan.items.some((i) => i.kind === "teardown-script")).toBe(false);
  });
});

describe("run", () => {
  test("exit 0: argv is the worktree, cwd the main checkout, 120 s; the worktree goes after it", async () => {
    w = makeWorld(); script();
    const { ctx, seen } = withScript({ code: 0, stdout: "removed volume a\nremoved volume b\n", stderr: "" });
    const cfg = w.cfg({ teardownScript: REL });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(seen).toEqual([{ cmd: join(w.main, REL), args: [w.wt], cwd: w.main, timeoutMs: 120_000 }]);
    expect(seen[0]).toBeDefined();
    expect(r.items[0]).toMatchObject({ kind: "teardown-script", status: "done", detail: "teardown ran: removed volume a | removed volume b" });
    expect(r.items.find((i) => i.kind === "worktree")!.status).toBe("done");
    expect(existsSync(w.wt)).toBe(false);
  });
  test("an image or volume the script already removed is done, not failed", async () => {
    w = makeWorld(); script();
    w.images = [{ repo: "orbit-django", tag: "orbit-1042", id: "aaa111aaa111", size: "1GB" }];
    w.volumes = ["orbit-pycache-ORBIT-1042"];
    const { ctx } = withScript(() => { w.images = []; w.volumes = []; return { code: 0, stdout: "removed image and volume\n", stderr: "" }; });
    const cfg = w.cfg({ teardownScript: REL });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    expect(plan.items.filter((i) => i.kind === "docker-image" || i.kind === "docker-volume").length).toBe(2);
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    for (const i of r.items.filter((x) => x.kind === "docker-image" || x.kind === "docker-volume")) expect(i).toMatchObject({ status: "done", detail: "already gone" });
    expect(r.ok).toBe(true);
  });
  test("no output; 20 lines print whole; 21 lines say +1 more", async () => {
    w = makeWorld(); script();
    const cfg = w.cfg({ teardownScript: REL });
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    // everything but the teardown is unticked, so the worktree survives for the next read
    const { ctx: c0 } = withScript({ code: 0, stdout: "", stderr: "" });
    const p0 = await planCleanup(w.main, PR, cfg, c0);
    const ex = p0.items.filter((i) => i.kind !== "teardown-script").map((i) => i.id);
    const run = async (stdout: string) => {
      const { ctx } = withScript({ code: 0, stdout, stderr: "" });
      const p = await planCleanup(w.main, PR, cfg, ctx);
      return (await runCleanup(w.main, PR, cfg, ctx, { planId: p.id, exclude: ex })).items[0]!.detail;
    };
    expect(await run("")).toBe("teardown ran (no output)");
    expect(await run(lines(20))).toBe(`teardown ran: ${lines(20).trim().split("\n").join(" | ")}`);
    const d21 = await run(lines(21));
    expect(d21.endsWith("l20 | +1 more")).toBe(true);
    expect(d21).not.toContain("l21");
  });
  // A teardown that says no keeps the worktree so it can run again; when the project names the state file the script
  // reads and this checkout never had it, a second run could find nothing either, so the clean, merged checkout goes.
  const no: RunOut = { code: 1, stdout: "", stderr: "checking worktree.env\nno state file at worktree.env" };
  test("a declining teardown in a checkout without the named state file: a warning, and the worktree goes", async () => {
    w = makeWorld(); script();
    const { ctx } = withScript(no);
    const cfg = w.cfg({ teardownScript: REL, teardownStateFile: "worktree.env" });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(r.items[0]).toMatchObject({ kind: "teardown-script", status: "warn" });
    expect(r.items[0]!.detail).toContain("this checkout has no worktree.env");
    expect(r.items.find((i) => i.kind === "worktree")).toMatchObject({ status: "done" });
    expect(existsSync(w.wt)).toBe(false);
  });
  test("a declining teardown in a checkout that HAS the state file keeps it, so it can run again", async () => {
    w = makeWorld(); script();
    // ignored, as a project's tooling keeps it: an untracked file would make the checkout dirty and refuse the plan
    mkdirSync(join(w.main, ".git", "info"), { recursive: true });
    writeFileSync(join(w.main, ".git", "info", "exclude"), "worktree.env\n");
    writeFileSync(join(w.wt, "worktree.env"), "BUILD_ID=orbit-1042\n");
    const { ctx } = withScript(no);
    const cfg = w.cfg({ teardownScript: REL, teardownStateFile: "worktree.env" });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(r.items[0]).toMatchObject({ status: "failed", detail: "teardown failed (exit 1): no state file at worktree.env; worktree kept" });
    expect(w.calls.some((c) => c.includes("worktree remove"))).toBe(false);
  });
  const failing: [string, RunOut, string][] = [
    ["exit 1", { code: 1, stdout: "", stderr: "stopping\nboom" }, "teardown failed (exit 1): boom; worktree kept"],
    ["exit 1 on stdout", { code: 1, stdout: "checked\nnot mine\n", stderr: "" }, "teardown failed (exit 1): not mine; worktree kept"],
    ["exit 2 silent", { code: 2, stdout: "", stderr: "" }, "teardown failed (exit 2): no output; worktree kept"],
    ["timeout", { code: 137, stdout: "", stderr: "", timedOut: true }, "teardown timed out after 120 s; worktree kept"],
    ["cannot start", { code: 1, stdout: "", stderr: "ENOENT: bad interpreter", notStarted: true }, "teardown could not start: ENOENT: bad interpreter; worktree kept"],
  ];
  test.each(failing)("%s: failed, the worktree and what lives on it are kept", async (_n, ans, line) => {
    w = makeWorld(); script();
    const { ctx } = withScript(ans);
    const cfg = w.cfg({ teardownScript: REL });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(r.items[0]).toMatchObject({ kind: "teardown-script", status: "failed", detail: line });
    const held = r.items.slice(1).filter((i) => heldByWorktree(i.kind));
    expect(held.map((i) => i.kind)).toEqual(expect.arrayContaining(["worktree", "branch"]));
    expect(held.every((i) => i.status === "skipped" && i.detail === TEARDOWN_KEPT)).toBe(true);
    expect(existsSync(w.wt)).toBe(true);
    expect(w.calls.some((c) => c.includes("worktree remove"))).toBe(false);
  });
  // Seen on three merged pull requests in a row: the script exited 1 on a worktree it had not made, and the
  // run skipped every later item and freed 0 bytes.
  test("a failed teardown keeps that checkout; the rest of the plan still runs", async () => {
    w = makeWorld(); script();
    const evidence = join(w.home, "Documents", "projects", "orbit");
    put(join(evidence, "orbit-1042-pol-checkout", "a.png"), "x".repeat(500));
    const { ctx } = withScript({ code: 1, stdout: "", stderr: "checking\nnot a worktree this script made; kept\n" });
    const cfg = w.cfg({ teardownScript: REL, evidenceRoots: [evidence] });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(r.items[0]).toMatchObject({ kind: "teardown-script", status: "failed", detail: "teardown failed (exit 1): not a worktree this script made; kept; worktree kept" });
    // kept, and each says why
    for (const kind of ["worktree", "branch"] as const) expect(r.items.find((i) => i.kind === kind)).toMatchObject({ status: "skipped", detail: TEARDOWN_KEPT });
    expect(existsSync(w.wt)).toBe(true);
    expect(w.calls.some((c) => c.includes("worktree remove"))).toBe(false);
    expect(w.calls.some((c) => c.includes(`branch -D ${BRANCH}`))).toBe(false);
    // what does not depend on the checkout went on
    expect(r.items.find((i) => i.kind === "evidence")).toMatchObject({ status: "done" });
    expect(existsSync(join(evidence, "orbit-1042-pol-checkout"))).toBe(false);
    expect(r.items.find((i) => i.kind === "fetch-prune")!.status).not.toBe("skipped");
    expect(r.freedBytes).toBeGreaterThan(0);
    // still a run that says it did not finish
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(1);
  });
  test("the script refuses one checkout and releases another: only the first is kept", async () => {
    const answer = (refused: string) => (a: string[]): RunOut => (a[0] === refused
      ? { code: 1, stdout: "", stderr: "not released\n" }
      : { code: 0, stdout: "released\n", stderr: "" });
    w = makeWorld(); script();
    const kept = w.wt;
    const one = withScript(answer(kept));
    const cfg1 = w.cfg({ teardownScript: REL });
    const r1 = await runCleanup(w.main, PR, cfg1, one.ctx, { planId: (await planCleanup(w.main, PR, cfg1, one.ctx)).id });
    expect(r1.items.find((i) => i.kind === "worktree")).toMatchObject({ status: "skipped", detail: TEARDOWN_KEPT });
    expect(existsSync(kept)).toBe(true);
    w.cleanup();

    w = makeWorld({ branch: "ORBIT-2077-other" }); script();
    const two = withScript(answer(kept));
    const cfg2 = w.cfg({ teardownScript: REL });
    const r2 = await runCleanup(w.main, PR, cfg2, two.ctx, { planId: (await planCleanup(w.main, PR, cfg2, two.ctx)).id });
    expect(two.seen.map((s) => s.args)).toEqual([[w.wt]]);
    expect(r2.items[0]).toMatchObject({ kind: "teardown-script", status: "done" });
    expect(r2.items.find((i) => i.kind === "worktree")!.status).toBe("done");
    expect(existsSync(w.wt)).toBe(false);
  });
  test("the kinds a failed teardown holds are the checkout's own, and nothing else", () => {
    const held = ["worktree", "branch", "stash", "tab", "docker-container", "docker-volume", "docker-image", "test-db", "agent-scratch", "agent-history", "own-state"] as const;
    const free = ["fetch-prune", "evidence", "note", "brief", "worklog", "other-folder", "card-move"] as const;
    for (const k of held) expect(heldByWorktree(k), k).toBe(true);
    for (const k of free) expect(heldByWorktree(k), k).toBe(false);
  });
  test("a real executable whose shebang names a missing interpreter could not start", async () => {
    w = makeWorld(); script(REL, 0o755, "#!/nonexistent/interp\n");
    const cfg = w.cfg({ teardownScript: REL });
    const real = (await import("../src/diskclean.ts")).spawnRunner;
    const base = cx();
    const ctx = { ...base, run: ((cmd, args, o) => (cmd.endsWith(REL) ? real(cmd, args, o) : base.run(cmd, args, o))) as Runner };
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id });
    expect(r.items[0]!.status).toBe("failed");
    expect(r.items[0]!.detail).toMatch(/^teardown could not start: .+; worktree kept$/);
    expect(existsSync(w.wt)).toBe(true);
  });
  test("the script is re-resolved at run time: a symlink swapped in after the plan is refused", async () => {
    w = makeWorld(); const p = script();
    const { ctx, seen } = withScript({ code: 0, stdout: "", stderr: "" });
    const cfg = w.cfg({ teardownScript: REL });
    const plan = await planCleanup(w.main, PR, cfg, ctx);
    const out = join(w.root, "outside.sh"); writeFileSync(out, "#!/bin/sh\n"); chmodSync(out, 0o755);
    (await import("node:fs")).rmSync(p); symlinkSync(out, p);
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: plan.id }).catch((e) => e);
    // the plan id changes with the target, or the item itself refuses: either way nothing ran
    expect(seen).toEqual([]);
    expect(existsSync(w.wt)).toBe(true);
    void r;
  });

  test("20 raw lines print whole; blank lines count toward the cap", async () => {
    w = makeWorld(); script();
    const cfg = w.cfg({ teardownScript: REL });
    const { ctx: c0 } = withScript({ code: 0, stdout: "", stderr: "" });
    const ex = (await planCleanup(w.main, PR, cfg, c0)).items.filter((i) => i.kind !== "teardown-script").map((i) => i.id);
    const { ctx } = withScript({ code: 0, stdout: "a\n\n\nb\n" + "x\n".repeat(18) + "last-cut\n", stderr: "" });
    const p = await planCleanup(w.main, PR, cfg, ctx);
    const d = (await runCleanup(w.main, PR, cfg, ctx, { planId: p.id, exclude: ex })).items[0]!.detail;
    expect(d.endsWith("| +3 more")).toBe(true); // 23 raw lines, 20 shown
    expect(d).not.toContain("last-cut");
  });
});

describe("the real runner on a repo script", () => {
  const real = async (rel: string, body: string, timeoutMs = 120_000) => {
    w = makeWorld(); const p = script(rel, 0o755, body);
    const { spawnRunner } = await import("../src/diskclean.ts");
    return spawnRunner(p, [w.wt], { cwd: w.main, timeoutMs, isolated: true });
  };
  test("no AGENTGLASS_*, token, secret or key variable reaches the script", async () => {
    const keep = { ...process.env };
    Object.assign(process.env, { AGENTGLASS_TOKEN: "t0k", AGENTGLASS_SEAT: "s", MY_API_KEY: "k", DB_SECRET: "s2", GH_TOKEN: "g" });
    try {
      const r = await real(REL, "#!/bin/sh\nenv\n");
      expect(r.code).toBe(0);
      expect(r.stdout).not.toMatch(/AGENTGLASS_|t0k|MY_API_KEY|DB_SECRET|GH_TOKEN/);
      expect(r.stdout).toContain("PATH=");
    } finally { for (const k of ["AGENTGLASS_TOKEN", "AGENTGLASS_SEAT", "MY_API_KEY", "DB_SECRET", "GH_TOKEN"]) delete process.env[k]; Object.assign(process.env, keep); }
  });
  test("a timeout kills the forked child too", async () => {
    const pidFile = join(process.env.TMPDIR ?? "/tmp", `agx-td-${process.pid}-${Date.now()}`);
    const r = await real(REL, `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nsleep 300\n`, 600);
    expect(r.timedOut).toBe(true);
    const pid = Number((await Bun.file(pidFile).text()).trim());
    await Bun.sleep(100);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    (await import("node:fs")).rmSync(pidFile, { force: true });
    expect(alive).toBe(false);
  });
});

// Five of six runs of one "Clean up all" answered 500: each had a report with a failed or kept item in it.
const routes = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
describe("a run that kept or failed an item is an answer, not a server error", () => {
  test("a report answers 200, clean or not", () => {
    expect(CLEANUP_REPORT_STATUS).toBe(200);
  });
  test("the route sends the report with that status, and 5xx is left to a run that threw", () => {
    const at = routes.indexOf('if (pathname === "/cleanup/run" && req.method === "POST") {');
    expect(at).toBeGreaterThan(-1);
    const body = routes.slice(at, routes.indexOf("\n    }\n", at));
    expect(body).toContain("return json(res, CLEANUP_REPORT_STATUS);");
    expect(body).not.toContain("res.ok ? 200 : 500");
    expect(body).toContain("e instanceof CleanupError ? e.status : 500");
  });
  test("the failed run's report carries the reason on the item", async () => {
    w = makeWorld(); script();
    const { ctx } = withScript({ code: 1, stdout: "", stderr: "not released\n" });
    const cfg = w.cfg({ teardownScript: REL });
    const r = await runCleanup(w.main, PR, cfg, ctx, { planId: (await planCleanup(w.main, PR, cfg, ctx)).id });
    expect(r.ok).toBe(false);
    expect(r.items.filter((i) => i.status === "failed").map((i) => i.detail)).toEqual(["teardown failed (exit 1): not released; worktree kept"]);
  });
});
