import { describe, expect, test } from "bun:test";
import {
  activityReducer, actionOf, agentAskRefusal, agentState, boxState, bubbleOf, bubblePlace, boxesMeet, dockPlace, GUIDE_CLEAR, guideRectIn, glassBlocks, guideCard, tabState, typingMs,
  type Activity, type GuideEvent,
} from "../src/lib/browserAgentActivity.ts";

const T = "t1";
const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
const run = (...evs: Parameters<typeof activityReducer>[1][]) => evs.reduce<Activity>((s, e) => activityReducer(s, e), {});
const rect = { x: 40, y: 100, w: 120, h: 30 };

describe("guide events fold into the tab", () => {
  test("start, point, a move and a click make one step the person clicked", () => {
    const s = run(
      { type: "begin", tab: T, agent: "orbit", op: "guide" },
      g({ phase: "start", say: "Rotate the API key", at: 1 }),
      g({ phase: "point", step: { n: 1, m: 2 }, say: "Press Rotate key", waitClick: true, target: { rect }, at: 2 }),
      g({ phase: "point", target: { rect: { ...rect, y: 160 } }, at: 3 }),
      g({ phase: "wait", clicked: true, at: 4 }),
    );
    const st = s[T]!.guide!;
    expect(st.on).toBe(true);
    expect(st.why).toBe("Rotate the API key");
    expect(st.steps).toHaveLength(1);
    expect(st.steps[0]).toMatchObject({ n: 1, m: 2, waitClick: true, rect: { y: 160 }, clicked: true, did: "click", didAt: 4 });
  });
  test("a new say is a new step; a null target marks it lost", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "One", target: { rect } }), g({ phase: "point", say: "Two", target: null }));
    expect(s[T]!.guide!.steps.map((x) => [x.n, x.lost ?? false])).toEqual([[1, false], [2, true]]);
  });
  test("navigated is recorded on the step", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Open it", waitClick: true, target: { rect } }), g({ phase: "wait", navigated: { url: "https://acme.test/keys" } }));
    expect(s[T]!.guide!.steps[0]).toMatchObject({ navigated: "https://acme.test/keys", did: "navigated" });
  });
  test("end keeps the card until close; Stop ends at once", () => {
    let s = run(g({ phase: "start" }), g({ phase: "point", say: "One", target: { rect } }), { type: "guideAnswer", tab: T, answer: "ok", at: 5 }, g({ phase: "end" }));
    expect(s[T]!.guide).toMatchObject({ on: false });
    expect(s[T]!.guide!.steps[0]!.did).toBe("ok");
    s = activityReducer(s, { type: "guideAnswer", tab: T, answer: "close", at: 6 });
    expect(s[T]!.guide).toBeUndefined();
    const stop = run(g({ phase: "start" }), g({ phase: "point", say: "One", target: { rect } }), { type: "guideAnswer", tab: T, answer: "stop", at: 7 });
    expect(stop[T]!.guide).toMatchObject({ on: false, endedAt: 7 });
  });
  test("an ask's begin and end keep the guide", () => {
    const s = run(g({ phase: "start" }), { type: "begin", tab: T, agent: "orbit", op: "observe" }, { type: "end", tab: T, action: null }, { type: "done", tab: T });
    expect(s[T]!.guide!.on).toBe(true);
  });
});

describe("one state for pill, overview and dock", () => {
  const on = run({ type: "begin", tab: T, agent: "orbit", op: "point" }, g({ phase: "start" }))[T]!;
  test("guiding first, never Reading, whatever the op", () => {
    expect(tabState(on, undefined, Date.now())).toEqual({ key: "guiding", word: "Guiding" });
    expect(agentState({ ...on, op: "observe" }).word).toBe("Guiding");
    expect(tabState({ ...on, working: 0, done: true }, undefined, Date.now())!.key).toBe("guiding");
  });
  test("after the end, the normal state again", () => {
    const off = activityReducer({ [T]: on }, g({ phase: "end" }))[T]!;
    expect(tabState({ ...off, working: 0, done: true }, undefined, Date.now())!.key).toBe("done");
  });
  test("a guided tab speaks for its box", () => {
    expect(boxState([{ key: "clicking", word: "Clicking" }, { key: "guiding", word: "Guiding" }])!.key).toBe("guiding");
  });
  test("Take over still wins", () => {
    expect(tabState({ ...on, paused: true }, undefined, Date.now())!.key).toBe("yours");
  });
});

