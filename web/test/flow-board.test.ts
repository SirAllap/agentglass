/*
 * The Flow board is the canvas's flow drawn as columns: these assert the layout
 * it paints, and that its edits are the canvas's own functions.
 */
import { describe, expect, test } from "bun:test";
import type { Flow } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { movePath, placeOnPath, removeFromPath } from "../src/lib/flowEdit.ts";
import { boardColumns, stepTarget } from "../src/lib/flowBoard.ts";

const shipped = (): Flow => ({ ...templateFlow(), blocks: [] });
const shape = (f: Flow) => boardColumns(f).map((c) => [c.stage.label, c.cards.map((x) => `${x.step}:${x.role.id}`)]);

describe("board columns", () => {
  test("the shipped flow: one column per stage the path reaches, in path order", () => {
    expect(shape(shipped())).toEqual([
      ["Shaping", ["1:planner"]],
      ["In development", ["2:builder"]],
      ["In code review", ["3:inspector"]],
      ["Verifier", ["4:verifier"]],
      ["Ready to land", ["5:landing"]],
    ]);
  });

  test("a stage with no role on the path has no column, and a role placed there opens it", () => {
    const f = placeOnPath(shipped(), "qa-only", 3);
    expect(shape(f).map((c) => c[0])).toEqual(["Shaping", "In development", "In code review", "QA", "Verifier", "Ready to land"]);
  });

  test("two roles of one stage share its column, in path order with their own steps", () => {
    const f = placeOnPath(shipped(), "security", 3);
    expect(shape(f)[2]).toEqual(["In code review", ["3:inspector", "4:security"]]);
  });

  test("a stage the path comes back to is still one column", () => {
    const f = placeOnPath(shipped(), "frontend", 4);
    expect(shape(f)[1]).toEqual(["In development", ["2:builder", "5:frontend"]]);
    expect(boardColumns(f).length).toBe(5);
  });

  test("roles off the path are not on the board", () => {
    const ids = boardColumns(shipped()).flatMap((c) => c.cards.map((x) => x.role.id));
    expect(ids).not.toContain("qa-only");
  });

  test("a role whose stage is missing gets a column named by the stage id", () => {
    const f = shipped();
    f.stages = f.stages.filter((s) => s.id !== "land");
    expect(shape(f).at(-1)).toEqual(["land", ["5:landing"]]);
  });

  test("an empty path draws no columns", () => {
    expect(boardColumns({ ...shipped(), path: [] })).toEqual([]);
  });
});

describe("board edits go through the canvas's functions", () => {
  test("earlier and later stop at the ends and off the path", () => {
    const f = shipped();
    expect(stepTarget(f, "planner", -1)).toBeNull();
    expect(stepTarget(f, "landing", 1)).toBeNull();
    expect(stepTarget(f, "qa-only", 1)).toBeNull();
    expect(stepTarget(f, "builder", 1)).toBe(2);
  });

  test("later moves a card one step down the path", () => {
    const f = shipped();
    const next = movePath(f, "builder", stepTarget(f, "builder", 1)!);
    expect(next.path).toEqual(["planner", "inspector", "builder", "verifier", "landing"]);
    expect(shape(next).slice(1, 3).map((c) => c[0])).toEqual(["In code review", "In development"]);
  });

  test("remove takes the card off the board and keeps the role in the team", () => {
    const next = removeFromPath(shipped(), "inspector");
    expect(shape(next).map((c) => c[0])).not.toContain("In code review");
    expect(next.roster.some((r) => r.id === "inspector")).toBe(true);
  });
});

describe("the editor switches views over one flow", () => {
  const src = Bun.file(new URL("../src/components/orchestration/flow/FlowEditor.tsx", import.meta.url));
  test("Board is on and draws the same flow the canvas does", async () => {
    const s = await src.text();
    expect(s).not.toContain("Coming soon");
    expect(s).toMatch(/<FlowBoard[^>]*flow=\{drawn\}/);
  });
});
