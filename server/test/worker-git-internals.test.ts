/*
 * `workers.gitInternals`: whether a sandboxed worker's shell may write the git
 * paths that run code on the next git command (hooks, config, config.worktree,
 * submodule git dirs, a core.hooksPath directory). Shut by default, as the
 * sandbox always had them.
 *
 * Measured with real sandboxed `claude -p` turns: with this open, a write to the
 * core.hooksPath directory and to `.git/modules` lands, while `.git/hooks` and
 * `.git/config` stay read-only because the CLI shuts those itself. So the
 * setting's words name what it lifts, not those two.
 *
 * What opening must NOT do is the point of this file. It only drops those deny
 * entries. It never adds an allow root, never lifts what proves a linked
 * worktree is the worker's own (`.git` file, commondir, the gitdir back-pointer),
 * never opens refs or logs for a role that may not commit, and never lets an
 * agent turn it on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { identify } from "./gitIdentity.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";
import { agentVerdict } from "../../shared/settingClass.ts";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import { gitWriteRoots, linkedTreeRefusal, sandboxFor } from "../src/agents/headless.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-git-internals-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
function repo(name: string): string {
  const at = join(dir, name);
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q", "-b", "main");
  identify(at);
  writeFileSync(join(at, "a.txt"), "one\n");
  git(at, "add", "-A");
  git(at, "commit", "-qm", "first");
  return at;
}

describe("a plain checkout", () => {
  const at = repo("plain");
  mkdirSync(join(at, ".husky"));
  git(at, "config", "core.hooksPath", ".husky");
  const dotGit = join(at, ".git");

  test("shut by default, and naming false is the same answer as naming nothing", () => {
    const shut = gitWriteRoots(at, false, true);
    expect(shut.deny).toContain(join(dotGit, "hooks"));
    expect(shut.deny).toContain(join(dotGit, "config"));
    expect(shut.deny).toContain(join(at, ".husky"));
    expect(gitWriteRoots(at, false, true, false)).toEqual(shut);
  });

  test("open drops the code-running entries and nothing else", () => {
    const open = gitWriteRoots(at, false, true, true);
    for (const p of [join(dotGit, "hooks"), join(dotGit, "config"), join(dotGit, "config.worktree"), join(at, ".husky")]) expect(open.deny).not.toContain(p);
    // A role that may not commit still cannot move a branch: refs, logs, packed-refs, and other trees' state stay shut.
    for (const p of ["refs", "logs", "packed-refs", "worktrees"]) expect(open.deny).toContain(join(dotGit, p));
    expect(open.allow).toEqual([]);
  });

  test("opening adds no allow root and a committing role still has refs open", () => {
    const shut = gitWriteRoots(at, true, true);
    const open = gitWriteRoots(at, true, true, true);
    expect(open.allow).toEqual(shut.allow);
    expect(open.deny).not.toContain(join(dotGit, "refs"));
    expect(shut.deny).not.toContain(join(dotGit, "refs"));
  });
});

describe("a linked worktree", () => {
  const main = repo("main-l");
  const wt = join(dir, "wt-l");
  expect(git(main, "worktree", "add", wt, "-b", "side").exitCode).toBe(0);
  const gitdir = realpathSync(resolve(wt, git(wt, "rev-parse", "--git-dir").stdout.toString("utf8").trim()));

  test("the allow roots are identical shut and open; the proof of ownership stays denied", () => {
    const shut = gitWriteRoots(wt, true, true);
    const open = gitWriteRoots(wt, true, true, true);
    expect(open.allow).toEqual(shut.allow);
    for (const p of [join(wt, ".git"), join(gitdir, "commondir"), join(gitdir, "gitdir")]) expect(open.deny).toContain(p);
    // Every entry open drops is a code-running one; the rest of the list is the same.
    const dropped = shut.deny.filter((p) => !open.deny.includes(p));
    for (const p of dropped) expect(p).toMatch(/\/(hooks|config|config\.worktree|modules)$/);
    expect(open.deny.filter((p) => !shut.deny.includes(p))).toEqual([]);
  });

  test("another worktree's gitdir named by a forged .git file is still refused, open or shut", () => {
    const other = join(dir, "wt-other");
    expect(git(main, "worktree", "add", other, "-b", "other").exitCode).toBe(0);
    const forged = join(dir, "forged");
    mkdirSync(forged);
    const otherGitdir = realpathSync(resolve(other, git(other, "rev-parse", "--git-dir").stdout.toString("utf8").trim()));
    writeFileSync(join(forged, ".git"), `gitdir: ${otherGitdir}\n`);
    for (const open of [false, true]) {
      const r = gitWriteRoots(forged, true, true, open);
      expect(r.allow, `open=${open}`).toEqual([]);
      expect(r.deny).toContain(join(forged, ".git"));
    }
  });
});

describe("a .git that is not the tree's own", () => {
  test("a .git file pointing at a gitdir it cannot prove allows nothing, open or shut", () => {
    const t = join(dir, "loose");
    mkdirSync(join(t, "elsewhere", "hooks"), { recursive: true });
    writeFileSync(join(t, "elsewhere", "config"), "");
    writeFileSync(join(t, ".git"), "gitdir: elsewhere\n");
    for (const open of [false, true]) {
      const r = gitWriteRoots(t, true, true, open);
      expect(r.allow, `open=${open}`).toEqual([]);
      expect(r.deny, `open=${open}`).toContain(join(t, ".git"));
    }
  });

  test("a .git that is a symlink is refused the turn whatever the setting says", () => {
    const t = join(dir, "linked");
    mkdirSync(join(t, "real"), { recursive: true });
    symlinkSync(join(t, "real"), join(t, ".git"));
    const builder = workerRole("builder")!;
    expect(linkedTreeRefusal(builder, DEFAULT_WORKER_ENVELOPE, t)).toContain("symbolic link");
    for (const open of [false, true]) expect(gitWriteRoots(t, true, true, open).deny).toContain(join(t, ".git"));
  });
});

describe("the sandbox the turn is given", () => {
  const at = repo("boxed");
  const builder = workerRole("builder")!;
  const deniedIn = (open?: boolean) => ((sandboxFor(builder, DEFAULT_WORKER_ENVELOPE, at, undefined, "off", open)!.filesystem as { denyWrite: string[] }).denyWrite);

  test("the hooks directory is denied unless the project opened it, and the project's .claude never is opened", () => {
    expect(deniedIn()).toContain(join(at, ".git", "hooks"));
    expect(deniedIn(false)).toEqual(deniedIn());
    expect(deniedIn(true)).not.toContain(join(at, ".git", "hooks"));
    for (const open of [false, true]) expect(deniedIn(open)).toContain(join(at, ".claude"));
  });
});

describe("who may open it", () => {
  const id = "workers.gitInternals";
  test("an agent may close it and may not open it, whatever its trust switch says", () => {
    expect(agentVerdict(id, true, false, false)).toBe("apply");
    expect(agentVerdict(id, false, true, false)).toBe("refuse");
    expect(agentVerdict(id, false, true, true)).toBe("refuse");
  });

  test("every turn reads the project's value, not the app's", () => {
    const src = readFileSync(join(import.meta.dir, "../src/agents/policystart.ts"), "utf8");
    expect(src).toContain("gitInternals: workerGitInternals(root)");
    const head = readFileSync(join(import.meta.dir, "../src/agents/headless.ts"), "utf8");
    expect(head).toContain("sandboxFor(t.role, t.envelope, t.cwd, t.runDir, t.unixSockets, t.gitInternals)");
  });

  const have = !!Bun.which("tmux") && !!Bun.which("python3");
  describe.skipIf(!have)("through the door", () => {
    let h: Harness, other: string;
    beforeAll(async () => {
      h = await startHarness("gitinternals");
      other = `${h.dir}-other-project`;
      mkdirSync(other);
    }, SERVER_BOOT_MS);
    afterAll(async () => { if (have) await h.stop(); });
    const at = async (root: string) => ((await h.read(`/settings/door?id=${id}&root=${encodeURIComponent(root)}`, MACHINE)).body as { value: unknown }).value;

    test("the person opens it for one project, a seat cannot open its own, and a seat may close it", async () => {
      expect(await at(other)).toBe(false);
      expect(await h.asPerson("/settings/door", { id, value: true, root: other })).toMatchObject({ status: 200, ok: true });
      expect(await at(other)).toBe(true);
      expect(await at(h.dir)).toBe(false);

      const open = await h.asSeat("/settings/door", { id, value: true });
      expect(open.ok).toBe(false);
      expect(await at(h.dir)).toBe(false);

      expect(await h.asPerson("/settings/door", { id, value: true, root: h.dir })).toMatchObject({ ok: true });
      expect(await h.asSeat("/settings/door", { id, value: false })).toMatchObject({ status: 200, ok: true });
      expect(await at(h.dir)).toBe(false);
      // Another project's row never moved.
      expect(await at(other)).toBe(true);
    });
  });
});
