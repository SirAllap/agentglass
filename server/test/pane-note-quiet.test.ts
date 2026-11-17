// `/ingest` rewrote a pane's note on every hook event: two write transactions
// per event, two events per tool call, to change nothing but a time. A tool
// event that repeats the last one from that pane is now left unwritten for a
// few seconds; anything that says something new is written at once.
import { beforeEach, expect, test } from "bun:test";
import { NOTE_QUIET_MS, __forgetHookNotes, notePaneFromHook, paneAgentNote, paneForSession } from "../src/panewt.ts";

const REPO = "/home/dev/code/orbit";
const ENGINE = "/tmp/tmux-1000/agentglass,4242";
const hook = (pane: string, session: string, type: string, over: { cwd?: string; transcript?: string } = {}) => ({
  session_id: session, tmux_pane: pane, tmux_server: ENGINE, hook_event_type: type,
  payload: { transcript_path: over.transcript ?? `/t/${session}.jsonl`, cwd: over.cwd ?? REPO },
});
const at = (pane: string) => paneAgentNote(pane, ENGINE)?.at;

beforeEach(() => __forgetHookNotes());

test("tool events from a working pane write its note once per quiet window, not once each", () => {
  const P = "%9950";
  expect(notePaneFromHook(hook(P, "quiet-1", "PreToolUse"), 1_000_000)).toBe(true);
  expect(at(P)).toBe(1_000_000);
  // The rest of that tool call and the next ones: accepted, not written.
  for (const [type, t] of [["PostToolUse", 1_000_200], ["PreToolUse", 1_003_000], ["PostToolUse", 1_000_000 + NOTE_QUIET_MS - 1]] as const) {
    expect(notePaneFromHook(hook(P, "quiet-1", type), t)).toBe(true);
    expect(at(P), `${type} at ${t}`).toBe(1_000_000);
  }
  // The window is over: the time moves again.
  notePaneFromHook(hook(P, "quiet-1", "PreToolUse"), 1_000_000 + NOTE_QUIET_MS);
  expect(at(P)).toBe(1_000_000 + NOTE_QUIET_MS);
});

test("anything that is not a repeat is written at once", () => {
  const P = "%9951";
  notePaneFromHook(hook(P, "quiet-2", "PreToolUse"), 2_000_000);
  // A turn that ended, and the first tool event after it.
  notePaneFromHook(hook(P, "quiet-2", "Stop"), 2_000_100);
  expect(at(P)).toBe(2_000_100);
  notePaneFromHook(hook(P, "quiet-2", "PreToolUse"), 2_000_200);
  expect(at(P)).toBe(2_000_200);
  // The pane's agent moved to another directory, then to another conversation.
  notePaneFromHook(hook(P, "quiet-2", "PostToolUse", { cwd: `${REPO}/server` }), 2_000_300);
  expect(paneAgentNote(P, ENGINE)?.cwd).toBe(`${REPO}/server`);
  notePaneFromHook(hook(P, "quiet-2", "PostToolUse", { cwd: `${REPO}/server`, transcript: "/t/after-clear.jsonl" }), 2_000_400);
  expect(paneAgentNote(P, ENGINE)?.transcript_path).toBe("/t/after-clear.jsonl");
  // Another agent took the pane.
  notePaneFromHook(hook(P, "quiet-3", "PreToolUse"), 2_000_500);
  expect(paneAgentNote(P, ENGINE)?.session_id).toBe("quiet-3");
});

test("a session seen in another pane and back again is where it was last seen", () => {
  const A = "%9952", B = "%9953";
  notePaneFromHook(hook(A, "quiet-4", "PreToolUse"), 3_000_000);
  notePaneFromHook(hook(B, "quiet-4", "PreToolUse"), 3_000_100);
  expect(paneForSession("quiet-4")).toBe(B);
  // Back in the first pane inside the window: the same words as its last note, and still written.
  notePaneFromHook(hook(A, "quiet-4", "PreToolUse"), 3_000_200);
  expect(paneForSession("quiet-4")).toBe(A);
});
