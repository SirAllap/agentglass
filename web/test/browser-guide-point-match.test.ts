/*
 * `point` resolves its selector before any card goes up: nothing matched is a
 * refusal and no card, one match is a card, several ring the first visible
 * one and the answer says how many. The page is a fake that answers the
 * match script with what a real page would.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { runGuide, setGuideShell, type DrivableWebview } from "../src/lib/browserDrive.ts";
import { onGuideEvent, resetGuideBus } from "../src/lib/browserGuideBus.ts";
import type { GuideEvent } from "../src/lib/browserAgentActivity.ts";
import type { BrowserAskFrame } from "../../shared/types.ts";

const T = "t1";
const ask = (args: Record<string, unknown>) => ({ id: "a", op: "point", args: { page: T, ...args,
  activity: { kind: "guide", tab: T, phase: "wait", say: String(args.say), waitClick: true } } }) as unknown as BrowserAskFrame;

/** A guest whose match script answers `match`; every script it was given is kept. */
function page(match: { total: number; tagged?: boolean; url?: string; seen?: boolean }) {
  const scripts: string[] = [];
  const el = {
    getWebContentsId: () => 7,
    executeJavaScript: async (src: string) => { scripts.push(src); return { url: "https://shop.example/cart", ...match }; },
  } as unknown as DrivableWebview;
  return { el, scripts };
}

function fakeShell() {
  const calls: Record<string, unknown>[] = [];
  setGuideShell({ observe: async (req) => { calls.push(req); return { ok: true, found: true }; }, onObserved: () => () => {} });
  return calls;
}

function cards() {
  const seen: GuideEvent[] = [];
  const off = onGuideEvent((e) => seen.push(e));
  return { seen, off };
}

afterEach(() => { setGuideShell(null); resetGuideBus(); });

describe("point on a selector", () => {
  test("that matches nothing is refused with the url, and no card goes up", async () => {
    const calls = fakeShell();
    const c = cards();
    const { el } = page({ total: 0 });
    const r = await runGuide(el, ask({ selector: "#nope", say: "Click the highlighted spot", waitClick: true }));
    c.off();
    expect(r).toEqual({ ok: false, error: "no match for #nope on https://shop.example/cart: observe again and point at an id from it" });
    expect(c.seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("on a page that cannot be read is refused, and no card goes up", async () => {
    const calls = fakeShell();
    const c = cards();
    const el = { getWebContentsId: () => 7, executeJavaScript: async () => { throw new Error("navigating"); } } as unknown as DrivableWebview;
    const r = await runGuide(el, ask({ selector: "#pay", say: "Press Pay", waitClick: true }));
    c.off();
    expect(r).toEqual({ ok: false, error: "point: the page could not be read: observe again" });
    expect(c.seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("on a page unreadable at first is looked at once more before it is refused", async () => {
    fakeShell();
    let n = 0;
    const el = { getWebContentsId: () => 7, executeJavaScript: async () => { n++; if (n === 1) throw new Error("loading"); return { url: "https://shop.example/cart", total: 1 }; } } as unknown as DrivableWebview;
    const r = await runGuide(el, ask({ selector: "#pay", say: "Press Pay", waitClick: true }));
    expect(n).toBe(2);
    expect(r.ok).toBe(true);
  });

  test("the match script counts a node whose on-screen check throws as seen only while it is connected", async () => {
    fakeShell();
    const { el, scripts } = page({ total: 1 });
    await runGuide(el, ask({ selector: "#pay", say: "Press Pay", waitClick: true }));
    // Run the page's own seen0 line against fake nodes, with an onScreen that throws.
    const line = scripts.join("\n").split("\n").find((l) => l.includes("const seen0 = "))!;
    expect(line).toBeTruthy();
    const build = (onScreen: () => boolean) => new Function("onScreen", `${line}; return seen0;`)(onScreen) as (n: unknown) => boolean;
    const throws = build(() => { throw new Error("cross-frame"); });
    expect(throws({ isConnected: true })).toBe(true);
    expect(throws({ isConnected: false })).toBe(false);
    expect(build(() => true)({ isConnected: false })).toBe(true);
  });

  test("that matched but is not on screen is refused, and no card goes up", async () => {
    const calls = fakeShell();
    const c = cards();
    const { el } = page({ total: 1, seen: false });
    const r = await runGuide(el, ask({ selector: "#pay", say: "Press Pay", waitClick: true }));
    c.off();
    expect(r).toEqual({ ok: false, error: "point: #pay matched but is not on screen (scrolled out or hidden): observe again" });
    expect(c.seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("that matches one node shows the card and rings it by its own selector", async () => {
    const calls = fakeShell();
    const c = cards();
    const { el } = page({ total: 1 });
    const r = await runGuide(el, ask({ selector: "#pay", say: "Press Pay", waitClick: true }));
    c.off();
    expect(r).toEqual({ ok: true, value: { followed: true } });
    expect(c.seen.map((e) => e.say)).toEqual(["Press Pay"]);
    expect(calls[0]).toMatchObject({ selector: "#pay" });
  });

  test("that matches two rings the first visible one and says how many matched", async () => {
    const calls = fakeShell();
    const c = cards();
    const { el, scripts } = page({ total: 2, tagged: true });
    const r = await runGuide(el, ask({ selector: "button.buy", say: "Press Buy", waitClick: true }));
    c.off();
    expect(r).toEqual({ ok: true, value: { followed: true, matched: 2 } });
    expect(c.seen).toHaveLength(1);
    /* The tag the page script set is the one the observer looks for. */
    const tag = /setAttribute\("data-agx-guide", "(g\d+)"\)/.exec(scripts[0]!)?.[1];
    expect(tag).toBeDefined();
    expect(calls[0]!.selector).toBe(`[data-agx-guide="${tag}"]`);
    expect(scripts[0]).toContain("nodes.find(onScreen)");
  });
});
