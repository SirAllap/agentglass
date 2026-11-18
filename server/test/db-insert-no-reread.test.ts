import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-noreread-"));
mkdirSync(join(dir, "p"), { recursive: true });
process.env.AGENTGLASS_ROOT = join(dir, "p");
let mod: typeof import("../src/db.ts");
let ing: typeof import("../src/ingest.ts");
beforeAll(async () => { mod = await import("../src/db.ts"); ing = await import("../src/ingest.ts"); });

const mk = (over: Record<string, unknown> = {}) => ing.normalize({
  source_app: "probe", session_id: "s-noreread", hook_event_type: "PostToolUse", tool_name: "Bash",
  tool_use_id: "tu1", timestamp: 1_700_000_000_000, model_name: "claude-sonnet-5-5",
  payload: { cwd: join(dir, "p"), project_path: join(dir, "p"), tool_input: { command: "ls" }, big: "x".repeat(4000) },
  ...over,
} as never);

test("insert returns the same event the re-read path built, with no payload parse", () => {
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return realParse(...a); }) as typeof JSON.parse;
  let r;
  try { r = mod.insertEvent(mk()); } finally { JSON.parse = realParse; }
  expect(r.inserted).toBe(true);
  // Old path: SELECT * + parse of the stored payload (>= 1 parse of the 4 KB payload).
  expect(parses).toBe(0);
  const old = mod.getRecent(50).find((e) => e.id === r.event.id)!;
  expect(r.event).toEqual(old);
});
