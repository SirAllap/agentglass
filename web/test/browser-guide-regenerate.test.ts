/* A text-field step with a draft offers three choices: Write my own, Suggest another, Use
   suggestion. "Suggest another" sends the agent a regenerate with the person's note; its new
   draft replaces the old one in place. A wrapper like div[role=textbox] finds its editable inside. */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activityReducer, bubbleOf, type Activity, type GuideEvent } from "../src/lib/browserAgentActivity.ts";
import { FIELD_OF, requestGuideSuggestion, runGuide, setGuideShell, type DrivableWebview } from "../src/lib/browserDrive.ts";
import { resetGuideBus, waitGuideNext } from "../src/lib/browserGuideBus.ts";
import { GuideSuggest, SUGGEST_ANOTHER, SUGGEST_INSERT, SUGGEST_MINE, SUGGEST_NOTE_HINT } from "../src/components/browser/AgentPresence.tsx";
import type { BrowserAskFrame } from "../../shared/types.ts";

const T = "t1";
const DRAFT = "Thanks for the review. I moved the check into the hook.";
const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
const run = (...evs: GuideEvent[]) => evs.reduce<Activity>((s, e) => activityReducer(s, e), {});
const rect = { x: 40, y: 100, w: 320, h: 120 };
const fieldOf = new Function(`return ${FIELD_OF}`)() as (n: unknown) => unknown;

afterEach(() => { setGuideShell(null); resetGuideBus(); });

describe("three choices on a draft", () => {
  test("Write my own, Suggest another and Use suggestion, in that order", () => {
    const html = renderToStaticMarkup(React.createElement(GuideSuggest, { text: DRAFT, filled: false, onRegenerate: () => true }));
    const at = (w: string) => html.indexOf(`${w}</button>`);
    expect(at(SUGGEST_MINE)).toBeGreaterThan(-1);
    expect(at(SUGGEST_ANOTHER)).toBeGreaterThan(at(SUGGEST_MINE));
    expect(at(SUGGEST_INSERT)).toBeGreaterThan(at(SUGGEST_ANOTHER));
    expect(SUGGEST_INSERT).toBe("Use suggestion");
  });
  test("no way to ask the agent, no Suggest another", () => {
    const html = renderToStaticMarkup(React.createElement(GuideSuggest, { text: DRAFT, filled: false }));
    expect(html).not.toContain(SUGGEST_ANOTHER);
  });
  test("the note row: a labelled one-line field, Cancel and Send, every control HIT tall", () => {
    const html = renderToStaticMarkup(React.createElement(GuideSuggest, { text: DRAFT, filled: false, onRegenerate: () => true, noting: true }));
    expect(html).toContain(`aria-label="${SUGGEST_NOTE_HINT}"`);
    expect(html).toContain('maxLength="200"');
    expect(html).toContain("Cancel</button>");
    expect(html).toContain("Send</button>");
    expect(html).not.toContain("title=");
    expect(html.match(/height:\s*\d+px/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the new draft replaces the old in place", () => {
  test("guide say with suggest only changes the draft; the words stay", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Edit the reply.", suggest: DRAFT, target: { rect } }),
      g({ phase: "say", suggest: "Thanks. Moved it." }));
    const step = s[T]!.guide!.steps[0]!;
    expect(step.say).toBe("Edit the reply.");
    expect(bubbleOf(step, true).suggest).toBe("Thanks. Moved it.");
  });
  test("a say with neither words nor a draft changes nothing", () => {
    const a = run(g({ phase: "start" }), g({ phase: "point", say: "Edit the reply.", suggest: DRAFT, target: { rect } }));
    const b = activityReducer(a, g({ phase: "say" }));
    expect(b).toEqual(a);
  });
});

describe("Suggest another reaches guide next", () => {
  /* A tab of its own: another file may have left a draft on t1 in this process. */
  const TR = "t-regen";
  test("with the note, after a point with a draft; none without one", async () => {
    expect(requestGuideSuggestion(TR, "shorter")).toBe(false);
    setGuideShell({ observe: async () => ({ ok: true, found: true }), onObserved: () => () => {} });
    const el = { getWebContentsId: () => 7, focus: () => {}, executeJavaScript: async () => ({ total: 1, url: "u", field: { filled: false } }) } as unknown as DrivableWebview;
    const ask = { id: "a", op: "point", args: { page: TR, selector: "#reply", say: "Edit the reply.", activity: { kind: "guide", tab: TR, phase: "point", say: "Edit the reply.", suggest: DRAFT } } } as unknown as BrowserAskFrame;
    await runGuide(el, ask);
    expect(requestGuideSuggestion(TR, "  less\n salesy ")).toBe(true);
    expect(await waitGuideNext(TR, 0)).toEqual({ event: "regenerate", note: "less salesy" });
  });
});

describe("a wrapper finds its editable inside (a rich composer)", () => {
  const editable = { nodeType: 1, tagName: "DIV", isContentEditable: true };
  const wrapper = (kids: unknown[], frames: unknown[] = []) => ({
    nodeType: 1, tagName: "DIV", isContentEditable: false,
    /* "*" is the walk over shadow roots and frames (ROOTS); the field query reads the kids. */
    querySelectorAll: (sel: string) => sel === "*" ? [...kids, ...frames] : sel.startsWith("iframe") ? frames : kids,
  });
  test("a field is itself", () => { expect(fieldOf(editable)).toBe(editable); });
  test("div[role=textbox] with an editable child", () => { expect(fieldOf(wrapper([editable]))).toBe(editable); });
  test("an editable inside a same-origin frame in the wrapper", () => {
    const body = { nodeType: 1, tagName: "BODY", isContentEditable: true };
    const frame = { tagName: "IFRAME", getAttribute: () => null, contentDocument: { body, designMode: "off", querySelectorAll: () => [] } };
    expect(fieldOf(wrapper([], [frame]))).toBe(body);
  });
  test("a cross-origin frame is skipped, and nothing found is null", () => {
    const frame = { tagName: "IFRAME", get contentDocument(): never { throw new Error("blocked"); } };
    expect(fieldOf(wrapper([], [frame]))).toBeNull();
  });
});
