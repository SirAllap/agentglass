/*
 * The one bar of the PRs panel points at the view under it. The decisions are
 * pure (src/lib/prBarView.ts); the wiring is asserted against source, because
 * this project has no renderer.
 */
import { describe, expect, test } from "bun:test";
import { barControls, barView, viewAfterTyping } from "../src/lib/prBarView.ts";
import { SEARCH_PLACEHOLDER, searchPlaceholder } from "../src/lib/prSearch.ts";

const bar = await Bun.file(new URL("../src/components/PrFilterBar.tsx", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const views = await Bun.file(new URL("../src/components/PrViewsBar.tsx", import.meta.url)).text();
const inbox = await Bun.file(new URL("../src/components/prs/Inbox.tsx", import.meta.url)).text();
const ci = await Bun.file(new URL("../src/components/prs/CiMetrics.tsx", import.meta.url)).text();

const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");

describe("which view the bar points at", () => {
  test("CI wins over Inbox, and neither is the board", () => {
    expect(barView(false, false)).toBe("board");
    expect(barView(true, false)).toBe("inbox");
    expect(barView(false, true)).toBe("ci");
    expect(barView(true, true)).toBe("ci");
  });
  test("the box is the board's search on every view: typing from Inbox or CI leaves for the board, an empty box stays", () => {
    expect(searchPlaceholder("acme/orbit")).toBe("Search all of acme/orbit · @person · -word · is:draft");
    expect(SEARCH_PLACEHOLDER).toBe("Search all of this repository · @person · -word · is:draft");
    expect(viewAfterTyping("inbox", "retry")).toBe("board");
    expect(viewAfterTyping("ci", "@ines-r")).toBe("board");
    expect(viewAfterTyping("ci", "  ")).toBe("ci");
    expect(viewAfterTyping("board", "")).toBe("board");
  });
});

describe("controls per view", () => {
  test("the board keeps the filters and asks GitHub on Enter", () => {
    expect(barControls("board")).toEqual({ boardControls: true, serverSearch: true });
  });
  test("the inbox has nothing of the board's; its Unread switch is in the view's More menu", () => {
    expect(barControls("inbox")).toEqual({ boardControls: false, serverSearch: false });
  });
  test("CI has nothing extra", () => {
    expect(barControls("ci")).toEqual({ boardControls: false, serverSearch: false });
  });
  test("the bar draws the board's controls only through the decision", () => {
    const c = code(bar);
    for (const needle of ['controls.boardControls && chips.some((c) => c.key !== "text")']) {
      expect(c).toContain(needle);
    }
    expect(c).not.toContain("inboxControls");
  });
  test("the saved views are a row of the board's own, under the bar, never on the other views or over a search", async () => {
    const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    const at = panel.indexOf("<PrViewsBar api={viewsApi}");
    expect(at).toBeGreaterThan(-1);
    expect(panel.slice(at - 600, at)).toContain('layout.listBar && repo && bar === "board" && !searchingNow && !personLogin');
  });
});

describe("text per view", () => {
  test("the panel keeps three separate texts", () => {
    const c = code(panel);
    expect(c).toContain('const [inboxQ, setInboxQ] = useState("")');
    expect(c).toContain('const [ciQ, setCiQ] = useState("")');
    expect(c).toContain('const [query, setQuery] = useState("")');
    expect(c).toContain("filterText={ciQ} onFilterText={setCiQ}");
    expect(c).toContain("filterText={inboxQ} onFilterText={setInboxQ}");
  });
  test("switching view does not reset another view's text", () => {
    const c = code(panel);
    expect(c).not.toMatch(/setInboxQ\(""\)|setCiQ\(""\)/);
  });
  test("Inbox and CI have no search input and no local fallback", () => {
    for (const src of [code(inbox), code(ci)]) {
      expect(src).not.toMatch(/<input\b/);
      expect(src).not.toMatch(/localQ|localQuery|setLocal/);
      expect(src).not.toMatch(/filterText\?:|onFilterText\?:/);
    }
    expect(code(inbox)).not.toContain("useState(false);\n  const [unreadOnly");
    expect(code(inbox)).not.toMatch(/const \[unreadOnly/);
  });
});

describe("no request on typing", () => {
  test("the bar has no scoped mode left: the box is the board's search, and the panel hops to the board on a keystroke", () => {
    expect(code(bar)).not.toContain("scoped");
    expect(code(panel)).toContain("viewAfterTyping(bar, v) === \"board\"");
  });
  test("Inbox and CI make no call from the filter text", () => {
    // The text feeds useMemo filters; the loaders and the effects that call them never name it.
    for (const [name, src, text] of [["inbox", code(inbox), "q"], ["ci", code(ci), "query"]] as const) {
      const loader = src.slice(src.indexOf("const load = useCallback("), src.indexOf("usePoll(active"));
      expect(loader.length, name).toBeGreaterThan(50);
      expect(loader, name).not.toMatch(new RegExp(`\\b${text}\\b|filterText`));
    }
  });
});

describe("the four-place switcher", () => {
  const c = code(panel);
  test("Open, Closed, Inbox, CI in that order, each with an icon", () => {
    const at = ["Open", "Closed", "Inbox", "CI"].map((l) => c.indexOf(`label: "${l}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const l of ["Open", "Closed", "Inbox", "CI"]) {
      const from = c.lastIndexOf("viewTab({", c.indexOf(`label: "${l}"`));
      expect(c.slice(from, c.indexOf(`label: "${l}"`))).toContain("icon: <");
    }
  });
  test("exactly one is lit: Open only when none of the others is", () => {
    expect(c).toContain("on: !inboxOn && !metricsOn && !closedOn");
    expect(c).toContain("on: closedOn && !inboxOn && !metricsOn");
    expect(c).toContain("on: inboxOn && !metricsOn");
    expect(c).toContain("on: metricsOn");
  });
  test("Open from anywhere returns to the board", () => {
    expect(c).toContain('if (!inboxOn && !metricsOn && !closedOn) { setFilter("all"); setQuery(""); }');
    expect(c).toContain("setInboxOn(false); setMetricsOn(false); setClosedOn(false);\n            } })");
  });
  test("unread is the inbox's alone: no chip, no mark-all in the board's bar", () => {
    const b = code(bar);
    expect(b).not.toMatch(/Mark all read|unread\?\.count|onMarkAllRead/);
    expect(c).not.toContain("unread={{");
    expect(c).not.toContain("count={inboxUnread");
  });
});

describe("the views bar", () => {
  test("it only moves the live filter and the saved list through its props: it asks no server itself", () => {
    expect(code(views)).not.toMatch(/\bapi\.pr|fetch\(|from "[./]+\/lib\/api/);
  });
  test("Alt+1..9 applies the nth view, and only while the panel is the one in front", () => {
    const c = code(views);
    expect(c).toContain("if (!hotkeys) return;");
    expect(c).toContain("viewHotkey(e, altHeld)");
  });
  test("a stale Alt is released when the window loses focus or is hidden", () => {
    const c = code(views);
    expect(c).toContain('window.addEventListener("blur", release)');
    expect(c).toContain('document.addEventListener("visibilitychange", release)');
    expect(c).toContain('if (e.key === "Alt") altHeld = false;');
  });
});

