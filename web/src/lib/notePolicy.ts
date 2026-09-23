import type { SystemNote } from "./sysNotify.ts";

/**
 * What a note is allowed to do when it arrives.
 *
 * Every note behind the bell has a SOURCE — the Lantern, an agent asking, a
 * desktop app — and a LEVEL, its urgency. The two answer different questions:
 * the level decides how loud a note may be, the source is what a person can
 * say "not this one" about. Before this there were two unrelated switches and
 * neither was either: Quiet only reached the mirrored notes, and the switch for
 * agentglass's own alerts was all or nothing, so a desk of five agents put
 * dozens of rows behind the bell in an hour and "Quiet on" still showed them.
 *
 * Three levels, one rule each:
 *
 *   urgent (2)  something is STOPPED until a person acts. Always interrupts —
 *               popup, sound, badge — and cannot be muted by source.
 *   normal (1)  news. Badged; interrupts only with Quiet off.
 *   quiet  (0)  a row, findable, with its destination. No badge, no sound.
 *
 * Quiet is on by default: the calm reading of the bell is "only what is
 * stopped reaches you", and turning it off is a choice somebody makes.
 *
 * Mirrored desktop notes are never louder than normal and never interrupt with
 * Quiet on — the desktop already drew its own popup for them, so ours was the
 * second copy of the same interruption.
 */

/** Sources that stop an agent or answer a promise the person made. Muting
 *  one would turn "stop interrupting me" into "an agent blocked and nobody
 *  said", so the mute control is not offered for them. */
const UNMUTABLE = new Set(["gate", "understudy", "reminder"]);
export const canMute = (source: string): boolean => !UNMUTABLE.has(source);

export const DESKTOP = "desktop:";
export const isDesktop = (source: string): boolean => source.startsWith(DESKTOP);

/** Where a note came from, as the unit a person mutes. */
export function sourceOf(n: Pick<SystemNote, "app" | "source">): string {
  if (n.source) return n.source;
  return (n.app || "agentglass").trim().toLowerCase();
}

const LABELS: Record<string, string> = {
  gate: "Approvals",
  agents: "Agents",
  lantern: "Lantern",
  errors: "Failing agents",
  understudy: "Deputy",
  reminder: "Reminders",
  schedule: "Scheduled starts",
  chat: "Chats",
  git: "Branches behind",
  ci: "Checks",
  pr: "PR conversation",
  clickup: "Cards",
  update: "Updates",
  agentglass: "agentglass",
};

/** A source as a person would name it. */
export function sourceLabel(source: string): string {
  if (isDesktop(source)) {
    const app = source.slice(DESKTOP.length);
    return app ? app[0]!.toUpperCase() + app.slice(1) : "Desktop";
  }
  return LABELS[source] ?? source;
}

/** The filter a source sits under in the panel. */
export type Lane = "agents" | "work" | "desktop";
const AGENT_SOURCES = new Set(["gate", "agents", "lantern", "errors", "understudy", "chat", "schedule"]);
export function laneOf(source: string): Lane {
  if (isDesktop(source)) return "desktop";
  return AGENT_SOURCES.has(source) ? "agents" : "work";
}

export type Delivery = {
  /** Recorded in the list at all. */
  keep: boolean;
  /** Counts toward the unread badge. */
  badge: boolean;
  /** Takes the screen: a toast, a popup, a sound. */
  interrupt: boolean;
};

export type PolicyState = { muted: ReadonlySet<string>; quiet: boolean };

export function deliveryFor(n: Pick<SystemNote, "app" | "source" | "urgency">, s: PolicyState): Delivery {
  const src = sourceOf(n);
  const desktop = isDesktop(src);
  const level = desktop ? Math.min(n.urgency, 1) : n.urgency;
  // A mute never reaches something stopped: muting "Agents" to stop hearing
  // about prompts left open must not also swallow the one asking permission.
  if (level < 2 && s.muted.has(src) && canMute(src)) return { keep: false, badge: false, interrupt: false };
  if (level === 2) return { keep: true, badge: true, interrupt: true };
  if (level === 1) return { keep: true, badge: !desktop || !s.quiet, interrupt: !s.quiet };
  return { keep: true, badge: false, interrupt: false };
}

/* ── the muted sources, persisted like their neighbours in sysNotify.ts ── */

const MUTED_KEY = "agentglass.notes.muted";

function readMuted(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(MUTED_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && canMute(x)) : []);
  } catch { return new Set(); }
}

let muted: ReadonlySet<string> | null = null;
const mutedListeners = new Set<() => void>();

/** The same Set until it changes, so `useSyncExternalStore` can hold it. */
export function mutedSources(): ReadonlySet<string> {
  return (muted ??= readMuted());
}

export function setMuted(source: string, on: boolean): void {
  if (on && !canMute(source)) return;
  const next = new Set(mutedSources());
  if (on) next.add(source); else next.delete(source);
  muted = next;
  try { localStorage.setItem(MUTED_KEY, JSON.stringify([...next].sort())); }
  catch { /* private mode — muted for this session */ }
  for (const fn of mutedListeners) fn();
}

export function subscribeMuted(fn: () => void): () => void {
  mutedListeners.add(fn);
  return () => { mutedListeners.delete(fn); };
}

/** Tests only: forget the cached set so a stubbed storage is read again. */
export function __resetMuted(): void { muted = null; }

/* ── grouping, for the panel ─────────────────────────────────────────────── */

export type NoteGroup = { source: string; lead: SystemNote; more: SystemNote[] };

/**
 * The list as the panel draws it: one entry per source, newest first, with the
 * older rows from the same source folded under the newest.
 *
 * Urgent rows are never folded — each one is somebody waiting on a decision,
 * and a decision behind "+3 more" is a decision nobody made. They lead their
 * own entry.
 */
export function groupNotes(list: readonly SystemNote[]): NoteGroup[] {
  const out: NoteGroup[] = [];
  const open = new Map<string, NoteGroup>();
  for (const n of list) {
    const src = sourceOf(n);
    if (n.urgency === 2) { out.push({ source: src, lead: n, more: [] }); continue; }
    const g = open.get(src);
    if (g) { g.more.push(n); continue; }
    const fresh = { source: src, lead: n, more: [] };
    open.set(src, fresh);
    out.push(fresh);
  }
  return out;
}
