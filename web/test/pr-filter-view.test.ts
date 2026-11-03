// What the filter deck says and how its tree is edited: the decisions the
// components used to make inline, tested without a renderer.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { VIEW_LIMITS, emptyLanes, isGroup, type FilterGroup, type FilterRule, type LaneFilter } from "../../shared/prFilter.ts";
import {
  CHIP_LIMIT, CULPRIT_COLOURS, deckNarrow, FLASH_MS, typedFlash, evalExempt, whyMap, viewDirty, blankRule, chipWords, culpritName, describeAdd, editorFields, culpritColours, deckMode, laneDepth, laneOfId, nodeName,
  opsFor, opWord, sameFilter, slipIn, topChildId, wallRule,
} from "../src/lib/prFilterView.ts";
import { addGroup, addParsed, addRule, canAddGroup, moveToLane, removeNode, replaceRule, setJoin, updateRule, withoutInert } from "../src/lib/prFilterTree.ts";
import { parseRuleText } from "../src/lib/prFilterSyntax.ts";
import { sentence } from "../src/lib/prFilterSentence.ts";

const rule = (id: string, field: string, op: FilterRule["op"], values: string[]): FilterRule => ({ id, field, op, values });
const group = (id: string, join: "and" | "or", children: FilterGroup["children"]): FilterGroup => ({ id, kind: "group", join, children });
function lanes(show: FilterGroup["children"] = [], hide: FilterGroup["children"] = []): LaneFilter {
  const f = emptyLanes();
  return { show: { ...f.show, children: show }, hide: { ...f.hide, children: hide } };
}

describe("deck mode", () => {
  test("no rules is the quiet line", () => expect(deckMode(emptyLanes())).toBe("quiet"));
  test("up to the chip limit stays chips", () => {
    const f = lanes(Array.from({ length: CHIP_LIMIT }, (_, i) => rule(`r${i}`, "text", "contains", ["x"])));
    expect(deckMode(f)).toBe("chips");
  });
  test("one past the limit is a sentence", () => {
    const f = lanes(Array.from({ length: CHIP_LIMIT + 1 }, (_, i) => rule(`r${i}`, "text", "contains", ["x"])));
    expect(deckMode(f)).toBe("sentence");
  });
  test("any nested group is a sentence, even with one rule inside", () => {
    expect(deckMode(lanes([group("g", "or", [rule("a", "author", "is", ["mara"])])]))).toBe("sentence");
  });
  test("a lane joined or is not a nested group", () => {
    const f = lanes([rule("a", "author", "is", ["mara"]), rule("b", "author", "is", ["jules"])]);
    f.show.join = "or";
    expect(deckMode(f)).toBe("chips");
  });
});

describe("culprit colours", () => {
  test("show first, then hide, one colour each, cycling", () => {
    const f = lanes([rule("a", "checks", "is", ["green"])], [rule("b", "text", "contains", ["BETA"])]);
    const c = culpritColours(f);
    expect(c.get("a")).toBe(CULPRIT_COLOURS[0]);
    expect(c.get("show")).toBe(CULPRIT_COLOURS[1]);
    expect(c.get("b")).toBe(CULPRIT_COLOURS[2]);
    expect(c.get("hide")).toBe(CULPRIT_COLOURS[3]);
  });
});

describe("words", () => {
  test("chips say what the rule says", () => {
    expect(chipWords(rule("a", "text", "contains", ["BETA"]))).toEqual({ lead: "title has", value: "BETA", mono: true });
    expect(chipWords(rule("a", "conflict", "not", ["yes"])).value).toBe("No conflicts");
    expect(chipWords(rule("a", "updated", "gt", ["14"]))).toEqual({ lead: "updated", value: "> 14 days ago", mono: false });
    expect(chipWords(rule("a", "author", "not", ["mara"]))).toEqual({ lead: "Author not", value: "mara", mono: false });
  });
  test("a text rule offers contains, exactly, pattern; a number offers is and is not", () => {
    expect(opsFor("text")).toEqual(["contains", "is", "matches"]);
    expect(opsFor("number")).toEqual(["is", "not"]);
  });
  test("an empty filter has no sentence", () => expect(sentence(emptyLanes())).toEqual([]));
  test("nodeName of a group counts its children", () => expect(nodeName(group("g", "or", [rule("a", "x", "set", [])]))).toBe("any of 1"));
});

