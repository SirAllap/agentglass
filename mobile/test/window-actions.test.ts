/*
 * Renaming and closing a tmux window from the phone.
 *
 * What is pinned: the name rule the server enforces (so the button is never
 * live for a name the computer will refuse), the request the phone sends, the
 * sentence in front of the irreversible one, and that the screen reaches all
 * of it — the model is worth nothing if no row calls it.
 */
import { describe, expect, test } from "bun:test";
import { closeWords, titleProblem, windowRequest } from "../src/terminal/windowActions.ts";
import { paneTabs } from "../src/terminal/tabs.ts";
import type { AgentPane } from "../../shared/types.ts";

const pane = (over: Partial<AgentPane>): AgentPane => ({
  session: "orbit", sessionId: "$1", windowId: "@4", windowIndex: "4",
  windowName: "AI02", paneId: "%7", path: "/home/x/code/orbit", agentCwds: [],
  agentSession: null, ...over,
});

describe("the name", () => {
  test("a plain name is taken", () => {
    expect(titleProblem("review-8421")).toBeNull();
    expect(titleProblem("api v2.1")).toBeNull();
  });

  test("an empty or blank name is refused with a sentence", () => {
    expect(titleProblem("")).not.toBeNull();
    expect(titleProblem("   ")).not.toBeNull();
  });

  test("what the server would refuse is refused here first", () => {
    expect(titleProblem("a".repeat(41))).not.toBeNull();
    expect(titleProblem("a;b")).not.toBeNull();
    expect(titleProblem("tab\tname")).not.toBeNull();
    expect(titleProblem("a".repeat(40))).toBeNull();
  });
});

describe("the request", () => {
  const [tab] = paneTabs([pane({})]);

  test("a tab knows its window", () => {
    expect(tab!.windowId).toBe("@4");
    expect(tab!.windowName).toBe("AI02");
    expect(tab!.windowPanes).toBe(1);
  });

  test("rename carries the new name, and no directory", () => {
    expect(windowRequest(tab!, "rename", "scratch")).toEqual({
      session: "orbit", op: "rename", windowId: "@4", title: "scratch",
    });
  });

  test("close carries no name", () => {
    expect(windowRequest(tab!, "kill-window")).toEqual({
      session: "orbit", op: "kill-window", windowId: "@4",
    });
  });

  test("a split window reports how many panes it takes down with it", () => {
    const tabs = paneTabs([pane({ paneId: "%7" }), pane({ paneId: "%8" })]);
    expect(tabs.map((t) => t.windowPanes)).toEqual([2, 2]);
    expect(closeWords(tabs[0]!)).toContain("its 2 panes stop.");
    expect(closeWords(tab!)).not.toContain("panes");
    expect(closeWords(tab!)).toContain("what is running in it stops.");
  });
});

const screen = (await Bun.file(new URL("../app/(tabs)/terminal.tsx", import.meta.url)).text())
  .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

const switcher = await Bun.file(new URL("../src/terminal/Switcher.tsx", import.meta.url)).text();

describe("the Terminal screen", () => {
  test("every window row in the switcher has a way to rename or close it", () => {
    expect(switcher).toContain("Rename or close ${tab.label}");
    expect(switcher).toContain("onManage(tab)");
    expect(screen).toContain("onManage={(tab) => {");
    expect(screen).toContain("setManaging(tab)");
  });

  test("it sends the request the model builds, to the route the desk uses", () => {
    expect(screen).toContain('"/terminal/tmux/windows"');
    expect(screen).toContain("windowRequest(tab, op, title)");
  });

  test("closing asks first, and with the model's sentence", () => {
    const at = screen.indexOf('"Close this window?"');
    expect(at).toBeGreaterThan(-1);
    expect(screen.slice(at, at + 200)).toContain("closeWords(managing)");
  });

  test("a window that is no longer the one the sheet opened on is not touched", () => {
    const at = screen.indexOf("const windowDo");
    expect(screen.slice(at, screen.indexOf("setManageBusy(true)", at))).toContain("windowId !== tab.windowId");
  });

  test("the strip is read again afterwards", () => {
    const at = screen.indexOf("const windowDo");
    expect(at).toBeGreaterThan(-1);
    expect(screen.slice(at, screen.indexOf("}, [host, load, strip]);", at))).toContain("void load()");
  });
});
