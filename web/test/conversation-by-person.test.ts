/*
 * Inside Humans, whose remarks.
 *
 * The lane answers "has a person said anything" and on a long review that is
 * still forty rows, while the question being asked is usually about one person.
 * So the people who actually spoke get a row of their own, and a pair of steps
 * to walk their remarks without scrolling past everybody else's.
 *
 * Checked at the source, because the thing worth locking here is not that a
 * filter filters — it is the set of rules that stop it becoming another hidden
 * filter nobody can see the effect of.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("the sub-filter by person", () => {
  it("carries the author on the rows that have one", () => {
    // A thread is filed under whoever RAISED it, the same rule the lane uses:
    // a reply inside somebody's thread is part of their remark, not one of
    // your own.
    expect(src).toContain('lane: "human", author: r.author,');
    expect(src).toContain('lane: "human", author: c.author,');
    expect(src).toContain("author: t.comments[0]?.author,");
  });

  it("offers only people who have actually spoken in the lane", () => {
    /* Counted off the rows the timeline draws rather than off the participant
       list — somebody who was asked to review and never answered is not a
       filter worth offering. */
    expect(src).toContain("for (const e of laned) if (e.author)");
  });

  it("does not appear where it could only ever do nothing", () => {
    // One speaker means the only choice is "the person already on screen".
    expect(src).toContain('who === "human" && speakers.length > 1');
  });

  it("clears itself when you leave the lane", () => {
    // A filter still applied on a lane that does not show it is how a
    // conversation reads as empty for no reason.
    expect(src).toContain("useEffect(() => { setPerson(null); setPCursor(-1); }, [who]);");
  });

  it("clears itself when the person stops appearing", () => {
    // A refresh drops their comment and the timeline goes blank with the chip
    // gone too — nothing on screen to explain it.
    expect(src).toContain("if (person && !speakerKey.split");
  });

  it("keeps that guard BELOW the list it reads, not up with the other hooks", () => {
    /* `speakers` is computed after the effects near the top; a hook reading it
       from up there is the temporal dead zone that takes the whole window
       black. This test is the reminder, and the order is the fix. */
    expect(src.indexOf("const speakers = (() => {")).toBeLessThan(src.indexOf("if (person && !speakerKey.split"));
  });

  it("wraps around in both directions, so a step is never a dead press", () => {
    expect(src).toContain("((pCursor + dir) % shown.length + shown.length) % shown.length");
  });

  it("lands centred and flashes, like the New walker does", () => {
    // On a long page a jump that lands silently is indistinguishable from a
    // jump that did nothing, and the reader scrolls anyway to check.
    const walk = src.slice(src.indexOf("const step = (dir: 1 | -1)"), src.indexOf("const speakerKey"));
    expect(walk).toContain('block: "center"');
    expect(walk).toContain('classList.add("agx-found")');
    expect(walk).toContain("prefers-reduced-motion");
  });
});
