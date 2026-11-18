/*
 * A worker's tab says which worker it is by a role glyph in the strip; there is
 * no bar over the pane (it changed the terminal's height between tabs). Only a
 * policy-started or role-started worker is marked: a tab a person opened by hand
 * gets no icon and no Stop.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { roleTabIcon, workerIconColour, workerInWindow, workerState, workerTabTip, type NamedAgentRow } from "../src/lib/workerTab.ts";

const base = { kind: "opencode", paneId: "%7", windowId: "@2", startedAt: 1_000, endedAt: null } as const;
const worker: NamedAgentRow = { ...base, name: "builder-retry", role: "builder", startedBy: { engine: "opencode" } };
const byHand: NamedAgentRow = { ...base, name: "my-own-tab", windowId: "@3" };

describe("role icon", () => {
  it("picks the flow glyph and colour per role", () => {
    expect(roleTabIcon("builder")).toMatchObject({ id: "builder", colour: "#4aa08f" });
    expect(roleTabIcon("reviewer")).toMatchObject({ id: "reviewer", colour: "#d4a73a" });
    expect(roleTabIcon("inspector")?.id).toBe("reviewer");
    expect(roleTabIcon("verifier")).toMatchObject({ id: "verifier", colour: "#4cb06f" });
    expect(roleTabIcon("scout")).toMatchObject({ id: "scout", colour: "#c98a7a" });
  });
  it("an unknown or missing role has no icon", () => {
    expect(roleTabIcon("gardener")).toBeNull();
    expect(roleTabIcon(undefined)).toBeNull();
  });
  it("a non-worker tab has no icon", () => {
    expect(workerInWindow([byHand], "@3")).toBeNull();
    expect(workerInWindow(null, "@2")).toBeNull();
    expect(roleTabIcon(workerInWindow([worker, byHand], "@3")?.role)).toBeNull();
    expect(workerInWindow([worker], "@2")?.name).toBe("builder-retry");
  });
});

describe("tooltip", () => {
  it("reads name · Role · state", () => {
    expect(workerTabTip(worker)).toBe("builder-retry · Builder · running");
    expect(workerTabTip({ ...worker, endedAt: 2_000 })).toBe("builder-retry · Builder · idle");
    expect(workerState({ ...worker, awaitingAnswer: true })).toBe("needs you");
  });
});

describe("no bar, Stop in the menu", () => {
  const panel = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url), "utf8");
  const strip = readFileSync(new URL("../src/components/terminal/TermStrip.tsx", import.meta.url), "utf8");
  it("TerminalPanel renders no WorkerBar", () => {
    expect(panel).not.toContain("WorkerBar");
  });
  it("the tab menu has Stop worker, on worker tabs only", () => {
    expect(strip).toContain("Stop worker");
    expect(strip).toMatch(/workerOf\(w\.id\)[^\n]*&&|workerOf\(w\.id\)\)? \?/);
  });
});

describe("a worker's window before its row exists", () => {
  it("lists the windows no row points at, so the fleet event can re-read for them", async () => {
    const { windowsWithoutRow } = await import("../src/lib/workerTab.ts");
    expect(windowsWithoutRow([worker], ["@2", "@9"])).toEqual(["@9"]);
    expect(windowsWithoutRow([worker, byHand], ["@2", "@3"])).toEqual([]);
    expect(windowsWithoutRow(null, ["@2"])).toEqual(["@2"]);
  });
  it("TermStrip re-reads on the fleet event, not a timer", () => {
    const src = readFileSync(new URL("../src/components/terminal/TermStrip.tsx", import.meta.url), "utf8");
    expect(src).toContain("subscribeAgents(");
    expect(src).not.toMatch(/setInterval/);
  });
});

describe("Stop worker", () => {
  it("is offered on a running worker, not an ended one", async () => {
    const { canStopWorker } = await import("../src/lib/workerTab.ts");
    expect(canStopWorker(worker)).toBe(true);
    expect(canStopWorker({ ...worker, endedAt: 2_000 })).toBe(false);
    expect(canStopWorker(null)).toBe(false);
  });
});

describe("workerIconColour", () => {
  const row = { name: "b", kind: "x", paneId: "%1", windowId: "@1", startedAt: 1, endedAt: null, role: "builder" } as NamedAgentRow;
  const role = { colour: "#4aa08f" };
  it("keeps the role colour while the worker runs, whatever the pane status says", () => {
    expect(workerIconColour(row, role, false)).toBe("#4aa08f");
  });
  it("goes amber when it needs you", () => {
    expect(workerIconColour(row, role, true)).toBe("var(--warning)");
    expect(workerIconColour({ ...row, awaitingAnswer: true }, role, false)).toBe("var(--warning)");
  });
  it("goes red only when it ended with a non-zero exit", () => {
    expect(workerIconColour({ ...row, endedAt: 5, exitCode: 1 }, role, false)).toBe("var(--error)");
    expect(workerIconColour({ ...row, endedAt: 5, exitCode: 0 }, role, false)).toBe("#4aa08f");
  });
});

describe("row re-reads", () => {
  it("spends one try per window, prunes gone windows, and stops at the max", async () => {
    const { spendRowTries } = await import("../src/lib/workerTab.ts");
    const t = new Map<string, number>([["@gone", 2]]);
    expect(spendRowTries(t, ["@1"], ["@1"], 2)).toEqual(["@1"]);
    expect(t.has("@gone")).toBe(false);
    expect(spendRowTries(t, ["@1"], ["@1"], 2)).toEqual(["@1"]);
    expect(spendRowTries(t, ["@1"], ["@1"], 2)).toEqual([]);
  });
  it("drops a read older than the last applied one", async () => {
    const { newestWins } = await import("../src/lib/workerTab.ts");
    const s = newestWins();
    const a = s.start(); const b = s.start();
    expect(s.accept(b)).toBe(true);
    expect(s.accept(a)).toBe(false);
  });
});
