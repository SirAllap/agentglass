/*
 * A control that a read-only board disables says why with a lock and one
 * sentence, and the whole row is the way to turn changes on: it opens the same
 * confirmation the header switch does. Read as source.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const note = await Bun.file(new URL("../src/components/tasks/ReadOnlyNote.tsx", import.meta.url)).text();
const detail = src.slice(src.indexOf("function CardDetail("), src.indexOf("\nfunction ", src.indexOf("function CardDetail(") + 20));

describe("the read-only card", () => {
  it("is handed a way to ask for changes", () => {
    expect(src).toContain("onAllow={() => setConfirmWrite(true)}");
    expect(src).toMatch(/function CardDetail\([^)]*onAllow/);
  });

  it("locks the assignee row: the whole row asks, the control stays disabled", () => {
    expect(detail).toContain("<ReadOnlyRow");
    expect(note).toContain("function ReadOnlyRow(");
  });
});

describe("ReadOnlyRow", () => {
  const i = note.indexOf("function ReadOnlyRow(");
  const row = i < 0 ? "" : note.slice(i, note.indexOf("\n}\n", i));
  it("shows the lock with the one sentence, and asks on a click anywhere in the row", () => {
    expect(row).toContain("<LockIcon");
    expect(row).toContain("title={READ_ONLY_TIP}");
    expect(note).toContain('const READ_ONLY_TIP = "Read-only board. Turn changes on to edit";');
    expect(row).toContain("onClick={");
    expect(row).toContain("onAllow");
  });
});
