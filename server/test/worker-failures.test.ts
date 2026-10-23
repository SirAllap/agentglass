/*
 * What a worker's first turn looked like when it failed, judged from the two
 * files the wrapper leaves: stdout and stderr. A retry on another engine is
 * allowed only when nothing had been done yet, so the question this file asks
 * most is "had the turn started".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { firstTurnFailure, workStarted } from "../src/agents/failures.ts";
import { nextEngine } from "../src/agents/workerstart.ts";
import { RATE_LIMITED, SIGNED_OUT, frames } from "./fixtures/fakeEngines.ts";

const lines = (l: string[] | undefined) => (l ?? []).join("\n");

describe("work started", () => {
  test("an answer or a tool call is work; a handshake and an error are not", () => {
    for (const e of ["claude", "codex", "hermes"] as const) {
      expect(workStarted(lines(frames(e))), e).toBe(true);
    }
    expect(workStarted(lines(SIGNED_OUT.codex!.frames))).toBe(false);
    expect(workStarted(lines(SIGNED_OUT.claude!.frames))).toBe(false);
    expect(workStarted("")).toBe(false);
    expect(workStarted(JSON.stringify({ type: "step_start", sessionID: "ses_fake0001", part: { type: "step-start" } }))).toBe(false);
    expect(workStarted(JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status: "completed" } } }))).toBe(true);
  });
  test("a frame this file does not know counts as work: the unsure case never retries", () => {
    expect(workStarted(JSON.stringify({ type: "something_new" }))).toBe(true);
  });
  test("a result that is an error is the end of a failed handshake, not work", () => {
    expect(workStarted(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "usage limit reached" }))).toBe(false);
    expect(workStarted(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }))).toBe(true);
  });
});

describe("a first-turn failure", () => {
  test("a rate-limit line on stderr, with nothing on stdout", () => {
    expect(firstTurnFailure("", RATE_LIMITED.stderr!)).toBe("rate-limit");
  });
  test("signed out: Claude says so on stdout, Codex in an error frame", () => {
    expect(firstTurnFailure(lines(SIGNED_OUT.claude!.frames), "")).toBe("signed-out");
    expect(firstTurnFailure(lines(SIGNED_OUT.codex!.frames), "")).toBe("signed-out");
  });
  test("a limit reported inside the result frame", () => {
    const out = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Claude usage limit reached" });
    expect(firstTurnFailure(out, "")).toBe("rate-limit");
  });
  test("the same words AFTER work started are not a retry: the work is half done", () => {
    expect(firstTurnFailure(lines(frames("claude")), RATE_LIMITED.stderr!)).toBeNull();
    const tool = JSON.stringify({ type: "tool_use", part: { tool: "edit" } });
    expect(firstTurnFailure(tool, RATE_LIMITED.stderr!)).toBeNull();
  });
  test("an ordinary failure matches neither pattern", () => {
    expect(firstTurnFailure("", "Error: could not read the config")).toBeNull();
  });
  test("the words in a model's own text do not count", () => {
    expect(firstTurnFailure(lines(frames("claude", "I fixed the rate limit handler")), "")).toBeNull();
  });
});

describe("the next engine for a worker whose first turn failed", () => {
  const A = { engine: "opencode", model: "opencode/big-pickle" }, B = { engine: "claude", model: "claude-sonnet-5-5" }, C = { engine: "codex", model: "gpt-orbit" };
  const all = () => true;
  test("the entry after the one it was on", () => {
    expect(nextEngine({ chain: [A, B, C], by: A, ask: false, usable: all })).toEqual({ ok: true, choice: B, position: 1 });
    expect(nextEngine({ chain: [A, B, C], by: A, ask: false, usable: (c) => c.engine !== "claude" })).toEqual({ ok: true, choice: C, position: 2 });
  });
  test("a chain that changed since the start is read by engine, not by the old position", () => {
    // Started on A at position 0 of [A, B]; a rule went off and the chain is [C, A, B] now.
    expect(nextEngine({ chain: [C, A, B], by: A, ask: false, usable: all })).toEqual({ ok: true, choice: B, position: 2 });
    // Its engine is not in the chain any more: nothing "after" it, so the chain from the top.
    expect(nextEngine({ chain: [B, C], by: A, ask: false, usable: all })).toEqual({ ok: true, choice: B, position: 0 });
  });
  test("an engine it has already been on is never picked again", () => {
    // Moved A to B, and the chain now lists A after B.
    expect(nextEngine({ chain: [B, A], by: { ...B, from: "opencode" }, ask: false, usable: all }).ok).toBe(false);
    expect(nextEngine({ chain: [B, { engine: "claude", model: "claude-opus-5-5" }], by: B, ask: false, usable: all }).ok).toBe(false);
    expect(nextEngine({ chain: [B, A, C], by: { ...B, from: "opencode" }, ask: false, usable: all })).toEqual({ ok: true, choice: C, position: 2 });
  });
  test("a role the person set to ask is not chosen for them", () => {
    const r = nextEngine({ chain: [A, B], by: A, ask: true, usable: all });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.why).toMatch(/ask/);
  });
  test("nothing ready is said so", () => {
    expect(nextEngine({ chain: [A, B], by: A, ask: false, usable: () => false })).toMatchObject({ ok: false, why: "no other engine in the chain is ready" });
  });
});

describe("zero polling", () => {
  test("the files that arm timers, watch runs and judge failures name no interval", async () => {
    for (const f of ["../src/agents/ceilings.ts", "../src/agents/failures.ts", "../src/agents/noplan.ts", "../src/agents/policystart.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
      expect(src, f).not.toMatch(/setInterval|every\s*\(|Bun\.cron/);
    }
  });
});
