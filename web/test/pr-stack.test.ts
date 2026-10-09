// Which pull requests are a stack, and what number each one is.
//
// Every case below is a shape git or GitHub really produces, and every case
// says why it is there. The rule they all serve: a card either says where it
// stands or says nothing. A wrong "2 of 3" is worse than no mark, so whatever
// cannot be known (a base nobody has asked about, a loop, a base in a fork) is
// null, never a guess.
//
// Merge kinds are not cases of their own, and the first table says so out
// loud: GitHub reports a pull request as MERGED whether it was merged with a
// merge commit, squashed or rebased, and whether the branch was kept or
// deleted afterwards. The app never reads ancestry, so the base's sha being
// absent from the trunk after a squash changes nothing here.
import { describe, expect, test } from "bun:test";
import { collapse, isTrunkBranch, needsLookup, stackOf, type Box, type SpineItem, type StackPr } from "../src/lib/prStack.ts";

type St = StackPr["state"];
const pr = (number: number, head: string, base: string, extra: Partial<StackPr> = {}): StackPr =>
  ({ number, headRefName: head, baseRefName: base, state: "OPEN", ...extra });
const gone = (number: number, head: string, base: string, state: St): StackPr => pr(number, head, base, { state });

const one = (b: Box) => (b.kind === "cur" ? "*" : "") + (b.kind === "merged" ? "✓" : b.kind === "closed" ? "×" : b.label);
/** The spine as a reader sees it: `1 *2 3`, `✓` for a merged base, `+2` for a counted gap, `[2a 2b]` for a fork. */
function read(items: SpineItem[]): string {
  return items.map((it) => it.t === "gap" ? `+${it.hidden}`
    : it.t === "fork" ? `[${it.boxes.map(one).join(" ")}]`
    : one(it.box)).join(" ");
}
const where = (n: number, prs: StackPr[], lookups = new Map<string, StackPr | null>(), shown?: (n: number) => boolean) => {
  const s = stackOf(n, prs, lookups, shown);
  return s ? `${s.position}/${s.size} ${read(s.spine)}` : null;
};

describe("a line of open pull requests", () => {
  const line = (k: number) => Array.from({ length: k }, (_, i) => pr(100 + i, `b${i}`, i === 0 ? "main" : `b${i - 1}`));

  test("a pull request on the trunk is not a stack (why: most of them)", () => {
    expect(where(1, [pr(1, "feat/a", "main")])).toBeNull();
  });
  test.each([2, 3, 4, 5, 6])("a stack of %i reads 1..n with the current one marked", (k) => {
    const prs = line(k);
    for (let i = 0; i < k; i++) {
      const want = Array.from({ length: k }, (_, j) => (j === i ? "*" : "") + (j + 1)).join(" ");
      expect(where(100 + i, prs)).toBe(`${i + 1}/${k} ${want}`);
    }
  });
  test("9 and 20 deep: the middle is counted, the current one and its neighbours stay (why: a spine must not outgrow its card)", () => {
    expect(where(104, line(9))).toBe("5/9 1 +2 4 *5 6 +2 9");
    expect(where(100, line(20))).toBe("1/20 *1 2 +17 20");
    expect(where(119, line(20))).toBe("20/20 1 +17 19 *20");
    expect(where(110, line(20))).toBe("11/20 1 +8 10 *11 12 +7 20");
  });
  test("exactly 7 collapses and 6 does not (the mockup's rule: from 7 up)", () => {
    expect(where(103, line(6))).toBe("4/6 1 2 3 *4 5 6");
    expect(where(103, line(7))).toBe("4/7 1 +1 3 *4 5 +1 7");
  });
  test("collapse never hides the first, the last or the current", () => {
    const items: SpineItem[] = Array.from({ length: 12 }, (_, i) => ({ t: "box", box: { kind: i === 6 ? "cur" : "oth", label: String(i + 1) } }));
    expect(read(collapse(items, 6))).toBe("1 +4 6 *7 8 +3 12");
  });
});

