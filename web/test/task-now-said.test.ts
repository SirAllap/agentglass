import { describe, expect, test } from "bun:test";
import { movesCard, rerunPending, rerunSig, SAID_MS, taskNow } from "../src/lib/taskNow.ts";

describe("tile click state", () => {
  test("Start work and Ready for QA move the card, others do not", () => {
    expect(movesCard("start")).toBe(true);
    expect(movesCard("ready-for-qa")).toBe(true);
    expect(movesCard("rerun")).toBe(false);
  });
  test("a card already in QA never offers Ready for QA", () => {
    const n = taskNow({ status: "qa", pr: { number: 7, state: "MERGED", draft: false } });
    expect(n.action).toBe("open-pr");
  });
  test("a re-run stays pending until the rollup changes", () => {
    const before = { state: "failing", failed: 3 };
    const clicked = rerunSig(before);
    expect(rerunPending(clicked, before)).toBe(true);
    expect(rerunPending(clicked, { state: "running", failed: 0 })).toBe(false);
    expect(rerunPending(null, before)).toBe(false);
  });
  test("said lasts about six seconds", () => { expect(SAID_MS).toBe(6000); });
});
