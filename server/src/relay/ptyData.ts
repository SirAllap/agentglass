// The socket's per-connection facts, built in ONE place for both doors: the
// in-process upgrade at /terminal/pty and a connection the relay redeemed. Two
// copies of this list is how a flag gets honoured on one door and not the other.
// Type-only import: nothing here runs terminal.ts.
import type { PtyWsData } from "../terminal.ts";
import type { TicketFacts } from "./wire.ts";

export function ptyDataFrom(q: URLSearchParams, f: TicketFacts & { local: boolean; deviceId: string | null }): PtyWsData & { ip?: string | null; deviceId?: string | null } {
  return {
    kind: "pty",
    /* The authenticated principal, never the header a caller chooses to send:
       an agent's credential must strip the shell even when it leaves
       `x-agentglass-agent` off. */
    worker: f.worker,
    principal: f.principal,
    local: f.local,
    deviceId: f.deviceId,
    root: q.get("root") || "",
    // A path to open, not a command to run. Validated in ptyOpen against the
    // same scope rule the directory gets.
    view: q.get("view") || undefined,
    // A number, bounded here so a URL cannot ask for a line that is not one.
    line: Math.min(Math.max(Number(q.get("line")) || 0, 0), 10_000_000),
    // Editing is asked for explicitly. Absent, the file opens read-only.
    edit: q.get("edit") === "1",
    // A live tmux pane to show instead of a new shell. Tmux's own id only.
    pane: q.get("pane") || undefined,
    // A single-use ticket for an agent to start in this pane. Opaque id.
    agent: q.get("agent") || undefined,
    fit: q.get("fit") === "1",
    fresh: q.get("fresh") === "1",
    console: q.get("console") === "1",
    // A small number the client keeps; the server turns it into a window name.
    bench: Math.min(Math.max(Number(q.get("bench")) || 0, 0), 99) || undefined,
    note: q.get("note") === "1",
    cols: Number(q.get("cols") || 80),
    rows: Number(q.get("rows") || 24),
    ip: f.ip,
  };
}