describe("a base that is not in the list", () => {
  const child = pr(2, "feat/b", "feat/a");

  test("not asked yet: nothing is said (why: unknown is not main)", () => {
    expect(where(2, [child])).toBeNull();
    expect(stackOf(2, [child])).toBeNull();
  });
  test("asked, and it is an open pull request of somebody else: a stack of 2, the base box dashed (not on the board)", () => {
    const base = pr(1, "feat/a", "main");
    expect(where(2, [child], new Map([["feat/a", base]]), () => false)).toBe("2/2 1 *2");
    const s = stackOf(2, [child], new Map([["feat/a", base]]), (n) => n !== 1)!;
    expect(s.spine[0]).toEqual({ t: "box", box: { kind: "off", label: "1", number: 1 } });
    expect(s.base).toEqual({ kind: "pr", number: 1, branch: "feat/a", draft: false });
  });
  test("asked, and the base's own base is not in the list either: the walk keeps asking (needsLookup says which)", () => {
    const base = pr(1, "feat/a", "feat/z");
    expect(needsLookup([child], new Map())).toEqual(["feat/a"]);
    expect(needsLookup([child], new Map([["feat/a", base]]))).toEqual(["feat/z"]);
    expect(needsLookup([child], new Map([["feat/a", base], ["feat/z", pr(0, "feat/z", "main")]]))).toEqual([]);
  });
  test("asked, nobody ever opened a pull request from it: broken, a '?' box that is not counted", () => {
    const s = stackOf(2, [child], new Map([["feat/a", null]]))!;
    expect(s.broken).toBe("missing");
    expect(`${s.position}/${s.size} ${read(s.spine)}`).toBe("1/1 ? *1");
    expect(s.base).toEqual({ kind: "missing", branch: "feat/a" });
  });
  test("the lookup failed or the app is offline: it is simply never answered, and the card says nothing", () => {
    expect(stackOf(2, [child], new Map())).toBeNull();
  });
  test("the list holds a merged or closed one already: no request is needed (why: state=all lists)", () => {
    const merged = gone(1, "feat/a", "main", "MERGED");
    expect(needsLookup([child, merged], new Map())).toEqual([]);
    expect(stackOf(2, [child, merged])!.broken).toBe("merged");
  });
  test("a branch name that was used twice: the newest closed one answers (why: a branch gets reused)", () => {
    const old = gone(1, "feat/a", "main", "MERGED");
    const newer = gone(7, "feat/a", "main", "CLOSED");
    expect(stackOf(2, [child, old, newer])!.broken).toBe("closed");
  });
});

