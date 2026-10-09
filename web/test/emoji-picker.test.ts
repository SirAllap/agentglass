/*
 * The emoji button on the card composer.
 *
 * A picker is mostly small decisions that a screenshot cannot pin: that an
 * emoji lands over the selection and leaves the caret after it, that a two-unit
 * character is never cut in half, that arrow keys survive a short last row, and
 * that the popover is placed inside the window instead of clipped by the pane.
 * All of it lives in plain functions, asserted here; the component is asserted
 * against its source, because there is no renderer in this project.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { insertText } from "../src/lib/mdEditor.ts";
import {
  CATEGORIES, DEFAULT_RECENT, EMOJI, RECENT_KEY, RECENT_MAX, moveInGrid, popoverPlace, pushRecent, readRecent, searchEmoji, writeRecent,
} from "../src/lib/emojiData.ts";

const composer = await Bun.file(new URL("../src/components/tasks/Composer.tsx", import.meta.url)).text();
const picker = await Bun.file(new URL("../src/components/tasks/EmojiPicker.tsx", import.meta.url)).text();

describe("the dataset", () => {
  it("has no repeated emoji, and every one has a category and a name", () => {
    const seen = new Set<string>();
    const ids = new Set(CATEGORIES.map((c) => c.id));
    for (const e of EMOJI) {
      expect(seen.has(e.char)).toBe(false);
      seen.add(e.char);
      expect(ids.has(e.cat)).toBe(true);
      expect(e.words.length).toBeGreaterThan(0);
      expect(e.words.every((w) => w.length > 0)).toBe(true);
      // The glyph column must not have swallowed a keyword: an emoji has no letters.
      expect(/[a-z0-9]/i.test(e.char.replace(/^[#*0-9]️⃣$/u, ""))).toBe(false);
    }
  });

  it("is about the size of a curated table, and no category is empty", () => {
    expect(EMOJI.length).toBeGreaterThanOrEqual(250);
    expect(EMOJI.length).toBeLessThanOrEqual(600);
    for (const c of CATEGORIES) expect(EMOJI.some((e) => e.cat === c.id)).toBe(true);
  });

  it("holds every default 'frequently used' emoji", () => {
    for (const c of DEFAULT_RECENT) expect(EMOJI.some((e) => e.char === c)).toBe(true);
  });
});

describe("search", () => {
  it("finds the flame by 'fire', names first", () => {
    const hits = searchEmoji("fire").map((e) => e.char);
    expect(hits[0]).toBe("🔥");
    expect(hits).toContain("🚒");
  });
  it("matches the words of a multi-word name in any order", () => {
    expect(searchEmoji("eyes heart").map((e) => e.char)).toContain("😍");
  });
  it("does not match two letters in the middle of a word, and empty is everything", () => {
    expect(searchEmoji("ir").map((e) => e.char)).not.toContain("🔥");
    expect(searchEmoji("  ")).toHaveLength(EMOJI.length);
    expect(searchEmoji("zzzzqq")).toEqual([]);
  });
});

describe("inserting at the caret", () => {
  const at = (text: string, start: number, end = start) => ({ text, start, end });
  it("puts it at the caret and leaves the caret after it", () => {
    expect(insertText(at("ab", 1), "🔥")).toEqual({ text: "a🔥b", start: 3, end: 3 });
  });
  it("replaces the selection", () => {
    expect(insertText(at("hello", 1, 4), "🙏")).toEqual({ text: "h🙏o", start: 3, end: 3 });
  });
  it("works on an empty box and at the end of the text", () => {
    expect(insertText(at("", 0), "😀")).toEqual({ text: "😀", start: 2, end: 2 });
    expect(insertText(at("done ", 5), "✅")).toEqual({ text: "done ✅", start: 6, end: 6 });
  });
  it("counts a joined sequence as one thing and moves the caret by all of it", () => {
    const dev = "🧑‍💻"; // person + ZWJ + laptop
    const out = insertText(at("x", 1), dev);
    expect(out.text).toBe("x" + dev);
    expect(out.start).toBe(1 + dev.length);
    expect(out.text.slice(out.start)).toBe("");
  });
  it("never splits a surrogate pair that the offsets landed inside", () => {
    // 🔥 is two UTF-16 units; offset 1 is between them.
    expect(insertText(at("🔥", 1), "🙏").text).toBe("🙏🔥");
    expect(insertText(at("🔥x", 1, 2), "🙏").text).toBe("🙏x");
    expect(insertText(at("a🔥", 2, 3), "!").text).toBe("a!");
  });
  it("takes a backwards selection as the same range", () => {
    expect(insertText(at("hello", 4, 1), "🙏").text).toBe("h🙏o");
  });
});

describe("frequently used", () => {
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });
  it("puts the last one first, once, and stays short", () => {
    expect(pushRecent(["🙏", "🔥"], "🔥")).toEqual(["🔥", "🙏"]);
    const long = pushRecent(EMOJI.slice(0, RECENT_MAX).map((e) => e.char), "😀");
    expect(long).toHaveLength(RECENT_MAX);
    expect(long[0]).toBe("😀");
  });
  it("falls back to the default row with no storage at all", () => {
    expect(readRecent()).toEqual(DEFAULT_RECENT);
  });
  it("reads what was stored, drops what it does not know, and survives garbage", () => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    writeRecent(["🔥", "🙏"]);
    expect(readRecent()).toEqual(["🔥", "🙏"]);
    mem.set(RECENT_KEY, JSON.stringify(["🔥", "not-an-emoji", 4]));
    expect(readRecent()).toEqual(["🔥"]);
    mem.set(RECENT_KEY, "{oops");
    expect(readRecent()).toEqual(DEFAULT_RECENT);
    mem.set(RECENT_KEY, "[]");
    expect(readRecent()).toEqual(DEFAULT_RECENT);
  });
  it("does not throw when storage refuses", () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(() => writeRecent(["🔥"])).not.toThrow();
    expect(readRecent()).toEqual(DEFAULT_RECENT);
  });
});

describe("arrow keys in the grid", () => {
  // a full row of 8, a short one of 3, a full row again
  const rows = [8, 3, 8];
  it("walks right across the end of a row and stops at the very end", () => {
    expect(moveInGrid(rows, { r: 0, c: 7 }, "ArrowRight")).toEqual({ r: 1, c: 0 });
    expect(moveInGrid(rows, { r: 2, c: 7 }, "ArrowRight")).toEqual({ r: 2, c: 7 });
  });
  it("walks left back onto the last cell of the row above", () => {
    expect(moveInGrid(rows, { r: 1, c: 0 }, "ArrowLeft")).toEqual({ r: 0, c: 7 });
    expect(moveInGrid(rows, { r: 0, c: 0 }, "ArrowLeft")).toEqual({ r: 0, c: 0 });
  });
  it("clamps the column onto a short row and does not lose it going on", () => {
    expect(moveInGrid(rows, { r: 0, c: 6 }, "ArrowDown")).toEqual({ r: 1, c: 2 });
    expect(moveInGrid(rows, { r: 1, c: 2 }, "ArrowUp")).toEqual({ r: 0, c: 2 });
    expect(moveInGrid(rows, { r: 2, c: 0 }, "ArrowDown")).toEqual({ r: 2, c: 0 });
  });
  it("has nowhere to go in an empty grid", () => {
    expect(moveInGrid([], { r: 0, c: 0 }, "ArrowDown")).toEqual({ r: 0, c: 0 });
  });
});

describe("where the popover goes", () => {
  const size = { width: 252, height: 330 };
  const view = { width: 1000, height: 800 };
  const box = (left: number, top: number) => ({ left, top, bottom: top + 24, right: left + 24 });
  it("sits above the button when it fits", () => {
    const p = popoverPlace(box(300, 500), size, view);
    expect(p.up).toBe(true);
    expect(p.top + p.height).toBeLessThanOrEqual(500);
  });
  it("goes below when above has no room and below has more", () => {
    const p = popoverPlace(box(300, 80), size, view);
    expect(p.up).toBe(false);
    expect(p.top).toBeGreaterThanOrEqual(104);
    expect(p.top + p.height).toBeLessThanOrEqual(view.height);
  });
  it("shrinks to the room there is instead of running off the window", () => {
    const p = popoverPlace(box(300, 200), size, { width: 1000, height: 420 });
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.top + p.height).toBeLessThanOrEqual(420);
  });
  it("is pulled back inside the window at the right edge and at the left", () => {
    expect(popoverPlace(box(900, 500), size, view).left + size.width).toBeLessThanOrEqual(view.width);
    expect(popoverPlace(box(-30, 500), size, view).left).toBeGreaterThanOrEqual(0);
  });
  it("fits the narrow sidebar: 270px wide", () => {
    const p = popoverPlace(box(200, 500), size, { width: 270, height: 800 });
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.left + size.width).toBeLessThanOrEqual(270);
  });
});

describe("the button and the popover, in source", () => {
  it("sits right after the mention button and before Preview, named 'Add emoji'", () => {
    const at = composer.indexOf('title="Mention somebody');
    const add = composer.indexOf('title="Add emoji"');
    const preview = composer.indexOf('{preview ? "Write" : "Preview"}');
    expect(at).toBeGreaterThan(0);
    expect(add).toBeGreaterThan(at);
    expect(preview).toBeGreaterThan(add);
    // and it never takes the textarea's selection away by taking focus on press
    expect(composer.slice(add, composer.indexOf("</button>", add))).toContain("onMouseDown={(e) => e.preventDefault()}");
  });
  it("hands the choice to run(), so the caret and focus go back to the box", () => {
    const fn = composer.slice(composer.indexOf("const putEmoji ="), composer.indexOf("/** Re-read the mention"));
    expect(fn).toContain("run((s) => insertText(s, ch))");
    expect(fn).toContain("if (!keep) setEmojiAt(null)");
  });
  it("is a dialog drawn through a portal on the menu layer, closed by Escape and an outside press", () => {
    expect(picker).toContain('role="dialog"');
    expect(picker).toContain("<Portal z={LAYER.menu}>");
    expect(picker).toContain('e.key === "Escape"');
    expect(picker).toContain('addEventListener("mousedown"');
    expect(picker).toContain('role="grid"');
    expect(picker).toContain('role="gridcell"');
  });
});
