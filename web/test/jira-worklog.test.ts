/*
 * What the work log's form decides, without a renderer: when the button may be pressed, what it will do, what it sends and
 * how what landed is put back. What a time, a day or a way to follow the estimate is, is the server's own check
 * (shared/jiraWorklog.ts); these tests hold the form to it. The source tests at the end hold the pane's markup to the
 * house rules a renderer would otherwise have to see.
 */
import { describe, expect, test } from "bun:test";
import { EMPTY_FORM, entryForm, modeLabel, modesOf, said, takesValue, undoOf, workSend, workView, type WorkCall, type WorkEntry, type WorkForm } from "../src/lib/jiraWorklog.ts";

const now = new Date(2026, 9, 11, 14, 5, 9);
const entry: WorkEntry = { id: "40002", time: "1h 30m", started: "2026-10-07T10:30:00.000+0000", note: "Pairing on the export", mine: true };
const f = (o: Partial<WorkForm>): WorkForm => ({ ...EMPTY_FORM, ...o });

describe("logging: when the button may be pressed", () => {
  test("an empty form is off and the foot says the time is owed", () => {
    const v = workView("add", EMPTY_FORM, { now });
    expect(v.canSubmit).toBe(false);
    expect(v.missing).toEqual(["the time"]);
    expect(v.hint).toBe("Needs the time");
  });
  test("a time that is not one, or of nothing, is a problem on the time and the button stays off", () => {
    expect(workView("add", f({ time: "a while" }), { now }).problems.time).toContain("1h 30m");
    expect(workView("add", f({ time: "0m" }), { now })).toMatchObject({ canSubmit: false, problems: { time: "Time must be more than zero" } });
    expect(workView("add", f({ time: "1.5h" }), { now }).canSubmit).toBe(false);
  });
  test("a day to come is refused, and one that has happened is fine", () => {
    expect(workView("add", f({ time: "1h", day: "2999-01-01" }), { now }).problems.day).toContain("has happened");
    expect(workView("add", f({ time: "1h", day: "2026-10-09" }), { now }).canSubmit).toBe(true);
  });
  test("a way that takes a time and has none keeps it off, saying which; one that is typed wrong says what is wrong", () => {
    expect(workView("add", f({ time: "1h", mode: "new" }), { now })).toMatchObject({ canSubmit: false, missing: ["the estimate"], hint: "Needs the estimate" });
    expect(workView("add", f({ time: "1h", mode: "manual", value: "soon" }), { now })).toMatchObject({ canSubmit: false });
    expect(workView("add", f({ time: "1h", mode: "new", value: "0m" }), { now }).canSubmit).toBe(true);
    expect(workView("add", f({ time: "1h", mode: "manual", value: "0m" }), { now }).canSubmit).toBe(false);
  });
  test("filled in: on, with what will happen said before the press", () => {
    const v = workView("add", f({ time: "1h30m", day: "2026-10-09", mode: "new", value: "4h" }), { now });
    expect(v.canSubmit).toBe(true);
    expect(v.hint).toBe("");
    expect(v.effects).toEqual(["Logs 1h 30m for 2026-10-09", "The remaining estimate is set to 4h"]);
    expect(workView("add", f({ time: "45m" }), { now }).effects).toEqual(["Logs 45m now", "The remaining estimate goes down by 45m"]);
  });
});

