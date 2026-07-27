// Search must find text that is verbatim in the index (#248 F14).
//
// The MATCH expression was built by stripping every character that is not
// alphanumeric or an underscore, then prefix-starring what was left. That
// welds any term with an inner separator into a single token the unicode61
// tokenizer can never produce, so the search returned ZERO hits for text
// sitting in the index:
//
//   src/db.ts      -> srcdbts*   0 hits
//   foo-bar        -> foobar*    0 hits
//   C++            -> C*         matches nearly everything
//
// Paths, hyphenated flags, dotted symbols and error strings are most of what
// anyone searches an agent's output for, so this was the common case.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-search-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "search.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const NEEDLE = "opened src/db.ts and hit error: ENOENT on foo-bar";

const event = (summary: string, session: string) => ({
  source_app: "proj",
  session_id: session,
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
  summary,
  timestamp: Date.now() - 60_000,
  payload: { project_path: ROOT, tool_input: { command: summary } },
  chat: null,
});

const hits = (q: string) => db.searchEvents(q, 60).length;

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(event(NEEDLE, "s1") as any);
  db.insertEvent(event("a totally unrelated line about deployment", "s2") as any);
});

describe("a term with an inner separator still finds its text", () => {
  for (const q of ["src/db.ts", "foo-bar", "error: ENOENT", "db.ts"]) {
    test(`"${q}" finds the line containing it`, () => {
      expect(hits(q)).toBe(1);
    });
  }

  test("an ordinary word still works", () => {
    expect(hits("deployment")).toBe(1);
  });

  test("two terms are still ANDed", () => {
    expect(hits("opened ENOENT")).toBe(1);
    expect(hits("opened deployment")).toBe(0);
  });

  test("a prefix still matches", () => {
    expect(hits("deploy")).toBe(1); // prefix of "deployment"
  });
});

describe("the expression it builds", () => {
  test("a path becomes a quoted phrase, not a welded token", () => {
    expect(db.ftsQuery("src/db.ts")).toBe('"src/db.ts"*');
  });

  test("the star sits outside the quotes, where it is a prefix operator", () => {
    expect(db.ftsQuery("foo")).toBe('"foo"*');
  });

  test("a user-supplied phrase is kept whole rather than split on whitespace", () => {
    expect(db.ftsQuery('"cost gate"')).toBe('"cost gate"*');
  });

  test("an inner double quote is doubled, which is how fts5 escapes it", () => {
    expect(db.ftsQuery('say"hi')).toBe('"say""hi"*');
  });

  // C++ used to collapse to `C*`, which prefix-matches essentially every event.
  test("a term with nothing indexable is dropped, not turned into a bare star", () => {
    expect(db.ftsQuery("C++")).toBe('"C++"*'); // has a letter — kept
    expect(db.ftsQuery("--")).toBe("");        // has none — dropped
    expect(db.ftsQuery("++ --")).toBe("");
  });

  test("an empty query stays empty", () => {
    expect(db.ftsQuery("   ")).toBe("");
    expect(hits("   ")).toBe(0);
  });
});

describe("a query that cannot be parsed does not take the panel down", () => {
  // searchEvents catches and returns [] rather than throwing a 500 at the UI.
  for (const q of ['"', 'a "b', "NEAR(", "*"]) {
    test(`${JSON.stringify(q)} returns a result set rather than throwing`, () => {
      expect(() => db.searchEvents(q, 60)).not.toThrow();
    });
  }
});
