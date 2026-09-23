import { test, expect, beforeEach, describe } from "bun:test";
import { notePaneAgent } from "../src/panewt.ts";
import { noteEvent, paneStatus, markSeen, __resetAgentDone } from "../src/agentdone.ts";

beforeEach(() => __resetAgentDone());

const seed = (pane: string, sid: string) =>
  notePaneAgent({ pane, sessionId: sid, transcriptPath: `/t/${sid}.jsonl`, cwd: "/repo" });

/** A minute on, well past every "recent" window: only what the ladder keeps
 *  without a clock survives it. */
const LATER = 60_000;

describe("finished", () => {
  test("a pane whose agent's latest event is Stop is done", () => {
    seed("%2", "s2");
    noteEvent("s2", "PreToolUse", 1000, { toolUseId: "t1" });
    noteEvent("s2", "PostToolUse", 1500, { toolUseId: "t1" });
    noteEvent("s2", "Stop", 2000);
    expect(paneStatus("%2", 2000 + LATER)).toBe("done");
  });

  test("looking at the tab makes it idle; a newer finish is done again", () => {
    seed("%3", "s3");
    noteEvent("s3", "Stop", 2000);
    expect(paneStatus("%3", 2500)).toBe("done");
    markSeen(["%3"]);
    expect(paneStatus("%3", 2500)).toBe("idle");
    noteEvent("s3", "UserPromptSubmit", 3000);
    expect(paneStatus("%3", 3500)).toBe("working");
    noteEvent("s3", "Stop", 4000);
    expect(paneStatus("%3", 4500)).toBe("done");
  });

  test("SubagentStop counts as a finish", () => {
    seed("%4", "s4");
    noteEvent("s4", "SubagentStop", 1000);
    expect(paneStatus("%4", 1500)).toBe("done");
  });

  test("an out-of-order backfill does not override the latest", () => {
    seed("%5", "s5");
    noteEvent("s5", "Stop", 2000);
    noteEvent("s5", "PreToolUse", 1000, { toolUseId: "t9" }); // older, arrives later (backfill)
    expect(paneStatus("%5", 2000 + LATER)).toBe("done");
  });

  test("an agent that exited is idle, not done", () => {
    seed("%6", "s6");
    noteEvent("s6", "SessionEnd", 1000);
    expect(paneStatus("%6", 1500)).toBe("idle");
  });
});

describe("no agent is not idle", () => {
  test("a pane with no agent has no status (nvim, a plain shell)", () => {
    noteEvent("sX", "Stop", 5000);
    expect(paneStatus("%99", 5500)).toBeUndefined();
  });

  test("an agent reported here that has sent nothing since the restart is idle", () => {
    seed("%7", "s7");
    expect(paneStatus("%7", 1000)).toBe("idle");
  });
});

describe("waiting", () => {
  test("a permission request is still waiting ten minutes on — longer than the fleet's idle cut, on purpose", () => {
    seed("%10", "s10");
    noteEvent("s10", "PermissionRequest", 1000);
    expect(paneStatus("%10", 1000 + 10 * 60_000)).toBe("waiting");
  });

  test("a notification is waiting too, and outranks an old error", () => {
    seed("%11", "s11");
    noteEvent("s11", "PostToolUseFailure", 1000, { isError: true, toolUseId: "t1" });
    noteEvent("s11", "Notification", 2000, { notice: "permission" });
    expect(paneStatus("%11", 2500)).toBe("waiting");
  });

  test("the 'waiting for your input' that follows every Stop is the turn ending, not a question", () => {
    seed("%18", "s18");
    noteEvent("s18", "Stop", 1000);
    noteEvent("s18", "Notification", 61_000, { notice: "input" });
    expect(paneStatus("%18", 62_000)).toBe("done");
    markSeen(["%18"]);
    expect(paneStatus("%18", 62_000)).toBe("idle");
  });

  test("news is not a question either", () => {
    seed("%19", "s19");
    noteEvent("s19", "Stop", 1000);
    markSeen(["%19"]);
    noteEvent("s19", "Notification", 5000, { notice: null });
    expect(paneStatus("%19", 6000)).toBe("idle");
  });

  test("a question abandoned for half an hour stops asking", () => {
    seed("%12", "s12");
    noteEvent("s12", "PermissionRequest", 1000);
    expect(paneStatus("%12", 1000 + 31 * 60_000)).toBe("idle");
  });
});

