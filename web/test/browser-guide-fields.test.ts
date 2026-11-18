/*
 * `point --suggest` reaches the field a person would type in, wherever the
 * page keeps it: a custom element's open shadow root (a forum's Title is a
 * <orbit-textarea-input> with its textarea inside), a same-origin frame (a
 * composer whose page shell holds a div[role=textbox] and whose editable one
 * lives in a frame), and the visible one of two matches (a header search
 * hidden, the page's own shown). The pages are invented; the in-page scripts
 * are the real ones, run against the stand-in DOM.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { insertGuideSuggestion, runGuide, setGuideShell } from "../src/lib/browserDrive.ts";
import { resetGuideBus } from "../src/lib/browserGuideBus.ts";
import { GUIDE_SKIP, activityReducer, bubbleOf, type Activity, type GuideEvent } from "../src/lib/browserAgentActivity.ts";
import type { BrowserAskFrame } from "../../shared/types.ts";
import { Root, h, page } from "./standinDom.ts";

const T = "t1";
const DRAFT = "Orbit v2 is out";
const suggestAsk = (selector: string) => ({ id: "a", op: "point", args: { page: T, selector, say: "Put the title in.",
  activity: { kind: "guide", tab: T, phase: "point", say: "Put the title in.", suggest: DRAFT } } }) as unknown as BrowserAskFrame;

afterEach(() => { setGuideShell(null); resetGuideBus(); });

const editable = (attrs: Record<string, string>) => Object.assign(h("div", { contenteditable: "true", ...attrs }), { isContentEditable: true });

describe("point --suggest finds the real field", () => {
  test("a custom element whose textarea is in its open shadow root, itself inside another component's shadow root", async () => {
    const area = h("textarea", { name: "title" });
    const field = h("orbit-textarea-input", { name: "title" });
    field.shadowRoot = new Root("shadow", h("label", {}, "Title"), area);
    const form = h("orbit-composer", {});
    form.shadowRoot = new Root("shadow", field);
    const { guest } = page(h("body", {}, form));
    const r = await runGuide(guest, suggestAsk('orbit-textarea-input[name="title"]'));
    expect(r).toMatchObject({ ok: true });
    expect(area.getAttribute("data-agx-suggest")).toBeTruthy();
    /* The ring is on the field itself, where the draft lands. */
    expect(area.getAttribute("data-agx-guide")).toBe(area.getAttribute("data-agx-suggest"));
    expect(await insertGuideSuggestion(guest, T, false)).toEqual({ ok: true, inserted: true });
    expect(area.value).toBe(DRAFT);
    expect(area.events).toContain("input");
  });

  test("a composer whose page shell is a div[role=textbox] and whose editable is in a same-origin frame", async () => {
    const shell = h("div", { role: "textbox" }, "What do you want to talk about?");
    const inner = editable({ role: "textbox" });
    const frame = h("iframe", {});
    frame.frameDoc = new Root("frame", h("body", {}, inner));
    const { guest } = page(h("body", {}, shell, frame));
    const r = await runGuide(guest, suggestAsk('div[role="textbox"]'));
    expect(r).toMatchObject({ ok: true });
    expect(shell.getAttribute("data-agx-suggest")).toBeNull();
    expect(inner.getAttribute("data-agx-suggest")).toBeTruthy();
    expect(await insertGuideSuggestion(guest, T, false)).toEqual({ ok: true, inserted: true });
    expect(inner.events).toContain("focus");
  });

  test("of two matches, the visible text field is chosen, not the hidden first one", async () => {
    const hidden = h("input", { name: "search", type: "search" });
    const head = h("div", {}, hidden);
    head.style.display = "none";
    const shown = h("input", { name: "search", type: "search" });
    const { guest } = page(h("body", {}, head, h("main", {}, shown)));
    const r = await runGuide(guest, suggestAsk('input[name="search"]'));
    expect(r).toMatchObject({ ok: true });
    expect(shown.getAttribute("data-agx-suggest")).toBeTruthy();
    expect(hidden.getAttribute("data-agx-suggest")).toBeNull();
    expect(shown.getAttribute("data-agx-guide")).toBeTruthy();
  });

  test("a page with no text field anywhere is still refused with the sentence", async () => {
    const btn = h("div", { role: "textbox" }, "Start a post");
    const frame = h("iframe", {});
    frame.frameDoc = new Root("frame", h("body", {}, h("div", { role: "textbox" })));
    const { guest } = page(h("body", {}, btn, frame));
    const r = await runGuide(guest, suggestAsk('div[role="textbox"]'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("point --suggest needs a text field");
  });

  test("a plain point (no draft) on a field in a shadow root is not refused as no match", async () => {
    const area = h("textarea", { name: "body" });
    const host = h("orbit-editor", {});
    host.shadowRoot = new Root("shadow", area);
    const outer = h("orbit-page", {});
    outer.shadowRoot = new Root("shadow", host);
    const { guest } = page(h("body", {}, outer));
    const ask = { id: "a", op: "point", args: { page: T, selector: 'textarea[name="body"]', say: "Type here.",
      activity: { kind: "guide", tab: T, phase: "point", say: "Type here." } } } as unknown as BrowserAskFrame;
    expect(await runGuide(guest, ask)).toMatchObject({ ok: true });
  });
});

describe("a lost OK step offers Skip", () => {
  const g = (e: Omit<GuideEvent, "kind" | "tab">): GuideEvent => ({ kind: "guide", tab: T, ...e });
  const card = (skip: boolean) => {
    const s = [g({ phase: "start", run: true }), g({ phase: "point", say: "Read the notes, then press OK.", step: { n: 2, m: 3 }, target: { rect: { x: 1, y: 1, w: 9, h: 9 } } }),
      g({ phase: "say", say: "Can't find \"notes\" on this page. Back?", lost: true, ...(skip ? { skip: true } : {}) })]
      .reduce<Activity>((a, e) => activityReducer(a, e), {});
    return bubbleOf(s[T]!.guide!.steps.at(-1)!, false);
  };
  test("its OK reads Skip beside Back and Stop", () => {
    const b = card(true);
    expect(b.buttons).toEqual(["back", "stop", "ok"]);
    expect(b.okWord).toBe(GUIDE_SKIP);
  });
  test("a click step's lost card stays Back and Stop", () => {
    const b = card(false);
    expect(b.buttons).toEqual(["back", "stop"]);
    expect(b.okWord).toBeUndefined();
  });
});
