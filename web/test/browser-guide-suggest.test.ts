/*
 * The guide card's "Insert suggestion": the draft the agent passed with
 * `--suggest` lands on the step and the card, shows as text, and goes into
 * the page's field only on the person's own click. A field with text asks
 * first; nothing is ever submitted; a target that is not a text field is
 * refused. The page is a fake; the in-page snippets run against fake nodes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activityReducer, bubbleOf, type Activity, type GuideEvent } from "../src/lib/browserAgentActivity.ts";
import { FIELD_EMPTY, PUT_DRAFT, TEXT_FIELD, insertGuideSuggestion, runGuide, setGuideShell, type DrivableWebview } from "../src/lib/browserDrive.ts";
import { onGuideEvent, resetGuideBus, waitGuideNext } from "../src/lib/browserGuideBus.ts";
import { GuideSuggest, SUGGEST_ASK, SUGGEST_INSERT, SUGGEST_REPLACE, personClicked } from "../src/components/browser/AgentPresence.tsx";
import type { BrowserAskFrame } from "../../shared/types.ts";

const T = "t1";
const DRAFT = "Thanks for the review.\nI moved the check into the hook, as you asked.";
const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
const run = (...evs: GuideEvent[]) => evs.reduce<Activity>((s, e) => activityReducer(s, e), {});
const rect = { x: 40, y: 100, w: 320, h: 120 };
const snippet = <F,>(src: string) => new Function(`return ${src}`)() as F;
const textField = snippet<(n: unknown) => string | null>(TEXT_FIELD);
const fieldEmpty = snippet<(n: unknown, k: string) => boolean>(FIELD_EMPTY);
const putDraft = snippet<(n: unknown, k: string, t: string) => void>(PUT_DRAFT);

const pointAsk = (extra: Record<string, unknown> = {}) => ({ id: "a", op: "point", args: { page: T, selector: "#reply", say: "Edit and send.",
  activity: { kind: "guide", tab: T, phase: "point", say: "Edit and send.", suggest: DRAFT }, ...extra } }) as unknown as BrowserAskFrame;

/** A guest whose every script answers what `answer` returns for it; the scripts are kept. */
function page(answer: (src: string) => unknown) {
  const scripts: string[] = [];
  let focused = 0;
  const el = {
    getWebContentsId: () => 7, focus: () => { focused++; },
    executeJavaScript: async (src: string) => { scripts.push(src); return answer(src); },
  } as unknown as DrivableWebview;
  return { el, scripts, focused: () => focused };
}
const isInsert = (src: string) => src.includes("inserted: true");
const fakeShell = () => setGuideShell({ observe: async () => ({ ok: true, found: true }), onObserved: () => () => {} });

/** A text input in a form, with spies on everything that could submit it. */
function input(value = "", type = "text") {
  const events: string[] = [];
  const form = { submits: 0, submit() { this.submits++; }, requestSubmit() { this.submits++; } };
  const n = { nodeType: 1, tagName: "INPUT", type, value, disabled: false, readOnly: false, form, focused: false,
    focus() { this.focused = true; }, click() { events.push("click"); },
    dispatchEvent(e: Event) { events.push(e.type); if (e.type === "submit") form.submit(); return true; },
    setSelectionRange() {} };
  return { n, events, form };
}

afterEach(() => { setGuideShell(null); resetGuideBus(); });

