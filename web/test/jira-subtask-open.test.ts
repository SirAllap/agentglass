import { describe, expect, test } from "bun:test";

/*
 * ORBIT-123: opening a subtask from the Jira list or the panel. Four defects, measured on the installed
 * app: a nested list row did nothing; a panel row threw the whole list away into Looked up; that Looked
 * up row drew the wrong type letter and a stray dot; an open subtask said nothing about its parent.
 * Source assertions (as in portal-attach.test.ts) rather than a render, since the fix is in which prop a
 * click reaches, not in new markup.
 */

const read = (path: string) => Bun.file(new URL(`../src/components/jira/${path}`, import.meta.url)).text();

describe("defect 1: a nested row in the LIST did nothing on click", () => {
  test("a nested row opens through onOpenCard, not the plain onOpen that only selects an id already on the page", async () => {
    const lanes = await read("list/JiraLanes.tsx");
    expect(lanes).toContain("onOpen={nested ? () => onOpenCard(t) : onOpen}");
  });

  test("the list view wires a real opener, not the id-only onOpen, into onOpenCard", async () => {
    const view = await read("list/JiraListView.tsx");
    expect(view).toMatch(/<JiraLanes[^>]*onOpenCard=\{openCard\}/);
  });
});

describe("defect 2: a PANEL subtask click threw the main list away into Looked up", () => {
  test("the panel's CardRow opens in place when given onOpen, instead of always firing the cross-view jump", async () => {
    const sections = await read("JiraSections.tsx");
    expect(sections).toContain('onClick={() => (onOpen ? onOpen(t) : openCard(k, k, "jira"))}');
  });

  test("the subtask tree carries onOpenCard down into both the writable and read-only subtask rows", async () => {
    const tree = await read("detail/SubtaskTree.tsx");
    expect(tree).toMatch(/SubtasksBlock[^/]*onOpenCard=\{onOpenCard\}/);
    expect(tree).toMatch(/SubtasksSection[^/]*onOpenCard=\{onOpenCard\}/);
  });
});

describe("defect 3: the Looked up row's wrong type letter and stray dot", () => {
  test("a subtask that nestSubtasks could not nest wears a chip, not the lane's status dot", async () => {
    const lanes = await read("list/JiraLanes.tsx");
    expect(lanes).toContain("(isSubtask(e.card) ? { chip: true } : {})");
    // The dot is suppressed for any chip row — a lone subtask included — not only the chevron's own children.
    expect(lanes).toContain("lane.flat && lane.mark !== \"area\" && !o.chip");
  });
});

describe("defect 4: an open subtask said nothing about its parent", () => {
  test("the panel header draws a clickable parent breadcrumb above the title, only for a subtask", async () => {
    const header = await read("detail/DetailHeader.tsx");
    expect(header).toContain("{isSubtask(t) && t.parent && <ParentCrumb p={t.parent} onOpen={onOpenByKey} />}");
  });

  test("the Parent field in the facts tile opens in place via onOpenByKey instead of only the cross-view jump", async () => {
    const facts = await read("JiraFacts.tsx");
    expect(facts).toContain("onClick={() => (onOpenByKey ? onOpenByKey(t.parent!.key) : openCard(t.parent!.key, t.parent!.key, \"jira\"))}");
  });

  test("Back reuses the existing finder history rather than a new history system", async () => {
    const view = await read("list/JiraListView.tsx");
    expect(view).toContain('from "../../../lib/finderHistory.ts"');
    const dock = await read("list/JiraDock.tsx");
    // Alt+Left is read the same way the dock already reads its other keys, guarded off text fields.
    expect(dock).toContain('e.key === "ArrowLeft" && !inField(e.target as HTMLElement)');
  });
});
