/*
 * Guide v2 phase 2 (mockup direction A): the guide lives in the top pill, the
 * bottom bar is gone, the step card leaves then arrives (never travels), it
 * sits on the side with the most room and folds to a dot while the person
 * types. Plus the record card keeps Resume while it is valid.
 *
 * No DOM here (bun test, no jsdom): the state machines are pure and tested as
 * such; the island renders to static markup; CSS and wiring are read as text.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activityReducer, auditAfterFade, auditLeft, auditWait, boxesMeet, bubblePlace, CARD_FLOW_INIT, CARD_WAIT_CAP_MS, cardDotted, cardFlow, cardMotion, cardReady,
  GUIDE_AUDIT_GRACE_MS, GUIDE_AUDIT_MS, GUIDE_PILL_END_MS, GUIDE_TYPING_IDLE_MS, guideCardKey, guideDotAt, guidePill, guideStepText,
  type Activity, type GuideEvent, type GuideStepUi, type TabAgent, type TabGuide,
} from "../src/lib/browserAgentActivity.ts";
import { BrowserIsland } from "../src/components/browser/BrowserIsland.tsx";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const presence = strip(await read("../src/components/browser/AgentPresence.tsx"));
const island = strip(await read("../src/components/browser/BrowserIsland.tsx"));
const panel = strip(await read("../src/components/BrowserPanel.tsx"));
const observer = strip(await read("../../electron/guide-observer.js"));
const css = await read("../src/index.css");
const rule = (sel: string) => { const i = css.indexOf(sel + " {"); return i < 0 ? "" : css.slice(i, css.indexOf("}", i) + 1); };

const step = (n: number, m?: number, extra: Partial<GuideStepUi> = {}): GuideStepUi => ({ n, ...(m ? { m } : {}), say: "Click Save", waitClick: true, at: n, ...extra });
const agent = (guide: TabGuide, name = "orbit-docs"): TabAgent => ({ agent: name, working: 0, paused: false, log: [], guide });

describe("the pill says the guide", () => {
  test("on: the step as n/m, or Step n with no total", () => {
    expect(guidePill(agent({ on: true, startedAt: 0, steps: [step(1, 5), step(3, 5)] }), 10)).toMatchObject({ kind: "on", step: "3/5", agent: "orbit-docs" });
    expect(guidePill(agent({ on: true, startedAt: 0, steps: [step(12, 14)] }), 10)!.step).toBe("12/14");
    expect(guidePill(agent({ on: true, startedAt: 0, steps: [step(3)] }), 10)!.step).toBe("Step 3");
    expect(guideStepText(3)).toBe("Step 3");
  });
  test("ended: done at the last step, stopped before it or on Stop, then Idle after 2.4 s", () => {
    const done = agent({ on: false, startedAt: 0, endedAt: 1000, steps: [step(5, 5, { did: "click" })] });
    expect(guidePill(done, 1000 + GUIDE_PILL_END_MS - 1)).toMatchObject({ kind: "done", step: "5/5" });
    expect(guidePill(done, 1000 + GUIDE_PILL_END_MS)).toBeNull();
    expect(guidePill(agent({ on: false, startedAt: 0, endedAt: 1000, steps: [step(3, 5)] }), 1100)).toMatchObject({ kind: "stopped", step: "3/5" });
    expect(guidePill(agent({ on: false, startedAt: 0, endedAt: 1000, steps: [step(5, 5, { did: "stop" })] }), 1100)!.kind).toBe("stopped");
    expect(GUIDE_PILL_END_MS).toBe(2400);
  });
  test("no guide: the pill is its usual self", () => {
    expect(guidePill({ agent: "a" }, 0)).toBeNull();
    expect(guidePill(undefined, 0)).toBeNull();
  });
});

describe("the island renders each guide state", () => {
  const noop = () => undefined;
  const html = (a: TabAgent, title = "Orbit Docs · Pricing", tabAgent?: string) => renderToStaticMarkup(React.createElement(BrowserIsland, {
    tabs: [{ id: "t1", url: "https://orbit.example/pricing", title, profile: "", ...(tabAgent ? { agent: tabAgent } : {}) } as never],
    activeId: "t1", acts: { t1: a }, spaceName: () => "Default", address: "", canBack: false, canForward: false, loading: false,
    onShow: noop, onClose: noop, onNew: noop, onAddress: noop, onBack: noop, onForward: noop, onReload: noop, onStop: noop, onMenu: noop,
    onToggle: noop, picture: async () => null, lastPicture: () => null, onTucked: noop, onEndGuide: noop,
  }));
  test("guiding: glyph and 3/5 at rest; hover holds title, Guiding, agent, step and End guide", () => {
    const h = html(agent({ on: true, startedAt: 0, steps: [step(3, 5)] }));
    expect(h).toContain('class="agx-isl-compact is-guide"');
    expect(h).toContain('<span class="agx-isl-num agx-isl-step">3/5</span>');
    expect(h).not.toContain("agx-isl-dot");
    expect(h).toMatch(/class="agx-isl[^"]* is-guide"/);
    expect(h).toContain("<b>Guiding</b>");
    expect(h).toContain('<span class="agx-isl-chip">3/5</span>');
    expect(h).toContain(">End guide</button>");
    expect(h).not.toContain(" title=");
  });
  test("worst case: long names ellipsize, +1 for a second agent, 12/14", () => {
    const long = "Pricing, plans and every add-on for teams of any size — Orbit Docs";
    const h = html(agent({ on: true, startedAt: 0, steps: [step(12, 14)] }, "orbit-docs-reviewer-sandbox"), long, "orbit-qa");
    expect(h).toContain(`<span class="agx-isl-title">${long}</span>`);
    expect(h).toContain('data-tip="1 more: orbit-qa">+1</span>');
    expect(h).toContain("12/14");
    expect(rule(".agx-isl-title")).toContain("text-overflow: ellipsis");
    expect(rule(".agx-isl-doing-t")).toContain("text-overflow: ellipsis");
    expect(rule(".agx-isl-compact .agx-isl-step")).toContain("min-width: 30px");
    expect(css).toContain(".agx-isl-compact { width: 104px; height: 30px;");
  });
  test("ended: tick for done, square for stopped, no End guide", () => {
    const now = Date.now();
    const d = html(agent({ on: false, startedAt: 0, endedAt: now, steps: [step(5, 5, { did: "click" })] }));
    expect(d).toContain("agx-isl-gl is-done");
    expect(d).toContain(">5/5</span>");
    expect(d).not.toContain("End guide");
    const s = html(agent({ on: false, startedAt: 0, endedAt: now, steps: [step(3, 5, { did: "stop" })] }));
    expect(s).toContain("agx-isl-gl is-stopped");
    expect(s).toContain(">3/5</span>");
  });
  test("after 2.4 s it is Idle again: the dot and the tab count", () => {
    const h = html(agent({ on: false, startedAt: 0, endedAt: Date.now() - GUIDE_PILL_END_MS - 1, steps: [step(5, 5)] }));
    expect(h).not.toContain("is-guide");
    expect(h).toContain("agx-isl-dot");
  });
  test("End guide in the pill stops the guide the way the old bar did", () => {
    expect(island).toContain("p.onEndGuide?.(active.id)");
    expect(panel).toMatch(/onEndGuide=\{\(id\) => \{ dispatchAct\(\{ type: "guideAnswer", tab: id, answer: "stop"[^}]*\}\); answerGuide\(id, "stop"\); \}\}/);
  });
});

describe("the bottom bar is gone", () => {
  test("no End guide, no Close and no guide overflow in the dock", () => {
    expect(presence).not.toContain("End guide");
    expect(presence).not.toContain('className="is-guide"');
    expect(presence).not.toContain("agx-dock-more");
    expect(presence).toContain("const docked = (agent.paused || (live && !isGuiding)) && !quiet;");
  });
});

describe("card motion: leave in place, then arrive", () => {
  test("a new step sends the shown card out; the next waits for the leave AND its rect", () => {
    let f = cardFlow(CARD_FLOW_INIT, { type: "step", key: "1|1", at: 0 });
    f = cardFlow(f, { type: "tick", at: 10, ready: true });
    expect(f).toMatchObject({ shown: "1|1", leaving: null, next: null });
    f = cardFlow(f, { type: "step", key: "2|2", at: 100 });
    expect(f).toMatchObject({ shown: null, leaving: "1|1", next: "2|2" });
    // ready, but the leave is not done: nothing arrives.
    expect(cardFlow(f, { type: "tick", at: 120, ready: true }).shown).toBeNull();
    f = cardFlow(f, { type: "left", key: "1|1" });
    expect(f.leaving).toBeNull();
    // left, but no rect yet: still nothing, until the cap.
    expect(cardFlow(f, { type: "tick", at: 100 + CARD_WAIT_CAP_MS - 1, ready: false }).shown).toBeNull();
    expect(cardFlow(f, { type: "tick", at: 100 + CARD_WAIT_CAP_MS, ready: false }).shown).toBe("2|2");
    expect(cardFlow(f, { type: "tick", at: 300, ready: true }).shown).toBe("2|2");
  });
  test("a guide say edit keeps the card: same key", () => {
    const s = step(2, 5);
    expect(guideCardKey({ ...s, ...{ say: "Other words" } })).toBe(guideCardKey(s));
    const f = cardFlow({ shown: guideCardKey(s), leaving: null, next: null, since: 0 }, { type: "step", key: guideCardKey(s), at: 9 });
    expect(f.leaving).toBeNull();
  });
  test("ready means the anchor is known", () => {
    expect(cardReady({})).toBe(false);
    expect(cardReady({ rect: { x: 0, y: 0, w: 1, h: 1 } })).toBe(true);
    expect(cardReady({ lost: true })).toBe(true);
  });
  test("standard: out 150 ms opacity and scale to .96; in 200 ms from .96 and -4 px", () => {
    const out = cardMotion("leave", false), inn = cardMotion("arrive", false);
    expect(out.keyframes).toEqual([{ opacity: 1, scale: "1" }, { opacity: 0, scale: ".96" }]);
    expect(out.options).toMatchObject({ duration: 150, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    expect(inn.keyframes[0]).toEqual({ opacity: 0, scale: ".96", transform: "translateY(-4px)" });
    expect(inn.options.duration).toBe(200);
  });
  test("reduce motion: opacities only, 100 ms out and 120 ms in", () => {
    const out = cardMotion("leave", true), inn = cardMotion("arrive", true);
    expect(out.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(out.options.duration).toBe(100);
    expect(inn.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(inn.options.duration).toBe(120);
  });
  test("no transform transition across anchors: the card is placed by translate, transitioned only once settled", () => {
    const base = rule(".agx-presence-bubble");
    expect(base).not.toMatch(/transition:/);
    expect(base).not.toMatch(/animation:/);
    expect(rule(".agx-presence-bubble.is-settled")).toContain("transition: translate 420ms var(--agx-move)");
    expect(presence).not.toMatch(/el\.style\.transform = `translate\(\$\{p\.left\}/);
    expect(presence).toContain("el.style.translate = `${p.left}px ${p.top}px`;");
    expect(presence).toContain('if (frozen) { el.classList.remove("is-settled"); return; }');
    expect(presence).toContain("if (frozen && placed.current) return;");
  });
  test("leaving card: pointer events off; the ring goes green and presses on the click", () => {
    expect(css).toContain(".agx-presence-bubble.is-leaving, .agx-presence-bubble.is-leaving * { pointer-events: none !important; }");
    expect(rule(".agx-presence-ring.is-got")).toContain("var(--agx-contact)");
    expect(css).toMatch(/@keyframes agx-ring-got \{ 0% \{ scale: 1; opacity: 1; \} 40% \{ scale: \.97;/);
    expect(presence).toContain("frozen={c.leaving || !!c.step.clicked || !!c.step.navigated}");
  });
});

describe("placement and the typing dot", () => {
  test("both sides fit: the side with the most room", () => {
    const pane = { w: 520, h: 600 };
    expect(bubblePlace({ x: 40, y: 420, w: 120, h: 30 }, pane, { h: 40 }).side).toBe("above");
    expect(bubblePlace({ x: 40, y: 120, w: 120, h: 30 }, pane, { h: 40 }).side).toBe("below");
  });
  test("the card never covers the target, wherever it is", () => {
    const pane = { w: 520, h: 600 };
    for (let y = 20; y < 560; y += 40) {
      const r = { x: 40, y, w: 160, h: 30 };
      const p = bubblePlace(r, pane, { h: 40 });
      expect(boxesMeet(r, { x: p.left, y: p.top, w: p.width, h: p.maxText + 52 })).toBe(false);
    }
  });
  const T = "t1";
  const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
  const run = (...evs: Parameters<typeof activityReducer>[1][]) => evs.reduce<Activity>((s, e) => activityReducer(s, e), {});
  test("typing folds the card; blur or 1.5 s without a key brings it back", () => {
    const rect = { x: 40, y: 100, w: 200, h: 30 };
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Type: hello", waitClick: false, target: { rect } }), g({ phase: "wait", typing: true, at: 50 }));
    const st = s[T]!.guide!.steps[0]!;
    expect(st.typingAt).toBe(50);
    expect(cardDotted(st, 50 + GUIDE_TYPING_IDLE_MS - 1)).toBe(true);
    expect(cardDotted(st, 50 + GUIDE_TYPING_IDLE_MS)).toBe(false);
    const b = activityReducer(s, g({ phase: "wait", typing: false, at: 60 }));
    expect(b[T]!.guide!.steps[0]!.typingAt).toBeUndefined();
    expect(b[T]!.guide!.steps).toHaveLength(1);
  });
  test("the dot sits beside the field, never on it", () => {
    const pane = { w: 400, h: 300 };
    for (const r of [{ x: 20, y: 40, w: 200, h: 30 }, { x: 180, y: 40, w: 210, h: 30 }, { x: 0, y: 40, w: 400, h: 30 }]) {
      expect(boxesMeet(r, guideDotAt(r, pane, 26))).toBe(false);
    }
  });
  test("the observer reports the person's keys and blur in the target, trusted only", () => {
    expect(observer).toContain('el.addEventListener("input", keyed, { capture: true });');
    expect(observer).toContain('el.addEventListener("focusout", leftField, { capture: true });');
    expect(observer).toMatch(/const keyed = \(e\) => \{\s*if \(!e\.isTrusted\) return;/);
    expect(observer).toContain('if (typeof m.typing === "boolean") { emit({ ...base(), typing: m.typing }); return; }');
    expect(observer).toContain('el.removeEventListener("focusout", leftField, { capture: true });');
  });
});

describe("the record card keeps Resume while it is valid", () => {
  test("6 s after a stopped run, the list fades but Resume stays (small card)", () => {
    const g: TabGuide = { on: false, run: true, startedAt: 0, endedAt: 1000, resumeUntil: 1000 + 600_000, steps: [step(3, 5, { did: "stop" })] };
    const at = 1000 + GUIDE_AUDIT_MS + 500;
    expect(auditLeft(g, at)).toBe(0);
    expect(auditAfterFade(g, at)).toBe("small");
    expect(auditAfterFade(g, 1000 + 600_000)).toBe("gone");
    expect(auditAfterFade({ steps: [] }, at)).toBe("gone");
    expect(presence).toContain('setTimeout(fold, 300)');
    expect(presence).toMatch(/if \(auditAfterFade\(guide, Date\.now\(\)\) === "small"\) \{ setSmall\(true\); setFading\(false\); \} else onGone\(\);/);
    expect(presence).toContain("{resumable && <div className=\"agx-bubble-foot\"");
    expect(presence).not.toMatch(/guide && !guide\.on && !quiet && <GuideAudit/);
  });
  test("the pointer leaving gives a fresh grace", () => {
    expect(auditWait(0, true)).toBe(GUIDE_AUDIT_GRACE_MS);
    expect(auditWait(4000, true)).toBe(4000);
    expect(auditWait(0, false)).toBe(0);
    expect(presence).toContain("onPointerLeave={() => { graced.current = true; setHeld(false); }}");
  });
  test("a long list scrolls", () => {
    expect(css).toMatch(/\.agx-presence-audit ol \{ pointer-events: auto; max-height: [^;]+; overflow-y: auto;/);
  });
});
