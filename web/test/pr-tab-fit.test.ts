import { describe, expect, it } from "bun:test";
import { fitTabs, type TabFitInput } from "../src/lib/prTabFit.ts";

// The strip at the narrowest dock (320px), measured: a tab is its label plus its count at 12px with 12px of
// air each side. A long count ("Conversation 123", "Checks 99+") is the worst case.
const tabs = (w: Record<string, number>) => Object.entries(w).map(([id, width]) => ({ id, width }));
const SIX = tabs({ overview: 74, conversation: 118, commits: 82, files: 66, checks: 86, review: 96 });
const base: Omit<TabFitInput, "active"> = { tabs: SIX, avail: 304, fixed: 0, actionFull: 112, actionIcon: 26, moreWidth: 26, gap: 8 };

describe("which tabs fit beside the primary action", () => {
  it("shows everything, the action with its words, when there is room", () => {
    const f = fitTabs({ ...base, avail: 700, active: "overview" });
    expect(f).toEqual({ visible: SIX.map((t) => t.id), hidden: [], action: "full" });
  });
  it("turns the action into an icon BEFORE any tab goes", () => {
    const need = 74 + 118 + 82 + 66 + 86 + 96; // 522
    const f = fitTabs({ ...base, avail: need + 8 + 26, active: "overview" });
    expect(f.action).toBe("icon");
    expect(f.hidden).toEqual([]);
  });
  it("collapses from the end at the narrowest dock, and the rest still fits", () => {
    const f = fitTabs({ ...base, active: "overview" });
    expect(f.action).toBe("icon");
    expect(f.hidden.length).toBeGreaterThan(0);
    const w = (ids: string[]) => ids.reduce((n, id) => n + SIX.find((t) => t.id === id)!.width, 0);
    // tabs + gap + icon + gap + "…" never exceed the room
    expect(w(f.visible) + 8 + 26 + 8 + 26).toBeLessThanOrEqual(304);
    expect(f.visible[0]).toBe("overview");
  });
  it("keeps the active tab when it is one that would collapse, whatever its place", () => {
    for (const id of SIX.map((t) => t.id)) {
      const f = fitTabs({ ...base, active: id });
      expect(f.visible).toContain(id);
      expect([...f.visible, ...f.hidden].sort()).toEqual(SIX.map((t) => t.id).sort());
    }
  });
  it("keeps the order of the strip", () => {
    const f = fitTabs({ ...base, active: "review" });
    const order = SIX.map((t) => t.id);
    expect(f.visible).toEqual(order.filter((id) => f.visible.includes(id)));
  });
  it("counts the draft badges as fixed, so they push tabs into the menu rather than clip", () => {
    const without = fitTabs({ ...base, active: "overview" }).visible.length;
    const withBadge = fitTabs({ ...base, fixed: 90, active: "overview" }).visible.length;
    expect(withBadge).toBeLessThan(without);
  });
  it("has no action to shrink when there is none", () => {
    const f = fitTabs({ ...base, actionFull: 0, actionIcon: 0, avail: 700, active: "files" });
    expect(f.action).toBe("none");
    expect(fitTabs({ ...base, actionFull: 0, actionIcon: 0, active: "files" }).action).toBe("none");
  });
  it("long counts: the same tabs with three-digit counts still never overflow", () => {
    const long = tabs({ overview: 74, conversation: 140, commits: 100, files: 92, checks: 110, review: 112 });
    const f = fitTabs({ ...base, tabs: long, active: "conversation" });
    const used = f.visible.reduce((n, id) => n + long.find((t) => t.id === id)!.width, 0);
    expect(used + 8 + 26 + 8 + 26).toBeLessThanOrEqual(304);
    expect(f.visible).toContain("conversation");
  });
});

describe("the strip is wired to the decision", () => {
  it("never scrolls sideways, measures what it fits, and keeps the action whole as a named icon", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    const at = src.indexOf("function PrTabStrip(");
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf("function prStateBadge(", at));
    expect(fn).toContain("fitTabs({");
    expect(fn).toContain("overflow-hidden");
    expect(fn).not.toContain("overflow-x-auto");
    // the icon-only action is still a button with a name, and the "…" lists what collapsed
    expect(fn).toContain('square tone="primary" label="Add your review"');
    expect(fn).toContain("data-tab-more");
    expect(fn).toContain("hid.map(");
    // a tab folded into the "…" keeps its pill's news: a dot on the button, red when a folded pill is red
    expect(fn).toContain("hid.some((t) => t.view.hot)");
    expect(fn).toContain('hid.some((t) => t.view.hot?.tone === "bad")');
  });
  it("keeps the header's controls on one row and lets the dock's branch group wrap at the narrowest dock", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    const i = src.indexOf("function Masthead(");
    const head = src.slice(i, src.indexOf("\n/**\n * Why Update branch will only sync", i));
    // a wrapping group left expand/close alone on a second row at a 620px dock
    expect(head).not.toContain('"flex-wrap max-w-full min-w-0"');
    expect(head).toContain('<div className="flex items-center gap-1 shrink-0">');
    // GitHub and Copy link leave the row for the More menu in the narrow band
    expect(head).toContain('{band !== "narrow" && <Button size="hit" onClick={() => openExternal(d.url)}');
    expect(head).toContain('{band === "narrow" && <>');
    expect(head).toContain(">Open on GitHub</MenuItem>");
    expect(head).toContain('{linkCopied ? "Copied" : "Copy link"}</span>');
    expect(src).toContain('flex-wrap max-w-full shrink-0" data-dock-branch');
  });
});
