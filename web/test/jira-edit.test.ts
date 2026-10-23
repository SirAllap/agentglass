/*
 * Changing a Jira card's Details from its pane, as decisions: how each change
 * reads afterwards, what puts it back, which colour a priority gets, and which
 * parts of the pane may draw a control at all. There is no renderer here, so
 * the rule about what is drawn is asserted against the source that draws it.
 */
import { describe, expect, test } from "bun:test";
import { canEdit, nowOf, parseEstimate, parseParent, parseTitle, priorityInk, priorityOptions, stepFor, type EditNow } from "../src/lib/jiraEdit.ts";
import type { CardEdit, ProviderTask } from "../../shared/providers.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();

const NOW: EditNow = {
  title: "Retry the export", priority: { id: "3", name: "Medium" }, due: "2026-03-01", start: "", parent: "ORBIT-7", flagged: false,
  originalEstimate: "2h", remainingEstimate: "",
};

describe("what a change says and how it is put back", () => {
  test("a priority reads from what to what, and goes back by its id", () => {
    const s = stepFor("priority", { value: "1", name: "High" }, NOW)!;
    expect(s.ask).toEqual({ field: "priority", value: "1" });
    expect(s.said).toBe("Priority: Medium → High");
    expect(s.undo).toEqual({ field: "priority", value: "3" });
  });

  test("labels are operations, and the undo of an add is the remove", () => {
    expect(stepFor("labels", { add: "ops" }, NOW)).toMatchObject({ ask: { field: "labels", add: "ops" }, undo: { field: "labels", remove: "ops" } });
    expect(stepFor("labels", { remove: "ops" }, NOW)).toMatchObject({ ask: { field: "labels", remove: "ops" }, undo: { field: "labels", add: "ops" } });
    expect(stepFor("labels", {}, NOW)).toBeNull();
  });

  test("a date set, changed and cleared says so, and clearing is null while undoing it puts the old day back", () => {
    expect(stepFor("duedate", { value: "2026-04-01" }, NOW)).toMatchObject({ ask: { value: "2026-04-01" }, said: "Due date: 2026-03-01 → 2026-04-01", undo: { value: "2026-03-01" } });
    const cleared = stepFor("duedate", { value: null }, NOW)!;
    expect(cleared.ask).toEqual({ field: "duedate", value: null });
    expect(cleared.said).toBe("Due date cleared (it was 2026-03-01)");
    expect(cleared.undo).toEqual({ field: "duedate", value: "2026-03-01" });
    // A start date that was empty has nothing to put back but "empty".
    expect(stepFor("start", { value: "2026-02-01" }, NOW)!.undo).toEqual({ field: "start", value: null });
  });

  test("an estimate cleared is the empty string, not null", () => {
    const s = stepFor("originalEstimate", { value: "  " }, NOW)!;
    expect(s.ask).toEqual({ field: "originalEstimate", value: "" });
    expect(s.undo).toEqual({ field: "originalEstimate", value: "2h" });
  });

  test("the parent is upper-cased and taken off with an empty box", () => {
    expect(stepFor("parent", { value: " orbit-9 " }, NOW)!.ask).toEqual({ field: "parent", value: "ORBIT-9" });
    const off = stepFor("parent", { value: "" }, NOW)!;
    expect(off.ask).toEqual({ field: "parent", value: null });
    expect(off.undo).toEqual({ field: "parent", value: "ORBIT-7" });
  });

  test("the flag is a boolean both ways", () => {
    expect(stepFor("flag", { value: true }, NOW)).toMatchObject({ ask: { value: true }, undo: { value: false }, said: "Flagged" });
    expect(stepFor("flag", { value: false }, NOW)).toMatchObject({ ask: { value: false }, undo: { value: true } });
  });

  test("a long title is cut in the sentence and whole in the request", () => {
    const long = "x".repeat(80);
    const s = stepFor("summary", { value: long }, NOW)!;
    expect(s.ask).toEqual({ field: "summary", value: long });
    expect(s.said.length).toBeLessThan(long.length);
    expect(s.undo).toEqual({ field: "summary", value: "Retry the export" });
  });

  test("a field nobody knows is not a step", () => {
    expect(stepFor("components", { value: "x" }, NOW)).toBeNull();
  });
});

describe("what a box accepts before anything is sent", () => {
  test("estimates, parents and titles", () => {
    expect(parseEstimate("2h 30m").ok).toBe(true);
    expect(parseEstimate("").ok).toBe(true);
    expect(parseEstimate("soon").ok).toBe(false);
    expect(parseParent("ORBIT-7").ok).toBe(true);
    expect(parseParent("").ok).toBe(true);
    expect(parseParent("seven").ok).toBe(false);
    expect(parseTitle("  ").ok).toBe(false);
    expect(parseTitle("x".repeat(256)).ok).toBe(false);
    expect(parseTitle("A title").ok).toBe(true);
  });
});

