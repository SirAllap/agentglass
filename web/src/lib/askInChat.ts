/**
 * "Ping in chat": whether the section is drawn, and how often we ask.
 *
 * It used to hide behind the ClickUp card, so a pull request with no card, or a
 * machine with no tracker at all, had no way to ask a colleague for a review
 * even with Slack connected to the agent. What decides it now is the agent's
 * reach and nothing else; the card only fills `{card}` in the wording.
 */

/** Drawn when the agent on this machine can post to a chat. `card` is accepted
 *  and ignored on purpose: the day somebody adds it to the condition, the test
 *  that passes `{slack: true, card: false}` goes red. */
export function askInChatVisible(x: { slack: boolean; card: boolean }): boolean {
  return x.slack;
}

/** How long one answer is kept. Somebody connects the integration without
 *  restarting agentglass, so it is not for ever; but every pull request opened
 *  in the next minute does not need to ask the server again either. */
export const REACH_TTL_MS = 60_000;

let kept: { at: number; slack: boolean } | null = null;

/** The answer from `ask`, reusing one younger than the TTL. A failure is
 *  "no" and is not kept, so the next pull request tries again. */
export async function slackReach(
  ask: () => Promise<{ slack?: boolean } | null | undefined>,
  now: number = Date.now(),
): Promise<boolean> {
  if (kept && now - kept.at < REACH_TTL_MS) return kept.slack;
  try {
    const slack = !!(await ask())?.slack;
    kept = { at: now, slack };
    return slack;
  } catch {
    return false;
  }
}

/** For tests: forget the kept answer. */
export function forgetSlackReach(): void { kept = null; }
