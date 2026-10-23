import { describe, expect, test } from "bun:test";
import { STYLE_MAX, applyStyle, cleanStyle, isEmoji, pick, readStyles } from "../src/lib/finderStyles.ts";

describe("what a person chose for how an item looks", () => {
  test("only what the finder can draw is kept", () => {
    expect(cleanStyle({ color: "#E5484D", icon: "pin", emoji: "📌", junk: 1 })).toEqual({ color: "#e5484d", icon: "pin", emoji: "📌" });
    expect(cleanStyle({ color: "red", icon: "not-an-icon", emoji: "ab" })).toBeNull();
    expect(cleanStyle("x")).toBeNull();
  });
  test("an emoji is one grapheme, not a letter", () => {
    expect(isEmoji("📁")).toBe(true);
    expect(isEmoji("👩‍💻")).toBe(true);
    expect(isEmoji("a")).toBe(false);
    expect(isEmoji("📁📁")).toBe(false);
    expect(isEmoji("")).toBe(false);
  });
  test("reading drops what is not an absolute path or not a style, and survives bad JSON", () => {
    expect(readStyles('{"/a/b":{"color":"#112233"},"rel":{"icon":"pin"},"/":{"icon":"pin"},"/c":{"icon":"zz"}}')).toEqual({ "/a/b": { color: "#112233" } });
    expect(readStyles("{nope")).toEqual({});
    expect(readStyles(null)).toEqual({});
    expect(readStyles("[]")).toEqual({});
  });
  test("applying sets every path, and an empty style clears them", () => {
    const s = applyStyle({}, ["/a", "/b"], { icon: "pin" });
    expect(s).toEqual({ "/a": { icon: "pin" }, "/b": { icon: "pin" } });
    expect(applyStyle(s, ["/a"], {})).toEqual({ "/b": { icon: "pin" } });
  });
  test("a full store refuses a new path but still changes one it has", () => {
    let s = {} as Record<string, { icon: string }>;
    for (let i = 0; i < STYLE_MAX; i++) s[`/p${i}`] = { icon: "pin" };
    expect(Object.keys(applyStyle(s, ["/new"], { icon: "play" }))).toHaveLength(STYLE_MAX);
    expect(applyStyle(s, ["/p0"], { icon: "play" })["/p0"]).toEqual({ icon: "play" });
  });
  test("an icon and an emoji exclude each other; the colour stays", () => {
    expect(pick({ icon: "pin", color: "#112233" }, { emoji: "📌" })).toEqual({ emoji: "📌", color: "#112233" });
    expect(pick({ emoji: "📌" }, { icon: "play" })).toEqual({ icon: "play" });
    expect(pick({ color: "#112233" }, { clearColor: true })).toEqual({});
  });
});
