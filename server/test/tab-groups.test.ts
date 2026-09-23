/*
 * What the tab strip groups windows by, from the server's side: the two window
 * options it writes and reads back (`@agx-group`, `@agx-pin`), the directory a
 * window is in, and the project that directory belongs to.
 *
 * Real tmux on a private socket for the options — whether `set-option -w -u`
 * really clears one, and whether the frame's format really reads them back, are
 * claims about tmux — and real git for the project, because "every worktree of
 * one repository is one group" is a claim about `--git-common-dir`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { FRAME_ARGV, parseWindows, runAction, sanitizeGroupName, type TmuxTarget } from "../src/tmuxctl.ts";
import { __resetWindowRepo, windowRepo } from "../src/windowrepo.ts";
import { projectRootOfAsync } from "../src/git.ts";

const SOCK = [...TMUX_ISOLATED, "-L", `agx-tabgroups-${process.pid}`];
const TMPDIR = `/tmp/agx-tmux-tabgroups-${process.pid}`;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const has = !!Bun.which("tmux");
/** Without TMUX: this suite may itself be running inside somebody's tmux. */
const env = () => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TMUX") e[k] = v;
  return e;
};
const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 4000, env: env() });
const out = (args: string[]) => raw(args).stdout.toString().trim();

let target: TmuxTarget;
let win = "";
let savedTmux: string | undefined;

beforeAll(() => {
  if (!has) return;
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  savedTmux = process.env.TMUX;
  delete process.env.TMUX;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "groups", "-n", "api", "-c", "/tmp", "sleep 600"]);
  raw(["new-window", "-t", "groups", "-n", "web", "-c", "/", "sleep 600"]);
  const id = out(["display-message", "-p", "-t", "groups", "#{session_id}"]);
  target = { pid: 0, socket: SOCK, session: "groups", id };
  win = out(["list-windows", "-t", "groups", "-F", "#{window_id}"]).split("\n")[0]!;
});

afterAll(() => {
  if (has) raw(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (savedTmux !== undefined) process.env.TMUX = savedTmux;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* gone */ }
});

/** The strip's own windows, read with the sweep's own format. */
const frameWindows = () => {
  const at = FRAME_ARGV.indexOf("list-windows");
  const fmt = FRAME_ARGV[FRAME_ARGV.indexOf("-F", at) + 1]!;
  const rows = out(["list-windows", "-t", "groups", "-F", fmt]).split("\n")
    .map((r) => r.split("\t").slice(2).join("\t"));
  return parseWindows(rows.join("\n"));
};

describe.skipIf(!has)("the window options, against real tmux", () => {
  test("a window starts in no group, unpinned, with its directory", () => {
    const w = frameWindows().find((x) => x.id === win)!;
    expect(w.group).toBeUndefined();
    expect(w.pinned).toBeUndefined();
    expect(w.cwd).toBe(realpathSync("/tmp"));
  });

  test("group sets @agx-group and the frame reads it back; no name clears it", () => {
    expect(runAction(target, "group", win, "orbit")).toBe(true);
    expect(frameWindows().find((x) => x.id === win)!.group).toBe("orbit");
    expect(runAction(target, "group", win)).toBe(true);
    expect(frameWindows().find((x) => x.id === win)!.group).toBeUndefined();
  });

  test("pin sets and clears @agx-pin", () => {
    expect(runAction(target, "pin", win, undefined, undefined, undefined, true)).toBe(true);
    expect(frameWindows().find((x) => x.id === win)!.pinned).toBe(true);
    expect(runAction(target, "pin", win, undefined, undefined, undefined, false)).toBe(true);
    expect(frameWindows().find((x) => x.id === win)!.pinned).toBeUndefined();
  });

  test("a window that is not on this server is refused", () => {
    expect(runAction(target, "group", "@9999", "orbit")).toBe(false);
    expect(runAction(target, "pin", "not-an-id", undefined, undefined, undefined, true)).toBe(false);
  });
});

describe("parsing", () => {
  test("the appended fields are read, and absent ones stay absent", () => {
    const [w] = parseWindows("@1\t1\tapi\t1\t*\t\t120\t40\tdesk\tops\t1\t/home/dev/code/orbit");
    expect(w).toMatchObject({ id: "@1", group: "ops", pinned: true, cwd: "/home/dev/code/orbit" });
    const [old] = parseWindows("@2\t2\tweb\t0\t-\t\t120\t40\tdesk");
    expect(old!.group).toBeUndefined();
    expect(old!.pinned).toBeUndefined();
    expect(old!.cwd).toBeUndefined();
  });

  test("a group name is held to one short printable line", () => {
    expect(sanitizeGroupName("  orbit  ")).toBe("orbit");
    expect(sanitizeGroupName("a\u0007b\nc")).toBe("abc");
    expect(sanitizeGroupName("x".repeat(80))).toHaveLength(32);
    expect(sanitizeGroupName("   ")).toBeNull();
    expect(sanitizeGroupName(7)).toBeNull();
  });
});

describe("the project a directory belongs to", () => {
  test("looked up once, off the sweep, then answered from the cache", async () => {
    __resetWindowRepo();
    let calls = 0;
    let release!: (v: string | null) => void;
    const slow = () => { calls++; return new Promise<string | null>((r) => { release = r; }); };
    expect(windowRepo("/home/dev/code/orbit/src", slow)).toBeUndefined();
    expect(windowRepo("/home/dev/code/orbit/src", slow)).toBeUndefined(); // still pending: no second lookup
    expect(calls).toBe(1);
    release("/home/dev/code/orbit");
    await Bun.sleep(0);
    expect(windowRepo("/home/dev/code/orbit/src", slow)).toBe("/home/dev/code/orbit");
    expect(calls).toBe(1);
    __resetWindowRepo();
  });

  test("a directory in no repository is null, not pending — and is asked again a minute on", async () => {
    __resetWindowRepo();
    windowRepo("/srv/x", async () => null);
    await Bun.sleep(0);
    let asked = 0;
    const now = Date.now();
    expect(windowRepo("/srv/x", async () => { asked++; return "/srv/x"; }, now)).toBeNull();
    expect(asked).toBe(0);
    // A `git init` there, or a lookup that failed at startup, is not forever.
    expect(windowRepo("/srv/x", async () => { asked++; return "/srv/x"; }, now + 61_000)).toBeNull();
    await Bun.sleep(0);
    expect(asked).toBe(1);
    expect(windowRepo("/srv/x", async () => "never", now + 62_000)).toBe("/srv/x");
    __resetWindowRepo();
  });

  test("a linked worktree beside the main checkout is the same project", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agx-tabgroups-git-")));
    const main = join(root, "orbit");
    const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a], {
      stdout: "pipe", stderr: "pipe",
      env: { ...env(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
    });
    try {
      mkdirSync(join(main, "src"), { recursive: true });
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "start");
      git(main, "worktree", "add", "-q", join(root, "orbit-fix-login"));
      expect(await projectRootOfAsync(join(main, "src"))).toBe(main);
      expect(await projectRootOfAsync(join(root, "orbit-fix-login"))).toBe(main);
      expect(await projectRootOfAsync(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
