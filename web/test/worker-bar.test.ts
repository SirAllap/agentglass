/*
 * The bar over a worker's tab is drawn for a policy-started worker and nobody
 * else. A named agent a person started, and an enlisted tab, run in panes too:
 * a Stop there would be a control that closes somebody's tab, so the stamp the
 * policy leaves is the test, and a pane with no worker gets no bar.
 */
import { describe, expect, it } from "bun:test";
import { workerAt, workerStatus, type NamedAgentRow } from "../src/lib/workerBar.ts";

const base = { kind: "opencode", windowId: "@2", startedAt: 1_000, endedAt: null } as const;
const worker: NamedAgentRow = { ...base, name: "builder-retry", paneId: "%7", startedBy: { engine: "opencode", rule: "Night hours" } };
const namedByHand: NamedAgentRow = { ...base, name: "my-own-tab", paneId: "%8" };
const endedWorker: NamedAgentRow = { ...base, name: "builder-retry", paneId: "%7", startedBy: { engine: "opencode" }, endedAt: 2_000, exitCode: 0 };

describe("which pane gets the worker's bar", () => {
  it("is the policy-started worker in that pane", () => {
    expect(workerAt([worker, namedByHand], "%7")?.name).toBe("builder-retry");
  });

  it("is not a pane a person's own named agent sits in", () => {
    expect(workerAt([worker, namedByHand], "%8")).toBeNull();
  });

  it("is not a pane nobody named", () => {
    expect(workerAt([worker], "%9")).toBeNull();
    expect(workerAt([worker], null)).toBeNull();
    expect(workerAt(null, "%7")).toBeNull();
  });

  it("follows the pane's newest row, so a stale worker name never claims a newer tab", () => {
    // Newest first: the tab in %7 belongs to a named agent now, not to the
    // worker that ran there yesterday.
    expect(workerAt([{ ...namedByHand, paneId: "%7" }, worker], "%7")).toBeNull();
  });

  it("stays after the turn, so the kept tab says the turn ended rather than looking broken", () => {
    expect(workerAt([endedWorker], "%7")?.exitCode).toBe(0);
  });
});

describe("the word on the bar", () => {
  it("says a role's turn ended without a result, which is the part to act on", () => {
    expect(workerStatus({ ...endedWorker, resultMissing: true })).toBe("ended without a result");
    expect(workerStatus({ ...endedWorker, resultMissing: true, exitCode: undefined })).toBe("ended without a result");
  });

  it("keeps the ending it had: running, the exit code, or just ended", () => {
    expect(workerStatus(worker)).toBe("running");
    expect(workerStatus(endedWorker)).toBe("exit 0");
    expect(workerStatus({ ...endedWorker, exitCode: undefined })).toBe("ended");
  });
});

describe("the bar's tooltips are the app's, not the browser's", () => {
  it("carries data-tip and never a native title", async () => {
    const src = await Bun.file(new URL("../src/components/terminal/WorkerBar.tsx", import.meta.url)).text();
    expect(src).toContain("data-tip={STOP_TIP}");
    expect(src).not.toMatch(/\stitle=/);
  });
});

describe("which id the bar is asked about", () => {
  it("is the tmux pane, never the shell's own key in `sessions`", async () => {
    /*
     * The shell's key is a client-side `t12-…` (see createSession), and
     * `/agents/named?pane=` refuses anything that is not `%7` — so the bar was
     * handed an id every poll was answered 400 for, and it never drew. The
     * pane comes off the tmux frame, which names it for a window that is not
     * split too (`tmuxPanes` is empty there).
     */
    const src = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url)).text();
    const at = src.indexOf("<WorkerBar");
    expect(at).toBeGreaterThan(-1);
    const tag = src.slice(at, src.indexOf("/>", at));
    expect(tag).toContain("tmuxPane");
    expect(tag).not.toContain("paneIds");
  });
});
