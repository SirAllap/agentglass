/*
 * A PROBE THAT WROTE TO THE REAL HISTORY.
 *
 * `AGENTGLASS_STATE_DIR` is how a second server says "my state lives over
 * here" — the tmux socket, the panes and the task file all honour it. The
 * database did not, so a probe with a scratch state directory opened the real
 * one anyway.
 *
 * Measured 2026-08-27: a probe started at 22:19 the previous night was still
 * running eighteen hours later against this machine's database, with that
 * day's code. Its watchdog stopped the deputy's shifts with a reason that no
 * longer exists in the source and closed the rows of runs that were alive,
 * while the app itself was fixed and reinstalled four times. Nobody was
 * looking at that process; the afternoon read as "the deputy does not work".
 *
 * Driven as a child process, because the path is decided once at module load
 * and this suite has already loaded it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASK = `${JSON.stringify(new URL("../src/db.ts", import.meta.url).pathname)}`;
/** Ask a fresh process where its database is. NODE_ENV is cleared: under
 *  `bun test` every path answers "a scratch file", which would pass whatever
 *  this module did. */
async function dbPathWith(env: Record<string, string>, cwd?: string): Promise<string> {
  return (await dbPathAndWarning(env, cwd)).path;
}
async function dbPathAndWarning(env: Record<string, string>, cwd?: string): Promise<{ path: string; err: string }> {
  const p = Bun.spawn(["bun", "-e", `const m = await import(${ASK}); console.log(m.dbPath());`], {
    env: { ...process.env, NODE_ENV: "", ...env },
    cwd,
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { path: out.trim().split("\n").pop() ?? "", err };
}

describe("where a second server puts its database", () => {
  test("a state directory of its own owns the database too", async () => {
    const state = mkdtempSync(join(tmpdir(), "agx-state-"));
    const where = await dbPathWith({ AGENTGLASS_STATE_DIR: state, AGENTGLASS_DB: "" });
    expect(where, "a probe with its own state directory opened the real history").toBe(join(state, "agentglass.db"));
    expect(existsSync(where)).toBe(true);
  });

  test("an explicit AGENTGLASS_DB still wins — naming a file is the stronger statement", async () => {
    const state = mkdtempSync(join(tmpdir(), "agx-state-"));
    const asked = join(mkdtempSync(join(tmpdir(), "agx-asked-")), "mine.db");
    const where = await dbPathWith({ AGENTGLASS_STATE_DIR: state, AGENTGLASS_DB: asked });
    expect(where).toBe(asked);
  });

  /*
   * A database file in the working directory used to win over the data dir.
   * A server started from `server/` in a checkout that once had a local
   * `agentglass.db` then read a months-old history and said nothing: the
   * sessions on screen were real, just not current. The data dir is the one
   * answer now; the stray file is named on stderr so it can be moved or
   * deleted, and it is never opened.
   */
  test("a stray agentglass.db in the working directory does not shadow the data dir", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agx-cwd-"));
    const stray = join(cwd, "agentglass.db");
    writeFileSync(stray, "");
    const data = mkdtempSync(join(tmpdir(), "agx-data-"));
    const { path, err } = await dbPathAndWarning(
      { XDG_DATA_HOME: data, AGENTGLASS_DB: "", AGENTGLASS_STATE_DIR: "" }, cwd,
    );
    expect(path, "the stray file in the cwd shadowed the data dir").toBe(join(data, "agentglass", "agentglass.db"));
    expect(err).toContain(stray);
    expect(err).toContain(join(data, "agentglass", "agentglass.db"));
    expect(err.split(stray).length - 1, "the warning is said once, not per open").toBe(1);
  });

  test("no stray file, no warning", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agx-cwd-"));
    const data = mkdtempSync(join(tmpdir(), "agx-data-"));
    const { path, err } = await dbPathAndWarning(
      { XDG_DATA_HOME: data, AGENTGLASS_DB: "", AGENTGLASS_STATE_DIR: "" }, cwd,
    );
    expect(path).toBe(join(data, "agentglass", "agentglass.db"));
    expect(err).not.toContain("agentglass.db");
  });
});
