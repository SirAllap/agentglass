/*
 * What a button on the board answers ("Shell opened", "copied", "moved") goes
 * in the footer status slot, where the "N of M" line is. It used to be a strip
 * under the toolbar and a pill on a row's Due cell, both over something.
 * Read as source; the note itself is a pure value.
 */
import { describe, expect, it } from "bun:test";
import { terminalNote, SHOW_IN_TERMINAL } from "../src/lib/tasksFooterNote.ts";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const footer = await Bun.file(new URL("../src/components/tasks/StatusFooter.tsx", import.meta.url)).text();

const slice = (from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, from).not.toBe(-1);
  return src.slice(a, src.indexOf(to, a));
};

describe("terminalNote", () => {
  it("offers Show in Terminal when something opened there", () => {
    let shown = 0;
    const n = terminalNote(true, "Shell opened", () => { shown++; });
    expect(n.go?.label).toBe(SHOW_IN_TERMINAL);
    expect(SHOW_IN_TERMINAL).toBe("Show in Terminal");
    n.go!.run();
    expect(shown).toBe(1);
  });

  it("offers nothing when nothing opened", () => {
    expect(terminalNote(false, "No shell opened: x").go).toBeUndefined();
  });
});

describe("the footer status slot", () => {
  it("is one component that shows the note in place of the count and takes the Show button", () => {
    expect(footer).toContain("export function StatusFooter");
    expect(footer).toContain("note.go");
    expect(footer).toContain('role="status"');
  });

  it("is what the three bodies end in, and no strip is drawn over their cells any more", () => {
    expect(src).not.toContain("<NoteStrip");
    expect(src).not.toContain("function NoteStrip");
    expect((src.match(/<StatusFooter /g) ?? []).length).toBe(3);
  });

  it("holds the ClickUp board's note, next to its N of M", () => {
    const f = slice("{view === \"loading\" || veiled ? \"Loading…\"", "</StatusFooter>");
    expect(f).toBeTruthy();
    expect(slice("<StatusFooter note={note}", "{view ===")).toContain("setNote(null)");
  });

  it("holds the Local board's note instead of a bar above the table", () => {
    expect(src).not.toContain('style={{\n          color: note.ok ? "var(--success)"');
    expect(slice("function LocalBody(", "\nconst BucketHeading")).toContain("<StatusFooter note={note}");
  });

  it("holds the issue list's note", () => {
    expect(slice("function IssuesBody(", "\nasync function start(")).toContain("<StatusFooter note={note}");
  });
});

describe("Shell here and Start", () => {
  it("answer with a note that can show the terminal (Local shell, Local chat)", () => {
    const i = src.indexOf("requestTermIssue(cwd, name,");
    const s = src.slice(i, i + 500);
    expect(s).toContain("Shell opened");
    expect(s).toContain("terminalNote(");
    expect(src).toContain("terminalNote(n.ok, n.text");
  });

  it("answer the same for a GitHub issue", () => {
    const s = slice("async function start(", "\nfunction IssueLine");
    expect(s).toContain("terminalNote(");
    expect(s).toContain("say: (n: FooterNote) => void");
  });
});

describe("the copy pill", () => {
  it("is gone from the row; the row hands its text up", () => {
    expect(src).not.toContain("{said} copied");
    expect(src).not.toContain("setSaid");
    expect(src).toContain("onSay?.(`${what} copied`)");
  });
});
