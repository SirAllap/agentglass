/*
 * The guide observer and FIND must call a node by the same name and role, or a
 * run step whose target point and interactive find is said to be lost. Measured:
 * a Wikipedia-shaped Contents link holds a CSS-hidden number span, so its
 * textContent is "1History" while FIND (innerText) calls it "History".
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { ACC_NAME } from "../../web/src/lib/browserObserve.ts";

const require = createRequire(import.meta.url);
const { nameOf, hasRole, nameFits, matchRank } = require("../../electron/guide-observer.js") as {
  matchRank: (got: string, want: string | undefined, exact: boolean | undefined, hidden: boolean) => number;
  nameOf: (el: unknown) => string;
  hasRole: (el: unknown, role: string) => boolean;
  nameFits: (got: string, want: string, exact?: boolean) => boolean;
};
/* FIND's name for a role= locator: ACC_NAME, then alt (browserLocator.ts). */
const accName = new Function(`return ${ACC_NAME}`)() as (el: unknown) => string;
const findName = (el: { getAttribute: (k: string) => string | null }) =>
  String(accName(el) || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();

type Fake = { tagName: string; attrs?: Record<string, string>; innerText?: string; textContent?: string; type?: string; multiple?: boolean; size?: number; labels?: { innerText: string }[] };
const el = (f: Fake) => ({
  tagName: f.tagName.toUpperCase(), innerText: f.innerText ?? "", textContent: f.textContent ?? f.innerText ?? "",
  type: f.type, multiple: f.multiple ?? false, size: f.size ?? 0, labels: f.labels,
  getAttribute: (k: string) => (f.attrs && k in f.attrs ? f.attrs[k]! : null),
  hasAttribute: (k: string) => !!f.attrs && k in f.attrs,
});

describe("guide observer names nodes as FIND does", () => {
  it("a TOC link with a hidden number span is History, not 1History", () => {
    const toc = el({ tagName: "a", attrs: { href: "#History" }, innerText: "History", textContent: "1History" });
    expect(nameOf(toc)).toBe("History");
    expect(nameOf(toc)).toBe(findName(toc));
    expect(hasRole(toc, "link")).toBe(true);
    expect(nameFits(nameOf(toc), "History")).toBe(true);
  });

  it("agrees with FIND's name order on labels, placeholder, title and alt", () => {
    const cases = [
      el({ tagName: "button", attrs: { "aria-label": "Close", title: "x" }, innerText: "×" }),
      el({ tagName: "input", type: "email", labels: [{ innerText: "Email" }], attrs: { placeholder: "you@x" } }),
      el({ tagName: "input", type: "search", attrs: { placeholder: "Search" } }),
      el({ tagName: "a", attrs: { href: "/", title: "Home" }, innerText: "" }),
      el({ tagName: "img", attrs: { alt: "Logo" } }),
      el({ tagName: "button", innerText: "  Save\n  draft " }),
    ];
    for (const c of cases) expect(nameOf(c)).toBe(findName(c));
  });

  it("agrees with FIND on link, button and combobox roles", () => {
    expect(hasRole(el({ tagName: "a" }), "link")).toBe(false);
    expect(hasRole(el({ tagName: "a", attrs: { href: "/" } }), "link")).toBe(true);
    expect(hasRole(el({ tagName: "input", type: "submit" }), "button")).toBe(true);
    expect(hasRole(el({ tagName: "div", attrs: { role: "button tab" } }), "button")).toBe(true);
    expect(hasRole(el({ tagName: "button", attrs: { role: "tab" } }), "button")).toBe(false);
    expect(hasRole(el({ tagName: "select" }), "combobox")).toBe(true);
    expect(hasRole(el({ tagName: "select", multiple: true }), "combobox")).toBe(false);
    expect(hasRole(el({ tagName: "input", attrs: { role: "combobox" } }), "combobox")).toBe(true);
  });

  it("compares a name as FIND does: contains, ignoring case, unless exact", () => {
    expect(nameFits("History of it", "history")).toBe(true);
    expect(nameFits("History of it", "history", true)).toBe(false);
  });

  it("prefers the whole name and a node on screen: History is not View history", () => {
    const visibleToc = matchRank("History", "History", undefined, false);
    const hiddenTab = matchRank("View history", "History", undefined, true);
    const visibleTab = matchRank("View history", "History", undefined, false);
    const hiddenToc = matchRank("History", "History", undefined, true);
    expect(visibleToc).toBe(0);
    expect(visibleToc).toBeLessThan(visibleTab);
    expect(visibleTab).toBeLessThan(hiddenToc);
    expect(hiddenToc).toBeLessThan(hiddenTab);
    expect(matchRank("Contents", "History", undefined, false)).toBe(-1);
    expect(matchRank("history", "History", true, false)).toBe(-1);
  });
});
