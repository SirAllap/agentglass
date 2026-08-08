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
  /**
   * Start the agent with its permission prompts turned off.
   *
   * A BOOLEAN, and that is the whole design. The socket carries a flag the
   * server knows how to interpret, never the switch itself — the rule this file
   * already states is that a socket reachable from the UI must not be a way to
   * execute an arbitrary string, and "let the client name a command-line
   * argument" is that rule with extra steps.
   *
   * Worth having because the alternative is worse in practice: a card handed to
   * an agent that then stops on its first tool call is an agent nobody notices
   * has stopped. Worth being a choice because the same setting on the wrong
   * card is an agent editing files nobody asked it to.
   */
  yolo?: boolean;
  /**
   * What to call the agent's session — the card's own title.
   *
   * Data, not a command, like everything else on this bus: the server decides
   * that a title becomes `--name` and sanitises it, and a client that sends
   * nothing simply gets an unnamed session. Sent because a tmux window name is
   * an id (`orbit-21025`, so `tmux ls` is readable) and this is the sentence —
   * they answer different questions and neither replaces the other.
   */
  title?: string;
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
export function requestTermIssue(cwd: string, name: string, prompt: string, agent: boolean, yolo = false, title = ""): void {
  pending = { cwd, name, prompt, agent, yolo, title, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}

/** Cleared on send rather than on arrival, so a request made while the socket
 *  was still connecting is not silently dropped. */
export function clearTermIssue(): void {
  pending = null;
  subs.forEach((f) => f());
}
