/*
 * "Send this prompt to a terminal session of the default engine in this
 * checkout": a tmux window on the engine with the person's default agent CLI
 * started on it, reused when the same work already has one.
 *
 * Every hand-off that used to open the Chat view goes through here, so the
 * answer to "where did it go" is always the Terminal view and no button decides
 * for itself which CLI to start. The prompt is the one the button always built.
 *
 * The default engine is the one Settings > Orchestration gives the Builder role
 * (there is no separate "default engine" setting). The SERVER resolves it, in
 * issueArgv, for every hand-off that names no engine: the buttons that go through
 * requestTermIssue directly and the review socket included, so none of them can
 * start Claude by itself.
 */
import { requestTermIssue, requestTermResume, type IssueResult } from "./termIssue.ts";

/** A tmux window name for one piece of work: letters, digits, dashes, bounded. */
export function windowNameFor(title: string): string {
  return title.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

/** Start (or reuse) a session of the default engine in `cwd` with `prompt`. `title` names the work and the window. */
export async function sendToTerminal(cwd: string, prompt: string, title: string, kind?: string): Promise<IssueResult> {
  // No engine named: the server starts the person's default (agentticket.ts issueArgv).
  return requestTermIssue(cwd, windowNameFor(title), prompt, true, false, title, "", "", true, kind ?? "");
}

/** Continue a Claude session from its transcript in a window of its own (only Claude has this). */
export function resumeInTerminal(cwd: string, sessionId: string): Promise<IssueResult> {
  return requestTermResume(cwd, sessionId);
}

/** The sentence a button flashes after `sendToTerminal`. */
export function sentNote(done: IssueResult, what: string): { ok: boolean; text: string } {
  return done.ok
    ? { ok: true, text: done.reused ? `${what} already has its tab open — switched to it` : `${what} is waiting in a pane` }
    : { ok: false, text: `Not started: ${done.error}` };
}