describe("the lock on the panel side", () => {
  const on = run({ type: "begin", tab: T, agent: "orbit" }, g({ phase: "start" }))[T]!;
  test("glass is down while guiding, even mid-act", () => {
    expect(glassBlocks({ held: true, acting: true, paused: false, guiding: true })).toBe(false);
  });
  test("every act is refused, reads pass", () => {
    for (const op of ["click", "fill", "type", "press", "select", "check", "upload", "drag", "back", "forward", "reload"]) {
      expect(agentAskRefusal(on, { op, args: {} })).toMatch(/guide mode/);
    }
    expect(agentAskRefusal(on, { op: "observe", args: {} })).toBeNull();
    expect(agentAskRefusal(on, { op: "point", args: {} })).toBeNull();
  });
  test("a refused act leaves no row in the person's log", () => {
    expect(actionOf({ op: "click", args: { selector: "#rotate", refused: "guide" } }, false, 1)).toBeNull();
  });
});

describe("bubblePlace", () => {
  const pane = { w: 520, h: 600, dockTop: 530 };
  test("below the target when it fits", () => {
    const p = bubblePlace(rect, pane, { h: 40 });
    expect(p).toMatchObject({ side: "below", top: 140, scroll: false, width: 300, left: 8 });
    expect(p.tailX).toBe(92);
  });
  test("above when below is short", () => {
    const p = bubblePlace({ ...rect, y: 450 }, pane, { h: 60 });
    expect(p.side).toBe("above");
    expect(p.top + 60 + 52).toBe(440);
  });
  test("too tall for both: the bigger side, text scrolls, buttons stay, never under the dock", () => {
    const p = bubblePlace({ ...rect, y: 200 }, pane, { h: 900 });
    expect(p.scroll).toBe(true);
    expect(p.side).toBe("below");
    expect(p.top + p.maxText + 52).toBeLessThanOrEqual(pane.dockTop - 8);
  });
  test("narrow pane: the bubble fits inside it", () => {
    const p = bubblePlace({ x: 300, y: 80, w: 50, h: 20 }, { w: 360, h: 640 }, { h: 120 });
    expect(p.width).toBe(300);
    expect(p.left + p.width).toBeLessThanOrEqual(352);
    expect(p.tailX).toBeGreaterThanOrEqual(14);
    expect(p.tailX).toBeLessThanOrEqual(p.width - 14);
  });
});

