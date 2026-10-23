/*
 * The one notice a chair with no plan left is allowed to make. Only a blocked
 * agent notifies; everything else is a quiet row, so this fires once when the
 * chair runs out and not again for every worker that fails behind it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NOTIFY_KINDS } from "../../shared/notifyPrefs.ts";
import { composePolicy, defaultStored } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { __forgetTold, watchChair } from "../src/agents/noplan.ts";

const ROOT = "/home/a/code/orbit";
const ready = (id: string, ok: boolean): EngineReadiness => ({
  id, title: id, found: true, path: `/x/${id}`, version: "1", min: null, versionOk: true,
  account: { signedIn: ok }, answers: { state: "never" },
  roles: { worker: { ok }, orchestrator: ok ? { ok } : { ok, why: "signed out" } }, missing: [], envelope: { via: null, enforced: "yes", note: "" },
});

const w = { engine: "opencode", model: "opencode/big-pickle" };
const policy = (chair: string) => composePolicy(defaultStored(), { orchestrator: { engine: chair, model: "m" }, workers: { scout: w, builder: w, verifier: w } });
const none = { on: () => false };

function harness() {
  const said: string[] = [];
  const notify = { out: (project: string, running: number) => said.push(`out:${project}:${running}`), back: (project: string) => said.push(`back:${project}`) };
  return { said, notify };
}

describe("a chair with no plan left", () => {
  test("is told once, with how many workers are still going", () => {
    __forgetTold();
    const { said, notify } = harness();
    const p = policy("claude");
    const engines = [ready("claude", false)];
    for (let i = 0; i < 3; i++) watchChair({ root: ROOT, policy: p, facts: none, readiness: engines, running: 2, notify });
    expect(said).toEqual(["out:orbit:2"]);
  });
  test("a chair that has a plan says nothing, however many workers fail", () => {
    __forgetTold();
    const { said, notify } = harness();
    for (let i = 0; i < 3; i++) watchChair({ root: ROOT, policy: policy("claude"), facts: none, readiness: [ready("claude", true)], running: 1, notify });
    expect(said).toEqual([]);
  });
  test("when the plan comes back the card is taken down, and a later run-out is told again", () => {
    __forgetTold();
    const { said, notify } = harness();
    const p = policy("claude");
    const watch = (ok: boolean) => watchChair({ root: ROOT, policy: p, facts: none, readiness: [ready("claude", ok)], running: 1, notify });
    watch(false); watch(true); watch(true); watch(false);
    expect(said).toEqual(["out:orbit:1", "back:orbit", "out:orbit:1"]);
  });
  test("two projects are told apart", () => {
    __forgetTold();
    const { said, notify } = harness();
    const engines = [ready("claude", false)];
    watchChair({ root: ROOT, policy: policy("claude"), facts: none, readiness: engines, running: 0, notify });
    watchChair({ root: "/home/a/code/acme", policy: policy("claude"), facts: none, readiness: engines, running: 0, notify });
    expect(said).toEqual(["out:orbit:0", "out:acme:0"]);
  });
  test("it is a blocked notice and no new kind of notification", () => {
    expect([...NOTIFY_KINDS].sort()).toEqual(["autopilot", "blocked", "failures", "idle", "reminders", "stalled", "usage"]);
    const src = readFileSync(new URL("../src/alerts.ts", import.meta.url), "utf8");
    const at = src.indexOf("export function pushNoPlanLeft(");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, src.indexOf("\n}\n", at))).toContain('"blocked"');
  });
});
