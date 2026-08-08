import { test, expect, beforeEach } from "bun:test";
import { notePaneAgent } from "../src/panewt.ts";
import { noteEvent, paneFinished, markSeen, __resetAgentDone } from "../src/agentdone.ts";

beforeEach(() => __resetAgentDone());

const seed = (pane: string, sid: string) =>
  notePaneAgent({ pane, sessionId: sid, transcriptPath: `/t/${sid}.jsonl`, cwd: "/repo" });

test("a pane whose agent is mid-work does not light", () => {
  seed("%1", "s1");
  noteEvent("s1", "PreToolUse", 1000);
  expect(paneFinished("%1")).toBe(false);
});

test("a pane whose agent's latest event is Stop lights", () => {
  seed("%2", "s2");
  noteEvent("s2", "PreToolUse", 1000);
  noteEvent("s2", "Stop", 2000);
  expect(paneFinished("%2")).toBe(true);
});

test("looking at the tab puts it out; a newer finish relights it", () => {
  seed("%3", "s3");
  noteEvent("s3", "Stop", 2000);
  expect(paneFinished("%3")).toBe(true);
  markSeen(["%3"]);
  expect(paneFinished("%3")).toBe(false);
  noteEvent("s3", "PreToolUse", 3000); // works again
  expect(paneFinished("%3")).toBe(false); // mid-work, not done
  noteEvent("s3", "Stop", 4000); // finishes again
  expect(paneFinished("%3")).toBe(true);
});

test("a pane with no agent never lights (nvim, a plain shell)", () => {
  noteEvent("sX", "Stop", 5000);
  expect(paneFinished("%99")).toBe(false);
});

test("SubagentStop counts as a finish", () => {
  seed("%4", "s4");
  noteEvent("s4", "SubagentStop", 1000);
  expect(paneFinished("%4")).toBe(true);
});

test("an out-of-order backfill does not override the latest", () => {
  seed("%5", "s5");
  noteEvent("s5", "Stop", 2000);
  noteEvent("s5", "PreToolUse", 1000); // older, arrives later (backfill)
  expect(paneFinished("%5")).toBe(true); // still Stop
});