describe("changing an entry", () => {
  test("it starts from the entry, and nothing different keeps the button off", () => {
    expect(entryForm(entry)).toEqual({ time: "1h 30m", day: "2026-10-07", note: "Pairing on the export", mode: "auto", value: "" });
    const v = workView("edit", entryForm(entry), { entry, now });
    expect(v).toMatchObject({ canSubmit: false, hint: "Change the time, the day or the note first" });
    expect(v.effects[0]).toBe("Nothing is different yet");
  });
  test("90m is the same time as 1h 30m, so it is not a change", () => {
    expect(workView("edit", f({ ...entryForm(entry), time: "90m" }), { entry, now }).canSubmit).toBe(false);
    expect(workView("edit", f({ ...entryForm(entry), time: "2h" }), { entry, now })).toMatchObject({ canSubmit: true });
    expect(workView("edit", f({ ...entryForm(entry), time: "2h" }), { entry, now }).effects[0]).toBe("Changes the entry's time from 1h 30m to 2h");
  });
  test("a note once written cannot be emptied here, and is said on the note", () => {
    expect(workView("edit", f({ ...entryForm(entry), note: "" }), { entry, now }).problems.note).toBe("A note cannot be taken off here");
  });
  test("an edit offers no manual way, and sends only what is different", () => {
    expect(modesOf("edit")).not.toContain("manual");
    expect(modesOf("add")).toEqual(["auto", "new", "leave", "manual"]);
    expect(workSend("edit", f({ ...entryForm(entry), time: "2h" }), entry)).toEqual({ time: "2h", adjust: { mode: "auto" } });
    expect(workSend("edit", f({ ...entryForm(entry), day: "2026-10-08", note: "Rewrote it" }), entry)).toEqual({ started: "2026-10-08", note: "Rewrote it", adjust: { mode: "auto" } });
  });
});

describe("deleting an entry", () => {
  test("the way the estimate follows is chosen, and the sentence says it cannot come back", () => {
    const v = workView("delete", EMPTY_FORM, { entry, now });
    expect(v.canSubmit).toBe(true);
    expect(v.effects).toEqual(["Deletes the entry of 1h 30m for good: Jira cannot bring it back", "The remaining estimate goes back up by 1h 30m"]);
    expect(workView("delete", f({ mode: "manual" }), { entry, now }).canSubmit).toBe(false);
    expect(workSend("delete", f({ mode: "manual", value: " 30m " }))).toEqual({ adjust: { mode: "manual", value: "30m" } });
  });
});

describe("what is sent", () => {
  test("a time with no day or note sends neither, and a value only where the way takes one", () => {
    expect(workSend("add", f({ time: " 1h " }))).toEqual({ time: "1h", adjust: { mode: "auto" } });
    expect(workSend("add", f({ time: "1h", day: "2026-10-09", note: " Did it ", mode: "leave", value: "9h" }))).toEqual({ time: "1h", started: "2026-10-09", note: "Did it", adjust: { mode: "leave" } });
    expect(workSend("add", f({ time: "1h", mode: "new", value: "2h" })).adjust).toEqual({ mode: "new", value: "2h" });
  });
  test("every mode has a label, and only new and manual take a time", () => {
    for (const op of ["add", "edit", "delete"] as const) for (const m of modesOf(op)) expect(modeLabel(op, m).length).toBeGreaterThan(3);
    expect(["auto", "new", "leave", "manual"].map((m) => takesValue(m as never))).toEqual([false, true, false, true]);
    expect(modeLabel("delete", "manual")).toBe("Add back…");
    expect(modeLabel("add", "manual")).toBe("Reduce by…");
  });
});

