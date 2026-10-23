// Processes an agent left behind. The classifier is pure, so its rules are
// asserted against rows shaped like real /proc reads (comm, a joined cmdline, a
// readlink that ends in " (deleted)"), and one test starts a real detached
// child to see the sampler and the stop route agree with the table.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyOrphans, sampleOrphans, stopOrphan, type OrphanContext, type OrphanRow,
} from "../src/orphans.ts";

const SESSION = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SCRATCH = `/home/dev/.cache/tmp/${SESSION}/scratchpad`;
// `isWorktree` is injected so no test reads the disk: only the orbit checkouts have a .git.
const ctx: OrphanContext = {
  initPids: [1, 2100], worktreeRoots: ["/home/dev/code/orbit-feat"], selfPid: 5000, home: "/home/dev",
  isWorktree: (d) => d.startsWith("/home/dev/code/orbit-") && d.split("/").length === 5,
};
const H = 3600;

const row = (o: Partial<OrphanRow>): OrphanRow => ({
  pid: 4242, ppid: 2100, comm: "bun", cmd: "bun run dev", cwd: "/home/dev/code/orbit-feat", ageSec: 3 * H,
  cpu: 1, cpuSamples: 6, rss: 80e6, ...o,
});
const flagged = (o: Partial<OrphanRow>) => classifyOrphans([row(o)], ctx);

describe("what is left behind", () => {
  test("a test runner re-parented to the user's systemd and running for days is flagged, with its reasons", () => {
    const [p] = flagged({ cmd: "bun test --timeout 5000", cwd: "/home/dev/code/orbit-feat/web", ageSec: 6 * 86400 + 15 * H, cpu: 45 });
    expect(p).toBeDefined();
    expect(p!.hot).toBe(true);
    expect(p!.origin).toBe("worktree orbit-feat");
    expect(p!.reasons.join(" | ")).toContain("should finish");
    expect(p!.reasons.join(" | ")).toContain("6d15h");
    expect(p!.reasons.join(" | ")).toContain("45%");
  });

  test("a scratchpad script with a deleted working directory is flagged and names its session", () => {
    const [p] = flagged({
      ppid: 1, cmd: `bun ${SCRATCH}/burst.ts`, cwd: "/home/dev/code/orbit-gone (deleted)", ageSec: 2 * 86400, cpu: 60,
    });
    expect(p!.cwdGone).toBe(true);
    expect(p!.cwd).toBe("/home/dev/code/orbit-gone");
    expect(p!.session).toBe(SESSION);
    expect(p!.origin).toBe("an agent scratchpad");
    expect(p!.reasons.join(" | ")).toContain("deleted");
  });

  test("a deleted working directory flags a process whose parent is alive", () => {
    expect(flagged({ ppid: 777, comm: "node", cmd: "node server.js", cwd: "/tmp/x (deleted)", ageSec: 60 })).toHaveLength(1);
    expect(flagged({ ppid: 777, comm: "mystery", cmd: "/home/dev/bin/mystery", cwd: "/tmp/x (deleted)", ageSec: 60 })).toHaveLength(0);
  });

  test("re-parented and old, from a worktree, is NOT enough on its own", () => {
    expect(flagged({ cmd: "node dev-server.js", ageSec: 30 * H })).toHaveLength(0);
  });

  test("busy and re-parented in a worktree is flagged only after enough samples", () => {
    const base = { cmd: "node worker.js", cwd: "/home/dev/code/orbit-feat" };
    expect(flagged({ ...base, cpu: 70, cpuSamples: 1 })).toHaveLength(0);
    expect(flagged({ ...base, cpu: 70, cpuSamples: 4 })).toHaveLength(1);
    expect(flagged({ ...base, cpu: 3, cpuSamples: 4 })).toHaveLength(0);
  });

  test("a one-shot command still alive after hours is flagged even with a live parent, a watcher is not", () => {
    const wt = "/home/dev/code/orbit-feat";
    expect(flagged({ ppid: 777, cmd: "bun test", ageSec: 5 * H, cwd: wt })).toHaveLength(1);
    expect(flagged({ ppid: 777, cmd: "bun test", ageSec: 1 * H, cwd: wt })).toHaveLength(0);
    expect(flagged({ ppid: 777, cmd: "tsc --watch", ageSec: 5 * H, cwd: wt })).toHaveLength(0);
    // no origin: a one-shot name in an ordinary directory is not enough
    expect(flagged({ ppid: 777, cmd: "bun test", ageSec: 5 * H, cwd: "/home/dev/other" })).toHaveLength(0);
  });

  test("an ordinary dev server in a live shell is left alone", () => {
    expect(flagged({ ppid: 777, cmd: "bun run dev", ageSec: 30 * H })).toHaveLength(0);
  });

  test("results come back hottest first", () => {
    const out = classifyOrphans([
      row({ pid: 1, cmd: "bun test", ageSec: 9 * H, cpu: 2 }),
      row({ pid: 2, cmd: "bun test", ageSec: 9 * H, cpu: 50 }),
    ], ctx);
    expect(out.map((p) => p.pid)).toEqual([2, 1]);
  });
});

