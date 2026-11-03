/*
 * What the chain tooltip says, without a renderer: one step has no fallback to
 * name, five steps are a ladder that scrolls, a rule says what moved it, the
 * switch state is a state, and the step the board says is working is the one
 * outlined. The component only paints this.
 */
import { describe, expect, test } from "bun:test";
import type { Chain } from "../../shared/orchestration.ts";
import { CHAIN_TIP_NO_FALLBACK, chainTip, type ChainTipInput } from "../src/lib/chainTip.ts";
import { readTip, tipAttr } from "../src/lib/tip.ts";

const chain = (...models: string[]): Chain =>
  models.map((m) => ({ engine: m.startsWith("claude") ? "claude" : m.startsWith("gpt") ? "codex" : "opencode", model: m }));

const input = (over: Partial<ChainTipInput> = {}): ChainTipInput => ({
  chain: chain("claude-sonnet-5-5", "deepseek-v4.1-flash"),
  rounds: 3,
  ask: false,
  running: false,
  pass: "Inspector",
  fail: "Builder",
  rule: null,
  ...over,
});

describe("the chain tip", () => {
  test("one step says there is no fallback instead of drawing a gap", () => {
    const t = chainTip(input({ chain: chain("claude-haiku-5-5") }));
    expect(t.steps.map((s) => s.n)).toEqual([1]);
    expect(t.noFallback).toBe(CHAIN_TIP_NO_FALLBACK);
    expect(t.noFallback).toContain("Configure → Who does the work");
    expect(t.detail).toBe("1 step");
    expect(t.scrolls).toBe(false);
  });

  test("five steps are a numbered ladder that scrolls, and the footer stays out of it", () => {
    const five = chain("deepseek-v4.1-flash", "claude-sonnet-5-5", "glm-5", "gpt-5.5-codex", "claude-haiku-5-5");
    const t = chainTip(input({ chain: five }));
    expect(t.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    expect(t.steps.map((s) => s.tag)).toEqual(["Main", "Fallback 1", "Fallback 2", "Fallback 3", "Fallback 4"]);
    expect(t.detail).toBe("5 steps");
    expect(t.scrolls).toBe(true);
    expect(t.noFallback).toBeNull();
    // The footer is its own field, never a step: the ladder can scroll under it.
    expect(t.footer).toContain("Configure → Who does the work");
  });

  test("a rule that moved the chain names itself and the engine it moved away from", () => {
    const moved = chainTip(input({ rule: { name: "Plan low → OpenCode Go", was: "Claude Code · claude-sonnet-5-5" } }));
    expect(moved.why).toBe("Rule “Plan low → OpenCode Go” moved it from Claude Code · claude-sonnet-5-5.");
    expect(chainTip(input()).why).toBeNull();
  });

  test("Ask when it runs is a state, and it changes what the last round does", () => {
    const on = chainTip(input({ ask: true, rounds: 2 }));
    expect(on.ask).toBe(true);
    expect(on.askWord).toBe("On · it stops and lets you pick");
    expect(on.rounds).toEqual({ of: 2, dots: [false, false], word: "up to 2 tries · then it asks you" });
    const off = chainTip(input({ ask: false, rounds: 2 }));
    expect(off.ask).toBe(false);
    expect(off.askWord).toBe("Off");
    expect(off.rounds?.word).toBe("up to 2 tries · then it hands over to the next step");
    // A role with no fail arrow has no rounds to draw.
    expect(chainTip(input({ rounds: null })).rounds).toBeNull();
  });

  test("the step the board says is working is the outlined one, and only it", () => {
    const t = chainTip(input({ running: true }));
    expect(t.steps.map((s) => s.now)).toEqual([true, false]);
    expect(t.steps[0]!.tag).toBe("Running now");
    expect(t.steps[0]!.main).toBe(true);
    expect(chainTip(input()).steps.map((s) => s.now)).toEqual([false, false]);
  });

  test("a long model name is data like any other: the ladder does not change shape", () => {
    const long = "opencode-go/deepseek-v4.1-flash-experimental-2026-11-preview-with-a-really-long-name";
    const t = chainTip(input({ chain: chain(long, "claude-sonnet-5-5") }));
    expect(t.steps[0]!.model).toBe(long);
    expect(t.steps).toHaveLength(2);
    expect(t.detail).toBe("2 steps");
    expect(t.steps[1]!.tag).toBe("Fallback 1");
  });

  test("the tip survives the attribute it is sent in", () => {
    const t = chainTip(input({ ask: true, rule: { name: "Night budget", was: "OpenCode" } }));
    const back = readTip(tipAttr({ name: t.title, detail: t.detail, chain: t }));
    expect(back.chain).toEqual(t);
    expect(back.name).toBe("Who runs this block");
    expect(back.detail).toBe("2 steps");
  });
});
