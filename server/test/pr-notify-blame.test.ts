// The PR watch timer must not leave its loop-watch label open.
//
// entered() without finished() keeps the label as the one to blame until some
// other request enters, so a stall caused by anything else was logged as
// "pr notify watch" (4.2 s and 5.8 s lines in one server's stall log).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pr notify watch loop label", () => {
  it("finishes the label it enters, on every path", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "prNotifyWatch.ts"), "utf8");
    const run = src.slice(src.indexOf("const run = (gate"), src.indexOf("if (!timer)"));
    expect(run).toContain('const mark = entered("pr notify watch")');
    expect(run).toMatch(/finally \{ finished\(mark\); \}/);
  });
});
