/*
 * Which windows the phone shows, and in what order.
 *
 * The strip used to be every window of one tmux session, named with tmux's
 * index. The fixtures are the shape of a real machine — an orchestrator in
 * one project driving workers, a second project and a scratch shell — with
 * invented names.
 */
import { describe, expect, test } from "bun:test";
import type { AgentPane } from "../../shared/types.ts";
import { paneTabs, readStrip, type Tab } from "../src/terminal/tabs.ts";
import {
  dotOf, groupOf, isDirty, rowSub, statusOf, stripFor, subline, switcherGroups, worstOf,
} from "../src/terminal/windows.ts";

const pane = (over: Partial<AgentPane>): AgentPane => ({
  session: "orbit", sessionId: "$1", windowId: "@1", windowIndex: "1",
  windowName: "Orchestrator", paneId: "%1", path: "/home/x/code/orbit", agentCwds: ["/home/x/code/orbit"],
  agentSession: null, repo: "/home/x/code/orbit", ...over,
});

const win = (n: number, over: Partial<AgentPane>): AgentPane =>
  pane({ windowId: `@${n}`, windowIndex: String(n), paneId: `%${n}`, ...over });

/** Orbit: an orchestrator (pinned), a worker that is waiting, a worker that
 *  is working. Acme: two windows. Docs: one, idle. One shell in no repository. */
const machine: AgentPane[] = [
  win(1, { windowName: "Orchestrator", pinned: true, status: "working" }),
  win(2, { windowName: "orbit-1042-sync", status: "working", path: "/home/x/code/orbit-1042" }),
  win(3, { windowName: "orbit-1050-crop", status: "waiting", path: "/home/x/code/orbit-1050" }),
  win(4, { windowName: "acme-2210-nav", repo: "/home/x/code/acme-web", path: "/home/x/code/acme-web", status: "idle" }),
  win(5, { windowName: "acme-ci", repo: "/home/x/code/acme-web", path: "/home/x/code/acme-web" }),
  win(6, { windowName: "docs-build", repo: "/home/x/code/docs-site", path: "/home/x/code/docs-site", status: "idle" }),
  win(7, { windowName: "scratch", repo: null, path: "/tmp", agentCwds: [] }),
];
const all: Tab[] = paneTabs(machine);
const tab = (name: string): Tab => all.find((t) => t.name === name)!;
const NONE: ReadonlySet<string> = new Set();

describe("a window's project", () => {
  test("is its repository's name, so every worktree of one project shares it", () => {
    expect(groupOf(tab("orbit-1042-sync"))).toBe("orbit");
    expect(groupOf(tab("acme-ci"))).toBe("acme-web");
  });

  test("a group set by hand wins, which is how an orchestrator lives in the project it drives", () => {
    const moved = paneTabs([win(1, { windowName: "Orchestrator", group: "acme-web" })])[0]!;
    expect(groupOf(moved)).toBe("acme-web");
  });

  test("no repository is 'other', not a blank", () => {
    expect(groupOf(tab("scratch"))).toBe("other");
  });

  test("the tab carries the window's own name, without tmux's index", () => {
    expect(tab("Orchestrator").label).toBe("1 Orchestrator");
    expect(tab("Orchestrator").name).toBe("Orchestrator");
  });
});

describe("the strip", () => {
  test("is only the project the open window is in", () => {
    expect(stripFor(all, tab("acme-ci")).map((t) => t.name)).toEqual(["acme-2210-nav", "acme-ci"]);
  });

  test("puts the pinned window first, whatever tmux's order", () => {
    const pinnedLast = paneTabs([
      win(1, { windowName: "worker" }),
      win(2, { windowName: "Orchestrator", pinned: true }),
    ]);
    expect(stripFor(pinnedLast, pinnedLast[0]).map((t) => t.name)).toEqual(["Orchestrator", "worker"]);
  });

  test("is empty with nothing open, and never drops the open window itself", () => {
    expect(stripFor(all, null)).toEqual([]);
    const fresh = { ...tab("scratch"), paneId: "%99", name: "fresh" };
    expect(stripFor(all, fresh).map((t) => t.name)).toContain("fresh");
  });
});

describe("what a window is doing", () => {
  test("a held gate says waiting ahead of the poll", () => {
    expect(statusOf(tab("orbit-1042-sync"), NONE)).toBe("working");
    expect(statusOf(tab("orbit-1042-sync"), new Set([tab("orbit-1042-sync").paneId]))).toBe("waiting");
  });

  test("a window with no agent has no dot colour of its own, which is not idle", () => {
    expect(dotOf(statusOf(tab("scratch"), NONE))).toBe("none");
    expect(dotOf(statusOf(tab("docs-build"), NONE))).toBe("idle");
    expect(dotOf("waiting")).toBe("needs");
  });

  test("a folded project shows its most urgent window's dot", () => {
    expect(worstOf(stripFor(all, tab("Orchestrator")), NONE)).toBe("waiting");
    expect(worstOf([tab("acme-ci")], NONE)).toBeUndefined();
  });
});

