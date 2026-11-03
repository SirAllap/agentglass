/*
 * An agent's fixed viewport (`resize`, `emulate --width/--height`) was a
 * device-metrics override drawn from the guest's top-left and never taken
 * off: the person's tab showed the page small in a corner, the rest white,
 * long after the agent was done. These pin the three halves of the fix: the
 * drawing is fitted to the pane, the panel is told the box to letterbox, and
 * the override ends when the agent lets go.
 */
import { describe, expect, test } from "bun:test";
import {
  clearAgentViewport, fitViewport, forgetAgentZoom, onAgentViewport, runBrowserAsk, setShellZoom,
  type DrivableWebview, type ViewportBox,
} from "../src/lib/browserDrive.ts";
import { IDLE_RELEASE_MS, viewportReleased, type TabAgent } from "../src/lib/browserAgentActivity.ts";

/** A guest whose pane is 1250x656 CSS pixels at a window scale of 1.6, the
 *  shape measured on the real shell. Every script answers with that size. */
function guest() {
  const el = {
    getURL: () => "https://orbit.example/board",
    getTitle: () => "Board",
    isLoading: () => false,
    loadURL: async () => {},
    executeJavaScript: async () => JSON.stringify({ w: 1250, h: 656, dpr: 1.6 }),
  };
  return el as unknown as DrivableWebview;
}

function recorder() {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const cdp = async (method: string, params?: unknown) => {
    sent.push({ method, params: params as Record<string, unknown> | undefined });
    return { ok: true, result: {} };
  };
  return { sent, cdp };
}

function ask(op: string, args: Record<string, unknown>) {
  return { id: `t-${op}`, op, args } as Parameters<typeof runBrowserAsk>[1];
}

function listen() {
  const seen: Array<{ el: object; box: ViewportBox | null }> = [];
  const stop = onAgentViewport((el, box) => seen.push({ el, box }));
  return { seen, stop };
}

