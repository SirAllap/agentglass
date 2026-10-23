/*
 * The one bar of the PRs panel points at the view under it. The decisions are
 * pure (src/lib/prBarView.ts); the wiring is asserted against source, because
 * this project has no renderer.
 */
import { describe, expect, test } from "bun:test";
import { barControls, barPlaceholder, barView, CI_PLACEHOLDER, INBOX_PLACEHOLDER } from "../src/lib/prBarView.ts";
import { SEARCH_PLACEHOLDER } from "../src/lib/prSearch.ts";

const bar = await Bun.file(new URL("../src/components/PrFilterBar.tsx", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const presets = await Bun.file(new URL("../src/components/FilterPresets.tsx", import.meta.url)).text();
const presetsHook = await Bun.file(new URL("../src/components/useFilterPresets.ts", import.meta.url)).text();
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
  test("each view has its own placeholder", () => {
    expect(barPlaceholder("board")).toBe("Search or filter · ⏎ searches all PRs");
    expect(barPlaceholder("board")).toBe(SEARCH_PLACEHOLDER);
    expect(barPlaceholder("inbox")).toBe("Inbox · filter by title, repo or #number");
    expect(barPlaceholder("ci")).toBe("CI · filter checks by name or workflow");
    expect(new Set([SEARCH_PLACEHOLDER, INBOX_PLACEHOLDER, CI_PLACEHOLDER]).size).toBe(3);
  });
});

describe("controls per view", () => {
  test("the board keeps the filters and asks GitHub on Enter", () => {
    expect(barControls("board")).toEqual({ boardControls: true, serverSearch: true, inboxControls: false });
  });
  test("the inbox has the All / Unread switch and nothing of the board's", () => {
    expect(barControls("inbox")).toEqual({ boardControls: false, serverSearch: false, inboxControls: true });
  });
  test("CI has nothing extra", () => {
    expect(barControls("ci")).toEqual({ boardControls: false, serverSearch: false, inboxControls: false });
  });
  test("the bar draws the board's controls only through the decision", () => {
    const c = code(bar);
    for (const needle of ["{controls.boardControls && builder}", "controls.boardControls && chips.length > 0"]) {
      expect(c).toContain(needle);
    }
    expect(c).toContain("controls.inboxControls && inbox");
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
  test("the scoped box neither searches nor suggests people, and Enter is inert", () => {
    const c = code(bar);
    expect(c).toContain("if (scoped) return;");
    expect(c).toContain("!scoped && (pending || searching)");
    expect(c).toContain("const menuOpen = !scoped && ");
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
    const at = ["Open", "Closed", "Inbox", "CI"].map((l) => c.indexOf(`label="${l}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const l of ["Open", "Closed", "Inbox", "CI"]) {
      const from = c.lastIndexOf("<Pill", c.indexOf(`label="${l}"`));
      expect(c.slice(from, c.indexOf(`label="${l}"`))).toContain("icon={<");
    }
  });
  test("exactly one is lit: Open only when none of the others is", () => {
    expect(c).toContain("on={!inboxOn && !metricsOn && !closedOn}");
    expect(c).toContain("on={closedOn && !inboxOn && !metricsOn}");
    expect(c).toContain("on={inboxOn && !metricsOn}");
    expect(c).toContain("on={metricsOn}");
  });
  test("Open from anywhere returns to the board", () => {
    expect(c).toContain('if (!inboxOn && !metricsOn && !closedOn) { setFilter("all"); setQuery(""); }');
    expect(c).toContain("setInboxOn(false); setMetricsOn(false); setClosedOn(false);\n            }} />");
  });
  test("unread is the inbox's alone: no chip, no mark-all in the board's bar", () => {
    const b = code(bar);
    expect(b).not.toMatch(/Mark all read|unread\?\.count|onMarkAllRead/);
    expect(c).not.toContain("unread={{");
    expect(c).not.toContain("count={inboxUnread");
  });
});

describe("clearing the preset chips", () => {
  test("pressing the chip that is on turns it off", () => {
    expect(code(presets)).toContain("onClick={() => (on ? api.clear() : api.apply(p.id))}");
  });
  test("clear empties the rules and forgets the active set, and deletes nothing", () => {
    const fn = presetsHook.slice(presetsHook.indexOf("const clear = useCallback("), presetsHook.indexOf("const saveNew"));
    expect(fn).toContain("setRules(EMPTY)");
    expect(fn).toContain("setActive(null)");
    expect(fn).not.toMatch(/commit\(|remove/);
  });
  test("the Clear filters button holds its place and only changes state", () => {
    const c = code(presets);
    expect(c).toContain("Clear filters");
    expect(c).toContain('visibility: live === 0 ? "hidden" : "visible"');
    expect(c).toContain("disabled={live === 0}");
  });
  test("Escape on the chips clears, and nothing here asks a server", () => {
    const c = code(presets);
    expect(c).toContain('e.key === "Escape" && live > 0');
    expect(c).not.toMatch(/\bapi\.pr|fetch\(/);
    expect(presetsHook).not.toMatch(/fetch\(|api\.[a-z]+\(/);
  });
});
