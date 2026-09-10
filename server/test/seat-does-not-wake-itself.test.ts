/*
 * THE CHAIR IS NOT SOMEBODY WAITING ON YOU.
 *
 * Measured from the seat's side, with the line it was woken by: "The field
 * changed: orchestrator is waiting for your next prompt — 1h: Claude is
 * waiting for your input." The agent stopped on a person WAS the seat, and the
 * person was the one who had not written yet. That is not a change in the
 * field, it is the chair sitting in the chair — and it was going to cost a turn
 * of the most expensive context on the machine every hour that nobody typed.
 *
 * It happened because the chair was known by SESSION id, and a session id is
 * not stable: an orchestrator that is resumed, restarted or re-adopted carries
 * a new one, and the board carries hook rows for the same pane under whatever
 * the tmux window is called. A pane is the fact this app already rests
 * liveness on, and it is the same pane whatever the session inside it is
 * called.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTGLASS_DOCTRINE = join(mkdtempSync(join(tmpdir(), "agx-self-")), "data");
const { seatPanes } = await import("../src/seatpanes.ts");
const { db } = await import("../src/db.ts");

beforeEach(() => {
  db.query("DELETE FROM seat").run();
  db.query("DELETE FROM named_agent").run();
});

describe("which panes are a chair", () => {
  test("a seat that ADOPTED a session is known by the pane it adopted", () => {
    db.query(`INSERT INTO seat (root, name, model, powers, started_at, ended_at, last_line, last_turn_at, adopted_session, adopted_pane)
              VALUES ('/r', 'orchestrator-r', '', 'speak', 1, NULL, '', 0, 'sess-1', '%11')`).run();
    expect([...seatPanes()]).toEqual(["%11"]);
  });

  test("and one this app OPENED is known by its named agent's pane", () => {
    db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at)
              VALUES ('orchestrator-abc', 'claude', '/r', '%42', '@4', 1, NULL)`).run();
    expect([...seatPanes()]).toEqual(["%42"]);
  });

  test("a chair nobody is in any more is not a chair", () => {
    db.query(`INSERT INTO seat (root, name, model, powers, started_at, ended_at, last_line, last_turn_at, adopted_session, adopted_pane)
              VALUES ('/r', 'orchestrator-r', '', 'speak', 1, 99, '', 0, 'sess-1', '%11')`).run();
    db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at)
              VALUES ('orchestrator-abc', 'claude', '/r', '%42', '@4', 1, 99)`).run();
    expect([...seatPanes()]).toEqual([]);
  });

  test("an ordinary agent's pane is nobody's chair", () => {
    db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at)
              VALUES ('review-1042', 'claude', '/r', '%7', '@1', 1, NULL)`).run();
    expect([...seatPanes()]).toEqual([]);
  });
});
