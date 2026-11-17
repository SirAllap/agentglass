/* Guide mode, from the improvements list: a say with no words is refused (#18), a summary step
   shows what the page is about before the person acts (#20), and guide end says how long each
   step took and where the person ended up (#14). */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsk } from "../src/browserdrive.ts";
import { SUMMARY_SAY, addStep, guideAudit, lintPlan, noteEvent, parsePlan, resetGuides, sayHasWords, setGuideClock, startGuide, type Guide } from "../src/browserGuide.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-guide-summary-"));
process.env.AGENTGLASS_STATE_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("#18 a say with no words is refused, never a bare card", () => {
  for (const say of ["…", "''", "-", " \"\" ", "?!"]) {
    test(`point say ${JSON.stringify(say)}`, () => {
      const r = parseAsk("point", { selector: "e1", say });
      expect("error" in r && r.error).toContain("point: say has no words");
    });
    test(`guide say ${JSON.stringify(say)}`, () => {
      const r = parseAsk("guide", { action: "say", say });
      expect("error" in r && r.error).toContain("guide say has no words");
    });
    test(`plan say ${JSON.stringify(say)}`, () => {
      const r = parsePlan([{ say }]);
      expect("error" in r && r.error).toContain("plan step 1: say has no words");
    });
  }
  test("words in any script pass", () => {
    for (const s of ["Open keys.", "Pulsa «Guardar»", "Нажмите", "42"]) expect(sayHasWords(s)).toBe(true);
  });
});

describe("#20 summary step", () => {
  test("point --summary rides to the card and ends on OK", () => {
    const r = parseAsk("point", { selector: "e1", say: "Read the post, then press OK.", summary: "  A post about orbit-1042 and 3 replies.  " });
    expect("ask" in r && r.ask.args.summary).toBe("A post about orbit-1042 and 3 replies.");
    expect("ask" in r && r.ask.args.waitClick).toBeUndefined();
  });
  test("a summary with no say gets a real instruction, not Got it", () => {
    const r = parseAsk("point", { selector: "e1", summary: "A post about orbit-1042." });
    expect("ask" in r && r.ask.args.say).toBe(SUMMARY_SAY);
  });
  test("a summary step that waits for a click is refused", () => {
    expect("error" in parseAsk("point", { selector: "e1", summary: "A post.", waitClick: true })).toBe(true);
    expect("error" in parseAsk("point", { selector: "e1", summary: "A post.", wait: "input" })).toBe(true);
  });
  test("an empty or wordless summary is refused", () => {
    for (const summary of ["", "  ", "…"]) expect("error" in parseAsk("point", { selector: "e1", say: "Read it.", summary })).toBe(true);
  });
  test("plan {wait: ok, summary} with no say parses, defaults to OK even with a target, and does not lint", () => {
    const r = parsePlan([{ summary: "A post about orbit-1042." }, { target: "#post", summary: "The post." }]);
    if ("error" in r) throw new Error(r.error);
    expect(r.steps[0]).toEqual({ say: SUMMARY_SAY, wait: "ok", summary: "A post about orbit-1042." });
    expect(r.steps[1]!.wait).toBe("ok");
    expect(lintPlan(r.steps)).toEqual([]);
  });
  test("plan summary with wait click is refused", () => {
    const r = parsePlan([{ target: "#post", summary: "The post.", wait: "click" }]);
    expect("error" in r && r.error).toContain("a summary step ends on the person's OK");
  });
});

describe("#14 guide end says time per step and the last address", () => {
  let now = 1_000_000;
  beforeEach(() => { resetGuides(); now = 1_000_000; setGuideClock(() => now); });
  test("seconds run to the answer, else to the next step, else to the end; url is the last move", () => {
    const made = startGuide("t1", "", "Post a reply");
    if ("error" in made) throw new Error(made.error);
    const g: Guide = made.guide;
    addStep(g, { target: "e1", say: "Open the thread.", waitClick: true });
    now += 4_000; noteEvent(g, "navigated", "https://example.test/item?id=1");
    now += 1_000; addStep(g, { target: "e2", say: "Read the post.", waitClick: false, summary: "A post." });
    now += 9_000; addStep(g, { target: "e3", say: "Click 'reply'.", waitClick: true });
    now += 2_000;
    const a = guideAudit(g) as { url?: string; steps: Array<{ seconds: number; summary?: boolean }> };
    expect(a.steps.map((s) => s.seconds)).toEqual([4, 9, 2]);
    expect(a.steps[1]!.summary).toBe(true);
    expect(a.url).toBe("https://example.test/item?id=1");
  });
});
