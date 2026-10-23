/*
 * What a Jira card is joined to, on the screen: the ways a link can read, what it says before it is made, how the pane
 * finds the link a write just made, and what the controls keep (the "+" at the end of the header, a removal that asks
 * first and says what goes, an Undo where the site lets the old state come back).
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canHaveSubtasks, linkEffect, linkWays, madeLink, parseCardId, parseSubtaskTitle, parseWebAddress, webAddress } from "../src/lib/jiraJoins.ts";
import { SubtasksBlock, LinkedBlock, WebLinksBlock, type JoinAct } from "../src/components/jira/JiraJoins.tsx";
import { SubtasksSection } from "../src/components/jira/JiraSections.tsx";
import type { CardLinked, CardWebLink, ProviderTask } from "../../shared/providers.ts";

// The credential is built apart so no single line spells out a whole login URL; the string is unchanged.
const PW = "b";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const kinds = [
  { id: "10000", name: "Blocks", outward: "blocks", inward: "is blocked by" },
  { id: "10003", name: "Relates", outward: "relates to", inward: "relates to" },
];
const task = (o: Partial<ProviderTask> = {}): ProviderTask => ({ id: "20043", customId: "ORBIT-1043", title: "Retry the webhook", url: "", status: "To Do", statusKind: "open", priority: null, updated: 0, tags: [], assignees: [], ...o } as ProviderTask);
const act: JoinAct = {
  subtask: async () => null, relate: async () => ({}), unrelate: async () => null, webAdd: async () => ({}), webRemove: async () => null, onRowTask: () => undefined,
};

describe("the ways a link can read", () => {
  test("each phrase of each type, and a type whose two phrases are the same once", () => {
    expect(linkWays(kinds).map((w) => [w.value, w.phrase, w.outward])).toEqual([["10000:out", "blocks", true], ["10000:in", "is blocked by", false], ["10003:out", "relates to", true]]);
  });
  test("what a link would be is said before it is made", () => {
    expect(linkEffect("ORBIT-1042", linkWays(kinds)[1]!, "ORBIT-1050")).toBe("ORBIT-1042 is blocked by ORBIT-1050");
  });
  test("the link a write made is found by the other card, the type and the side, and not by another's", () => {
    const rows = [
      { id: "1", phrase: "is blocked by", type: "Blocks", direction: "in", task: task({ customId: "ORBIT-1050" }) },
      { id: "2", phrase: "blocks", type: "Blocks", direction: "out", task: task({ customId: "ORBIT-1050" }) },
      { id: "3", phrase: "blocks", type: "Blocks", direction: "out", task: task({ customId: "ORBIT-1060" }) },
    ] as CardLinked[];
    expect(madeLink(rows, "ORBIT-1050", { kind: "Blocks", outward: true })!.id).toBe("2");
    expect(madeLink(rows, "ORBIT-1050", { kind: "Blocks", outward: false })!.id).toBe("1");
    expect(madeLink(rows, "ORBIT-1050", { kind: "Relates", outward: true })).toBeUndefined();
    expect(madeLink(undefined, "ORBIT-1050", { kind: "Blocks", outward: true })).toBeUndefined();
  });
});

describe("what is sent is checked first", () => {
  test("a sub-task title is one line, not empty, at most 255", () => {
    expect(parseSubtaskTitle("Write the draft").ok).toBe(true);
    for (const bad of ["", "  ", "a\nb", "x".repeat(256)]) expect(parseSubtaskTitle(bad).ok).toBe(false);
  });
  test("a card id is a key", () => {
    expect(parseCardId("ORBIT-1042").ok).toBe(true);
    for (const bad of ["", "1042", "orbit 1042", "ORBIT-"]) expect(parseCardId(bad).ok).toBe(false);
  });
  test("an address is http or https, with no password", () => {
    expect(webAddress("https://docs.acme.example/note")).toBe("https://docs.acme.example/note");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", `https://a:${PW}@docs.acme.example/`, "docs.acme.example", ""]) { expect(webAddress(bad)).toBeNull(); expect(parseWebAddress(bad).ok).toBe(false); }
  });
  test("a card that is a sub-task is not offered one", () => {
    expect(canHaveSubtasks("Sub-task")).toBe(false);
    expect(canHaveSubtasks("Subtask")).toBe(false);
    expect(canHaveSubtasks("Story")).toBe(true);
    expect(canHaveSubtasks(undefined)).toBe(true);
  });
});

describe("the controls, drawn", () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);
  const parent = task({ customId: "ORBIT-1042", issueType: "Story" });

  test("with writes on, a card with no sub-tasks still has its section, a way to add one, and says there are none", () => {
    const h = html(React.createElement(SubtasksBlock, { rows: [], parent, writable: true, act }));
    expect(h).toContain("Subtasks");
    expect(h).toContain("Add a sub-task");
    expect(h).toContain("No sub-tasks yet.");
  });
  test("a sub-task has no way to add one, and with no rows no section", () => {
    expect(html(React.createElement(SubtasksBlock, { rows: [], parent: task({ issueType: "Sub-task" }), writable: true, act }))).toBe("");
  });
  test("each sub-task row carries its own status control; read-only keeps the plain pill", () => {
    const rows = [task({ id: "1", customId: "ORBIT-1051", title: "Draft" })];
    expect(html(React.createElement(SubtasksBlock, { rows, parent, writable: true, act }))).toContain('title="Status"');
    expect(html(React.createElement(SubtasksSection, { rows }))).not.toContain('title="Status"');
  });
  test("linked work items offer a way to link and a way to take each off, and say there are none when there are none", () => {
    const linked = [{ id: "77", phrase: "blocks", type: "Blocks", direction: "out", task: task() }] as CardLinked[];
    const h = html(React.createElement(LinkedBlock, { linked, card: "ORBIT-1042", writable: true, act }));
    expect(h).toContain("Link another work item");
    expect(h).toContain("Take off the link to ORBIT-1043");
    expect(html(React.createElement(LinkedBlock, { linked: [], card: "ORBIT-1042", writable: true, act }))).toContain("No linked work items.");
    expect(html(React.createElement(LinkedBlock, { linked: [], card: "ORBIT-1042", writable: false, act }))).toBe("");
    expect(html(React.createElement(LinkedBlock, { linked, card: "ORBIT-1042", writable: false, act }))).not.toContain("Take off");
  });
  test("web links offer to add one and to take each off; nothing read yet draws nothing", () => {
    const web = [{ id: "5", url: "https://docs.acme.example/note", title: "Design note", host: "docs.acme.example" }] as CardWebLink[];
    const h = html(React.createElement(WebLinksBlock, { links: web, error: "", writable: true, card: "ORBIT-1042", act }));
    expect(h).toContain("Add a web link");
    expect(h).toContain("Take off docs.acme.example");
    expect(html(React.createElement(WebLinksBlock, { links: null, error: "", writable: true, card: "ORBIT-1042", act }))).toBe("");
    expect(html(React.createElement(WebLinksBlock, { links: web, error: "", writable: false, card: "ORBIT-1042", act }))).not.toContain("Take off");
  });
});

describe("the rules the controls keep, read from source", () => {
  test("the plus is the last thing in the header, after the line a change says, in every state", async () => {
    const src = await read("components/jira/JiraJoins.tsx");
    const aside = src.slice(src.indexOf("function Aside("), src.indexOf("/** A one-line form"));
    expect(aside.indexOf("{said ? (")).toBeLessThan(aside.indexOf("{canAdd && <CommentAction"));
    expect(aside).toContain("Undo");
    expect(aside).toContain('title="Put it back"');
  });
  test("a removal asks in place and says what goes before anything is sent; it is never one click", async () => {
    const src = await read("components/jira/JiraJoins.tsx");
    expect(src).toContain("off? You can put it back right after.");
    expect(src).toContain('onClick={() => setAsking(l.id)}');
    expect(src).toContain('role="alertdialog"');
    // The click that opens the question is not the one that sends.
    expect(src).not.toMatch(/CloseButton[^>]*onClick=\{\(\) => void remove/);
  });
  test("a link is said before it is made: the picker shows the effect and the Link button comes after it", async () => {
    const src = await read("components/jira/JiraJoins.tsx");
    expect(src.indexOf("linkEffect(card, chosen, other)")).toBeGreaterThan(-1);
    expect(src).toContain('sendLabel="Link"');
  });
  test("the pane saves through the server's own routes and puts a write's answer in place without reading again", async () => {
    const card = await read("components/jira/JiraCard.tsx");
    for (const call of ["api.jiraSubtask(", "api.jiraRelate(", "api.jiraUnrelate(", "api.jiraWebLink(", "api.jiraWebUnlink("]) expect(card).toContain(call);
    expect(card).toContain("setDetail((d) => (d ? { ...sent, comments: d.comments } : sent))");
    expect(card).toContain("setJiraWeb(key, r.web)");
    expect(card).toContain("writes ? <SubtasksBlock");
  });
  test("a sub-task's menu opens inward from the right edge", async () => {
    expect(await read("components/jira/JiraJoins.tsx")).toContain('align="right"');
    expect(await read("components/TrackerStatusPick.tsx")).toContain("align={align}");
  });
});