describe("nothing of ours covers the ring", () => {
  /* Panes for windows 1440x900, 1100x760 and 820x620 (the browser pane is a bit smaller than the window). */
  const panes = [{ w: 1180, h: 820 }, { w: 860, h: 680 }, { w: 600, h: 540 }];
  const zooms = [0.67, 1, 1.5];
  const dock = { w: 260, h: 52 };
  /* A checkbox row (page px) near each edge, each corner and the centre. */
  const spots = (vw: number, vh: number) => {
    const w = 180, h = 28, m = 6;
    const xs = [m, (vw - w) / 2, vw - w - m], ys = [m, (vh - h) / 2, vh - h - m];
    return xs.flatMap((x) => ys.map((y) => ({ x, y, w, h, vw, vh })));
  };
  for (const pane of panes) for (const z of zooms) {
    test(`pane ${pane.w}x${pane.h} at zoom ${z}: dock and bubble stay off the ring`, () => {
      const vw = pane.w / z, vh = pane.h / z;
      for (const page of spots(vw, vh)) {
        const ring = guideRectIn(page, pane.w);
        const d = dockPlace(ring, pane, dock);
        const where = `ring ${JSON.stringify(ring)}`;
        expect(d.through, where).toBe(false);
        const db = { x: d.left, y: d.top, ...dock };
        expect(boxesMeet(ring, db, GUIDE_CLEAR), where).toBe(false);
        expect(d.left >= 0 && d.top >= 0 && d.left + dock.w <= pane.w && d.top + dock.h <= pane.h, where).toBe(true);
        for (const th of [60, 180]) {
          const b = bubblePlace(ring, { ...pane, dock: db }, { h: th });
          const bb = { x: b.left, y: b.top, w: b.width, h: Math.min(th, b.maxText) + 52 };
          expect(b.through, where).toBe(false);
          expect(boxesMeet(ring, bb, 2), where).toBe(false);
          expect(boxesMeet(db, bb), where).toBe(false);
          expect(bb.x >= 0 && bb.y >= 0 && bb.x + bb.w <= pane.w && bb.y + bb.h <= pane.h, where).toBe(true);
        }
      }
    });
  }
  test("the dock keeps its bottom-centre place when the ring is elsewhere", () => {
    expect(dockPlace({ x: 40, y: 40, w: 100, h: 20 }, { w: 600, h: 540 }, dock)).toEqual({ left: 170, top: 472, through: false });
    expect(dockPlace(null, { w: 600, h: 540 }, dock).through).toBe(false);
  });
  test("a target that fills the pane: nothing fits, so clicks pass through", () => {
    const big = { x: 0, y: 0, w: 600, h: 540 };
    expect(dockPlace(big, { w: 600, h: 540 }, dock).through).toBe(true);
    expect(bubblePlace(big, { w: 600, h: 540 }, { h: 60 }).through).toBe(true);
  });
  test("clicks pass through, but the bubble's and the dock's buttons still answer", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toContain(".agx-presence-bubble.is-through { pointer-events: none; }");
    expect(css).toContain(".agx-presence-bubble.is-through .agx-bubble-foot button { pointer-events: auto; }");
    expect(css).toContain(".agx-presence-dock.is-through { pointer-events: none; }");
    expect(css).toContain(".agx-presence-dock.is-through button { pointer-events: auto; }");
  });
  /* The island's collapsed pill: 104x30 at the top centre, 12 px down (index.css .agx-isl-compact). */
  const pillIn = (pane: { w: number }) => ({ x: 12 + (pane.w - 24) / 2 - 52, y: 12, w: 104, h: 30 });
  test("the dock moved to the top keeps off the island's pill too", () => {
    for (const pane of panes) {
      const pill = pillIn(pane);
      /* A ring at the bottom centre sends the dock to the top. */
      const ring = { x: pane.w / 2 - 90, y: pane.h - 60, w: 180, h: 28 };
      expect(dockPlace(ring, pane, dock).top).toBe(16);
      const d = dockPlace(ring, pane, dock, [pill]);
      const db = { x: d.left, y: d.top, ...dock };
      expect(d.through).toBe(false);
      expect(boxesMeet(pill, db, GUIDE_CLEAR), JSON.stringify(pane)).toBe(false);
      expect(boxesMeet(ring, db, GUIDE_CLEAR), JSON.stringify(pane)).toBe(false);
    }
  });
  test("with the pill, every spot still has a place off the ring and the pill", () => {
    for (const pane of panes) for (const z of zooms) {
      const pill = pillIn(pane), vw = pane.w / z, vh = pane.h / z;
      for (const page of spots(vw, vh)) {
        const ring = guideRectIn(page, pane.w);
        const d = dockPlace(ring, pane, dock, [pill]);
        const db = { x: d.left, y: d.top, ...dock }, where = `pane ${pane.w} zoom ${z} ring ${JSON.stringify(ring)}`;
        expect(d.through, where).toBe(false);
        expect(boxesMeet(ring, db, GUIDE_CLEAR), where).toBe(false);
        expect(boxesMeet(pill, db, GUIDE_CLEAR), where).toBe(false);
      }
    }
  });
  test("an overlay that leaves no free place does not cost the ring: the dock still keeps off it", () => {
    const pane = { w: 600, h: 540 }, ring = { x: 40, y: 40, w: 100, h: 20 };
    const d = dockPlace(ring, pane, dock, [{ x: 0, y: 0, w: 600, h: 540 }]);
    expect(d.through).toBe(false);
    expect(boxesMeet(ring, { x: d.left, y: d.top, ...dock }, GUIDE_CLEAR)).toBe(false);
  });
  test("a tall target with no room above or below: the bubble goes beside it", () => {
    const p = bubblePlace({ x: 20, y: 20, w: 200, h: 480 }, { w: 860, h: 540 }, { h: 60 });
    expect(p.side).toBe("right");
    expect(p.left).toBeGreaterThanOrEqual(230);
    expect(p.through).toBe(false);
  });
});

