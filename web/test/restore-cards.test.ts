import { describe, expect, test } from "bun:test";
import type { TmuxWindow } from "../../shared/types.ts";
import { ageText, paneCard, restoredBanner } from "../src/lib/restoreCards.ts";

const w = (id: string, over: Partial<TmuxWindow> = {}): TmuxWindow => ({ id, index: 1, name: "AI01", active: false, flags: "", ...over });

describe("the banner", () => {
  test("none unless a window was restored", () => {
    expect(restoredBanner([w("@1"), w("@2")])).toBeNull();
  });
  test("counts the windows and the agents, and says none is running", () => {
    const b = restoredBanner([
      w("@1", { restored: true, restoredAt: 5, was: "Claude Code" }),
      w("@2", { restored: true, restoredAt: 5, was: "Claude Code" }),
      w("@3", { restored: true, restoredAt: 5 }),
    ])!;
    expect(b.text).toBe("Back after the reboot. 3 windows restored with their scrollback. 2 were running an agent; none of them is running now.");
    expect(b.resumeLabel).toBe("Resume the 2 agents");
    expect(b.stamp).toBe(5);
  });
  test("singular wording, and no action when no agent was running", () => {
    expect(restoredBanner([w("@1", { restored: true, was: "Claude Code" })])!.text).toContain("1 window restored");
    expect(restoredBanner([w("@1", { restored: true, was: "Claude Code" })])!.resumeLabel).toBe("Resume the agent");
    const plain = restoredBanner([w("@1", { restored: true })])!;
    expect(plain.resumeLabel).toBeNull();
    expect(plain.text).not.toContain("agent");
  });
});

describe("age", () => {
  test("the coarsest unit that is not zero", () => {
    expect(ageText(10_000)).toBe("a few seconds");
    expect(ageText(3 * 60_000)).toBe("3 min");
    expect(ageText(2 * 3_600_000)).toBe("2 h");
    expect(ageText(3 * 86_400_000)).toBe("3 d");
  });
});

describe("the card over the window in front", () => {
  const now = 1_700_000_300_000;
  test("a restored agent window offers Resume and a plain shell, and says which session", () => {
    const c = paneCard(w("@1", { restored: true, was: "Claude Code", resume: "0123456789abcdef" }), "orbit-fix", now)!;
    expect(c.kind).toBe("resume");
    expect(c.title).toBe("AI01 was running Claude Code before the reboot");
    expect(c.body).toBe("The scrollback came back, the process did not. Resume continues session 01234567 in orbit-fix.");
    expect([c.primary, c.secondary]).toEqual(["Resume session", "Plain shell instead"]);
  });
  test("a restored shell has no card", () => {
    expect(paneCard(w("@1", { restored: true }), null, now)).toBeNull();
    expect(paneCard(w("@1"), null, now)).toBeNull();
  });
  test("a dead pane says how it ended, how long ago, and where Restart opens", () => {
    const c = paneCard(w("@1", { dead: true, exit: 2, diedAt: now - 4 * 60_000 }), "orbit", now)!;
    expect(c).toMatchObject({ kind: "dead", title: "This process exited with status 2", primary: "Restart here", secondary: "Close window" });
    expect(c.body).toBe("AI01 stopped 4 min ago. The text above is what it left. Restart opens a fresh shell in orbit.");
  });
  test("a dead pane wins over a stale restored mark", () => {
    expect(paneCard(w("@1", { dead: true, restored: true, was: "Claude Code" }), null, now)!.kind).toBe("dead");
  });
});
