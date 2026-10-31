/*
 * WHAT THE AGENTS SCREEN FOLDS, AND THE LAST HOUR ON EACH ROW.
 *
 * Two answers the screen reads and draws as numbers: how many rounds of a
 * coordinator only said "looked, nothing changed" (it folds them into one
 * line), and the last hour of tool calls on every board row (the pulse beside
 * each working agent). Both are counts, so both are tested against a real
 * table shape and not against their own arithmetic.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-screen-counts-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const { db } = await import("../src/db.ts");
const { quietCounts } = await import("../src/seat.ts");
const { withPulse, BUCKETS, BUCKET_MS } = await import("../src/seatpulse.ts");

const ROOT = "/home/a/code/orbit";
const NOW = 1_800_000_000_000;

describe("the routine rounds a coordinator keeps", () => {
  test("only the 'looked, nothing changed' lines are routine, and only this project's", () => {
    const put = (root: string, line: string, at: number) => db.query("INSERT INTO seat_line (root, line, at) VALUES (?, ?, ?)").run(root, line, at);
    // bun test shares one database across files; another file's rounds for this root counted 4, not 2.
    db.query("DELETE FROM seat_line WHERE root IN (?, ?)").run(ROOT, "/home/a/code/ledger");
    put(ROOT, "(looked at 09:49 — nothing had changed, so nobody was woken)", NOW - 4 * 3_600_000);
    put(ROOT, "(looked at 13:49 — the field cleared, so nobody was woken)", NOW - 3_600_000);
    put(ROOT, "orbit-lead: two upload branches overlap, asked the person", NOW - 1_800_000);
    put("/home/a/code/ledger", "(looked at 13:49 — nothing had changed, so nobody was woken)", NOW);
    expect(quietCounts(ROOT, NOW).routine).toBe(2);
  });
});

describe("the last hour on a board row", () => {
  test("a row with a session gets twelve zero-filled buckets, and one without keeps none", () => {
    db.query(`INSERT INTO events (source_app, session_id, hook_event_type, timestamp) VALUES ('orbit', 's-1', 'PreToolUse', ?)`).run(NOW - 2 * 60_000);
    const [a, b] = withPulse([{ name: "scout-2", session: "s-1" }, { name: "pane-only" }], NOW) as { name: string; pulse?: number[] }[];
    expect(a!.pulse).toHaveLength(BUCKETS);
    expect(a!.pulse!.reduce((x, y) => x + y, 0)).toBe(1);
    expect(a!.pulse![BUCKETS - 1]).toBe(1);
    expect(b!.pulse).toBeUndefined();
    expect(BUCKET_MS).toBe(300_000);
  });
});
