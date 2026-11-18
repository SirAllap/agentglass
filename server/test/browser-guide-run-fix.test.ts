/*
 * guide run, the server's half of five review fixes: a step whose target is
 * not on the page yet is not lost from the point's answer (F1), the person's
 * Stop ends a run that already ended (F4), and an overflowed run is not
 * resumed (F5). Fakes only, state in a temp dir.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setBrowserAsker, guidePanelEvent, resetBrowserDrive, type BrowserAsk, type BrowserReply } from "../src/browserdrive.ts";
import { guideLock, guideOf, resumeRun, runInput, setGuideClock, startGuide, startRun, type Guide, type PlanStep } from "../src/browserGuide.ts";

const prevState = process.env.AGENTGLASS_STATE_DIR;
beforeAll(() => { process.env.AGENTGLASS_STATE_DIR = mkdtempSync(join(tmpdir(), "agx-guide-run-fix-")); });
afterAll(() => { if (prevState === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = prevState; });

let now = Date.parse("2026-11-13T15:02:00");
let seen: BrowserAsk[] = [];
let pointReply: BrowserReply = { ok: true, value: {} };
beforeEach(() => {
  resetBrowserDrive();
  now = Date.parse("2026-11-13T15:02:00");
  seen = [];
  pointReply = { ok: true, value: {} };
  setGuideClock(() => now);
  __setBrowserAsker(async (a): Promise<BrowserReply> => {
    seen.push(a);
    if (a.op === "point") return pointReply;
    return { ok: true, value: {} };
  });
});
afterEach(() => { __setBrowserAsker(null); setGuideClock(null); resetBrowserDrive(); });

const TWO: PlanStep[] = [
  { target: "a.next", say: "Click 'Next page'.", wait: "click" },
  { target: "#name", say: "Type your name in the 'Name' box.", wait: "input" },
];
function begin(steps: PlanStep[] = TWO): Guide {
  const st = startGuide("t1", "orbit-guide", "Sign up on the test page");
  if ("error" in st) throw new Error(st.error);
  startRun(st.guide, steps.map((s) => ({ ...s })));
  return st.guide;
}

describe("F1: lost is never decided from the point's answer", () => {
  test("a point that finds no match yet leaves the step not lost and says nothing of it", async () => {
    const g = begin();
    pointReply = { ok: false, error: "no match for #name on http://127.0.0.1:4321/b: observe again" };
    await guidePanelEvent({ tab: "t1", event: "click", visit: 1 });
    expect(g.run!.index).toBe(1);
    expect(g.run!.visits.at(-1)!.lost).toBeUndefined();
    expect(g.run!.queue.some((e) => e.event === "lost")).toBe(false);
    expect(seen.some((a) => a.op === "guide" && (a.args.activity as { lost?: boolean })?.lost)).toBe(false);
  });
});

describe("F4: Stop after the run ended", () => {
  test("after done, the person's Stop ends the guide and frees the tab", async () => {
    const g = begin();
    runInput(g, { event: "click", visit: 1 });
    runInput(g, { event: "input", visit: 2 });
    expect(g.run!.endedBy).toBe("done");
    expect(guideLock("click", true, "t1", true, "orbit-guide")).toContain("guide mode");
    const r = await guidePanelEvent({ tab: "t1", event: "stop" });
    expect(r.value).toMatchObject({ ended: true, resumable: false });
    expect(guideOf("t1")).toBeUndefined();
    expect(guideLock("click", true, "t1", true, "orbit-guide")).toBe(null);
  });
});

describe("F5: no Resume after an overflow", () => {
  test("Resume is refused with the reason, and the tab stays free", async () => {
    const g = begin();
    for (let i = 0; i < 400; i++) runInput(g, { event: "back", visit: g.run!.visits.length });
    expect(g.run!.endedBy).toBe("overflow");
    await guidePanelEvent({ tab: "t1", event: "stop" });
    const r = resumeRun("t1");
    expect("error" in r && r.error).toContain("200 events");
    expect(guideOf("t1")).toBeUndefined();
  });
});
