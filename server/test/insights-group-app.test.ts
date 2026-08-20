// A session id is only unique inside the app that issued it (#248). Two apps
// working the same project can hold the same session id, and the insight
// queries grouped by session id alone — so two fleets running `pytest test_a.py`
// seven times each collapsed into one card, `Possible loop · 14× identical
// command`, attributed to whichever source_app SQLite happened to return.
//
// The fix is the pair, and it has to hold in two places. `GROUP BY` splits the
// rows; the `id` each row is keyed by has to split with them, or the cards are
// separated in the server and merged again by `key={i.id}` in Alerts.tsx.
//
// The collision is what the fixture is for: one session id, one command, two
// apps. Both halves are asserted, because each fails alone — dropping the
// source_app from GROUP BY loses the second card, and dropping it from the id
// makes two cards that React cannot tell apart.
//
// A third pair guards the id itself. `agentglass:web` in session `s1` and
// `agentglass` in session `web:s1` are two rows that a plain join writes as one
// string, so the id has to encode the pair rather than concatenate it.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-insights-group-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "insights-grp.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let insights: typeof import("../src/insights.ts");

const now = Date.now();
const SESSION = "s-shared"; // the same id in both apps — the whole point
const CMD = "pytest test_a.py";
const COLLIDING = ["app-alpha", "app-beta"];
const AMBIGUOUS: [string, string][] = [["agentglass:web", "s1"], ["agentglass", "web:s1"]];

const event = (app: string, session: string, over: Record<string, unknown>, i: number) => ({
  source_app: app,
  session_id: session,
  hook_event_type: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: `${app}-${session}-${i}`,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "",
  timestamp: now - i * 1000,
  payload: { project_path: ROOT, tool_input: { command: CMD } },
  chat: null,
  ...over,
});

beforeAll(async () => {
  const db = await import("../src/db.ts");
  insights = await import("../src/insights.ts");
  // Every session-scoped insight, for both apps, on the one shared session id.
  for (const app of COLLIDING) {
    let i = 0;
    // Loop: >= 6 identical Bash commands in 30m.
    for (let n = 0; n < 7; n++) db.insertEvent(event(app, SESSION, {}, i++) as any);
    // Fast burn: >= $15 in 15m. Opus input is $5/M, so 2M tokens is $10 an event.
    for (let n = 0; n < 2; n++) db.insertEvent(event(app, SESSION, {
      hook_event_type: "PostToolUse",
      usage: { input_tokens: 2_000_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
    }, i++) as any);
    // High failure rate: 3 of 5 tool calls fail in an hour, which is over 30%.
    for (let n = 0; n < 3; n++) db.insertEvent(event(app, SESSION, {
      hook_event_type: "PostToolUseFailure", is_error: 1, error_text: "boom",
    }, i++) as any);
  }
  for (const [app, session] of AMBIGUOUS) {
    for (let n = 0; n < 7; n++) db.insertEvent(event(app, session, {}, n) as any);
  }
});

const loopsFor = (prefix: string) =>
  insights.getInsights().filter((i) => i.kind === "loop" && (i.session ?? "").startsWith(prefix));

describe("two apps sharing one session id are two fleets, not one", () => {
  test("each app gets its own card, counting only its own commands", () => {
    const loops = loopsFor("app-");
    const sessions = loops.map((l) => l.session);
    expect(sessions).toContain(`app-alpha:${SESSION}`);
    expect(sessions).toContain(`app-beta:${SESSION}`);
    // 7 each. One merged card would say 14, and name only one of the two.
    expect(loops.map((l) => l.title)).toEqual([
      "Possible loop · 7× identical command",
      "Possible loop · 7× identical command",
    ]);
    expect(loops.every((l) => l.detail === CMD)).toBe(true);
  });

  test("their cards are addressable apart, for every insight the pair keys", () => {
    // `key={i.id}` in Alerts.tsx: an id shared by two cards renders one of them.
    const ids = insights.getInsights().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const kind of ["loop", "spend", "errors"]) {
      expect(ids.filter((id) => id.startsWith(`${kind}:app-`))).toHaveLength(2);
    }
  });

  test("a colon in an app name does not fold two rows into one id", () => {
    const rows = loopsFor("agentglass");
    expect(rows).toHaveLength(2);
    // The label is allowed to collide — it is a label, and it truncates the
    // session id anyway. The React key is not.
    expect(new Set(rows.map((r) => r.session)).size).toBe(1);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});
