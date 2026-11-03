/*
 * What a provider's chip says, and what it refuses to say.
 *
 * There is no renderer in this project, so the decision is pulled out of the
 * strip: the component draws whatever `chipView` answers. The case that matters
 * is the one with no reading — a dash and the provider's own sentence, never a
 * 0%, because "nothing used" and "nobody would say" are different answers.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderUsage } from "../../shared/types.ts";
import { chipView, shortWindow, tabBadge, worstWindow } from "../src/lib/usageChips.ts";

const topbar = await Bun.file(new URL("../src/components/TopBar.tsx", import.meta.url)).text();

const win = (label: string, minutes: number, usedPercent: number) =>
  ({ label, minutes, usedPercent, resetsAt: null });

const opencode: ProviderUsage = {
  provider: "opencode", label: "OpenCode Go", available: true, plan: "Go",
  windows: [win("5h", 300, 4), win("weekly", 10080, 1), win("monthly", 43200, 1)],
  observedAt: 1,
};

const signedOut: ProviderUsage = {
  provider: "opencode", label: "OpenCode Go", available: false, windows: [],
  note: "OpenCode Go is not signed in in its browser profile.",
};

describe("the chip", () => {
  test("OpenCode Go: a fresh key or console reading is the number, the local estimate is not", () => {
    const local = { ...opencode, windows: [win("5h", 300, 13), win("weekly", 10080, 19.6), win("monthly", 43200, 9.6)] };
    const withKey = { ...local, calibration: { at: Date.now(), windows: [win("5h", 300, 34), win("weekly", 10080, 53), win("monthly", 43200, 26)] } };
    const v = chipView(withKey);
    expect(v.kind === "reading" && v.percent).toBe(53);
    const stale = chipView({ ...withKey, calibration: { at: Date.now() - 3 * 3_600_000, windows: withKey.calibration.windows } });
    expect(stale.kind === "reading" && stale.percent).toBe(19.6);
  });
  test("shows the tightest window with its own tag", () => {
    const v = chipView(opencode);
    expect(v.kind).toBe("reading");
    if (v.kind !== "reading") return;
    expect(v.percent).toBe(4);
    expect(v.tag).toBe("5h");
    expect(v.tip).toContain("4% used");
  });

  test("a provider with no reading renders no number at all", () => {
    const v = chipView(signedOut);
    expect(v.kind).toBe("none");
    expect("percent" in v).toBe(false);
    expect(v.tip).toContain("not signed in");
    expect(v.tip).not.toMatch(/\d+%/);
  });

  test("available but with no windows is still no reading", () => {
    const v = chipView({ provider: "opencode", label: "OpenCode Go", available: true, windows: [] });
    expect(v.kind).toBe("none");
  });

  test("a spend total with no windows is a reading, with its span and source", () => {
    const v = chipView({
      provider: "opencode", label: "OpenCode Go", available: true, windows: [],
      spend: { usd: 7.07, window: "30 days" }, source: "opencode stats",
    });
    expect(v.kind).toBe("spend");
    if (v.kind !== "spend") return;
    expect(v.usd).toBe(7.07);
    expect(v.span).toBe("30 days");
    expect(v.tip).toContain("$7.07");
    expect(v.tip).toContain("opencode stats");
  });

  test("a tie goes to the shorter window, which is the one that comes back first", () => {
    expect(worstWindow(opencode)?.minutes).toBe(300);
  });

  test("the month says mo, not 30d", () => {
    expect(shortWindow(win("monthly", 43200, 1))).toBe("mo");
  });

  test("one clock: a badge asked with the sheet's now cannot flip under a body that froze it", () => {
    // A console reading 11h59m old at the sheet's `now` is the plan's number;
    // two minutes later it is past CONSOLE_VALID_MS and the badge would switch
    // to the local estimate while the headline and rows still showed the
    // console's windows.
    const at = Date.parse("2026-10-31T12:00:00Z");
    const consoleWin = { label: "weekly", minutes: 10080, usedPercent: 53, resetsAt: new Date(at + 3 * 86_400_000).toISOString() };
    const u: ProviderUsage = {
      ...opencode,
      windows: [win("weekly", 10080, 19.6)],
      calibration: { at: at - (11 * 60 + 59) * 60_000, windows: [consoleWin] },
    };
    const pct = (v: ReturnType<typeof chipView>) => (v.kind === "reading" ? v.percent : null);
    expect(pct(chipView(u, at))).toBe(53);
    expect(pct(chipView(u, at + 2 * 60_000))).toBe(19.6);
  });
});

describe("a tab's badge is the same reading as the cell and the headline", () => {
  // A spend-only provider used to fall into the "none" shape on the sheet's
  // own tab: a dash over an empty track, while the cell on the bar and the
  // headline above it both said $7.07 — one provider, two answers, in one
  // dialog.
  const spend: ProviderUsage = {
    provider: "opencode", label: "OpenCode Go", available: true, windows: [],
    spend: { usd: 7.07, window: "30 days" }, source: "opencode stats",
  };

  test("a spend with no windows is the dollars, and no track to fill", () => {
    expect(tabBadge(chipView(spend))).toEqual({ text: "$7.07", percent: null, track: false });
  });

  test("a reading is its percent over a track", () => {
    expect(tabBadge(chipView(opencode))).toEqual({ text: "4%", percent: 4, track: true });
  });

  test("no reading is a dash, not a zero", () => {
    expect(tabBadge(chipView(signedOut))).toEqual({ text: "—", percent: null, track: true });
  });
});

describe("the strip draws nothing numeric for a chip with no reading", () => {
  test("the number is inside the reading branch only", () => {
    const chip = topbar.slice(topbar.indexOf("function PlanChip"), topbar.indexOf("export function TopBar"));
    const none = chip.slice(chip.indexOf('{view.kind === "reading" ? ('), chip.indexOf("</button>"));
    expect(none).toContain("view.percent");
    // The other branch's NUMBER is a dash (or the dollars of a spend reading);
    // the only percent it may draw is the track, which is drawn from the
    // reading branch alone.
    const at = none.indexOf(") : (");
    const fallback = none.slice(at, none.indexOf("</b>", at));
    expect(fallback).toContain("—");
    expect(fallback).not.toContain("percent");
    expect(none.slice(none.indexOf("</b>", at))).toContain('view.kind === "reading" &&');
  });
});
