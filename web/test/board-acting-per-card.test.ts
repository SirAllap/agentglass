import { describe, expect, test } from "bun:test";

/*
 * Two Updates pressed one after the other on the board are both in flight. The
 * card that was pressed first lost its "Working…" the moment the second was
 * pressed, because the panel held ONE number for "the card being acted on".
 * It holds a set now, and a card is working while its own number is in it.
 * A rule about source is asserted against source: there is no renderer here.
 */
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("the board marks every card that is being acted on", () => {
  test("the panel keeps a set of numbers and removes only its own", () => {
    const p = code(panel);
    expect(p).toContain("useState<ReadonlySet<number>>(new Set())");
    expect(p).not.toContain("setActingOn(null)");
    expect(p).not.toMatch(/setActingOn\(p\.number\)/);
  });
  test("a card is working while its own number is in the set", () => {
    const b = code(board);
    expect(b).toContain("const working = !!acting?.has(p.number);");
    expect(b).not.toContain("acting === p.number");
  });
});

describe("the narrow lane strip has air above it", () => {
  test("it pads its top as well as its bottom, so it never touches the view chips above", () => {
    const at = board.indexOf('aria-label="Lanes"');
    expect(at).toBeGreaterThan(-1);
    expect(board.slice(at, at + 120)).toContain("px-4 pt-2 pb-2");
  });
});
