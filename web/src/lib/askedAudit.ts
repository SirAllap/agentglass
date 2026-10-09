import type { AskedAlert } from "../../../shared/notifyPayload.ts";

/** Where an alert the person asked for stands: waiting on them, opened (acted on), or closed without opening. */
export function askedState(a: AskedAlert): "waiting" | "opened" | "closed" {
  if (a.closedAt === null) return "waiting";
  return a.actedAt !== null ? "opened" : "closed";
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "fired 10:42 · seen 10:42 · opened 10:51" — only the steps that happened. */
export function askedTimeline(a: AskedAlert): string {
  const parts = [`fired ${hhmm(a.firedAt)}`];
  if (a.seenAt !== null) parts.push(`seen ${hhmm(a.seenAt)}`);
  if (a.actedAt !== null) parts.push(`opened ${hhmm(a.actedAt)}`);
  else if (a.closedAt !== null) parts.push(`closed ${hhmm(a.closedAt)}`);
  return parts.join(" · ");
}