describe("what landed, and how it is put back", () => {
  const add: WorkCall = { op: "add", send: { time: "1h 30m", adjust: { mode: "auto" } } };
  test("an added entry is deleted again with the estimate set to what it was; with none before, it is left alone", () => {
    expect(undoOf(add, { ok: true, entry: "60101", before: "1d 4h", after: "1d 2h 30m" })).toEqual({ op: "delete", id: "60101", send: { adjust: { mode: "new", value: "1d 4h" } } });
    expect(undoOf(add, { ok: true, entry: "60101", before: "", after: "" })).toEqual({ op: "delete", id: "60101", send: { adjust: { mode: "leave" } } });
    expect(undoOf(add, { ok: true })).toBeNull();
  });
  test("a changed time is put back; a changed day or note is not offered an undo, and a delete never is", () => {
    const edit: WorkCall = { op: "edit", id: "40002", send: { time: "2h", adjust: { mode: "auto" } } };
    expect(undoOf(edit, { ok: true, before: "1d 4h", after: "1d 3h 30m" }, entry)).toEqual({ op: "edit", id: "40002", send: { time: "1h 30m", adjust: { mode: "new", value: "1d 4h" } } });
    expect(undoOf({ op: "edit", id: "40002", send: { time: "2h", note: "x", adjust: { mode: "auto" } } }, { ok: true, before: "4h" }, entry)).toBeNull();
    expect(undoOf({ op: "edit", id: "40002", send: { started: "2026-10-08", adjust: { mode: "auto" } } }, { ok: true, before: "4h" }, entry)).toBeNull();
    expect(undoOf({ op: "delete", id: "40002", send: { adjust: { mode: "auto" } } }, { ok: true, before: "4h", after: "5h 30m" }, entry)).toBeNull();
  });
  test("the sentence says the estimate from the site's two readings, and a delete says it cannot be undone", () => {
    expect(said(add, { ok: true, before: "1d 4h", after: "1d 2h 30m" })).toBe("Logged 1h 30m. Remaining estimate went from 1d 4h to 1d 2h 30m.");
    expect(said(add, { ok: true, before: "4h", after: "4h" })).toBe("Logged 1h 30m. Remaining estimate stays 4h.");
    expect(said(add, { ok: true })).toBe("Logged 1h 30m.");
    expect(said({ op: "delete", id: "1", send: { adjust: { mode: "auto" } } }, { ok: true, before: "4h", after: "5h 30m" }, entry)).toBe("Deleted the entry of 1h 30m. Remaining estimate went from 4h to 5h 30m. It cannot be undone.");
  });
});

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const panel = await read("../src/components/jira/JiraWorklog.tsx");
const note = await read("../src/components/jira/EditNote.tsx");
const hook = await read("../src/components/jira/useJiraWork.ts");
const activity = await read("../src/components/jira/JiraActivity.tsx");
const card = await read("../src/components/jira/JiraCard.tsx");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the pane keeps the house rules", () => {
  test("the controls are the house ones: its own sizes, edges, close button and select, and no typed glyph", () => {
    const c = code(panel);
    expect(c).toContain("EDGE");
    expect(c).toContain("INPUT_STYLE");
    expect(c).toContain('from "../Select.tsx"');
    expect(c).toContain("CommentAction");
    expect(c).toContain("ICON.sm");
    // The dismiss control is the shared one, through the note line.
    expect(code(note)).toContain("CloseButton");
    for (const g of ["✕", "×", "✓", "▾", "→"]) expect(c, g).not.toContain(g);
    expect(c).not.toMatch(/width=\{?["']?\d/);
  });
  test("the bar's one button is always drawn and keeps its words; the note line holds its height", () => {
    const c = code(panel);
    expect(c).toMatch(/aria-pressed=\{adding\}[^]*?>Log time<\/Button>/);
    expect(c).toContain("minHeight: NOTE_H");
    expect(c).toContain("min-w-[76px]");
  });
  test("the form lists what will happen before the press, and every refusal sits in a row that already has its height", () => {
    const c = code(panel);
    expect(c).toContain("What will happen");
    expect(c).toContain("h-[16px]");
    expect(c).toContain("min-h-[30px]");
  });
  test("a delete is asked in place and says it cannot be brought back; it offers no undo", () => {
    const c = code(panel);
    expect(c).toContain("Jira cannot bring it back");
    expect(c).toContain('role="alertdialog"');
  });
  test("the controls are drawn only for an entry that is yours, and only while writing is on", () => {
    const c = code(panel);
    expect(c).toContain("const own = !!work && !!entry?.mine");
    expect(code(card)).toContain("work={writes && detail.tracking ? work : undefined}");
  });
  test("one write at a time, with the stamp read when it is sent, and the card moved is a reload", () => {
    const c = code(hook);
    expect(c).toContain("if (going.current)");
    expect(c).toContain("stamp.current");
    // The conflict branch itself asks for the card again, and so does a write whose answer carried no card.
    expect(c).toMatch(/if \(r\.conflict\) \{[^\n]*cb\.current\.onStale\(\)/);
    expect(c).toMatch(/else cb\.current\.onStale\(\)/);
  });
  test("the paged-in rows of an earlier log are dropped when a write lands", () => {
    expect(code(activity)).toContain("[logEpoch]");
  });
});