describe("working", () => {
  test("recent events are working", () => {
    seed("%1", "s1");
    noteEvent("s1", "PostToolUse", 1000, { toolUseId: "a" });
    expect(paneStatus("%1", 5000)).toBe("working");
  });

  test("a long quiet build is still working while its call is open", () => {
    seed("%13", "s13");
    noteEvent("s13", "PreToolUse", 1000, { toolUseId: "build" });
    expect(paneStatus("%13", 1000 + 10 * 60_000)).toBe("working");
    noteEvent("s13", "PostToolUse", 1000 + 10 * 60_000, { toolUseId: "build" });
    expect(paneStatus("%13", 1000 + 11 * 60_000)).toBe("idle");
  });

  test("a call whose result was replayed first is not left open", () => {
    seed("%14", "s14");
    noteEvent("s14", "PostToolUse", 2000, { toolUseId: "x" });
    noteEvent("s14", "PreToolUse", 1000, { toolUseId: "x" });
    expect(paneStatus("%14", 2000 + LATER)).toBe("idle");
  });

  test("a call opened before the turn ended cannot still be running", () => {
    seed("%15", "s15");
    noteEvent("s15", "PreToolUse", 1000, { toolUseId: "lost" });
    noteEvent("s15", "Stop", 2000);
    markSeen(["%15"]);
    expect(paneStatus("%15", 2000 + LATER)).toBe("idle");
  });

  test("an open call past thirty minutes is lost, not long", () => {
    seed("%16", "s16");
    noteEvent("s16", "PreToolUse", 1000, { toolUseId: "old" });
    expect(paneStatus("%16", 1000 + 31 * 60_000)).toBe("idle");
  });

  test("calls without an id pair up by tool name", () => {
    seed("%17", "s17");
    noteEvent("s17", "PreToolUse", 1000, { toolName: "Bash" });
    expect(paneStatus("%17", 1000 + LATER)).toBe("working");
    noteEvent("s17", "PostToolUse", 1000 + LATER, { toolName: "Bash" });
    expect(paneStatus("%17", 1000 + 2 * LATER)).toBe("idle");
  });
});

describe("error", () => {
  test("an error seconds ago is error, and fades to working-or-idle", () => {
    seed("%20", "s20");
    noteEvent("s20", "PostToolUseFailure", 1000, { isError: true, toolUseId: "e" });
    noteEvent("s20", "PreToolUse", 1200, { toolUseId: "f" });
    expect(paneStatus("%20", 5000)).toBe("error");
    // Twenty seconds on it is still running its next call: working again.
    expect(paneStatus("%20", 30_000)).toBe("working");
  });

  test("a turn that ended on an error is error until looked at", () => {
    seed("%21", "s21");
    noteEvent("s21", "PostToolUseFailure", 1000, { isError: true, toolUseId: "e" });
    noteEvent("s21", "Stop", 1500);
    expect(paneStatus("%21", 1500 + LATER)).toBe("error");
    markSeen(["%21"]);
    expect(paneStatus("%21", 1500 + LATER)).toBe("idle");
  });

  test("an early error does not paint a turn that finished well", () => {
    seed("%22", "s22");
    noteEvent("s22", "PostToolUseFailure", 1000, { isError: true, toolUseId: "e" });
    noteEvent("s22", "PostToolUse", 1000 + 5 * LATER, { toolUseId: "g" });
    noteEvent("s22", "Stop", 1000 + 5 * LATER + 100);
    expect(paneStatus("%22", 1000 + 7 * LATER)).toBe("done");
  });

  test("a run that went quiet on an error, never ending its turn, is error", () => {
    seed("%23", "s23");
    noteEvent("s23", "PostToolUseFailure", 1000, { isError: true, toolUseId: "e" });
    expect(paneStatus("%23", 1000 + LATER)).toBe("error");
  });
});
