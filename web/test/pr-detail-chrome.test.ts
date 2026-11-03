import { describe, expect, test } from "bun:test";

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const body = (name: string) => {
  const a = panel.indexOf(`function ${name}(`);
  const b = panel.indexOf("\n}\n", a);
  return panel.slice(a, b);
};

describe("detail masthead follows the mockup", () => {
  const m = body("Masthead");
  test("row 1: state, '#N title' heading, then the fixed group of 26px controls", () => {
    expect(m).toContain("<h2");
    expect(m).toContain('size="hit"');
    // order of the group: Review menu, watch bell, GitHub, copy link, more, dock controls
    const order = ["<ReviewMenu", "<PrWatchMenu", "Open on GitHub", "Copy link", 'title="More actions"', "{dockControls}"].map((k) => m.indexOf(k));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
  test("row 2 carries the stack (or its dimmed 'Not stacked' twin), the worktree tag, the card and the pin glyph", () => {
    expect(m.indexOf("<StackControl")).toBeGreaterThan(m.indexOf("Copy branch name"));
    expect(m).toContain("<StackNone");
    expect(m).toContain("<PrCardChip");
    expect(m).toContain("requestWorktreeJump");
    expect(m.indexOf("<PinCurrent")).toBeGreaterThan(m.indexOf("<PrCardChip"));
  });
  test("the header follows mastheadPlan: the title never takes a row by force, the narrow meta row does not wrap, and the quiet cells follow the plan", () => {
    expect(m).toContain("mastheadPlan(band ??");
    expect(m).not.toContain("basis-full order-3");
    expect(m).toContain("plan.titleOneLine");
    expect(m).toContain("plan.metaOneRow");
    expect(m).toContain("plan.showQuiet");
    expect(m.indexOf("plan.showQuiet")).toBeLessThan(m.indexOf("<StackNone"));
    /* A stacked base's long name stayed shrink-0 and ran under the stack control: in the one-row meta it truncates. */
    expect(m).toMatch(/data-base-chip className=\{`[^`]*\$\{plan\.metaOneRow && !isTrunk\(d\.baseRefName\) \? "truncate min-w-0"/);
  });
  test("a stacked pull request keeps its branch readable in the one-row meta: the stack control drops its mini bars, the gaps tighten and a trunk base never truncates", () => {
    expect(m).toContain("compact={plan.metaOneRow}");
    expect(m).toMatch(/plan\.metaOneRow \? "gap-x-2\.5 min-w-0" : "gap-x-3\.5"\} flex-wrap/);
    expect(m).toMatch(/plan\.metaOneRow && !isTrunk\(d\.baseRefName\) \? "truncate min-w-0"/);
    const stk = Bun.file(new URL("../src/components/StackMarks.tsx", import.meta.url));
    return stk.text().then((t) => { expect(t).toMatch(/compact\?: boolean/); expect(t).toMatch(/compact \? null : <span className="agx-stk-mini"/); });
  });
  test("there is no stats strip under the header; its facts moved to the sidebar's closed section", () => {
    for (const f of ["Changes", "Assignee", "Milestone", "Checks", "Review"]) expect(m).not.toContain(`<Field label="${f}"`);
    expect(m).not.toContain("condensed");
    const side = body("SizeAndReview");
    for (const f of ["Changes", "Checks", "Review"]) expect(side).toContain(`<Field label="${f}"`);
    expect(body("PrSidebar")).toContain("<SizeAndReview");
  });
  test("Review ▾ is a plain menu, the idle bell is an icon, and the pin is a glyph (not a 'Pin #N' button in the dock controls)", () => {
    expect(m).toContain("primary={false}");
    expect(m).toContain("<PrWatchMenu root={root} repo={repo} d={d} iconOnly />");
    expect(body("ReviewMenu")).toContain("Review<CaretIcon />");
    expect(body("ReviewMenu")).not.toContain("Review with {");
    expect(panel.slice(panel.indexOf("const dockControls ="), panel.indexOf("const dockControls =") + 600)).not.toContain("PinCurrent");
  });
  test("the sixth tab, Review, is always drawn; a pull request you cannot review says why in its body", () => {
    expect(panel).toContain('t("review", "Review"),');
    expect(panel).not.toContain('canReview ? [t("review"');
    expect(panel).toContain("<ReviewUnavailable");
  });
});

describe("tab strip", () => {
  test("numbers and the hot pill come from tabView, not from per-tab ifs", () => {
    expect(panel).toContain("view: tabView(id, facts)");
    expect(panel).toContain("t.view.hot");
  });
});

describe("empty tabs say what is empty, in the mockup's words", () => {
  test.each([
    ["No commits", "The branch has no commits ahead of"],
    ["No files changed", "The diff is empty."],
    ["0 runs recorded", "No check has reported on this pull request."],
    ["No conversation yet.", "Be the first to comment."],
    ["Nothing to say yet.", "This pull request has no description."],
  ])("%s", (title, sentence) => {
    expect(panel).toContain(title);
    expect(panel).toContain(sentence);
  });
});

describe("sidebar", () => {
  test("auto-merge is a switch over the dock button's own handlers, not a second implementation", () => {
    const b = body("AutoMergeBlock");
    expect(b).toContain('role="switch"');
    expect(b).toContain("props.onCancelAutoMerge()");
    expect(b).toContain("props.onAutoMerge()");
  });
});

describe("view tabs carry their numbers", () => {
  test("Inbox shows the unread count and Closed the total already read, never a request", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(src).toContain('label: "Inbox", count: inboxUnread || undefined');
    expect(src).toContain('label: "Closed", count: personLogin ? undefined : closedKnownTotal(root)');
    const closed = await Bun.file(new URL("../src/lib/prClosed.ts", import.meta.url)).text();
    const body = closed.slice(closed.indexOf("export function closedKnownTotal("));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn).not.toContain("api.");
    expect(fn).not.toContain("ask(");
  });
});

