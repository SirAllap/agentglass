// The disk scan and the clean, run for real against fake docker/git/gh/df/du.
//
// Every case runs in a CHILD whose PATH begins with the fakes: `Bun.which`
// resolves against the PATH a process started with, so changing it in this
// process would do nothing. The child refuses to start unless `docker` resolves
// to the fake, and the log the fakes write is how each test proves the fake
// ran and that no `volume` command was ever issued. The machine's own docker
// is never asked, not even `docker ps`.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiskCleanReport, DiskCleanRunResult } from "../../shared/types.ts";
import { C1, C2, GB, LEGACY_ID, LIVE_ID, OLD_ID, TEMP_PROJ, YOUNG_ID, makeFixture, row, populateHome, type Fixture } from "./diskcleanFixture.ts";

const MODULE = fileURLToPath(new URL("../src/diskclean.ts", import.meta.url));
const made: Fixture[] = [];
afterAll(() => { for (const f of made) rmSync(f.dir, { recursive: true, force: true }); });

function driver(fx: Fixture): string {
  const file = join(fx.dir, "drive.mjs");
  writeFileSync(file, [
    `const m = await import(${JSON.stringify(MODULE)});`,
    'const w = Bun.which("docker");',
    'if (!w || !w.startsWith(process.env.AGX_SHIM)) throw new Error("docker is not the fake: " + w);',
    'const ctx = m.defaultDiskCtx({ home: process.env.AGX_HOME, procDir: process.env.AGX_PROC ?? process.env.AGX_HOME + "/no-proc", swaps: () => process.env.AGX_SWAPS ?? "", snapshotsDir: process.env.AGX_HOME + "/no-snapshots", repos: [], ...(process.env.AGX_SOCKS ? { tmuxSockets: () => [["-S", "/fake/other.sock"]] } : {}) });',
    'const [mode, arg] = process.argv.slice(2);',
    // sequences in ONE process, because the cache and the in-flight scan are module state
    'const seq = {',
    '  async "scan-then-run"() { await m.diskCleanReport(true, ctx); return m.runDiskClean(["trash"], {}, ctx); },',
    '  async "scan-dry-run-then-run"() { await m.diskCleanReport(true, ctx); await m.runDiskClean(undefined, { dryRun: true }, ctx); return m.runDiskClean(["trash"], {}, ctx); },',
    '  async "stale-scan-after-a-clean"() { const slow = m.diskCleanReport(true, { ...ctx, run: async (...a) => { await Bun.sleep(50); return ctx.run(...a); } }); await m.runDiskClean(undefined, {}, ctx); await slow; return m.diskCleanReport(false, ctx); },',
    // the confirm carries the scan the person looked at (`at`), or one that is not it
    '  async "scan-then-run-with-its-at"() { const r = await m.diskCleanReport(true, ctx); return m.runDiskClean(["trash"], { at: r.at }, ctx); },',
    '  async "scan-then-run-with-another-at"() { const r = await m.diskCleanReport(true, ctx); return m.runDiskClean(["trash"], { at: r.at - 1 }, ctx); },',
    '};',
    'const out = mode === "seq" ? await seq[arg]() : mode === "del" ? await m.deleteTarget(JSON.parse(arg), ctx) : mode === "scan" ? await m.scanDisk(ctx) : await m.runDiskClean(arg === "all" ? undefined : JSON.parse(arg), { dryRun: mode === "dry" }, ctx);',
    'process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");',
  ].join("\n"));
  return file;
}

