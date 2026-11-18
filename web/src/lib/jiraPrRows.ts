/*
 * The pull-request rows of a Jira card's Dev tab, as data: one shape for every
 * row (`#n · title`, a state pill, a relation tag), the card's own PRs before
 * the ones only mentioned. Pure; the component only draws it.
 */
import type { JiraLink } from "./jiraLinks.ts";
import type { CardPr } from "./cardPrPick.ts";
import { prAddress } from "../../../shared/taskref.ts";

export type PrStateWord = "Open" | "Draft" | "Merged" | "Closed" | "";
export interface PrRow { url: string; number: number; label: string; state: PrStateWord; relation: "Linked" | "Mentions this card"; canLink: boolean }

const key = (u: string) => prAddress(u)?.url ?? u;
const isOwn = (l: JiraLink) => l.where === "link" || l.where === "dev";

/** Linked (and dev-tool) rows first, then mentions; each group keeps its order. */
export function orderLinks(links: readonly JiraLink[]): JiraLink[] {
  return [...links.filter(isOwn), ...links.filter((l) => !isOwn(l))];
}

/**
 * The list holds every PR the Dev count counts: the card's links, plus the card's own PRs the board found by branch or
 * title. Deduped by address; a PR already linked keeps its link row.
 */
export function withKnownOwn(links: readonly JiraLink[], known: readonly CardPr[] = []): JiraLink[] {
  const have = new Set(links.map((l) => key(l.url)));
  const out = [...links];
  for (const p of known) {
    if (p.link === "mention" || !p.url || have.has(key(p.url))) continue;
    have.add(key(p.url));
    out.push({ url: p.url, number: p.number, title: p.title, resolved: p.state.toUpperCase() !== "OPEN", where: "dev" });
  }
  return out;
}

/** `known` is any PR list already read (the board's): it lends a title and a state to a row that has only a number. */
export function prRows(links: readonly JiraLink[], known: readonly CardPr[] = []): PrRow[] {
  const ownKeys = new Set(known.filter((p) => p.link === "own").map((p) => key(p.url)));
  const by = new Map(known.map((p) => [key(p.url), p]));
  const rank = (l: JiraLink): number => {
    if (!(isOwn(l) || ownKeys.has(key(l.url)))) return 9;
    const k = by.get(key(l.url));
    const st = (l.dev?.state || k?.state || "").toUpperCase();
    return st === "OPEN" && !k?.draft ? 0 : k?.draft && st === "OPEN" ? 1 : st === "MERGED" ? 2 : 3;
  };
  // Own first (open, draft, merged, closed; newest number first), then mentions.
  return [...orderLinks(links)].sort((a, b) => rank(a) - rank(b) || (rank(a) < 9 ? b.number - a.number : 0)).map((l) => {
    const k = by.get(key(l.url));
    const title = l.dev?.title || k?.title || (/^[^#\s]+#\d+$/.test(l.title) || l.title === l.url ? "" : l.title);
    const st = (l.dev?.state || k?.state || "").toUpperCase();
    const draft = !!k?.draft && st === "OPEN";
    const state: PrStateWord = draft ? "Draft" : st === "OPEN" ? "Open" : st === "MERGED" ? "Merged" : st === "CLOSED" ? "Closed" : "";
    // A row the card does not link is still its own when the board's classifier (branch or title carries the key) says so.
    const own = isOwn(l) || ownKeys.has(key(l.url));
    return { url: l.url, number: l.number, label: title ? `#${l.number} · ${title}` : `#${l.number}`, state, relation: own ? "Linked" : "Mentions this card", canLink: !own };
  });
}
