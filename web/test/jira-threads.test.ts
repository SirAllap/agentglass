/* A card's comments as threads: one level, replies oldest first, and nothing a person wrote is ever hidden. */
import { describe, expect, test } from "bun:test";
import { answeredBy, keepThreads, threadsOf } from "../src/lib/jiraThreads.ts";

const c = (id: string, at: number, parentId?: string) => ({ id, who: `Person ${id}`, text: id, at, ...(parentId ? { parentId } : {}) });

describe("threadsOf", () => {
  test("replies sit under their comment, oldest first, and the roots follow the order asked", () => {
    const all = [c("1", 10), c("2", 20), c("3", 30, "1"), c("4", 40, "1"), c("5", 50)];
    const old = threadsOf(all, false);
    expect(old.map((t) => t.root.id)).toEqual(["1", "2", "5"]);
    expect(old[0]!.replies.map((r) => r.id)).toEqual(["3", "4"]);
    const fresh = threadsOf(all, true);
    expect(fresh.map((t) => t.root.id)).toEqual(["5", "2", "1"]);
    // A thread still reads oldest first when the list is turned around.
    expect(fresh[2]!.replies.map((r) => r.id)).toEqual(["3", "4"]);
  });

  test("a reply to a reply belongs to the thread it is in", () => {
    const t = threadsOf([c("1", 10), c("2", 20, "1"), c("3", 30, "2")], false);
    expect(t.length).toBe(1);
    expect(t[0]!.replies.map((r) => r.id)).toEqual(["2", "3"]);
  });

  test("a reply whose comment was not read is a comment of its own, marked", () => {
    const t = threadsOf([c("7", 10, "99"), c("8", 20)], false);
    expect(t.map((x) => [x.root.id, x.orphan])).toEqual([["7", true], ["8", false]]);
  });

  test("a loop in the data ends and hides nothing", () => {
    const t = threadsOf([c("1", 10, "2"), c("2", 20, "1")], false);
    expect(t.flatMap((x) => [x.root.id, ...x.replies.map((r) => r.id)]).sort()).toEqual(["1", "2"]);
  });

  test("answeredBy names who a reply answers, for the list drawn in time order", () => {
    const m = answeredBy([c("1", 10), c("2", 20, "1"), c("3", 30, "404")]);
    expect(m.get("2")).toBe("Person 1");
    expect(m.has("3")).toBe(false);
  });
});

describe("keepThreads", () => {
  const mine = (id: string, at: number) => ({ ...c(id, at), mine: true as const });
  test("a comment keeps the parent it had, and the one new comment of the person's own takes the reply it was sent as", () => {
    const prev = [c("1", 10), c("2", 20, "1")];
    const next = [c("1", 10), c("2", 20), mine("3", 30)];
    const out = keepThreads(prev, next, "1");
    expect(out.map((x) => [x.id, x.parentId])).toEqual([["1", undefined], ["2", "1"], ["3", "1"]]);
  });
  test("a comment sent on its own stays at the top, and so does somebody else's new one", () => {
    const prev = [c("1", 10)];
    expect(keepThreads(prev, [c("1", 10), mine("2", 20)], null).map((x) => x.parentId)).toEqual([undefined, undefined]);
    expect(keepThreads(prev, [c("1", 10), c("2", 20)], "1").map((x) => x.parentId)).toEqual([undefined, undefined]);
  });
  test("two new comments of the person's own are not guessed at", () => {
    const out = keepThreads([c("1", 10)], [c("1", 10), mine("2", 20), mine("3", 30)], "1");
    expect(out.map((x) => x.parentId)).toEqual([undefined, undefined, undefined]);
  });
});
