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
  ErrorStreaks, ERROR_STREAK, lanternStep, lanternState, REMIND_MS, NO_SCREEN,
  type LanternFinding, type Screen,
} from "../src/notePolicy.ts";
import { parseClientPanes } from "../src/tmuxctl.ts";

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

  test("a turn that ends on a failure is said; one that ends after recovering is not", () => {
    const s = new ErrorStreaks();
    s.note(post("a", 1, "Edit"));
    expect(s.note({ hook_event_type: "Stop", session_id: "a" })).toMatchObject({ kind: "stopped", tool: "Edit" });
    s.note(post("b", 1));
    s.note(post("b", 0));
    expect(s.note({ hook_event_type: "Stop", session_id: "b" })).toBeNull();
  });

  test("a streak already said is not said again when the turn ends", () => {
    const s = new ErrorStreaks();
    for (let i = 0; i < ERROR_STREAK; i++) s.note(post("a", 1));
    expect(s.note({ hook_event_type: "Stop", session_id: "a" })).toBeNull();
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

  test("urgency: critical only when something new is blocked", () => {
    expect(lanternStep([left("a", "%1")], lanternState(), NOW)).toMatchObject({ act: "announce", urgency: 1 });
    expect(lanternStep([forgotten("a", "%1")], lanternState(), NOW)).toMatchObject({ act: "announce", urgency: 1 });
    expect(lanternStep([blocked("a", "%1")], lanternState(), NOW)).toMatchObject({ act: "announce", urgency: 2 });
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

  test("a pane on screen is not announced; a blocked one only when its terminal has focus", () => {
    const shown: Screen = { shown: new Set(["%3", "%4"]), focused: new Set() };
    expect(lanternStep([left("orch", "%3")], lanternState(), NOW, shown).act).toBe("none");
    expect(lanternStep([forgotten("w", "%4")], lanternState(), NOW, shown).act).toBe("none");
    expect(lanternStep([blocked("b", "%3")], lanternState(), NOW, shown).act, "shown behind another window is not seen").toBe("announce");
    const focused: Screen = { shown: new Set(["%3"]), focused: new Set(["%3"]) };
    expect(lanternStep([blocked("b", "%3")], lanternState(), NOW, focused).act).toBe("none");
  });

  test("looking away from a pane that was on screen makes it news", () => {
    const st = lanternState();
    const f = [left("orch", "%3")];
    expect(lanternStep(f, st, NOW, { shown: new Set(["%3"]), focused: new Set() }).act).toBe("none");
    expect(lanternStep(f, st, NOW + 15 * MIN, NO_SCREEN).act).toBe("announce");
  });

  test("the panes it names are all of them, for the client's own focus check", () => {
    const step = lanternStep([left("a", "%1"), forgotten("b", "%2"), { kind: "gone", name: "c", since: NOW }], lanternState(), NOW);
    expect(step).toMatchObject({ act: "announce", panes: ["%1", "%2"] });
  });
});

describe("which pane is on screen", () => {
  test("list-clients' pane and focus flag", () => {
    const shown = new Set<string>(), focused = new Set<string>();
    parseClientPanes("%2\tattached,focused,UTF-8\n%7\tattached,UTF-8\n\nnot-a-pane\tfocused", shown, focused);
    expect([...shown]).toEqual(["%2", "%7"]);
    expect([...focused]).toEqual(["%2"]);
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
  alerts.setScreenProbe(null);
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

  test("a waiting prompt in a pane on screen is not sent at all; a permission there with focus is silent", async () => {
    const { notePaneAgent } = await import("../src/panewt.ts");
    notePaneAgent({ pane: "%81", sessionId: "noise-c", transcriptPath: "/tmp/noise-c.jsonl", cwd: "/home/u/code/orbit" });
    alerts.setScreenProbe(() => ({ shown: new Set(["%81"]), focused: new Set(["%81"]) }));
    frames = [];
    alerts.maybeAlert(ev({ hook_event_type: "Notification", session_id: "noise-c", payload: { message: "Claude is waiting for your input" } }));
    alerts.maybeAlert(ev({ hook_event_type: "Notification", session_id: "noise-c", payload: { message: "Claude needs your permission to use Bash" } }));
    expect(frames.map((f) => f.urgency)).toEqual([0]);
    alerts.setScreenProbe(() => NO_SCREEN);
    frames = [];
    alerts.maybeAlert(ev({ hook_event_type: "Notification", session_id: "noise-c", payload: { message: "Claude needs your permission to use Edit" } }));
    expect(frames.map((f) => f.urgency), "off screen it interrupts as before").toEqual([2]);
  });

  test("the Lantern: announce, then silence, then an in-place redraw, then a clear", () => {
    alerts.__resetLanternMemory();
    alerts.setScreenProbe(() => NO_SCREEN);
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
