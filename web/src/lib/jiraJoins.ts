/*
 * What a Jira card is joined to, as plain decisions the pane draws from: which
 * ways a link can read, the sentence that says what a link would do before it
 * is made, which of the card's links a write just made, and what an address or
 * a sub-task title must be before anything is sent. The same rules the server
 * holds (server/src/jiraRelate.ts); here they only keep a mistake from costing
 * a request.
 *
 * A link has a side. "ORBIT-1042 blocks ORBIT-1050" and "ORBIT-1042 is blocked
 * by ORBIT-1050" are two different links of one type, so the picker offers each
 * phrase of each type, and a type whose two phrases are the same ("relates to")
 * once.
 */
import type { JiraLinkKind } from "./api.ts";
import type { CardLinked } from "../../../shared/providers.ts";
import { hasUrlCredentials } from "../../../shared/urlCredentials.ts";

export interface LinkWay { value: string; typeId: string; /** This card holds the outward phrase. */ outward: boolean; phrase: string; kind: string }

/** Every way a card can be linked to another, in the order the site lists its types. */
export function linkWays(kinds: readonly JiraLinkKind[]): LinkWay[] {
  const out: LinkWay[] = [];
  for (const k of kinds) {
    out.push({ value: `${k.id}:out`, typeId: k.id, outward: true, phrase: k.outward, kind: k.name });
    if (k.inward !== k.outward) out.push({ value: `${k.id}:in`, typeId: k.id, outward: false, phrase: k.inward, kind: k.name });
  }
  return out;
}

/** "ORBIT-1042 blocks ORBIT-1050": what the link would be, said before it is made and after. */
export const linkEffect = (card: string, way: Pick<LinkWay, "phrase">, other: string): string => `${card} ${way.phrase} ${other}`;

/** The link a write just made, among the card's links as read back: the other card, the type and the side. */
export function madeLink(linked: readonly CardLinked[] | undefined, other: string, way: Pick<LinkWay, "kind" | "outward">): CardLinked | undefined {
  return (linked ?? []).find((l) => (l.task.customId ?? l.task.id) === other && l.type === way.kind && l.direction === (way.outward ? "out" : "in"));
}

export const parseSubtaskTitle = (raw: string): { ok: boolean; error?: string } =>
  !raw.trim() ? { ok: false, error: "A sub-task needs a title" } : /[\r\n]/.test(raw) ? { ok: false, error: "A title is one line" } : raw.trim().length > 255 ? { ok: false, error: "At most 255 characters" } : { ok: true };

const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
export const parseCardId = (raw: string): { ok: boolean; error?: string } =>
  KEY.test(raw.trim()) ? { ok: true } : { ok: false, error: "A card id, like ORBIT-1042" };

/** A web address a person may follow: `http` or `https`, no password in it. Null for anything else. */
export function webAddress(raw: string): string | null {
  if (raw.length > 2000) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  return (u.protocol === "https:" || u.protocol === "http:") && !hasUrlCredentials(u) && !!u.hostname ? u.href : null;
}
export const parseWebAddress = (raw: string): { ok: boolean; error?: string } =>
  webAddress(raw) ? { ok: true } : { ok: false, error: "An address starting with http:// or https://" };

/** A card that is itself a sub-task cannot have one. */
export const canHaveSubtasks = (issueType: string | undefined): boolean => !/sub-?task/i.test(issueType ?? "");
