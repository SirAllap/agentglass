// insertEvent claimed a PreToolUse row (marking it `paired = 1`) in its own,
// separate implicit transaction, ahead of the `db.transaction(write)` that
// inserts the matching Post. Two consequences of that split:
//
//   * two lock acquisitions instead of one, so a writer elsewhere (the
//     transcript scanner's sweep, the retention prune) that takes the write
//     lock twice in that window stacks two busy_timeout waits onto a single
//     /ingest — measured on a real cockpit as an 11.3s loop stall from one
//     call;
//   * the claim could commit even when the insert that follows it then
//     failed, leaving a Pre marked "answered" by an event that was never
//     written — exactly the bug the comment on the transaction call already
//     warned against, just not what the code did.
//
// The claim now runs inside `write`, so it commits or rolls back with the
// insert it is measuring. This proves the second part directly: force the
// insert to throw after the claim has run, and check the Pre it claimed is
// still unclaimed afterwards.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-single-lock-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "lock.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
const T0 = Date.now() - 10 * 60_000;

const ev = (over: Record<string, unknown>) => ({
  source_app: "proj",
  session_id: "s1",
  hook_event_type: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: T0,
  payload: { project_path: ROOT },
  chat: null,
  ...over,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
});

describe("the Pre claim commits or rolls back with the insert that follows it", () => {
  test("a Post whose insert throws leaves its claimed Pre still unclaimed", () => {
    const tool = "RollsBack";
    db.insertEvent(ev({ tool_name: tool, tool_use_id: "tu-rollback", timestamp: T0 }) as any);

    // A circular payload makes `JSON.stringify($payload)` throw while
    // building the insert's bound parameters — inside `write`, after the
    // claim has already run, before the row is actually written. Exactly
    // the "claim ran, insert failed" case the atomicity is for.
    const circular: Record<string, unknown> = { project_path: ROOT };
    circular.self = circular;

    expect(() =>
      db.insertEvent(
        ev({ tool_name: tool, tool_use_id: "tu-rollback", hook_event_type: "PostToolUse", timestamp: T0 + 1000, payload: circular }) as any
      )
    ).toThrow();

    const row = db.db
      .query<{ paired: number }, [string]>(`SELECT paired FROM events WHERE tool_use_id = ? AND hook_event_type = 'PreToolUse'`)
      .get("tu-rollback");
    expect(row?.paired, "the Pre was marked claimed even though its Post was never written").toBe(0);

    // The Pre is still there to be claimed properly by a retry.
    const retried = db.insertEvent(
      ev({ tool_name: tool, tool_use_id: "tu-rollback", hook_event_type: "PostToolUse", timestamp: T0 + 1000 }) as any
    );
    expect((retried as any).event.duration_ms).toBe(1000);
  });
});
