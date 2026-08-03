// Which tools a chat may run without asking.
//
// Its own module so the rule can be tested: importing it from the panel drags
// in the API client, which wants a `location` that a test process does not
// have.

const BEFORE_PR_DIFF = "Read Glob Grep Bash(git status) Bash(git log:*) Bash(git diff:*) Bash(gh pr view:*)";

/** A starting point that covers the reading and inspection an assistant reaches
 *  for constantly, without granting anything that writes or leaves the machine.
 *
 *  `gh pr diff` sits beside `gh pr view` because "Review with Claude" asks for
 *  it by name: without it the one command carrying the change was refused while
 *  the prompt told the agent to run it. Both only read. The write-shaped `gh`
 *  verbs — `pr comment`, `pr review`, `pr merge` — are absent, and stay
 *  refused. */
export const ALLOW_DEFAULT = `${BEFORE_PR_DIFF} Bash(gh pr diff:*)`;

/**
 * The list to start from, honouring what was saved.
 *
 * A saved list wins, or changing the default would be pointless. But the panel
 * writes the list back on every render, so somebody who has never opened the
 * field still has yesterday's default written down — which makes "change the
 * default" a no-op on every install that already exists, and is exactly how a
 * prompt came to ask for a command the allowlist refused.
 *
 * So one string is upgraded: the previous default, untouched. Anything else is
 * a decision somebody made, and quietly adding a tool to it would be a grant
 * nobody issued.
 */
export function initialAllowed(saved: string | null): string {
  if (saved === null) return ALLOW_DEFAULT;
  return saved.trim() === BEFORE_PR_DIFF ? ALLOW_DEFAULT : saved;
}
