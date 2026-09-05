/*
 * A pull request read by branch has no check rollup, and the chip must survive
 * that.
 *
 * This shipped and took the whole Source control view to a black screen. The
 * lookup asks GitHub for the cheap field set on purpose — `statusCheckRollup`
 * is a separate GraphQL walk per pull request, four times the cost of the rest
 * together — so `checks` is simply absent, and the chip read `checks.failure`
 * off it. The demo never caught it because its stub returns no pull request at
 * all, so the branch that throws was never rendered.
 *
 * What is pinned here is the SHAPE the server promises, because that is what
 * the component may rely on. A component test would not have caught this
 * either: the value that was missing comes from the server.
 */
import { describe, expect, it } from "bun:test";
import { chipTarget } from "../src/lib/chipTarget.ts";
import type { PrBranchSummary } from "../../shared/types.ts";

/** The exact `--json` field list `prsForBranch` asks `gh` for. */
const FIELDS = "number,title,author,state,isDraft,headRefName,baseRefName,url,updatedAt,reviewDecision";

describe("what a by-branch lookup promises", () => {
  it("does not include the check rollup", () => {
    // If somebody adds it, the cost note in prs.ts has to be revisited — and
    // this test is where they will find out.
    expect(FIELDS).not.toContain("statusCheckRollup");
  });

  it("carries what the chip actually draws", () => {
    for (const f of ["number", "title", "author", "headRefName", "baseRefName"]) {
      expect(FIELDS.split(",")).toContain(f);
    }
  });

  it("matches the field list the server sends", async () => {
    /*
     * Read from the source rather than trusted: a constant copied into a test
     * proves nothing about the code it claims to describe, and this one exists
     * precisely because the two drifted.
     */
    const src = await Bun.file(new URL("../../server/src/prs.ts", import.meta.url)).text();
    expect(src).toContain(`const fields = "${FIELDS}"`);
  });
});

/*
 * Pressing the chip must OPEN that pull request, not search for it.
 *
 * Reported with four screenshots: from Source control, on the branch whose pull
 * request the chip was naming, pressing it put the panel into "Searching… 1 of
 * 75", then "388 matches", then a board filtered to `Custom` — and never showed
 * the pull request. The chip had the number in its hand and spent it on a query
 * box.
 *
 * The cause is that `openPrs` sends a SEARCH, deliberately and correctly: its
 * callers mostly have a string, not an identity. A caller that knows both the
 * repository and the number has no business going through it, so there is a
 * second door, and this is what keeps the chip pointed at it.
 */
describe("the chip opens rather than searches", () => {
  it("hands over repository and number, and never reaches the search", async () => {
    const mod = await import("../src/lib/openPrs.ts");
    const searched: unknown[] = [];
    const opened: { repo: string; number: number; mention?: boolean; n?: number }[] = [];
    const offSearch = mod.onOpenPrs((j) => searched.push(j));
    const offOpen = mod.onOpenPr((j) => opened.push(j));
    try {
      mod.openPr("acme/widgets", 17375);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ repo: "acme/widgets", number: 17375 });
      // `n` rises per request so the same pull request can be asked for twice —
      // pressing the same inbox row again has to jump again.
      mod.openPr("acme/widgets", 17375);
      expect(opened[1]!.n).toBeGreaterThan(opened[0]!.n!);
      expect(searched).toEqual([]);
    } finally { offOpen(); offSearch(); }
  });
});

/*
 * THE DECISION ITSELF, which is the part that had the bug and the part no test
 * could reach.
 *
 * The two assertions that used to stand here read GitPanel.tsx as text and
 * grepped for the call — `toContain("openPr(prRepo!, branchPr.number)")` and
 * `not.toContain("openPrs(String(branchPr.number))")` — and an audit broke the
 * chip past both of them without changing a character either one looks at:
 *
 *     onClick={() => (prRepo ? openPrs(`${branchPr.number}`) : openPr(prRepo!, branchPr.number))}
 *
 * That is the reported bug, restored, searching precisely when it DOES know the
 * repository, with six green tests over it. Both substrings are still in the
 * file — one per arm of a ternary — and a substring cannot say which arm runs.
 *
 * So the decision is a function now, and these are about the function. Every
 * arm, by its answer rather than by its spelling.
 */
const pr = (over: Partial<PrBranchSummary> = {}): PrBranchSummary => ({
  number: 17375,
  title: "Round the checkout total once, at the end",
  author: "d-okafor",
  state: "OPEN",
  isDraft: false,
  headRefName: "fix/checkout-rounding",
  baseRefName: "main",
  url: "https://github.example/acme/widgets/pull/17375",
  updatedAt: "2026-01-02T09:00:00Z",
  reviewDecision: null,
  ...over,
});

