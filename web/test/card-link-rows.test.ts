/*
 * The GitHub tab of a card has two kinds of row that end in buttons: a pull
 * request and an "Other link". They were drawn by different code — a small
 * bordered arrow on one, bare glyph chips centred in a taller block on the
 * other — so the arrows sat at different heights and different sizes. Both
 * now come from one row class and one square, and a rule about source is
 * asserted against source (there is no renderer here).
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

const block = (from: string, to: string) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};
const prRows = block("{prs.map((p) => (", "No pull request names this card yet.");
const otherRows = block("{others.map((l) => (", "</>)}");

describe("card link rows", () => {
  it("draw both kinds of row from the one row class", () => {
    expect(prRows).toContain("className={LINK_ROW}");
    expect(otherRows).toContain("className={LINK_ROW}");
    expect(src).toContain('const LINK_ROW = "flex items-start gap-2 py-1"');
  });
  it("end both in the same square, arrow last so the columns line up", () => {
    expect(prRows).toContain("<RowSquare href={p.url}");
    expect(otherRows.indexOf("<CopyLinkChip")).toBeLessThan(otherRows.indexOf("<RowSquare title=\"Open in your browser\""));
    expect(otherRows).not.toContain("<IconChip");
  });
  it("gives the copy button the same square and the house icon size", () => {
    const chip = block("function CopyLinkChip(", "\n}\n");
    expect(chip).toContain("<RowSquare");
    expect(chip).toContain("ICON.xs");
    expect(chip).toContain("1200");
  });
  it("sizes the square with HIT, not a number of its own", () => {
    expect(block("const ROW_SQUARE", ";\n")).toContain("width: HIT, height: HIT");
  });
});
