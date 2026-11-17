/*
 * guide run, the panel's half of review fixes: a run's target not on the page
 * yet gets a watcher, not a refusal (F1); the step before is muted before the
 * new step is looked up, so its reports never carry the new visit (F2); a nav
 * step with no target keeps a navigation watcher (F3); Stop after a run ended
 * still reaches the server (F4). Fake shell and fake page.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { runGuide, setGuideShell, type DrivableWebview, type GuideRunReport } from "../src/lib/browserDrive.ts";
import { answerGuide, resetGuideBus } from "../src/lib/browserGuideBus.ts";
import type { BrowserAskFrame } from "../../shared/types.ts";

const T = "t1";
const ask = (op: string, args: Record<string, unknown>) => ({ id: "a", op, args: { page: T, ...args } }) as unknown as BrowserAskFrame;
/* A page whose point lookup answers `total`, after `gate` when one is given. */
function page(total: () => number, gate?: () => Promise<void>) {
  return {
    getWebContentsId: () => 7,
    executeJavaScript: async () => { if (gate) await gate(); return { total: total(), tagged: false, url: "http://127.0.0.1:4321/b" }; },
  } as unknown as DrivableWebview;
}
function fakeShell() {
  const calls: Record<string, unknown>[] = [];
  const reports: GuideRunReport[] = [];
  let push: (ev: unknown) => void = () => {};
  setGuideShell({
    observe: async (req) => { calls.push(req); return { ok: true, found: false }; },
    onObserved: (fn) => { push = fn; return () => { push = () => {}; }; },
    report: async (ev) => { reports.push(ev); return { ok: true }; },
  });
  return { calls, reports, push: (ev: unknown) => push(ev) };
}
afterEach(() => { setGuideShell(null); resetGuideBus(); });

const point = (el: DrivableWebview, selector: string, wait: string, visit: number) => runGuide(el, ask("point", {
  selector, say: "Type your name in the 'Name' box.", wait, run: { visit },
  activity: { kind: "guide", tab: T, phase: "point", say: "Type your name in the 'Name' box.", step: { n: 2, m: 3 } },
}));

describe("F1: a run's target not there yet", () => {
  test("is watched with watchLost by the plan's selector, not refused", async () => {
    const sh = fakeShell();
    const r = await point(page(() => 0), "#name", "input", 2);
    expect(r.ok).toBe(true);
    const obs = sh.calls.filter((c) => !c.stop);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ again: { selector: "#name" }, watchLost: true, wait: "input" });
  });
});

describe("F2: the step before is muted before the lookup", () => {
  test("a report of the old watcher during the new step's lookup posts nothing with the new visit", async () => {
    const sh = fakeShell();
    await point(page(() => 1), "#start", "click", 1);
    const oldId = sh.calls[0]!.stepId;
    let open!: () => void;
    const held = new Promise<void>((r) => { open = r; });
    const next = point(page(() => 0, () => held), "#name", "input", 2);
    await Promise.resolve();
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: oldId, target: { rect: { x: 1, y: 1, w: 1, h: 1 } }, clicked: true });
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: oldId, gone: { url: "http://127.0.0.1:4321/b" } });
    open();
    await next;
    /* Neither under the new visit nor at all: the old step is over. */
    expect(sh.reports).toEqual([]);
  });
});

describe("F3: a nav step with no target", () => {
  test("keeps a navigation-only watcher, and the navigation is posted", async () => {
    const sh = fakeShell();
    await runGuide(page(() => 0), ask("point", { say: "Open 'Settings' from the menu.", wait: "nav", run: { visit: 3 } }));
    const obs = sh.calls.filter((c) => !c.stop);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ wait: "nav" });
    expect(obs[0]!.watchLost).toBeUndefined();
    sh.push({ kind: "guide", tab: T, phase: "point", stepId: obs[0]!.stepId, navigated: { url: "http://127.0.0.1:4321/settings" } });
    expect(sh.reports).toEqual([{ tab: T, event: "navigated", visit: 3, url: "http://127.0.0.1:4321/settings" }]);
  });
});

describe("F4: Stop after the run is over on the panel", () => {
  test("a second Stop (the run already stopped here) still goes to the server", async () => {
    const sh = fakeShell();
    await point(page(() => 1), "#start", "click", 1);
    answerGuide(T, "stop");
    answerGuide(T, "stop");
    expect(sh.reports.map((r) => r.event)).toEqual(["stop", "stop"]);
  });
});
