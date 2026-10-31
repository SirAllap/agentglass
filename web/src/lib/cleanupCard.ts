/*
 * The agent's "clean up this merged PR" request, as the card draws it: the
 * decisions pulled out of the component so they can be tested (there is no
 * renderer in this project). The lines it reads are written by
 * shared/cleanupCard.ts; a request whose lines are not those is drawn as the
 * plain settings request, never as this card.
 */
import { parseCleanupCard, type CardItem } from "../../../shared/cleanupCard.ts";
import { humanSize } from "../../../shared/dockerSize.ts";
import type { SettingRequestView } from "../../../shared/settingClass.ts";
import { CLEANUP_KIND_ROWS } from "./cleanupSettings.ts";
import { whenWord } from "./housekeeping.ts";

export const CLEANUP_SETTING = "cleanup.run";

/** What the card needs of a request; the Lantern's copy has no expiry. */
export type CardRequest = Pick<SettingRequestView, "id" | "setting" | "who" | "diff" | "at"> & { expires?: number };

export interface CardChip { group: string; name: string; text: string }
export interface CardGroup { group: string; name: string; rows: CardItem[] }
export interface CleanupCardView {
  headline: string;
  sub: string;
  size: string;
  count: string;
  /** Proportions for the size bar: only kinds that free bytes, never thinner than a sliver. */
  bar: { group: string; name: string; size: string; flex: number }[];
  chips: CardChip[];
  /** The plain-language lines under the chips. */
  notes: { icon: "patch" | "shield" | "lock"; text: string }[];
  full: CardGroup[];
  /** Items of the plan that the door did not keep (a very long plan). */
  unlisted: number;
}

const NAME = new Map(CLEANUP_KIND_ROWS.map((k) => [k.id as string, k.name]));
const nameOf = (g: string): string => NAME.get(g) ?? g;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "just now" under five seconds, then seconds, then the minutes and days of whenWord. */
export function askedWord(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 5 ? "just now" : s < 60 ? `${s} s ago` : whenWord(at, now);
}

const sentence = (who: string): string => who.charAt(0).toUpperCase() + who.slice(1);

export function cleanupCardView(r: CardRequest, now: number): CleanupCardView | null {
  if (r.setting !== CLEANUP_SETTING) return null;
  const c = parseCleanupCard(r.diff);
  if (!c) return null;
  const name = c.slug || `#${c.pr}`;
  const merged = c.mergedAt ? ` merged ${whenWord(c.mergedAt, now)}` : "";
  const total = Math.max(c.totalBytes, 1);
  return {
    headline: `${sentence(r.who)} wants to clean up ${name}'s local leftovers`,
    sub: `${c.repo ? `${c.repo} · ` : ""}#${c.pr}${merged} · asked ${askedWord(r.at, now)}`,
    size: humanSize(c.totalBytes),
    count: `will be freed, ${plural(c.itemCount, "item")}`,
    bar: c.groups.filter((g) => g.bytes > 0).map((g) => ({ group: g.group, name: nameOf(g.group), size: humanSize(g.bytes), flex: Math.max(g.bytes, total * 0.015) })),
    chips: c.groups.map((g) => ({ group: g.group, name: nameOf(g.group), text: g.bytes > 0 ? humanSize(g.bytes) : g.items > 1 ? `${g.items} items` : "1" })),
    notes: [
      ...(c.groups.some((g) => g.group === "stashes") ? [{ icon: "patch" as const, text: "Stashes are saved as patch files first." }] : []),
      { icon: "shield", text: "No safety block: clean worktree, no extra commits, no stacked PR, no live session." },
      { icon: "lock", text: "Local only: nothing on GitHub or any tracker is touched." },
    ],
    full: c.groups.map((g) => ({ group: g.group, name: nameOf(g.group), rows: c.items.filter((i) => i.group === g.group) })),
    unlisted: Math.max(0, c.itemCount - c.items.length),
  };
}