describe("the base is gone", () => {
  /* One table for the three ways to merge and the two things done to the
     branch afterwards: the app sees state MERGED and a branch that is, or is
     not, still the target. Squash and rebase leave the base's sha out of the
     trunk's history, which is why nothing here may look at ancestry. */
  for (const how of ["merge commit", "squash", "rebase"]) {
    test(`${how}, branch kept: the follower still targets it, a ticked box, not counted`, () => {
      const base = gone(1, "feat/a", "main", "MERGED");
      const s = stackOf(2, [pr(2, "feat/b", "feat/a")], new Map([["feat/a", base]]))!;
      expect(`${s.position}/${s.size} ${read(s.spine)}`).toBe("1/1 ✓ *1");
      expect(s.broken).toBe("merged");
      expect(s.base).toEqual({ kind: "merged", number: 1, branch: "feat/a" });
    });
    test(`${how}, branch deleted: GitHub retargeted the follower to main, so it is an ordinary card`, () => {
      expect(where(2, [pr(2, "feat/b", "main")])).toBeNull();
    });
  }
  test("the bottom of three merges, branch deleted: the other two renumber themselves, 1 of 2 and 2 of 2", () => {
    const prs = [pr(2, "b", "main"), pr(3, "c", "b")];
    expect(where(2, prs)).toBe("1/2 *1 2");
    expect(where(3, prs)).toBe("2/2 1 *2");
  });
  test("the bottom of three merges, branch kept: same numbers, and the ticked box takes no number", () => {
    const merged = gone(1, "a", "main", "MERGED");
    const prs = [pr(2, "b", "a"), pr(3, "c", "b")];
    const l = new Map([["a", merged]]);
    expect(where(2, prs, l)).toBe("1/2 ✓ *1 2");
    expect(where(3, prs, l)).toBe("2/2 ✓ 1 *2");
  });
  test("the middle one merged INTO the one below, branch deleted: GitHub retargets the top to the bottom's branch, a normal chain", () => {
    const prs = [pr(1, "a", "main"), pr(3, "c", "a")];
    expect(where(3, prs)).toBe("2/2 1 *2");
  });
  test("the middle one merged INTO the one below, branch kept: the walk hops through the merged one's own base and attaches to the open ancestor", () => {
    const mid = gone(2, "b", "a", "MERGED");
    const prs = [pr(1, "a", "main"), pr(3, "c", "b")];
    const l = new Map([["b", mid]]);
    expect(where(3, prs, l)).toBe("2/2 1 ✓ *2");
    expect(where(1, prs, l)).toBe("1/2 *1 ✓ 2");
    expect(stackOf(1, prs, l)!.next).toEqual([3]);
    expect(stackOf(3, prs, l)!.broken).toBe("merged");
  });
  test("two merged in a row, branches kept: one box for the pair, still attached", () => {
    const m2 = gone(2, "b", "a", "MERGED");
    const m3 = gone(3, "c", "b", "MERGED");
    const prs = [pr(1, "a", "main"), pr(4, "d", "c")];
    expect(where(4, prs, new Map([["b", m2], ["c", m3]]))).toBe("2/2 1 ✓ *2");
  });
  test("the base closed without merging: a crossed box, not counted, and the token says closed", () => {
    const closed = gone(1, "a", "main", "CLOSED");
    const s = stackOf(2, [pr(2, "b", "a")], new Map([["a", closed]]))!;
    expect(`${s.position}/${s.size} ${read(s.spine)}`).toBe("1/1 × *1");
    expect(s.broken).toBe("closed");
    expect(s.base).toEqual({ kind: "closed", number: 1, branch: "a" });
  });
  test("a merged base that was itself on a missing branch: the box says '✓' and no more is guessed", () => {
    const merged = gone(1, "a", "ghost", "MERGED");
    const s = stackOf(2, [pr(2, "b", "a")], new Map([["a", merged], ["ghost", null]]))!;
    expect(read(s.spine)).toBe("✓ *1");
  });
  test("the base branch was renamed or force-pushed: the name on the follower is stale, so nothing answers to it: a '?' box (force-push alone changes nothing: no sha is read)", () => {
    expect(where(2, [pr(2, "b", "a-old")], new Map([["a-old", null]]))).toBe("1/1 ? *1");
    expect(where(2, [pr(1, "a", "main"), pr(2, "b", "a")])).toBe("2/2 1 *2");
  });
  test("the head branch was deleted while the pull request is open: the name is still a string, nothing changes", () => {
    expect(where(2, [pr(1, "a", "main"), pr(2, "b", "a")])).toBe("2/2 1 *2");
  });
});

