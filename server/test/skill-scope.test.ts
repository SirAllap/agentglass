// top_skills is a scoped read, like every other stat. skillUsageDetail forgot
// the project filter, so a cockpit opened for one project listed skills — and
// charged their cost — from every other project on the machine.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-skillscope-"));
const SCOPED = join(dir, "scoped");
const OTHER = join(dir, "other");
for (const p of [SCOPED, OTHER]) mkdirSync(p, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "skill.db");
process.env.AGENTGLASS_ROOT = SCOPED;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const skillEvent = (project: string, session: string, skill: string) => ({
  source_app: project.split("/").pop()!,
  session_id: session,
  hook_event_type: "PreToolUse",
  tool_name: "Skill",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "ran a skill",
  timestamp: Date.now(),
  payload: { project_path: project, tool_input: { skill } },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(skillEvent(SCOPED, "s-in", "alpha") as any);
  db.insertEvent(skillEvent(OTHER, "s-out", "beta") as any);
});

describe("skillUsageDetail scoping", () => {
  test("lists only skills run in the open project", () => {
    const skills = db.skillUsageDetail(0).map((s) => s.skill);
    expect(skills).toContain("alpha");
    expect(skills).not.toContain("beta"); // the other project's skill must not leak in
  });
});
