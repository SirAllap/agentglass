/*
 * The pull-request side of "Check on base", against a fixture repository whose
 * remote is an invented `acme/orbit` and a GitHub that is a function: which two
 * commits, whether they are here, one experiment per repository at a time, and
 * a cancel that stops the rest. What the experiment itself guarantees is in
 * check-on-base.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cob-pr-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.XDG_DATA_HOME = dir;
process.env.XDG_CACHE_HOME = dir;
process.env.AGENTGLASS_STATE_DIR = dir;
process.env.AGENTGLASS_DB = join(dir, "p.db");
const { planCheckOnBase, startCheckOnBase, checkOnBaseStatus, cancelCheckOnBase } = await import("../src/checkOnBasePr.ts");
const { sandboxKind } = await import("../src/checkOnBase.ts");
type Deps = import("../src/checkOnBasePr.ts").GhDeps;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", root, "-c", "user.name=Orbit Test", "-c", "user.email=test@orbit.invalid", ...args], { env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" } });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const root = join(dir, "orbit");
Bun.spawnSync(["mkdir", "-p", root]);
git(root, "init", "-q", "-b", "main");
git(root, "remote", "add", "upstream", "https://github.com/acme/orbit.git");
const commit = (n: number) => { writeFileSync(join(root, "note.txt"), String(n)); git(root, "add", "-A"); git(root, "commit", "-q", "-m", `step ${n}`); return git(root, "rev-parse", "HEAD"); };
const BASE = commit(0);
const HEAD = commit(1);

/** What the page sends: the two commits and the sandbox it showed, and the say-so a no-box run needs. */
const CONFIRM = { baseSha: BASE, headSha: HEAD, sandbox: sandboxKind(), allowNoSandbox: true };

