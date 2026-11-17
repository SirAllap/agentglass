/*
 * The Lantern's and the seat's chats from before roles existed used to be found
 * by a LIKE over every prompt payload, run inside the first POST /ingest after a
 * start (2.4 s of a 3.1 s first ingest on a cold 1.6 GB file). Now a background
 * walk, once per database, one session's first prompt at a time.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
process.env.AGENTGLASS_DB = join(mkdtempSync(join(tmpdir(), "legacy-scan-")), "t.db");
const { db, insertEvent, legacyScanTest, legacyScanStats, scheduleLegacyPromptScan } = await import("../src/db.ts");
const { isLanternSession, LANTERN_PROMPT_MARK } = await import("../src/lantern.ts");

const prompt = (sid: string, text: string, ts: number) => insertEvent({
  source_app: "claude", session_id: sid, event_id: null, hook_event_type: "UserPromptSubmit", tool_name: null, tool_use_id: null,
  agent_id: null, agent_type: null, model_name: null, is_error: 0, error_text: null, summary: "p", timestamp: ts,
  usage: {}, payload: { prompt: text },
} as never);

test("a first read of the answer does not scan prompts; the walk finds old chats once", async () => {
  prompt("old-chat", `${LANTERN_PROMPT_MARK}: you read the field`, 1);
  prompt("plain", "fix the export", 2);
  prompt("late-mention", `fix it. ${LANTERN_PROMPT_MARK} appears later`, 3);
  // The request path: answers from the role table only, no payload read.
  const seen: string[] = [];
  const orig = db.query.bind(db);
  (db as { query: unknown }).query = (sql: string) => { if (/LIKE/.test(sql)) seen.push(sql); return orig(sql); };
  expect(isLanternSession("old-chat")).toBe(false); // not found yet: the walk has not run
  (db as { query: unknown }).query = orig;
  expect(seen).toEqual([]);

  const found: string[] = [];
  legacyScanTest.delayMs = 0;
  scheduleLegacyPromptScan("t-legacy", LANTERN_PROMPT_MARK, (id) => found.push(id));
  for (let i = 0; i < 50 && !db.query("SELECT 1 FROM boot_once WHERE name = 't-legacy'").get(); i++) await Bun.sleep(20);
  expect(found).toEqual(["old-chat"]);
  expect(legacyScanStats.sessions).toBeGreaterThanOrEqual(3);

  // Done is remembered: a second start does not walk again.
  const before = legacyScanStats.sessions;
  scheduleLegacyPromptScan("t-legacy", LANTERN_PROMPT_MARK, (id) => found.push(id));
  await Bun.sleep(60);
  expect(legacyScanStats.sessions).toBe(before);
});

test("the budget is checked after each session: a zero budget yields after every one", async () => {
  for (let i = 0; i < 4; i++) prompt(`slow-${i}`, `${"x".repeat(200_000)}`, 10 + i);
  const s0 = legacyScanStats.slices, n0 = legacyScanStats.sessions;
  legacyScanTest.delayMs = 0; legacyScanTest.budgetMs = 0;
  scheduleLegacyPromptScan("t-budget", LANTERN_PROMPT_MARK, () => {});
  // The walk is awaited, not timed: it ends when the scan writes its row, however long a loaded runner takes to get there.
  for (let i = 0; i < 750 && !db.query("SELECT 1 FROM boot_once WHERE name = 't-budget'").get(); i++) await Bun.sleep(20);
  legacyScanTest.budgetMs = 25;
  expect(db.query("SELECT 1 FROM boot_once WHERE name = 't-budget'").get()).not.toBeNull();
  expect(legacyScanStats.slices - s0).toBeGreaterThanOrEqual(legacyScanStats.sessions - n0 - 1);
});

test("a throw is retried from the same session, then the walk finishes and is remembered", async () => {
  let threw = false;
  const found: string[] = [];
  legacyScanTest.delayMs = 0; legacyScanTest.retryMs = 5;
  const warn = console.warn; const warned: string[] = []; console.warn = (m: string) => { warned.push(String(m)); };
  scheduleLegacyPromptScan("t-retry", LANTERN_PROMPT_MARK, (id) => { if (!threw) { threw = true; throw new Error("SQLITE_BUSY"); } found.push(id); });
  for (let i = 0; i < 100 && !db.query("SELECT 1 FROM boot_once WHERE name = 't-retry'").get(); i++) await Bun.sleep(20);
  console.warn = warn;
  expect(threw).toBe(true);
  expect(found).toEqual(["old-chat"]);
  expect(warned.length).toBe(1);
  expect(db.query("SELECT 1 FROM boot_once WHERE name = 't-retry'").get()).not.toBeNull();
});
