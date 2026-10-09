/*
 * A pane the phone itself just opened, before the poll lists it for real:
 * `paneTabs` filters a detached, agent-less pane on purpose, and attaching is
 * what mounting its terminal does, so without a bridge the empty state's "Open
 * a shell in <name>" left the phone on "Nothing open".
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
    expect(tab).toEqual({ paneId: "%9", label: "atlas", name: "atlas", session: "atlas", where: "/home/x/code/atlas", agent: false, windowId: "", windowName: "", windowPanes: 1 });
  });
});
