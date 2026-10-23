/*
 * One "N unread" chip, not two switches wearing the same label.
 *
 * The board kept its own `onlyUnread` state and drew its own chip, next to the
 * panel's filter bar drawing an identical chip over its own `unreadOnly` state.
 * The two never touched each other, so pressing the filter bar's chip on the
 * Board view changed nothing on screen — it toggled a state the board never
 * read. Both chips now read and write the one state the panel owns.
 *
 * Read as source, not rendered: a missing wire is invisible in a snapshot of
 * either component alone, because each one renders correctly with whatever
 * state it was handed. The bug is in which state that is — a fact about the
 * call site, not about either component's own output.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

const BOARD = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
const PANEL = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");

/** Comments stripped, so a rule about what the code does cannot be tripped by
 *  a comment that happens to mention the same words. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The board's own `<TriageBoard ... />` call, out of PrPanel — found by
 *  balancing `{}` from the tag's start, so the slice ends at the tag's own
 *  closing `>` rather than at a fixed offset that a reordered prop would
 *  slide past. */
function triageBoardCall(src: string): string {
  const at = src.indexOf("<TriageBoard");
  expect(at, "TriageBoard is still mounted from PrPanel").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    else if (src[i] === ">" && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced");
}

describe("the unread switch is one state, not two", () => {
  it("TriageBoard no longer declares its own onlyUnread state", () => {
    const src = code(BOARD);
    expect(src, "onlyUnread must come in as a prop, not a local useState")
      .not.toMatch(/\bonlyUnread\s*,\s*set\w+\s*\]\s*=\s*useState/);
  });

  it("TriageBoard still reads and flips onlyUnread, from props", () => {
    const src = code(BOARD);
    expect(src).toMatch(/\bonlyUnread\s*:\s*boolean\b/);
    expect(src).toMatch(/\bonOnlyUnread\s*:\s*\([^)]*\)\s*=>\s*void\b/);
    // The board's own chip flips it by calling the prop, not a setter it owns.
    expect(src).toContain("onOnlyUnread(!onlyUnread)");
  });

  it("PrPanel wires its own unreadOnly state into the board it mounts", () => {
    /* Comments stripped from the whole file before searching for the tag —
       a doc comment two thousand lines up also spells `<TriageBoard/>`, as
       one example among several JSX call shapes, and finding THAT would make
       this test pass whether or not the real mount below it was ever wired. */
    const call = triageBoardCall(code(PANEL));
    expect(call, "the board must receive the panel's switch").toContain("onlyUnread={personLogin ? false : unreadOnly}");
    expect(call, "and a way to flip it").toContain("onOnlyUnread={personLogin ? () => {} : setUnreadOnly}");
  });
});
