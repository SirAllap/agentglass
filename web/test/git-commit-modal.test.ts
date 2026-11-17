import { describe, expect, it } from "bun:test";
import { subjectMeter, commitTitle, commitPlan, splitPath, MAP_FROM } from "../src/lib/gitCommitModal.ts";

const f = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions });

describe("subjectMeter", () => {
  it("is ok up to 62, amber 63-72, red past 72, with the number always", () => {
    expect(subjectMeter("a".repeat(62)).level).toBe("ok");
    expect(subjectMeter("a".repeat(63)).level).toBe("warn");
    expect(subjectMeter("a".repeat(72)).level).toBe("warn");
    const over = subjectMeter("a".repeat(81));
    expect(over.level).toBe("over");
    expect(over.label).toBe("81/72");
    expect(over.hint).toBe("9 characters over 72. Git keeps it, but the log cuts it.");
  });
  it("fills the ring and caps it at full", () => {
    expect(subjectMeter("").fill).toBe(0);
    expect(subjectMeter("a".repeat(200)).fill).toBe(1);
  });
});

describe("commitTitle", () => {
  it("asks a question, singular and plural, and names the fold", () => {
    expect(commitTitle(3, false)).toBe("Commit 3 files?");
    expect(commitTitle(1, false)).toBe("Commit 1 file?");
    expect(commitTitle(3, true)).toBe("Fold 3 files into the last commit?");
  });
});

describe("commitPlan", () => {
  const files = [f("src/a.ts", 52, 9), f("src/b.ts", 31), f("test/a.test.ts", 3, 3)];
  const base = { files, off: new Set<string>(), subject: "Retry", fold: false, ahead: 2 };
  it("sums only the ticked files", () => {
    const p = commitPlan({ ...base, off: new Set(["src/b.ts"]) });
    expect(p.paths).toEqual(["src/a.ts", "test/a.test.ts"]);
    expect([p.additions, p.deletions]).toEqual([55, 12]);
    expect(p.actionLabel).toBe("Commit 2 files");
  });
  it("is off with a reason when nothing is ticked or the subject is empty", () => {
    expect(commitPlan({ ...base, off: new Set(files.map((x) => x.path)) }).reason).toBe("Tick at least one file.");
    expect(commitPlan({ ...base, subject: "  " }).reason).toBe("Write a subject first.");
    expect(commitPlan(base).ok).toBe(true);
  });
  it("offers the fold only while the last commit is not pushed", () => {
    expect(commitPlan({ ...base, ahead: 0, fold: true, lastHash: "a41c9e2" })).toMatchObject({ canFold: false, actionLabel: "Commit 3 files", foldNote: "a41c9e2 is on origin already" });
    expect(commitPlan({ ...base, fold: true })).toMatchObject({ canFold: true, actionLabel: "Rewrite last commit" });
    expect(commitPlan({ ...base, ahead: null, fold: true }).canFold).toBe(false);
  });
  it("switches the strip to a status map at many files", () => {
    expect(commitPlan({ ...base, files: Array.from({ length: MAP_FROM }, (_, i) => f(`x${i}`)) }).statusMap).toBe(true);
    expect(commitPlan(base).statusMap).toBe(false);
  });
});

describe("splitPath", () => {
  it("dims the directory only", () => {
    expect(splitPath("src/checkout/retry.ts")).toEqual({ dir: "src/checkout/", name: "retry.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

import { filterFiles, statusCounts, statusLetter } from "../src/lib/gitCommitModal.ts";
import { describe as d2, expect as e2, test as t2 } from "bun:test";

d2("status map and filter", () => {
  t2("letters and counts", () => {
    e2(statusLetter("modified")).toBe("M");
    e2(statusLetter("added")).toBe("A");
    e2(statusLetter(undefined)).toBe("M");
    e2(statusCounts([{ path: "a", additions: 0, deletions: 0, status: "added" }, { path: "b", additions: 0, deletions: 0 }, { path: "c", additions: 0, deletions: 0, status: "modified" }])).toEqual([{ letter: "M", n: 2 }, { letter: "A", n: 1 }]);
  });
  t2("filter is case-insensitive on the whole path", () => {
    const f = [{ path: "src/Cart.tsx" }, { path: "docs/old.md" }];
    e2(filterFiles(f, " cart ")).toEqual([{ path: "src/Cart.tsx" }]);
    e2(filterFiles(f, "")).toHaveLength(2);
  });
});
