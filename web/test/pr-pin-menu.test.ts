/*
 * The pinned pull requests are one bar control with a count and a menu.
 *
 * They were a strip of chips that scrolled under arrows, and past a handful the
 * strip was either cut or pushed the bar around. One control is the same size
 * with 0 pins and with 30. The decisions are numbers, tested as numbers; the
 * markup is asserted against source, because there is no renderer here. The
 * edge-fade and paging helpers below belong to the shared tab strip (the
 * terminal tabs use them), so their tests stay.
 */
import { describe, expect, it } from "bun:test";
import { edgeMask, overflowEdges, stepX } from "../src/lib/tabStrip.ts";
import { filterPins, type Pin } from "../src/lib/prPins.ts";

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/** Comments out, so a word in prose does not satisfy or fail a guard. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

/** The menu's own source, to its closing brace. */
const menu = (() => {
  const a = panel.indexOf("function PinMenu(");
  const b = panel.indexOf("\n}\n", a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return code(panel.slice(a, b));
})();

describe("which arrows show", () => {
  // scrollLeft, clientWidth, scrollWidth: eight chips in a 400px strip.
  const arrows = (l: number, c: number, w: number) => overflowEdges(l, c, w);

  it("none when the chips fit", () => {
    expect(arrows(0, 400, 400)).toEqual({ start: false, end: false });
    expect(arrows(0, 400, 280)).toEqual({ start: false, end: false });
  });
  it("only the one ahead at the start, only the one behind at the end, both between", () => {
    expect(arrows(0, 400, 1100)).toEqual({ start: false, end: true });
    expect(arrows(700, 400, 1100)).toEqual({ start: true, end: false });
    expect(arrows(300, 400, 1100)).toEqual({ start: true, end: true });
  });
  it("a fractional end on a zoomed display is the end", () => {
    expect(arrows(699.5, 400, 1100)).toEqual({ start: true, end: false });
  });
});

describe("what an arrow does", () => {
  const v = { scrollLeft: 0, clientWidth: 400, scrollWidth: 1100 };
  it("pages three quarters of the strip toward its side", () => {
    expect(stepX(v, 1)).toBe(300);
    expect(stepX({ ...v, scrollLeft: 300 }, -1)).toBe(0);
  });
  it("stops at the ends", () => {
    expect(stepX({ ...v, scrollLeft: 600 }, 1)).toBe(700);
  });
  it("does nothing toward a side with nothing hidden", () => {
    expect(stepX(v, -1)).toBeNull();
    expect(stepX({ ...v, scrollLeft: 700 }, 1)).toBeNull();
    expect(stepX({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }, 1)).toBeNull();
  });
});

describe("the fade holds room for the arrow", () => {
  it("is transparent under the arrow before it starts to fade", () => {
    expect(edgeMask({ start: true, end: false }, 22)).toBe("linear-gradient(to right, transparent 0, transparent 22px, #000 46px, #000 100%)");
    expect(edgeMask({ start: false, end: true }, 22)).toBe("linear-gradient(to right, #000 0, #000 calc(100% - 46px), transparent calc(100% - 22px), transparent 100%)");
  });
});

const pin = (number: number, title: string): Pin => ({ repo: "acme/orbit", number, title, at: number });

describe("filtering the pins", () => {
  const list = [pin(1042, "Add the thing"), pin(77, "Fix orbit docs"), pin(1500, "Rename widgets")];
  it("matches a number or a title, any case", () => {
    expect(filterPins(list, "104").map((p) => p.number)).toEqual([1042]);
    expect(filterPins(list, "ORBIT").map((p) => p.number)).toEqual([77]);
  });
  it("ignores a leading # and surrounding space", () => {
    expect(filterPins(list, " #77 ").map((p) => p.number)).toEqual([77]);
  });
  it("returns everything for an empty box and nothing for a miss", () => {
    expect(filterPins(list, "")).toHaveLength(3);
    expect(filterPins(list, "zzz")).toEqual([]);
  });
});

describe("the pin menu in source", () => {
  it("the bar control is the bar's own size, never one of its own", () => {
    expect(menu).toContain("`agx-btn ${BAR_CTRL}`");
    expect(menu).toContain("<PinIcon size={BAR_ICON}");
  });

  it("with no pins it stays in place: disabled, greyed, not-allowed, explained", () => {
    expect(menu).toContain("disabled={none}");
    expect(menu).toContain("opacity: none ? 0.5 : 1");
    expect(menu).toContain('cursor: none ? "not-allowed"');
    expect(menu).toContain('"No pinned pull requests"');
    // The count only draws when there is one; the control itself is never conditional.
    expect(menu).toContain("{!none && <span");
    expect(code(panel)).not.toMatch(/pinned\.length > 0 && \(\s*<PinMenu/);
  });

  it("opens an anchored menu 420px wide whose list scrolls on its own", () => {
    expect(menu).toContain("<AnchoredMenu");
    expect(panel).toContain("const PIN_MENU_W = 420;");
    expect(menu).toContain("overflow-y-auto");
    expect(menu).toContain("maxHeight: 336");
  });

  it("the filter box appears past eight pins", () => {
    expect(panel).toContain("const PIN_FILTER_FROM = 8;");
    expect(menu).toContain("pinned.length > PIN_FILTER_FROM");
    expect(menu).toContain("filterPins(pinned, q)");
  });

  it("a row opens the pull request and the x unpins without closing the menu", () => {
    expect(menu).toContain("onOpen(p.number)");
    expect(menu).toContain("aria-label={`Unpin #${p.number}`}");
    expect(menu).toContain("togglePin(p.repo, p.number, p.title)");
    const unpin = menu.slice(menu.indexOf("togglePin(p.repo"));
    expect(unpin.slice(0, unpin.indexOf("</button>"))).not.toContain("close()");
  });

  it("closes itself when the last pin goes", () => {
    expect(menu).toContain("if (none && open) close()");
  });

  it("the old strip is gone, and so is anything that scrolls pins sideways", () => {
    expect(code(panel)).not.toContain("PinnedCapsule");
    expect(code(panel)).not.toContain("PinScroller");
    expect(code(panel)).not.toContain("PIN_ARROW_W");
  });

  it("the menu is mounted in the list bar and in the detail bar", () => {
    expect(code(panel).match(/<PinMenu /g)).toHaveLength(2);
  });
});