describe("the bubble's words and buttons", () => {
  const base = { n: 1, say: "Press Rotate key", waitClick: false, at: 0 };
  test("Back hidden on step 1, shown after", () => {
    expect(bubbleOf(base, true).buttons).toEqual(["stop", "ok"]);
    expect(bubbleOf({ ...base, n: 2 }, false).buttons).toEqual(["back", "stop", "ok"]);
  });
  test("wait-click: no OK, the bubble says the click moves it on", () => {
    const b = bubbleOf({ ...base, waitClick: true }, true);
    expect(b.buttons).not.toContain("ok");
    expect(b.note).toBe("Click the highlighted spot to continue");
    expect(b.waiting).toBe(true);
    /* Step 1 has no Back, so nothing to confirm. */
    expect(b.confirmBack).toBeUndefined();
  });
  test("wait-click: Back asks before leaving; an OK step's Back does not", () => {
    expect(bubbleOf({ ...base, n: 2, waitClick: true }, false).confirmBack).toBe(true);
    expect(bubbleOf({ ...base, n: 2, waitClick: true }, false, "down").confirmBack).toBe(true);
    expect(bubbleOf({ ...base, n: 2 }, false).confirmBack).toBeUndefined();
  });
  test("after the click: the step's words stay, Got it is the small state line, until the next point", () => {
    const b = bubbleOf({ ...base, n: 2, waitClick: true, clicked: true }, false);
    expect(b.text).toBe(base.say);
    expect(b.note).toBe("Got it");
    expect(b.waiting).toBe(false);
    expect(b.buttons).toEqual(["stop"]);
  });
  test("fallback text per step kind", () => {
    expect(bubbleOf({ ...base, lost: true }, true).note).toBe("Can't follow this element. Press OK when done.");
    const w = bubbleOf({ ...base, lost: true, waitClick: true }, true);
    expect(w.note).toBe("Can't follow this element. Click it, then press Done.");
    expect(w.buttons).toContain("done");
    expect(bubbleOf({ ...base, navigated: "https://acme.test" }, true).note).toBe("The page changed");
  });
  test("step label only when given", () => {
    expect(bubbleOf(base, true).label).toBeUndefined();
    expect(bubbleOf({ ...base, m: 4 }, true).label).toBe("Step 1 of 4");
  });
  test("typing: at most 600 ms, none when calm", () => {
    expect(typingMs(2000, false)).toBe(600);
    expect(typingMs(20, false)).toBe(240);
    expect(typingMs(2000, true)).toBe(0);
  });
});

describe("the person's audit card", () => {
  test("only their steps, what they did, Done · N steps", () => {
    const s = run(g({ phase: "start", say: "Rotate the key" }), g({ phase: "point", say: "Open keys", target: { rect } }),
      { type: "guideAnswer", tab: T, answer: "ok", at: new Date(2026, 0, 1, 9, 5, 7).getTime() },
      g({ phase: "point", say: "Press Rotate", waitClick: true, target: { rect } }), g({ phase: "wait", clicked: true }), g({ phase: "end" }));
    const c = guideCard(s[T]!.guide!);
    expect(c.title).toBe("Done \u00b7 2 steps");
    expect(c.done).toBe(true);
    expect(c.why).toBe("Rotate the key");
    expect(c.rows.map((r) => r.did)).toEqual(["You pressed OK", "You clicked it"]);
    expect(c.rows[0]!.at).toBe("09:05:07");
    expect(JSON.stringify(c)).not.toMatch(/refus/i);
  });
});

describe("the bus between the drive and the panel", () => {
  test("events reach the panel and answers reach the drive, then stop on unsubscribe", async () => {
    const bus = await import("../src/lib/browserGuideBus.ts");
    const seen: string[] = [];
    const off1 = bus.onGuideEvent((e) => seen.push("ev:" + e.phase));
    const off2 = bus.onGuideAnswer((a) => seen.push(`ans:${a.tab}:${a.answer}`));
    bus.emitGuideEvent({ kind: "guide", tab: T, phase: "start" });
    bus.answerGuide(T, "ok");
    off1(); off2();
    bus.emitGuideEvent({ kind: "guide", tab: T, phase: "end" });
    expect(seen).toEqual(["ev:start", "ans:t1:ok"]);
  });
});
