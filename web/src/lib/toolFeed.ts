// What a folded turn of tool calls says about itself.
//
// Kept apart from the component for the same reason `toolTree` is: this is the
// part with rules — what the fold is allowed to hide and what it must not — and
// rules are worth testing without a DOM to render them into.
import type { ChatTool } from "./chatStore.ts";

export interface ToolFeedSummary {
  /** How many calls the turn made. */
  n: number;
  /** How many of them came back an error. A folded failure is worse than no
   *  fold at all, so this always reaches the summary line. */
  failed: number;
  /** The call to show while the turn is still running: the most recent one. */
  latest: ChatTool | null;
}

export function toolFeedSummary(tools: ChatTool[]): ToolFeedSummary {
  return {
    n: tools.length,
    failed: tools.reduce((k, t) => k + (t.error ? 1 : 0), 0),
    latest: tools.length ? tools[tools.length - 1] : null,
  };
}

/** One line describing a call, written the way the expanded row writes it:
 *  `Tool(what it acted on)`. A command can be a whole script, and only its
 *  first line identifies the run. */
export function toolLabel(t: ChatTool): string {
  const target = (t.target ?? "").split("\n")[0];
  return target ? `${t.name}(${target})` : t.name;
}