describe("suggest on the guide card", () => {
  test("a point with suggest puts it on the step and the bubble; the field's text is carried", () => {
    const s = run(g({ phase: "start" }), g({ phase: "point", say: "Edit and send.", suggest: DRAFT, suggestFilled: true, target: { rect } }));
    const step = s[T]!.guide!.steps[0]!;
    expect(step).toMatchObject({ suggest: DRAFT, suggestFilled: true });
    expect(bubbleOf(step, true)).toMatchObject({ suggest: DRAFT, suggestFilled: true });
    const bare = run(g({ phase: "start" }), g({ phase: "point", say: "Click it.", target: { rect } }));
    expect(bubbleOf(bare[T]!.guide!.steps[0]!, true).suggest).toBeUndefined();
  });

  test("point carries the draft and the field's state to the card", async () => {
    fakeShell();
    const seen: GuideEvent[] = [];
    const off = onGuideEvent((e) => seen.push(e));
    const { el } = page(() => ({ total: 1, url: "https://code.example/pr/7", field: { filled: true } }));
    expect((await runGuide(el, pointAsk())).ok).toBe(true);
    off();
    expect(seen[0]).toMatchObject({ suggest: DRAFT, suggestFilled: true });
  });

  test("the preview shows markup as text, and the button reads Insert or Replace", () => {
    const html = renderToStaticMarkup(React.createElement(GuideSuggest, { text: '<img src=x onerror="alert(1)"><b>hi</b>', filled: false }));
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain(`${SUGGEST_INSERT}</button>`);
    expect(html).not.toContain("title=");
    expect(renderToStaticMarkup(React.createElement(GuideSuggest, { text: DRAFT, filled: true }))).toContain(`${SUGGEST_REPLACE}</button>`);
    const ask = renderToStaticMarkup(React.createElement(GuideSuggest, { text: DRAFT, filled: true, asking: true }));
    expect(ask).toContain(SUGGEST_ASK);
    expect(ask).toContain(">Keep mine</button>");
    expect(ask).toContain(">Replace</button>");
  });
});

describe("insert only on the person's click", () => {
  test("a script's click is not the person's", () => {
    expect(personClicked({ nativeEvent: { isTrusted: true } })).toBe(true);
    expect(personClicked({ nativeEvent: { isTrusted: false } })).toBe(false);
    expect(personClicked({})).toBe(false);
  });

  test("point, next and end never write the field", async () => {
    fakeShell();
    const { el, scripts } = page((src) => src.includes("data-agx-suggest") ? { total: 1, url: "u", field: { filled: false } } : {});
    await runGuide(el, pointAsk());
    await runGuide(el, { id: "b", op: "guide", args: { page: T, action: "next", waitMs: 0 } } as unknown as BrowserAskFrame);
    await runGuide(el, { id: "c", op: "guide", args: { page: T, action: "end" } } as unknown as BrowserAskFrame);
    expect(scripts.some(isInsert)).toBe(false);
  });

  test("the person's insert writes the field, focuses it, and tells guide next without ending the step", async () => {
    fakeShell();
    const p = page((src) => isInsert(src) ? { inserted: true } : { total: 1, url: "u", field: { filled: false } });
    await runGuide(p.el, pointAsk());
    expect(await insertGuideSuggestion(p.el, T, false)).toEqual({ ok: true, inserted: true });
    expect(p.focused()).toBe(1);
    const ins = p.scripts.find(isInsert)!;
    expect(ins).toContain(JSON.stringify(DRAFT));
    expect(await waitGuideNext(T, 0)).toEqual({ event: "suggest-inserted" });
    /* The step is still open: the next answer is still to come. */
    expect(await waitGuideNext(T, 0)).toBeNull();
  });

  test("a step that waits on input: the person's insert is the input", async () => {
    const reports: unknown[] = [];
    setGuideShell({ observe: async () => ({ ok: true, found: true }), onObserved: () => () => {}, report: async (ev) => { reports.push(ev); return { ok: true }; } });
    const p = page((src) => isInsert(src) ? { inserted: true } : { total: 1, url: "u", field: { filled: false } });
    /* A run's step: the server hears input for the card's visit. */
    await runGuide(p.el, pointAsk({ wait: "input", run: { visit: 3 } }));
    expect(await insertGuideSuggestion(p.el, T, false)).toEqual({ ok: true, inserted: true });
    expect(reports).toEqual([{ tab: T, event: "input", visit: 3 }]);
    /* A single step with --wait-input: the news, then the step's answer. */
    await runGuide(p.el, pointAsk({ wait: "input" }));
    expect(await insertGuideSuggestion(p.el, T, false)).toEqual({ ok: true, inserted: true });
    expect(await waitGuideNext(T, 0)).toEqual({ event: "suggest-inserted" });
    expect(await waitGuideNext(T, 0)).toEqual({ event: "input" });
    expect(reports).toHaveLength(1);
  });

  test("with no draft on the step there is nothing to insert", async () => {
    const p = page(() => ({ inserted: true }));
    expect(await insertGuideSuggestion(p.el, "t9", false)).toEqual({ ok: false, error: "This step is over" });
    expect(p.scripts).toEqual([]);
  });
});

