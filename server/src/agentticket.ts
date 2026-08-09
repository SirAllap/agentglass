/*
 * Starting an agent in a terminal that has no tmux.
 *
 * The buttons that send a pull request, an issue or a card to an agent all went
 * one way: `cmd:"issue"` over the terminal socket, which opens a tmux window
 * running the agent. Without a tmux client under the shell the request was
 * dropped by the client before it was sent and again by the server if it
 * arrived — twice silent, and on macOS unconditionally, since the detection
 * only ever read /proc. The detection is portable now (procchildren.ts); this
 * is the other half, for a machine with no tmux at all.
 *
 * A pane is what a tmux-less terminal has instead of a window, and the panel
 * already knows how to open one. What it could not do is open one RUNNING
 * something: a PTY session is opened by a websocket, and the three things it
 * could already be — a shell, a file in an editor, an existing tmux pane — are
 * all named by short query parameters.
 *
 * A prompt is not short. It is a card's description or a review brief, which is
 * kilobytes, and a URL is the wrong place for it — the limit is unspecified, it
 * lands in logs, and it is the query string of a GET.
 *
 * So the prompt is handed over first, on an authenticated POST, and the socket
 * carries a ticket. That keeps the rule this endpoint has always followed and
 * which the file-viewer states plainly: the client says WHAT, the server
 * decides HOW. The client never names a binary or a flag — it passes text and a
 * boolean, exactly as it already does over the tmux socket.
 */
import { randomBytes } from "node:crypto";

export interface AgentRequest {
  /** The worktree to start in. Validated by the caller against the open
   *  project before it is ever stored — a ticket is not a way around scope. */
  cwd: string;
  /** What the agent is started with. Empty means a plain shell, which is what
   *  the tmux path does too. */
  prompt: string;
  /** Permission prompts off. A BOOLEAN, and the flag it buys is written here:
   *  a socket reachable from the UI must not be able to name an argument. */
  yolo: boolean;
  /** The session name, already through `sessionTitle`. */
  title: string;
}

/**
 * Short, because a ticket is not a secret worth keeping — it is a nonce that
 * lives for seconds behind an endpoint that already required a token to mint.
 * Long enough that guessing one inside its lifetime is not a thing to think
 * about.
 */
const ID_BYTES = 18;

/**
 * How long a ticket is good for.
 *
 * The gap it has to cover is one websocket opening, which is milliseconds on
 * the same machine. A minute is generous for a browser that was mid-repaint,
 * and short enough that an abandoned request is not sitting in memory when
 * somebody comes back an hour later.
 */
const TTL_MS = 60_000;

/** A ceiling, so a bug upstream cannot turn this into an unbounded store. Far
 *  above what a person produces: these are minted one press at a time. */
const MAX = 64;

const pending = new Map<string, { at: number; req: AgentRequest }>();

const sweep = (now: number): void => {
  for (const [id, v] of pending) if (now - v.at > TTL_MS) pending.delete(id);
};

export function mintAgentTicket(req: AgentRequest, now = Date.now()): string {
  sweep(now);
  // Oldest first, and only when full. A press that evicts somebody else's
  // pending press is worse than a refusal, but at 64 outstanding tickets the
  // thing that has gone wrong is not somebody pressing buttons.
  if (pending.size >= MAX) {
    const oldest = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) pending.delete(oldest[0]);
  }
  const id = randomBytes(ID_BYTES).toString("base64url");
  pending.set(id, { at: now, req });
  return id;
}

/**
 * Take a ticket, once.
 *
 * Single use rather than merely expiring: the socket that claims it is the one
 * that opens the pane, and a ticket that could be claimed twice is a way to
 * start the same agent twice from one press — which, in a worktree, is two
 * agents editing the same files.
 */
export function claimAgentTicket(id: string, now = Date.now()): AgentRequest | null {
  sweep(now);
  const held = pending.get(String(id || ""));
  if (!held) return null;
  pending.delete(id);
  return now - held.at > TTL_MS ? null : held.req;
}

/** For a test's own teardown, and so one suite cannot leave a ticket for the
 *  next. */
export function __clearAgentTickets(): void { pending.clear(); }

/**
 * The command line an agent request becomes.
 *
 * Here rather than at either call site because there are now two — a tmux
 * window and a plain pane — and they must not drift. The whole point of this
 * change is that the two paths do the same thing; building the argv twice is
 * how they would stop.
 *
 * Empty when there is no agent binary, and the callers read that as "open a
 * plain shell in the worktree": no agent available is not a reason to open
 * nothing, since a shell in the right tree is still most of what was asked for.
 */
export function agentArgv(
  bin: string | null | undefined,
  req: { prompt: string; yolo: boolean; title: string },
  canName: boolean,
): string[] {
  if (!bin) return [];
  // `--name` is what `/rename` writes, set before the first turn rather than
  // typed into a program that may not have finished starting. The value is data
  // from the client and the flag is ours — the same division as the permission
  // flag below.
  const named = req.title && canName ? ["--name", req.title] : [];
  const skip = req.yolo ? ["--dangerously-skip-permissions"] : [];
  // The prompt is LAST and is one element. Never split, never through a shell:
  // a review brief contains quotes, newlines and backticks, and every one of
  // them is text.
  return [bin, ...named, ...skip, req.prompt];
}
