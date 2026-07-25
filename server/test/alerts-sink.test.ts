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
let clientsPresent = true;

beforeAll(async () => {
  // Fresh instance so its module-level `DESKTOP = AGENTGLASS_NOTIFY === "1"` is
  // read with the env set above, even if another test already imported alerts.ts
  // (bun shares the module registry across the suite).
  alerts = await import(`../src/alerts.ts?u=${Math.random()}`);
  alerts.setAlertSink({ broadcast: (a) => broadcasts.push(a), hasClients: () => clientsPresent });
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
    broadcasts = []; fallbacks = []; clientsPresent = true;
    alerts.pushGate("app:sess1", "Bash", "ls fixture-one");
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].title).toContain("Approval");
    expect(broadcasts[0].urgency).toBe(2);
    expect(broadcasts[0].body).toContain("Bash");
    expect(fallbacks.length).toBe(0); // the client showed it; no notify-send
  });

  test("with no client attached, it does NOT broadcast — notify-send gets it instead", () => {
    broadcasts = []; fallbacks = []; clientsPresent = false;
    alerts.pushGate("app:sess2", "Bash", "ls fixture-two");
    expect(broadcasts.length).toBe(0);
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0].title).toContain("Approval");
    expect(fallbacks[0].body).toContain("ls fixture-two");
  });

  test("an agent notification is normal urgency; a tool error is critical", () => {
    broadcasts = []; fallbacks = []; clientsPresent = true;
    alerts.maybeAlert({ hook_event_type: "Notification", session_id: "s-notif", source_app: "app", payload: { message: "heads up" } } as any);
    alerts.maybeAlert({ hook_event_type: "PostToolUse", is_error: 1, session_id: "s-err", source_app: "app", tool_name: "Bash", error_text: "boom", payload: {} } as any);
    expect(broadcasts.map((b) => b.urgency).sort()).toEqual([1, 2]);
  });
});
