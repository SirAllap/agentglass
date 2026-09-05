// The state taxonomy the fleet reads: working / waiting / stalled / errored /
// failed / idle.
//
// Two of those six are verdicts rather than observations, and the reason this
// file is table-driven is that the verdicts are only worth having if they are
// wrong ~never. A dot that says "stalled" over a healthy twenty-minute build is
// not a small cosmetic bug — it is the end of the dot, because after the second
// one nobody reads it again. So every positive case below is paired with the
// negative it could be confused with, and the negatives are the half that
// matters:
//
//   stalled   vs  a long call the evidence can vouch for   (liveness working)
//   stalled   vs  a long call nothing local can speak to   (liveness unknown)
//   stalled   vs  a stuck call that has not run long yet   (under the floor)
//   stalled   vs  a session between turns, nothing open    (no runningTool)
//   failed    vs  a run that finished clean                (Stop, no error)
//   failed    vs  a run that hit an error and recovered    (error long before)
//
// Time-relative, like derive-agents.test.ts: offsets are kept well clear of the
// thresholds (STALL 20s, IDLE 5m, WARN 5m) so the millisecond of drift between
// this file's `now` and deriveAgents' own can never flip a case.
import { test, expect } from "bun:test";
import { deriveAgents, deriveAlerts, isStalled, type AgentCard, type AgentStatus, type AgentOutcome } from "../src/lib/derive.ts";
import type { WatchEvent, OpenToolCall } from "../../shared/types.ts";

const now = Date.now();
const MIN = 60_000;

const ev = (over: Partial<WatchEvent> = {}): WatchEvent => ({
  id: Math.floor(Math.random() * 1e9),
  source_app: "app",
  session_id: "s1",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  provider: "Anthropic",
  is_error: 0,
  error_text: null,
  duration_ms: null,
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  cost_usd: 0.01,
  summary: null,
  timestamp: now - 1000,
  payload: {},
  ...over,
});

/** An open call as the server reports it, evidence and verdict included. This
 *  is the only door a `stuck` verdict can come through — the client never
 *  decides one for itself, which is what keeps a stall a measurement rather
 *  than a guess. */
const open = (over: Partial<OpenToolCall> = {}): OpenToolCall => ({
  session_id: "s1",
  source_app: "app",
  tool_name: "Edit",
  since: now - 8 * MIN,
  target: "/w/app/src/main.ts",
  evidenceKind: "target",
  liveness: "stuck",
  ...over,
});

const card = (events: WatchEvent[], openTools: OpenToolCall[] = []): AgentCard => {
  const cards = deriveAgents(events, openTools);
  expect(cards.length).toBe(1);
  return cards[0];
};

interface Case {
  name: string;
  events: WatchEvent[];
  open?: OpenToolCall[];
  status: AgentStatus;
  /** Asserted only where the run is over and the answer is the point. */
  outcome?: AgentOutcome;
}

const CASES: Case[] = [
  // ── stalled ───────────────────────────────────────────────────────────────
  {
    name: "an Edit open eight minutes whose named file never changed is stalled",
    events: [],
    open: [open()],
    status: "stalled",
  },
  {
    name: "a Read open eight minutes with the session writing nothing is stalled",
    events: [],
    // The evidence module's own reasoning: there is no such thing as a slow
    // Glob, so silence really is the answer for this class of tool.
    open: [open({ tool_name: "Read", target: null, evidenceKind: "none" })],
    status: "stalled",
  },
  // ── ...and everything it must NOT be ──────────────────────────────────────
  {
    name: "a twenty-minute call the evidence can vouch for is working, not stalled",
    events: [],
    open: [open({ since: now - 20 * MIN, liveness: "working", evidenceAt: now - 4000 })],
    status: "working",
  },
  {
    name: "a twenty-minute call nothing local can speak to is working, not stalled",
    events: [],
    // A WebFetch leaves nothing behind. `unknown` is the honest answer and is
    // rendered as one — rounding it up to a stall is the false positive that
    // cost the old five-minute timer its credibility.
    open: [open({ tool_name: "WebFetch", target: null, since: now - 20 * MIN, liveness: "unknown", evidenceKind: "none" })],
    status: "working",
  },
  {
    name: "a stuck verdict under the floor is still only working",
    events: [],
    // The server can reach `stuck` three minutes in. A red dot on a
    // three-minute call is noise, and the floor is what keeps the dot and the
    // alert saying the same thing at the same moment.
    open: [open({ since: now - 2 * MIN })],
    status: "working",
  },
  {
    name: "a session between turns has nothing open and is idle, not stalled",
    events: [ev({ hook_event_type: "Stop", tool_name: null, timestamp: now - 6 * MIN })],
    status: "idle",
    outcome: "settled",
  },
  {
    name: "a question outranks a stall — the person is what unblocks it",
    events: [ev({ hook_event_type: "PermissionRequest", tool_name: "Bash", timestamp: now - 1000 })],
    open: [open()],
    status: "waiting",
  },
  {
    name: "an error seconds ago outranks a stall — it is plainly still producing things",
    events: [ev({ hook_event_type: "PostToolUseFailure", is_error: 1, timestamp: now - 3000 })],
    open: [open()],
    status: "errored",
  },

  // ── failed ────────────────────────────────────────────────────────────────
  {
    name: "a run that stopped seconds after an error is failed, not merely over",
    events: [
      ev({ hook_event_type: "PostToolUseFailure", is_error: 1, timestamp: now - 30_000 }),
      ev({ hook_event_type: "Stop", tool_name: null, timestamp: now - 25_000 }),
    ],
    status: "failed",
    outcome: "faulted",
  },
  {
    name: "a run that went quiet mid-tool is failed",
    events: [],
    // `lost` means the CLI moved on and our Post never arrived, so the call is
    // written off; nothing else ever came, and the session is six minutes
    // silent. It died holding a tool.
    open: [open({ since: now - 6 * MIN, liveness: "lost" })],
    status: "failed",
    outcome: "faulted",
  },
  // ── ...and everything it must NOT be ──────────────────────────────────────
  {
    name: "a clean finish is idle, and stays out of the failed pile",
    events: [
      ev({ hook_event_type: "PostToolUse", timestamp: now - 40_000 }),
      ev({ hook_event_type: "Stop", tool_name: null, timestamp: now - 30_000 }),
    ],
    status: "idle",
    outcome: "settled",
  },
  {
    name: "an error the run recovered from and finished past is idle, not failed",
    // The regression the outcome axis exists to prevent, now with a status
    // attached: one early failure must not paint a session that went on to
    // finish properly.
    events: [
      ev({ hook_event_type: "PostToolUseFailure", is_error: 1, timestamp: now - 10 * MIN }),
      ev({ hook_event_type: "PostToolUse", timestamp: now - 2 * MIN }),
      ev({ hook_event_type: "Stop", tool_name: null, timestamp: now - 30_000 }),
    ],
    status: "idle",
    outcome: "settled",
  },
  {
    name: "a session that stopped on a question is idle and unanswered, never failed",
    // It wants a person, not a stack trace. Reporting it as a failure sends you
    // to read the wrong thing.
    events: [ev({ hook_event_type: "Notification", tool_name: null, timestamp: now - 10 * MIN, payload: { message: "which branch?" } })],
    status: "idle",
    outcome: "unanswered",
  },
  {
    name: "a session that simply went quiet is idle and unclear — no verdict invented",
    events: [ev({ hook_event_type: "PostToolUse", timestamp: now - 10 * MIN })],
    status: "idle",
    outcome: "unclear",
  },
];

