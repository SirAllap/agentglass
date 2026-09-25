/**
 * The two halves that keep test tmux servers out of the developer's machine:
 * the preload's rule for which new sockets this run leaked (tmuxleak.ts), and
 * the reaper for a run that was interrupted before it could stop its own
 * servers (tmuxTmp.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { leakedByThisRun } from "./tmuxleak.ts";
import { reapOrphanRuns, socketDirUnder } from "./tmuxTmp.ts";

describe("leakedByThisRun", () => {
  test("only new entries carrying the pid as a whole number", () => {
    const seen = new Set(["agentglass", "agx-orbit-4242"]);
    // "agx-run.4242" carries the pid glued on with a dot, not this house's
    // hyphen separator -- a concurrent run's own label, not ours, and it must
    // not be attributed to us just because a non-digit sits on both sides.
    const now = [
      "agentglass", "agx-orbit-4242", "agx-orbit-4242-b", "agx-orbit-42421", "agx-acme",
      "agx-quiet-4242", "agx-run.4242",
    ];
    expect(leakedByThisRun(now, seen, 4242)).toEqual(["agx-orbit-4242-b", "agx-quiet-4242"]);
  });
});

describe("reapOrphanRuns", () => {
  const root = mkdtempSync("/tmp/agx-reap-");
  const deadPid = (() => { const p = Bun.spawnSync(["true"]); return p.pid; })();
  const orphan = join(root, `agx-test-tmux-${deadPid}`);
  const living = join(root, `agx-test-tmux-${process.ppid}`);
  const sock = join(socketDirUnder(orphan), "agx-orbit");
  const tmux = (...a: string[]) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TMUX") env[k] = v;
    return Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", sock, ...a], { env, stdout: "pipe", stderr: "ignore" });
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let server = 0;

  afterAll(() => {
    // Ours, by pid: once the directory is gone the socket no longer reaches it.
    if (server && alive(server)) process.kill(server);
    rmSync(root, { recursive: true, force: true });
  });

  const backdate = (path: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    utimesSync(path, t, t);
  };

  test("stops the servers of a run that is gone and removes its directory; leaves a live run alone", () => {
    mkdirSync(socketDirUnder(orphan), { recursive: true, mode: 0o700 });
    mkdirSync(socketDirUnder(living), { recursive: true, mode: 0o700 });
    expect(tmux("new-session", "-d", "sleep", "60").exitCode).toBe(0);
    server = Number(tmux("display-message", "-p", "#{pid}").stdout.toString().trim());
    expect(server).toBeGreaterThan(0);
    // Starting the server just wrote the socket file, so both directories
    // read as touched moments ago; back them past the 15-minute floor so the
    // ESRCH verdict on `deadPid` is trusted.
    backdate(orphan, 16 * 60_000);
    backdate(socketDirUnder(orphan), 16 * 60_000);

    expect(reapOrphanRuns(root)).toBe(1);
    // kill-server returns once the signal is sent, not once the server is gone.
    const deadline = Date.now() + 2000;
    while (alive(server) && Date.now() < deadline) Bun.sleepSync(20);
    expect(alive(server)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(living)).toBe(true);
  });

  test("a run dir that is a symlink is never followed, never killed, never removed", () => {
    const targetRoot = mkdtempSync("/tmp/agx-reap-target-");
    const targetSockDir = socketDirUnder(targetRoot);
    mkdirSync(targetSockDir, { recursive: true, mode: 0o700 });
    const targetSock = join(targetSockDir, "agx-orbit");
    const t = (...a: string[]) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TMUX") env[k] = v;
      return Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", targetSock, ...a], { env, stdout: "pipe", stderr: "ignore" });
    };
    expect(t("new-session", "-d", "sleep", "60").exitCode).toBe(0);
    const targetServer = Number(t("display-message", "-p", "#{pid}").stdout.toString().trim());
    backdate(targetRoot, 16 * 60_000);
    backdate(targetSockDir, 16 * 60_000);

    const linkPid = (() => { const p = Bun.spawnSync(["true"]); return p.pid; })();
    const linkName = join(root, `agx-test-tmux-${linkPid}`);
    symlinkSync(targetRoot, linkName);

    try {
      expect(reapOrphanRuns(root)).toBe(0);
      expect(lstatSync(linkName).isSymbolicLink()).toBe(true);
      expect(existsSync(targetRoot)).toBe(true);
      expect(alive(targetServer)).toBe(true);
    } finally {
      t("kill-server");
      rmSync(linkName, { force: true });
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  test("a dead pid with a freshly touched run dir is not reaped", () => {
    const pid = (() => { const p = Bun.spawnSync(["true"]); return p.pid; })();
    const dir = join(root, `agx-test-tmux-${pid}`);
    mkdirSync(socketDirUnder(dir), { recursive: true, mode: 0o700 });
    // No backdating: this run dir was touched moments ago, same as a live run.
    expect(reapOrphanRuns(root)).toBe(0);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
