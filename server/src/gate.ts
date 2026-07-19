// Control plane: a PreToolUse gate. An opt-in hook long-polls POST /gate with a
// pending tool call; agentglass holds it open until a human approves/denies from
// the dashboard (or a timeout auto-allows). This is the remote for the fleet.
//
// Safety: default-allow on timeout, and the hook exits 0 (allow) if agentglass
// is unreachable — the control plane never blocks agents by accident.
import type { PendingGate } from "../../shared/types.ts";
import { pushGate } from "./alerts.ts";
export type GateDecision = "allow" | "deny";

interface Waiter extends PendingGate {
  resolve: (d: { decision: GateDecision; reason: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

// The gate is fail-open by design: a timeout (or an unreachable server) never
// blocks an agent. Set this to invert that — a tool call that no human decides
// within the timeout is DENIED. Opt-in, because it means a slow or absent human
// stops the fleet; that is the point for security-sensitive use.
const FAIL_CLOSED = process.env.AGENTGLASS_GATE_FAILCLOSED === "1";

// The clamp is a DoS guard (each waiter pins a held connection + timer), but a
// hard 120s silently defeated the documented AGENTGLASS_GATE_TIMEOUT knob: an
// operator asking for a 5-minute approval window got auto-resolved at 2. The
// operator's own configured timeout now raises the ceiling.
export const GATE_MAX_MS = Math.max(120_000, (Number(process.env.AGENTGLASS_GATE_TIMEOUT) || 60) * 1000);

const waiters = new Map<string, Waiter>();
let onChange: () => void = () => {};
export function onGateChange(fn: () => void) { onChange = fn; }

/** Hold a tool call until decided or the timeout auto-allows. */
export function submitGate(
  req: { source_app: string; session_id: string; tool_name: string; summary: string },
  timeoutMs: number
): Promise<{ decision: GateDecision; reason: string }> {
  // Floor the timeout: a negative value (a repo-local settings.json can set
  // AGENTGLASS_GATE_TIMEOUT=-1) makes setTimeout fire immediately, turning the
  // gate into an instant auto-allow. Never below 1s, never above 2min.
  const wait = Math.max(1000, Math.min(GATE_MAX_MS, Number.isFinite(timeoutMs) ? timeoutMs : 60_000));
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      waiters.delete(id);
      onChange();
      if (FAIL_CLOSED) {
        resolve({ decision: "deny", reason: "gate timeout — no decision (fail-closed)" });
        return;
      }
      // Empty reason so the hook falls through to Claude Code's own permission
      // prompt instead of force-allowing — an auto-allow shouldn't silently
      // skip the human it was meant to ask.
      resolve({ decision: "allow", reason: "" });
    }, wait);
    waiters.set(id, { id, ...req, created: Date.now(), resolve, timer });
    pushGate(`${req.source_app}:${req.session_id.slice(0, 8)}`, req.tool_name, req.summary);
    onChange();
  });
}

export function decideGate(id: string, decision: GateDecision, reason: string): boolean {
  const w = waiters.get(id);
  if (!w) return false;
  clearTimeout(w.timer);
  waiters.delete(id);
  w.resolve({ decision, reason: reason || (decision === "deny" ? "denied from dashboard" : "approved from dashboard") });
  onChange();
  return true;
}

export function pendingGates(): PendingGate[] {
  return [...waiters.values()]
    .map(({ id, source_app, session_id, tool_name, summary, created }) => ({ id, source_app, session_id, tool_name, summary, created }))
    .sort((a, b) => a.created - b.created);
}
