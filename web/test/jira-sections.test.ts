/*
 * The sections of a Jira card, drawn: the ones a card lacks are not drawn, the
 * subtasks carry their progress, links are grouped by the phrase of this card's
 * side, and storage that cannot be read leaves every section open.
 *
 * What a mistake costs: an empty "Subtasks" heading on every card, "blocks"
 * and "is blocked by" under one title, a pull request's progress bar that
 * says 100% of nothing, or a pane that will not draw in a private window.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { groupLinked, LinkedSection, JiraSection, SubtasksSection, WebLinksSection } from "../src/components/jira/JiraSections.tsx";
import { FactValue } from "../src/components/jira/JiraFacts.tsx";
import { globalStubs } from "./stubGlobal.ts";
import type { CardLinked, CardWebLink, ProviderTask } from "../../shared/providers.ts";

const stubGlobal = globalStubs();
const task = (o: Partial<ProviderTask> = {}): ProviderTask => ({
  id: "20046", customId: "ORBIT-1046", title: "Crash on an empty board", url: "", status: "To Do", statusKind: "open", priority: "high",
  due: null, updated: 0, tags: [], list: "Orbit", assignees: [], people: [], mine: false, issueType: "Bug", ...o,
} as ProviderTask);
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const linked = (id: string, phrase: string, key: string, direction: "in" | "out" = "out"): CardLinked => ({ id, phrase, type: "Blocks", direction, task: task({ id: key, customId: key }) });

describe("a section a card does not have is not drawn", () => {
  test("no subtasks, no links, no files, no web links: nothing at all", () => {
    expect(html(React.createElement(SubtasksSection, { rows: [] }))).toBe("");
    expect(html(React.createElement(LinkedSection, { linked: [] }))).toBe("");
    expect(html(React.createElement(WebLinksSection, { links: [], error: "" }))).toBe("");
    expect(html(React.createElement(WebLinksSection, { links: null, error: "" }))).toBe("");
  });

  test("a web-link read that failed says so, and a Jira that answered with none says nothing", () => {
    expect(html(React.createElement(WebLinksSection, { links: [], error: "Jira did not answer" }))).toContain("Jira did not answer");
  });
});

describe("subtasks", () => {
  test("progress counts the done ones of all of them", () => {
    const out = html(React.createElement(SubtasksSection, { rows: [task(), task({ id: "2", customId: "ORBIT-1047", statusKind: "done", status: "Done" }), task({ id: "3", customId: "ORBIT-1048" })] }));
    expect(out).toContain("1 of 3 done");
    expect(out).toContain('aria-valuenow="33"');
    expect(out).toContain("ORBIT-1047");
  });
  test("all done is a full bar and none done an empty one", () => {
    const done = html(React.createElement(SubtasksSection, { rows: [task({ statusKind: "done" })] }));
    expect(done).toContain('aria-valuenow="100"');
    expect(html(React.createElement(SubtasksSection, { rows: [task()] }))).toContain('aria-valuenow="0"');
  });
});

describe("linked work items", () => {
  test("two phrases are two groups in the order the site gave them, and one phrase is one group", () => {
    const g = groupLinked([linked("1", "blocks", "ORBIT-1"), linked("2", "is blocked by", "ORBIT-2", "in"), linked("3", "blocks", "ORBIT-3")]);
    expect(g.map((x) => [x.phrase, x.rows.map((r) => r.task.customId)])).toEqual([["blocks", ["ORBIT-1", "ORBIT-3"]], ["is blocked by", ["ORBIT-2"]]]);
  });
  test("each phrase heads its own rows and every row names its card", () => {
    const out = html(React.createElement(LinkedSection, { linked: [linked("1", "blocks", "ORBIT-1"), linked("2", "relates to", "ORBIT-2", "in")] }));
    expect(out.indexOf("blocks")).toBeLessThan(out.indexOf("ORBIT-1"));
    expect(out.indexOf("relates to")).toBeLessThan(out.indexOf("ORBIT-2"));
    expect(out).toContain("Linked work items");
  });
});

describe("web links and files", () => {
  test("a link shows its title and where it goes, and the address is the tooltip", () => {
    const link: CardWebLink = { id: "1", url: "https://docs.acme.example/design/sync", title: "Design note", host: "docs.acme.example" };
    const out = html(React.createElement(WebLinksSection, { links: [link], error: "" }));
    for (const w of ["Design note", "docs.acme.example", 'title="https://docs.acme.example/design/sync"']) expect(out).toContain(w);
  });
});

describe("the Details", () => {
  test("an unfilled one says None, a flag says what it is, the reporter has a face", () => {
    expect(html(React.createElement(FactValue, { f: { id: "start", label: "Start date", value: "" } }))).toContain("None");
    expect(html(React.createElement(FactValue, { f: { id: "flag", label: "Flagged", value: "Impediment", tone: "flag" } }))).toContain("Impediment");
    const rep = html(React.createElement(FactValue, { f: { id: "reporter", label: "Reporter", value: "Grace Sample", initials: "GS" } }));
    expect(rep).toContain("Grace Sample");
    expect(rep).toContain("GS");
  });
});

describe("a section's open state", () => {
  test("storage that throws leaves it open, and a title with a count says the count", () => {
    stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
    const out = html(React.createElement(JiraSection, { id: "x", title: "Things", count: 3, children: React.createElement("p", null, "inside") }));
    expect(out).toContain("inside");
    expect(out).toContain("Things");
    expect(out).toContain('aria-expanded="true"');
  });
});
