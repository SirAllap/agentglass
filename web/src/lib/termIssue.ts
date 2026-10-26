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

import { requestWorktreeJump } from "./worktreeJump.ts";
import type { LaunchMode } from "../../../shared/launchModes.ts";

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
  /** `haiku` / `sonnet` / `opus` and `low` / `medium` / `high`, or nothing for
   *  the CLI's own default. Names, not flags — the server owns the flags. */
  model?: string;
  effort?: string;
  /** Select the window of this exact name when it is already running, instead
   *  of starting a second one. Only for a name that stands for ONE piece of
   *  work (`conflict-1042`): a different prompt to the same name would be
   *  dropped, which is why it is asked for and not the default. */
  reuse?: boolean;
  /** Continue this Claude session instead of starting a prompt: `cwd` is where it ran. */
  resumeId?: string;
  /** The agent CLI to start, an id of shared/agentKinds.ts. Absent is Claude. */
  kind?: string;
  /** A one-off permission mode for this run, over the person's setting. The
   *  server turns it into the engine's own flags (launchperm.ts). */
  mode?: LaunchMode;
  n: number;
};

let pending: TermIssue | null = null;
/** Survives `clearTermIssue`, so a request number is never handed out twice. */
let lastN = 0;
const subs = new Set<() => void>();

export function subscribeTermIssue(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function termIssue(): TermIssue | null { return pending; }

/** What became of a request. `error` is a sentence for the person who pressed
 *  the button, never a code. */
export type IssueResult = { ok: boolean; error?: string;
  /** The window was already there and working, so it was brought to the front
   *  instead of a second one being started. */
  reused?: boolean };

const waiting = new Map<number, (r: IssueResult) => void>();

/** How long a request may sit in the slot with no terminal view to take it. */
export const TAKE_NUDGE_MS = 600;
export const UNTAKEN_MS = 6000;
/** How long the server has to answer once it was sent. */
export const UNANSWERED_MS = 10000;

/** Called by whoever learned the outcome: the server's answer, or the pane
 *  fallback. A second call for the same request is ignored. */
export function resolveTermIssue(n: number, r: IssueResult): void {
  const done = waiting.get(n);
  waiting.delete(n);
  // `n` comes off the socket; only a callback this module stored is called.
  if (typeof done === "function") done(r);
}

/** `n` increments so starting the same issue twice is two requests — otherwise
 *  closing the window and pressing Start again would look like the request that
 *  has already been served.
 *
 *  Resolves with the truth. A button used to say "Claude is on it" the moment
 *  it filled this slot, and nothing ever checked that anyone emptied it — a
 *  terminal view that was not mounted, or a server that refused, both read as
 *  success. So the answer is awaited, and silence is an answer too: after
 *  UNTAKEN_MS with the request still here nobody is listening (it is taken
 *  back, so it cannot start an agent hours later when a terminal opens), and
 *  after UNANSWERED_MS with it sent the server did not reply. */
export function requestTermIssue(cwd: string, name: string, prompt: string, agent: boolean, yolo = false, title = "", model = "", effort = "", reuse = false, kind = "", mode?: LaunchMode): Promise<IssueResult> {
  const n = ++lastN;
  pending = { cwd, name, prompt, agent, yolo, title, model, effort, reuse, ...(kind ? { kind } : {}), ...(mode ? { mode } : {}), n };
  const answered = new Promise<IssueResult>((res) => { waiting.set(n, res); });
  subs.forEach((f) => f());
  /* A view is mounted the first time it is shown, so a person who never opened
     Terminal this session has nothing listening, and the request would sit here
     until it was withdrawn. Measured in an isolated app: the conflict handoff
     from a freshly opened window never reached a socket. Bringing the view
     forward is what mounts it — the same move the review handoff makes. */
  setTimeout(() => { if (pending?.n === n) requestWorktreeJump({ view: "term" }); }, TAKE_NUDGE_MS);
  setTimeout(() => {
    if (pending?.n !== n) return;
    pending = null;
    subs.forEach((f) => f());
    resolveTermIssue(n, { ok: false, error: "the Terminal view is not open, so nothing could start it — open Terminal and press the button again" });
  }, UNTAKEN_MS);
  setTimeout(() => resolveTermIssue(n, { ok: false, error: "the terminal did not answer — check the Terminal view before pressing again" }), UNANSWERED_MS);
  return answered;
}

/** Continue a session from its transcript, in a window of its own (the terminal's `resume`). */
export function requestTermResume(cwd: string, id: string): Promise<IssueResult> {
  const n = ++lastN;
  pending = { cwd, name: "", prompt: "", agent: true, yolo: false, title: "", model: "", effort: "", reuse: false, resumeId: id, n };
  const answered = new Promise<IssueResult>((res) => { waiting.set(n, res); });
  subs.forEach((f) => f());
  setTimeout(() => { if (pending?.n === n) requestWorktreeJump({ view: "term" }); }, TAKE_NUDGE_MS);
  setTimeout(() => {
    if (pending?.n !== n) return;
    pending = null;
    subs.forEach((f) => f());
    resolveTermIssue(n, { ok: false, error: "the Terminal view is not open, so nothing could resume it — open Terminal and press the button again" });
  }, UNTAKEN_MS);
  return answered;
}

/** Cleared on send rather than on arrival, so a request made while the socket
 *  was still connecting is not silently dropped. */
export function clearTermIssue(): void {
  pending = null;
  subs.forEach((f) => f());
}