describe("an agent's viewport is fitted to the pane, never drawn in its corner", () => {
  test("a viewport larger than the pane is scaled down, aspect kept", () => {
    const { scale, box } = fitViewport({ w: 1250, h: 656 }, 1440, 790);
    expect(scale).toBeCloseTo(656 / 790, 5);
    expect(box.h).toBeCloseTo(1, 5);
    expect(box.w).toBeCloseTo((1440 * scale) / 1250, 5);
  });

  test("a smaller one is never enlarged, and sits in the middle of both axes", () => {
    const { scale, box } = fitViewport({ w: 1250, h: 656 }, 800, 450);
    expect(scale).toBe(1);
    expect(box.w).toBeCloseTo(800 / 1250, 5);
    expect(box.h).toBeCloseTo(450 / 656, 5);
  });

  test("resize lays the page out at the size asked, scaled to fit, and tells the panel the box", async () => {
    const el = guest();
    const { sent, cdp } = recorder();
    const { seen, stop } = listen();
    const r = await runBrowserAsk(el, ask("resize", { width: 1440, height: 790 }), undefined, undefined, undefined, cdp);
    stop();
    expect(r.ok).toBe(true);
    const set = sent.find((c) => c.method === "Emulation.setDeviceMetricsOverride")?.params;
    expect(set).not.toBeUndefined();
    /* Literal CSS pixels: multiplying by the window's scale laid 1440 out at 2304. */
    expect(set!.width).toBe(1440);
    expect(set!.height).toBe(790);
    expect(set!.deviceScaleFactor).toBe(1.6);
    expect(set!.scale as number).toBeCloseTo(656 / 790, 5);
    expect(seen.at(-1)?.el).toBe(el);
    expect(seen.at(-1)?.box?.h).toBeCloseTo(1, 5);
  });

  test("emulate with a size goes the same way, and keeps the dpr it was given", async () => {
    const el = guest();
    const { sent, cdp } = recorder();
    const { seen, stop } = listen();
    await runBrowserAsk(el, ask("emulate", { width: 390, height: 844, scale: 3, mobile: true }), undefined, undefined, undefined, cdp);
    const set = sent.find((c) => c.method === "Emulation.setDeviceMetricsOverride")?.params;
    expect(set!.deviceScaleFactor).toBe(3);
    expect(set!.scale as number).toBeCloseTo(656 / 844, 5);
    expect(seen.at(-1)?.box).not.toBeNull();
    /* `reset` hands the pane back, and the panel hears it. */
    await runBrowserAsk(el, ask("emulate", { reset: true }), undefined, undefined, undefined, cdp);
    stop();
    expect(seen.at(-1)?.box).toBeNull();
  });

  test("clearing gives the pane back once, and leaves a tab without one alone", async () => {
    const el = guest();
    const { sent, cdp } = recorder();
    await runBrowserAsk(el, ask("resize", { width: 1440, height: 790 }), undefined, undefined, undefined, cdp);
    const { seen, stop } = listen();
    sent.length = 0;
    await clearAgentViewport(el, cdp);
    expect(sent.map((c) => c.method)).toContain("Emulation.clearDeviceMetricsOverride");
    expect(seen).toEqual([{ el, box: null }]);
    sent.length = 0;
    await clearAgentViewport(el, cdp);
    await clearAgentViewport(guest(), cdp);
    stop();
    expect(sent, "a tab with no agent viewport (a zoom, say) is not touched").toEqual([]);
  });

  test("a resize without a usable size is refused before anything is sent", async () => {
    const { sent, cdp } = recorder();
    const r = await runBrowserAsk(guest(), ask("resize", { width: 0, height: 790 }), undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("the viewport ends when the agent lets go of the tab", () => {
  const now = 1_000_000_000;
  const agent = (over: Partial<TabAgent>): TabAgent => ({ agent: "orbit-bot", working: 0, paused: false, log: [], lastAt: now - 1000, ...over });

  test("done, Take over, a forgotten tab, and ten idle minutes each end it", () => {
    expect(viewportReleased(agent({ done: true }), now)).toBe(true);
    expect(viewportReleased(agent({ paused: true }), now)).toBe(true);
    expect(viewportReleased(undefined, now)).toBe(true);
    expect(viewportReleased(agent({ lastAt: now - IDLE_RELEASE_MS - 1 }), now)).toBe(true);
  });

  test("an agent still working, or between asks, keeps it", () => {
    expect(viewportReleased(agent({}), now)).toBe(false);
    expect(viewportReleased(agent({ working: 1, done: true }), now)).toBe(false);
  });
});

describe("zoom is the page zoom, not a viewport", () => {
  /** A shell whose page zoom starts at the pane's own 1.25. */
  function shell(start = 1.25) {
    let now = start;
    const calls: Array<number | undefined> = [];
    setShellZoom(async (factor) => {
      calls.push(factor);
      if (factor !== undefined) now = factor;
      return { ok: true, factor: now, percent: Math.round(now * 100) };
    });
    return { calls, now: () => now };
  }
  const tab = () => ({ ...guest(), getWebContentsId: () => 7 }) as unknown as DrivableWebview;

  test("leaves the device metrics alone and answers the factor asked, not stacked on the pane's", async () => {
    const sh = shell();
    const { sent, cdp } = recorder();
    const r = await runBrowserAsk(tab(), ask("zoom", { factor: 1.4 }), undefined, undefined, undefined, cdp);
    setShellZoom(null);
    expect(r.ok).toBe(true);
    expect(sent.filter((c) => c.method.startsWith("Emulation."))).toEqual([]);
    const v = r.value as Record<string, unknown>;
    expect(v.factor).toBe(1.4); // 1.4 x 1.25 = 1.75 was the old answer
    expect(v.was).toBe(1.25);
    expect(sh.now()).toBe(1.4);
  });

  test("done, Take over, idle and a forgotten tab all go through clearAgentViewport and give the pane its zoom back", async () => {
    const sh = shell();
    const el = tab();
    const { sent, cdp } = recorder();
    await runBrowserAsk(el, ask("zoom", { factor: 1.4 }), undefined, undefined, undefined, cdp);
    await runBrowserAsk(el, ask("zoom", { factor: 2 }), undefined, undefined, undefined, cdp);
    await clearAgentViewport(el, cdp);
    setShellZoom(null);
    expect(sh.now()).toBe(1.25); // the first read, not the intermediate 1.4
    expect(sent.some((c) => c.method === "Emulation.clearDeviceMetricsOverride")).toBe(true);
  });

  test("a zoom the person took back is not undone by the release", async () => {
    const sh = shell();
    const el = tab();
    const { cdp } = recorder();
    await runBrowserAsk(el, ask("zoom", { factor: 1.4 }), undefined, undefined, undefined, cdp);
    forgetAgentZoom(el);
    sh.calls.length = 0;
    await clearAgentViewport(el, cdp);
    setShellZoom(null);
    expect(sh.calls).toEqual([]);
  });

  test("0.8 widens the layout with no override, and 1 sets the page back", async () => {
    const sh = shell(1);
    const { sent, cdp } = recorder();
    const el = tab();
    const out = await runBrowserAsk(el, ask("zoom", { factor: 0.8 }), undefined, undefined, undefined, cdp);
    expect((out.value as Record<string, unknown>).factor).toBe(0.8);
    expect(sh.now()).toBe(0.8);
    const back = await runBrowserAsk(el, ask("zoom", { factor: 1 }), undefined, undefined, undefined, cdp);
    setShellZoom(null);
    expect((back.value as Record<string, unknown>).factor).toBe(1);
    expect(sh.now()).toBe(1);
    expect(sent.filter((c) => c.method.startsWith("Emulation.")), "nothing narrows the viewport, so the page fills the pane").toEqual([]);
  });

  test("without the desktop shell there is no zoom, not a device-metrics one", async () => {
    setShellZoom(null);
    const { sent, cdp } = recorder();
    const r = await runBrowserAsk(tab(), ask("zoom", { factor: 0.8 }), undefined, undefined, undefined, cdp);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("needs the desktop app");
    expect(sent).toEqual([]);
  });

  test("reading with no factor claims nothing", async () => {
    const sh = shell();
    const el = tab();
    const { cdp } = recorder();
    const r = await runBrowserAsk(el, ask("zoom", {}), undefined, undefined, undefined, cdp);
    await clearAgentViewport(el, cdp);
    setShellZoom(null);
    expect((r.value as Record<string, unknown>).factor).toBe(1.25);
    expect(sh.calls.every((f) => f === undefined)).toBe(true);
  });
});
