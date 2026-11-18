/*
 * A LIVENESS READ THAT FAILED IS NOT "EVERY WINDOW IS GONE".
 *
 * Both reads the reaper leans on used to answer the same thing whether they
 * worked or not: a failed `list-panes` read as "no pane is alive", so
 * `reconcile` closed every open row and sent each one's owner to `reapOwner`;
 * a failed `list-windows` read as "only the registry names are live", so a chat
 * window's `nohup`'d dev server looked like an owner whose window was gone. The
 * kill was the only evidence the read had failed.
 *
 * Two failures, and they are not the same fact. A read that could not be made
 * says nothing about any window and closes nothing. An engine that is not there
 * at all (`no server running on <socket>`) proves every window of it is gone:
 * the rows go, since a dead worker must not stay listed as alive and hold its
 * name — but still nothing is killed, because the upgrade that killed the
 * engine restores those windows a moment later.
 *
 * The first is a tmux that answers with something else entirely; the second is
 * a real socket with no server on it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const NAME = `agx-reaperclosed-${process.pid}`;
const SOCKET = `agx-reaperclosed-${process.pid}-sock`;
const STATE = mkdtempSync(join(tmpdir(), `${NAME}-state-`));
const REAL = {
  sock: process.env.AGENTGLASS_TMUX_SOCKET,
  tmpdir: process.env.TMUX_TMPDIR,
  state: process.env.AGENTGLASS_STATE_DIR,
  tmuxPath: process.env.AGENTGLASS_TMUX_PATH,
};
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
process.env.AGENTGLASS_STATE_DIR = STATE;

const { db } = await import("../src/db.ts");
const ops = await import("../src/agentops.ts");
const { reapOwned } = await import("../src/reaper.ts");

const ROW = "probe-kept-open";

/** A tmux that cannot answer: what a client the server will not speak to says. */
const BROKEN = join(STATE, "broken-tmux");
writeFileSync(BROKEN, "#!/bin/sh\necho 'server exited unexpectedly' >&2\nexit 1\n");
chmodSync(BROKEN, 0o755);

/** A tmux that answers: an engine with nothing in it. */
const EMPTY = join(STATE, "empty-tmux");
writeFileSync(EMPTY, "#!/bin/sh\nexit 0\n");
chmodSync(EMPTY, 0o755);

function openRow(): void {
  db.query(`INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at)
    VALUES (?, 'claude', ?, '%1', '@1', ?, NULL)`).run(ROW, STATE, Date.now());
}

afterAll(() => {
  try { db.query("DELETE FROM named_agent WHERE name = ?").run(ROW); } catch { /* never written */ }
  rmSync(STATE, { recursive: true, force: true });
  for (const [k, v] of [
    ["AGENTGLASS_TMUX_SOCKET", REAL.sock],
    ["TMUX_TMPDIR", REAL.tmpdir],
    ["AGENTGLASS_STATE_DIR", REAL.state],
    ["AGENTGLASS_TMUX_PATH", REAL.tmuxPath],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** `console.error` lines, for the one thing a failure says. */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const said = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.error = said; } };
}

describe("an engine that cannot be read", () => {
  test("every liveness question answers 'still open', and says so once", async () => {
    /* The one line per outage is per PROCESS, so a test that asked first has
       already spent it. An engine that answers clears it again. */
    process.env.AGENTGLASS_TMUX_PATH = EMPTY;
    expect(await ops.liveOwnerNames()).not.toBeNull();
    process.env.AGENTGLASS_TMUX_PATH = BROKEN;
    const said = capture();
    try {
      expect(await ops.liveOwnerNames()).toBeNull();
      expect(await ops.paneAlive("%1")).toBe(true);
      await ops.paneAlive("%2");
      expect(said.lines.length, "one outage, one line").toBe(1);
    } finally { said.restore(); }
  });

  test("an open registry row is not closed, and no sweep is asked for on its behalf", async () => {
    process.env.AGENTGLASS_TMUX_PATH = BROKEN;
    openRow();
    const said = capture();
    try {
      expect((await ops.reconcile()).map((a) => a.name)).toContain(ROW);
      expect(ops.openNamed().map((a) => a.name)).toContain(ROW);
    } finally { said.restore(); }
  });

  test("the net stops nothing, because the owners it would check cannot be listed", async () => {
    process.env.AGENTGLASS_TMUX_PATH = BROKEN;
    const sent: string[] = [];
    const said = capture();
    try {
      const result = await reapOwned({
        live: () => ops.liveOwnerNames(),
        scan: () => [{ pid: 10, ppid: 1487, start: "1000", ageMs: 2 * 60 * 60_000, owner: "pr-12", tmp: "", mine: false }],
        nobody: () => new Set([1487]),
        signal: (p, sig) => { if (sig === "SIGTERM") sent.push(String(p)); },
        startOf: () => "1000",
        removeDir: () => { /* not what this test is about */ },
      });
      expect(result.stopped).toBe(0);
    } finally { said.restore(); }
    expect(sent).toEqual([]);
  });
});

describe("an engine that is not running at all", () => {
  test("proves no pane is there, so a row is closed — and still nothing is killed", async () => {
    delete process.env.AGENTGLASS_TMUX_PATH;
    openRow();
    const said = capture();
    try {
      expect(await ops.paneAlive("%1"), "there is no engine, so there is no pane").toBe(false);
      expect(await ops.reconcile()).toEqual([]);
      expect(ops.openNamed().map((a) => a.name), "a dead worker must not hold its name").not.toContain(ROW);
    } finally { said.restore(); }

    const sent: string[] = [];
    const quiet = capture();
    try {
      const result = await reapOwned({
        live: () => ops.liveOwnerNames(),
        scan: () => [{ pid: 10, ppid: 1487, start: "1000", ageMs: 2 * 60 * 60_000, owner: "pr-12", tmp: "", mine: false }],
        nobody: () => new Set([1487]),
        signal: (p, sig) => { if (sig === "SIGTERM") sent.push(String(p)); },
        startOf: () => "1000",
        removeDir: () => { /* not what this test is about */ },
      });
      expect(result.stopped).toBe(0);
    } finally { quiet.restore(); }
    expect(sent).toEqual([]);
  });
});
