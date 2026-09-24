/*
 * `alertKind` — which of the seven notification kinds a fleet alert is, pure.
 *
 * The one case worth a comment is `wait:` from a `PermissionRequest` event:
 * `becauseOf` (derive.ts) renders that as "wants to run Bash" or "wants your
 * approval", text `kindOfNotification`'s regex was never written to catch —
 * it is already the real block, not a message to classify. Getting this one
 * wrong would mean the one alert the diet defaults to interrupting for stops
 * doing so the moment it arrives as a permission request instead of a
 * `Notification` event, which derive.ts's own comment says is the live path
 * (`Notification` is the dead one, kept only because it once fired).
 */
import { describe, expect, test } from "bun:test";
import { alertKind, type Alert, type AgentCard } from "../src/lib/derive.ts";

function agent(over: Partial<AgentCard> = {}): AgentCard {
  return {
    key: "k", source_app: "app", session_id: "s", model_name: null,
    status: "waiting", outcome: "unclear", lastAction: "", lastType: "",
    events: 0, tools: 0, errors: 0, toolErrors: 0, cost: 0, tokens: 0, turnCost: 0,
    lastSeen: 0, lastErrorTs: 0, spark: new Array(20).fill(0),
    subagents: 0, subagentTypes: [], needBecause: "", cwd: null, project: null,
    runningTool: null, runningSince: 0, evidenceAt: null, evidenceKind: "none",
    liveness: "unknown", ctxTokens: 0, ctxTs: 0, ctxLimit: 0, worktree: null, risks: [],
    ...over,
  };
}

function alert(over: Partial<Alert> = {}): Alert {
  return { id: "wait:k", level: "warn", agent: "k", text: "waiting for approval / input", ts: 0, ...over };
}

describe("alertKind", () => {
  test("a wait: alert from a real permission request is blocked, whatever needBecause says", () => {
    const a = agent({ lastType: "PermissionRequest", needBecause: "wants to run Bash" });
    expect(alertKind(alert(), a)).toBe("blocked");
  });

  test("a wait: alert from a Notification is classified by its text", () => {
    const a = agent({ lastType: "Notification", needBecause: "Claude needs your permission to use Bash" });
    expect(alertKind(alert(), a)).toBe("blocked");
    const idle = agent({ lastType: "Notification", needBecause: "Claude is waiting for your input" });
    expect(alertKind(alert(), idle)).toBe("idle");
  });

  test("stuck: is always stalled", () => {
    expect(alertKind(alert({ id: "stuck:k" }), agent())).toBe("stalled");
  });

  test("rate: is always failures", () => {
    expect(alertKind(alert({ id: "rate:k" }), agent())).toBe("failures");
  });

  test("an alert with no matching agent card falls back to the alert's own text", () => {
    expect(alertKind(alert({ text: "Usage limit reset — Claude is continuing your task" }), undefined)).toBe("usage");
  });
});
