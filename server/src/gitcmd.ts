import { setTimeoutAs } from "./loopwatch.ts";

/**
 * A Bash tool call that runs a mutating git verb changed the repo behind the
 * terminal's git pill. The server only broadcasts {type:"git"} for git work it
 * runs itself, so an agent's own `git commit` waited for the pill's 20 s backstop.
 */
const VERBS = "commit|checkout|switch|merge|rebase|reset|pull|stash|cherry-pick|revert|branch|tag|add|restore|rm|mv";
// `git` as a word, optional global flags (-C dir, -c k=v, --no-pager), then a verb.
const GIT_MUTATES = new RegExp(`(?:^|[\\s;&|(\`])git(?:\\s+-{1,2}[\\w-]+(?:[ =]\\S+)?)*\\s+(?:${VERBS})(?![\\w-])`);

export function runsMutatingGit(ev: { hook_event_type: string; tool_name: string | null; payload?: unknown }): boolean {
  if (ev.hook_event_type !== "PostToolUse" || ev.tool_name !== "Bash") return false;
  const cmd = (ev.payload as { tool_input?: { command?: unknown } } | null)?.tool_input?.command;
  return typeof cmd === "string" && GIT_MUTATES.test(cmd);
}

/** At most one send per `ms`: the first goes now, calls inside the window collapse into one at its end. */
export function coalesce(
  send: () => void, ms = 500,
  now: () => number = Date.now,
  later: (fn: () => void, ms: number) => unknown = (fn, d) => setTimeoutAs("git poke coalesce", fn, d),
): () => void {
  let last = -Infinity;
  let pending = false;
  const fire = () => { last = now(); pending = false; send(); };
  return () => {
    if (pending) return;
    const wait = last + ms - now();
    if (wait <= 0) fire();
    else { pending = true; later(fire, wait); }
  };
}

/** The one reaction to a repo change: drop the caches first, then tell clients, so their re-read never hits a pre-change answer. */
export function gitChange(clear: () => void, send: () => void): () => void {
  return () => { clear(); send(); };
}
