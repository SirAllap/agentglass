/*
 * Another person's board: the same filing from their chair, in their words,
 * with the owner's own board left exactly as it was.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { board, fileInLane, lanesFor, LANES, voice } from "../src/lib/prLanes.ts";
import { singleLogin } from "../src/lib/prSearch.ts";
import { askPerson, __forgetPeople } from "../src/lib/personBoard.ts";
import { api } from "../src/lib/api.ts";
import type { PrSummary } from "../../shared/types.ts";

type O = Partial<PrSummary> & { fail?: number; pend?: number; failing?: string[] };
const pr = (o: O = {}): PrSummary => {
  const { fail = 0, pend = 0, failing = [], ...rest } = o;
  return {
    number: 1, title: "t", author: "ana-dev", state: "OPEN", isDraft: false,
    headRefName: "h", baseRefName: "main", url: "", updatedAt: "", reviewDecision: null,
    additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
    checks: { total: 14 + fail + pend, success: 14, failure: fail, skipped: 0, pending: pend,
      allDone: pend === 0, verdict: pend ? null : fail ? "red" : "green",
      failing: failing.map((name) => ({ name, workflow: "CI", state: "failure", done: true })) },
    ...rest,
  } as unknown as PrSummary;
};

/* Every shape a card can have, so a sentence nobody voiced cannot hide. */
function everyShape(): PrSummary[] {
  const out: PrSummary[] = [];
  let n = 0;
  for (const isDraft of [false, true])
    for (const reviewDecision of [null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const)
      for (const fail of [0, 2])
        for (const pend of [0, 1])
          for (const mergeable of ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const)
            for (const hr of [undefined, { askedAgain: true }, { cleared: true }] as const)
              for (const failing of [[], ["unit"]] as const)
                out.push(pr({ number: ++n, isDraft, reviewDecision, fail, pend, mergeable, failing: fail ? [...failing] : [],
                  humanReview: hr as never, reviewers: n % 2 ? [{ login: "bo-dev" }] as never : [] }));
  return out;
}
const stakes = [{ mine: true, asked: false }, { mine: false, asked: true }, { mine: true, asked: true }, { mine: false, asked: false }];

describe("lane assignment from another viewer", () => {
  it("files by the person's stake, with the owner's rules", () => {
    const authored = pr({ number: 10, author: "ana-dev", reviewDecision: "APPROVED" });
    const asked = pr({ number: 11, author: "bo-dev" });
    const red = pr({ number: 12, author: "ana-dev", fail: 1, failing: ["unit"] });
    const m = new Set([10, 12]), r = new Set([11]);
    const lanes = board([authored, asked, red], (p) => ({ mine: m.has(p.number), asked: r.has(p.number) }), undefined, "ana-dev");
    expect(lanes.get("land")!.map((p) => p.number)).toEqual([10]);
    expect(lanes.get("review")!.map((p) => p.number)).toEqual([11]);
    expect(lanes.get("blocked")!.map((p) => p.number)).toEqual([12]);
    expect(lanes.get("blocked")![0].filed.reason).toContain("ana-dev's to fix");
    expect(lanes.get("review")![0].filed.reason).toContain("Asked of ana-dev");
  });

  it("leaves no second-person word in any sentence, for any shape", () => {
    const left: string[] = [];
    for (const p of everyShape()) for (const s of stakes) {
      const reason = voice(fileInLane(p, s).reason, "ana-dev");
      if (/\b(you|your|yours|you've|you're)\b/i.test(reason)) left.push(reason);
    }
    expect([...new Set(left)]).toEqual([]);
  });

  it("words the lanes about the person", () => {
    const l = lanesFor("ana-dev");
    expect(l.find((x) => x.id === "review")!.label).toBe("Needs ana-dev's review");
    expect(l.map((x) => x.id)).toEqual(LANES.map((x) => x.id));
    expect(JSON.stringify(l)).not.toMatch(/\byour?s?\b/i);
  });
});

describe("the owner's own board is unchanged", () => {
  it("files and words every shape identically with no viewer", () => {
    const prs = everyShape();
    const stakeOf = (p: PrSummary) => stakes[p.number % stakes.length];
    const plain = board(prs, stakeOf);
    const same = board(prs, stakeOf, undefined, undefined);
    expect(JSON.stringify([...same])).toBe(JSON.stringify([...plain]));
    for (const p of prs) for (const s of stakes) expect(voice(fileInLane(p, s).reason)).toBe(fileInLane(p, s).reason);
    expect(lanesFor()).toBe(LANES);
    // And it really is the owner's voice, so the test above compares something.
    expect([...plain.values()].flat().some((p) => /\byou\b/i.test(p.filed.reason))).toBe(true);
  });
});

describe("no request unless Enter opens the board", () => {
  const real = api.prPerson;
  afterAll(() => { (api as { prPerson: typeof real }).prPerson = real; __forgetPeople(); });

  it("asks once per login, dedupes the overlap, and remembers", async () => {
    let calls = 0;
    (api as { prPerson: unknown }).prPerson = async () => { calls++; return { ok: true, authored: [pr({ number: 1 })], asked: [], more: false }; };
    __forgetPeople();
    const [a, b] = await Promise.all([askPerson("/r", "Ana-Dev"), askPerson("/r", "ana-dev")]);
    expect(a.kind).toBe("ready"); expect(b.kind).toBe("ready");
    await askPerson("/r", "ana-dev");
    expect(calls).toBe(1);
    await askPerson("/r", "bo-dev");
    expect(calls).toBe(2);
  });

  it("does not remember a failure", async () => {
    let calls = 0;
    (api as { prPerson: unknown }).prPerson = async () => { calls++; return { ok: false, error: "no" }; };
    __forgetPeople();
    expect((await askPerson("/r", "ana-dev")).kind).toBe("failed");
    await askPerson("/r", "ana-dev");
    expect(calls).toBe(2);
  });

  it("typing only reads: the one place a person is opened is the button", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    const opens = [...src.matchAll(/setPersonLogin\(([^)]*\)?)\)/g)].map((m) => m[1]).filter((a) => !a.startsWith("null"));
    expect(opens.length).toBe(1);
    expect(src).toContain("onView: () => setPersonLogin(");
    expect((await Bun.file(new URL("../src/lib/personBoard.ts", import.meta.url)).text()).match(/api\.prPerson\(/g)?.length).toBe(1);
  });
});

describe("which searches are about one person", () => {
  const known = new Set(["ana-dev"]);
  it("takes one login token and nothing else", () => {
    expect(singleLogin("author:ana-dev")).toBe("ana-dev");
    expect(singleLogin("@ana-dev", known)).toBe("ana-dev");
    expect(singleLogin("ana-dev", known)).toBe("ana-dev");
    expect(singleLogin("author:ana-dev fix")).toBeNull();
    expect(singleLogin("fix login")).toBeNull();
    expect(singleLogin("")).toBeNull();
    expect(singleLogin("author:a b")).toBeNull();
  });
});
