/*
 * What is allowed to interrupt him, and what is only allowed to be findable.
 *
 * He runs nine sessions at once. His notification centre read 60 unread, nearly
 * every row "Tool error — URGENT", and his verdict on them was the measurement
 * that mattered: "when I open the conversation I don't see that anything has
 * failed". By the time he looked, nothing had. Over 8 days of the real database,
 * 465 error events: 464 were followed by another event from the same session
 * within 60 seconds, all 465 within five minutes, and NOT ONE was the last
 * thing a session ever did. The agent had always already recovered.
 *
 * Urgency 0 was defined end to end — the server sends it, the frame carries it,
 * the phone drops it — and then died here, on an `unread++` and a `ding()` that
 * never asked. So the quietest tier in the app rang the bell exactly like an
 * agent blocked on a permission. These hold the tier honest at the one place it
 * was not.
 *
 * The guard against over-correcting is the last describe: a real blockage must
 * still ring, or this trades sixty useless interruptions for zero useful ones.
 */
import { describe, expect, test, beforeAll, beforeEach } from "bun:test";

// The module reads localStorage at import time (`retune` at the bottom of the
// file), so the stub has to exist before the import does — hence the dynamic
// one, the same shape notify-quiet.test.ts uses.
const cell = new Map<string, string>();
let sysNotify: typeof import("../src/lib/sysNotify.ts");
let recordNote: typeof sysNotify.recordNote;
let notifyHistory: typeof sysNotify.notifyHistory;
let notifyUnread: typeof sysNotify.notifyUnread;
let clearNotes: typeof sysNotify.clearNotes;

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  sysNotify = await import("../src/lib/sysNotify.ts");
  ({ recordNote, notifyHistory, notifyUnread, clearNotes } = sysNotify);
});

const note = (over: Partial<Parameters<typeof recordNote>[0]> = {}) => ({
  app: "agentglass", summary: "Tool error", body: "Bash failed", ...over,
});

describe("urgency 0 is a row, not an interruption", () => {
  beforeEach(() => clearNotes());

  test("it lands in the list", () => {
    recordNote(note({ urgency: 0 }));
    expect(notifyHistory().length, "still findable").toBe(1);
  });

  test("and does not touch the unread badge", () => {
    recordNote(note({ urgency: 0 }));
    recordNote(note({ urgency: 0, summary: "Tool error 2" }));
    expect(notifyUnread()).toBe(0);
  });

  test("while anything above it does", () => {
    recordNote(note({ urgency: 1, summary: "waiting" }));
    recordNote(note({ urgency: 2, summary: "blocked" }));
    expect(notifyUnread()).toBe(2);
  });

  test("and the default is unchanged", () => {
    // Callers that pass no urgency must keep the behaviour they had. Only the
    // ones that explicitly say 0 go quiet.
    recordNote(note({ summary: "no urgency given" }));
    expect(notifyUnread()).toBe(1);
  });
});

describe("the same news about one pane replaces itself", () => {
  beforeEach(() => clearNotes());

  const onPane = (summary: string, urgency: 0 | 1 | 2 = 0) =>
    recordNote({ app: "agentglass", summary, body: "failed", urgency, goto: { kind: "pane", pane: "%17" } });

  test("eighty failures on one pane are one row", () => {
    onPane("Tool error"); onPane("Tool error"); onPane("Tool error");
    expect(notifyHistory().length).toBe(1);
  });

  test("but nine sessions are nine rows", () => {
    // The key is the pane, so nothing collapses across agents — which is the
    // whole reason the pane is on the note in the first place.
    for (const pane of ["%1", "%2", "%3"]) {
      recordNote({ app: "agentglass", summary: "Tool error", body: "failed", urgency: 0, goto: { kind: "pane", pane } });
    }
    expect(notifyHistory().length).toBe(3);
  });

  test("and a blockage on that pane is never swallowed by a failure on it", () => {
    // Different urgency, different row. Collapsing these would let a silent
    // stream of failures delete the one note he has to act on.
    recordNote({ app: "agentglass", summary: "Approve Bash?", body: "held", urgency: 2, goto: { kind: "pane", pane: "%17" } });
    onPane("Tool error");
    const kinds = notifyHistory().map((n) => n.urgency).sort();
    expect(kinds).toEqual([0, 2]);
  });
});

describe("the badge counts what the list holds", () => {
  beforeEach(() => clearNotes());

  test("a superseded row stops being unread", () => {
    // It read 60 unread over a list that had never held 60: `unread++` ran on
    // every note while `supersede` was quietly removing the ones it replaced.
    const behind = (n: number) => recordNote({
      app: "git", summary: "orbit", body: `${n} commits to pull on trunk`, urgency: 1,
      goto: { kind: "git", repo: "orbit", branch: "trunk", root: "/r" },
    });
    behind(43); behind(44); behind(45);
    expect(notifyHistory().length).toBe(1);
    expect(notifyUnread(), "one row, one unread").toBe(1);
  });
});
