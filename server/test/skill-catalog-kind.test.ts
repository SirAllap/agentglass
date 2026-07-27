// One invocation charges one catalog entry (#248 F9).
//
// The catalog is keyed by `kind:name`, because a project may legitimately hold
// both `.claude/skills/review/SKILL.md` and `.claude/commands/review.md`. The
// usage bucket, however, is keyed by name alone — so both entries read it. A
// single run of the *skill* was reported as two calls and twice the cost across
// the catalogue, and the command, which had never run, inherited the skill's
// last_used, its per-run cost, a place in the "top 3 most used" badge and a
// spot in the "used recently" filter instead of "to discover".
//
// The bucket only ever contains Skill-tool invocations, so where a skill of
// that name exists it is the one that ran.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-skillkind-"));
const CODE = join(dir, "code");
const PROJ = join(CODE, "proj");
const CLAUDE = join(PROJ, ".claude");
mkdirSync(join(CLAUDE, "skills", "review"), { recursive: true });
mkdirSync(join(CLAUDE, "commands"), { recursive: true });
mkdirSync(join(CLAUDE, "skills", "deploy"), { recursive: true });

// A skill and a command sharing the name "review" — the collision.
writeFileSync(join(CLAUDE, "skills", "review", "SKILL.md"),
  "---\nname: review\ndescription: Review a diff carefully\n---\nbody\n");
writeFileSync(join(CLAUDE, "commands", "review.md"),
  "---\ndescription: A slash command that happens to share the name\n---\nbody\n");
// A command with no rival skill — must still be chargeable.
writeFileSync(join(CLAUDE, "commands", "ship.md"),
  "---\ndescription: Ship it\n---\nbody\n");
// A skill with no rival command — the ordinary case.
writeFileSync(join(CLAUDE, "skills", "deploy", "SKILL.md"),
  "---\nname: deploy\ndescription: Deploy the thing\n---\nbody\n");

process.env.AGENTGLASS_DB = join(dir, "kind.db");
process.env.AGENTGLASS_ROOT = PROJ;
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_CODE_DIR = CODE;

let db: typeof import("../src/db.ts");
let getSkills: typeof import("../src/skills.ts").getSkills;

const skillEvent = (name: string, cost: number) => ({
  source_app: "proj",
  session_id: "s1",
  hook_event_type: "PreToolUse",
  tool_name: "Skill",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "ran a skill",
  timestamp: Date.now(),
  payload: { project_path: PROJ, tool_input: { skill: name } },
  chat: null,
});

const find = (list: any[], kind: string, name: string) =>
  list.find((s) => s.kind === kind && s.name === name);

beforeAll(async () => {
  db = await import("../src/db.ts");
  getSkills = (await import("../src/skills.ts")).getSkills;
  db.insertEvent(skillEvent("review", 0.0175) as any);
  db.insertEvent(skillEvent("ship", 0.0175) as any);
});

describe("a Skill invocation is charged to the skill, not to a same-named command", () => {
  test("the catalogue holds both entries — the collision is legitimate", async () => {
    const all = await getSkills();
    expect(find(all, "skill", "review")).toBeDefined();
    expect(find(all, "command", "review")).toBeDefined();
  });

  test("the skill carries the call", async () => {
    const all = await getSkills();
    expect(find(all, "skill", "review").calls).toBe(1);
  });

  test("the same-named command carries none, and no cost", async () => {
    const all = await getSkills();
    const cmd = find(all, "command", "review");
    expect(cmd.calls).toBe(0);
    expect(cmd.cost_usd).toBe(0);
    // It had never run, so it belongs in "to discover", not "used recently".
    expect(cmd.last_used).toBeNull();
  });

  test("the catalogue's totals are not inflated by the collision", async () => {
    const all = await getSkills();
    const reviewCalls = all.filter((s) => s.name === "review").reduce((n, s) => n + s.calls, 0);
    expect(reviewCalls).toBe(1); // was 2
  });

  test("a command with no rival skill is still charged", async () => {
    const all = await getSkills();
    expect(find(all, "command", "ship").calls).toBe(1);
  });

  test("an uncontested skill is unaffected", async () => {
    const all = await getSkills();
    expect(find(all, "skill", "deploy").calls).toBe(0);
  });
});
