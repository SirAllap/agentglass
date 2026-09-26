/*
 * A pane the phone itself just opened, before the poll lists it for real.
 *
 * Reported from a real device: the empty state's "Open a shell in <name>"
 * button made a real window on the computer — one pane, one window, zero
 * tmux clients on the session, no agent under it — and the phone stayed on
 * "Nothing open" through repeated presses of "Look again". `paneTabs` filters
 * out a detached, agent-less pane ON PURPOSE (a stale session from a test or
 * an old worktree should not clutter the strip), and nothing ever attaches to
 * flip that session's `attached` to true, because attaching IS what mounting
 * a terminal for the pane does — a chicken standing on its own egg.
 */
import { describe, expect, test } from "bun:test";
import { pendingTab } from "../src/terminal/tabs.ts";

const PENDING = { paneId: "%9", session: "atlas", where: "/home/x/code/atlas", label: "atlas" };

describe("pendingTab", () => {
  test("nothing pending, nothing to bridge", () => {
    expect(pendingTab(null, "%9")).toBeNull();
  });

  test("nothing active, even with a pane pending", () => {
    expect(pendingTab(PENDING, null)).toBeNull();
  });

  test("active is a DIFFERENT pane — never hand back somebody else's pending open", () => {
    expect(pendingTab(PENDING, "%3")).toBeNull();
  });

  test("the active pane IS the one just opened — a tab to bridge with", () => {
    const tab = pendingTab(PENDING, "%9");
    expect(tab).toEqual({ paneId: "%9", label: "atlas", session: "atlas", where: "/home/x/code/atlas", agent: false });
  });
});
