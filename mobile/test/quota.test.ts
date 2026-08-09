/*
 * What Home is allowed to claim about the plan.
 *
 * The two failures worth a suite of their own are both about a card that says
 * something false rather than nothing: a phone off the network drawing an empty
 * bar (which reads as a spent plan), and a day-old reading drawn in the same
 * type as a live one.
 */
import { describe, expect, it } from "bun:test";
import {
  ageLabel, planState, quotaTone, remainingOf, resetLabel, tightestWindow,
} from "../src/model/quota.ts";
import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";

const NOW = 1_700_000_000_000;

const window = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  label: "5h", minutes: 300, usedPercent: 20, resetsAt: null, ...over,
});

const claude = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
  provider: "anthropic", label: "Claude", available: true,
  windows: [window()], observedAt: NOW, ...over,
});

describe("what is left", () => {
  it("is the complement of what was used", () => {
    expect(remainingOf(window({ usedPercent: 62 }))).toBe(38);
  });

  it("never goes negative when a provider overshoots its own limit", () => {
    expect(remainingOf(window({ usedPercent: 103 }))).toBe(0);
  });
});

describe("the headline", () => {
  it("is the window closest to running out, across providers", () => {
    const rows = [
      claude({ windows: [window({ label: "5h", usedPercent: 30 }), window({ label: "weekly", usedPercent: 71 })] }),
      claude({ provider: "codex", label: "Codex", windows: [window({ label: "weekly", usedPercent: 44 })] }),
    ];
    const top = tightestWindow(rows);
    expect(top?.provider).toBe("Claude");
    expect(top?.window.label).toBe("weekly");
    expect(remainingOf(top!.window)).toBe(29);
  });

  it("skips a provider that cannot report rather than counting it as spent", () => {
    const rows = [
      claude({ available: false, windows: [], note: "Quota not reported.", observedAt: undefined }),
      claude({ provider: "codex", label: "Codex", windows: [window({ usedPercent: 10 })] }),
    ];
    expect(tightestWindow(rows)?.provider).toBe("Codex");
  });

  it("carries the reading's own age, not the row it was found beside", () => {
    const rows = [
      claude({ observedAt: NOW - 60_000, windows: [window({ usedPercent: 10 })] }),
      claude({ provider: "codex", label: "Codex", observedAt: NOW - 86_400_000, windows: [window({ usedPercent: 90 })] }),
    ];
    expect(tightestWindow(rows)?.observedAt).toBe(NOW - 86_400_000);
  });

  it("is nothing at all when nothing has answered", () => {
    expect(tightestWindow(null)).toBeNull();
    expect(tightestWindow([])).toBeNull();
  });
});

describe("tone", () => {
  it("matches the dashboard's thresholds so both windows agree", () => {
    expect(quotaTone(0)).toBe("good");
    expect(quotaTone(59)).toBe("good");
    expect(quotaTone(60)).toBe("bad");
    expect(quotaTone(84)).toBe("bad");
    expect(quotaTone(85)).toBe("crit");
  });
});

describe("when it comes back", () => {
  it("reads as a duration while it is inside a day", () => {
    expect(resetLabel(new Date(NOW + 3_600_000 + 44 * 60_000).toISOString(), NOW)).toBe("in 1h 44m");
    expect(resetLabel(new Date(NOW + 12 * 60_000).toISOString(), NOW)).toBe("in 12m");
  });

  it("says now rather than a negative duration once it has passed", () => {
    expect(resetLabel(new Date(NOW - 1_000).toISOString(), NOW)).toBe("now");
  });

  it("says nothing when the provider did not say", () => {
    expect(resetLabel(null, NOW)).toBe("");
    expect(resetLabel("not a date", NOW)).toBe("");
  });
});

describe("how old the reading is", () => {
  it("stays quiet while the number is fresh", () => {
    expect(ageLabel(NOW - 30_000, NOW)).toBe("");
    expect(ageLabel(undefined, NOW)).toBe("");
  });

  it("speaks up once it is old enough to matter", () => {
    expect(ageLabel(NOW - 20 * 60_000, NOW)).toBe("20m old");
    expect(ageLabel(NOW - 5 * 3_600_000, NOW)).toBe("5h old");
    expect(ageLabel(NOW - 2 * 86_400_000, NOW)).toBe("2d old");
  });
});

describe("which card to draw", () => {
  it("tells an unanswered first poll apart from a failed one", () => {
    expect(planState(false, null)).toBe("loading");
    expect(planState(true, null)).toBe("unreachable");
  });

  it("does not read an empty answer as a spent plan", () => {
    expect(planState(true, [])).toBe("empty");
  });

  it("draws rows when there are rows", () => {
    expect(planState(true, [claude()])).toBe("rows");
  });

  it("keeps the last good rows standing through a later failure", () => {
    // The hook never blanks `rows` on error, so this is the state a phone that
    // walked out of wifi is in: real rows, and an error line under them.
    expect(planState(true, [claude()])).toBe("rows");
  });
});