describe("the wall", () => {
  test("names the rule that hid the most when nothing is left", () => {
    const hiddenBy = new Map([["a", 2], ["b", 5]]);
    expect(wallRule({ hiddenBy }, 7, 0)).toEqual({ id: "b", count: 5 });
  });
  test("no wall while anything is kept, or on an empty board", () => {
    expect(wallRule({ hiddenBy: new Map([["a", 2]]) }, 7, 5)).toBeNull();
    expect(wallRule({ hiddenBy: new Map() }, 0, 0)).toBeNull();
  });
});

describe("finding", () => {
  const f = lanes([group("g", "and", [rule("a", "x", "is", ["1"])])], [rule("b", "y", "is", ["2"])]);
  test("which lane, and which top-level child gets the count", () => {
    expect(laneOfId(f, "a")).toBe("show");
    expect(laneOfId(f, "b")).toBe("hide");
    expect(laneOfId(f, "nope")).toBeNull();
    expect(topChildId(f, "a")).toBe("g");
    expect(topChildId(f, "b")).toBe("b");
  });
  test("equal means same JSON", () => {
    expect(sameFilter(f, structuredClone(f))).toBe(true);
    expect(sameFilter(f, emptyLanes())).toBe(false);
  });
});

describe("tree edits", () => {
  test("a typed rule lands in the lane the text named", () => {
    const r = parseRuleText("-BETA is:conflict");
    if ("error" in r) throw new Error(r.error);
    const f = addParsed(emptyLanes(), r.add);
    expect(f.hide.children).toHaveLength(1);
    expect(f.show.children).toHaveLength(1);
  });
  test("rules go into a nested group by id and out again", () => {
    let f = addGroup(emptyLanes(), "show", group("g", "and", []));
    f = addRule(f, "g", rule("a", "x", "is", ["1"]));
    expect((f.show.children[0] as FilterGroup).children).toHaveLength(1);
    f = removeNode(f, "a");
    expect((f.show.children[0] as FilterGroup).children).toHaveLength(0);
  });
  test("a fourth level of groups is refused, three are fine", () => {
    let f = addGroup(emptyLanes(), "show", group("g1", "and", []));
    f = addGroup(f, "g1", group("g2", "or", []));
    f = addGroup(f, "g2", group("g3", "and", []));
    expect(laneDepth(f.show)).toBe(3);
    expect(canAddGroup(f, "g3")).toBe(false);
    const again = addGroup(f, "g3", group("g4", "and", []));
    expect(again).toBe(f);
    expect(canAddGroup(f, "g2")).toBe(true);
  });
  test("the rule limit holds", () => {
    let f = emptyLanes();
    for (let i = 0; i < VIEW_LIMITS.rules + 3; i++) f = addRule(f, "show", rule(`r${i}`, "x", "is", ["1"]));
    expect(f.show.children).toHaveLength(VIEW_LIMITS.rules);
  });
  test("update, join, move and the lane group itself cannot be removed", () => {
    let f = addRule(emptyLanes(), "show", rule("a", "x", "is", ["1"]));
    f = updateRule(f, "a", { op: "not", values: ["2"] });
    expect((f.show.children[0] as FilterRule).values).toEqual(["2"]);
    f = setJoin(f, "show", "or");
    expect(f.show.join).toBe("or");
    f = moveToLane(f, "a", "hide");
    expect(f.hide.children.map((c) => c.id)).toEqual(["a"]);
    expect(f.show.children).toHaveLength(0);
    expect(removeNode(f, "hide")).toBe(f);
  });
  test("unfinished rules are dropped, set/unset are not unfinished", () => {
    const f = withoutInert(lanes([rule("a", "x", "is", []), rule("b", "y", "set", []), group("g", "or", [rule("c", "z", "contains", [])])]));
    expect(f.show.children.map((c) => c.id)).toEqual(["b", "g"]);
    expect((f.show.children[1] as FilterGroup).children).toHaveLength(0);
    expect(isGroup(f.show.children[1]!)).toBe(true);
  });
});