describe("priorities by where they sit in the site's list", () => {
  test("first is urgent, last is low, the second is high when there are four or more", () => {
    const ink = (i: number, n: number) => priorityInk(i, n);
    expect(ink(0, 5)).toContain("urgent");
    expect(ink(1, 5)).toContain("high");
    expect(ink(2, 5)).toContain("normal");
    expect(ink(4, 5)).toContain("low");
    expect(ink(1, 3)).toContain("normal");
    expect(ink(0, 1)).toContain("normal");
  });
  test("the options are the site's, in its order", () => {
    const edit: CardEdit = { fields: ["priority"], reply: true, priorities: [{ id: "1", name: "Blocker" }, { id: "2", name: "Minor" }] };
    expect(priorityOptions(edit).map((o) => [o.id, o.label])).toEqual([["1", "Blocker"], ["2", "Minor"]]);
    expect(priorityOptions(undefined)).toEqual([]);
  });
});

describe("what is read off the card", () => {
  test("nowOf takes the estimates, the start and the flag from the Details and the rest from the card", () => {
    const t = { title: "T", due: "2026-03-01", parent: { key: "ORBIT-7", title: "" } } as unknown as ProviderTask;
    const now = nowOf(t, [
      { id: "start", label: "Start date", value: "2026-02-01", raw: "2026-02-01", field: "start" },
      { id: "flag", label: "Flagged", value: "Impediment", raw: "1", field: "flag", tone: "flag" },
      { id: "originalEstimate", label: "Original estimate", value: "2h", raw: "2h", field: "originalEstimate" },
    ], { fields: [], reply: true, priorities: [], priority: { id: "3", name: "Medium" } });
    expect(now).toEqual({ title: "T", priority: { id: "3", name: "Medium" }, due: "2026-03-01", start: "2026-02-01", parent: "ORBIT-7", flagged: true, originalEstimate: "2h", remainingEstimate: "" });
  });
  test("a control exists only for a field the edit screen offered", () => {
    expect(canEdit({ fields: ["summary"], reply: true, priorities: [] }, "summary")).toBe(true);
    expect(canEdit({ fields: ["summary"], reply: true, priorities: [] }, "priority")).toBe(false);
    expect(canEdit(undefined, "summary")).toBe(false);
  });
});

describe("the pane draws a control only when writing is on and the card offers the field", () => {
  test("every editor in the pane is behind `live`, which is the writes switch AND the card's own list", async () => {
    const src = await read("components/jira/JiraFacts.tsx");
    expect(src).toContain("const live = writable ? ed : undefined;");
    const at = src.indexOf("export function JiraProps(");
    const body = src.slice(at);
    for (const f of ["priority", "duedate", "parent", "labels"]) expect(body, f).toContain(`can("${f}")`);
    // The controls take no value from the card without `can`: the ones inside the facts check the row's own field.
    expect(src).toContain("if (!ed || !f.field || !canEdit(ed.edit, f.field)) return <FactValue f={f} />;");
    const head = src.slice(src.indexOf("export function JiraHead("), at);
    expect(head).toContain('writable && ed && canEdit(ed.edit, "summary")');
  });
  test("the card hands the pane no list of editable fields while writing is off", async () => {
    const src = await read("components/jira/JiraCard.tsx");
    expect(src).toContain("edit: writes ? detail?.edit : undefined");
  });
  test("a refused change that was a conflict reads the card again, and a successful one replaces the card from its own answer", async () => {
    const hook = await read("components/jira/useJiraEdit.ts");
    expect(hook).toContain("if (r.conflict) cb.current.onStale();");
    expect(hook).toContain("Changed in Jira meanwhile: reloaded, nothing sent");
    expect(hook).toContain("cb.current.onDone({ task: r.task, facts: r.facts, edit: r.edit });");
    // One edit at a time: the card's stamp moves with each.
    expect(hook).toContain("if (going.current) return;");
  });
});

describe("the day box in a light theme", () => {
  test("its scheme follows the page, because a dark one leaves the calendar button white on white", async () => {
    const src = await read("components/tasks/CardEdit.tsx");
    const day = src.slice(src.indexOf("export function EditDay("), src.indexOf("\n}\n", src.indexOf("export function EditDay(")));
    expect(day).toContain("colorScheme: schemeOfTheme()");
    expect(day).not.toContain('colorScheme: "dark"');
  });
});
