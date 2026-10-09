/*
 * The pull request views ask GitHub nothing while the window is not the one
 * being looked at, and only ask past the server's copy when told to.
 *
 * Measured on an isolated server with a stub gh: with the window unfocused the
 * board still polled its list (1.5 requests a minute), a five-minute cycle of
 * "how far behind" comparisons fired one spawn per card, the open pull
 * request's local-head (every 8 s) and behind (every 30 s) ticks went on, and
 * the inbox kept its own 60 s interval under a pull request that covered it.
 * All of it returned the answer it had returned before.
 */
import { beforeEach, describe, expect, it } from "bun:test";

const calls: { number: number; force: boolean }[] = [];
const mod = await import("../src/lib/api.ts");
(mod.api as unknown as { prBehind: unknown }).prBehind = (_root: string, number: number, force = false) => {
  calls.push({ number, force });
  return Promise.resolve({ ok: true, behind: number });
};
const { behindOf, forgetBehind, refreshBehind } = await import("../src/lib/prBehindStore.ts");

const settle = () => new Promise((r) => setTimeout(r, 30));
const setWindow = (looking: boolean) => {
  (globalThis as any).document = { hidden: !looking, visibilityState: looking ? "visible" : "hidden", hasFocus: () => looking };
};
const later = (ms: number) => { const real = Date.now; Date.now = () => real() + ms; return () => { Date.now = real; }; };
const src = (rel: string) => Bun.file(new URL(`../src/${rel}`, import.meta.url)).text();

describe("the behind store", () => {
  beforeEach(() => { calls.length = 0; forgetBehind(); setWindow(true); });

  it("does not re-ask an aged answer while nobody is looking, and does when they return", async () => {
    behindOf("/repo", 7);
    await settle();
    expect(calls.length).toBe(1);
    const back = later(6 * 60_000);
    try {
      setWindow(false);
      behindOf("/repo", 7); behindOf("/repo", 7);
      await settle();
      expect(calls.length).toBe(1);
      setWindow(true);
      behindOf("/repo", 7);
      await settle();
      expect(calls.length).toBe(2);
    } finally { back(); }
  });

  it("a first look is always allowed, focused or not", async () => {
    setWindow(false);
    behindOf("/repo", 9);
    await settle();
    expect(calls.length).toBe(1);
  });

  it("an explicit refresh reaches past the server's copy; the panel's tick does not", async () => {
    refreshBehind("/repo", 4);
    await settle();
    refreshBehind("/repo", 5, false);
    await settle();
    expect(calls).toEqual([{ number: 4, force: true }, { number: 5, force: false }]);
  });
});

describe("the panel's own timers", () => {
  it("the Inbox polls through usePoll, and is inactive under an open pull request", async () => {
    const inbox = await src("components/prs/Inbox.tsx");
    expect(inbox).toContain("usePoll(active");
    expect(inbox).not.toContain("setInterval(");
    const panel = await src("components/PrPanel.tsx");
    expect(panel).toContain("active={active && selected == null}");
  });

  it("the open pull request's local and behind ticks check that the window is looked at", async () => {
    const panel = await src("components/PrPanel.tsx");
    expect(panel).toContain("setInterval(() => { if (looking()) again(); }, 30_000)");
    expect(panel).toContain("setInterval(() => { if (looking()) read(); }, 8_000)");
  });

  it("the board's list poll waits for focus as well as visibility, and returns on focus", async () => {
    const panel = await src("components/PrPanel.tsx");
    expect(panel).toContain('document.visibilityState === "hidden" || !document.hasFocus()');
    expect(panel).toContain('window.addEventListener("focus", onBack)');
  });
});
