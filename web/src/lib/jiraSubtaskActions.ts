/*
 * What the list's sub-task bar does: make a sub-task under a card (the site's own create, through the server), and hand the open
 * sub-tasks to the terminal, each in the checkout a live session names for the card or, failing that, its parent.
 */
import type { ProviderTask } from "../../../shared/providers.ts";
import type { AgentCard } from "./derive.ts";
import { api } from "./api.ts";
import { sendPrompt } from "./cardDetailMenu.ts";
import { rootFor } from "./jiraCardWork.ts";
import { forgetJiraSubtasks } from "./jiraSubtasks.ts";
import { sendToTerminal, sentNote } from "./sendToTerminal.ts";

const keyOf = (t: Pick<ProviderTask, "customId" | "id">): string => t.customId ?? t.id;

export async function addSubtask(parentKey: string, title: string): Promise<{ ok: boolean; text: string }> {
  const t = title.trim();
  if (!t) return { ok: false, text: "Give the sub-task a title" };
  try {
    const r = await api.jiraSubtask(parentKey, t);
    if (r.ok) { forgetJiraSubtasks(); return { ok: true, text: r.created ? `Created ${r.created}` : "Sub-task created" }; }
    return { ok: false, text: r.error ?? "Jira did not create it" };
  } catch { return { ok: false, text: "Could not reach the server" }; }
}

/** One terminal window per open sub-task. A sub-task with no checkout known is counted as skipped, never guessed. */
export async function sendOpenSubtasks(parent: ProviderTask, kids: readonly ProviderTask[], agents: readonly AgentCard[]): Promise<{ ok: boolean; text: string }> {
  const open = kids.filter((k) => k.statusKind !== "done");
  let sent = 0; let skipped = 0;
  for (const k of open) {
    const root = rootFor(keyOf(k), agents) ?? rootFor(keyOf(parent), agents);
    if (!root) { skipped++; continue; }
    const r = await sendToTerminal(root, sendPrompt(k), keyOf(k));
    if (sentNote(r, keyOf(k)).ok) sent++; else skipped++;
  }
  return { ok: sent > 0, text: `${sent} sent to the terminal${skipped ? `, ${skipped} with no checkout known` : ""}` };
}