function go<T>(fx: Fixture, mode: "scan" | "run" | "dry" | "del" | "seq", arg = "all", env: Record<string, string> = {}): T {
  const r = Bun.spawnSync([process.execPath, driver(fx), mode, arg], { env: { ...fx.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(r.stdout);
  const line = text.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`no result: ${text}${new TextDecoder().decode(r.stderr)}`);
  return JSON.parse(line.slice(7)) as T;
}
const calls = (fx: Fixture) => readFileSync(fx.log, "utf8").split("\n").filter(Boolean);
function fixture(opts: Parameters<typeof makeFixture>[0] = {}) {
  const fx = makeFixture(opts);
  made.push(fx);
  return { fx, ...populateHome(fx) };
}
const byId = (r: DiskCleanReport, id: string) => r.lines.find((l) => l.id === id);

describe("the scan", () => {
  const { fx, wt, sessions } = fixture();
  const report = go<DiskCleanReport>(fx, "scan");

  test("the fakes answered, and the scan only read: no prune, no remove, no volume command", () => {
    const log = calls(fx);
    expect(log).toContain("docker system df --format {{json .}}");
    expect(log.some((l) => l.startsWith("git -C") && l.includes("worktree list"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh pr list"))).toBe(true);
    expect(log.some((l) => /prune|remove|rm /.test(l))).toBe(false);
    expect(log.some((l) => /volume/.test(l))).toBe(false);
  });

  test("Docker lines live on Docker's disk, the rest on the home disk, and each mount reports its free space", () => {
    expect(byId(report, "docker:images")!.mount).toBe("/vault");
    expect(byId(report, "worktree:" + wt["ORBIT-1042"])!.mount).toBe("/home");
    const m = Object.fromEntries(report.mounts.map((x) => [x.mount, x]));
    expect(m["/home"]!.free).toBe(5.1 * GB);
    expect(m["/vault"]!.free).toBe(215 * GB);
    expect(m["/vault"]!.safeBytes).toBeGreaterThan(100 * GB);
  });

  test("Docker: unused images and build cache are safe, what containers use is not, volumes are never deletable", () => {
    expect(byId(report, "docker:images")).toMatchObject({ verdict: "safe", bytes: 59.37 * GB, target: { via: "docker", what: "images" } });
    expect(byId(report, "docker:cache")).toMatchObject({ verdict: "safe", bytes: 61.06 * GB });
    expect(byId(report, "docker:containers")).toMatchObject({ verdict: "safe", bytes: 5 * GB, target: { via: "docker", what: "containers", ids: [C1, C2] } });
    expect(byId(report, "docker:images-used")!.verdict).toBe("inuse");
    expect(byId(report, "docker:volumes-used")).toMatchObject({ verdict: "inuse", target: null });
    expect(byId(report, "docker:volumes-used")!.why).toContain("orbit");
    expect(byId(report, "docker:volumes-spare")).toMatchObject({ verdict: "explain", target: null });
  });

  test("worktrees: merged and clean is safe; uncommitted work asks; an open pull request is in use", () => {
    expect(byId(report, "worktree:" + wt["ORBIT-1042"])).toMatchObject({ verdict: "safe", target: { via: "worktree", path: wt["ORBIT-1042"] } });
    expect(byId(report, "worktree:" + wt["ORBIT-1050"])).toMatchObject({ verdict: "ask", target: null });
    expect(byId(report, "worktree:" + wt["ORBIT-1050"])!.why).toContain("3 files");
    expect(byId(report, "worktree:" + wt["ORBIT-1060"])).toMatchObject({ verdict: "inuse", target: null });
    expect(byId(report, "worktree:" + wt["ORBIT-1060"])!.why).toContain("#1060");
  });

  test("Claude temp: old and idle is safe, one a running session names is in use, a young one asks", () => {
    expect(byId(report, `claude-temp:${TEMP_PROJ}/${OLD_ID}`)).toMatchObject({ verdict: "safe", target: { via: "fs", path: sessions.old } });
    expect(byId(report, `claude-temp:${TEMP_PROJ}/${LIVE_ID}`)).toMatchObject({ verdict: "inuse", target: null });
    expect(byId(report, `claude-temp:${TEMP_PROJ}/${YOUNG_ID}`)).toMatchObject({ verdict: "ask", target: null });
  });

  test("Claude temp, the older shape (claude-tmp/<project>/<session>) is still found", () => {
    expect(byId(report, `claude-temp:-home-dev-code-orbit/${LEGACY_ID}`)).toMatchObject({ verdict: "safe", target: { via: "fs", path: sessions.legacy } });
  });

  test("Claude temp, the measured shape: nothing is lost to the claude-<uid> folder in front of the project", () => {
    const ids = report.lines.filter((l) => l.kind === "claude-temp").map((l) => l.id).sort();
    expect(ids).toEqual([`claude-temp:${TEMP_PROJ}/${LIVE_ID}`, `claude-temp:${TEMP_PROJ}/${OLD_ID}`, `claude-temp:${TEMP_PROJ}/${YOUNG_ID}`, `claude-temp:-home-dev-code-orbit/${LEGACY_ID}`].sort());
  });

  test("a session that writes deep inside its scratchpad is not old, whatever the top levels say", () => {
    const { fx, sessions } = fixture();
    const deep = join(sessions.old!, "scratchpad", "a", "b");
    mkdirSync(deep, { recursive: true });
    const longAgo = new Date(Date.now() - 5 * 86400_000);
    for (const d of [deep, join(deep, ".."), join(deep, "../.."), join(sessions.old!, "scratchpad"), sessions.old!]) utimesSync(d, longAgo, longAgo);
    writeFileSync(join(deep, "out.log"), "still writing");
    const l = byId(go<DiskCleanReport>(fx, "scan"), `claude-temp:${TEMP_PROJ}/${OLD_ID}`)!;
    expect(l).toMatchObject({ verdict: "ask", target: null });
  });

  test("caches and trash are safe; memory and sign-ins are shown and never deletable", () => {
    expect(byId(report, "cache:uv")).toMatchObject({ verdict: "safe", bytes: 1.8 * GB });
    expect(byId(report, "trash")!.verdict).toBe("safe");
    expect(byId(report, "claude-memory")).toMatchObject({ verdict: "explain", target: null });
    expect(byId(report, "logins-browser")).toMatchObject({ verdict: "explain", target: null });
  });

  test("GUARD: only a safe line has a target, and the plan total is the sum of the safe lines", () => {
    for (const l of report.lines) expect(l.target !== null).toBe(l.verdict === "safe");
    expect(report.safeBytes).toBe(report.lines.filter((l) => l.verdict === "safe").reduce((n, l) => n + (l.bytes ?? 0), 0));
  });
});

describe("a checkout that is merged and clean can still hold what must not go", () => {
  const key = (p: string) => "worktree:" + p;

  test("an ignored .env no other copy has makes the line ask, and names it", () => {
    const { fx, wt } = fixture();
    const l = byId(go<DiskCleanReport>(fx, "scan"), key(wt["ORBIT-1080"]!))!;
    expect(l).toMatchObject({ verdict: "ask", target: null });
    expect(l.why).toContain(".env");
    expect(l.why).not.toContain("__pycache__");
  });

  test("an agent standing in the checkout (a tmux pane in a subfolder) makes it in use", () => {
    const { fx, wt } = fixture();
    expect(byId(go<DiskCleanReport>(fx, "scan"), key(wt["ORBIT-1090"]!))!.verdict).toBe("safe");
    const sub = join(wt["ORBIT-1090"]!, "web");
    mkdirSync(sub, { recursive: true });
    const l = byId(go<DiskCleanReport>(fx, "scan", "all", { AGX_PANES: `/somewhere/else\n${sub}` }), key(wt["ORBIT-1090"]!))!;
    expect(l).toMatchObject({ verdict: "inuse", target: null });
    expect(calls(fx).some((x) => x.startsWith("tmux") && x.includes("list-panes"))).toBe(true);
  });

  test("a process whose cwd is inside the checkout makes it in use", () => {
    const { fx, wt } = fixture();
    const proc = join(fx.dir, "proc");
    mkdirSync(join(proc, "4242"), { recursive: true });
    symlinkSync(wt["ORBIT-1090"]!, join(proc, "4242", "cwd"));
    const r = go<DiskCleanReport>(fx, "scan", "all", { AGX_PROC: proc });
    expect(byId(r, key(wt["ORBIT-1090"]!))!.verdict).toBe("inuse");
    expect(byId(r, key(wt["ORBIT-1042"]!))!.verdict).toBe("safe");
  });

  test("GUARD: the removal looks again, so a line the scan called safe is not removed once an agent has moved in", () => {
    const { fx, repo, wt } = fixture();
    const target = { via: "worktree", repo, path: wt["ORBIT-1042"] };
    const r = go<{ status: string; detail: string }>(fx, "del", JSON.stringify(target), { AGX_PANES: wt["ORBIT-1042"]! });
    expect(r.status).toBe("refused");
    expect(r.detail).toContain("running inside");
    expect(calls(fx).some((x) => x.includes("worktree remove"))).toBe(false);
  });

  test("GUARD: the removal looks again, so ignored files that appeared after the scan keep the checkout", () => {
    const { fx, repo, wt } = fixture();
    const target = { via: "worktree", repo, path: wt["ORBIT-1080"] };
    const r = go<{ status: string; detail: string }>(fx, "del", JSON.stringify(target));
    expect(r.status).toBe("refused");
    expect(r.detail).toContain("git ignores");
    expect(calls(fx).some((x) => x.includes("worktree remove"))).toBe(false);
    expect(existsSync(join(wt["ORBIT-1080"]!, ".env"))).toBe(true);
  });
});

describe("a Docker that is down or a GitHub that is signed out", () => {
  test("Docker down: no Docker lines, a plain-words problem, and the rest of the scan still answers", () => {
    const { fx } = fixture({ dockerDown: true });
    const r = go<DiskCleanReport>(fx, "scan");
    expect(r.lines.some((l) => l.kind.startsWith("docker"))).toBe(false);
    expect(r.problems.join(" ")).toContain("Docker");
    expect(r.lines.some((l) => l.kind === "package-cache")).toBe(true);
    expect(calls(fx).some((l) => l.startsWith("docker info"))).toBe(true);
  });

  test("gh failing is not 'no pull request': every checkout is kept (ask), none is safe", () => {
    const { fx } = fixture({ ghFail: true });
    const r = go<DiskCleanReport>(fx, "scan");
    const wts = r.lines.filter((l) => l.kind === "worktree");
    expect(wts.length).toBe(6);
    expect(wts.some((l) => l.verdict === "safe")).toBe(false);
    expect(r.problems.join(" ")).toContain("GitHub");
  });
});

describe("what a scan costs", () => {
  const ghCalls = (fx: Fixture) => calls(fx).filter((l) => l.startsWith("gh pr list"));

  test("one GitHub call per repository, not one per checkout", () => {
    const { fx, wt } = fixture();
    const r = go<DiskCleanReport>(fx, "scan");
    expect(r.lines.filter((l) => l.kind === "worktree").length).toBe(6);
    expect(ghCalls(fx).length).toBe(1);
    expect(byId(r, "worktree:" + wt["ORBIT-1042"]!)!.verdict).toBe("safe");
  });

  test("a repository with more pull requests than one call holds: the branch missing from it is asked for alone", () => {
    const { fx, wt } = fixture();
    const r = go<DiskCleanReport>(fx, "scan", "all", { AGX_GH_FULL: "1" });
    expect(ghCalls(fx).filter((l) => l.includes("--head")).length).toBe(6);
    expect(byId(r, "worktree:" + wt["ORBIT-1042"]!)!.verdict).toBe("safe");
    expect(byId(r, "worktree:" + wt["ORBIT-1060"]!)!.verdict).toBe("inuse");
  });

  test("a clean right after a scan reuses it: the second round of GitHub calls is not made", () => {
    const { fx } = fixture();
    go<DiskCleanRunResult>(fx, "seq", "scan-then-run");
    expect(ghCalls(fx).length).toBe(1);
  });

  test("a dry run and the confirm that follows it share one scan", () => {
    const { fx } = fixture();
    go<DiskCleanRunResult>(fx, "seq", "scan-dry-run-then-run");
    expect(ghCalls(fx).length).toBe(1);
  });

  test("GUARD: a scan that was running when a clean finished does not put the pre-clean disk back in the cache", () => {
    const { fx, sessions } = fixture();
    const r = go<DiskCleanReport>(fx, "seq", "stale-scan-after-a-clean");
    expect(existsSync(sessions.old!)).toBe(false);
    expect(r.lines.some((l) => l.id === `claude-temp:${TEMP_PROJ}/${OLD_ID}`)).toBe(false);
  });
});

describe("Docker aimed somewhere else, and containers that only look finished", () => {
  const cSpec = (id: string, extra = "") => `{"ID":"${id.slice(0, 12)}","Names":"x","State":"exited","Status":"Exited (0) 5 minutes ago","Labels":"${extra}"}`;
  const prunes = (fx: Fixture) => calls(fx).filter((l) => /prune/.test(l));

  test("GUARD: a remote DOCKER_HOST is not counted and not cleaned, and the scan never asks that daemon anything", () => {
    const { fx } = fixture();
    const r = go<DiskCleanReport>(fx, "scan", "all", { DOCKER_HOST: "tcp://10.0.0.5:2375" });
    expect(r.lines.some((l) => l.kind.startsWith("docker"))).toBe(false);
    expect(r.problems.join(" ")).toContain("DOCKER_HOST");
    expect(calls(fx).some((l) => l.startsWith("docker system") || l.startsWith("docker info"))).toBe(false);
  });

  test("GUARD: a Docker context other than the local default is refused too", () => {
    const { fx } = fixture();
    const r = go<DiskCleanReport>(fx, "scan", "all", { AGX_DOCKER_CONTEXT: "staging" });
    expect(r.lines.some((l) => l.kind.startsWith("docker"))).toBe(false);
    expect(r.problems.join(" ")).toContain('"staging"');
    expect(calls(fx)).toContain("docker context show");
  });

  test("a local unix DOCKER_HOST is the local daemon", () => {
    const { fx } = fixture();
    const r = go<DiskCleanReport>(fx, "scan", "all", { DOCKER_HOST: "unix:///var/run/docker.sock" });
    expect(r.lines.some((l) => l.id === "docker:images")).toBe(true);
  });

  test("GUARD: the prune itself looks again, so a target from an older scan does not reach another daemon", () => {
    const { fx } = fixture();
    const r = go<{ status: string; detail: string }>(fx, "del", JSON.stringify({ via: "docker", what: "images" }), { DOCKER_HOST: "tcp://10.0.0.5:2375" });
    expect(r.status).toBe("refused");
    expect(prunes(fx)).toEqual([]);
  });

  test("stopped compose services exit 0 like a test run, so they ask and no container is removed", () => {
    const { fx } = fixture();
    fx.put("docker-ps", [
      '{"State":"running","Status":"Up 3 hours","Labels":"com.docker.compose.project=orbit"}',
      cSpec(C1, "com.docker.compose.project=orbit,com.docker.compose.service=db"),
    ].join("\n"));
    fx.put("docker-inspect", row(C1, true, { compose: "orbit" }));
    const r = go<DiskCleanReport>(fx, "scan");
    expect(byId(r, "docker:containers")).toMatchObject({ verdict: "ask", target: null });
    expect(byId(r, "docker:containers")!.why).toContain("compose project orbit");
    go<DiskCleanRunResult>(fx, "run");
    expect(prunes(fx).some((l) => l.startsWith("docker container prune"))).toBe(false);
    expect(calls(fx).some((l) => l.startsWith("docker rm"))).toBe(false);
    expect(prunes(fx)).toContain("docker image prune -a -f");
  });

  test("a hand-run container that exited 0 (a shell you left, a database you stopped) asks: nothing proves it is disposable", () => {
    const { fx } = fixture();
    fx.put("docker-ps", cSpec(C1).replace('"Names":"x"', '"Names":"dev"'));
    fx.put("docker-inspect", row(C1, false));
    const r = go<DiskCleanReport>(fx, "scan");
    expect(byId(r, "docker:containers")).toMatchObject({ verdict: "ask", target: null });
    expect(byId(r, "docker:containers")!.why).toContain("dev exited with 0");
    go<DiskCleanRunResult>(fx, "run");
    expect(calls(fx).some((l) => l.startsWith("docker rm") || l.startsWith("docker container prune"))).toBe(false);
  });

  test("an unused image that exists only here (no registry digest) makes the images line ask, and the clean does not prune images", () => {
    const { fx } = fixture();
    fx.put("docker-images", '{"ID":"e5e5e5e5e5e5","Repository":"acme/tools","Tag":"dev","Digest":"<none>"}\n{"ID":"f6f6f6f6f6f6","Repository":"postgres","Tag":"16","Digest":"sha256:feed"}');
    const r = go<DiskCleanReport>(fx, "scan");
    expect(byId(r, "docker:images")).toMatchObject({ verdict: "ask", target: null });
    expect(byId(r, "docker:images")!.why).toContain("acme/tools:dev");
    go<DiskCleanRunResult>(fx, "run");
    expect(prunes(fx).some((l) => l.startsWith("docker image prune"))).toBe(false);
  });

  test("GUARD: the images prune looks again: an image made after the scan stops it", () => {
    const { fx } = fixture();
    fx.put("docker-images", '{"ID":"e5e5e5e5e5e5","Repository":"acme/tools","Tag":"dev","Digest":"<none>"}');
    const r = go<{ status: string }>(fx, "del", JSON.stringify({ via: "docker", what: "images" }));
    expect(r.status).toBe("refused");
    expect(prunes(fx)).toEqual([]);
  });

  test("GUARD: a container that started again after the scan is not removed", () => {
    const { fx } = fixture();
    fx.put("docker-inspect", row(C1, true).replace(" false ", " true "));
    const r = go<{ status: string }>(fx, "del", JSON.stringify({ via: "docker", what: "containers", ids: [C1] }));
    expect(r.status).toBe("refused");
    expect(calls(fx).some((l) => l.startsWith("docker rm"))).toBe(false);
  });
});

describe("the clean", () => {
  test("a dry run lists the plan and removes nothing", () => {
    const { fx, sessions } = fixture();
    const r = go<DiskCleanRunResult>(fx, "dry");
    expect(r.ok).toBe(true);
    expect(r.lines.every((l) => l.status === "planned")).toBe(true);
    expect(existsSync(sessions.old!)).toBe(true);
    expect(calls(fx).some((l) => /prune|worktree remove/.test(l))).toBe(false);
  });

  test("the whole plan: Docker by its CLI only, freed measured by df on Docker's own disk, nothing else touched", () => {
    const { fx, wt, sessions, outside } = fixture();
    const r = go<DiskCleanRunResult>(fx, "run");
    const log = calls(fx);
    expect(r.ok).toBe(true);
    // each prune handed 5 GB back on /vault: that is what df says, line by line
    for (const id of ["docker:images", "docker:cache", "docker:containers"]) expect(r.lines.find((l) => l.id === id)).toMatchObject({ status: "freed", freed: 5 * GB });
    expect(r.mounts.find((m) => m.mount === "/vault")).toMatchObject({ before: 215 * GB, after: 230 * GB });
    expect(log).toContain("docker image prune -a -f");
    expect(log).toContain("docker builder prune -a -f");
    // the stopped containers go by the ids the scan showed, never by a blanket prune
    expect(log).toContain(`docker rm ${C1} ${C2}`);
    expect(log.some((l) => l.includes("container prune"))).toBe(false);
    // images before containers: removing the containers first would free images the plan did not list
    expect(log.indexOf("docker image prune -a -f")).toBeLessThan(log.indexOf(`docker rm ${C1} ${C2}`));
    expect(log.some((l) => /volume|--volumes|system prune/.test(l))).toBe(false);
    // the merged, clean checkout went through git, without --force
    expect(log.some((l) => l.includes("worktree remove") && l.endsWith(wt["ORBIT-1042"]!))).toBe(true);
    expect(log.some((l) => /worktree remove.*--force/.test(l))).toBe(false);
    expect(log.some((l) => l.includes("worktree remove") && l.includes(wt["ORBIT-1050"]!))).toBe(false);
    // filesystem: the old session folder is gone, the others are not, and the link inside it did not lead out
    expect(existsSync(sessions.old!)).toBe(false);
    expect(existsSync(sessions.live!)).toBe(true);
    expect(existsSync(sessions.young!)).toBe(true);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    // Hugging Face: its two caches are emptied, the login and the config beside them are not
    expect(existsSync(join(fx.home, ".cache/huggingface/hub"))).toBe(true);
    expect(existsSync(join(fx.home, ".cache/huggingface/hub/blob"))).toBe(false);
    expect(existsSync(join(fx.home, ".cache/huggingface/xet/chunk"))).toBe(false);
    expect(readFileSync(join(fx.home, ".cache/huggingface/token"), "utf8")).toBe("hf_invented_token_for_tests");
    expect(existsSync(join(fx.home, ".cache/huggingface/accelerate/default_config.yaml"))).toBe(true);
    // a cache is emptied but left in place
    expect(existsSync(join(fx.home, ".cache/uv"))).toBe(true);
    expect(existsSync(join(fx.home, ".cache/uv/blob"))).toBe(false);
    // memory and sign-ins untouched
    expect(existsSync(join(fx.home, ".claude"))).toBe(true);
    expect(existsSync(join(fx.home, ".config/agentglass-electron/Partitions"))).toBe(true);
  });

  test("the order is Docker's images before its containers whatever order the ids come in", () => {
    const { fx } = fixture();
    go<DiskCleanRunResult>(fx, "run", JSON.stringify(["docker:containers", "docker:cache", "docker:images"]));
    const log = calls(fx);
    expect(log.indexOf("docker image prune -a -f")).toBeGreaterThan(-1);
    expect(log.indexOf("docker image prune -a -f")).toBeLessThan(log.indexOf(`docker rm ${C1} ${C2}`));
  });

  test("a checkout with root-owned files is reported as 'needs sudo', not escalated", () => {
    const { fx, wt } = fixture();
    const r = go<DiskCleanRunResult>(fx, "run");
    const line = r.lines.find((l) => l.id === "worktree:" + wt["ORBIT-1070"]);
    expect(line).toMatchObject({ status: "needs-sudo", freed: 0 });
    expect(calls(fx).some((l) => /sudo/.test(l))).toBe(false);
  });

  test("GUARD: naming a line that is not safe, or does not exist, is refused and nothing runs for it", () => {
    const { fx, wt, sessions } = fixture();
    const ids = ["worktree:" + wt["ORBIT-1050"], "worktree:" + wt["ORBIT-1060"], `claude-temp:${TEMP_PROJ}/${LIVE_ID}`, "docker:volumes-spare", "claude-memory", "../../etc", "/etc/passwd"];
    const r = go<DiskCleanRunResult>(fx, "run", JSON.stringify(ids));
    expect(r.lines.map((l) => l.status)).toEqual(ids.map(() => "refused"));
    expect(calls(fx).some((l) => /prune|worktree remove/.test(l))).toBe(false);
    expect(existsSync(sessions.live!)).toBe(true);
  });

  test("GUARD: ids that are not a list of strings are an error, not 'everything'", () => {
    const { fx } = fixture();
    for (const bad of ['"all"', "{}", "[1]", '[""]', "7"]) {
      const r = go<DiskCleanRunResult>(fx, "run", bad);
      expect(r.ok).toBe(false);
      expect(r.lines).toEqual([]);
    }
    expect(calls(fx).some((l) => /prune|worktree remove/.test(l))).toBe(false);
  });
});

describe("Hugging Face: its two caches, never the folder that holds the login", () => {
  test("the scan lists hub and xet as caches and never the folder above them", () => {
    const { fx } = fixture();
    const r = go<DiskCleanReport>(fx, "scan");
    expect(byId(r, "cache:huggingface-hub")).toMatchObject({ verdict: "safe", target: { via: "fs", root: join(fx.home, ".cache/huggingface/hub") } });
    expect(byId(r, "cache:huggingface-xet")).toMatchObject({ verdict: "safe" });
    expect(r.lines.some((l) => l.id === "cache:huggingface" || (l.target?.via === "fs" && l.target.root === join(fx.home, ".cache/huggingface")))).toBe(false);
  });
});

describe("Claude temp: a folder something has open is in use, whatever its age and whoever names its id", () => {
  const oldLine = (r: DiskCleanReport) => byId(r, `claude-temp:${TEMP_PROJ}/${OLD_ID}`)!;

  test("a process holding a file open inside it, with no session id on its command line", () => {
    const { fx, sessions } = fixture();
    expect(oldLine(go<DiskCleanReport>(fx, "scan")).verdict).toBe("safe");
    const proc = join(fx.dir, "proc");
    mkdirSync(join(proc, "4242", "fd"), { recursive: true });
    symlinkSync(join(sessions.old!, "scratchpad", "out.json"), join(proc, "4242", "fd", "7"));
    expect(oldLine(go<DiskCleanReport>(fx, "scan", "all", { AGX_PROC: proc }))).toMatchObject({ verdict: "inuse", target: null });
  });

  test("a process whose cwd is inside it", () => {
    const { fx, sessions } = fixture();
    const proc = join(fx.dir, "proc");
    mkdirSync(join(proc, "4242"), { recursive: true });
    symlinkSync(join(sessions.old!, "scratchpad"), join(proc, "4242", "cwd"));
    expect(oldLine(go<DiskCleanReport>(fx, "scan", "all", { AGX_PROC: proc })).verdict).toBe("inuse");
  });

  test("a session running in a pane of another tmux server, named by its id", () => {
    const { fx } = fixture();
    expect(oldLine(go<DiskCleanReport>(fx, "scan", "all", { AGX_SOCKS: "1" })).verdict).toBe("safe");
    const r = go<DiskCleanReport>(fx, "scan", "all", { AGX_SOCKS: "1", AGX_PANES_SOCK: `/home/dev/code/orbit claude --resume ${OLD_ID}` });
    expect(oldLine(r)).toMatchObject({ verdict: "inuse", target: null });
    expect(calls(fx).some((l) => l.startsWith("tmux -S /fake/other.sock list-panes"))).toBe(true);
  });
});

describe("the clean acts on the plan the person saw", () => {
  test("a confirm that carries the scan on screen goes ahead", () => {
    const { fx } = fixture(); const home = fx.home;
    const r = go<DiskCleanRunResult>(fx, "seq", "scan-then-run-with-its-at");
    expect(r.ok).toBe(true);
    expect(existsSync(join(home, ".local/share/Trash/files/old.zip"))).toBe(false);
  });

  test("GUARD: a confirm that carries another scan removes nothing and says to look again", () => {
    const { fx } = fixture(); const home = fx.home;
    const r = go<DiskCleanRunResult>(fx, "seq", "scan-then-run-with-another-at");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("scan again");
    expect(r.lines).toEqual([]);
    expect(existsSync(join(home, ".local/share/Trash/files/old.zip"))).toBe(true);
  });
});
