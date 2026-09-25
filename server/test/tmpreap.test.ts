/*
 * What a killed run leaves in /tmp is taken away by the next one.
 *
 * tmpsweep.test.ts covers the run that exits. This is the one that does not: a
 * SIGKILL runs no handler and no `afterAll`, and measured on the machine this
 * was written for it had left 2,000+ `agx-test-*` directories in a tmpfs. Every
 * case is against a private root, never the real /tmp, and with the liveness
 * check injected — the real one would need a real dead pid.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_PREFIX, pidOf, reapDead } from "./tmpreap.ts";

const root = mkdtempSync(join(tmpdir(), "agx-reapcheck-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const DEAD = 41_000_001, LIVE = 41_000_002;
const alive = (pid: number) => pid === LIVE;
const HOUR = 60 * 60_000;

function made(name: string, ageMs = 2 * HOUR): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  const t = new Date(Date.now() - ageMs);
  utimesSync(p, t, t);
  return p;
}

describe("which pid a name carries", () => {
  test("the shapes the suites use", () => {
    expect(pidOf("agx-tmux-tabs-123")).toBe(123);
    expect(pidOf("agx-test-tmux-4567")).toBe(4567);
    expect(pidOf("agx-wsize-89.sock")).toBe(89);
    expect(pidOf("agx-pscroll-123-3.sock")).toBe(123);
  });
  test("a random suffix, or somebody else's name, carries none", () => {
    expect(pidOf("agx-sweepfix-Ab3dE9")).toBeNull();
    expect(pidOf("tmux-1000")).toBeNull();
    expect(pidOf("claude-1000")).toBeNull();
  });
});

describe("reapDead", () => {
  test("takes a dead run's directory and leaves a live one's", () => {
    const dead = made(`agx-tmux-tabs-${DEAD}`);
    const live = made(`agx-tmux-tabs-${LIVE}`);
    reapDead(root, { alive });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("spares a young directory even when its pid looks dead", () => {
    // `mkdtemp` can draw six digits, and then the name reads as a pid.
    const young = made(`agx-scratch-${DEAD}`, 60_000);
    reapDead(root, { alive });
    expect(existsSync(young)).toBe(true);
  });

  test("never touches a name that is not ours", () => {
    const other = made(`other-${DEAD}`);
    reapDead(root, { alive });
    expect(existsSync(other)).toBe(true);
  });

  test("a dead run's manifest takes the random-named directories with it", () => {
    const scratch = made("agx-manifest-case-Zk29Qd", 0);
    const outside = mkdtempSync(join(tmpdir(), "agx-reapoutside-"));
    const manifest = join(root, `${MANIFEST_PREFIX}${DEAD}`);
    writeFileSync(manifest, `${scratch}\n${outside}\n`);
    try {
      reapDead(root, { alive });
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(manifest)).toBe(false);
      // A line pointing outside the root is not the manifest's to delete.
      expect(existsSync(outside)).toBe(true);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  test("a live run's manifest is left alone", () => {
    const scratch = made("agx-manifest-live-Qw81Lp", 0);
    const manifest = join(root, `${MANIFEST_PREFIX}${LIVE}`);
    writeFileSync(manifest, scratch + "\n");
    reapDead(root, { alive });
    expect(existsSync(scratch)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
  });

  test.skipIf(!Bun.which("tmux"))("stops the tmux server the dead run left listening", () => {
    const dir = made(`agx-tmux-leak-${DEAD}`);
    const tmpdirEnv = { ...process.env, TMUX_TMPDIR: dir } as Record<string, string>;
    delete tmpdirEnv.TMUX;
    const tmux = (...a: string[]) =>
      Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", "agx-reapcheck", ...a], { env: tmpdirEnv, stdout: "ignore", stderr: "ignore" }).exitCode;
    expect(tmux("new-session", "-d", "-s", "x", "sleep", "300")).toBe(0);
    expect(tmux("list-sessions")).toBe(0);
    // Starting the server touched the directory; age it again.
    const old = new Date(Date.now() - 2 * HOUR);
    utimesSync(dir, old, old);
    reapDead(root, { alive });
    expect(existsSync(dir)).toBe(false);
    // The socket went with the directory, so a fresh query finds no server.
    mkdirSync(dir);
    expect(tmux("list-sessions")).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a run that is SIGKILLed", () => {
  test("leaves its scratch directory, and the next run removes it", async () => {
    const jail = mkdtempSync(join(tmpdir(), "agx-reapjail-"));
    const report = join(jail, "paths.txt");
    try {
      const child = Bun.spawn(
        ["bun", "test", "--preload", "./test/tmpsweep.ts", "./test/fixtures/tmpreap-fixture.ts"],
        { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, TMPDIR: jail, TMPREAP_REPORT: report }, stdout: "ignore", stderr: "ignore" },
      );
      for (let i = 0; i < 200 && !existsSync(report); i++) await Bun.sleep(50);
      expect(existsSync(report)).toBe(true);
      const scratch = readFileSync(report, "utf8");
      child.kill("SIGKILL");
      await child.exited;
      // The measurement the whole change rests on: nothing swept it.
      expect(existsSync(scratch)).toBe(true);

      // The next run: its preload, not this file, has to be what removes it.
      const next = Bun.spawnSync(
        ["bun", "test", "--preload", "./test/tmpsweep.ts", "./test/fixtures/tmpsweep-fixture.ts"],
        { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, TMPDIR: jail, TMPSWEEP_REPORT: join(jail, "next.txt") }, stdout: "ignore", stderr: "ignore" },
      );
      expect(next.exitCode).toBe(0);
      expect(existsSync(scratch)).toBe(false);
    } finally { rmSync(jail, { recursive: true, force: true }); }
  }, 20_000);
});
