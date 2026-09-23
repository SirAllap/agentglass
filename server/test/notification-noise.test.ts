// What the server no longer says, rule by rule.
//
// Replays the shapes a desk of agents actually produces — a failing grep that
// recovers, a streak that does not, the Lantern looking every fifteen minutes
// at the same two sessions — and asserts on the frames that would reach the
// client. The pure rules are in notePolicy.ts; the last block drives them
// through alerts.ts with the sink seam, so the wiring is held too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AlertNote } from "../../shared/types.ts";
import {
  ErrorStreaks, ERROR_STREAK, STOP_QUIET_MS, lanternStep, lanternState, REMIND_MS,
  type LanternFinding,
} from "../src/notePolicy.ts";

const post = (session: string, is_error: 0 | 1, tool = "Bash") =>
  ({ hook_event_type: "PostToolUse", session_id: session, is_error, tool_name: tool, error_text: is_error ? "exit code 1" : null });

describe("failed tool calls", () => {
  test("one failure, then a success, is not news", () => {
    const s = new ErrorStreaks();
    expect(s.note(post("a", 1))).toBeNull();
    expect(s.note(post("a", 0))).toBeNull();
    expect(s.note(post("a", 1))).toBeNull();
    expect(s.note({ hook_event_type: "UserPromptSubmit", session_id: "a" })).toBeNull();
  });

  test("a streak is said once, at the threshold, and a success ends it", () => {
    const s = new ErrorStreaks();
    const out = Array.from({ length: ERROR_STREAK + 3 }, () => s.note(post("a", 1)));
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(out[ERROR_STREAK - 1]).toMatchObject({ kind: "streak", count: ERROR_STREAK, tool: "Bash" });
    s.note(post("a", 0));
    const again = Array.from({ length: ERROR_STREAK }, () => s.note(post("a", 1)));
    expect(again.filter(Boolean), "a new streak after a success is a new episode").toHaveLength(1);
  });

  test("streaks are per session: two agents failing alternately do not add up", () => {
    const s = new ErrorStreaks();
    const out = [post("a", 1), post("b", 1), post("a", 0), post("b", 0), post("a", 1), post("b", 1)].map((e) => s.note(e));
    expect(out.every((x) => x === null)).toBe(true);
  });

  test("a turn that ends on a failure is said once it has been quiet; one that recovered is not", () => {
    const s = new ErrorStreaks();
    s.note(post("a", 1, "Edit"), 0);
    expect(s.note({ hook_event_type: "Stop", session_id: "a" }, 1_000)).toBeNull();
    expect(s.settle("a", 1_000 + STOP_QUIET_MS - 1), "not before the quiet period").toBeNull();
    expect(s.settle("a", 1_000 + STOP_QUIET_MS)).toMatchObject({ kind: "stopped", tool: "Edit" });
    expect(s.settle("a", 1_000 + 2 * STOP_QUIET_MS), "said once").toBeNull();
    s.note(post("b", 1), 0);
    s.note(post("b", 0), 1);
    s.note({ hook_event_type: "Stop", session_id: "b" }, 2);
    expect(s.settle("b", 2 + STOP_QUIET_MS)).toBeNull();
  });

  test("the scanner's mid-turn Stop — a thinking line after a failure — is not the end of a turn", () => {
    // The transcript scanner emits a Stop for every assistant line without a
    // tool call, and a thinking block is its own line: fail, "Stop", then the
    // agent carries on. Measured, that is what follows about half of failures.
    const s = new ErrorStreaks();
    s.note(post("a", 1), 0);
    s.note({ hook_event_type: "Stop", session_id: "a" }, 500);
    s.note({ hook_event_type: "PreToolUse", session_id: "a", tool_name: "Bash" }, 3_000);
    expect(s.settle("a", 500 + STOP_QUIET_MS)).toBeNull();
    s.note(post("a", 0), 4_000);
    expect(s.settle("a", 60_000)).toBeNull();
  });

  test("a mid-turn Stop does not reset a streak in the making", () => {
    const s = new ErrorStreaks();
    s.note(post("a", 1), 0);
    s.note({ hook_event_type: "Stop", session_id: "a" }, 1);
    s.note({ hook_event_type: "PreToolUse", session_id: "a" }, 2);
    s.note(post("a", 1), 3);
    s.note({ hook_event_type: "Stop", session_id: "a" }, 4);
    s.note({ hook_event_type: "PreToolUse", session_id: "a" }, 5);
    expect(s.note(post("a", 1), 6)).toMatchObject({ kind: "streak", count: ERROR_STREAK });
  });

  test("a streak already said is not said again when the turn ends", () => {
    const s = new ErrorStreaks();
    for (let i = 0; i < ERROR_STREAK; i++) s.note(post("a", 1), i);
    s.note({ hook_event_type: "Stop", session_id: "a" }, 10);
    expect(s.settle("a", 10 + STOP_QUIET_MS)).toBeNull();
  });
});

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const blocked = (name: string, pane: string, since = NOW - 5 * MIN): LanternFinding =>
  ({ kind: "waiting", name, pane, since });