describe("what is never flagged", () => {
  // Each of these would be flagged for several reasons at once if the allow
  // list did not come first: re-parented, hot, old, cwd deleted.
  const trap = { ppid: 1, cwd: `${SCRATCH} (deleted)`, ageSec: 30 * 86400, cpu: 99, cpuSamples: 6 };
  const never: [string, Partial<OrphanRow>][] = [
    ["a browser", { comm: "chrome", cmd: "/opt/chrome/chrome --type=renderer" }],
    ["a browser's helper under its own name", { comm: "firefox", cmd: "firefox -contentproc" }],
    ["tmux", { comm: "tmux: server", cmd: "tmux -L agx-x new-session" }],
    ["the app itself", { comm: "agentglass-serve", cmd: "/opt/agentglass/agentglass-server" }],
    ["electron", { comm: "electron", cmd: "/opt/agentglass/electron --type=gpu-process" }],
    ["an editor", { comm: "nvim", cmd: "nvim notes.md" }],
    ["docker", { comm: "dockerd", cmd: "/usr/bin/dockerd -H fd://" }],
    ["systemd", { comm: "systemd", cmd: "/usr/lib/systemd/systemd --user" }],
    ["a shell", { comm: "bash", cmd: "bash" }],
    ["a login shell", { comm: "zsh", cmd: "-zsh" }],
    ["a chat app under systemd --user", { comm: "slack", cmd: "/usr/lib/slack/slack --type=renderer" }],
    ["a keyring daemon", { comm: "gnome-keyring-d", cmd: "/usr/bin/gnome-keyring-daemon --foreground" }],
    ["an input method", { comm: "fcitx5", cmd: "/usr/bin/fcitx5" }],
    ["a portal", { comm: "xdg-desktop-por", cmd: "/usr/lib/xdg-desktop-portal" }],
    ["a dictation daemon", { comm: "voxtype", cmd: "/usr/bin/voxtype daemon" }],
    ["an indexer", { comm: "localsearch-3", cmd: "/usr/lib/localsearch-3" }],
    ["an unknown daemon in a package path", { comm: "thingd", cmd: "/opt/thing/thingd --serve" }],
  ];
  for (const [name, o] of never) {
    test(name, () => expect(flagged({ ...trap, ...o })).toHaveLength(0));
  }

  test("this server's own pid", () => {
    expect(flagged({ ...trap, pid: ctx.selfPid!, comm: "bun", cmd: "bun src/index.ts" })).toHaveLength(0);
  });

  test("a checkout whose name contains agentglass does not exempt a test run in it", () => {
    expect(flagged({ ...trap, comm: "bun", cmd: "bun test /home/dev/code/agentglass-x/web" })).toHaveLength(1);
  });
});

describe("the home directory is not a worktree", () => {
  // Measured: 296 desktop apps flagged, each "from worktree <user>", because
  // the home directory was a registered root.
  const homeCtx: OrphanContext = { ...ctx, worktreeRoots: ["/home/dev", "/home", "/home/dev/code/orbit-feat"], isWorktree: (d) => d.includes("orbit-") };
  const app = row({ ppid: 2100, comm: "mystery", cmd: "/home/dev/.local/bin/mystery", cwd: "/home/dev", ageSec: 90 * H, cpu: 90 });
  test("a hot, old, re-parented process whose cwd is ~ has no origin and is not flagged", () => {
    expect(classifyOrphans([app], homeCtx)).toHaveLength(0);
    expect(classifyOrphans([{ ...app, cwd: "/home/dev/.config/thing" }], homeCtx)).toHaveLength(0);
  });
  test("a real checkout under ~ still counts", () => {
    expect(classifyOrphans([{ ...app, cwd: "/home/dev/code/orbit-feat/web" }], homeCtx)).toHaveLength(1);
  });
});

