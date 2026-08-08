// agentglass's own push alerts reach a connected client so it can raise a
// NATIVE OS notification — the cross-platform replacement for notify-send, which
// only exists on Linux (#192). The server still owns the opt-in and the
// triggers; notify-send stays as the fallback when nothing is attached to show
// it. These pin the routing: broadcast when a client is present, not when it
// isn't, and the right urgency per alert kind.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AlertNote } from "../../shared/types.ts";

const NOTIFY0 = process.env.AGENTGLASS_NOTIFY;
const HOOK0 = process.env.AGENTGLASS_WEBHOOK;
process.env.AGENTGLASS_NOTIFY = "1"; // read at import → the desktop branch is live
delete process.env.AGENTGLASS_WEBHOOK; // no outbound fetch during the test
afterAll(() => {
  if (NOTIFY0 === undefined) delete process.env.AGENTGLASS_NOTIFY; else process.env.AGENTGLASS_NOTIFY = NOTIFY0;
  if (HOOK0 === undefined) delete process.env.AGENTGLASS_WEBHOOK; else process.env.AGENTGLASS_WEBHOOK = HOOK0;
});

let alerts: typeof import("../src/alerts.ts");
let broadcasts: AlertNote[] = [];
let fallbacks: AlertNote[] = [];
/** What the sink says about the sockets it holds. `attached` decides who gets
 *  the frame; `live` decides whether anybody was actually told. */
let census = { attached: 1, live: 1 };

beforeAll(async () => {
  // Fresh instance so its module-level `DESKTOP = AGENTGLASS_NOTIFY === "1"` is
  // read with the env set above, even if another test already imported alerts.ts
  // (bun shares the module registry across the suite).
  alerts = await import(`../src/alerts.ts?u=${Math.random()}`);
  alerts.setAlertSink({ broadcast: (a) => broadcasts.push(a), census: () => census });
  // Captures the notify-send fallback instead of running it. Without this the
  // no-client test spawned a REAL desktop notification, so anyone running the
  // suite got "✋ Approval needed — wants to run Bash: rm -rf …" from a hold
  // that did not exist. alerts.ts also refuses to spawn under NODE_ENV=test;
  // this seam is what lets the path still be asserted.
  alerts.setDesktopNotifier((a) => fallbacks.push(a));
});

describe("desktop alert routing", () => {
  // Fixture summaries are deliberately inert. They end up in the text of a
  // real "Approval needed" alert the moment anything stops stubbing delivery,
  // and `rm -rf <path>` in that position is alarming enough to be acted on.
  test("with a client attached, a gate hold broadcasts a critical native alert", () => {
    broadcasts = []; fallbacks = []; census = { attached: 1, live: 1 };
    alerts.pushGate("app:sess1", "Bash", "ls fixture-one");
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].title).toContain("Approval");
    expect(broadcasts[0].urgency).toBe(2);
    expect(broadcasts[0].body).toContain("Bash");
    expect(fallbacks.length).toBe(0); // the client showed it; no notify-send
  });

  test("with no client attached, it does NOT broadcast — notify-send gets it instead", () => {
    broadcasts = []; fallbacks = []; census = { attached: 0, live: 0 };
    alerts.pushGate("app:sess2", "Bash", "ls fixture-two");
    expect(broadcasts.length).toBe(0);
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0].title).toContain("Approval");
    expect(fallbacks[0].body).toContain("ls fixture-two");
  });

  /*
   * The one that dropped an alert and left no trace.
   *
   * A phone in a pocket that Android has frozen is ATTACHED and not LISTENING:
   * the socket is half-open, `ws.send()` returns the byte count without
   * throwing, and nothing closes. Measured on this serve config, that state
   * held for 120.1 seconds — and for all of it `clients.size > 0` was the whole
   * test for "somebody was told", so the gate hold went into a frozen socket
   * and the desk was never touched.
   *
   * Both halves are asserted, because either one alone is a different bug: the
   * frame must STILL be broadcast (a frozen peer delivers its backlog when it
   * thaws — measured, 4 frames queued during a 60s freeze all arrived 570ms
   * after it resumed), and notify-send must ALSO fire.
   */
  test("attached but deaf: the frame still goes out AND notify-send fires", () => {
    broadcasts = []; fallbacks = []; census = { attached: 1, live: 0 };
    alerts.pushGate("app:sess3", "Bash", "ls fixture-three");
    expect(broadcasts.length).toBe(1);
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0].body).toContain("ls fixture-three");
  });

  /** And the guard against over-correcting: one live client among several deaf
   *  ones is still somebody being told, so the desk is not woken twice. */
  test("one live client among the deaf ones suppresses the fallback", () => {
    broadcasts = []; fallbacks = []; census = { attached: 3, live: 1 };
    alerts.pushGate("app:sess4", "Bash", "ls fixture-four");
    expect(broadcasts.length).toBe(1);
    expect(fallbacks.length).toBe(0);
  });

  test("an agent notification is normal urgency; a tool error is critical", () => {
    broadcasts = []; fallbacks = []; census = { attached: 1, live: 1 };
    alerts.maybeAlert({ hook_event_type: "Notification", session_id: "s-notif", source_app: "app", payload: { message: "heads up" } } as any);
    alerts.maybeAlert({ hook_event_type: "PostToolUse", is_error: 1, session_id: "s-err", source_app: "app", tool_name: "Bash", error_text: "boom", payload: {} } as any);
    expect(broadcasts.map((b) => b.urgency).sort()).toEqual([1, 2]);
  });
});
