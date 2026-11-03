/* A list with no views said "Nothing matches “”." with an empty query. Read as source. */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("the view picker of a list with no views", () => {
  it("never quotes an empty search", () => {
    expect(src).not.toContain("Nothing matches “{q.trim()}”.");
    expect(src).toContain("This list has no saved views");
  });
});
