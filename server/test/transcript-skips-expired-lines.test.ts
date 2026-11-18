/*
 * A transcript line older than the retention window is not stored.
 *
 * A rewritten transcript (shorter than before) is re-read from line 0 and its old lines used to go
 * back in, after the prune had folded them: 47,082 such events from one session on a live DB.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-expired-"));
const PROJECTS = join(dir, "projects", "-tmp-orbit");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
const SCOPE = join(dir, "workspace");
mkdirSync(SCOPE, { recursive: true });
process.env.AGENTGLASS_ROOT = SCOPE;
process.env.AGENTGLASS_DB ||= join(dir, "expired.db");
process.env.AGENTGLASS_RETENTION_DAYS = "8";

test("lines past the window are skipped, recent ones kept", async () => {
  const { db } = await import("../src/db.ts");
  const scan = await import("../src/transcripts.ts");
  const D = 86_400_000, now = Date.now();
  const line = (t: number, text: string) => JSON.stringify({
    type: "user", sessionId: "s-exp", cwd: SCOPE, timestamp: new Date(t).toISOString(), message: { role: "user", content: text },
  });
  writeFileSync(join(PROJECTS, "s-exp.jsonl"), [line(now - 12 * D, "old one"), line(now - 10 * D, "old two"), line(now - 1000, "fresh")].join("\n") + "\n");
  await scan.scanOnce(null);
  const rows = db.query("SELECT payload FROM events WHERE session_id = 's-exp'").all() as { payload: string }[];
  expect(rows.map((r) => JSON.parse(r.payload).prompt)).toEqual(["fresh"]);
});