describe("the line under the title", () => {
  test("counts the project's windows and, only when it is news, the ones that need you", () => {
    const orbit = stripFor(all, tab("Orchestrator"));
    expect(subline(orbit, NONE)).toBe("3 windows · 1 needs you");
    expect(subline(stripFor(all, tab("acme-ci")), NONE)).toBe("2 windows");
    expect(subline([tab("scratch")], NONE)).toBe("1 window");
  });

  test("a gate counts as needing you", () => {
    const docs = [tab("docs-build")];
    expect(subline(docs, new Set([docs[0]!.paneId]))).toBe("1 window · 1 needs you");
  });
});

describe("the switcher", () => {
  const open = (query = "", currentKey: string | null = "orbit", expanded: string[] = []) =>
    switcherGroups(all, { query, currentKey, asking: NONE, expanded: new Set(expanded) });

  test("groups by project, the one you are in first when it has news, only that one open", () => {
    const groups = open();
    expect(groups.map((g) => g.label)).toEqual(["orbit", "acme-web", "docs-site", "other"]);
    expect(groups.map((g) => g.open)).toEqual([true, false, false, false]);
    expect(groups[0]!.needs).toBe(1);
  });

  test("a project with something waiting outranks the one you are in", () => {
    const groups = open("", "acme-web");
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(["orbit", "acme-web"]);
    expect(groups[1]!.current).toBe(true);
  });

  test("inside a project: pinned first, then the ones waiting on you, then tmux's order", () => {
    expect(open()[0]!.tabs.map((t) => t.name)).toEqual(["Orchestrator", "orbit-1050-crop", "orbit-1042-sync"]);
  });

  test("a folded project opens when the person opens it", () => {
    expect(open("", "orbit", ["acme-web"]).find((g) => g.key === "acme-web")!.open).toBe(true);
  });

  test("searching opens every project with a match and hides the rest", () => {
    const groups = open("crop");
    expect(groups.map((g) => g.label)).toEqual(["orbit"]);
    expect(groups[0]!.tabs.map((t) => t.name)).toEqual(["orbit-1050-crop"]);
    const byProject = open("acme");
    expect(byProject.map((g) => g.label)).toEqual(["acme-web"]);
    // The name of the project matched, so it keeps all its windows.
    expect(byProject[0]!.tabs).toHaveLength(2);
    expect(byProject[0]!.open).toBe(true);
  });

  test("every word must match, in any order", () => {
    expect(open("crop 1050").length).toBe(1);
    expect(open("crop nothing-like-it")).toEqual([]);
  });
});

describe("a window's row", () => {
  test("says what it is doing and where", () => {
    expect(rowSub(tab("orbit-1042-sync"), "working")).toBe("working · orbit-1042");
    expect(rowSub(tab("scratch"), undefined)).toBe("tmp");
  });

  test("at a gate it says the exact thing it wants to do, because that decides whether to go", () => {
    expect(rowSub(tab("orbit-1050-crop"), "waiting", "bun test src/avatar"))
      .toBe("needs you · Allow “bun test src/avatar”?");
    expect(rowSub(tab("orbit-1050-crop"), "waiting")).toBe("needs you · orbit-1050");
  });
});

describe("the dot on the Git icon", () => {
  test("is on when the checkout has anything uncommitted", () => {
    expect(isDirty({ repos: [{ files: [{}] }] })).toBe(true);
    expect(isDirty({ repos: [{ files: [] }] })).toBe(false);
  });

  test("is off for an answer with no repository, or no answer", () => {
    expect(isDirty({ repos: [] })).toBe(false);
    expect(isDirty(null)).toBe(false);
    expect(isDirty({})).toBe(false);
  });
});

describe("the poll notices a window change state", () => {
  test("a dot that turns amber repaints the strip, and an answer that changes nothing does not", () => {
    const first = readStrip(null, { canAttach: true, panes: machine });
    expect(first.changed).toBe(true);
    const shape = first.changed ? first.shape : "";
    expect(readStrip(shape, { canAttach: true, panes: machine }).changed).toBe(false);
    const turned = machine.map((p) => (p.windowName === "orbit-1042-sync" ? { ...p, status: "waiting" as const } : p));
    expect(readStrip(shape, { canAttach: true, panes: turned }).changed).toBe(true);
    const regrouped = machine.map((p) => (p.windowName === "scratch" ? { ...p, group: "orbit" } : p));
    expect(readStrip(shape, { canAttach: true, panes: regrouped }).changed).toBe(true);
  });
});
