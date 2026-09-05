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
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASK = `${JSON.stringify(new URL("../src/db.ts", import.meta.url).pathname)}`;
/** Ask a fresh process where its database is. NODE_ENV is cleared: under
 *  `bun test` every path answers "a scratch file", which would pass whatever
 *  this module did. */
async function dbPathWith(env: Record<string, string>): Promise<string> {
  const p = Bun.spawn(["bun", "-e", `const m = await import(${ASK}); console.log(m.dbPath());`], {
    env: { ...process.env, NODE_ENV: "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return out.trim().split("\n").pop() ?? "";
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
});
