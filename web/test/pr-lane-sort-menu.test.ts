import { describe, expect, test } from "bun:test";

const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
const sort = board.slice(board.indexOf("function SortButton("), board.indexOf("/** The mark in each lane's heading"));

// The menu used the workflow map's `wfm-opt` classes, whose CSS is injected only when that map is
// mounted: on a fresh load of the pull request view the rows were 16px, centred and unpadded.
describe("the lane sort menu", () => {
  test("is built from the shared menu rows, not from a stylesheet another screen injects", () => {
    expect(sort).not.toContain("wfm");
    expect(sort).toContain("<MenuRow");
    expect(sort).toContain("<MenuRule />");
  });
  test("is headed and carries the lane light, as the mockup draws it", () => {
    expect(sort).toContain("<PopHead>Sort this lane</PopHead>");
    expect(sort).toContain("Light only this lane");
    expect(sort).toContain("Light every lane again");
  });
});

describe("a result row beside the dock", () => {
  test("keeps its title column: the route track is capped and the meta line truncates instead of wrapping a word to a line", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toContain("grid-template-columns: 22px minmax(0, 1fr) fit-content(45%) auto");
    expect(board).toContain('<span className="min-w-0 truncate">#{p.number}');
  });
  test("under 560px the route and tags drop under the title, asked of the results box", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toContain("[data-results] { container: agx-res / inline-size; }");
    expect(css).toMatch(/@container agx-res \(max-width: 560px\) \{\s*\.agx-srow \{ grid-template-columns: 22px minmax\(0, 1fr\) auto;/);
  });
});

describe("a lane's header is one bar", () => {
  const head = board.slice(board.indexOf("<h3"), board.indexOf("</h3>"));
  test("count, sort and fold share the height, the radius and the glyph size", () => {
    expect(head).toMatch(/className="agx-btn rounded-lg px-1\.5 tabular-nums shrink-0"\s+style=\{\{ height: HIT/);
    expect(head).toContain('rounded-lg agx-hover"\n                          style={{ width: HIT, height: HIT, color: "var(--text4)" }}>\n                          <MinusIcon size={ICON.sm} />');
    expect(sort).toContain("grid place-items-center rounded-lg agx-hover");
    expect(sort).toContain("width={ICON.sm} height={ICON.sm}");
  });
});
