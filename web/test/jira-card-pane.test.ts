/*
 * The Jira card pane, drawn: the facts the site gives a card, who may change
 * it, and the one sentence that says why not.
 *
 * What a mistake costs: a pane that offers a picker the server will refuse, a
 * switched-off sentence repeated under the facts, the thread and the box, a
 * zero-point card that looks like one with no estimate, or a card with no
 * subtasks wearing a tab for them.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { factsOf, JiraFacts, WRITES_OFF } from "../src/components/jira/JiraFacts.tsx";
import { SubtaskRows } from "../src/components/jira/JiraCard.tsx";
import { JiraPrsView } from "../src/components/jira/JiraCardPrs.tsx";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (o: Partial<ProviderTask> = {}): ProviderTask => ({
  id: "20042", customId: "ORBIT-1042", title: "Fix timeout when syncing the board", url: "https://acme.atlassian.net/browse/ORBIT-1042",
  status: "In Progress", statusKind: "open", priority: "high", due: "2026-02-03", updated: 0, tags: ["sync", "bug"], list: "Orbit",
  assignees: ["Ada Example"], sprint: "Sprint 4", points: 5, parent: { key: "ORBIT-1000", title: "Report improvements" }, ...o,
} as ProviderTask);
const facts = (writable: boolean, t = card()) =>
  renderToStaticMarkup(React.createElement(JiraFacts, { t, writable, onTask() {} }));

describe("the facts a Jira card shows", () => {
  test("sprint, points, priority, due, labels, project and parent are all there", () => {
    const html = facts(false);
    for (const word of ["Sprint 4", "Points", ">5<", "high", "2026-02-03", "sync, bug", "Orbit", "ORBIT-1000", "Report improvements"]) expect(html).toContain(word);
  });

  test("zero points is a fact, no points is not a row", () => {
    expect(factsOf(card({ points: 0 })).map(([k, v]) => `${k}=${v}`)).toContain("Points=0");
    expect(factsOf(card({ points: null })).map(([k]) => k)).not.toContain("Points");
    expect(factsOf(card({ sprint: undefined })).map(([k]) => k)).not.toContain("Sprint");
    expect(factsOf(card({ tags: [] })).map(([k]) => k)).not.toContain("Labels");
  });

  test("a card with no parent has no Parent row", () => {
    expect(facts(false, card({ parent: undefined }))).not.toContain("Parent");
  });
});

describe("with writes off", () => {
  test("status and assignee are plain text, there is no hand-off, and one sentence says why", () => {
    const html = facts(false);
    expect(html).toContain("In Progress");
    expect(html).toContain("Ada Example");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Hand off");
    expect(html.split(WRITES_OFF.slice(0, 30)).length - 1).toBe(1);
    expect(html).toContain("switched off");
  });

  test("the pull request section, told the pane has spoken, adds no second sentence and no box", () => {
    const view = (quiet: boolean) => renderToStaticMarkup(React.createElement(JiraPrsView, {
      links: [], error: "", writable: false, said: "", busy: false, draft: "", onDraft() {}, onLink() {}, quiet,
    }));
    expect(view(true)).not.toContain("switched off");
    expect(view(true)).not.toContain("<input");
    expect(view(false)).toContain("switched off");
  });
});

describe("with writes on", () => {
  test("the pane makes no apology", () => {
    expect(facts(true)).not.toContain("switched off");
  });
});

describe("the subtasks tab", () => {
  test("each subtask is its key, its title and its status", () => {
    const html = renderToStaticMarkup(React.createElement(SubtaskRows, { rows: [card({ id: "1", customId: "ORBIT-1046", title: "Write the retry test", status: "To Do" })] }));
    for (const w of ["ORBIT-1046", "Write the retry test", "To Do"]) expect(html).toContain(w);
  });
});

describe("the pane's shape, read from source", () => {
  const src = async (p: string) => (await Bun.file(new URL(p, import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  test("the tabs are Card, GitHub and Subtasks, and Subtasks only for a card that has some", async () => {
    const c = await src("../src/components/jira/JiraCard.tsx");
    expect(c).toContain('["card", "Card"]');
    expect(c).toContain('["github", "GitHub"]');
    expect(c).toContain("...(subtasks.length ? [[\"subtasks\", `Subtasks ${subtasks.length}`] as const] : [])");
    expect(c).toContain('tab === "subtasks" && !subtasks.length ? "card" : tab');
  });

  test("the composer and its sentence exist only with writes on", async () => {
    const c = await src("../src/components/jira/JiraCard.tsx");
    expect(c).toContain("{writes && <div");
    expect(c).not.toContain("Commenting is switched off");
  });

  test("the board draws one pane for both shells", async () => {
    const t = await src("../src/components/TasksPanel.tsx");
    expect(t).toContain("source.CardPane");
    expect((t.match(/\{cardBody\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
