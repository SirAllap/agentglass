/*
 * Reader mode on an open card: `r` opens it, Esc closes it, the description draws with JiraDescription's
 * own markup. The toggle's key check is pure (jiraReaderMode.ts); the card's wiring is read from source,
 * the same way the dock's own modes are (jira-dock-d2.test.ts) — a real keydown dispatch cannot prove
 * listener order across components, but the source can show the fix that keeps it right.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { opensReader } from "../src/lib/jiraReaderMode.ts";

const at = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const field = (tag: string, contentEditable = false) => ({ tagName: tag, isContentEditable: contentEditable }) as unknown as EventTarget;
const key = (k: string, o: Record<string, boolean> = {}) => ({ key: k, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...o });

describe("opensReader", () => {
  test("a bare r outside a field opens it", () => {
    expect(opensReader(key("r"), null)).toBe(true);
    expect(opensReader(key("r"), field("DIV"))).toBe(true);
  });
  test("with a modifier, or any other key, it does nothing", () => {
    expect(opensReader(key("r", { ctrlKey: true }), null)).toBe(false);
    expect(opensReader(key("r", { metaKey: true }), null)).toBe(false);
    expect(opensReader(key("r", { shiftKey: true }), null)).toBe(false);
    expect(opensReader(key("r", { altKey: true }), null)).toBe(false);
    expect(opensReader(key("R"), null)).toBe(false);
    expect(opensReader(key("e"), null)).toBe(false);
  });
  test("typing into a field swallows it", () => {
    expect(opensReader(key("r"), field("INPUT"))).toBe(false);
    expect(opensReader(key("r"), field("TEXTAREA"))).toBe(false);
    expect(opensReader(key("r"), field("SELECT"))).toBe(false);
    expect(opensReader(key("r"), field("DIV", true))).toBe(false);
  });
});

describe("the card's wiring, read from source", () => {
  const src = () => at("../src/components/jira/JiraCard.tsx").replace(/\/\*[\s\S]*?\*\//g, "");

  test("the reader's own keydown listener is added once, not on every toggle, so it stays ahead of the dock's", () => {
    const c = src();
    const from = c.indexOf("const [reading, setReading]");
    expect(from).toBeGreaterThan(-1);
    const block = c.slice(from, c.indexOf("<div ref={paneRef}", from));
    expect(block).toContain("document.addEventListener(\"keydown\", on)");
    // The listener effect's own dependency array is empty: it is registered once and never re-added.
    expect(block).toMatch(/document\.removeEventListener\("keydown", on\);\s*\}, \[\]\);/);
  });

  test("reading resets when another card opens", () => {
    const c = src();
    expect(c).toMatch(/useEffect\(\(\) => \{ setReading\(false\); \}, \[key\]\);/);
  });

  test("Escape inside reader mode marks the event used instead of letting it fall through", () => {
    const c = src();
    expect(c).toContain('if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); setReading(false); }');
  });

  test("the overlay draws only with a card read, and reuses JiraDescription for the text", () => {
    const c = src();
    expect(c).toContain('{reading && detail && (');
    expect(c).toContain('data-slot="jira-reader"');
    expect(c.match(/<JiraDescription/g)?.length).toBe(2); // the Card tab's own, and the reader's
    const from = c.indexOf('data-slot="jira-reader"');
    const readerBlock = c.slice(from, c.indexOf("</div>\n      )}\n    </div>", from));
    expect(readerBlock).toContain("<JiraDescription");
    expect(readerBlock).toContain("writes={false}");
  });

  test("the pane is `relative` so the overlay stays inside it, not over the whole window", () => {
    expect(src()).toContain('className="agx-jacc relative flex flex-col flex-1 min-w-0 min-h-0"');
  });
});
