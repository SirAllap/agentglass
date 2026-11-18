/* Moving cards into the board's active sprint: the body is built from a numeric sprint id and card keys only, and the write is behind the Jira write switch. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-sprint-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
delete process.env.AGENTGLASS_JIRA_WRITE;
const S = await import("../src/jiraSprintMove.ts");
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("sprintMoveBody", () => {
  test("a numeric sprint and card keys make the body", () => {
    expect(S.sprintMoveBody("42", ["orbit-1042", "ORBIT-7"])).toEqual({ ok: true, id: "42", body: { issues: ["ORBIT-1042", "ORBIT-7"] } });
  });
  test("no active sprint says so", () => {
    const r = S.sprintMoveBody("", ["ORBIT-1"]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("no active sprint");
  });
  test("a sprint id that is not a number is refused (it goes into the path)", () => {
    expect(S.sprintMoveBody("42/../9", ["ORBIT-1"]).ok).toBe(false);
  });
  test("a key that is not a card key is refused, and so are none and too many", () => {
    expect(S.sprintMoveBody("42", ["nope"]).ok).toBe(false);
    expect(S.sprintMoveBody("42", []).ok).toBe(false);
    expect(S.sprintMoveBody("42", Array.from({ length: 51 }, (_, i) => `ORBIT-${i + 1}`)).ok).toBe(false);
  });
});

describe("the write switch", () => {
  test("with Jira writes off nothing is sent", async () => {
    const r = await S.moveToSprint({ site: "orbit.atlassian.net", email: "a@example.com", token: "x" } as never, "42", ["ORBIT-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe((await import("../src/jira.ts")).WRITE_OFF);
  });
});
