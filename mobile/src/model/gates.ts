/*
 * What a gate waiting on you says about itself, in the words a card draws.
 *
 * A gate is an agent stopped at a tool call until somebody answers. The card
 * has three things to say and they are not the same thing: WHERE it is (the
 * checkout and the window, which the server composes because only it knows the
 * pane), WHAT it wants (the tool, as a verb), and the exact thing it wants to
 * do (the summary, which is a command line or a path and is drawn in mono).
 *
 * The Now screen drew all three as one title and a line of `source_app · the
 * agent is stopped until you answer`, which named the project and not the
 * window — on a machine with thirty worktrees of one project that identifies
 * nothing.
 */
import type { PendingGate } from "../../../shared/types.ts";

/** "orbit · 2 build", or the app that asked when the server could not say. */
export function gateWhere(g: PendingGate): string {
  return g.where?.trim() || g.source_app || "An agent";
}

const VERB: Record<string, string> = {
  Bash: "wants to run",
  Edit: "wants to edit",
  MultiEdit: "wants to edit",
  Write: "wants to write",
  NotebookEdit: "wants to edit",
  WebFetch: "wants to fetch",
  WebSearch: "wants to search",
  Read: "wants to read",
};

/** "Claude wants to run". The names in VERB are Claude Code's own tools, the
 *  ones its gate hook holds, so they can say whose ask it is; `source_app` can
 *  not — it is the project's label, not the agent's. Anything else is named
 *  after what it does, which for an MCP tool is the best there is. */
export function gateAsk(g: PendingGate): string {
  const verb = VERB[g.tool_name];
  return verb ? `Claude ${verb}` : `Wants to use ${g.tool_name}`;
}

/** The exact thing asked for, or the tool when there is no summary. */
export function gateDetail(g: PendingGate): string {
  return g.summary?.trim() || g.tool_name;
}

/** Oldest first: the agent that has waited longest is the one to answer. */
export function gatesInOrder(gates: PendingGate[]): PendingGate[] {
  return [...gates].sort((a, b) => a.created - b.created);
}

/** How long it has waited, in the one unit that matters. */
export function waited(created: number, now: number): string {
  const s = Math.max(0, Math.round((now - created) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