describe("where the branch chip goes", () => {
  it("opens the one it is naming, by repository and number", () => {
    const t = chipTarget("acme/widgets", pr());
    expect(t.kind).toBe("open");
    // Narrowed rather than asserted through: if the kind above is wrong this
    // line does not compile, which is the point of a discriminated answer.
    if (t.kind !== "open") return;
    expect(t.repo).toBe("acme/widgets");
    expect(t.pr.number).toBe(17375);
  });

  it("carries the summary through, so the caller needs no non-null assertion", () => {
    /*
     * The call site was `openPr(prRepo!, branchPr.number)`. That `!` was a proof
     * kept in a comment — "the repository is always there when the pull request
     * is" — and a comment is not something the compiler reads. The `open` arm
     * holds both, so the assertion is gone from the component.
     */
    const t = chipTarget("acme/widgets", pr({ title: "Round the total once" }));
    if (t.kind !== "open") throw new Error("expected an open target");
    expect(t.pr.title).toBe("Round the total once");
  });

  it("draws nothing when the branch has no pull request", () => {
    // The ordinary case, and most branches. Not an error and nothing to say.
    expect(chipTarget("acme/widgets", null)).toEqual({ kind: "no-pull-request" });
    expect(chipTarget("acme/widgets", undefined)).toEqual({ kind: "no-pull-request" });
  });

  it("draws nothing — rather than searching — with a number and no repository", () => {
    /*
     * The arm that WAS a search, and the reason this file exists. The state is
     * unreachable (see below), so the only question is what it does if it ever
     * happens, and "type the number into a filter over 388 pull requests" is the
     * behaviour four screenshots were filed against. Silence is the answer: a
     * button that leads nowhere is worse than no button.
     */
    for (const repo of [null, undefined, ""]) {
      expect(chipTarget(repo, pr())).toEqual({ kind: "no-repository" });
    }
  });

  it("has no third answer, because the fallback WAS the bug", () => {
    /*
     * One destination, not two. The temptation, every time somebody reads the
     * `no-repository` arm, is to make it "degrade gracefully" into a search —
     * which is not defensiveness, it is the reported bug behind a condition. So
     * every arm is enumerated here: nothing this function can answer carries a
     * query, and the only thing it can answer that carries an address is `open`.
     */
    const all = [
      chipTarget("acme/widgets", pr()),
      chipTarget(null, pr()),
      chipTarget("acme/widgets", null),
      chipTarget(null, null),
    ];
    expect(all.map((t) => t.kind).sort()).toEqual(
      ["no-pull-request", "no-pull-request", "no-repository", "open"],
    );
    for (const t of all) expect(JSON.stringify(t)).not.toContain("query");
  });

  it("is what the header presses, and the header presses nothing else", async () => {
    /*
     * The wiring, and the one thing here that still has to be read as text: the
     * panel is three thousand lines of JSX and rendering it would mean standing
     * up xterm, the API client and a repository. It is a much smaller claim than
     * the one it replaces — that the component DELEGATES — and it is scoped to
     * the chip's own button, because there are four chips in that header and
     * `toContain("openPr(")` would pass on any of them.
     */
    const src = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
    expect(src).toContain("const prChip = chipTarget(prRepo, branchPr)");

    const start = src.indexOf(`{prChip.kind === "open" && (`);
    expect(start).toBeGreaterThan(-1);
    const button = src.slice(start, src.indexOf("</button>", start));
    expect(button).toContain("openPr(prChip.repo, prChip.pr.number)");
    // And never through the search, which is what it did. Inside the button, so
    // the assertion cannot be satisfied by some other chip's honest `openPrs`.
    expect(button).not.toContain("openPrs(");
    // Nor by hand around the seam: a number reaching `openPr` from anywhere but
    // the target is the `prRepo!` the seam exists to delete.
    expect(button).not.toContain("branchPr");
  });

  it("has no fallback, because the case it guarded does not exist", async () => {
    /*
     * Why the `no-repository` arm draws nothing instead of doing something
     * clever: it cannot happen. `from` comes back only on the one success path,
     * and that path always sets `repo` from `repoIdFor`, which returns null
     * unless it parsed a real owner/name. A branch nobody can reach is a lie the
     * next reader keeps alive.
     */
    const server = await Bun.file(new URL("../../server/src/prs.ts", import.meta.url)).text();
    const ok = server.slice(server.indexOf("return { ok: true, repo:"));
    expect(ok.slice(0, 120)).toContain("repo: id.nameWithOwner");
    expect(ok.slice(0, 120)).toContain("from:");
  });
});
