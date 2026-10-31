// The board-side decisions that follow the approved mockup (phase 2c): the
// rule chip words, the wall copy, the search placeholder, the width bands of
// the docked detail and the places the screens must keep their anchors.
// Values are asserted as values; screens are read as text because there is no
// renderer in this project.
import { describe, expect, test } from "bun:test";
import { emptyLanes, type FilterGroup, type FilterRule, type LaneFilter } from "../../shared/prFilter.ts";
import { ruleChipView, ruleWithLane, wallCopy } from "../src/lib/prFilterView.ts";
import { COMPACT_PX, SIDE_FOLDS_PX, detailBand } from "../src/lib/prDock.ts";
import { searchPlaceholder } from "../src/lib/prSearch.ts";

const src = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url)).text();
const rule = (id: string, field: string, op: FilterRule["op"], values: string[]): FilterRule => ({ id, field, op, values });
function lanes(show: FilterGroup["children"] = [], hide: FilterGroup["children"] = []): LaneFilter {
  const f = emptyLanes();
  return { show: { ...f.show, children: show }, hide: { ...f.hide, children: hide } };
}

describe("a rule chip reads as lane word + rule", () => {
  test("a title rule is a quoted phrase under the lane word", () => {
    const v = ruleChipView(rule("a", "text", "contains", ["wip"]), "hide");
    expect(v.label).toBe("Hide");
    expect(v.quoted).toBe(true);
    expect(v.lead).toBe("");
  });
  test("every other rule keeps its field lead, and the show lane says Show only", () => {
    const v = ruleChipView(rule("a", "author", "is", ["ana-dev"]), "show");
    expect(v.label).toBe("Show only");
    expect(v.quoted).toBe(false);
    expect(v.lead).not.toBe("");
  });
  test("the wall names a rule with its lane", () => {
    expect(ruleWithLane("hide", rule("a", "text", "contains", ["wip"]))).toStartWith("Hide · ");
    expect(ruleWithLane("show", rule("a", "text", "contains", ["wip"]))).toStartWith("Show only · ");
  });
});

describe("the wall says what the rules did, naming at most three", () => {
  test("one rule, one pull request", () => {
    const w = wallCopy(lanes([], [rule("a", "text", "contains", ["wip"])]), 1);
    expect(w.title).toBe("Your rules hide the only pull request");
    expect(w.parts.filter((p) => p.b)).toHaveLength(1);
    expect(w.parts.at(-1)!.t).toBe(" leaves nothing.");
  });
  test("four rules are counted, not listed", () => {
    const hide = [1, 2, 3, 4].map((i) => rule(`r${i}`, "text", "contains", [`x${i}`]));
    const w = wallCopy(lanes([], hide), 12);
    expect(w.title).toBe("Your rules hide all 12 pull requests");
    expect(w.parts.find((p) => p.b)!.t).toBe("4 rules");
  });
});

describe("the search box names the repository it searches", () => {
  test("with and without a repository", () => {
    expect(searchPlaceholder("acme/orbit")).toBe("Search all of acme/orbit · @person · -word · is:draft");
    expect(searchPlaceholder()).toBe("Search all of this repository · @person · -word · is:draft");
  });
});

describe("the docked detail's width bands are the mockup's 860 and 760", () => {
  test("edges belong to the narrower band", () => {
    expect(detailBand(SIDE_FOLDS_PX + 1)).toBe("wide");
    expect(detailBand(SIDE_FOLDS_PX)).toBe("mid");
    expect(detailBand(COMPACT_PX + 1)).toBe("mid");
    expect(detailBand(COMPACT_PX)).toBe("narrow");
    expect(detailBand(620)).toBe("narrow");
  });
  test("an unmeasured width is the wide layout", () => {
    expect(detailBand(null)).toBe("wide");
    expect(detailBand(0)).toBe("wide");
    expect(detailBand(NaN)).toBe("wide");
  });
  test("the panel measures the body and folds the sidebar into a Details fold", async () => {
    const panel = await src("components/PrPanel.tsx");
    expect(panel).toContain("setBand(detailBand(el.clientWidth))");
    expect(panel).toContain("fold={band !== \"wide\"}");
    expect(panel).toContain("data-side-fold");
    expect(panel).not.toMatch(/container-type/);
    const css = await src("index.css");
    expect(css).toContain('#pr-tab-body[data-band="narrow"] .agx-tree3 { width: 170px; }');
  });
});

describe("the board's states", () => {
  test("a person's board is rows under an info banner with Follow and Back", async () => {
    const tb = await src("components/TriageBoard.tsx");
    expect(tb).toContain("<PersonBanner login={viewer}");
    expect(tb).toContain('<b>Viewing {login}{name ? ` (${name})` : ""}.</b> Every pull request they wrote or were asked on. Your rules do not apply.');
    expect(tb).toContain('{follow.on ? "Following" : "Follow"}');
  });
  test("search is a banner with the way back, and a nothing-found state that can ask GitHub", async () => {
    const tb = await src("components/TriageBoard.tsx");
    expect(tb).toContain("Searching every pull request in {repoSlug");
    expect(tb).toContain("Back to the board");
    expect(tb).toContain("Ask GitHub");
    const panel = await src("components/PrPanel.tsx");
    expect(panel).toContain("ask: answered || query.trim() === \"\" ? undefined : { query: query.trim(), run: runSearch }");
  });
  test("Closed is an All | Merged | Closed switch over one list", async () => {
    const tb = await src("components/TriageBoard.tsx");
    expect(tb).toContain('label="Show" value={closedF}');
    expect(tb).toContain('"Nothing closed"');
  });
  test("the lane's info, sort and fold are the 26px square, like the mockup's .btn.sq", async () => {
    const tb = await src("components/TriageBoard.tsx");
    expect(tb.match(/style=\{\{ width: HIT, height: HIT, color:/g)).toHaveLength(3);
  });
  test("a missing sign-in and a missing remote are one notice, not a bare sentence", async () => {
    const panel = await src("components/PrPanel.tsx");
    expect(panel).toContain("GitHub is not signed in on this machine");
    expect(panel).toContain("This project has no GitHub remote");
    expect(panel).toContain('requestWorktreeJump({ view: "git", root: projectRoot })');
  });
});
