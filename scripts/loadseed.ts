/**
 * Seed a database for the load test: `bun scripts/loadseed.ts <out.db> <MB>`.
 *
 * The server's own schema is created by importing db.ts (so the tables, indexes
 * and FTS table are exactly the product's), then `events`, `sessions` and
 * `events_fts` are filled with invented hook events of realistic size (a prompt,
 * a Bash call and its 1-12 KB result, a file edit with content, a Stop with
 * usage) until the file is MB big. Run with AGENTGLASS_DB and the XDG variables
 * pointing at a scratch place; loadagents.ts does that.
 */
import { Database } from "bun:sqlite";
import "../server/src/db.ts";

const out = process.argv[2]!;
const mb = Number(process.argv[3] || 0);
if (!out || out !== process.env.AGENTGLASS_DB || !(mb > 0)) { console.error("usage: AGENTGLASS_DB=<out.db> bun scripts/loadseed.ts <out.db> <MB>"); process.exit(2); }

const db = new Database(out);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;");
const ev = db.prepare(`INSERT INTO events (source_app, session_id, hook_event_type, tool_name, tool_use_id, model_name, is_error, duration_ms, input_tokens, output_tokens, cost_usd, summary, payload, timestamp)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const fts = db.prepare("INSERT INTO events_fts (rowid, text) VALUES (?, ?)");
const ses = db.prepare(`INSERT OR REPLACE INTO sessions (session_id, source_app, model_name, started_at, last_seen, event_count, tool_count, input_tokens, output_tokens, cost_usd, pricing_baseline_usd)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

const words = "build test deploy review orbit acme widget migrate refactor config route cache queue index parse render token session worker".split(" ");
const text = (kb: number) => { let s = ""; while (s.length < kb * 1024) s += words[Math.floor(Math.random() * words.length)] + " " + Math.floor(Math.random() * 1e6).toString(36) + " "; return s; };
const sizeMb = () => (db.query<{ p: number; s: number }, []>("SELECT (SELECT page_count FROM pragma_page_count) p, (SELECT page_size FROM pragma_page_size) s").get()!.p * 4096) / 1_048_576;
const pageMb = () => { const r = db.query<{ p: number; s: number }, []>("SELECT (SELECT page_count FROM pragma_page_count) p, (SELECT page_size FROM pragma_page_size) s").get()!; return (r.p * r.s) / 1_048_576; };
void sizeMb;

const T0 = Date.now() - 90 * 86_400_000;
const sessions = Math.max(50, Math.round(mb / 4));
let n = 0;
let evCount = 0;
while (pageMb() < mb) {
  db.transaction(() => {
    for (let b = 0; b < 500; b++) {
      const si = n % sessions;
      const sid = `seed-sess-${si}`;
      const cwd = `/work/orbit/proj-${si % 12}`;
      const ts = T0 + Math.floor((n / 1000) * 60_000) + b;
      const tid = `seed-tu-${n}`;
      const kind = n % 4;
      let type = "PreToolUse", tool: string | null = "Bash", payload: object, summary: string, body: string;
      if (kind === 0) { type = "UserPromptSubmit"; tool = null; body = text(1); payload = { cwd, project_path: cwd, prompt: body }; summary = body.slice(0, 80); }
      else if (kind === 1) { body = "make test"; payload = { cwd, project_path: cwd, tool_name: tool, tool_use_id: tid, tool_input: { command: body } }; summary = body; }
      else if (kind === 2) { type = "PostToolUse"; body = text(1 + (n % 12)); payload = { cwd, project_path: cwd, tool_name: tool, tool_use_id: tid, tool_response: { stdout: body } }; summary = body.slice(0, 80); }
      else { type = "Stop"; tool = null; body = text(2); payload = { cwd, project_path: cwd, last_assistant_message: body }; summary = body.slice(0, 80); }
      const r = ev.run("claude-code", sid, type, tool, tid, "claude-sonnet-4-5", 0, 200 + (n % 3000), 900, 120, 0.01, summary, JSON.stringify(payload), ts);
      fts.run(Number(r.lastInsertRowid), `${tool ?? ""} ${body}`);
      n++; evCount++;
    }
  })();
}
db.transaction(() => {
  for (let i = 0; i < sessions; i++) ses.run(`seed-sess-${i}`, "claude-code", "claude-sonnet-4-5", T0 + i * 60_000, Date.now() - i * 3_600_000, Math.round(evCount / sessions), Math.round(evCount / sessions / 2), 900 * 100, 120 * 100, 1.5, 1.5);
})();
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
console.log(`seeded ${evCount} events, ${sessions} sessions, ${pageMb().toFixed(0)} MB`);
db.close();