/** A GitHub that answers the two requests the plan makes, and remembers what it was asked. */
function fakeGh(over: { base?: string; head?: string; prFails?: boolean; tipFails?: boolean; sandbox?: "bwrap" | "none" } = {}): Deps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    sandbox: over.sandbox ? () => over.sandbox! : undefined,
    gh: async (args) => {
      const path = args[1]!;
      asked.push(path);
      if (/\/pulls\/\d+$/.test(path)) return over.prFails ? { code: 1, stdout: "", stderr: "HTTP 404" } : { code: 0, stdout: JSON.stringify({ base: "main", head: over.head ?? HEAD }), stderr: "" };
      if (/\/branches\/main$/.test(path)) return over.tipFails ? { code: 1, stdout: "", stderr: "HTTP 404" } : { code: 0, stdout: `${over.base ?? BASE}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  };
}

const settle = async (id: string) => {
  for (let i = 0; i < 400; i++) { const s = checkOnBaseStatus(id); if (!s.ok || s.state === "done") return s; await Bun.sleep(50); }
  throw new Error("the check never finished");
};

describe("the plan", () => {
  test("names the base branch's tip and the PR's head, asks GitHub twice, and says both are here", async () => {
    const g = fakeGh();
    const p = await planCheckOnBase(root, 7, g);
    expect(p.ok && p.plan).toMatchObject({ base: { ref: "main", sha: BASE, local: true }, head: { sha: HEAD, local: true }, runs: 3 });
    expect(g.asked).toEqual(["repos/acme/orbit/pulls/7", "repos/acme/orbit/branches/main"]);
  });

  test("a tip that is not in this repository is reported as not local, never fetched", async () => {
    const p = await planCheckOnBase(root, 7, fakeGh({ base: "c".repeat(40) }));
    expect(p.ok && p.plan.base.local).toBe(false);
    expect(await startCheckOnBase(root, 7, "true", CONFIRM, fakeGh({ base: "c".repeat(40) }))).toEqual({ ok: false, error: "the base commit is not local (ccccccc on main)" });
  });

  test("a GitHub that does not answer is said in words", async () => {
    expect(await planCheckOnBase(root, 7, fakeGh({ prFails: true }))).toEqual({ ok: false, error: "could not read the pull request from GitHub" });
    expect(await planCheckOnBase(root, 7, fakeGh({ tipFails: true }))).toEqual({ ok: false, error: "could not read the tip of main on GitHub" });
    expect(await planCheckOnBase(root, 7, fakeGh({ head: "not-a-sha" }))).toEqual({ ok: false, error: "could not read the pull request from GitHub" });
  });

  test("a root with no checkout, or a bad number, stops before anything is asked", async () => {
    const g = fakeGh();
    expect(await planCheckOnBase("gh:acme/orbit", 7, g)).toMatchObject({ ok: false });
    expect(await planCheckOnBase(root, "7; rm", g)).toEqual({ ok: false, error: "invalid pull request number" });
    expect(g.asked).toEqual([]);
  });
});

describe("a run", () => {
  test("starts from the confirmed command, reports progress, and ends with facts", async () => {
    const started = await startCheckOnBase(root, 7, `test "$(cat note.txt)" = 0`, CONFIRM, fakeGh());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const s = await settle(started.id);
    expect(s.ok && s.state === "done" && s.result.facts).toBe("passed 3/3 on base, failed 3/3 on head");
    if (s.ok && s.state === "done") {
      expect(s.result).toMatchObject({ base: { ref: "main", sha: BASE }, head: { sha: HEAD } });
      expect(s.result.base.tally).toMatchObject({ runs: 3, passed: 3 });
    }
  }, 60_000);

  test("one at a time per repository, and a cancel stops the rest", async () => {
    const first = await startCheckOnBase(root, 7, "sleep 1", CONFIRM, fakeGh());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await startCheckOnBase(root, 8, "true", CONFIRM, fakeGh())).toEqual({ ok: false, error: "a check is already running on this repository" });
    expect(cancelCheckOnBase(first.id)).toEqual({ ok: true });
    const s = await settle(first.id);
    expect(s.ok && s.state === "done" && s.result.cancelled).toBe(true);
    expect(cancelCheckOnBase(first.id)).toEqual({ ok: false });
    expect(checkOnBaseStatus("no-such-id")).toEqual({ ok: false, error: "no such check" });
  }, 60_000);

  test("a command that is not a string never reaches a shell", async () => {
    expect(await startCheckOnBase(root, 7, { toString: () => "touch /tmp/agx-cob-pwned" }, CONFIRM, fakeGh())).toEqual({ ok: false, error: "write the command to run" });
    expect(await startCheckOnBase(root, 7, "  ", CONFIRM, fakeGh())).toEqual({ ok: false, error: "write the command to run" });
  }, 60_000);
});

describe("what runs is what was confirmed", () => {
  test("a base or head that is not the one shown, or a sandbox that is not the one shown, runs nothing", async () => {
    const changed = { ok: false as const, error: "the commits or the sandbox changed since you looked; open it again" };
    expect(await startCheckOnBase(root, 7, "true", { ...CONFIRM, baseSha: "d".repeat(40) }, fakeGh())).toEqual(changed);
    expect(await startCheckOnBase(root, 7, "true", { ...CONFIRM, headSha: BASE }, fakeGh())).toEqual(changed);
    expect(await startCheckOnBase(root, 7, "true", { ...CONFIRM, sandbox: sandboxKind() === "bwrap" ? "none" : "bwrap" }, fakeGh())).toEqual(changed);
    expect(await startCheckOnBase(root, 7, "true", {}, fakeGh())).toEqual(changed);
    expect(await startCheckOnBase(root, 7, "true", undefined, fakeGh())).toEqual(changed);
  });

  test("with no sandbox the request must say so itself; the page's warning is not the guard", async () => {
    const none = fakeGh({ sandbox: "none" });
    const asked = { baseSha: BASE, headSha: HEAD, sandbox: "none" };
    expect(await startCheckOnBase(root, 7, "true", asked, none)).toEqual({ ok: false, error: "no sandbox is available here; running without one needs your explicit say-so" });
    expect(await startCheckOnBase(root, 7, "true", { ...asked, allowNoSandbox: "yes" }, none)).toMatchObject({ ok: false });
    const started = await startCheckOnBase(root, 7, "true", { ...asked, allowNoSandbox: true }, none);
    expect(started.ok).toBe(true);
    if (started.ok) { const s = await settle(started.id); expect(s.ok && s.state === "done" && s.result.sandbox).toBe("none"); }
  }, 60_000);

  test("at most two checks run at once, across repositories", async () => {
    const repos = [0, 1, 2].map((n) => {
      const r = join(dir, `extra-${n}`);
      Bun.spawnSync(["mkdir", "-p", r]);
      git(r, "init", "-q", "-b", "main");
      git(r, "remote", "add", "upstream", "https://github.com/acme/orbit.git");
      writeFileSync(join(r, "note.txt"), "0"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "a");
      const base = git(r, "rev-parse", "HEAD");
      writeFileSync(join(r, "note.txt"), "1"); git(r, "commit", "-q", "-am", "b");
      return { r, base, head: git(r, "rev-parse", "HEAD") };
    });
    const go = (x: (typeof repos)[number]) => startCheckOnBase(x.r, 7, "sleep 5", { baseSha: x.base, headSha: x.head, sandbox: sandboxKind(), allowNoSandbox: true }, fakeGh({ base: x.base, head: x.head }));
    const a = await go(repos[0]!);
    const b = await go(repos[1]!);
    expect(a.ok && b.ok).toBe(true);
    expect(await go(repos[2]!)).toEqual({ ok: false, error: "too many checks are running; wait for one to finish" });
    for (const j of [a, b]) if (j.ok) { cancelCheckOnBase(j.id); await settle(j.id); }
  }, 60_000);
});
