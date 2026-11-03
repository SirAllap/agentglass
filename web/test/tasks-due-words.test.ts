/*
 * The Due column says the whole thing: "3 days ago", never "3d" or a clipped
 * "3 days a…". A pure decision (words and tone) so the cell only draws it.
 * Read as source for the cell.
 */
import { describe, expect, it } from "bun:test";
import { dueWords } from "../src/lib/taskGrammar.ts";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const rowStart = src.indexOf('<div role="row" tabIndex={0}');
const row = src.slice(rowStart, src.indexOf("{menu && (", rowStart));
const fit = await Bun.file(new URL("../src/lib/tasksColumnFit.ts", import.meta.url)).text();

const TODAY = "2026-10-29";

describe("dueWords", () => {
  it("names the near days and counts the rest", () => {
    expect(dueWords("2026-10-29", TODAY, false)).toEqual({ text: "Today", tone: "today" });
    expect(dueWords("2026-10-30", TODAY, false)).toEqual({ text: "Tomorrow", tone: "later" });
    expect(dueWords("2026-10-28", TODAY, false)).toEqual({ text: "Yesterday", tone: "late" });
    expect(dueWords("2026-10-26", TODAY, false)).toEqual({ text: "3 days ago", tone: "late" });
    expect(dueWords("2026-11-03", TODAY, false)).toEqual({ text: "In 5 days", tone: "later" });
  });

  it("says No date for none, and Done for a finished card whatever its date", () => {
    expect(dueWords(null, TODAY, false)).toEqual({ text: "No date", tone: "none" });
    expect(dueWords("2026-10-01", TODAY, true)).toEqual({ text: "Done", tone: "done" });
    expect(dueWords(null, TODAY, true).text).toBe("Done");
  });

  it("falls back to the date past the counting range, so the words stay short", () => {
    expect(dueWords("2026-06-01", TODAY, false).text).toBe("1 Jun");
    expect(dueWords("2027-03-02", TODAY, false)).toEqual({ text: "2 Mar 2027", tone: "later" });
  });
});

describe("the Due cell on a ClickUp row", () => {
  const at = row.indexOf("{due.text}");
  const cell = row.slice(row.lastIndexOf("<span", row.lastIndexOf("<span", at) - 1), at + 20);
  it("draws dueWords, with a flag on an overdue date, and never clips", () => {
    expect(at).not.toBe(-1);
    expect(src).toContain("const due = dueWords(");
    expect(cell).toContain("<FlagIcon");
    expect(cell).not.toContain("truncate");
    expect(cell).toContain("whitespace-nowrap");
  });

  it("colours late red, today in the warning ink, and keeps Done quiet", () => {
    expect(cell).toContain("var(--error-ink)");
    expect(cell).toContain("var(--warning-ink)");
  });

  it("has a track wide enough for 'Yesterday' with the flag", () => {
    expect(src).toMatch(/"(9\d|1\d\d)px", est \? /);
  });
});

describe("the eyebrow", () => {
  it("is 10px everywhere in the Tasks files", () => {
    expect(src).not.toContain("text-[8.5px]");
    expect(fit).not.toContain("8.5 /");
  });
});

describe("the eyebrow, in the other Tasks files", () => {
  it("has no 8.5px text left", async () => {
    for (const f of ["CardChrome.tsx", "jira/JiraAreas.tsx", "jira/JiraSections.tsx", "jira/JiraBoardContext.tsx", "JiraTasks.tsx"]) {
      const t = await Bun.file(new URL(`../src/components/${f}`, import.meta.url)).text();
      expect(t, f).not.toContain("text-[8.5px]");
    }
  });
});
