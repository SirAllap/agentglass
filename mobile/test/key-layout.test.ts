/*
 * Which keys the accessory bar draws, and in what order.
 *
 * The failure this file exists for is a bar that quietly lost Ctrl+C. Every
 * rule below is one where getting it wrong produces a plausible-looking strip
 * of keys with something missing from it, on the screen where the missing
 * thing is how you stop a runaway command.
 */
import { describe, expect, test } from "bun:test";
import type { AccessoryKey } from "../src/terminal/keys.ts";
import {
  DEFAULT_LAYOUT, apply, canHide, move, parse, reset, rows, serialise, toggle,
} from "../src/terminal/keyLayout.ts";

const key = (id: string): AccessoryKey => ({ id, label: id, bytes: id, spoken: id });
const CAT = [key("esc"), key("ctrlC"), key("up"), key("down"), key("tab")];
const ids = (list: { id: string }[]): string[] => list.map((k) => k.id);

describe("with nothing chosen", () => {
  test("the catalogue's own order, nothing hidden", () => {
    expect(ids(apply(DEFAULT_LAYOUT, CAT))).toEqual(["esc", "ctrlC", "up", "down", "tab"]);
  });
});

describe("the stored order", () => {
  test("named keys come first, in the order given", () => {
    expect(ids(apply({ order: ["tab", "esc"], hidden: [] }, CAT)))
      .toEqual(["tab", "esc", "ctrlC", "up", "down"]);
  });

  test("a key the catalogue gained appears rather than vanishing", () => {
    // The reason the stored shape is an order plus a hidden set and NOT an
    // allow-list: with a list, a key added in a later version would be
    // invisible to everybody who had ever opened the settings screen.
    const grown = [...CAT, key("ctrlR")];
    expect(ids(apply({ order: ["tab"], hidden: [] }, grown))).toContain("ctrlR");
  });

  test("an id that no longer exists is dropped, not kept as a hole", () => {
    expect(ids(apply({ order: ["gone", "tab"], hidden: [] }, CAT)))
      .toEqual(["tab", "esc", "ctrlC", "up", "down"]);
  });

  test("a duplicate in the stored order places once", () => {
    // A stored order is data from an older build and cannot be trusted to be a
    // permutation of anything.
    expect(ids(apply({ order: ["tab", "tab", "esc"], hidden: [] }, CAT)))
      .toEqual(["tab", "esc", "ctrlC", "up", "down"]);
  });
});

describe("hiding", () => {
  test("a hidden key is not drawn", () => {
    expect(ids(apply({ order: [], hidden: ["up"] }, CAT)))
      .toEqual(["esc", "ctrlC", "down", "tab"]);
  });

  test("hidden wins over a stored order that names it", () => {
    expect(ids(apply({ order: ["up", "esc"], hidden: ["up"] }, CAT)))
      .toEqual(["esc", "ctrlC", "down", "tab"]);
  });

  test("a hidden id the catalogue does not have is harmless", () => {
    expect(ids(apply({ order: [], hidden: ["gone"] }, CAT))).toEqual(ids(CAT));
  });

  test("the last visible key cannot be hidden", () => {
    // An empty bar is a terminal with no Escape and no Ctrl+C, reachable in
    // two taps, with the way back on a different screen.
    const bare: ReturnType<typeof toggle> = { order: [], hidden: ["ctrlC", "up", "down", "tab"] };
    expect(canHide(bare, CAT, "esc")).toBe(false);
    expect(toggle(bare, CAT, "esc")).toEqual(bare);
    expect(apply(toggle(bare, CAT, "esc"), CAT)).toHaveLength(1);
  });

  test("anything else can be", () => {
    expect(canHide(DEFAULT_LAYOUT, CAT, "esc")).toBe(true);
  });

  test("toggling twice is where it started", () => {
    const once = toggle(DEFAULT_LAYOUT, CAT, "tab");
    expect(ids(apply(once, CAT))).not.toContain("tab");
    expect(ids(apply(toggle(once, CAT, "tab"), CAT))).toContain("tab");
  });
});

describe("moving", () => {
  test("one place earlier", () => {
    expect(ids(apply(move(DEFAULT_LAYOUT, CAT, "up", -1), CAT)))
      .toEqual(["esc", "up", "ctrlC", "down", "tab"]);
  });

  test("one place later", () => {
    expect(ids(apply(move(DEFAULT_LAYOUT, CAT, "esc", 1), CAT)))
      .toEqual(["ctrlC", "esc", "up", "down", "tab"]);
  });

  test("off either end does nothing", () => {
    expect(move(DEFAULT_LAYOUT, CAT, "esc", -1)).toEqual(DEFAULT_LAYOUT);
    expect(ids(apply(move(DEFAULT_LAYOUT, CAT, "tab", 1), CAT))).toEqual(ids(CAT));
  });

  test("a hidden key keeps its place for when it comes back", () => {
    // Unhiding must not send a key to the back of a bar it used to be near the
    // front of.
    let l = toggle(DEFAULT_LAYOUT, CAT, "ctrlC");
    l = move(l, CAT, "tab", -1);
    l = toggle(l, CAT, "ctrlC");
    expect(ids(apply(l, CAT))).toContain("ctrlC");
  });

  test("moving something hidden does nothing", () => {
    const l = toggle(DEFAULT_LAYOUT, CAT, "up");
    expect(move(l, CAT, "up", -1)).toEqual(l);
  });
});

describe("the settings list", () => {
  test("visible ones first in bar order, hidden ones after", () => {
    const l = toggle(DEFAULT_LAYOUT, CAT, "ctrlC");
    const list = rows(l, CAT);
    expect(list.map((r) => r.key.id)).toEqual(["esc", "up", "down", "tab", "ctrlC"]);
    expect(list.map((r) => r.shown)).toEqual([true, true, true, true, false]);
  });

  test("every key in the catalogue appears exactly once", () => {
    const list = rows(toggle(DEFAULT_LAYOUT, CAT, "tab"), CAT);
    expect(list).toHaveLength(CAT.length);
    expect(new Set(list.map((r) => r.key.id)).size).toBe(CAT.length);
  });
});

describe("what is stored", () => {
  test("a round trip keeps the layout", () => {
    const l = move(toggle(DEFAULT_LAYOUT, CAT, "up"), CAT, "tab", -1);
    expect(parse(serialise(l))).toEqual(l);
  });

  test("nothing stored is the default", () => {
    expect(parse(null)).toEqual(DEFAULT_LAYOUT);
    expect(parse("")).toEqual(DEFAULT_LAYOUT);
  });

  test("rubbish is the default rather than a throw", () => {
    // A keystore value is the one input here that can come from a different
    // version of the app, and a throw on a cold start is a phone that cannot
    // draw its terminal because of a preference.
    expect(parse("not json")).toEqual(DEFAULT_LAYOUT);
    expect(parse("[1,2,3]")).toEqual(DEFAULT_LAYOUT);
    expect(parse('{"order":"tab","hidden":7}')).toEqual(DEFAULT_LAYOUT);
  });

  test("non-strings inside the arrays are dropped", () => {
    expect(parse('{"order":["tab",5,null],"hidden":[{}]}')).toEqual({ order: ["tab"], hidden: [] });
  });

  test("reset is the default and is a fresh object", () => {
    const r = reset();
    expect(r).toEqual(DEFAULT_LAYOUT);
    r.hidden.push("esc");
    expect(DEFAULT_LAYOUT.hidden).toEqual([]);
  });
});
