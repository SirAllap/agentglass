// "Open a tmux window in this worktree, and put this in it."
//
// A one-slot request, the same shape as the pull-request review's — and for the
// same reason. The issues panel cannot reach the terminal's websocket, and the
// terminal view may not even be mounted when the button is pressed. The request
// is left here, the shell switches to the terminal, and it is sent the moment
// there is a socket to send it on.
//
// The panel sends a DIRECTORY and a PROMPT, never a command. What actually runs
// is decided by the server (see terminal.ts), which is the same rule the review
// flow follows: a socket reachable from the UI must not be a way to execute an
// arbitrary string.

export type TermIssue = {
  /** The worktree the window opens in. */
  cwd: string;
  /** The window's name — `i455`, so it is findable in a tmux list. */
  name: string;
  /** What the agent should be started with. Empty means a plain shell. */
  prompt: string;
  /** Start an agent at all. False opens the shell and nothing else. */
  agent: boolean;
  n: number;
};

let pending: TermIssue | null = null;
const subs = new Set<() => void>();

export function subscribeTermIssue(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function termIssue(): TermIssue | null { return pending; }

/** `n` increments so starting the same issue twice is two requests — otherwise
 *  closing the window and pressing Start again would look like the request that
 *  has already been served. */
export function requestTermIssue(cwd: string, name: string, prompt: string, agent: boolean): void {
  pending = { cwd, name, prompt, agent, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}

/** Cleared on send rather than on arrival, so a request made while the socket
 *  was still connecting is not silently dropped. */
export function clearTermIssue(): void {
  pending = null;
  subs.forEach((f) => f());
}