const left = (name: string, pane: string, since = NOW - 70 * MIN): LanternFinding =>
  ({ kind: "waiting", name, pane, since, left: true });
const forgotten = (name: string, pane: string, since = NOW - 90 * MIN): LanternFinding =>
  ({ kind: "forgotten", name, pane, since });

describe("the Lantern's card", () => {
  test("the same findings, look after look, are said once", () => {
    const st = lanternState();
    const f = [left("orbit-api", "%3"), forgotten("orbit-web", "%4")];
    const acts = [0, 15, 30, 45, 60].map((m) => lanternStep(f, st, NOW + m * MIN).act);
    expect(acts).toEqual(["announce", "none", "none", "none", "none"]);
  });

  test("urgency is the card's standing level: critical while anything in it is blocked", () => {
    expect(lanternStep([left("a", "%1")], lanternState(), NOW)).toMatchObject({ act: "announce", urgency: 1 });
    expect(lanternStep([forgotten("a", "%1")], lanternState(), NOW)).toMatchObject({ act: "announce", urgency: 1 });
    expect(lanternStep([blocked("a", "%1")], lanternState(), NOW)).toMatchObject({ act: "announce", urgency: 2 });
    // A forgotten claim turning up next to a blocked agent does not demote the
    // card, and the blocked one resolving does.
    const st = lanternState();
    lanternStep([blocked("a", "%1")], st, NOW);
    expect(lanternStep([blocked("a", "%1"), forgotten("b", "%2")], st, NOW + MIN)).toMatchObject({ act: "announce", urgency: 2 });
    expect(lanternStep([forgotten("b", "%2")], st, NOW + 2 * MIN)).toMatchObject({ act: "update", urgency: 1 });
  });

  test("a blocked session is reminded once after the cooldown, and never a third time", () => {
    const st = lanternState();
    const f = [blocked("orbit-api", "%3")];
    expect(lanternStep(f, st, NOW).act).toBe("announce");
    expect(lanternStep(f, st, NOW + REMIND_MS - MIN).act).toBe("none");
    expect(lanternStep(f, st, NOW + REMIND_MS)).toMatchObject({ act: "announce", urgency: 2 });
    expect(lanternStep(f, st, NOW + 3 * REMIND_MS).act).toBe("none");
  });

  test("a prompt left open is not reminded — it is not stopped on a question", () => {
    const st = lanternState();
    const f = [left("orbit-api", "%3")];
    lanternStep(f, st, NOW);
    expect(lanternStep(f, st, NOW + 5 * REMIND_MS).act).toBe("none");
  });

  test("something new next to something old announces; a finding going away redraws silently", () => {
    const st = lanternState();
    lanternStep([left("a", "%1")], st, NOW);
    expect(lanternStep([left("a", "%1"), blocked("b", "%2")], st, NOW + 15 * MIN)).toMatchObject({ act: "announce", urgency: 2 });
    expect(lanternStep([left("a", "%1")], st, NOW + 30 * MIN).act).toBe("update");
  });

  test("the card clears when everything resolved, and the next episode is news again", () => {
    const st = lanternState();
    lanternStep([blocked("a", "%1")], st, NOW);
    expect(lanternStep([], st, NOW + 15 * MIN).act).toBe("clear");
    expect(lanternStep([], st, NOW + 30 * MIN).act).toBe("none");
    expect(lanternStep([blocked("a", "%1", NOW + 40 * MIN)], st, NOW + 45 * MIN).act).toBe("announce");
  });

  test("the panes it names are all of them", () => {
    const step = lanternStep([left("a", "%1"), forgotten("b", "%2"), { kind: "gone", name: "c", since: NOW }], lanternState(), NOW);
    expect(step).toMatchObject({ act: "announce", panes: ["%1", "%2"] });
  });
});

// ── through alerts.ts ──────────────────────────────────────────────────────

