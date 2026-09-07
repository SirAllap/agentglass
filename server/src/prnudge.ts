/*
 * A NUDGE FOR A PULL REQUEST — the sentence you would type in chat, written
 * for you, sent for you when a channel is configured.
 *
 * "A nudge over Slack, straight from the card": a pull request waiting on somebody is
 * chased in a chat, by hand, by copying its link and remembering who was
 * asked. The card knows both. This composes the line — who it waits on, what
 * for, where — copies it to the clipboard in the client, and, when
 * AGENTGLASS_WEBHOOK points at a channel (the same one the alerts use), posts
 * it there too. No new credential, no new integration: the webhook is the one
 * outbound channel this app has, and a nudge is one more line down it.
 */
import type { PrDetail } from "../../shared/types.ts";
import { webhookDestination } from "./egress.ts";

export function nudgeText(d: Pick<PrDetail, "number" | "title" | "url" | "humanReview" | "reviewers" | "isDraft">): string {
  const v = d.humanReview;
  const who = (v?.kind === "awaiting" && v.who?.length) ? v.who : (d.reviewers ?? []).map((r) => r.login);
  const at = who.length ? who.map((w) => `@${w}`).join(" ") + " " : "";
  const ask = d.isDraft ? "is a draft still — a look when it is ready?"
    : v?.kind === "changes" ? "has the changes you asked for — could you take another look?"
    : v?.kind === "approved" && v.stale ? "has moved since your approval — could you re-check?"
    : v?.kind === "commented" ? "has your comments answered — could you give it a verdict?"
    : "is waiting for your review";
  return `${at}PR #${d.number} "${d.title}" ${ask}\n${d.url}`;
}

export function nudgeChannel(): { configured: boolean } {
  return { configured: webhookDestination().configured };
}

export async function sendNudge(text: string): Promise<{ sent: boolean; error?: string }> {
  const channel = webhookDestination();
  if (!channel.configured) return { sent: false, error: channel.error };
  try {
    const r = await fetch(channel.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    return r.ok ? { sent: true } : { sent: false, error: `the channel said ${r.status}` };
  } catch (e) {
    return { sent: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