describe("a field with text asks first", () => {
  test("the page says filled: nothing is written and the card asks", async () => {
    fakeShell();
    const p = page((src) => isInsert(src) ? (src.includes("!false && !") ? { filled: true } : { inserted: true }) : { total: 1, url: "u", field: { filled: true } });
    await runGuide(p.el, pointAsk());
    expect(await insertGuideSuggestion(p.el, T, false)).toEqual({ ok: true, filled: true });
    expect(await waitGuideNext(T, 0)).toBeNull();
    expect(await insertGuideSuggestion(p.el, T, true)).toEqual({ ok: true, inserted: true });
  });

  test("the emptiness check reads the field's own text", () => {
    expect(fieldEmpty(input("").n, "input")).toBe(true);
    expect(fieldEmpty(input("   ").n, "input")).toBe(true);
    expect(fieldEmpty(input("my words").n, "input")).toBe(false);
    expect(fieldEmpty({ innerText: "draft" }, "editable")).toBe(false);
  });
});

describe("never submits", () => {
  test("the draft goes in with one input event: no key, no submit, no click", () => {
    const { n, events, form } = input("");
    putDraft(n, "input", DRAFT);
    expect(n.value).toBe(DRAFT);
    expect(n.focused).toBe(true);
    expect(events).toEqual(["input"]);
    expect(form.submits).toBe(0);
  });

  test("a contenteditable gets the text by insertText, with no key and no submit", () => {
    const events: string[] = [];
    const cmds: unknown[][] = [];
    const g0 = globalThis as unknown as Record<string, unknown>;
    const was = { window: g0.window, document: g0.document };
    g0.window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
    g0.document = { createRange: () => ({ selectNodeContents() {} }), execCommand: (...a: unknown[]) => { cmds.push(a); return true; } };
    try {
      const n = { focus() {}, dispatchEvent(e: Event) { events.push(e.type); return true; } };
      putDraft(n, "editable", DRAFT);
    } finally { g0.window = was.window; g0.document = was.document; }
    /* A draft with a newline goes in piece by piece (c05c07d31): one insertText with "\n" glues words in rich editors. */
    expect(cmds).toEqual([
      ["insertText", false, "Thanks for the review."],
      ["insertLineBreak", false, undefined],
      ["insertText", false, "I moved the check into the hook, as you asked."],
    ]);
    expect(events).toEqual([]);
  });
});

describe("a target that is not a text field", () => {
  test("is refused by point with a sentence, and no card goes up", async () => {
    fakeShell();
    const seen: GuideEvent[] = [];
    const off = onGuideEvent((e) => seen.push(e));
    const { el } = page(() => ({ notText: "button" }));
    const r = await runGuide(el, pointAsk({ selector: "#send" }));
    off();
    expect(r).toEqual({ ok: false, error: "point --suggest needs a text field: a textarea, a text input or a contenteditable. Point at the field itself; #send is a <button>" });
    expect(seen).toEqual([]);
  });

  test("only textareas, text-like inputs and contenteditables count", () => {
    expect(textField(input("", "text").n)).toBe("input");
    expect(textField(input("", "email").n)).toBe("input");
    expect(textField({ nodeType: 1, tagName: "TEXTAREA" })).toBe("textarea");
    expect(textField({ nodeType: 1, tagName: "DIV", isContentEditable: true })).toBe("editable");
    expect(textField(input("", "password").n)).toBeNull();
    expect(textField(input("", "checkbox").n)).toBeNull();
    expect(textField({ nodeType: 1, tagName: "TEXTAREA", readOnly: true })).toBeNull();
    expect(textField({ nodeType: 1, tagName: "INPUT", type: "text", disabled: true })).toBeNull();
    expect(textField({ nodeType: 1, tagName: "BUTTON" })).toBeNull();
  });
});
