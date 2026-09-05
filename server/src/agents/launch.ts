/*
 * How each agent on the roster is STARTED in a terminal.
 *
 * This is a different question from the one paneagent.ts asks, and the two are
 * deliberately not the same file. `PaneAgent` is the contract the chat engine
 * needs — where the transcript is, what an end of turn looks like, which entry
 * types reach the browser — and only Claude Code can currently answer it,
 * because only Claude Code writes a structured transcript this app knows how to
 * read. Everything here needs far less: a binary, and the handful of words that
 * binary wants on its command line. A tmux window running a CLI interactively
 * does not care whether anybody can parse what it writes.
 *
 * That gap is why "a run leg names its own agent" did not work before this
 * file existed. `startRun` already took a roster id per leg and already
 * resolved it to a binary — and then built the command line with `agentArgv`,
 * which spells the permission flag `--dangerously-skip-permissions` because
 * that is Claude Code's spelling. Handed to `codex` that is an unknown flag,
 * and an unknown flag does not degrade: the CLI prints usage and exits, so the
 * window opens, flashes and closes. A two-vendor run would have produced one
 * working leg and one that looked like tmux was broken.
 *
 * The spellings below are not invented here. Each one is already written down
 * somewhere in this server, against a CLI somebody ran:
 * `--dangerously-skip-permissions` in claudecode.ts and agentticket.ts,
 * `--dangerously-bypass-approvals-and-sandbox` in codex.ts, and Antigravity's
 * own `--dangerously-skip-permissions` in antigravity.ts. What is new is that
 * they sit in one table keyed by the same roster id the rest of the app uses,
 * instead of being a Claude constant that three call sites reach for.
 *
 * And they are still ASKED rather than trusted, for the reason claudecode.ts
 * gives about `--name`: the answer is a property of whichever version happens
 * to be on this machine, and getting it wrong costs the window rather than a
 * feature. One `--help` per binary per process is a cheap way never to hand a
 * CLI a word it will refuse to start with.
 */
import { ROSTER } from "../agentprobe.ts";
import { agentArgv } from "../agentticket.ts";
import { supportsSessionName } from "./claudecode.ts";

/** The roster id of the agent every path here defaults to. Named rather than
 *  written out at each call site, so "which agent is this?" is a variable that
 *  can be lifted later instead of a string that has to be found again. */
export const CLAUDE_CODE = "claude-code";

/**
 * The agents a caller may name, resolved to a binary here and nowhere else.
 *
 * Same division every other spawner in this server makes: the client sends an
 * ID out of a closed set and the server decides what that means on a command
 * line. `ROSTER` rather than a list of our own because it is already the
 * machine's answer to "which agents exist" — the requirements panel reads it,
 * the hook installer reads it, and a run that could start something the rest of
 * the app has never heard of is a run whose legs nothing else can describe.
 */
export function agentBin(id: unknown): string | null {
  const entry = ROSTER.find((a) => a.id === id);
  return entry ? Bun.which(entry.bin) : null;
}

/** What one vendor's CLI wants said to it when a window opens running it. */
export interface CliSpelling {
  /**
   * The single flag that turns permission prompts off.
   *
   * One flag, and it is the server's word rather than the client's — the same
   * rule agentticket.ts states: a socket reachable from the UI sends a boolean
   * and never an argument.
   */
  bypass: string;
  /**
   * The flag that carries the prompt when a bare positional argument would run
   * the CLI headlessly instead of opening it.
   *
   * Empty means positional, which is Claude Code's form, Codex's, and what
   * every path in this server did before this file existed. It is also the
   * FALLBACK when the flag below cannot be confirmed on this machine, and that
   * is deliberate: a flag we can prove is an improvement on the shipped
   * behaviour, and a flag we cannot prove must degrade back to it rather than
   * to some third thing nobody has run.
   */
  promptFlag: string;
}

export const SPELLINGS: Record<string, CliSpelling> = {
  // claudecode.ts and agentticket.ts, and the path everything shipped on.
  [CLAUDE_CODE]: { bypass: "--dangerously-skip-permissions", promptFlag: "" },
  // codex.ts:codexArgs, where the same flag drives the `full-access` sandbox.
  // The interactive form takes the prompt as a positional; `codex exec --json`
  // is the streaming form the chat panel drives and would fill a tmux pane with
  // JSON instead of a TUI.
  codex: { bypass: "--dangerously-bypass-approvals-and-sandbox", promptFlag: "" },
  // The Gemini CLI answers a bare positional non-interactively and exits, so
  // the prompt goes through the flag that keeps the TUI up. Both words are
  // probed before they are used — this is the entry with the least evidence
  // behind it in this repo, and the probe is what makes that safe rather than
  // hopeful: an unrecognised flag is dropped and the leg still opens.
  gemini: { bypass: "--yolo", promptFlag: "-i" },
  // antigravity.ts:antigravityArgs, same spelling as Claude's by that CLI's own
  // choice. Its `-p` is the print-and-exit form the chat panel drives and is
  // deliberately NOT listed as the prompt flag: sending a run's leg through it
  // would answer once and close the window. Positional is what is left, and it
  // is the form every other path here already uses.
  antigravity: { bypass: "--dangerously-skip-permissions", promptFlag: "" },
};

