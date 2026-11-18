/* Empty columns start as bars; a drag opens only the bars the card could land in; the drop target stays open. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openedKey, opensForDrag, pruneOpened, shiftToggle, startsCollapsed, staysOpenAfterDrop } from "../src/components/jira/list/boardModel.ts";

describe("startsCollapsed", () => {
  test("empty column is a bar until opened by hand", () => {
    expect(startsCollapsed({ count: 0, folded: false, opened: false })).toBe(true);
    expect(startsCollapsed({ count: 0, folded: false, opened: true })).toBe(false);
  });
  test("a column with cards opens, unless folded by hand", () => {
    expect(startsCollapsed({ count: 3, folded: false, opened: false })).toBe(false);
    expect(startsCollapsed({ count: 3, folded: true, opened: false })).toBe(true);
  });
});

describe("opensForDrag", () => {
  test("only a bar that can take the card opens", () => {
    expect(opensForDrag({ collapsed: true, allowed: true })).toBe(true);
    expect(opensForDrag({ collapsed: true, allowed: false })).toBe(false);
    expect(opensForDrag({ collapsed: false, allowed: true })).toBe(false);
  });
});

describe("staysOpenAfterDrop", () => {
  test("the target joins the opened set; drag-only columns are not in it", () => {
    const next = staysOpenAfterDrop(new Set(["DONE"]), "READY FOR QA");
    expect([...next].sort()).toEqual(["DONE", "READY FOR QA"]);
  });
});

describe("shift on a header", () => {
  const all = ["TO DO", "QA COMPLETE", "DONE"];
  const base = { all, folded: new Set(["lane:x"]), opened: new Set<string>(), laneKey: "lane:", board: "b1" };
  test("on an empty bar it opens every column and folds none", () => {
    const r = shiftToggle({ ...base, status: "QA COMPLETE", barred: true });
    expect([...r.folded]).toEqual(["lane:x"]);
    expect(all.every((s) => r.opened.has(openedKey("b1", s)))).toBe(true);
  });
  test("on an open column it keeps only that one open", () => {
    const r = shiftToggle({ ...base, status: "DONE", barred: false });
    expect([...r.folded].sort()).toEqual(["QA COMPLETE", "TO DO", "lane:x"]);
    expect(r.opened.size).toBe(0);
  });
});

describe("opened is per board", () => {
  test("another board's entry does not open this one; pruning keeps only live columns", () => {
    const set = new Set([openedKey("a", "QA COMPLETE"), openedKey("b", "OLD")]);
    expect(set.has(openedKey("b", "QA COMPLETE"))).toBe(false);
    expect([...pruneOpened(set, "b", ["QA COMPLETE"])]).toEqual([openedKey("a", "QA COMPLETE")]);
  });
  test("a drop on a column with cards adds nothing", () => {
    expect(staysOpenAfterDrop(new Set(), "DONE", false).size).toBe(0);
  });
});

describe("board source: drop, drag", () => {
  const src = readFileSync(new URL("../src/components/jira/list/JiraBoard.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  test("the target is kept open on success, not at the drop", () => {
    expect(src).not.toContain("keepOpened(staysOpenAfterDrop(");
    expect(src).toContain("if (r.ok) keepTarget(outcome.toStatus);");
    expect(src).toContain("keepTarget(toStatus)");
  });
  test("allowed is decided once per drag, columns snap while dragging", () => {
    expect(src).toContain("allowedMemo");
    expect(css).toContain(".agx-jb[data-jb-dragging] .agx-jb-col { transition: none; animation: none; }");
  });
});

describe("board source", () => {
  const src = readFileSync(new URL("../src/components/jira/list/JiraBoard.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  test("the whole header is a keyboard button with a name", () => {
    expect(src).toContain('role="button" tabIndex={0}');
    expect(src).toContain("aria-expanded={!fold}");
    expect(src).toContain("`Open ${col.status}`");
    expect(src).toContain('e.key === "Enter" || e.key === " "');
    expect(css).toContain('.agx-jb-colhead[role="button"]:focus-visible');
  });
  test("motion is off under reduced motion", () => {
    expect(css).toContain(".agx-jb-col { transition: none; animation: none; }");
  });
});
