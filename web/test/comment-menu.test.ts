/*
 * The "More actions" menu on a comment: where it is drawn, where it opens, and
 * what a row in it looks like.
 *
 * Measured on a fixture, before: a four-row menu opened from a comment card
 * sitting 60px above the bottom of its scroller was cut off by the card
 * (`overflow: hidden`) and lost the last row; the "Hide" row put its eye icon on
 * a line of its own; and the link and markdown rows led with `&#9033;`, a
 * character most fonts do not carry, drawn as a struck circle.
 *
 * There is no renderer in this project, so the decision (where it opens) is
 * tested as a function and the rest as rules about source, at the place they
 * are written.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MENU_GAP, MENU_MARGIN, placeMenu } from "../src/lib/menuPlacement.ts";

const src = (...p: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...p), "utf8");
const PANEL = src("components", "PrPanel.tsx");
const ANCHORED = src("components", "AnchoredMenu.tsx");

/** The text of one top-level function, up to its own closing brace. */
function fn(source: string, head: string): string {
  const at = source.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", at);
  expect(end).toBeGreaterThan(at);
  return source.slice(at, end);
}
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");

const VIEW = { width: 1000, height: 700 };
const SIZE = { width: 216, height: 140 };
const at = (top: number, right = 900): Parameters<typeof placeMenu>[0] => ({ top, bottom: top + 24, left: right - 24, right });

describe("placeMenu", () => {
  test("opens below the trigger when it fits", () => {
    const p = placeMenu(at(100), SIZE, VIEW);
    expect(p.side).toBe("below");
    expect(p.top).toBe(124 + MENU_GAP);
  });

  test("flips above when it does not fit below and above is roomier", () => {
    // A trigger 60px above the bottom edge: the fixture's comment near the foot of a scroller.
    const p = placeMenu(at(616), SIZE, VIEW);
    expect(p.side).toBe("above");
    expect(p.top + SIZE.height).toBe(616 - MENU_GAP);
  });

  test("never leaves the window, in either direction", () => {
    for (const top of [0, 8, 100, 300, 500, 600, 676, 699]) {
      for (const right of [10, 240, 500, 990]) {
        const p = placeMenu(at(top, right), SIZE, VIEW);
        const h = Math.min(SIZE.height, p.maxHeight);
        expect(p.top).toBeGreaterThanOrEqual(0);
        expect(p.top + h).toBeLessThanOrEqual(VIEW.height);
        expect(p.left).toBeGreaterThanOrEqual(MENU_MARGIN);
        expect(p.left + SIZE.width).toBeLessThanOrEqual(VIEW.width - MENU_MARGIN);
      }
    }
  });

  test("stays below, capped, when neither side fits and below is the roomier", () => {
    const p = placeMenu(at(100), { width: 216, height: 900 }, VIEW);
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(VIEW.height - 124 - MENU_GAP - MENU_MARGIN);
  });

  test("aligns its right edge to the trigger by default and its left edge on request", () => {
    expect(placeMenu(at(100, 600), SIZE, VIEW).left).toBe(600 - SIZE.width);
    expect(placeMenu(at(100, 600), SIZE, VIEW, "left").left).toBe(576);
  });

  test("shifts back inside when the trigger is at the left edge", () => {
    expect(placeMenu(at(100, 30), SIZE, VIEW).left).toBe(MENU_MARGIN);
  });
});

describe("the menu is drawn outside the card", () => {
  const menu = code(fn(PANEL, "export function Menu("));

  test("Menu renders through AnchoredMenu, not as a child positioned inside its trigger", () => {
    expect(menu).toContain("<AnchoredMenu");
    expect(menu).not.toContain("absolute z-50");
    expect(menu).not.toContain("agx-menu");
  });

  test("AnchoredMenu portals at the menu layer and places with placeMenu", () => {
    const body = code(ANCHORED);
    expect(body).toContain("<Portal z={LAYER.menu}>");
    expect(body).toContain("placeMenu(");
    expect(body).toContain("menuEventGuards()");
    expect(body).not.toContain("absolute");
  });

  test("measures after the portal is attached, never in a layout effect", () => {
    // Portal appends its container in an effect, so a layout effect measures a
    // detached list: 0 by 0, which fits everywhere and never flips. Measured:
    // the menu opened at the trigger's right edge, off the window.
    const body = code(ANCHORED);
    expect(body).not.toContain("useLayoutEffect");
    expect(body).toContain("setPos(placeMenu(");
    expect(body).toContain('visibility: pos ? "visible" : "hidden"');
  });

  test("a click on the catcher closes the menu and does not reach the comment", () => {
    const body = code(ANCHORED);
    expect(body).toContain('className="fixed inset-0"');
    expect(body).toContain("onClick={onClose}");
  });

  test("the card that holds the menu still clips, which is why it must not be inside", () => {
    // If the card stops clipping this guard is moot; if it keeps clipping the menu must stay out.
    expect(fn(PANEL, "function Card(")).toContain('className="agx-card rounded-md overflow-hidden"');
  });
});

describe("keyboard", () => {
  const body = code(ANCHORED);
  test("arrows, Home, End, Escape and Tab are handled in the capture phase", () => {
    for (const k of ['"ArrowDown"', '"ArrowUp"', '"Home"', '"End"', '"Escape"', '"Tab"']) expect(body).toContain(k);
    expect(body).toContain('addEventListener("keydown", key, true)');
  });
  test("opens on the first row and hands focus back to the trigger on Escape", () => {
    // A caller may name the row to land on (`focus`); the first menuitem is the default.
    expect(body).toContain("?? ref.current?.querySelector<HTMLElement>(ITEMS)");
    expect(body).toContain("first?.focus(");
    expect(body).toContain('anchor.current?.querySelector<HTMLElement>("button")?.focus()');
  });
  test("every row a Menu offers is a menuitem", () => {
    expect(fn(PANEL, "export function MenuItem(")).toContain('role="menuitem"');
    expect(PANEL).not.toMatch(/<div role="button" tabIndex=\{0\}\s+onClick=\{\(\) => \{ close\(\); onPick/);
  });
});

describe("a row", () => {
  const item = fn(PANEL, "export function MenuItem(");

  test("is one line of icon and label, at one height", () => {
    expect(item).toContain("flex items-center");
    expect(item).toContain("minHeight: HIT");
    expect(item).toContain("whitespace-nowrap");
  });

  test("gives the icon a box at ICON.sm, so rows with and without one keep the label in line", () => {
    expect(item).toContain("width: ICON.sm, height: ICON.sm");
  });

  test("has hover, pressed and keyboard-focus states", () => {
    expect(PANEL).toContain(".agx-mi:hover{");
    expect(PANEL).toContain(".agx-mi:active{");
    expect(PANEL).toContain(".agx-mi:focus-visible{");
  });

  test("no row hands its icon in as a child, where it took a line of its own", () => {
    expect(PANEL).not.toMatch(/<MenuItem\b[^>]*>\s*<[A-Za-z]+Icon\b/);
  });

  test("no row leads with an HTML-entity glyph standing in for an icon", () => {
    expect(PANEL).not.toMatch(/<MenuItem\b[^>]*>\s*&#\d+;/);
  });

  test("the comment menu's icons are the house ones, sized from ICON", () => {
    const card = fn(PANEL, "function Card(");
    for (const icon of ["LinkIcon", "MarkdownIcon", "QuoteIcon", "EditIcon", "EyeIcon"]) {
      expect(card).toContain(`<${icon} size={ICON.sm} />`);
    }
  });
});