describe("what a typed rule will do", () => {
  const first = (t: string) => {
    const r = parseRuleText(t);
    if ("error" in r) throw new Error(r.error);
    return r.add[0]!;
  };
  test("said in a few words, with its lane", () => {
    const d = (t: string) => { const a = first(t); return describeAdd(a.lane, a.node); };
    expect(d("-ORBIT-1009")).toBe("Hide card ORBIT-1009");
    expect(d("-BETA")).toBe("Hide words BETA");
    expect(d("#322")).toBe("Show only PR #322");
    expect(d("-is:conflict")).toBe("Hide PRs with conflicts");
    expect(d("updated:>14d")).toBe("Show only PRs untouched for over 14 days");
  });
  test("the editor offers the fieldless extras first, and a field the board lost", () => {
    const f = editorFields([{ key: "author", label: "Author", options: [{ value: "mara", label: "mara" }] }], "milestone");
    expect(f.map((x) => x.key)).toEqual(["text", "card", "number", "conflict", "updated", "author", "milestone"]);
  });
  test("a blank rule starts in its field's first operator", () => {
    expect(blankRule("text", "x")).toEqual({ id: "x", field: "text", op: "contains", values: [] });
    expect(blankRule("conflict", "x").values).toEqual(["yes"]);
  });
});

