/**
 * Which tmux pane an alert should take you to.
 *
 * Split out of NeedsPopover.tsx rather than left beside its only caller,
 * because the component reaches api.ts on import and api.ts reads `location` —
 * so a test that imports the panel to check this decision dies before the first
 * assertion. Every other web test in this repo imports from lib/ for the same
 * reason, and this is the decision worth testing: the panel around it is a list
 * and four buttons.
 */
import type { AgentPane } from "../../../shared/types.ts";

/**
 * The panes running an agent in a directory.
 *
 * Measured, not assumed: on the machine this was built against there are five
 * agents in one project directory and three in another, so "which pane" often
 * has no single answer this way. One hit is a button; more is a fact worth
 * stating rather than a choice worth guessing at.
 */
export const panesForCwd = (panes: AgentPane[], cwd: string | null): AgentPane[] =>
  cwd ? panes.filter((p) => p.agentCwds.includes(cwd)) : [];

/**
 * Where to send this alert, exact answer first.
 *
 * The directory match was the only join available when the panel was built, and
 * it is a guess: it has to decline whenever two agents share a worktree, which
 * is a working day rather than an edge case. It no longer has to. Claude Code's
 * hooks carry the pane they fired from, panewt.ts records pane → session on
 * every event, and `/terminal/panes` now says which session each pane is
 * running — so an alert about a session that reported a pane has one right
 * answer and no need for a row of maybes.
 *
 * The fallback stays. An agent started outside a hook-wired CLI never reports a
 * pane, and it should not lose the behaviour it had.
 */
export function paneChoices(panes: AgentPane[], it: { sessionId: string; cwd: string | null }): {
  /** The pane that session is in, when it said so and the pane is still open. */
  exact: AgentPane | null;
  /** Candidates by directory. Empty once `exact` is known — offering both would
   *  be asking the user to choose between an answer and a coin flip. */
  hits: AgentPane[];
} {
  const exact = it.sessionId ? panes.find((p) => p.agentSession === it.sessionId) ?? null : null;
  return exact ? { exact, hits: [] } : { exact: null, hits: panesForCwd(panes, it.cwd) };
}
