/**
 * Which pull request a card's row chip names, when the card has more than
 * one.
 *
 * A card worked on for a while collects several: a draft opened first, closed
 * again, then the real one. The row has room for one chip, so it has to pick,
 * and "most recently opened" is not "most worth showing" — a merged pull
 * request from last week is not what the row should lead with over the open
 * one from this morning. Open work wins, then a draft in progress, then what
 * already landed, then what did not. Ties within a state are broken by pull
 * request number, which is the only ordering `clickup/prs` gives this card:
 * the endpoint that lists them does not carry `updatedAt`, and asking GitHub
 * for it would be the per-row round trip this chip exists to avoid — see
 * cardPrStore.ts.
 */

import type { PrCheckRollup } from "../../../shared/types.ts";
import { inkFor } from "./contrast.ts";
import { prAddress } from "../../../shared/taskref.ts";

export interface CardPr {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  url: string;
  author?: string;
  mine?: boolean;
  /** Whose it is: see `CardPr` in shared/providers.ts. Absent means own, which
   *  is what every pull request was before the server said otherwise. */
  link?: "own" | "mention";
  /** For a mention: the item the pull request belongs to. */
  belongsTo?: string;
  /** Head branch, when the list carries it. */
  branch?: string;
  /** Base branch, from the same batched rollup read as the checks. */
  base?: string;
  /** Review decision and checks of an open PR, from the project's one batched read (jira/prs?project=). */
  reviewDecision?: string | null;
  checks?: PrCheckRollup;
  /** When the project read took those checks (ms), so a stale read does not look fresh. */
  checksAt?: number;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

/** A PR is the card's own when the card key stands alone in its branch or title (no request: the list already holds both). Linked-on-the-card is added by `withLinkedOwn`. */
export function withKeyOwn(prs: readonly CardPr[], key: string): CardPr[] {
  const k = key.trim();
  if (!k) return [...prs];
  const re = new RegExp(`(^|[^A-Za-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "i");
  return prs.map((p) => re.test(`${p.branch ?? ""} ${p.title}`) ? { ...p, link: "own" as const, belongsTo: undefined } : p);
}

/** Old tracker keys a migrated card names in its description ("Migrated from <tracker> LEGACY-123"). */
export function legacyKeysOf(description: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of (description ?? "").matchAll(/Migrated from [^\n]*?\b([A-Z][A-Z0-9_]*-\d+)\b/gi)) out.add(m[1]!.toUpperCase());
  return [...out];
}

/**
 * The one own-vs-mention rule for a Jira card. OWN: the card key stands alone in the PR's branch name or title, or the card is linked to the PR on the site (Jira dev-status). A migrated card's old key counts as its key. MENTION: anything else the search found, i.e. only the body names the card (a parent's PR that lists each sub-task). The server's own reading of the body is not trusted here: a body-only hit with no other key is "own" there, and it must not be for a sub-task.
 * Every place that treats a PR as the card's own reads `own`; the UI reads `mentions` only to show them as not the card's.
 */
export function classifyCardPrs(prs: readonly CardPr[], key: string, linked: readonly { url: string; number: number; title?: string }[] = [], legacy: readonly string[] = []): { own: CardPr[]; mentions: CardPr[] } {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keys = [key, ...legacy].map((x) => x.trim()).filter(Boolean);
  const re = keys.length ? new RegExp(`(^|[^A-Za-z0-9])(${keys.map(esc).join("|")})(?![0-9])`, "i") : null;
  const addr = (u: string) => prAddress(u)?.url ?? u;
  const linkedAt = new Set(linked.map((l) => addr(l.url)));
  const own: CardPr[] = [];
  const mentions: CardPr[] = [];
  for (const p of prs) {
    const isOwn = linkedAt.has(addr(p.url)) || (!!re && re.test(`${p.branch ?? ""} ${p.title}`));
    if (isOwn) own.push({ ...p, link: "own", belongsTo: undefined });
    else mentions.push({ ...p, link: "mention" });
  }
  for (const l of linked) {
    if (!own.some((p) => addr(p.url) === addr(l.url))) own.push({ number: l.number, title: l.title ?? "", state: "", url: l.url, link: "own" });
  }
  return { own, mentions };
}

/** A pull request this card only NAMES, as opposed to one cut for it. */
export const isRelated = (p: CardPr): boolean => p.link === "mention";

/** The words for a related pull request's tooltip and accessible name. */
export function relatedNote(p: CardPr): string {
  return `mentions this card${p.belongsTo ? `; belongs to ${p.belongsTo}` : ""}`;
}

/** How many of the others are the card's own and how many only mention it, for
 *  the chip's count. */
export function restCounts(rest: readonly CardPr[]): { own: number; related: number } {
  const related = rest.filter(isRelated).length;
  return { own: rest.length - related, related };
}

function rank(p: CardPr): number {
  if (p.state === "OPEN" && !p.draft) return 0;
  if (p.draft) return 1;
  if (p.state === "MERGED") return 2;
  return 3; // CLOSED, or anything the API ever adds
}

/** Every pull request the card has, in the order the chip and its popover
 *  read them: the card's OWN before any that merely mention it (a stacked pull
 *  request names the one under it, and being newer must not make it the chip
 *  of the card below); then open, draft, merged, closed; within each, yours
 *  before anyone else's, then newest number first. */
export function sortedCardPrs(prs: readonly CardPr[]): CardPr[] {
  return [...prs].sort((a, b) =>
    Number(isRelated(a)) - Number(isRelated(b)) || rank(a) - rank(b)
    || Number(!!b.mine) - Number(!!a.mine) || b.number - a.number);
}

/**
 * Fold the pull requests a Jira card is LINKED to on the site into the board's
 * list: a linked one is the card's own whatever its text says (the project
 * search only reads text), and one the search never found is added with what
 * the link carries. Pure; the same address is matched by canonical form.
 */
export function withLinkedOwn(prs: readonly CardPr[], linked: readonly { url: string; number: number; title?: string }[]): CardPr[] {
  const key = (u: string) => prAddress(u)?.url ?? u;
  const out = prs.map((p) => ({ ...p }));
  for (const l of linked) {
    const at = out.findIndex((p) => key(p.url) === key(l.url));
    if (at >= 0) out[at] = { ...out[at]!, link: "own", belongsTo: undefined };
    else out.push({ number: l.number, title: l.title ?? "", state: "", url: l.url, link: "own" });
  }
  return out;
}

export type CardPrPick =
  | { kind: "none" }
  | { kind: "one"; pr: CardPr }
  | { kind: "many"; primary: CardPr; rest: CardPr[] };

/** The one decision the row chip needs: what to show, and what a click on it
 *  alone (no popover) should open. */
export function pickCardPr(prs: readonly CardPr[] | null | undefined): CardPrPick {
  if (!prs || !prs.length) return { kind: "none" };
  const sorted = sortedCardPrs(prs);
  if (sorted.length === 1) return { kind: "one", pr: sorted[0]! };
  return { kind: "many", primary: sorted[0]!, rest: sorted.slice(1) };
}

/** The chip's colour, off the same state a pull request is drawn in
 *  everywhere else this app shows one (`Detail`'s pull-request list in
 *  TasksPanel.tsx): open green, merged purple, closed red, and a draft — open
 *  in GitHub's own state machine but not yet asking for anything — grey like
 *  `PrPanel.tsx`'s `rowState` already draws it. No new colour, just the two
 *  house mappings this app already has for a pull request's state. */
export function cardPrTint(p: CardPr): string {
  if (isRelated(p)) return "var(--info)";
  if (p.draft) return "var(--text3)";
  if (p.state === "MERGED") return "#a371f7";
  if (p.state === "CLOSED") return "var(--error)";
  return "var(--success)";
}

let mergedInkCache: { key: string; ink: string } | null = null;

/** `#a371f7` on a light theme's chip fill is 3.35:1 — GitHub's own "Merged"
 *  purple, chosen for a dark background and never checked against a light
 *  one. The green and red chips are theme tokens already lifted once per
 *  theme in contrast.ts's inkTints; this literal is not, so it is lifted
 *  here instead, cached per background/text pair rather than per read. */
/** Exported for the two spots that draw the merged badge directly rather
 *  than through `cardPrTint`/`cardPrInk` (TasksPanel's own issue-linked pull
 *  request list). */
export function mergedInk(): string {
  if (typeof document === "undefined") return "#a371f7";
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue("--bg").trim();
  const text = cs.getPropertyValue("--text").trim();
  const key = `${bg}|${text}`;
  if (mergedInkCache?.key === key) return mergedInkCache.ink;
  const ink = bg && text ? inkFor("#a371f7", text, bg, 4.5) : "#a371f7";
  mergedInkCache = { key, ink };
  return ink;
}

/** The chip's TEXT colour — `cardPrTint`, guaranteed to clear 4.5:1 against
 *  the page it sits on. Fills stay `cardPrTint` as they are; only text reads
 *  through this. */
export function cardPrInk(p: CardPr): string {
  if (isRelated(p)) return "var(--info-ink)";
  if (p.draft) return "var(--text3)";
  if (p.state === "MERGED") return mergedInk();
  if (p.state === "CLOSED") return "var(--error-ink)";
  return "var(--success-ink)";
}