for (const c of CASES) {
  test(c.name, () => {
    const a = card(c.events, c.open ?? []);
    expect(a.status).toBe(c.status);
    if (c.outcome) expect(a.outcome).toBe(c.outcome);
  });
}

// ---------------------------------------------------------------------------
// The dot and the alert are one fact.
//
// They used to be two computations of the same evidence, five minutes apart in
// their thresholds, and a reader who saw a green card and an angry alert about
// it had no way to tell which one was lying. `deriveAlerts` reads the status
// now, so the only way they can disagree is if somebody makes them.
// ---------------------------------------------------------------------------

const ids = (a: AgentCard, prefix: string) =>
  deriveAlerts([a]).filter((x) => x.id.startsWith(prefix));

test("a stalled card raises exactly one stall alert, and it names the reason", () => {
  const a = card([], [open()]);
  expect(a.status).toBe("stalled");
  const stuck = ids(a, "stuck:");
  expect(stuck.length).toBe(1);
  expect(stuck[0].level).toBe("error");
  // The verdict is only useful if the sentence under it can be argued with.
  expect(stuck[0].text).toContain("the file it named has not changed since it started");
  // ...and it is not also reported as the softer "could be either".
  expect(ids(a, "long:")).toEqual([]);
});

test("a call nothing can vouch for raises the soft alert and no stall alert", () => {
  const a = card([], [open({ tool_name: "WebFetch", target: null, since: now - 20 * MIN, liveness: "unknown", evidenceKind: "none" })]);
  expect(a.status).toBe("working");
  expect(ids(a, "stuck:")).toEqual([]);
  const long = ids(a, "long:");
  expect(long.length).toBe(1);
  expect(long[0].level).toBe("warn");
});

test("a healthy long call raises nothing at all", () => {
  const a = card([], [open({ since: now - 20 * MIN, liveness: "working", evidenceAt: now - 4000 })]);
  expect(a.status).toBe("working");
  expect(deriveAlerts([a])).toEqual([]);
});

test("a stalled card still says how long the call has been open", () => {
  // The duration is the most informative thing the row can carry while a call
  // is open, and promoting the status must not have swallowed it.
  const a = card([], [open()]);
  expect(a.lastAction).toContain("running Edit");
  expect(a.lastAction).toContain("no sign of life");
});

// ---------------------------------------------------------------------------
// The predicate itself, away from the ladder — the three conditions, one at a
// time, so a future edit that drops one fails here rather than in a screenshot.
// ---------------------------------------------------------------------------

const at = (over: Partial<AgentCard>): AgentCard =>
  ({ runningTool: "Edit", runningSince: now - 8 * MIN, liveness: "stuck", ...over } as AgentCard);

test("isStalled needs an open call, a stuck verdict AND the floor", () => {
  expect(isStalled(at({}), now)).toBe(true);
  expect(isStalled(at({ runningTool: null }), now)).toBe(false);        // nothing open
  expect(isStalled(at({ liveness: "working" }), now)).toBe(false);      // vouched for
  expect(isStalled(at({ liveness: "unknown" }), now)).toBe(false);      // unseeable
  expect(isStalled(at({ liveness: "lost" }), now)).toBe(false);         // our bookkeeping, not a hang
  expect(isStalled(at({ runningSince: now - 2 * MIN }), now)).toBe(false); // under the floor
});
