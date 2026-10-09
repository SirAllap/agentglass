/*
 * Where the workflow map puts things: how much of a space name fits in the
 * gutter beside a step, and that the screen asks for it instead of printing the
 * whole name.
 *
 * The fixture is the shape of a real workspace: one space is named like a
 * department ("Support Escalations and Customer Success Operations (EMEA)") and
 * its label, drawn from 28px into an 84px gutter, ran over the first rows of
 * the status list.
 */
import { describe, expect, test } from "bun:test";
import { CHIP_H, GUTTER_CHAR, GUTTER_GAP, GUTTER_STUB, GUTTER_W, LINE_LH, SENTENCE_LH, STEP_GAP, gutterLabel, reachLines } from "../src/lib/workflowMap.ts";
import { HIT } from "../src/lib/iconSize.ts";

const MAP = await Bun.file(new URL("../src/components/WorkflowMap.tsx", import.meta.url)).text();

/** The label's two lines never reach the status list: the widest one ends before the gutter does. */
const reach = (l: { lead: string; name: string }) => GUTTER_STUB + 4 + Math.max(l.lead.length, l.name.length) * GUTTER_CHAR;

describe("the label in the gutter", () => {
  test("a long space name is cut so the label stays inside the gutter, with room before the list", () => {
    const l = gutterLabel("Support Escalations and Customer Success Operations (EMEA)");
    expect(l.name.endsWith("…")).toBe(true);
    expect(reach(l)).toBeLessThanOrEqual(GUTTER_W - GUTTER_GAP);
  });

  test("the whole name is kept for the tooltip, so cutting it loses nothing", () => {
    const l = gutterLabel("Support Escalations and Customer Success Operations (EMEA)");
    expect(l.full).toBe("not in Support Escalations and Customer Success Operations (EMEA)");
  });

  test("a short name is shown as it is, with no ellipsis", () => {
    expect(gutterLabel("Platform")).toEqual({ lead: "not in", name: "Platform", full: "not in Platform" });
  });

  test("a name that fits exactly is not cut, one character more is", () => {
    const fit = gutterLabel("x".repeat(40)).name.length;
    expect(gutterLabel("x".repeat(fit)).name).toBe("x".repeat(fit));
    expect(gutterLabel("x".repeat(fit + 1)).name.endsWith("…")).toBe(true);
  });

  test("runs of spaces and edge spaces do not eat the room", () => {
    expect(gutterLabel("  Growth   Ops ").name).toBe("Growth Ops");
  });

  test("a space with no name still says something true", () => {
    expect(gutterLabel("   ")).toMatchObject({ name: "", full: "not in this space" });
  });
});

describe("the map draws that label and no other", () => {
  const draw = MAP.slice(MAP.indexOf("const draw = useCallback("), MAP.indexOf("useLayoutEffect(() => { draw(); });"));

  test("the connector label comes from gutterLabel, not from the raw space name", () => {
    expect(draw).toContain("gutterLabel(space.name)");
    expect(draw.replace(/^\s*\/[/*].*$/gm, "")).not.toMatch(/not in \$\{space\.name/);
  });

  test("the grid column is the width the label was measured against", () => {
    expect(MAP).toContain("`minmax(0,1fr) ${GUTTER_W}px 300px`");
  });

  test("a name set into markup is escaped, so a space called <b> stays a name", () => {
    expect(MAP).toContain("${xml(l.name)}");
    expect(MAP).toContain("${xml(l.full)}");
  });
});

describe("the rhythm of a step", () => {
  const body = MAP.slice(MAP.indexOf("const stepRow = ("), MAP.indexOf("const move = steps.find("));

  test("a sentence line clears the picker in it, so a pill never touches the line above or below", () => {
    expect(CHIP_H).toBe(HIT);
    expect(SENTENCE_LH - CHIP_H).toBeGreaterThanOrEqual(4);
  });

  test("the sentence takes its line height from that constant, not from a multiple of the type", () => {
    expect(body).toContain("lineHeight: `${SENTENCE_LH}px`");
    expect(body.replace(/^\s*\/[/*].*$/gm, "")).not.toMatch(/leading-\[/);
  });

  test("the blocks of a step sit in one column with one gap, not one margin each", () => {
    expect(body).toContain("flex flex-col\" style={{ gap: STEP_GAP }}");
    expect(body.replace(/^\s*\/[/*].*$/gm, "")).not.toMatch(/className="mt-(1|2|2\.5) ml-7/);
    expect(STEP_GAP).toBeGreaterThan(0);
    expect(LINE_LH).toBeLessThan(SENTENCE_LH);
  });

  test("the picker in a sentence is as tall as the constant says", () => {
    const chip = MAP.slice(MAP.indexOf("function PickChip("), MAP.indexOf("function Pill("));
    expect(chip).toContain("height: CHIP_H");
  });
});

describe("the coverage lines", () => {
  const n = { space: "space", spaces: "spaces" };
  const spaces = [{ id: "1", name: "Engineering", statuses: [] }, { id: "2", name: "Platform", statuses: [] }];

  test("each is its own line, so the spacing between them is the step's gap", () => {
    const l = reachLines({ kind: "some", has: ["Engineering"], missing: ["Platform"], total: 2 }, spaces, n);
    expect(l.map((x) => x.text)).toEqual(["Engineering", "Platform: no such status — the button is absent"]);
    expect(l.map((x) => x.dot)).toEqual([true, false]);
  });

  test("past five spaces the count and the absent list are two lines, in that order", () => {
    const l = reachLines({ kind: "some", has: ["a", "b"], missing: ["c", "d", "e", "f", "g", "h"], total: 8 }, spaces, n);
    expect(l.map((x) => x.text)).toEqual(["2 of 8 spaces", "absent in c, d, e, f, g, h"]);
  });

  test("every kind reads as one line", () => {
    expect(reachLines({ kind: "everywhere" }, spaces, n)).toHaveLength(1);
    expect(reachLines({ kind: "all", count: 2 }, spaces, n)[0]!.text).toBe("In all 2 spaces");
    expect(reachLines({ kind: "pending" }, spaces, n)[0]!.tone).toBe("warn");
    expect(reachLines({ kind: "none-needed" }, spaces, n)[0]!.dot).toBeUndefined();
  });
});
