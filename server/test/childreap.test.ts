/*
 * The suite stops the servers it started, even the ones a file forgot.
 *
 * A file that fails in `beforeAll`, or never wrote its `afterAll`, left its
 * `server/src/index.ts` running after the run: a port, a database and a few
 * hundred MB each, piling up across runs. The cleanup is a preload
 * (childreap.ts), so it runs after the last test and cannot be checked from
 * inside one. This runs a fixture that boots a server and walks away, in a
 * child `bun test`, and looks at what the child left behind. The child gets
 * its preloads from bunfig.toml, not from flags here, so dropping childreap.ts
 * from bunfig turns this red.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jail = mkdtempSync(join(tmpdir(), "agx-reapcheck-"));
const report = join(jail, "report.txt");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("what a run leaves running", () => {
  test("bunfig.toml preloads childreap.ts, so every run gets the cleanup", () => {
    const bunfig = readFileSync(new URL("../bunfig.toml", import.meta.url), "utf8");
    const preload = bunfig.match(/^preload\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
    expect(preload).toContain('"./test/childreap.ts"');
  });

  test("the server a file never stopped is gone, and so is its scratch directory", () => {
    const child = Bun.spawnSync(
      ["bun", "test", "./test/fixtures/childreap-fixture.ts"],
      { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, CHILDREAP_REPORT: report }, stdout: "ignore", stderr: "ignore" },
    );
    expect(existsSync(report)).toBe(true);
    const [pidText, dir, state] = readFileSync(report, "utf8").trim().split("\n");
    const pid = Number(pidText);
    try {
      // The fixture really had a server up, or the rest proves nothing.
      expect(state).toBe("up");
      expect(child.exitCode).toBe(0);
      expect(pid).toBeGreaterThan(0);
      expect(alive(pid)).toBe(false);
      expect(existsSync(dir!)).toBe(false);
    } finally {
      if (pid > 0 && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      rmSync(jail, { recursive: true, force: true });
    }
  }, 45_000);
});
