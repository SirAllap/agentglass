import { describe, expect, it } from "bun:test";
import { termPins, repoGroups } from "../src/lib/termPins.ts";
import type { Pin } from "../src/lib/prPins.ts";

const pin = (repo: string, number: number, at = number): Pin => ({ repo, number, title: `t${number}`, at });

describe("termPins", () => {
  it("is empty with no pins", () => expect(termPins([], "orbit/web")).toEqual([]));
  it("keeps the pinned order when no repository is known", () => {
    const a = [pin("orbit/web", 2), pin("orbit/api", 1)];
    expect(termPins(a).map((p) => p.number)).toEqual([2, 1]);
  });
  it("puts the pane's repository first, the rest in pinned order", () => {
    const a = [pin("orbit/api", 1), pin("orbit/web", 2), pin("orbit/api", 3), pin("orbit/web", 4)];
    expect(termPins(a, "orbit/web").map((p) => p.number)).toEqual([2, 4, 1, 3]);
  });
  it("lists the same number in two repositories twice, a repeated pin once", () => {
    const a = [pin("orbit/web", 5), pin("orbit/api", 5), pin("orbit/web", 5)];
    expect(termPins(a).map((p) => p.repo)).toEqual(["orbit/web", "orbit/api"]);
  });
});

describe("repoGroups", () => {
  const list = [pin("orbit/web", 2), pin("orbit/api", 1), pin("orbit/web", 4)];
  it("makes one group per repository in first-seen order and marks the current one", () => {
    const g = repoGroups(list, "orbit/web");
    expect(g.map((x) => [x.repo, x.current, x.pins.map((p) => p.number)])).toEqual([
      ["orbit/web", true, [2, 4]], ["orbit/api", false, [1]]]);
  });
  it("marks none current when the repository is unknown", () => {
    expect(repoGroups(list, null).every((x) => !x.current)).toBe(true);
  });
});