/**
 * Does this binary admit to knowing this flag?
 *
 * Generalised from `supportsSessionName` in claudecode.ts, which asks the same
 * question about `--name` and gives the reasoning: a capability check costs one
 * `--help` per process, and a wrong guess costs a window that opens, prints a
 * usage error and closes.
 *
 * Cached for the life of the process, keyed by binary and flag together —
 * different vendors are different binaries and must not answer for each other.
 * Somebody who upgrades a CLI mid-session gets the old answer until the app
 * restarts, which is the right trade against running `--help` per leg.
 */
const known = new Map<string, boolean>();
export function supportsFlag(bin: string, flag: string): boolean {
  // A NUL separator, written as an escape rather than as a raw byte: neither a
  // path nor a flag can contain one, so the key cannot be forged by a name that
  // happens to hold the delimiter. The literal byte does the same job and makes
  // the line invisible to grep, which is what source-hygiene.test.ts refuses.
  const key = `${bin}\u0000${flag}`;
  const cached = known.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const r = Bun.spawnSync([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    // Help text is written for people, so the flag can be followed by a comma,
    // a space, an `=` or the end of a line. A word boundary is enough, and
    // anchoring on more would start reporting a supported flag as missing.
    ok = new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
      r.stdout.toString() + r.stderr.toString(),
    );
  } catch { /* an unreadable binary is one that does not take the flag */ }
  known.set(key, ok);
  return ok;
}

/** For a suite that needs to ask twice, or with a different fake binary. */
export function __resetFlagProbes(): void { known.clear(); }

/**
 * The command line that starts one agent, in one checkout, on one prompt.
 *
 * The default is the shipped path and is deliberately byte-identical to it:
 * no agent named, or Claude Code named, hands straight to `agentArgv`, which
 * keeps `--name`, the permission flag and the rule about never passing an empty
 * positional argument in the one place both terminal paths already share. This
 * is an extension of that builder rather than a second one — a run's legs are
 * the only reason a second vendor's spelling is needed at all, and the day
 * agentticket.ts gains an agent field it delegates here instead.
 *
 * `--name` is not offered to the others. It is Claude Code's flag, and a run is
 * the one place where the binary on the other end is deliberately not always
 * Claude Code; the tmux window is named after the leg's branch anyway, which is
 * what tells the legs apart in a window list.
 *
 * Empty when there is no binary, which every caller reads as "open a plain
 * shell in the checkout": no agent available is not a reason to open nothing,
 * since a shell in the right tree is still most of what was asked for.
 */
export function launchArgv(
  agent: string,
  bin: string | null | undefined,
  req: { prompt: string; yolo: boolean; title: string },
  knows: (bin: string, flag: string) => boolean = supportsFlag,
): string[] {
  if (!bin) return [];
  const id = agent || CLAUDE_CODE;
  // The probe is asked only when its answer can matter. `--name` is used for a
  // title and a run's legs have none, so asking would spend a `--help` per leg
  // to decide a flag that is not going to be passed either way.
  if (id === CLAUDE_CODE) return agentArgv(bin, req, req.title ? supportsSessionName(bin) : false);
  const spell = SPELLINGS[id];
  // A roster entry with no spelling written down yet. It still gets a window in
  // the right checkout and the run's question, positionally — but no permission
  // flag, because every spelling we have belongs to some other vendor and
  // putting one of those on this binary is the failure this file exists to
  // prevent.
  if (!spell) return req.prompt ? [bin, req.prompt] : [bin];
  const skip = req.yolo && knows(bin, spell.bypass) ? [spell.bypass] : [];
  // The flag when this binary confirms it, a bare positional otherwise. The
  // fallback is the shipped behaviour rather than a second guess — dropping the
  // question would leave a leg that opened in the right checkout and never
  // asked anything, which is a comparison arm that quietly measures nothing.
  const seed = !req.prompt
    ? []
    : spell.promptFlag && knows(bin, spell.promptFlag)
      ? [spell.promptFlag, req.prompt]
      : [req.prompt];
  // The prompt LAST and as one element, never split and never through a shell —
  // the rule agentticket.ts states at length, and for the same reason: a run's
  // question contains quotes, newlines and backticks, and every one of them is
  // text.
  return [bin, ...skip, ...seed];
}
