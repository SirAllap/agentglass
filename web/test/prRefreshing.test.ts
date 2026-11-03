import { describe, expect, test } from "bun:test";
import { REFRESH_CEILING_MS, refreshMoved, refreshPhase } from "../src/lib/prRefreshing.ts";

describe("the refreshing state after an update", () => {
  test("nothing is refreshing until an update finishes", () => {
    expect(refreshPhase(undefined, 1000)).toBeNull();
    expect(refreshPhase(0, 1000)).toBeNull();
  });

  test("it reads while the answer is on its way", () => {
    expect(refreshPhase(1000, 1000)).toBe("reading");
    expect(refreshPhase(1000, 1000 + REFRESH_CEILING_MS - 1)).toBe("reading");
  });

  test("at the 45 s ceiling it gives up and says so, rather than spinning for ever", () => {
    expect(refreshPhase(1000, 1000 + REFRESH_CEILING_MS)).toBe("expired");
    expect(refreshPhase(1000, 1000 + REFRESH_CEILING_MS + 60_000)).toBe("expired");
  });
});

describe("a read after the write", () => {
  test("the same head is GitHub's 202: the branch has not moved yet", () => {
    expect(refreshMoved("0ldhead", "0ldhead")).toBe(false);
  });

  test("a new head is the merge landing", () => {
    expect(refreshMoved("0ldhead", "n3whead")).toBe(true);
  });

  test("with nothing to compare against, one read is all there is to go on", () => {
    expect(refreshMoved(undefined, "n3whead")).toBe(true);
    expect(refreshMoved(null, null)).toBe(true);
  });
});