describe("an edited rule goes back", () => {
  test("in the same lane it stays where it is; in the other it moves", () => {
    let f = addRule(addRule(emptyLanes(), "show", rule("a", "x", "is", ["1"])), "show", rule("b", "y", "is", ["2"]));
    f = replaceRule(f, "show", rule("a", "x", "not", ["9"]));
    expect(f.show.children.map((c) => c.id)).toEqual(["a", "b"]);
    expect((f.show.children[0] as FilterRule).op).toBe("not");
    f = replaceRule(f, "hide", rule("a", "x", "is", ["9"]));
    expect(f.show.children.map((c) => c.id)).toEqual(["b"]);
    expect(f.hide.children.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("blame in words", () => {
  const f = lanes([rule("a", "text", "contains", ["BETA"])]);
  test("a rule by what it says, a lane credited whole by its name", () => {
    expect(culpritName(f, "a")).toBe("title has BETA");
    expect(culpritName(f, "show")).toBe("your Show only rules");
    expect(culpritName(f, "hide")).toBe("your Hide rules");
    expect(culpritName(f, "gone")).toBe("a rule");
  });
});

describe("modified view", () => {
  test("dirty is a difference in what the rules say, not in their ids", () => {
    const a = lanes([rule("a", "text", "contains", ["BETA"])]);
    const b = lanes([rule("zzz", "text", "contains", ["BETA"])]);
    expect(viewDirty(a, b)).toBe(false);
    expect(viewDirty(a, emptyLanes())).toBe(true);
    expect(viewDirty(emptyLanes(), null)).toBe(false);
  });
});

describe("the unread exemption", () => {
  type Row = { number: number; title: string };
  const rows: Row[] = [{ number: 1, title: "BETA a" }, { number: 2, title: "BETA b" }, { number: 3, title: "fine" }];
  const read = (r: Row, k: string) => (k === "text" ? [r.title] : []);
  const f = lanes([], [rule("b", "text", "contains", ["BETA"])]);
  test("a row with something unread stays, and the counts still add up", () => {
    const r = evalExempt(rows, f, read, (x) => x.number === 2);
    expect(r.kept.map((x) => x.number)).toEqual([2, 3]);
    expect(r.hiddenBy.get("b")).toBe(1);
    expect(r.culprit.size).toBe(1);
  });
  test("nothing exempt is plain evalLanes", () => {
    const r = evalExempt(rows, f, read, () => false);
    expect(r.kept.map((x) => x.number)).toEqual([3]);
    expect(r.hiddenBy.get("b")).toBe(2);
  });
  test("whyMap names the rule and its colour per PR number", () => {
    const r = evalExempt(rows, f, read, () => false);
    const w = whyMap(f, r.culprit);
    expect(w.get(1)).toEqual({ id: "b", name: "title has BETA", colour: culpritColours(f).get("b")! });
    expect(w.has(3)).toBe(false);
  });
});

describe("chip value labels", () => {
  test("a facet value reads as the option's label, free text as typed", () => {
    const lab = (f: string, v: string) => (f === "checks" && v === "green" ? "passing" : v);
    expect(chipWords(rule("a", "checks", "is", ["green"]), lab)).toEqual({ lead: "Checks", value: "passing", mono: false });
    expect(chipWords(rule("a", "text", "contains", ["green"]), lab).value).toBe("green");
  });

  test("the Draft rule says Draft once: its field and its value are the same word", () => {
    const lab = (f: string, v: string) => (f === "is" && v === "draft" ? "Draft" : v);
    expect(chipWords(rule("a", "is", "is", ["draft"]), lab)).toEqual({ lead: "", value: "Draft", mono: false });
    expect(chipWords(rule("a", "is", "not", ["draft"]), lab)).toEqual({ lead: "not", value: "Draft", mono: false });
    expect(chipWords(rule("a", "is", "is", ["draft"])).lead).toBe("");
  });
});

describe("the sentence, in a person's words", () => {
  const say = (f: LaneFilter) => sentence(f).map((x) => x.t).join("");
  test("the mockup's own example", () => {
    const f = lanes(
      [rule("a", "checks", "is", ["green"]), group("g", "or", [rule("b", "author", "is", ["mara"]), rule("c", "author", "is", ["jules"])])],
      [rule("d", "text", "contains", ["BETA"]), rule("e", "conflict", "is", ["yes"])],
    );
    expect(say(f)).toBe("Show PRs with passing checks, by mara or jules. Hide any whose title contains BETA, and conflicted ones.");
  });
  test("one verb phrase per field", () => {
    const one = (r: FilterRule, lane: "show" | "hide" = "show") => say(lane === "show" ? lanes([r]) : lanes([], [r]));
    expect(one(rule("a", "conflict", "not", ["yes"]))).toBe("Show PRs without conflicts.");
    expect(one(rule("a", "base", "is", ["main"]))).toBe("Show PRs that target main.");
    expect(one(rule("a", "updated", "lt", ["2"]))).toBe("Show PRs updated in the last 2 days.");
    expect(one(rule("a", "updated", "gt", ["14"]), "hide")).toBe("Hide any untouched for over 14 days.");
    expect(one(rule("a", "card", "unset", []))).toBe("Show PRs with no card.");
    expect(one(rule("a", "label", "is", ["hotfix"]))).toBe("Show PRs labelled hotfix.");
    expect(one(rule("a", "author", "not", ["you"]), "hide")).toBe("Hide any not by you.");
  });
  test("a group in the middle keeps its brackets", () => {
    const f = lanes([group("g", "or", [rule("b", "author", "is", ["mara"]), rule("c", "base", "is", ["main"])]), rule("a", "checks", "is", ["green"])]);
    expect(say(f)).toBe("Show PRs (by mara or that target main), with passing checks.");
  });
});

describe("conflicts read has · conflicts / none", () => {
  test("the operator word is has either way, the value says which", () => {
    expect(opWord("is", "conflict")).toBe("has");
    expect(opWord("not", "conflict")).toBe("has");
    expect(chipWords(rule("a", "conflict", "is", ["yes"])).value).toBe("Has conflicts");
    expect(chipWords(rule("a", "conflict", "not", ["yes"])).value).toBe("No conflicts");
  });
});

describe("slips in place", () => {
  type R = { number: number };
  const rank = new Map([[10, 0], [20, 1], [30, 2], [40, 3]]);
  const ns = (xs: R[]) => xs.map((x) => x.number);
  test("a hidden row goes where its card would have been", () => {
    expect(ns(slipIn([{ number: 10 }, { number: 40 }], [{ number: 30 }], rank))).toEqual([10, 30, 40]);
  });
  test("several keep the board's order, first and last included", () => {
    expect(ns(slipIn([{ number: 20 }], [{ number: 40 }, { number: 10 }], rank))).toEqual([10, 20, 40]);
  });
  test("with no cards they are all there is, and an unranked card sits last", () => {
    expect(ns(slipIn([], [{ number: 20 }, { number: 10 }], rank))).toEqual([10, 20]);
    expect(ns(slipIn([{ number: 99 }], [{ number: 30 }], rank))).toEqual([30, 99]);
  });
});

describe("the board draws slips through slipIn", () => {
  const src = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
  test("in the lane's own order, or in the chosen sort, never appended after the cards", () => {
    expect(src).toContain("slipIn<PrSummary>(all, hiddenHere, lens.rank)");
    expect(src).toContain("rows.map((p) => hiddenNums.has(p.number) ? slipOf(p) : (");
    expect(src).not.toContain("{slips && hiddenHere.map(");
  });
});

describe("rules just typed in, for the tree editor to point at", () => {
  const typed = (t: string) => { const r = parseRuleText(t); if ("error" in r) throw new Error(r.error); return typedFlash(r.add); };
  test("each new rule id maps to the text it came from, lane included", () => {
    const m = typed("-BETA is:conflict");
    expect([...m.values()]).toEqual(["-BETA", "is:conflict"]);
  });
  test("a card and a facet read back as typed", () => {
    expect([...typed("-ORBIT-1042 author:mara").values()]).toEqual(["-ORBIT-1042", "author:mara"]);
  });
  test("it is a moment, not a state", () => {
    expect(FLASH_MS).toBeGreaterThanOrEqual(1500);
    expect(FLASH_MS).toBeLessThanOrEqual(5000);
  });
  test("the deck sets it on every typed add and the tree draws the note", () => {
    const deck = readFileSync(new URL("../src/components/PrFilterDeck.tsx", import.meta.url), "utf8");
    const tree = readFileSync(new URL("../src/components/PrFilterTree.tsx", import.meta.url), "utf8");
    expect(deck.match(/setFlash\(typedFlash\(/g)?.length).toBe(2);
    expect(deck).toContain("flash={flash}");
    expect(tree).toContain("added from typing <code>{typed}</code>");
  });
});

describe("the narrow deck is a sheet", () => {
  test("the fold happens under 520px, and not at it", () => {
    expect(deckNarrow(519)).toBe(true);
    expect(deckNarrow(520)).toBe(false);
  });
  const deck = readFileSync(new URL("../src/components/PrFilterDeck.tsx", import.meta.url), "utf8");
  const sheet = readFileSync(new URL("../src/components/PrFilterSheet.tsx", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../../shared/uiActions.ts", import.meta.url), "utf8");
  test("the deck opens it, tree included, instead of pushing the board down", () => {
    expect(deck).toContain('<PrFilterSheet title="Filter" onClose={() => setSheet(false)}>');
    expect(deck).toContain("{!narrow && treeEl}");
    expect(deck).toContain("{treeEl}\n        </PrFilterSheet>");
  });
  test("it is a dialog with a focus trap, closes on Escape and on the scrim, and is on the registry", () => {
    expect(sheet).toContain("useModalDialog(true, title)");
    expect(sheet).toContain('e.key === "Escape"');
    expect(sheet).toContain("onMouseDown={onClose}");
    expect(ui).toContain('"PrFilterSheet.tsx"');
  });
});
