/*
 * "Does this finished PR have anything on this computer?": the one answer every
 * surface (the card's footer, the Closed list's rows, the PR panel's chip, a
 * lane footer) reads before it shows a chip or a Clean up button. The rule is
 * one sentence: a button exists only when the inventory was read and has at
 * least one real item. Computing, unknown and nothing all draw no button; an
 * unknown one is at most a muted "Leftovers ?" on the PR panel, with the reason
 * in its tooltip. The rows are the server's local inventory (GET
 * /cleanup/inventory: no gh, one answer per row), cached by PR and state.
 */
import { humanSize } from "../../../shared/dockerSize.ts";
import { CLEANUP_KIND_ROWS, type CleanupKind } from "./cleanupSettings.ts";
import { groupOf, listed, type Plan } from "./cleanupPr.ts";

export interface LeftoverGroup { group: string; items: number; bytes: number }
export type LeftoverState =
  | { kind: "computing" }
  | { kind: "unknown"; why: string }
  | { kind: "none" }
  | { kind: "some"; items: number; bytes: number; groups: LeftoverGroup[] };

export type Surface = "card" | "closedRow" | "panel" | "lane";

export interface Offer {
  /** The Clean up control exists. Never true unless the inventory has an item. */
  button: boolean;
  /** The tinted size (or item count) chip; the muted "Leftovers ?" on the panel for an unknown one. */
  chip: string | null;
  muted: boolean;
  tooltip: string;
  /** Still reading: a quiet placeholder, never a control. */
  skeleton: boolean;
}

const NOTHING: Offer = { button: false, chip: null, muted: false, tooltip: "", skeleton: false };

const sizeText = (bytes: number): string => (bytes > 0 ? humanSize(bytes) : "");
const nameOf = (g: string): string => CLEANUP_KIND_ROWS.find((k) => k.id === (g as CleanupKind))?.name ?? g;

/** "Docker 6.1 GB · Worktree 222 MB": the groups that have a size, largest first; the count for a group with none. */
export const tooltipOf = (groups: readonly LeftoverGroup[]): string =>
  [...groups].sort((a, b) => b.bytes - a.bytes).map((g) => `${nameOf(g.group)} ${sizeText(g.bytes) || (g.items === 1 ? "1 item" : `${g.items} items`)}`).join(" · ");

export function offerFor(s: LeftoverState | undefined, surface: Surface): Offer {
  if (!s || s.kind === "computing") return { ...NOTHING, skeleton: true };
  if (s.kind === "none") return NOTHING;
  if (s.kind === "unknown") return surface === "panel" ? { ...NOTHING, chip: "Leftovers ?", muted: true, tooltip: s.why } : NOTHING;
  if (s.items < 1) return NOTHING;
  return { button: true, chip: sizeText(s.bytes) || (s.items === 1 ? "1 item" : `${s.items} items`), muted: false, tooltip: tooltipOf(s.groups), skeleton: false };
}

/** The server's row, or "unknown" when it said so or sent nothing for this PR. */
export function stateOfRow(row: unknown): LeftoverState {
  const r = row as { unknown?: boolean; items?: unknown; bytes?: unknown; groups?: unknown } | null | undefined;
  if (!r || r.unknown || typeof r.items !== "number") return { kind: "unknown", why: "The local inventory could not be read for this pull request." };
  if (r.items < 1) return { kind: "none" };
  const parts = Array.isArray(r.groups) ? (r.groups as LeftoverGroup[]) : [];
  return { kind: "some", items: r.items, bytes: typeof r.bytes === "number" ? r.bytes : 0, groups: parts };
}

/**
 * The same answer from a full plan: bookkeeping rows (own-state, worklog) are not leftovers, the filter the server's
 * automatic cleanup uses. A plan that blocks still lists what is there; the block is shown, the chip stays.
 */
export function stateOfPlan(plan: Plan | null, failed: boolean, why = "The plan could not be read."): LeftoverState {
  if (!plan) return failed ? { kind: "unknown", why } : { kind: "computing" };
  const rows = listed(plan);
  if (!rows.length) return { kind: "none" };
  const by = new Map<string, LeftoverGroup>();
  for (const i of rows) {
    const g = groupOf(i.kind)!, cur = by.get(g) ?? { group: g, items: 0, bytes: 0 };
    by.set(g, { group: g, items: cur.items + 1, bytes: cur.bytes + Math.max(0, i.bytes ?? 0) });
  }
  const groups = [...by.values()];
  return { kind: "some", items: rows.length, bytes: groups.reduce((n, g) => n + g.bytes, 0), groups };
}

export interface LeftoverLine { tone: "none" | "some" | "run"; text: string; title: string }

/**
 * The finished card's quiet line about this computer. Nothing while the inventory is read or when it failed: the card
 * does not claim "No leftovers" over a silence. The Clean up button is the card's own primary action (offerFor).
 */
export function leftoverLine(s: LeftoverState | undefined, cleaning: boolean): LeftoverLine | null {
  if (cleaning) return { tone: "run", text: "Cleaning up\u2026", title: "Removing this pull request's local leftovers" };
  if (!s || s.kind === "computing" || s.kind === "unknown") return null;
  if (s.kind === "none") return { tone: "none", text: "No leftovers", title: "Nothing of this pull request is left on this computer" };
  if (s.items < 1) return { tone: "none", text: "No leftovers", title: "Nothing of this pull request is left on this computer" };
  const size = sizeText(s.bytes);
  return { tone: "some", text: `Leftovers: ${s.items === 1 ? "1 item" : `${s.items} items`}${size ? ` \u00b7 ${size}` : ""}`, title: tooltipOf(s.groups) };
}