// Shape of the real list that came back from a laptop after the fix: dev
// servers, their esbuild and node children, all with a deleted checkout.
describe("real-shaped list: leftovers flagged, desktop around them not", () => {
  const dead = (n: string) => `/home/dev/code/orbit-${n}`;
  const rows: OrphanRow[] = [
    row({ pid: 10, comm: "bun", cmd: "bun --no-env-file run src/index.ts", cwd: `${dead("a")}/server (deleted)`, ageSec: 214 * H, cpu: null }),
    row({ pid: 11, comm: "node-MainThread", cmd: `node ${dead("a")}/web/node_modules/.bin/vite`, cwd: `${dead("a")}/web (deleted)`, ageSec: 214 * H }),
    row({ pid: 12, comm: "esbuild", cmd: `${dead("a")}/node_modules/.bun/@esbuild/linux-x64/bin/esbuild --service`, cwd: `${dead("a")}/web (deleted)`, ageSec: 214 * H }),
    row({ pid: 20, comm: "slack", cmd: "/usr/lib/slack/slack", cwd: "/home/dev", ageSec: 300 * H, cpu: 40 }),
    row({ pid: 21, comm: "gnome-keyring-d", cmd: "/usr/bin/gnome-keyring-daemon --foreground", cwd: "/home/dev", ageSec: 300 * H }),
    row({ pid: 22, comm: "git", cmd: "git fsmonitor--daemon run", cwd: "/home/dev", ageSec: 100 * H }),
    row({ pid: 23, comm: "engram", cmd: "/home/dev/.local/bin/engram serve", cwd: "/home/dev", ageSec: 100 * H }),
  ];
  test("exactly the deleted-checkout trio", () => {
    expect(classifyOrphans(rows, ctx).map((p) => p.pid).sort()).toEqual([10, 11, 12]);
  });
});

// ------------------------------------------------------------ the real one --

describe("a real detached child", () => {
  // The suite refuses reads of real paths; no .git is looked for on the real disk.
  const noDisk = { isWorktree: () => false };
  const dir = mkdtempSync(join(tmpdir(), "agx-orphan-"));
  const pids: number[] = [];
  afterAll(() => { for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch { /* already gone */ } } rmSync(dir, { recursive: true, force: true }); });

  test("is flagged when its directory is deleted, and stop kills that pid and only that pid", async () => {
    const sub = join(dir, "wt");
    mkdirSync(sub);
    // cwd in a directory that is removed under it, which is how the measured
    // burst script ended up with a deleted worktree. Its parent is alive (this
    // test), so only the deleted directory can flag it.
    const child = Bun.spawn(["python3", "-c", "import time; time.sleep(300)"], { cwd: sub, stdio: ["ignore", "ignore", "ignore"] });
    pids.push(child.pid);
    rmSync(sub, { recursive: true, force: true });

    const report = sampleOrphans({ isWorktree: () => false });
    const mine = report.procs.find((p) => p.pid === child.pid);
    expect(mine).not.toBeUndefined();
    expect(mine!.cwdGone).toBe(true);

    // A bystander (this test process) is refused, and is still alive after.
    expect(stopOrphan(process.pid, noDisk).ok).toBe(false);
    expect(stopOrphan(1, noDisk).ok).toBe(false);

    const res = stopOrphan(mine!.pid, noDisk, 200);
    expect(res.ok).toBe(true);
    await Bun.sleep(400);
    expect(() => process.kill(mine!.pid, 0)).toThrow();
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  test("a live process that is not flagged cannot be stopped through this door", async () => {
    const quiet = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
    pids.push(quiet.pid);
    const res = stopOrphan(quiet.pid, noDisk);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not flagged");
    expect(() => process.kill(quiet.pid, 0)).not.toThrow();
    quiet.kill();
  });
});
