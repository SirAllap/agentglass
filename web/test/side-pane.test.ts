/*
 * The side pane beside a terminal: what each tab remembers, how wide the pane may
 * be, and the promises the rest of the code keeps about it (read as text, like the
 * other guards: there is no renderer to mount a view).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);

const side = await import("../src/lib/sidePane.ts");

beforeEach(() => { store.clear(); side.resetSidePane(); });

describe("the width of the pane", () => {
  const cell = 8;
  const termMin = 80 * cell;

  it("is the default when nothing was chosen, and never under 360 when there is room", () => {
    expect(side.paneWidth(null, 1600, termMin, false)).toBe(side.SIDE_DEFAULT);
    expect(side.paneWidth(100, 1600, termMin, false)).toBe(side.SIDE_MIN);
  });

  it("never takes the terminal under its 80 columns", () => {
    const total = 1000;
    const w = side.paneWidth(900, total, termMin, false);
    expect(total - side.DIVIDER_PX - w).toBeGreaterThanOrEqual(termMin);
  });

  it("is capped at 65% of the row", () => {
    expect(side.paneWidth(5000, 2000, termMin, false)).toBe(2000 * side.SIDE_MAX_SHARE);
  });

  it("gives the ceiling the last word when it is under the floor", () => {
    const w = side.paneWidth(null, 800, termMin, false);
    expect(w).toBe(800 - side.DIVIDER_PX - termMin);
    expect(w).toBeLessThan(side.SIDE_MIN);
  });

  it("compact is 300 under the same ceiling", () => {
    expect(side.paneWidth(null, 1600, termMin, true)).toBe(side.SIDE_COMPACT);
    expect(side.paneWidth(null, 800, termMin, true)).toBe(800 - side.DIVIDER_PX - termMin);
  });

  it("a drag ending at x leaves the pane the rest of the row", () => {
    expect(side.dragWidth(1000, 1600, termMin)).toBe(1600 - side.DIVIDER_PX - 1000);
    expect(side.dragWidth(1500, 1600, termMin)).toBe(side.SIDE_MIN);
  });
});

describe("what a tab remembers", () => {
  it("starts shut, on the card, with no width", () => {
    expect(side.viewOf("@1")).toEqual({ open: false, section: "card", width: null, pinned: false, compact: false, maxWidth: false, split: false, splitSection: "diff" });
  });

  it("opens on the section asked for, for that tab only", () => {
    side.openSide("@1", "pr");
    expect(side.viewOf("@1").open).toBe(true);
    expect(side.viewOf("@1").section).toBe("pr");
    expect(side.viewOf("@2").open).toBe(false);
  });

  it("keeps the width and the section when the tab is left and come back to", () => {
    side.openSide("@1", "diff");
    side.setWidth("@1", 640);
    side.openSide("@2", "card");
    expect(side.viewOf("@1")).toMatchObject({ open: true, section: "diff", width: 640 });
    expect(side.viewOf("@2").width).toBeNull();
  });

  it("remembers the scroll of each section apart", () => {
    side.rememberScroll("@1", "card", 120);
    side.rememberScroll("@1", "pr", 40);
    expect(side.scrollOf("@1", "card")).toBe(120);
    expect(side.scrollOf("@1", "pr")).toBe(40);
    expect(side.scrollOf("@2", "pr")).toBe(0);
  });

  it("a pinned pane is open on every tab until a tab closes it", () => {
    side.togglePin();
    expect(side.viewOf("@1").open).toBe(true);
    expect(side.viewOf("@9").open).toBe(true);
    side.closeSide("@9");
    expect(side.viewOf("@9").open).toBe(false);
    expect(side.viewOf("@1").open).toBe(true);
  });

  it("writes down the pin and compact mode, and nothing else", () => {
    side.togglePin();
    side.toggleCompact();
    side.openSide("@1", "pr");
    side.setWidth("@1", 600);
    expect([...store.keys()].sort()).toEqual(["agentglass.sidePane.compact", "agentglass.sidePane.pinned"]);
  });

  it("notifies on a change a person can see, not on a scroll", () => {
    let n = 0;
    const off = side.subscribeSidePane(() => { n++; });
    side.rememberScroll("@1", "card", 10);
    expect(n).toBe(0);
    side.openSide("@1");
    side.setSection("@1", "diff");
    side.setSection("@1", "diff");
    expect(n).toBe(2);
    off();
  });
});

describe("the keys", () => {
  it("1, 2 and 3 are card, pull request and diff", () => {
    expect([side.sectionForKey("1"), side.sectionForKey("2"), side.sectionForKey("3"), side.sectionForKey("4")]).toEqual(["card", "pr", "diff", null]);
  });
});

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");

describe("the wiring", () => {
  const term = src("components/TerminalPanel.tsx");
  const bar = term.slice(term.indexOf("function PaneBarFor("), term.indexOf("function SlotBar("));

  it("the pane bar's card, pull request and diff open the side pane; the full views are its pop out", () => {
    expect(bar).toContain('onSide("card")');
    expect(bar).toContain('onSide("pr")');
    expect(bar).toContain('onSide("diff")');
    expect(term).toContain("onPopOut={(sec) => { void paneDoor(sec); }}");
  });

  it("the terminal row is a flex row: the grid narrows and the pane takes what it leaves", () => {
    expect(term).toMatch(/ref=\{setRowEl\} className="flex-1 min-h-0 min-w-0 flex relative"/);
    expect(term).toContain("const termMinPx = sideCols * (MIN_TERM_COLS * sideCell + SIDE_SCROLLBAR_PX)");
  });

  it("Alt+1/2/3 stay the window strip's: the panel takes no window-level key capture for the pane", () => {
    expect(term).not.toContain('window.addEventListener("keydown", down, true);');
    expect(term).not.toContain("setSideSection(tab, sec)");
    expect(term).toContain("if (altDigit(e) && stripUp()) return false;");
  });

  it("with the pane open and the terminal focused, Alt+2 is a window switch and 2 inside the pane is the PR section", async () => {
    const { altDigit } = await import("../src/lib/termKeys.ts");
    side.openSide("@1");
    const alt2 = { code: "Digit2", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(altDigit(alt2)).toBe(2);
    expect(side.viewOf("@1").section).toBe("card");
    expect(side.sectionForKey("2")).toBe("pr");
    const pane = src("components/terminal/SidePane.tsx");
    expect(pane).toContain("if (typing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;");
  });

  it("the chips open the pane only when it can draw; otherwise they keep the full-view jumps", () => {
    expect(side.sideCanShow(true, false, 900)).toBe(true);
    expect(side.sideCanShow(false, false, 900)).toBe(false);
    expect(side.sideCanShow(true, true, 900)).toBe(false);
    expect(side.sideCanShow(true, false, 0)).toBe(false);
    expect(term).toContain("onSide={sideCan ? (sec) => openSide(sideTab, sec) : undefined}");
    expect(term).toContain("onSide={canSide ? (sec) => { onFocusMe(); onSide(sec, win || sessId); } : undefined}");
    expect(bar).toContain("onSide ? () => onSide(\"diff\") : onDiff");
    expect(bar).toContain("onSide ? () => onSide(\"pr\") : onPr");
    expect(bar).toContain("openCard(card.query, card.label, card.tracker)");
  });

  it("types into the focused pane with a bracketed paste and never takes the focus", () => {
    const fn = term.slice(term.indexOf("const typeIntoPane"), term.indexOf("}, [paneIds, focusIdx]);", term.indexOf("const typeIntoPane")));
    expect(fn).toContain("\\x1b[200~");
    expect(fn).not.toContain(".focus(");
  });

  it("the embedded pull request keeps off the shared jump slot and the full view's Escape", () => {
    const pr = src("components/PrPanel.tsx");
    expect(pr).toContain("if (embedded) ownServed.current = ownKey; else clearPrJump();");
    expect(pr).toContain("if (embedded || !active || (selected == null && !query.trim())) return;");
  });

  it("a chip under another pane opens the side pane on THAT pane's window, and the review goes into this terminal", () => {
    expect(term).toContain("onSide(sec, win || sessId)");
    expect(term).toContain("onSide={(sec, tab) => openSide(tab, sec)}");
    const pr = src("components/PrPanel.tsx");
    expect(pr).toContain("if (!embedded?.typeInto) return sendToTerminal(cwd, prompt, title);");
    expect(src("components/terminal/SidePane.tsx")).toContain("typeInto: p.onType");
  });

  it("the embedded diff does not serve the worktree jump the full page serves", () => {
    expect(src("components/diff/DiffPage.tsx")).toContain("if (embedded || !wtJump ||");
  });

  it("mounts one section: the content is lazy and keyed by checkout and section", () => {
    const sp = src("components/terminal/SidePane.tsx");
    expect(sp.match(/lazy\(\(\) => import\(/g)?.length).toBe(3);
    expect(sp).toContain("const key = `${s.key}:${view.section}`;");
    expect(sp).not.toMatch(/setInterval|usePoll|\.focus\(\)/);
  });

  it("draws what the sections report: tinted badges, diff totals, card status, a title that wraps beside the terminal", () => {
    const sp = src("components/terminal/SidePane.tsx");
    expect(sp).toContain("color-mix(in srgb, ${TONE_FILL[tone]} 16%, transparent)");
    expect(sp).toContain("onTotals");
    expect(sp).toContain("onStatus");
    expect(sp).toContain('setSection(p.tab, "pr")');
    expect(src("components/diff/DiffPage.tsx")).toContain("embedded?.onTotals");
    expect(src("components/diff/DiffPage.tsx")).toContain("{narrow && (");
    const pr = src("components/PrPanel.tsx");
    // the title has a row of its own and clamps, beside a terminal as everywhere (components/pr/PrHeader.tsx)
    expect(src("index.css")).toContain(".prx-title {");
    expect(pr).toContain("<PrHeader");
    // The side pane is a pure reader of the tab's own record now — no second
    // hook of its own, so it and the bar can never disagree about the facts.
    expect(src("components/TerminalPanel.tsx")).toContain("const facts = liveTabFacts.get(tab);");
  });
});

describe("behaviour", () => {
  beforeEach(() => side.resetSidePane());

  it("pinning opens the pane on a tab that was closed earlier, and unpinning leaves it as it was", () => {
    side.openSide("@1");
    side.closeSide("@1");
    expect(side.viewOf("@1").open).toBe(false);
    side.togglePin();
    expect(side.viewOf("@1").open).toBe(true);
    side.togglePin();
    expect(side.viewOf("@1").open).toBe(false);
  });

  it("leaving compact is one change, however many times a drag asks for it", () => {
    side.toggleCompact();
    let bumps = 0;
    const off = side.subscribeSidePane(() => bumps++);
    for (let i = 0; i < 10; i++) side.setCompact(false);
    off();
    expect(side.viewOf("x").compact).toBe(false);
    expect(bumps).toBe(1);
  });

  it("forgetting a tab drops its view", () => {
    side.openSide("@2", "pr");
    side.forgetTab("@2");
    expect(side.viewOf("@2").section).toBe("card");
  });

  it("a scroll position is only restorable once the content is tall enough", () => {
    expect(side.canRestore(400, 300, 500)).toBe(false);
    expect(side.canRestore(400, 1000, 500)).toBe(true);
    expect(side.canRestore(500, 1000, 500)).toBe(true);
    expect(side.canRestore(501, 1000, 500)).toBe(false);
  });

});

describe("the embedded pull request is served once", () => {
  it("a re-render of the same request keeps it served; another request resets it", async () => {
    const pr = await import("../src/components/PrPanel.tsx");
    expect(pr.servedAfterRender("acme/orbit#42", "acme/orbit#42")).toBe("acme/orbit#42");
    expect(pr.servedAfterRender("acme/orbit#42", "acme/orbit#43")).toBe("");
    expect(pr.servedAfterRender("", "acme/orbit#42")).toBe("");
  });
});

describe("review fixes", () => {
  it("a window list from another session, or an empty one, forgets nothing", () => {
    const prev = { sid: "a", ids: ["@1", "@2"] };
    expect(side.closedWindows(prev, "b", ["@7"])).toEqual([]);
    expect(side.closedWindows(prev, "a", [])).toEqual([]);
    expect(side.closedWindows(prev, "a", ["@2"])).toEqual(["@1"]);
    expect(side.closedWindows(null, "a", ["@2"])).toEqual([]);
  });

  it("unpinning keeps a pane the person opened and still closes one the pin opened", () => {
    side.openSide("@1");
    side.openSide("@2");
    side.closeSide("@2");
    side.togglePin();
    expect(side.viewOf("@2").open).toBe(true);
    side.togglePin();
    expect(side.viewOf("@1").open).toBe(true);
    expect(side.viewOf("@2").open).toBe(false);
  });

  it("the flash alternates two keyframe names so a finished animation replays", () => {
    const pane = src("components/terminal/SidePane.tsx");
    expect(pane).toContain("agx-sp-flash0");
    expect(pane).toContain("agx-sp-flash1");
    expect(pane).toContain("agx-sp-f${n % 2}");
  });

  it("the diff badge says clean only for no files, and the pane keeps one element type", () => {
    expect(src("components/terminal/SidePane.tsx")).toContain("if (!t.files)");
    const term = src("components/TerminalPanel.tsx");
    expect(term).toContain("return <SidePaneWithFacts {...p} />;");
  });
});

describe("side pane fixes", () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, "..", "src", f), "utf8");

  it("keeps visited sections mounted: coming back refetches nothing, and the list is bounded", () => {
    let list: { id: string; n: number }[] = [];
    for (let i = 0; i < 10; i++) list = side.keepAlive(list, { id: `t${i}`, n: i });
    expect(list.length).toBe(side.KEEP_SECTIONS);
    list = side.keepAlive(list, { id: "t9", n: 99 });
    expect(list.length).toBe(side.KEEP_SECTIONS);
    expect(list.at(-1)).toEqual({ id: "t9", n: 99 });
    const body = src("components/terminal/SidePane.tsx");
    expect(body).toContain('display: "none"');
    expect(body).toContain("live={p.active && shown(e.id)}");
  });

  it("never renders another tab's checkout while this tab's is read", () => {
    const t = src("components/TerminalPanel.tsx");
    // A pane never seen before reads nothing (null), never `here`'s guess,
    // while its own first read is in flight — `storedRoot` only ever answers
    // for `identTabId`'s own record, there is no per-tab shadow cache to
    // paper over a gap, and no "current" root any other tab could land on.
    expect(t).toContain("const storedRoot = identTabId ? liveTabFacts.get(identTabId)?.root ?? null : null;");
    expect(t).toContain("chipWorktree(rawWt, wtDetecting, !!focusSess?.tmux, here)");
    expect(t).not.toContain("const lastFacts");
    expect(t).toContain("function SidePaneFor(p: SidePaneFactsProps) {\n  return <SidePaneWithFacts {...p} />;\n}");
  });

  it("a revisit shows the tab's own stored record at once — no 'detecting' for a tab already resolved", () => {
    const t = src("components/TerminalPanel.tsx");
    expect(t).toContain("setWtDetecting(!liveTabFacts.get(focusWin));");
  });

  it("a popup menu is moved back inside the pane's edges", () => {
    expect(side.menuShift(-30, 190, 0, 520)).toBe(38);
    expect(side.menuShift(10, 200, 0, 520)).toBe(0);
    expect(side.menuShift(300, 560, 0, 520)).toBe(-48);
    expect(src("components/diff/DiffPage.tsx")).toContain('closest("[data-side-pane]")');
  });

  it("the file list's drag changes the pane's own width, within the pane", () => {
    expect(side.embeddedListMax(520)).toBe(340);
    expect(side.embeddedListMax(200)).toBe(side.EMBEDDED_LIST_MIN_PX);
    const d = src("components/diff/DiffPage.tsx");
    expect(d).toContain("<SidebarGrip own={embedded");
    expect(d).not.toContain("Math.min(sidebarW, EMBEDDED");
  });

  it("the PR strip keeps 'PR #n' and its badge on one line; only the title shrinks", () => {
    const b = src("components/terminal/SidePane.tsx");
    expect(b).toContain('font-mono whitespace-nowrap shrink-0');
    expect(b).toContain('shrink-0 whitespace-nowrap"><Badge');
    expect(b).toContain("inline-flex items-center whitespace-nowrap px-1");
    expect(b).toContain('truncate min-w-0');
  });
});

describe("switching tabs A -> B -> A", () => {
  it("keeps A's mounted sections (same objects, so no remount and no fetch), its scroll and its section", () => {
    side.setSection("A", "diff");
    side.rememberScroll("A", "diff", 340);
    let list: { id: string; subject: object }[] = [];
    const a = { id: "A:k:diff", subject: {} };
    list = side.keepAlive(list, a);
    const first = list[0]!;
    list = side.keepAlive(list, { id: "B:k:pr", subject: {} });
    list = side.keepAlive(list, a);
    expect(list.map((e) => e.id)).toEqual(["B:k:pr", "A:k:diff"]);
    expect(list.find((e) => e.id === a.id)!.subject).toBe(first.subject);
    expect(side.viewOf("A").section).toBe("diff");
    expect(side.scrollOf("A", "diff")).toBe(340);
    expect(side.viewOf("B").section).not.toBe("diff");
  });

  it("the hidden pane stays mounted and quiet: no section is live and nothing new is kept", () => {
    const b = readFileSync(join(import.meta.dir, "..", "src/components/terminal/SidePane.tsx"), "utf8");
    expect(b).toContain("if (!p.hidden) keptSections = keepAlive(");
    expect(b).toContain("live={p.active && shown(e.id)}");
  });

  it("the kept sections live outside the component: a tab switch's momentary null subject cannot wipe them", () => {
    // PaneBody is swapped out for <Note> while `subject` is null (SidePane.tsx's
    // `!subject ? <Note/> : <PaneBody/>`) — a `useRef` inside PaneBody would die
    // with that unmount and lose every tab's mounted sections, not just the one
    // whose read is in flight. The cache must be a module-level binding instead.
    const b = readFileSync(join(import.meta.dir, "..", "src/components/terminal/SidePane.tsx"), "utf8");
    expect(b).toContain("let keptSections:");
    expect(b).not.toContain("useRef<typeof cur[]>");
    const paneBody = b.slice(b.indexOf("function PaneBody("), b.indexOf("function KeptSection("));
    expect(paneBody).not.toContain("useRef(");
  });
});

describe("the tracker card keeps its last answer across a switch", () => {
  const tasks = () => readFileSync(join(import.meta.dir, "..", "src", "components", "TasksPanel.tsx"), "utf8");

  it("clears the shown card only on a new card, never on re-activation", () => {
    const t = tasks();
    const body = t.slice(t.indexOf("function TrackerCardEmbed("), t.indexOf("export function TasksView("));
    // The reset is its own effect, keyed on card identity only: `active` toggling
    // false->true (section switch, tab switch) must not run it. A literal,
    // unconditional `setTask(null)` here used to be the check, but a SPLIT-MODE
    // remount runs this same effect fresh too (new component instance, same
    // [source, query]) — an unconditional clear would blank the paint a
    // cache-backed `useState` initializer just made, right back to a skeleton.
    // So the guard is now "only when this card isn't already held": a never-seen
    // card still clears to the spinner; a remount of one already in the cache
    // does not.
    expect(body).toMatch(/useEffect\(\(\) => \{ if \(peek<FindOutcome>\(findKey\)\.value === undefined\) \{ setTask\(null\); setErr\(""\); \} \}, \[source, query\]\);/);
    // The fetch effect, keyed on `active` too, never nulls the task itself: a
    // re-activation refetches in the background over the data already shown.
    const fetchEffect = body.slice(body.indexOf("useEffect(() => {\n    if (!active) return;"), body.indexOf("}, [active, source, query]);"));
    // One exception: a definite not-found answer (o.ok false, cached since a missing card
    // stopped throwing) is about this card, so it may clear it. A failed read throws into
    // .catch, which only sets the error and keeps the card shown.
    expect(fetchEffect.replace("else { setTask(null); setErr(o.error); }", "")).not.toContain("setTask(null)");
    expect(fetchEffect).toContain(".catch((e) => { if (live) setErr(");
  });
});

describe("the side pane's tab identity survives a tmux switch", () => {
  const term = () => readFileSync(join(import.meta.dir, "..", "src", "components", "TerminalPanel.tsx"), "utf8");

  it("never falls back to the shared project root while tmux is active", () => {
    // `root` is the same string for every window of this project. A window list
    // that has not caught up with a just-made A -> B -> A switch must keep
    // answering with the window id this tab had a moment ago — never with a
    // pane id (a different identity) or `root` (shared by every other tab),
    // either of which would hand this tab's cached branch and PR to the next
    // tab that lands on the same fallback key.
    const t = term();
    const body = t.slice(t.indexOf("const activeWindow ="), t.indexOf("const sideTab ="));
    expect(body).toContain("lastActiveWindow.current = activeWindow");
    expect(t).toContain('const sideTab = activeWindow ?? (tmuxActive ? lastActiveWindow.current : null) ?? paneIds[focusIdx] ?? root;');
  });
});

describe("an optimistic window switch stands until tmux actually confirms it", () => {
  it("is not resolved by an unrelated frame: only by tmux confirming or the window closing", () => {
    // tmux's window list is a fresh array on every poll frame regardless of
    // content, so "the array changed" is not news about the switch.
    expect(side.pendingResolved("@2", [{ id: "@1", active: true }, { id: "@2", active: false }])).toBe(false);
    expect(side.pendingResolved("@2", [{ id: "@1", active: false }, { id: "@2", active: true }])).toBe(true);
    // The window closed underneath the click: tmux's own next answer wins.
    expect(side.pendingResolved("@2", [{ id: "@1", active: true }])).toBe(true);
    expect(side.pendingResolved(null, [{ id: "@1", active: true }])).toBe(true);
  });

  it("the effect clears pendingWindow by content, never merely because the list's reference changed", () => {
    const t = readFileSync(join(import.meta.dir, "..", "src", "components", "TerminalPanel.tsx"), "utf8");
    expect(t).toContain("useEffect(() => { if (pendingResolved(pendingWindow, tmuxWindows)) setPendingWindow(null); }, [tmuxWindows, pendingWindow]);");
    expect(t).not.toContain('useEffect(() => { setPendingWindow(null); }, [tmuxWindows]);');
  });
});

describe("the card chip trusts tmux's own confirmed state, not a lagging window lookup", () => {
  it("a tmux pane with no active window reported yet is still a tmux pane: no cwd fallback", () => {
    const t = readFileSync(join(import.meta.dir, "..", "src", "components", "TerminalPanel.tsx"), "utf8");
    expect(t).toContain("chipWorktree(rawWt, wtDetecting, !!focusSess?.tmux, here)");
    expect(t).not.toContain("chipWorktree(storedRoot, wtDetecting, !!focusWin, here)");
  });
});

describe("the chip bar and the side pane read the same tab record", () => {
  const t = () => readFileSync(join(import.meta.dir, "..", "src", "components", "TerminalPanel.tsx"), "utf8");

  it("one record store, imported from lib/tabFacts.ts, never lib/paneIdentity.ts", () => {
    const body = t();
    expect(body).toContain('import { liveTabFacts, resolveCardId, resolveWorktree } from "../lib/tabFacts.ts";');
    expect(body).not.toContain("paneIdentity.ts");
    expect(body).toContain("const storedRoot = identTabId ? liveTabFacts.get(identTabId)?.root ?? null : null;");
  });

  it("both the chip bar and the side pane are handed the SAME resolved chipWt — one source, not two", () => {
    const body = t();
    expect(body.match(/at=\{chipWt\}/g)?.length).toBe(2); // the pane bar (PaneBarFor), and SidePaneFor
  });

  it("the record is written only where a read actually resolves something, never merely on a focus change", () => {
    const body = t();
    const write = body.slice(body.indexOf("liveTabFacts.write(focusWin,"), body.indexOf("liveTabFacts.write(focusWin,") + 90);
    expect(write).toContain("root: wt?.root ?? null, branch: wt?.branch ?? \"\"");
    // The write sits inside `run`, after `wt` is resolved from this read's own
    // answer — not in some effect keyed on the focus change itself, and the
    // focus-change branch above it only ever reads (`setWtDetecting`), never writes.
    expect(body.indexOf("liveTabFacts.write(focusWin,")).toBeGreaterThan(body.indexOf("const wt = resolveWorktree("));
  });

  it("a window's entire record is dropped when it closes, card/branch/pr/diff/view alike", () => {
    const body = t();
    expect(body).toContain("closedWindows(knownWindows.current, listKey, ids).forEach((id) => { forgetTab(id); });");
    // Switching tmux session in the same pty swaps the window list wholesale; that is not a close.
    expect(body).toContain("const listKey = `${focusSid}\\t${sess?.tmuxSession ?? \"\"}`;");
    const forgetTab = readFileSync(join(import.meta.dir, "..", "src/lib/sidePane.ts"), "utf8");
    expect(forgetTab).toContain("export function forgetTab(tab: string): void { liveTabFacts.forget(tab); }");
  });

  it("a pane book refill replaces the whole map, never merges stale entries into the new one", () => {
    const body = t();
    const read = body.slice(body.indexOf("const fill = () => {"), body.indexOf("fill();"));
    expect(read).toContain("paneBook.current = bookPanes(r.panes ?? []);");
  });
});

describe("resolveActiveWindow trusts tmux's list, not a stale pending id", () => {
  it("returns pending only while it is actually in the window list", () => {
    const windows = [{ id: "@1", active: true }, { id: "@2", active: false }];
    expect(side.resolveActiveWindow("@2", windows)).toBe("@2");
    // A click just switched tabs: tmux's list already moved on and no longer has
    // "@2" (closed, or this is a fresh session) — the active window wins instead
    // of the pending id from the tab that was just left.
    expect(side.resolveActiveWindow("@2", [{ id: "@1", active: true }])).toBe("@1");
    expect(side.resolveActiveWindow(null, windows)).toBe("@1");
    expect(side.resolveActiveWindow("@9", [])).toBe(null);
  });
});

describe("max width and split", () => {
  it("toggles independently, but turning max width off also drops the split", () => {
    expect(side.viewOf("@1").maxWidth).toBe(false);
    side.toggleMaxWidth("@1");
    expect(side.viewOf("@1").maxWidth).toBe(true);
    side.toggleSplit("@1");
    expect(side.viewOf("@1").split).toBe(true);
    side.toggleMaxWidth("@1");
    expect(side.viewOf("@1")).toMatchObject({ maxWidth: false, split: false });
  });

  it("turning the split on reaches max width even if it was off", () => {
    expect(side.viewOf("@2").maxWidth).toBe(false);
    side.toggleSplit("@2");
    expect(side.viewOf("@2")).toMatchObject({ maxWidth: true, split: true });
  });

  it("remembers which section is on the right, per tab", () => {
    side.setSplitSection("@1", "pr");
    expect(side.viewOf("@1").splitSection).toBe("pr");
    expect(side.viewOf("@2").splitSection).toBe("diff");
  });

  it("the right half falls back to diff when there is no PR to show", () => {
    expect(side.effectiveSplitSection("pr", true)).toBe("pr");
    expect(side.effectiveSplitSection("pr", false)).toBe("diff");
    expect(side.effectiveSplitSection("diff", false)).toBe("diff");
  });
});

describe("compact view and per-tab list width", () => {
  it("compact keeps the sections mounted (hidden) instead of dropping them", () => {
    const b = readFileSync(join(import.meta.dir, "..", "src/components/terminal/SidePane.tsx"), "utf8");
    expect(b).toContain("hidden={p.hidden || view.compact}");
    expect(b).not.toContain("view.compact ? <Compact");
  });

  it("each tab has its own diff list width", () => {
    side.setListWidth("A", 300);
    side.setListWidth("B", 150);
    expect(side.listWidthOf("A")).toBe(300);
    expect(side.listWidthOf("B")).toBe(150);
    expect(side.listWidthOf("C")).toBe(150);
  });
});