const HOOK0 = process.env.AGENTGLASS_WEBHOOK;
const NOTIFY0 = process.env.AGENTGLASS_NOTIFY;
delete process.env.AGENTGLASS_WEBHOOK;
let alerts: typeof import("../src/alerts.ts");
let frames: AlertNote[] = [];
let census = { attached: 1, live: 1 };
beforeAll(async () => {
  // Read at import: the desktop fallback is live, and asserted on below.
  process.env.AGENTGLASS_NOTIFY = "1";
  alerts = await import(`../src/alerts.ts?noise=${Math.random()}`);
  alerts.setAlertSink({ broadcast: (a) => frames.push(a), census: () => census });
  alerts.setDesktopNotifier(() => {});
});
afterAll(() => {
  alerts.setAlertSink(null);
  alerts.setDesktopNotifier(null);
  if (HOOK0 !== undefined) process.env.AGENTGLASS_WEBHOOK = HOOK0;
  if (NOTIFY0 === undefined) delete process.env.AGENTGLASS_NOTIFY; else process.env.AGENTGLASS_NOTIFY = NOTIFY0;
});

describe("the frames that reach the client", () => {
  const ev = (o: Record<string, unknown>) => ({ source_app: "orbit", payload: {}, ...o }) as any;

  test("a burst of failures in one session is one keyed card, not one per failure", () => {
    frames = [];
    for (let i = 0; i < 8; i++) alerts.maybeAlert(ev({ hook_event_type: "PostToolUse", session_id: "noise-a", is_error: 1, tool_name: "Bash", error_text: "exit code 1" }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ urgency: 1, key: "errors:noise-a" });
    expect(frames[0]!.title).toContain("Keeps failing");
  });

  test("\"waiting for your input\" is a silent row", () => {
    frames = [];
    alerts.maybeAlert(ev({ hook_event_type: "Notification", session_id: "noise-b", payload: { message: "Claude is waiting for your input" } }));
    expect(frames.map((f) => f.urgency)).toEqual([0]);
  });

  test("the Lantern: announce, then silence, then an in-place redraw, then a clear", () => {
    alerts.__resetLanternMemory();
    const notice = (f: LanternFinding[]) => ({ title: `🔦 Lantern: ${f.length}`, body: f.map((x) => x.name).join("\n") });
    frames = [];
    const two = [blocked("orbit-api", "%1"), left("orbit-web", "%2")];
    alerts.pushLanternFindings(two, notice, NOW);
    alerts.pushLanternFindings(two, notice, NOW + 15 * MIN);
    alerts.pushLanternFindings([left("orbit-web", "%2")], notice, NOW + 30 * MIN);
    alerts.pushLanternFindings([], notice, NOW + 45 * MIN);
    expect(frames.map((f) => [f.urgency, f.key, f.update ?? false, f.clear ?? false])).toEqual([
      [2, "lantern", false, false],
      [1, "lantern", true, false],
      [0, "lantern", false, true],
    ]);
  });

  test("a client that attaches later is told the card as it stands, or that there is none", () => {
    alerts.__resetLanternMemory();
    expect(alerts.lanternSnapshot()).toMatchObject({ key: "lantern", clear: true });
    const notice = (f: LanternFinding[]) => ({ title: `🔦 Lantern: ${f.length}`, body: f.map((x) => x.name).join("\n"), pane: "%1" });
    alerts.pushLanternFindings([blocked("orbit-api", "%1")], notice, NOW);
    expect(alerts.lanternSnapshot()).toMatchObject({ key: "lantern", update: true, urgency: 2, title: "🔦 Lantern: 1", pane: "%1" });
    alerts.pushLanternFindings([], notice, NOW + MIN);
    expect(alerts.lanternSnapshot()).toMatchObject({ key: "lantern", clear: true });
  });

  test("a redraw and a clear never reach the desktop fallback", () => {
    alerts.__resetLanternMemory();
    const fell: AlertNote[] = [];
    alerts.setDesktopNotifier((a) => fell.push(a));
    census = { attached: 1, live: 0 };
    const notice = (f: LanternFinding[]) => ({ title: "t", body: f.map((x) => x.name).join(",") });
    alerts.pushLanternFindings([left("a", "%1"), left("b", "%2")], notice, NOW);
    alerts.pushLanternFindings([left("a", "%1")], notice, NOW + MIN);
    alerts.pushLanternFindings([], notice, NOW + 2 * MIN);
    expect(fell).toHaveLength(1);
    census = { attached: 1, live: 1 };
    alerts.setDesktopNotifier(() => {});
  });
});