describe("forks and look-alikes", () => {
  test("two on one base: 2a and 2b, each other's sibling", () => {
    const prs = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "a")];
    expect(where(2, prs)).toBe("2/2 1 [*2a 2b]");
    expect(where(3, prs)).toBe("2/2 1 [2a *2b]");
    expect(stackOf(2, prs)!.siblings).toEqual([3]);
    expect(stackOf(2, prs)!.letter).toBe("a");
    expect(stackOf(1, prs)!.next).toEqual([2, 3]);
  });
  test("a fork with a follower on one side: the follower is a third tier on every card", () => {
    const prs = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "a"), pr(4, "d", "b")];
    expect(where(4, prs)).toBe("3/3 1 [2a 2b] *3");
    expect(where(3, prs)).toBe("2/3 1 [2a *2b] 3");
  });
  test("a fork of a fork: lettered by tier, nothing throws (the ceiling the mockup names)", () => {
    const prs = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "a"), pr(4, "d", "b"), pr(5, "e", "b"), pr(6, "f", "c")];
    expect(where(4, prs)).toBe("3/3 1 [2a 2b] [*3a 3b 3c]");
  });
  test("two open pull requests with the SAME head (a duplicate): the follower attaches to one, the other is alone, no number is doubled", () => {
    const prs = [pr(1, "a", "main"), pr(2, "a", "main"), pr(3, "c", "a")];
    expect(where(3, prs)).toBe("2/2 1 *2");
    expect(where(2, prs)).toBeNull();
  });
  test("a pull request from a fork whose branch is named like an upstream branch is not that branch's follower", () => {
    const fromFork = pr(9, "feature", "main", { isCrossRepository: true });
    const follower = pr(10, "x", "feature");
    expect(where(10, [fromFork, follower])).toBeNull();
    expect(needsLookup([fromFork, follower], new Map())).toEqual(["feature"]);
  });
  test("…and when upstream has one too, the follower attaches to the upstream one", () => {
    const upstream = pr(8, "feature", "main");
    const fromFork = pr(9, "feature", "main", { isCrossRepository: true });
    expect(where(10, [fromFork, upstream, pr(10, "x", "feature")])).toBe("2/2 1 *2");
  });
  test("a fork's own pull request can still sit on an upstream stack", () => {
    const prs = [pr(1, "a", "main"), pr(2, "b", "a", { isCrossRepository: true })];
    expect(where(2, prs)).toBe("2/2 1 *2");
  });
});

describe("shapes that must not loop, lie or throw", () => {
  test("A on B and B on A: terminates and says nothing (why: no honest number exists)", () => {
    const prs = [pr(1, "a", "b"), pr(2, "b", "a")];
    expect(where(1, prs)).toBeNull();
    expect(where(2, prs)).toBeNull();
  });
  test("a longer loop, and a tail hanging from it", () => {
    const prs = [pr(1, "a", "c"), pr(2, "b", "a"), pr(3, "c", "b"), pr(4, "d", "c")];
    for (const n of [1, 2, 3, 4]) expect(where(n, prs)).toBeNull();
  });
  test("a pull request on its own head", () => {
    expect(where(1, [pr(1, "a", "a")])).toBeNull();
  });
  test("a 60-deep chain is read in full; a 100-deep one is not drawn at all rather than with a wrong tail", () => {
    const chain = (k: number) => Array.from({ length: k }, (_, i) => pr(i + 1, `b${i}`, i === 0 ? "main" : `b${i - 1}`));
    expect(stackOf(60, chain(60))!.size).toBe(60);
    expect(() => stackOf(100, chain(100))).not.toThrow();
    expect(stackOf(100, chain(100))).toBeNull();
    expect(stackOf(10, chain(100))).toBeNull();
  });
  test("an empty list, an unknown number, empty branch names", () => {
    expect(stackOf(1, [])).toBeNull();
    expect(stackOf(5, [pr(1, "a", "main")])).toBeNull();
    expect(stackOf(1, [pr(1, "", "")])).toBeNull();
    expect(needsLookup([], new Map())).toEqual([]);
  });
  test("a merged or closed pull request in the list is never a card: asking about one says nothing", () => {
    expect(stackOf(1, [gone(1, "a", "b", "MERGED"), pr(2, "b", "main")])).toBeNull();
  });
});

describe("what is a trunk", () => {
  test.each(["main", "master", "trunk", "develop", "development", "Main", "MASTER", "staging", "production", "release/2.4", "release-2.4", "v2", "2.4", "1.x", "v1.2.x", "rc/3"])(
    "%s is never a stack (why: aiming at it is ordinary)", (b) => {
      expect(isTrunkBranch(b)).toBe(true);
      expect(where(2, [pr(2, "feat/x", b)])).toBeNull();
    });
  test.each(["feat/a", "release", "main-2", "myorg-main", "release-notes", "hotfix/login", "v", "feature/1.2-fix"])("%s is not (it is asked about)", (b) => {
    expect(isTrunkBranch(b)).toBe(false);
  });
  test("a team that calls its trunk something else sees a '?' once the lookup answers, and never a number", () => {
    expect(where(2, [pr(2, "feat/x", "company-main")])).toBeNull();
    expect(where(2, [pr(2, "feat/x", "company-main")], new Map([["company-main", null]]))).toBe("1/1 ? *1");
  });
});

