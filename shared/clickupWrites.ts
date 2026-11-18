/*
 * Whether ClickUp may be WRITTEN to for a repository.
 *
 * With Jira connected, ClickUp is the fallback for the pull requests that only
 * ever named a ClickUp id, and a fallback is read-only until the person says
 * otherwise for a repository: the card of an old pull request must not be
 * moved by somebody whose work has moved on.
 *
 * Shared because the panel and the server answer the same question, and a
 * panel that hides a control the server would allow (or the other way round)
 * is the worse of both answers. The server asks it per write; the panel asks it
 * to decide what to draw.
 */

/** What a refused write says, on both sides. One sentence, so a person who saw
 *  the panel and then a refusal reads the same thing twice. */
export const CLICKUP_READ_ONLY = "ClickUp is read-only on this repository. Turn it on in Settings > Tasks > Card tracker > ClickUp changes.";

/** The sentence to show, or null when writes are allowed. */
export function clickupReadOnly(args: {
  jiraConnected: boolean;
  /** The repository's own tracker choice. */
  choice: "auto" | "clickup" | "jira";
  /** The repository's ClickUp-writes switch, from Settings. */
  writesOn?: boolean;
}): string | null {
  if (!args.jiraConnected) return null;
  if (args.choice === "clickup") return null;
  if (args.writesOn) return null;
  return CLICKUP_READ_ONLY;
}
