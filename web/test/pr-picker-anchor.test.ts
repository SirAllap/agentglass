import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { pickAnchor } from "../src/lib/prPickerAnchor.ts";

const box = (left: number, w = 20, h = 20) => ({ left, width: w, height: h });

describe("pickAnchor", () => {
  it("prefers what was pressed", () => expect(pickAnchor(box(1), box(2), box(3)).left).toBe(1));
  it("a card menu pressed nothing in the detail: the header's ⋯", () => expect(pickAnchor(undefined, box(2), box(3)).left).toBe(2));
  it("a box with no area is not an anchor", () => expect(pickAnchor(box(1, 0, 0), box(2, 0, 0), box(3)).left).toBe(3));
  it("the middle is the last resort", () => expect(pickAnchor(null, null, box(3)).left).toBe(3));
});

describe("who uses it", () => {
  it("the panel's picker opens through it, with the masthead's ⋯ as the second choice", () => {
    const src = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
    const at = src.indexOf("const openAt = useCallback(");
    const body = src.slice(at, src.indexOf("\n  }, [ensureOptions]);", at));
    expect(body).toContain("pickAnchor(from,");
    expect(body).toContain("[data-masthead]");
  });
});
