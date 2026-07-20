// Folding a flat timeline back into the shape the agent actually ran in.
//
// Subagent turns report the *parent's* session id, so a fleet of them lands on
// one flat list: an `Explore` that spawned 111 tool calls arrives as 111 rows
// wedged between the main thread's own, and reading it means reconstructing in
// your head which of them belonged to what. The CLI never shows it that way —
// it shows `Explore(why it was spawned)` with its work nested underneath and
// the tail folded behind `… +N tool uses`. This rebuilds that.
import type { TimelineEntry } from "../../../shared/types.ts";

/** Tools whose whole purpose is to start a subagent. A row for one of these is
 *  the natural place to hang that subagent's work. */
const SPAWN_TOOLS = new Set(["Task", "Agent", "Explore"]);

export type Row =
  | { kind: "message"; e: TimelineEntry; key: string }
  | { kind: "tool"; e: TimelineEntry; children: TimelineEntry[]; key: string };

/**
 * Group a chronological timeline into top-level rows, with each subagent's
 * entries nested under the call that spawned it.
 *
 * Binding is by arrival, not by id: `agent_id` is claude's own id for the
 * sidechain and has no link back to the `tool_use_id` of the Task that started
 * it, so there is nothing to join on. The first agent to report is matched to
 * the earliest spawn still waiting for one — right for the sequential case, and
 * a coin flip only when several were started in the same turn, where the worst
 * outcome is two sibling subagents labelled as each other. A subagent whose
 * spawn we never saw (it aged out of the window, or the session was already
 * running when we attached) still gets a row of its own rather than being
 * scattered through the main thread.
 */
export function buildRows(entries: TimelineEntry[]): Row[] {
  const rows: Row[] = [];
  const byAgent = new Map<string, Row & { kind: "tool" }>();
  const unclaimed: (Row & { kind: "tool" })[] = [];

  entries.forEach((e, i) => {
    const agent = e.agent_id || "";
    if (agent) {
      let host = byAgent.get(agent);
      if (!host) {
        host = unclaimed.shift();
        if (!host) {
          // No spawn to hang this on — stand the subagent up as its own row so
          // its work still reads as one unit.
          host = {
            kind: "tool",
            e: { kind: "tool", ts: e.ts, tool: e.agent_type || "subagent", target: null },
            children: [],
            key: `a${agent}`,
          };
          rows.push(host);
        }
        byAgent.set(agent, host);
      }
      host.children.push(e);
      return;
    }
    if (e.kind === "tool") {
      const row: Row & { kind: "tool" } = { kind: "tool", e, children: [], key: `t${i}` };
      rows.push(row);
      if (SPAWN_TOOLS.has(e.tool ?? "")) unclaimed.push(row);
      return;
    }
    rows.push({ kind: "message", e, key: `m${i}` });
  });

  return rows;
}
