/*
 * What the fleet is costing and where it is going wrong.
 *
 * The server has computed all of this from the beginning — `/insights` names
 * the session stuck in a loop, the one burning tokens, the one throwing errors;
 * `/stats` breaks spend down by model and by app. The phone showed three
 * numbers in a Settings sheet and had no route to any of the rest, so "which
 * agent is the expensive one" and "is anything looping right now" could not be
 * answered from the device you are holding when you are away from the desk —
 * which is the only time the question is urgent.
 */
import { describe, expect, it } from "bun:test";
import { sessionForInsight, orderInsights, spendByModel, spendByApp, errorRate } from "../src/mobile/fleet.ts";
import type { Insight, CostByModel, SessionRollup } from "../../shared/types.ts";

const NOW = 1_700_000_000_000;

const s = (id: string, app = "claude-code"): SessionRollup => ({
  session_id: id, source_app: app, model_name: "opus", project_path: "/w/a",
  started_at: NOW, ended_at: null, last_seen: NOW,
  event_count: 1, tool_count: 1, error_count: 0,
  input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0,
});

const ins = (over: Partial<Insight> = {}): Insight => ({
  id: "i1", severity: "warn", kind: "loop", title: "Going in circles",
  detail: "Read on the same file eleven times", session: "claude-code:cd3fa401", ts: NOW, ...over,
});

const model = (over: Partial<CostByModel> = {}): CostByModel => ({
  model_name: "opus", input_tokens: 0, output_tokens: 0,
  cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 1, sessions: 1, unpriced: false, ...over,
} as CostByModel);

describe("from an insight to the conversation it is about", () => {
  const list = [s("cd3fa401-7cb5-4652-ac0b-785ed3751479"), s("aa119900-0000-4000-8000-000000000000")];

  it("finds the session behind the label", () => {
    // The server writes `<app>:<first 8 of the uuid>` — enough to recognise,
    // not enough to open. This is what makes the card tappable.
    expect(sessionForInsight("claude-code:cd3fa401", list)?.session_id)
      .toBe("cd3fa401-7cb5-4652-ac0b-785ed3751479");
  });

  it("will not cross runtimes on a matching prefix", () => {
    // Eight hex characters collide often enough on a busy machine; the app half
    // of the label is not decoration.
    expect(sessionForInsight("codex:cd3fa401", list)).toBeNull();
  });

  it("opens nothing rather than the wrong thing when the prefix is ambiguous", () => {
    // Two matches is not an answer. Opening the wrong conversation from an
    // alert about a runaway agent is worse than opening none.
    const twins = [s("cd3fa401-1111-4000-8000-000000000000"), s("cd3fa401-2222-4000-8000-000000000000")];
    expect(sessionForInsight("claude-code:cd3fa401", twins)).toBeNull();
  });

  it("survives a label that is not one", () => {
    expect(sessionForInsight(null, list)).toBeNull();
    expect(sessionForInsight("", list)).toBeNull();
    expect(sessionForInsight("nocolon", list)).toBeNull();
    expect(sessionForInsight(":cd3fa401", list)).toBeNull();
  });

  it("an empty prefix resolves to nothing, even against one session", () => {
    // `startsWith("")` is true of everything, so with a two-session list the
    // ambiguity check catches this by accident — and with one session it does
    // not, and a truncated label would open whatever happened to be there.
    expect(sessionForInsight("claude-code:", list)).toBeNull();
    expect(sessionForInsight("claude-code:", [s("cd3fa401-7cb5-4652-ac0b-785ed3751479")])).toBeNull();
  });

  it("splits on the last colon, because a runtime name can contain one", () => {
    const odd = [s("cd3fa401-7cb5-4652-ac0b-785ed3751479", "acme:agent")];
    expect(sessionForInsight("acme:agent:cd3fa401", odd)?.source_app).toBe("acme:agent");
  });
});

describe("which insight to read first", () => {
  it("puts the worst at the top, then the newest", () => {
    const out = orderInsights([
      ins({ id: "old-bad", severity: "bad", ts: NOW - 60_000 }),
      ins({ id: "info", severity: "info", ts: NOW }),
      ins({ id: "new-bad", severity: "bad", ts: NOW }),
      ins({ id: "warn", severity: "warn", ts: NOW }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["new-bad", "old-bad", "warn", "info"]);
  });

  it("leaves the caller's array alone", () => {
    const given = [ins({ id: "a", severity: "info" }), ins({ id: "b", severity: "bad" })];
    orderInsights(given);
    expect(given.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("where the money went", () => {
  it("ranks by cost and shares add up", () => {
    const rows = spendByModel([
      model({ model_name: "haiku", cost_usd: 1 }),
      model({ model_name: "opus", cost_usd: 3 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["opus", "haiku"]);
    expect(rows[0]!.share).toBeCloseTo(0.75);
    expect(rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1);
  });

  it("divides by what is drawn, not by the fleet's total", () => {
    // `by_model` can omit a model whose price is unknown. Dividing by a larger
    // number would draw every bar short and understate all of them at once,
    // which reads as "nothing is expensive".
    const rows = spendByModel([model({ cost_usd: 2 })]);
    expect(rows[0]!.share).toBe(1);
  });

  it("draws no bar at all when nothing has been spent", () => {
    // A full-width bar for $0.00 is the wrong answer to "where did it go".
    const rows = spendByModel([model({ cost_usd: 0 }), model({ model_name: "haiku", cost_usd: 0 })]);
    expect(rows.every((r) => r.share === 0)).toBe(true);
    expect(rows.every((r) => Number.isFinite(r.share))).toBe(true);
  });

  it("keeps the unpriced flag, so a blank is not read as free", () => {
    expect(spendByModel([model({ unpriced: true })])[0]!.unpriced).toBe(true);
  });

  it("names a model that arrived without one", () => {
    expect(spendByModel([model({ model_name: "" })])[0]!.name).toBe("unknown");
  });

  it("does the same by runtime", () => {
    const rows = spendByApp([
      { source_app: "codex", events: 1, sessions: 1, tool_calls: 1, cost_usd: 1, tokens: 1 },
      { source_app: "claude-code", events: 1, sessions: 2, tool_calls: 1, cost_usd: 3, tokens: 1 },
    ]);
    expect(rows[0]!.name).toBe("claude-code");
    expect(rows[0]!.share).toBeCloseTo(0.75);
  });

  it("handles an empty breakdown without dividing by zero", () => {
    expect(spendByModel([])).toEqual([]);
    expect(spendByApp([])).toEqual([]);
  });
});

describe("how often a tool call fails", () => {
  it("uses the narrower numerator", () => {
    expect(errorRate({ tool_calls: 100, tool_errors: 4 })).toBeCloseTo(0.04);
  });

  it("says nothing rather than something wrong", () => {
    // `errors` counts LLM spans and notifications, which never enter
    // `tool_calls` — see shared/types.ts. An older server sends no
    // `tool_errors`, and a rate computed from the wider count would be a
    // confident overstatement.
    expect(errorRate({ tool_calls: 100 })).toBeNull();
    expect(errorRate({ tool_calls: 0, tool_errors: 0 })).toBeNull();
    expect(errorRate(null)).toBeNull();
    expect(errorRate(undefined)).toBeNull();
  });
});
