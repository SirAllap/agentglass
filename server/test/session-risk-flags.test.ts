/*
 * The flags reach the two places that read them: each change in a session's
 * diff, and the session's own row, which is what its card on the fleet board
 * is drawn from.
 *
 * The row is the one with a cost. The list is polled every few seconds, and
 * parsing every edit of forty sessions on each poll would be the dashboard's
 * most expensive query for a fact that only changes when an edit lands. So the
 * rollup remembers how far into the events table it has read per session and
 * only parses what arrived after — and "after" is by row id, not timestamp,
 * because a backfill inserts old edits late.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-risk-"));
const ROOT = join(dir, "orbit");
mkdirSync(ROOT, { recursive: true });
const saved = { db: process.env.AGENTGLASS_DB, cfg: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT };
process.env.AGENTGLASS_DB = join(dir, "risk.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_ROOT = ROOT;

let db: typeof import("../src/db.ts");
const T0 = Date.now() - 3_600_000;
const AWS = "AKIA" + "Q3EXAMPLEKEY7ZZX";

const event = (over: Record<string, unknown> = {}) => ({
  source_app: "orbit",
  session_id: "risk-s1",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-5",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: T0,
  payload: { project_path: ROOT },
  chat: null,
  ...over,
});

const write = (session_id: string, file: string, content: string, timestamp: number) =>
  event({ session_id, tool_name: "Write", timestamp,
          payload: { project_path: ROOT, tool_input: { file_path: join(ROOT, file), content } } });
const edit = (session_id: string, file: string, oldS: string, newS: string, timestamp: number) =>
  event({ session_id, tool_name: "Edit", timestamp,
          payload: { project_path: ROOT, tool_input: { file_path: join(ROOT, file), old_string: oldS, new_string: newS } } });

// The rollup is cached per limit for a second; a fresh limit is a fresh read.
let limit = 60;
const bySession = () => {
  process.env.AGENTGLASS_ROOT = ROOT;
  return new Map(db.getSessions(limit++).map((s) => [s.session_id, s]));
};

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(write("risk-s1", "config/settings.yml", `region: eu-west-1\naccess_key: ${AWS}\n`, T0 + 1_000) as any);
  db.insertEvent(edit("risk-s1", "src/authMiddleware.ts", "return next();", "if (!ok) return deny();\nreturn next();", T0 + 2_000) as any);
  db.insertEvent(edit("risk-s1", "src/format.ts", "a", "b", T0 + 3_000) as any);
  db.insertEvent(event({ session_id: "risk-s2", timestamp: T0 + 1_000 }) as any);
});

afterAll(() => {
  for (const [k, v] of [["AGENTGLASS_DB", saved.db], ["XDG_CONFIG_HOME", saved.cfg], ["AGENTGLASS_ROOT", saved.root]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("each change carries its own flags", () => {
  test("the key names its line, the auth module its word, and a plain edit nothing", () => {
    process.env.AGENTGLASS_ROOT = ROOT;
    const byFile = new Map(db.getChanges(50, "risk-s1").map((c) => [c.file_path.slice(ROOT.length + 1), c]));
    const cfg = byFile.get("config/settings.yml")!;
    expect(cfg.risks?.map((r) => r.kind)).toEqual(["secret"]);
    expect(cfg.risks?.[0].line).toBe(2);
    expect(byFile.get("src/authMiddleware.ts")!.risks?.map((r) => r.kind)).toEqual(["auth"]);
    expect(byFile.get("src/format.ts")!.risks).toBeUndefined();
  });

  test("the session detail's changes are the same objects, so the diff panel gets them too", () => {
    const d = db.getSession("risk-s1");
    expect(d?.changes.some((c) => c.risks?.some((r) => r.kind === "secret"))).toBe(true);
  });
});

describe("the session row rolls them up", () => {
  test("one entry per kind and file, and nothing on a session that edited nothing risky", () => {
    const rows = bySession();
    const s1 = rows.get("risk-s1")!;
    expect(s1.risks?.map((r) => `${r.kind}:${r.file.slice(ROOT.length + 1)}`).sort())
      .toEqual(["auth:src/authMiddleware.ts", "secret:config/settings.yml"]);
    expect(rows.get("risk-s2")).toBeDefined();
    expect(rows.get("risk-s2")!.risks).toBeUndefined();
  });

  test("an edit that lands after the first read is picked up on the next", () => {
    bySession();
    db.insertEvent(write("risk-s2", ".github/workflows/ci.yml", "on: push\n", T0 + 5_000) as any);
    expect(bySession().get("risk-s2")!.risks?.map((r) => r.kind)).toEqual(["ci"]);
  });

  test("a backfilled edit older than everything already read is still counted", () => {
    bySession();
    db.insertEvent(write("risk-s1", "bun.lock", "{}\n", T0 - 60_000) as any);
    expect(bySession().get("risk-s1")!.risks?.map((r) => r.kind).sort()).toEqual(["auth", "deps", "secret"]);
  });

  test("reading again with nothing new changes nothing", () => {
    const a = bySession().get("risk-s1")!.risks;
    const b = bySession().get("risk-s1")!.risks;
    expect(b).toEqual(a);
  });
});
