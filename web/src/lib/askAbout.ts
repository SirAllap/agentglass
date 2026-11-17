import { api } from "./api.ts";
/* The one way the "Ask about this" button starts a session: a new tab of the default engine in `cwd`, seeded. The seeds are in askSeed.ts. */
import { sendToTerminal, windowNameFor } from "./sendToTerminal.ts";
import type { IssueResult } from "./termIssue.ts";
import type { AskSeed } from "./askSeed.ts";

/** The one way the button starts the session: a new tab of the default engine in `cwd`, seeded. */
export function askAbout(cwd: string, seed: AskSeed): Promise<IssueResult> {
  return sendToTerminal(cwd, seed.prompt, `ask-${seed.title}`, "ask", undefined, seed.subject ?? `machine:${windowNameFor(seed.title)}`);
}

/** The folder a panel with no project of its own opens the tab in: the instance's workspace, else the first project the server knows. Only read here; the server builds every path after it. */
export async function askDir(): Promise<string> {
  const p = await api.projects();
  return p.workspace ?? p.projects[0]?.path ?? "";
}
