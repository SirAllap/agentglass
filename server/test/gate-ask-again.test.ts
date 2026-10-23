/*
 * "If nobody answers: Ask again" (Settings ▸ Agents ▸ Gate).
 *
 * The notification repeats twice inside the same wait and the hold is then
 * dropped as before. It never outlives the wait: the hook that holds the agent
 * gives up when its own window ends, and a hold that outlived it would be
 * released unseen. And the orchestrator, when it is told, is told once per
 * round and cannot answer.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-gate-ask-again-"));
const saved = { db: process.env.AGENTGLASS_DB, xdg: process.env.XDG_CONFIG_HOME };
process.env.AGENTGLASS_DB = join(dir, "gate.db");
process.env.XDG_CONFIG_HOME = dir;
afterAll(() => {
  for (const [k, v] of [["AGENTGLASS_DB", saved.db], ["XDG_CONFIG_HOME", saved.xdg]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

let gate: typeof import("../src/gate.ts");
let chair: typeof import("../src/gatechair.ts");
let seq = 0;
const newId = () => `${crypto.randomUUID().slice(0, 24)}${String(++seq).padStart(12, "0")}`;
const req = (id: string) => ({ id, source_app: "orbit", session_id: "s-ask-again", tool_name: "Bash", summary: "git push origin main" });
beforeAll(async () => {
  gate = await import("../src/gate.ts");
  chair = await import("../src/gatechair.ts");
});

test("nobody answers: two more asks inside the wait, then it is denied as before", async () => {
  const rounds: number[] = [];
  const t0 = Date.now();
  const out = await gate.submitGate(req(newId()), 1200, undefined, true, (n) => rounds.push(n));
  expect(rounds).toEqual([1, 2]);
  expect(out.decision).toBe("deny");
  expect(Date.now() - t0).toBeLessThan(1700);
});

test("answered before the first ask: no ask follows", async () => {
  const rounds: number[] = [];
  const id = newId();
  const held = gate.submitGate(req(id), 1200, undefined, true, (n) => rounds.push(n));
  gate.decideGate(id, "deny", "no");
  await held;
  await Bun.sleep(900);
  expect(rounds).toEqual([]);
});

test("without the callback nothing is asked again", async () => {
  const out = await gate.submitGate(req(newId()), 1000, undefined, true);
  expect(out.decision).toBe("deny");
});

test("the chair is told in one bounded line that says only the person releases it", async () => {
  const lines: [string, string][] = [];
  const seats = () => [{ root: "/work/orbit", endedAt: null } as never];
  const ok = await chair.tellChair("/work/orbit/wt-1", "Bash", `git push ${"x".repeat(400)}`, 1, { seats, prompt: async (r, t) => { lines.push([r, t]); } });
  expect(ok).toBe(true);
  expect(lines[0]![0]).toBe("/work/orbit");
  expect(lines[0]![1]).toContain("Still held (1 of 2)");
  expect(lines[0]![1]).toContain("Only the person can release it");
  expect(lines[0]![1].length).toBeLessThan(400);
});

test("no seat over that checkout: nobody is told, and nothing throws", async () => {
  expect(await chair.tellChair("/elsewhere", "Bash", "git push", 0, { seats: () => [{ root: "/work/orbit", endedAt: null } as never], prompt: async () => { throw new Error("must not be called"); } })).toBe(false);
  expect(await chair.tellChair("/work/orbit/x", "Bash", "git push", 0, { seats: () => [{ root: "/work/orbit", endedAt: 5 } as never], prompt: async () => { throw new Error("must not be called"); } })).toBe(false);
});
