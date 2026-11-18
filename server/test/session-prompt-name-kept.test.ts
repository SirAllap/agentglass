// The Lantern's board asked, on every poll, for the name of each untitled
// session, and each ask read every prompt the session ever had to look at
// six: 4.5 s of the server's only thread and about 480 MB read from disk,
// measured in one GET /agents/board.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-promptname-"));
const ROOT = join(dir, "orbit");
mkdirSync(ROOT, { recursive: true });
const saved = { db: process.env.AGENTGLASS_DB, cfg: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT };
process.env.AGENTGLASS_DB = join(dir, "names.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_ROOT = ROOT;

let db: typeof import("../src/db.ts");
const T0 = Date.now() - 3_600_000;
const prompt = (session_id: string, text: string, timestamp: number) => db.insertEvent({
  source_app: "orbit", session_id, hook_event_type: "UserPromptSubmit", tool_name: null, tool_use_id: null,
  agent_id: null, agent_type: null, model_name: "claude-opus-5", is_error: 0, error_text: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false, summary: "x", timestamp, chat: null,
  payload: { project_path: ROOT, prompt: text },
} as never);

beforeAll(async () => { db = await import("../src/db.ts"); });
afterAll(() => {
  for (const [k, v] of [["AGENTGLASS_DB", saved.db], ["XDG_CONFIG_HOME", saved.cfg], ["AGENTGLASS_ROOT", saved.root]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a name is read once, and again only when that session's prompts change", () => {
  prompt("pn-long", "mira esto", T0 + 1);
  prompt("pn-long", "Rework the companion pairing screen", T0 + 2);
  for (let i = 0; i < 40; i++) prompt("pn-long", `And then step number ${i} of the plan`, T0 + 10 + i);
  prompt("pn-other", "Fix the pagination arrows today", T0 + 5);

  const n0 = db.promptNameReads;
  expect(db.sessionNames(["pn-long", "pn-other"]).get("pn-long")).toBe("Rework the companion pairing screen");
  expect(db.promptNameReads - n0).toBe(2);
  // The poll, again and again: nothing goes to the table.
  for (let i = 0; i < 5; i++) expect(db.sessionNames(["pn-long", "pn-other"]).get("pn-other")).toBe("Fix the pagination arrows today");
  expect(db.promptNameReads - n0).toBe(2);

  // A prompt backfilled from before the others changes which six come first: that session is read again, the other is not.
  prompt("pn-long", "Design the nightly sweep report", T0);
  expect(db.sessionNames(["pn-long", "pn-other"]).get("pn-long")).toBe("Design the nightly sweep report");
  expect(db.promptNameReads - n0).toBe(3);
});

test("no name yet is kept as an answer too, until a prompt arrives", () => {
  prompt("pn-none", "esto?", T0 + 1);
  const n0 = db.promptNameReads;
  expect(db.sessionNames(["pn-none"]).has("pn-none")).toBe(false);
  expect(db.sessionNames(["pn-none"]).has("pn-none")).toBe(false);
  expect(db.promptNameReads - n0).toBe(1);
  prompt("pn-none", "Rename the settings page sections", T0 + 2);
  expect(db.sessionNames(["pn-none"]).get("pn-none")).toBe("Rename the settings page sections");
});

test("the read stops at six rows per session", async () => {
  const source = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
  const at = source.indexOf("const firstSixPrompts = db.query");
  expect(at).toBeGreaterThan(-1);
  expect(source.slice(at, source.indexOf(";", at))).toContain("ORDER BY timestamp ASC, id ASC LIMIT 6");
});
