/*
 * Go to a window: every tmux window on the machine, the ones waiting for you
 * first, one chord away.
 *
 * Past twenty windows the strip stops being how you find one; the switcher is.
 * Its decisions live in lib/windowSwitcher.ts and are tested there; the panel
 * and the app wiring are checked at source level.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentPane } from "../../shared/types.ts";
import { nextWaiting, rankWindows, windowsFromPanes, type SwitcherRow } from "../src/lib/windowSwitcher.ts";
import { APP_CHORD_DEFAULTS, APP_CHORD_LABELS, appActionForChord } from "../src/lib/keybindings.ts";
import { isAppChord } from "../src/lib/termKeys.ts";

const read = (p: string) => readFileSync(new URL("../src/" + p, import.meta.url), "utf8");

const pane = (over: Partial<AgentPane>): AgentPane => ({
  session: "main", sessionId: "$0", windowId: "@1", windowIndex: "1", windowName: "AI01",
  paneId: "%1", path: "/home/dev/code/orbit", agentCwds: [], agentSession: null, attached: true,
  ...over,
});

describe("rows from panes", () => {
  test("one row per window, with its most urgent pane's status and pane", () => {
    const rows = windowsFromPanes([
      pane({ windowId: "@1", paneId: "%1", status: "working" }),
      pane({ windowId: "@1", paneId: "%2", status: "waiting" }),
      pane({ windowId: "@2", windowIndex: "2", windowName: "notes", paneId: "%3" }),
    ]);
    expect(rows).toHaveLength(2);
    const one = rows.find((r) => r.windowId === "@1")!;
    expect(one.status).toBe("waiting");
    expect(one.paneId).toBe("%2");
    expect(one.repo).toBe("orbit");
    expect(rows.find((r) => r.windowId === "@2")!.status).toBeUndefined();
  });

  test("a window shared with a phone's grouped session is one row, under the session on a screen", () => {
    const rows = windowsFromPanes([
      pane({ session: "phone-%1", sessionId: "$9", attached: false }),
      pane({ session: "main", sessionId: "$0", attached: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session).toBe("main");
    expect(rows[0]!.sessionId).toBe("$0");
  });

  test("named by project: a worktree or a subfolder answers its repository", () => {
    const rows = windowsFromPanes([
      pane({ windowId: "@1", path: "/home/dev/code/orbit-fix-login", repo: "/home/dev/code/orbit" }),
      pane({ windowId: "@2", path: "/home/dev/code/orbit/src", repo: "/home/dev/code/orbit" }),
      pane({ windowId: "@3", path: "/home/dev/scratch", repo: null }),
    ]);
    expect(rows.map((r) => r.repo)).toEqual(["orbit", "orbit", "scratch"]);
  });

  test("popups are not places to go", () => {
    expect(windowsFromPanes([pane({ popup: true })])).toEqual([]);
  });
});

const row = (over: Partial<SwitcherRow>): SwitcherRow => ({
  windowId: "@1", sessionId: "$0", session: "main", index: 1, name: "AI01", repo: "orbit",
  paneId: "%1", attached: true, ...over,
});

describe("order", () => {
  const rows = [
    row({ windowId: "@1", index: 1, name: "orbit-api", status: "idle" }),
    row({ windowId: "@2", index: 2, name: "orbit-web", status: "working" }),
    row({ windowId: "@3", index: 3, name: "notes" }),
    row({ windowId: "@4", index: 4, name: "acme-docs", repo: "acme", status: "waiting" }),
    row({ windowId: "@5", index: 5, name: "acme-ci", repo: "acme", status: "error" }),
    row({ windowId: "@6", index: 6, name: "orbit-bench", status: "done" }),
  ];

  test("with nothing typed: waiting, error, working, done, idle, then windows with no agent", () => {
    expect(rankWindows(rows, "").map((r) => r.windowId)).toEqual(["@4", "@5", "@2", "@6", "@1", "@3"]);
  });

  test("the attached session before others at the same urgency, then tmux's order", () => {
    const two = [
      row({ windowId: "@7", session: "b", index: 2, attached: false }),
      row({ windowId: "@8", session: "a", index: 3 }),
      row({ windowId: "@9", session: "a", index: 1 }),
    ];
    expect(rankWindows(two, "").map((r) => r.windowId)).toEqual(["@9", "@8", "@7"]);
  });

  test("a query ranks by how it matched, and urgency inside that — not by name length", () => {
    // Both names start with it. The shorter one scores higher, and the one
    // waiting for you still comes first.
    const hits = rankWindows(rows, "acme").map((r) => r.windowId);
    expect(hits).toEqual(["@4", "@5"]);
    // A name that starts with it beats one that only has it in its folder,
    // however urgent that one is.
    const two = [
      row({ windowId: "@a", name: "AI01", repo: "acme", status: "waiting" }),
      row({ windowId: "@b", name: "acme-docs", repo: "orbit" }),
    ];
    expect(rankWindows(two, "acme").map((r) => r.windowId)).toEqual(["@b", "@a"]);
    expect(rankWindows(rows, "orbw").map((r) => r.windowId)[0]).toBe("@2"); // letters in order
    expect(rankWindows(rows, "zzz")).toEqual([]);
  });

  test("the folder and the session are searchable too", () => {
    expect(rankWindows([row({ name: "AI07", repo: "orbit-lab" })], "lab")).toHaveLength(1);
    expect(rankWindows([row({ name: "AI07", session: "scratch" })], "scratch")).toHaveLength(1);
  });
});

describe("the chord again walks the windows waiting for you", () => {
  const rows = [
    row({ windowId: "@1", status: "waiting" }),
    row({ windowId: "@2", status: "working" }),
    row({ windowId: "@3", status: "waiting" }),
  ];
  test("next, wrapping round", () => {
    expect(nextWaiting(rows, 0)).toBe(2);
    expect(nextWaiting(rows, 2)).toBe(0);
    expect(nextWaiting(rows, 1)).toBe(2);
  });
  test("nothing waiting is -1; one waiting stays on it", () => {
    expect(nextWaiting([row({ status: "idle" })], 0)).toBe(-1);
    expect(nextWaiting([row({ status: "waiting" })], 0)).toBe(0);
    expect(nextWaiting([], 0)).toBe(-1);
  });
});

describe("the panel", () => {
  const sw = read("components/terminal/WindowSwitcher.tsx");

  test("the cursor follows its window through the two-second re-sort", () => {
    expect(sw).toContain("const [selId, setSelId] = useState<string | null>(null);");
    expect(sw).toContain("ranked.findIndex((r) => r.windowId === selId)");
    expect(sw).not.toContain("const [sel, setSel]");
  });

  test("a digit is part of the search; Alt+digit jumps", () => {
    expect(sw).toContain("if (e.altKey && !ctrl && digit)");
    expect(sw).not.toMatch(/!q && !ctrl && !e\.altKey/);
  });

  test("closing gives the keyboard back to whatever had it", () => {
    expect(sw).toContain("if (back?.isConnected) back.focus();");
  });
});

describe("the chord", () => {
  test("registered and labelled, so Settings can rebind it", () => {
    expect(APP_CHORD_DEFAULTS["windows.switcher"]).toBe("mod+alt+j");
    expect(APP_CHORD_LABELS["windows.switcher"].label).toBe("Go to a window");
    expect(appActionForChord("mod+alt+j")).toBe("windows.switcher");
  });

  test("not plain Ctrl+J, which is a new line in the shell and in agent prompts", () => {
    expect(appActionForChord("mod+j")).toBeNull();
    expect(isAppChord({ key: "j", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
  });

  test("it is taken from the terminal, so it works with a pane focused", () => {
    expect(isAppChord({ key: "j", ctrlKey: true, metaKey: false, shiftKey: false, altKey: true })).toBe(true);
  });

  test("the app opens it; pressed again, the switcher keeps the key", () => {
    const app = read("App.tsx");
    expect(app).toContain('if (action === "windows.switcher") {');
    expect(app).toContain("<WindowSwitcher open={windowsOpen}");
    const sw = read("components/terminal/WindowSwitcher.tsx");
    expect(sw).toContain('chord === appChordFor("windows.switcher")');
    expect(sw).toContain("nextWaiting(ranked, at)");
    // stopPropagation before anything else, or the App handler sees the chord.
    const start = sw.indexOf("const onKey = (e: React.KeyboardEvent) => {");
    expect(start).toBeGreaterThan(-1);
    const onKey = sw.slice(start, sw.indexOf("\n  };\n", start));
    const stop = onKey.indexOf("e.stopPropagation()");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(onKey.indexOf("chordFromEvent"));
  });

  test("no animation on a palette used from the keyboard all day", () => {
    const sw = read("components/terminal/WindowSwitcher.tsx");
    expect(sw).not.toContain("motion.");
    expect(sw).not.toContain("transition");
  });
});
