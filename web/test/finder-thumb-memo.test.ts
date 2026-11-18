/*
 * A row's picture is not rendered again because another row was selected.
 *
 * The column re-renders every row on a selection change, and each row hands
 * its picture a fallback icon built new in that render, which defeats a plain
 * memo. The comparison leaves the fallback out: it depends only on the file
 * the other props already name.
 */
import { describe, expect, test } from "bun:test";
import { sameThumb } from "../src/components/finder/machine/Thumb.tsx";

const src = await Bun.file(new URL("../src/components/finder/machine/Thumb.tsx", import.meta.url)).text();
const p = { path: "/home/acme/orbit/shot.png", name: "shot.png", mtime: 1000, bytes: 600_000, size: 17, radius: 3 };

describe("the same picture", () => {
  test("the same file in the same box is the same, whatever fallback came with it", () => {
    expect(sameThumb({ ...p }, { ...p })).toBe(true);
    expect(sameThumb({ ...p, fallback: "one" } as typeof p, { ...p, fallback: "two" } as typeof p)).toBe(true);
  });
  test("a saved-over file, another file, or another box is not", () => {
    expect(sameThumb(p, { ...p, mtime: 1001 })).toBe(false);
    expect(sameThumb(p, { ...p, bytes: 600_001 })).toBe(false);
    expect(sameThumb(p, { ...p, path: "/home/acme/orbit/other.png", name: "other.png" })).toBe(false);
    expect(sameThumb(p, { ...p, size: 64 })).toBe(false);
    expect(sameThumb(p, { ...p, radius: 6 })).toBe(false);
    expect(sameThumb(p, { ...p, bytes: null })).toBe(false);
  });
  test("the component is a memo that compares with it", () => {
    expect(src).toContain("export const Thumb = memo(function Thumb(");
    expect(src.trimEnd().endsWith("}, sameThumb);")).toBe(true);
  });
});
