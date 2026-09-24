/*
 * vitals and a11y run in the page, so they are exercised against a stand-in:
 * a PerformanceObserver that replays entries, and a hand-made document. What
 * they are held to is the arithmetic (CLS by session window, INP by
 * interaction) and what they leave out.
 */
import { describe, expect, test } from "bun:test";
import { A11Y_SCRIPT, VITALS_SCRIPT, rate } from "../src/lib/browserVitals.ts";

function vitalsPage(entries: Record<string, any[]>, nav: any = { responseStart: 120.4 }) {
  class PO {
    got: any[] = [];
    constructor(private cb: (l: { getEntries(): any[] }) => void) {}
    observe(o: { type: string }) { this.got = entries[o.type] ?? []; }
    takeRecords() { return this.got; }
    disconnect() {}
  }
  const g: any = {
    PerformanceObserver: PO,
    performance: { getEntriesByType: () => [nav] },
    location: { href: "http://localhost/" }, document: { title: "Orbit" },
    setTimeout, Promise, Math, Object, Number,
  };
  return new Function(...Object.keys(g), `return ${VITALS_SCRIPT}`)(...Object.values(g)) as Promise<any>;
}

describe("vitals script", () => {
  test("CLS is the worst session window, not the sum of the day", async () => {
    const r = await vitalsPage({ "layout-shift": [
      { startTime: 100, value: 0.05 }, { startTime: 600, value: 0.04 },   // one window: 0.09
      { startTime: 9000, value: 0.02 },                                    // a later, smaller one
      { startTime: 9100, value: 0.5, hadRecentInput: true },               // a shift the person caused
    ] });
    expect(r.vitals.cls).toBe(0.09);
  });

  test("INP is the slowest interaction, by interactionId", async () => {
    const r = await vitalsPage({ event: [
      { interactionId: 1, duration: 40 }, { interactionId: 1, duration: 96 },
      { interactionId: 2, duration: 180 }, { interactionId: 0, duration: 900 },
    ] });
    expect(r.vitals.inpMs).toBe(180);
  });

  test("LCP is the last candidate; TTFB and FCP come from navigation and paint", async () => {
    const r = await vitalsPage({
      "largest-contentful-paint": [{ startTime: 800 }, { startTime: 1900.6 }],
      paint: [{ name: "first-paint", startTime: 300 }, { name: "first-contentful-paint", startTime: 420 }],
    });
    expect(r.vitals).toMatchObject({ lcpMs: 1901, fcpMs: 420, ttfbMs: 120 });
  });

  test("what the page never produced is absent, not zero", async () => {
    const r = await vitalsPage({}, {});
    expect(r.vitals).toEqual({ cls: 0 });
  });

  test("ratings follow web.dev's thresholds at the edges", () => {
    expect(rate("lcpMs", 2500)).toBe("good");
    expect(rate("lcpMs", 2501)).toBe("needs-improvement");
    expect(rate("lcpMs", 4001)).toBe("poor");
    expect(rate("cls", 0.1)).toBe("good");
    expect(rate("inpMs", 501)).toBe("poor");
  });
});

function el(tag: string, o: { attrs?: Record<string, string>; text?: string; type?: string; hidden?: boolean } = {}) {
  const attrs = o.attrs ?? {};
  return {
    tagName: tag.toUpperCase(), type: o.type, value: "", dataset: {} as Record<string, string>,
    textContent: o.text ?? "", innerText: o.text ?? "", id: "",
    getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs,
    getBoundingClientRect: () => (o.hidden ? { width: 0, height: 0 } : { width: 40, height: 20, x: 0, y: 0 }),
    labels: [] as unknown[], placeholder: "", title: "",
    cs: { display: o.hidden ? "none" : "block", visibility: "visible" },
  };
}

function a11yPage(items: Record<string, any[]>, root: Record<string, string> = { lang: "en" }, title = "Orbit") {
  const g: any = {
    location: { href: "http://localhost/" },
    getComputedStyle: (e: any) => e.cs,
    WeakSet, Math, Number, String, Object, Array, window: {},
    document: {
      title,
      documentElement: { getAttribute: (k: string) => root[k] ?? null },
      querySelectorAll: (sel: string) => (Object.entries(items).find(([k]) => sel.includes(k))?.[1] ?? []),
    },
  };
  return new Function(...Object.keys(g), `return ${A11Y_SCRIPT}`)(...Object.values(g)) as any;
}

describe("a11y script", () => {
  test("images without alt are reported with ids, an empty alt is fine", () => {
    const bad = el("img"), decor = el("img", { attrs: { alt: "" } });
    const r = a11yPage({ img: [bad, decor] });
    expect(r.problems.imgNoAlt.n).toBe(1);
    expect(r.problems.imgNoAlt.samples[0]).toMatch(/^e\d+ img$/);
    expect(r.verdict).toBe("1 kinds of problem");
  });

  test("a heading that jumps two levels is a skip; going back up is not", () => {
    const hs = [el("h1"), el("h3"), el("h2"), el("h4")];
    const r = a11yPage({ "h1,h2": hs });
    expect(r.problems.headingSkips.n).toBe(2);
  });

  test("a hidden heading does not count, and a missing lang and title are said", () => {
    const r = a11yPage({ "h1,h2": [el("h1"), el("h3", { hidden: true })] }, {}, "");
    expect(r.problems.headingSkips).toBeUndefined();
    expect(r.problems.noLang).toBe(true);
    expect(r.problems.noTitle).toBe(true);
  });

  test("a clean page says ok", () => {
    const r = a11yPage({});
    expect(r.verdict).toBe("ok");
    expect(r.problems).toEqual({});
  });
});
