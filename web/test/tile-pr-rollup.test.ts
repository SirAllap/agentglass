import { describe, expect, test } from "bun:test";
import { tilePrFrom } from "../src/lib/jiraTileData.ts";

const roll = { total: 4, success: 1, failure: 3, skipped: 0, pending: 0, allDone: true, verdict: "red" as const, failing: [] };
describe("tilePrFrom with the project read's rollup", () => {
  test("a PR the board never loaded still shows its checks and review decision", () => {
    const t = tilePrFrom({ number: 322, title: "Retry", state: "OPEN", url: "https://github.com/acme/orbit/pull/322", checks: roll, checksAt: Date.now(), reviewDecision: "CHANGES_REQUESTED" });
    expect(t.ci.state).toBe("failing");
    expect(t.ci.failed).toBe(3);
    expect(t.review.kind).toBe("changes");
  });
  test("without a rollup the tile says unknown", () => {
    const t = tilePrFrom({ number: 9, title: "x", state: "OPEN", url: "https://github.com/acme/orbit/pull/9" });
    expect(t.ci.state).toBe("unknown");
    expect(t.review.kind).toBe("unknown");
  });
});