describe("the dock's slots are the mockup's, drawn in every state", () => {
  const scope = body("MergeScope");
  const dock = body("PrDock");
  test("the reason follows the lib's decision, which keeps a blocked reason at the narrow band", () => {
    expect(dock).toContain("dockFit(band, reason.kind)");
    expect(dock).toContain("fit.reason");
  });
  test("Update, Resolve and Send to terminal are always drawn (dimmed by dockSlots, never removed)", () => {
    expect(scope).toContain("dockSlots({");
    expect(scope).toContain("disabled={!slots.update.enabled || busy || updateHeld(upState)}");
    expect(scope).not.toContain("(d.mergeable === \"CONFLICTING\" || conflicted) && conflictNode");
    expect(scope).toContain("onTerm={onReviewInTerminal && !noCheckout");
    expect(dock).toContain("{updateNode}{conflictNode}");
  });
  test("Merge when green is the sidebar switch; the dock keeps only the way out of an armed one", () => {
    expect(scope).not.toContain(">Merge when green<");
    expect(scope).toContain("Cancel auto-merge");
  });
  test("the merge button is 'Merge pull request' with a caret-only method menu", () => {
    expect(scope).toContain('"Merge pull request"');
    expect(scope).toContain("trigger={<></>}");
  });
});

describe("the Overview is the mockup's: verdict, four rows, then the rest behind a disclosure", () => {
  const box = Bun.file(new URL("../src/components/MergeBox.tsx", import.meta.url)).text();
  test("rows come from prOverviewView, and the old table is kept under 'Who moves it'", async () => {
    const src = await box;
    expect(src).toContain("data-overview-rows");
    expect(src).toContain("data-overview-path");
    expect(panel).toContain("overviewRows({");
    expect(panel).toContain("overviewVerdict({");
  });
  test("the description's duplicate button row is gone; the review history has its own box", () => {
    const ov = body("Overview");
    expect(ov).not.toContain("<ReviewMenu");
    expect(ov).not.toContain("<PluginPrActions");
    expect(ov).toContain("<ReviewHistoryBox");
  });
});

describe("the Files rail folds by the pane's width, not the window's", () => {
  test("a 620px dock in a 2560px window has no room for a third column", () => {
    // A viewport media query keeps the rail in a docked pane: the dock is a
    // fraction of the window, and at 620px the diff was left about 100px.
    expect(css).not.toMatch(/@media \(min-width: 1180px\) \{ \.agx-rail \{/);
    expect(css).toMatch(/@container agx-files \(min-width: 1180px\) \{ \.agx-rail \{ display: flex; \} \}/);
    expect(css).toMatch(/\.agx-files \{[^}]*container: agx-files \/ inline-size;/);
  });
  test("the row that holds the diff and the rail carries the container class", () => {
    const a = panel.indexOf("<FileRail d={d}");
    const row = panel.lastIndexOf('<div className="agx-files ', a);
    expect(row).toBeGreaterThan(0);
  });
});
