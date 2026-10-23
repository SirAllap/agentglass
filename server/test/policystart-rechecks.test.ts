/*
 * Two guards inside the name's turn that the route cannot reach, so only a
 * direct call to the turn can pin them.
 *
 *   A seat that lost a race for a new name: the route looked, saw the name
 *   free, and by the time the turn ran another seat's finished worker was
 *   sitting on it. The turn asks again; without that, the second start empties
 *   the first seat's run folder before the spawn answers "exists".
 *
 *   A prompt whose worker stopped being one: the route saw a stamped row, an
 *   enlist replaced it with a hand-started one before the prompt's turn. The
 *   turn reads the row again; without a stamp there is no envelope to resume
 *   under, and reading `role` off nothing is a 500.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/db.ts";
import * as P from "../src/agents/policystart.ts";
import { runFiles } from "../src/agents/headless.ts";
import { agentNamed } from "../src/agentops.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-recheck-")));
const mine = join(dir, "orbit-mine");
const theirs = join(dir, "orbit-theirs");
beforeAll(() => { mkdirSync(mine); mkdirSync(theirs); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const readiness = async () => [{ id: "claude", path: "/bin/true", roles: { worker: { ok: true }, orchestrator: { ok: true } } } as never];
const seed = (name: string, seatRoot: string | null, startedBy: unknown = null) =>
  db.run(
    "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by) VALUES (?, 'claude', ?, '%9999', '@9999', ?, ?, ?, ?)",
    [name, theirs, Date.now(), Date.now(), seatRoot, startedBy ? JSON.stringify(startedBy) : null],
  );

describe("the name's turn asks again", () => {
  test("a name another seat's finished worker holds is refused, and its run folder is left alone", async () => {
    seed("w-race", theirs);
    const f = runFiles("w-race");
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(f.out, "their result");
    const r = await P.startThroughPolicy({
      root: mine, policyRoot: mine, name: "w-race", cwd: mine, prompt: "go", body: { role: "builder", engine: "claude" },
      seatRoot: mine, probe: readiness,
    });
    expect(r.body.error).toContain("belongs to the seat of orbit-theirs");
    expect(r.status).toBe(403);
    expect(existsSync(f.out)).toBe(true);
  });

  test("a prompt whose worker lost its stamp in between is refused, not a crash", async () => {
    seed("w-hand", mine);
    const stale = { ...agentNamed("w-hand")!, startedBy: { headless: true, role: "builder", engine: "claude", model: "sonnet", turn: 1 } } as never;
    const r = await P.promptHeadless(stale, "and then?");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("no longer a worker this app started");
  });
});
