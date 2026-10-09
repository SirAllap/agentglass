// The words on the stack marks. A mark is read by people who cannot see its
// colour, so every one has a sentence; these pin which word wins and what the
// sentences say, so a refactor of the view cannot change what is claimed.
import { describe, expect, test } from "bun:test";
import { spineSentence, tokenSentence, wordOf, type Facts } from "../src/lib/prStackWords.ts";
import { stackOf, type BaseRef, type StackPr } from "../src/lib/prStack.ts";

const pr = (number: number, head: string, base: string, state: StackPr["state"] = "OPEN"): StackPr =>
  ({ number, headRefName: head, baseRefName: base, state });
const open = (number: number): BaseRef => ({ kind: "pr", number, branch: "a", draft: false });
const facts = (o: Partial<Facts> = {}): Facts => ({ number: 1, state: "OPEN", draft: false, onBoard: true, ...o });

describe("the word on the token", () => {
  test("the tracker's own status wins over the column, whatever the team calls it", () => {
    expect(wordOf(facts({ lane: "land", status: "Waiting On QA" }), open(1)).word).toBe("waiting on qa");
  });
  test("with no card status the column it sits in is the word", () => {
    expect(wordOf(facts({ lane: "land" }), open(1)).word).toBe("ready to land");
    expect(wordOf(facts({ lane: "flight" }), open(1)).word).toBe("in flight");
    expect(wordOf(facts({ lane: "blocked" }), open(1)).word).toBe("blocked");
    expect(wordOf(facts({ lane: "review" }), open(1)).word).toBe("needs review");
    expect(wordOf(facts({ lane: "others" }), open(1)).word).toBe("waiting on others");
  });
  test("with neither, the pull request's own state: draft, else open", () => {
    expect(wordOf(facts({ draft: true }), open(1)).word).toBe("draft");
    expect(wordOf(facts(), open(1)).word).toBe("open");
    expect(wordOf(undefined, open(1)).word).toBe("open");
  });
  test("a base that is gone says so before anything else, even with a card status (the broken fact is the news)", () => {
    expect(wordOf(facts({ status: "Done" }), { kind: "merged", number: 1, branch: "a" }).word).toBe("merged");
    expect(wordOf(facts({ status: "Done" }), { kind: "closed", number: 1, branch: "a" }).word).toBe("closed");
    expect(wordOf(undefined, { kind: "missing", branch: "a" }).word).toBe("no PR");
  });
  test("a status with no company's name in the code: nothing here is spelled like a tracker's column", async () => {
    const src = await Bun.file(new URL("../src/lib/prStackWords.ts", import.meta.url)).text();
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/ready for qa|in development|code review|in review/i);
  });
});

describe("the sentences", () => {
  test("a base on the board and one that is not say where they are", () => {
    expect(tokenSentence(open(1180), facts({ lane: "land" }))).toBe("Base pull request #1180, ready to land, on this board. Open it");
    expect(tokenSentence(open(1180), facts({ lane: "land", onBoard: false }))).toBe("Base pull request #1180, ready to land, not on this board. Open it");
  });
  test("broken bases say how", () => {
    expect(tokenSentence({ kind: "merged", number: 4402, branch: "a" }, undefined)).toContain("is merged but this one still targets its branch");
    expect(tokenSentence({ kind: "closed", number: 4440, branch: "a" }, undefined)).toContain("was closed without merging");
    expect(tokenSentence({ kind: "missing", branch: "orbit-x" }, undefined)).toBe("Base branch orbit-x has no pull request");
  });
  test("the spine says its place, its base and its next, in words", () => {
    const prs = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "b")];
    const s = stackOf(2, prs)!;
    const f = (n: number): Facts => facts({ number: n, lane: n === 1 ? "land" : "flight" });
    expect(spineSentence(s, f)).toBe("Stacked pull request 2 of 3. Base: #1, ready to land. Next: #3, in flight.");
    expect(spineSentence(stackOf(1, prs)!, f)).toBe("Stacked pull request 1 of 3. It targets the trunk. Next: #2, in flight.");
  });
  test("a fork names its sibling, a broken stack names the break", () => {
    const fork = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "a")];
    expect(spineSentence(stackOf(2, fork)!, () => facts())).toContain("Stacked pull request 2a of 2, on a fork.");
    expect(spineSentence(stackOf(2, fork)!, () => facts())).toContain("Sibling: #3, on the same base.");
    const broken = stackOf(2, [pr(2, "b", "a")], new Map([["a", pr(1, "a", "main", "MERGED")]]))!;
    expect(spineSentence(broken, () => undefined)).toContain("Broken: the base #1 is merged and this one still targets its branch.");
  });
});
