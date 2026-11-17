/*
 * One question, asked by two screens: is this row something to ANSWER (a gate,
 * a settings request, a plan waiting for Go), or something that HAPPENED (a
 * review asked, a watch fired, an agent stopped)?
 *
 * It lives in model/ rather than in the list so the section a row is drawn
 * under and the segment that filters it cannot disagree — the Inbox used to
 * decide "decision" in the list's own filter table, which is fine until a
 * second screen wants the same split and writes a second predicate.
 */
import type { InboxItem } from "./inbox.ts";

export const denotesDecision = (item: InboxItem): boolean =>
  item.source === "gate" || item.source === "settings" || item.source === "plan";
