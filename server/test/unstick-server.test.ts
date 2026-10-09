/*
 * The server half of Unstick: it asks GitHub again before it closes anything and
 * refuses with a sentence, because the panel's copy can be minutes old and a close
 * fires automations somewhere else. Injected deps: no gh, no network, no writes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unstickClose, unstickReopen, type UnstickServerDeps } from "../src/prs.ts";
import type { Look, UnstickFacts } from "../../shared/unstick.ts";

const OLD = "c".repeat(40);
const NEW = "e".repeat(40);
const facts: UnstickFacts = {
  state: "OPEN", isDraft: false, author: true, canWrite: true, crossRepo: false, checksRunning: false,
  autoMerge: false, inMergeQueue: false, changesRequested: false, baseLocked: false,
  headSha: OLD, refSha: NEW, mergeState: "UNKNOWN",
};
const full = (over: Partial<UnstickFacts> = {}): Look => ({ ok: true, state: over.state ?? "OPEN", headSha: OLD, refSha: NEW, mergeState: "UNKNOWN", facts: { ...facts, ...over } });

function deps(look: Look): UnstickServerDeps & { acted: boolean[] } {
  const acted: boolean[] = [];
  return { acted, look: async () => look, act: async (_r, _n, reopen) => { acted.push(reopen); return { ok: true, detail: reopen ? "reopened" : "closed" }; } };
}
// `writeGuard` wants a real checkout inside the open project; this repository is one.
const ROOT = import.meta.dir + "/..";

// The open project is whatever AGENTGLASS_ROOT says, and `bun test` shares one
// process: about sixty other files set it to a scratch repo and never put it
// back, so after any of them every call here was refused with "outside the open
// project" and passed alone. This file opens the project it asserts on, and
// puts the environment back when it is done.
const REPO = import.meta.dir + "/../..";
let savedRoot: string | undefined;
beforeAll(() => { savedRoot = process.env.AGENTGLASS_ROOT; process.env.AGENTGLASS_ROOT = REPO; });
afterAll(() => { if (savedRoot === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = savedRoot; });

describe("unstickClose: re-checks against a fresh read", () => {
  test("a stuck, eligible pull request is closed", async () => {
    const d = deps(full());
    const r = await unstickClose(ROOT, 12, d);
    expect(r.ok).toBe(true);
    expect(d.acted).toEqual([false]);
  });
  for (const [name, over] of [
    ["a draft", { isDraft: true }], ["merged", { state: "MERGED" }], ["already closed", { state: "CLOSED" }],
    ["not the author", { author: false }], ["no write", { canWrite: false }], ["a fork", { crossRepo: true }],
    ["checks running", { checksRunning: true }], ["auto-merge", { autoMerge: true }], ["in the queue", { inMergeQueue: true }],
    ["changes requested", { changesRequested: true }], ["base locked", { baseLocked: true }],
    ["no longer stuck", { refSha: OLD, mergeState: "CLEAN" }],
    ["branch ahead but GitHub has decided", { mergeState: "BEHIND" }],
  ] as const) {
    test(`${name}: refused, the close is never called`, async () => {
      const d = deps(full(over));
      const r = await unstickClose(ROOT, 12, d);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Nothing was closed");
      expect(d.acted).toEqual([]);
    });
  }
  test("an unreadable pull request is not closed", async () => {
    const d = deps({ ok: false, error: "GitHub did not answer" });
    const r = await unstickClose(ROOT, 12, d);
    expect(r).toMatchObject({ ok: false });
    expect(d.acted).toEqual([]);
  });
  test("an answer without facts is not closed", async () => {
    const d = deps({ ok: true, state: "OPEN", headSha: OLD, refSha: NEW, mergeState: "UNKNOWN" });
    expect((await unstickClose(ROOT, 12, d)).ok).toBe(false);
    expect(d.acted).toEqual([]);
  });
  test("a bad number is refused before any read", async () => {
    const d = deps(full());
    expect((await unstickClose(ROOT, "x", d)).ok).toBe(false);
    expect((await unstickClose(ROOT, -3, d)).ok).toBe(false);
    expect(d.acted).toEqual([]);
  });
});

describe("unstickReopen: only a closed, unmerged pull request whose branch exists", () => {
  const light = (state: string, refSha: string | null): Look => ({ ok: true, state, headSha: OLD, refSha, mergeState: "UNKNOWN" });
  test("closed with its branch: reopened", async () => {
    const d = deps(light("CLOSED", NEW));
    expect((await unstickReopen(ROOT, 12, d)).ok).toBe(true);
    expect(d.acted).toEqual([true]);
  });
  test("already open: ok, nothing called", async () => {
    const d = deps(light("OPEN", NEW));
    expect(await unstickReopen(ROOT, 12, d)).toMatchObject({ ok: true, detail: "already open" });
    expect(d.acted).toEqual([]);
  });
  test("merged: refused", async () => {
    const d = deps(light("MERGED", NEW));
    expect((await unstickReopen(ROOT, 12, d)).ok).toBe(false);
    expect(d.acted).toEqual([]);
  });
  test("branch gone: refused with the reason", async () => {
    const d = deps(light("CLOSED", null));
    const r = await unstickReopen(ROOT, 12, d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("branch is gone");
    expect(d.acted).toEqual([]);
  });
  test("unreadable: refused", async () => {
    const d = deps({ ok: false, error: "net" });
    expect((await unstickReopen(ROOT, 12, d)).ok).toBe(false);
    expect(d.acted).toEqual([]);
  });
});
