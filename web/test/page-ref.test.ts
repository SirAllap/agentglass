/*
 * What an agent is told when somebody points at something on a page.
 *
 * The description IS the feature. An agent told "the button is wrong" can do
 * nothing; one told which page, which selector, what the element currently is
 * and what should change can go and find it. So these tests are mostly about
 * what ends up in the prompt, and about not trusting what came back from a
 * page — that string was produced inside somebody else's site.
 */
import { describe, expect, it } from "bun:test";
import { elementForClipboard, feedbackWindowName, pageFeedbackPrompt, parsePick, type PickedElement } from "../src/lib/pageRef.ts";

const el = (over: Partial<PickedElement> = {}): PickedElement => ({
  action: "select",
  selector: "main > div:nth-of-type(2) > button",
  tag: "button",
  id: "buy",
  classes: "btn btn-primary is-loading extra another",
  text: "Buy it now",
  html: '<button id="buy" class="btn">Buy it now</button>',
  rect: { x: 10, y: 20, width: 120, height: 40 },
  ...over,
});

describe("reading what the page sent back", () => {
  it("takes a well-formed answer", () => {
    const p = parsePick(JSON.stringify(el()));
    expect(p?.tag).toBe("button");
    expect(p?.rect.width).toBe(120);
  });

  it("refuses anything that is not an answer", () => {
    // This string came out of somebody else's site.
    expect(parsePick("")).toBeNull();
    expect(parsePick("not json")).toBeNull();
    expect(parsePick(null)).toBeNull();
    expect(parsePick(JSON.stringify({ tag: "div" }))).toBeNull();   // no action
    expect(parsePick(JSON.stringify({ action: "" }))).toBeNull();
  });

  it("fills in what a half-formed answer left out, rather than trusting it", () => {
    const p = parsePick(JSON.stringify({ action: "copy" }));
    expect(p).not.toBeNull();
    expect(p!.selector).toBe("");
    expect(p!.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("coerces numbers that arrived as something else", () => {
    const p = parsePick(JSON.stringify({ action: "shoot", rect: { x: "4", y: null, width: "80", height: 9 } }));
    expect(p!.rect.x).toBe(4);
    expect(p!.rect.y).toBe(0);
    expect(p!.rect.width).toBe(80);
  });
});

describe("the element on the clipboard", () => {
  it("leads with what it is and where it was", () => {
    const s = elementForClipboard(el(), "https://shop.test/cart");
    expect(s).toContain("button#buy — 120×40 on https://shop.test/cart");
    expect(s).toContain("selector: main > div:nth-of-type(2) > button");
    expect(s).toContain("<button id=\"buy\"");
  });

  it("leaves the text line out when there is no text", () => {
    expect(elementForClipboard(el({ text: "" }), "https://x.test/")).not.toContain("text:");
  });
});

describe("the briefing", () => {
  const brief = (over: Partial<Parameters<typeof pageFeedbackPrompt>[0]> = {}) =>
    pageFeedbackPrompt({ url: "https://shop.test/cart", title: "Cart", intent: "change", ask: "make it green", element: el(), ...over });

  it("leads with the ask, because that is the part a person wrote", () => {
    const lines = brief().split("\n");
    expect(lines[0]).toContain("changed");
    expect(brief()).toContain("What I want: make it green");
  });

  it("names the page and the selector before the markup", () => {
    const s = brief();
    expect(s.indexOf("Selector:")).toBeLessThan(s.indexOf("```html"));
    expect(s).toContain("URL:      https://shop.test/cart");
  });

  it("draws the do-not-commit line, the same one the conflict handoff draws", () => {
    expect(brief()).toContain("Do not commit");
  });

  it("tells a question not to change anything", () => {
    const s = brief({ intent: "question" });
    expect(s).toContain("question");
    expect(s).toContain("Do not change anything");
    expect(s).not.toContain("Do not commit");
  });

  it("admits when nothing was written rather than sending an empty ask", () => {
    expect(brief({ ask: "   " })).toContain("(nothing written — ask me)");
  });

  it("shows only the first few classes — a framework's class list is not information", () => {
    const s = brief();
    expect(s).toContain(".btn.btn-primary.is-loading.extra");
    expect(s).not.toContain(".another");
  });

  it("survives a page with no title", () => {
    expect(brief({ title: "" })).toContain("(untitled)");
  });
});

describe("what the tmux window is called", () => {
  it("is named after the site, so it is findable in a list", () => {
    expect(feedbackWindowName("https://shop.test/cart?x=1")).toBe("page-shop");
  });

  it("drops the www, which names nothing", () => {
    expect(feedbackWindowName("https://www.github.com/x")).toBe("page-github");
  });

  it("falls back rather than throwing on something that is not a URL", () => {
    expect(feedbackWindowName("about:blank")).toBe("page");
  });

  it("stays short enough for a tmux list", () => {
    expect(feedbackWindowName("https://an-extremely-long-subdomain-name-here.example.com/").length).toBeLessThanOrEqual(24);
  });
});
