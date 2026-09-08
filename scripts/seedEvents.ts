#!/usr/bin/env bun
/**
 * Fill a scratch database with a plausible day of events.
 *
 * `perfbudget.ts` was careful about one half of its fixture and blind to the
 * other: `buildRepo` makes eight worktrees because "a single-checkout fixture
 * would pass this check with the bugs still in", while the database it measured
 * against was empty every run. Half the routes the panels poll read `events`,
 * so their cost — the part that scales with what a real desk accumulates — was
 * never on the clock. A query that walks the table per candidate row measured
 * 11ms against that empty database and 46 seconds against a day of turns.
 *
 * So: rows, before anything is measured. Written as its own process rather than
 * an import, because the harness then holds no database handle of its own — the
 * child closes everything by exiting, and the server it spawns next opens the
 * file cleanly.
 *
 *   bun scripts/seedEvents.ts <db path> <project path> [count]
 *
 * The shape matters as much as the count. Several apps, several models, several
 * sessions per app, main and subagent lineages side by side, a minority of
 * events in another project so a scope filter has something to exclude, and
 * tool calls paired with their results the way the ingest path writes them. One
 * session with one model would leave a per-lineage query looking linear.
 */
import { insertEvent, db } from "../server/src/db.ts";

const [dbPath, projectPath, countArg] = process.argv.slice(2);
if (!dbPath || !projectPath) {
  console.error("usage: bun scripts/seedEvents.ts <db path> <project path> [count]");
  process.exit(2);
}
if (process.env.AGENTGLASS_DB !== dbPath) {
  console.error(`[seed] AGENTGLASS_DB must be ${dbPath} in this process's environment`);
  process.exit(2);
}

const COUNT = Math.max(0, Number(countArg ?? 20_000) || 0);
const APPS = ["orbit", "atlas", "relay"];
const MODELS = ["claude-opus-4-8", "claude-sonnet-4-5", "gpt-5.1-codex"];
const TOOLS = ["Bash", "Read", "Edit", "Grep", "Write", "WebFetch"];
/** A minority elsewhere, so `scopeClause` has rows to leave out rather than a
 *  table that happens to be entirely in scope. */
const OTHER_PROJECT = "/tmp/agx-perf-other";
const SESSIONS_PER_APP = 8;
const DAY = 24 * 60 * 60_000;

const now = Date.now();
let written = 0;

const seed = db.transaction(() => {
  for (let i = 0; i < COUNT; i++) {
    const app = APPS[i % APPS.length]!;
    const session = `${app}-session-${Math.floor(i / APPS.length) % SESSIONS_PER_APP}`;
    const model = MODELS[Math.floor(i / 7) % MODELS.length]!;
    // Every fifth event belongs to a subagent, and there are two of them: the
    // lineage split is what a per-agent query has to walk past.
    const sub = i % 5 === 0 ? `agent-${i % 2}` : null;
    const tool = i % 3 === 0 ? TOOLS[i % TOOLS.length]! : null;
    // Most of the history inside the last day — that is the window the insight
    // and stats queries scan — with a tail behind it, because retention is 8
    // days and a real table is not all "today".
    const age = i % 9 === 0 ? DAY + (i % 7) * DAY : Math.floor((i / COUNT) * DAY);
    insertEvent({
      source_app: app,
      session_id: session,
      hook_event_type: tool ? (i % 6 === 0 ? "PreToolUse" : "PostToolUse") : "Stop",
      tool_name: tool,
      tool_use_id: tool ? `tu-${i}` : null,
      agent_id: sub,
      agent_type: sub ? "subagent" : null,
      model_name: model,
      is_error: i % 47 === 0 ? 1 : 0,
      error_text: i % 47 === 0 ? "command failed with exit code 1" : null,
      usage: {
        input_tokens: 400 + (i % 900),
        output_tokens: 120 + (i % 400),
        // Cache-bearing on most turns, which is what a warm agent actually does
        // — and what makes a cache-lineage query expensive.
        cache_creation_tokens: i % 4 === 0 ? 12_000 + (i % 9_000) : 0,
        cache_read_tokens: i % 4 === 0 ? 0 : 40_000 + (i % 20_000),
      },
      usage_is_cumulative: false,
      summary: tool ? `${tool} on src/module-${i % 120}.ts` : "turn complete",
      timestamp: now - age,
      payload: { project_path: i % 11 === 0 ? OTHER_PROJECT : projectPath },
      chat: null,
    } as Parameters<typeof insertEvent>[0]);
    written++;
  }
});

seed();
db.close();
console.log(`[seed] ${written} events across ${APPS.length} apps × ${SESSIONS_PER_APP} sessions, ${MODELS.length} models`);
