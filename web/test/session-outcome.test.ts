import { test, expect } from "bun:test";
import { deriveOutcome, type AgentCard } from "../src/lib/derive.ts";

const at = (t: number, over: Partial<AgentCard> = {}) =>
  ({ status: "idle", outcome: "unclear", lastType: "", lastSeen: t,
     lastErrorTs: 0, runningSince: 0, errors: 0, ...over } as unknown as AgentCard);

const NOW = 1_700_000_000_000;

test("a deliberate finish with nothing trailing is settled", () => {
  expect(deriveOutcome(at(NOW, { lastType: "Stop" }))).toBe("settled");
  expect(deriveOutcome(at(NOW, { lastType: "SessionEnd" }))).toBe("settled");
});

test("an error just before the end is the note it ended on", () => {
  // The Stop that trails a failure by a few seconds is the normal shape.
  expect(deriveOutcome(at(NOW, { lastType: "Stop", lastErrorTs: NOW - 5_000 }))).toBe("faulted");
});

// The regression this whole distinction exists to prevent: a session that hit a
// transient failure early, recovered, and worked for another ten minutes must
// not be reported as a failure. A lifetime error count would get this wrong.
test("an early error the session recovered from does not mark it", () => {
  expect(deriveOutcome(at(NOW, { lastType: "Stop", lastErrorTs: NOW - 10 * 60_000, errors: 3 }))).toBe("settled");
});

test("stopping on a question nobody answered is unanswered, not faulted", () => {
  expect(deriveOutcome(at(NOW, { lastType: "PermissionRequest" }))).toBe("unanswered");
  expect(deriveOutcome(at(NOW, { lastType: "Notification" }))).toBe("unanswered");
});

// Ordering: a run that errored and *then* asked for help wants a yes or a no,
// not a stack trace.
test("a question outranks a preceding error", () => {
  expect(deriveOutcome(at(NOW, { lastType: "PermissionRequest", lastErrorTs: NOW - 2_000 }))).toBe("unanswered");
});

test("a tool that started and never finished is faulted", () => {
  expect(deriveOutcome(at(NOW, { lastType: "PreToolUse", runningSince: NOW }))).toBe("faulted");
});

test("a tool that ran and was followed by more work is not faulted", () => {
  expect(deriveOutcome(at(NOW, { lastType: "Stop", runningSince: NOW - 120_000 }))).toBe("settled");
});

test("going quiet with no terminal event stays unclear", () => {
  // Saying nothing is the honest answer; inventing a verdict here is exactly
  // the green-washing the outcome axis exists to avoid.
  expect(deriveOutcome(at(NOW, { lastType: "PostToolUse" }))).toBe("unclear");
});

test("a running session has no outcome yet", () => {
  for (const status of ["working", "waiting", "errored"] as const) {
    expect(deriveOutcome(at(NOW, { status, lastType: "Stop" }))).toBe("unclear");
  }
});
