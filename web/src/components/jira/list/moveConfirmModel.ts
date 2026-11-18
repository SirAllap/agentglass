/*
 * The decisions behind the board's move confirmation, pulled out of the dialog so they can be tested without a
 * renderer: which cards go and which cannot (and why), how they group by where they stand, and the words.
 */
import { dropDecision } from "./boardModel.ts";
import type { MoveFacts } from "./menus/menuModel.ts";

export interface MoveItem { id: string; key: string; title: string; from: string }
export interface BlockedItem extends MoveItem { reason: string }
export interface MovePlan {
  /** The cards that can make the step, grouped by the status they stand in (first seen first). */
  groups: { from: string; items: MoveItem[] }[];
  movable: MoveItem[];
  /** Shown, never dropped: each with the site's own reason. */
  blocked: BlockedItem[];
}

/** Every card is read through the same decision a drop makes, so the dialog never promises a move the write refuses. */
export function planMove(items: readonly MoveItem[], facts: ReadonlyMap<string, MoveFacts>, to: string): MovePlan {
  const movable: MoveItem[] = [];
  const blocked: BlockedItem[] = [];
  for (const it of items) {
    const f = facts.get(it.id);
    const d = dropDecision(f ?? "reading", to);
    if (d.ok) movable.push(it); else blocked.push({ ...it, reason: d.reason });
  }
  const groups: MovePlan["groups"] = [];
  for (const it of movable) {
    const g = groups.find((x) => x.from === it.from);
    if (g) g.items.push(it); else groups.push({ from: it.from, items: [it] });
  }
  return { groups, movable, blocked };
}

/** The flow step the board's "Move to" would have gone to, when the card is being sent somewhere past it. */
export const skippedStep = (next: string | null, to: string): string | null => (next && next !== to ? next : null);

const upper = (s: string): string => s.toUpperCase();
const cards = (n: number): string => `${n} card${n === 1 ? "" : "s"}`;

export const confirmTitle = (n: number, to: string, key: string): string => (n === 1 ? `Move ${key} to ${upper(to)}?` : `Move ${cards(n)} to ${upper(to)}?`);
export const confirmSub = (plan: MovePlan): string =>
  plan.blocked.length ? `${plan.movable.length} can move · ${plan.blocked.length} cannot. This writes to your Jira site.` : "This writes to your Jira site.";
export const moveButtonLabel = (n: number): string => (n === 1 ? "Move" : `Move ${cards(n)}`);

export type RowPhase = "moving" | "moved" | "failed" | "undone";
export interface RunRow { phase: RowPhase; reason?: string }

const count = (rows: readonly RunRow[], p: RowPhase): number => rows.filter((r) => r.phase === p).length;
/** "2 moved · 1 moving · 1 failed": only the parts that are not zero. */
export function progressLine(rows: readonly RunRow[]): string {
  const parts = ([["moved", "moved"], ["moving", "moving"], ["failed", "failed"], ["undone", "put back"]] as const)
    .map(([p, w]) => [count(rows, p), w] as const).filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
  return parts.join(" · ");
}
export const runDone = (rows: readonly RunRow[]): boolean => rows.length > 0 && count(rows, "moving") === 0;

/** The toast a finished run leaves: "Moved 4 of 5 · 1 failed", or plain "Moved 5" when nothing failed. */
export function resultToast(rows: readonly RunRow[]): string {
  const moved = count(rows, "moved") + count(rows, "undone"), failed = count(rows, "failed");
  return failed ? `Moved ${moved} of ${rows.length} · ${failed} failed` : `Moved ${moved}`;
}
export const toastHolds = (rows: readonly RunRow[]): boolean => count(rows, "failed") > 0;

/*
 * What else the site does with a move: the fields its transition screen requires. Read once per (project, from-status)
 * pair, never per card, and only ever read: nothing here writes.
 */
export interface MoveScreen { toStatus: string; needs?: readonly string[]; fields?: readonly { key: string; name: string; required: boolean }[] }
export type ScreenRead = { phase: "loading" } | { phase: "ok"; moves: readonly MoveScreen[] } | { phase: "failed"; error: string };
export interface PairGroup { pair: string; project: string; from: string; rep: MoveItem; ids: string[] }

/** The project is the card key's prefix: "ORBIT-1042" is in ORBIT. */
export const projectOf = (key: string): string => key.replace(/-\d+$/, "");
export const pairOf = (it: MoveItem): string => `${projectOf(it.key)}|${it.from}`;

/** One group per distinct pair, first seen first; `rep` is the card the one read goes through. */
export function pairGroups(items: readonly MoveItem[]): PairGroup[] {
  const out: PairGroup[] = [];
  for (const it of items) {
    const pair = pairOf(it);
    const g = out.find((x) => x.pair === pair);
    if (g) g.ids.push(it.id); else out.push({ pair, project: projectOf(it.key), from: it.from, rep: it, ids: [it.id] });
  }
  return out;
}

/** The names of the required fields of the move into `to`, or null when the read has no such move. */
export function requiredNames(moves: readonly MoveScreen[], to: string): string[] | null {
  const m = moves.find((x) => x.toStatus === to);
  if (!m) return null;
  const named = (m.fields ?? []).filter((f) => f.required).map((f) => f.name);
  // A required key the screen did not describe is still named, by its key.
  const rest = (m.needs ?? []).filter((k) => !(m.fields ?? []).some((f) => f.key === k) );
  return [...named, ...rest];
}

export const NOTHING_ELSE = "Nothing else changes";
export const READING_SCREEN = "Reading what this step asks for…";
export const screenFailedLine = (error: string): string => `Could not read what this step changes${error ? `: ${error}` : ""}. You can still move.`;

/** The line a group shows under its heading: loading, the failure in one line, the required fields, or nothing else. */
export function screenLine(read: ScreenRead | undefined, to: string): { tone: "info" | "warn" | "plain"; text: string } {
  if (!read || read.phase === "loading") return { tone: "info", text: READING_SCREEN };
  if (read.phase === "failed") return { tone: "warn", text: screenFailedLine(read.error) };
  const names = requiredNames(read.moves, to);
  if (names === null) return { tone: "warn", text: screenFailedLine("this site did not list the step") };
  return names.length ? { tone: "plain", text: `Needs ${names.join(", ")}` } : { tone: "plain", text: NOTHING_ELSE };
}