describe("draft pull requests and the board", () => {
  test("a draft base is still a base; the token learns it is a draft", () => {
    const prs = [pr(1, "a", "main", { isDraft: true }), pr(2, "b", "a")];
    expect(stackOf(2, prs)!.base).toEqual({ kind: "pr", number: 1, branch: "a", draft: true });
    expect(where(2, prs)).toBe("2/2 1 *2");
  });
  test("a base that is not on the board is dashed, a base that is stays solid", () => {
    const prs = [pr(1, "a", "main"), pr(2, "b", "a")];
    const s = stackOf(2, prs, new Map(), (n) => n === 2)!;
    expect(s.spine[0]).toEqual({ t: "box", box: { kind: "off", label: "1", number: 1 } });
    expect(stackOf(2, prs, new Map(), () => true)!.spine[0]).toEqual({ t: "box", box: { kind: "oth", label: "1", number: 1 } });
  });
});

describe("names", () => {
  test("slashes, unicode and a trailing dot match exactly", () => {
    const head = "feat/ünï/日本語.v2.";
    const prs = [pr(1, head, "main"), pr(2, "b", head)];
    expect(where(2, prs)).toBe("2/2 1 *2");
  });
  test("branch names are case-sensitive, as git's are: Feature/A is not feature/a", () => {
    expect(where(2, [pr(1, "feature/a", "main"), pr(2, "b", "Feature/A")])).toBeNull();
  });
  test("a name with regexp characters is only ever compared, never built into a pattern", () => {
    const head = "feat/(a+)*[x]?";
    expect(where(2, [pr(1, head, "main"), pr(2, "b", head)])).toBe("2/2 1 *2");
  });
});

describe("refreshes", () => {
  const prs = [pr(5, "e", "d"), pr(1, "a", "main"), pr(3, "c", "b"), pr(2, "b", "a"), pr(4, "d", "c")];
  const shuffles = (xs: StackPr[]) => [xs, [...xs].reverse(), [xs[2], xs[4], xs[0], xs[3], xs[1]], [xs[1], xs[0], xs[4], xs[3], xs[2]]];

  test("the order the two lists are concatenated in (mine, then asked-of-me) does not change a number", () => {
    for (const order of shuffles(prs)) for (let n = 1; n <= 5; n++) expect(where(n, order)).toBe(where(n, prs));
  });
  test("the list arrives before the answer to a lookup, then the answer lands: the stack grows by one box, never flips", () => {
    const base = pr(1, "a", "main");
    const child = pr(2, "b", "a");
    expect(where(2, [child])).toBeNull();
    expect(where(2, [child], new Map([["a", base]]))).toBe("2/2 1 *2");
  });
  test("retargeted while the app is open: the next list renumbers, and a cached answer for the old base is not consulted", () => {
    const merged = gone(1, "a", "main", "MERGED");
    const cache = new Map([["a", merged]]);
    expect(where(2, [pr(2, "b", "a")], cache)).toBe("1/1 ✓ *1");
    expect(where(2, [pr(2, "b", "main")], cache)).toBeNull();
  });
  test("a looked-up pull request that has since appeared in the list: the list wins", () => {
    const stale = gone(1, "a", "main", "CLOSED");
    const fresh = pr(8, "a", "main");
    expect(where(2, [fresh, pr(2, "b", "a")], new Map([["a", stale]]))).toBe("2/2 1 *2");
  });
  test("a looked-up answer for one branch never leaks into another", () => {
    const l = new Map<string, StackPr | null>([["a", pr(1, "a", "main")]]);
    expect(where(2, [pr(2, "b", "other")], l)).toBeNull();
  });
});
