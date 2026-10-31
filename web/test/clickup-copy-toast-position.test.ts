/* The "copied" pill sat on the row, over the Due cell. It is said in the footer now. Read as source. */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("the copy confirmation on a card row", () => {
  it("is not drawn on the row at all", () => {
    expect(src).not.toContain("{said} copied");
    expect(src).not.toMatch(/-translate-y-1\/2 text-\[9\.5px\] px-1\.5 py-0\.5 rounded pointer-events-none/);
  });

  it("is handed to the board, which says it in its footer", () => {
    const i = src.indexOf("const copy = (v: string, what: string)");
    expect(src.slice(i, i + 300)).toContain("onSay?.(`${what} copied`)");
    expect(src).toContain("onSay={(text) => setNote({ ok: true, text })}");
  });
});
