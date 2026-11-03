/*
 * The GitHub source of the Tasks view and the All tab around it, read as source:
 * the states' words, the Start button and its menu, the Finish question, and the
 * heading the issues get when they sit under the Local block.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const from = (needle: string, to?: string) => {
  const i = src.indexOf(needle);
  expect(i, needle).not.toBe(-1);
  return src.slice(i, to ? src.indexOf(to, i + needle.length) : undefined);
};
const issues = from("function IssuesBody(", "\n/**\n * Start work");
const line = from("function IssueLine(", "\nfunction Detail(");
const detail = from("function Detail(", "\n/*");

describe("GitHub states", () => {
  it("says what happened in each", () => {
    for (const s of ["Asking GitHub…", "Could not reach GitHub", "Try now", "No issue matches", "The full list comes back when you clear the search.", "Clear search", "Nothing is open, closed or assigned."]) {
      expect(issues).toContain(s);
    }
  });
  it("keeps the toolbar above every state", () => {
    const bar = issues.indexOf("RefreshButton");
    expect(bar).not.toBe(-1);
    expect(issues.indexOf("<BoardSkeleton")).toBeGreaterThan(bar);
    expect(issues.indexOf('title="Could not reach GitHub"')).toBeGreaterThan(bar);
  });
  it("draws the pane and its grip only with an issue selected", () => {
    expect(issues).toContain("{sel != null && <PaneGrip pane={pane} />}");
    expect(issues).toContain('usePaneWidth("agentglass.tasks.github.paneWidth")');
  });
  it("names the repository in the footer once an issue has told it", () => {
    expect(issues).toContain("repoName.current");
    expect(issues).toContain("in ${repoName.current}");
  });
});

describe("GitHub row and menus", () => {
  it("puts Start on the row and the other ways behind a caret", () => {
    expect(line).toContain('tone="primary"');
    expect(line).toContain(">Start</Button>");
    expect(line).toContain('label="Other ways to start"');
    expect(line).toContain("MODES.map");
  });
  it("shows a working-on-it badge for an issue with a worktree", () => {
    expect(line).toContain("working on it");
  });
  it("keeps the context menu to Start, Other ways to start and Open on GitHub, with the modes one step in", () => {
    const menu = issues.slice(issues.indexOf("{menu && ("));
    for (const s of ['label="Start"', 'label="Other ways to start"', 'label="Open on GitHub"', "MODES.slice(1)", "setWays(true)"]) {
      expect(menu).toContain(s);
    }
  });
});

describe("Finish question", () => {
  it("is a dialog that must be answered with its own buttons", () => {
    expect(detail).toContain("<TaskDialog title={`Finish #${d.number}?`} closable={false}");
    expect(detail).toContain("Keep working");
  });
  it("offers Finish only for an issue that has a worktree", () => {
    expect(detail).toContain("{d.work && <Button tone=\"danger\"");
  });
  it("asks again, with the other words, once uncommitted changes are found", () => {
    expect(detail).toContain("Throw them away and remove it");
    expect(detail).toContain("api.issueFinish(");
  });
});

describe("All tab", () => {
  it("heads the issues the way the Local block is headed, only when they sit under it", () => {
    expect(issues).toContain("{onOpenSource && (");
    expect(issues).toContain("GitHub issues</b>");
    expect(issues).toContain(">Open GitHub</Button>");
    expect(src).toContain('onOpenSource={source === "all" ? () => setSource("github") : undefined}');
  });
  it("draws the Local block with a count, Open Local, and a line for the rest", () => {
    const strip = from("function LocalStrip(");
    for (const s of ["Local due soon", "Open Local", "open the Local tab"]) expect(strip).toContain(s);
  });
  it("asks nothing new of ClickUp or Jira: the All tab has no boards block", () => {
    const all = from('{source === "all" && <NowBand', "No repository to read issues from.");
    expect(all).not.toContain("ClickUpBody");
    expect(all).not.toContain("api.board");
  });
});
