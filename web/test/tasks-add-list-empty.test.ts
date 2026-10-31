/*
 * Picking which view of a loose list to add, before anything is typed: the
 * empty line is "This list has no saved views", never `Nothing matches ""`.
 * Read as source.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("the view picker of a loose list", () => {
  const i = src.indexOf("function ListViews(");
  const body = src.slice(i, src.indexOf("\n}\n", i));

  it("names a query only when there is one", () => {
    const at = body.indexOf("Nothing matches");
    expect(at).not.toBe(-1);
    expect(body.slice(at - 80, at)).toContain("q.trim() ?");
    expect(body).toContain("This list has no saved views");
  });

  it("never interpolates an empty query anywhere in the add flow", () => {
    for (const m of src.matchAll(/Nothing matches [“"]\$\{(\w+)\.trim\(\)\}/g)) {
      const around = src.slice(Math.max(0, m.index! - 80), m.index!);
      expect(around, m[0]).toContain(`${m[1]}.trim() ?`);
    }
  });
});
