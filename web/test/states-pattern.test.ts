/*
 * The hide rule of the state patterns, and pins that the Jira screens use the house components and no longer draw the old strings.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { emptyLine, fieldRule } from "../src/lib/stateRule.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("fieldRule", () => {
  test("a value shows", () => expect(fieldRule({ value: "Ana Example", canFill: false })).toBe("show"));
  test("no value, cannot fill: hide", () => {
    expect(fieldRule({ value: "", canFill: false })).toBe("hide");
    expect(fieldRule({ value: "  ", canFill: false })).toBe("hide");
    expect(fieldRule({ value: null, canFill: false })).toBe("hide");
    expect(fieldRule({ value: undefined, canFill: false })).toBe("hide");
  });
  test("no value, can fill: the prompt", () => expect(fieldRule({ value: null, canFill: true })).toBe("action"));
  test("a verdict stays even when empty", () => expect(fieldRule({ value: "", canFill: false, verdict: true })).toBe("show"));
});

describe("emptyLine", () => {
  test("three or more merge into one line", () => expect(emptyLine(["sub-tasks", "links", "files"])).toBe("Empty: sub-tasks, links, files"));
  test("fewer than three do not", () => expect(emptyLine(["links", "files"])).toBe(""));
});

describe("Jira screens use the state components", () => {
  const old: Array<[string, string[]]> = [
    ["components/jira/JiraFacts.tsx", [">None<"]],
    ["components/jira/JiraDescription.tsx", ["No description."]],
    ["components/jira/JiraJoins.tsx", ["No sub-tasks yet.", "No linked work items.", "No web links."]],
    ["components/CardFiles.tsx", ["No files on this card."]],
    ["components/jira/detail/WorkTab.tsx", ["No session names this card."]],
    ["components/jira/list/JiraBoard.tsx", ["drop one here", "agx-jb-none"]],
  ];
  for (const [file, strings] of old) {
    test(`${file} drops the old strings`, () => { for (const s of strings) expect(src(file)).not.toContain(s); });
  }
  for (const file of ["components/jira/JiraDescription.tsx", "components/jira/JiraJoins.tsx", "components/CardFiles.tsx", "components/jira/detail/WorkTab.tsx", "components/jira/list/JiraBoard.tsx"]) {
    test(`${file} uses StateCollapse`, () => expect(src(file)).toContain("StateCollapse"));
  }
  test("the facts apply the hide rule", () => expect(src("components/jira/JiraFacts.tsx")).toContain("fieldRule("));
  test("the board has one hint, not a box per column", () => expect(src("components/jira/list/JiraBoard.tsx")).toContain("agx-jb-hint"));
  test("the skeleton waits 150 ms", () => expect(src("components/tasks/BoardState.tsx")).toContain("150"));
  test("the card folds its writable empty blocks into one line", () => {
    const card = src("components/jira/JiraCard.tsx");
    expect(card).toContain("<StateFold line={fold.line}");
    expect(card).toContain("emptyLine(");
    for (const f of ["components/jira/JiraJoins.tsx", "components/jira/JiraFiles.tsx", "components/jira/JiraDescription.tsx"]) expect(src(f)).toContain("folded");
  });
  test("errors and the not-connected state use the house components", () => {
    expect(src("components/jira/list/JiraStates.tsx")).toContain("<StateDisconnected");
    expect(src("components/jira/list/JiraStates.tsx")).toContain("<StateError");
    expect(src("components/jira/JiraCard.tsx")).toContain("<StateError");
    expect(src("components/JiraPane.tsx")).toContain("<StateError");
  });
});

describe("states part 3: Manifest, lazy panels, loading lines", () => {
  test("Manifest: one quiet line for a quiet week, house error", () => {
    const m = src("components/ManifestView.tsx");
    expect(m).toContain("quietWeek");
    expect(m).toContain("<EmptyState>");
    expect(m).toContain("<StateError");
    expect(m).not.toContain("mv-errbox");
    expect(m).not.toContain('<div className="mv-quiet">Nothing');
  });
  test("LazyPanel error is the house component, old string gone", () => {
    const l = src("components/LazyPanel.tsx");
    expect(l).toContain("<StateError");
    expect(l).not.toContain("could not be loaded.</div>");
  });
  test("loading is the house skeleton, not bare text (mockup #6)", () => {
    expect(src("components/CommandBar.tsx")).toContain("<BoardSkeleton");
    expect(src("components/PrPanel.tsx")).toContain("<BoardSkeleton");
  });
});

describe("states: mockup mismatches fixed", () => {
  test("the card's one Empty line also names estimate, parent, sprint and labels", () => {
    const card = src("components/jira/JiraCard.tsx");
    for (const n of ['"estimate"', '"parent"', '"sprint"', '"labels"']) expect(card).toContain(n);
    const facts = src("components/jira/JiraFacts.tsx");
    expect(facts).toContain("hid(\"parent\")");
    expect(facts).toContain("hid(\"labels\")");
    expect(facts).toContain("estFolded");
  });
  test("not connected shows the cached cards with their age", () => {
    const s = src("components/jira/list/JiraStates.tsx");
    expect(s).toContain("age={model.at > 0 ? ago(model.at)");
    expect(s).toContain("model.cards.slice(");
  });
  test("Jira and ClickUp settings: not connected is a page state, not a badge", () => {
    for (const f of ["components/JiraPane.tsx", "components/ClickUpPane.tsx"]) {
      expect(src(f)).toContain("<StateDisconnected");
      expect(src(f)).not.toContain('>Not connected</StatusBadge>');
    }
  });
  test("PR reviewers: the warning has a Request button", () => expect(src("components/PrPanel.tsx")).toContain("onRequest={(e) => onEditField(\"reviewers\", e)}"));
  test("review rail: the clean verdict counts", () => expect(src("components/FileRail.tsx")).toContain("Clean: 0 threads, 0 failing, 0 comments"));
  test("board: an empty filtered board offers Clear filter", () => {
    expect(src("components/jira/list/JiraBoard.tsx")).toContain("Clear filter");
    expect(src("components/jira/list/JiraListView.tsx")).toContain("onClearFilter=");
  });
  test("skeleton: past 8 s it says Still reading and offers Cancel", () => {
    const b = src("components/tasks/BoardState.tsx");
    expect(b).toContain("STILL_READING_MS = 8000");
    expect(b).toContain("Still reading…");
  });
  test("no bare Loading text where the skeleton belongs", () => {
    for (const f of ["AskedAlertLog", "BudgetsPane", "ReviewPromptsPane", "CommandBar", "plugins/Market", "SettingsModal"]) expect(src(`components/${f}.tsx`)).toContain("<BoardSkeleton");
    expect(src("components/PrPanel.tsx")).not.toContain("<EmptyState>Loading…</EmptyState>");
  });
  test("StateError always says where to change it", () => expect(src("components/tasks/BoardState.tsx")).toContain("Open settings</StateButton>}"));
});
