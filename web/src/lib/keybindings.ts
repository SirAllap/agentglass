import { VIEWS, type ViewId } from "../components/workspace/views.ts";
import { MOD_KEY as MOD_LABEL } from "./format.ts";

/**
 * The single-letter shortcuts, and the ability to change them.
 *
 * Only the bare letters are rebindable. The modified ones — ⌘1..5, ⌘\, ⌘[/],
 * ⌘K, ⌘±  — are structural: they are the bindings that keep working while the
 * caret sits in a composer or a shell, and letting those be reassigned would
 * let you lock yourself out of the workspace from inside a text field.
 *
 * Stored as action → key, not key → action. A key can only be held by one
 * action, but an action must always have exactly one key, and that is the
 * invariant worth making unrepresentable.
 */

export type ActionId =
  | `view.${ViewId}`
  | "open.help"
  | "open.stats"
  | "open.skills"
  | "open.search";

export type Binding = { id: ActionId; label: string; hint: string; key: string };

/** Defaults come from VIEWS so the rail, the palette and this cannot drift. */
export const DEFAULTS: Record<ActionId, string> = {
  ...(Object.fromEntries(VIEWS.map((v) => [`view.${v.id}`, v.key])) as Record<`view.${ViewId}`, string>),
  "open.help": "?",
  "open.stats": "s",
  "open.skills": "k",
  "open.search": "/",
};

export const LABELS: Record<ActionId, { label: string; hint: string }> = {
  ...(Object.fromEntries(VIEWS.map((v) => [`view.${v.id}`, { label: `Workspace — ${v.label}`, hint: v.hint }])) as Record<`view.${ViewId}`, { label: string; hint: string }>),
  "open.help": { label: "Legend & shortcuts", hint: "what the colours mean, and every key binding" },
  "open.stats": { label: "Statistics", hint: "totals, tool latency and cost breakdowns" },
  "open.skills": { label: "Skills catalog", hint: "every skill the fleet has available" },
  "open.search": { label: "Search", hint: "find a session, a file or an error" },
};

const KEY = "agentglass.keybindings";

/**
 * Keys that may not be bound.
 *
 * Escape closes things everywhere and is the way out of a mistake; Enter and
 * Tab belong to whatever has focus; a bare digit is how the git panel's tabs
 * are reached. Binding any of them would break something the user cannot then
 * use the keyboard to fix.
 */
const RESERVED = new Set(["Escape", "Enter", "Tab", " ", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

let cache: Record<ActionId, string> | null = null;
const listeners = new Set<() => void>();

export function bindings(): Record<ActionId, string> {
  if (cache) return cache;
  let stored: Partial<Record<ActionId, string>> = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* corrupt or absent */ }
  // Merged over the defaults rather than replacing them: a binding added in a
  // later version must appear for someone whose stored map predates it, instead
  // of that action silently having no key at all.
  cache = { ...DEFAULTS };
  for (const [id, k] of Object.entries(stored)) {
    if (id in DEFAULTS && typeof k === "string" && k.length > 0) cache[id as ActionId] = k;
  }
  return cache;
}

/** action for a pressed key, or null. */
export function actionFor(key: string): ActionId | null {
  const map = bindings();
  for (const id of Object.keys(map) as ActionId[]) if (map[id] === key) return id;
  return null;
}

export type RebindResult = { ok: true } | { ok: false; error: string };

export function rebind(id: ActionId, key: string): RebindResult {
  if (!key || key.length !== 1 && !/^[A-Za-z?/]$/.test(key)) {
    if (key.length !== 1) return { ok: false, error: "pick a single character" };
  }
  if (RESERVED.has(key)) return { ok: false, error: `${key === " " ? "space" : key} is reserved` };
  const map = bindings();
  const clash = (Object.keys(map) as ActionId[]).find((a) => a !== id && map[a] === key);
  // Refuse rather than steal: silently unbinding another action leaves you with
  // a shortcut that stopped working and no clue why.
  if (clash) return { ok: false, error: `already bound to ${LABELS[clash].label}` };
  cache = { ...map, [id]: key };
  persist();
  return { ok: true };
}

export function resetBindings() {
  cache = { ...DEFAULTS };
  persist();
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* non-fatal */ }
  for (const fn of listeners) fn();
}

export function subscribeBindings(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Whether anything has been changed from the shipped defaults. */
export const isCustomised = (): boolean =>
  (Object.keys(DEFAULTS) as ActionId[]).some((id) => bindings()[id] !== DEFAULTS[id]);

/* ------------------------------------------------------------------ chords */

/**
 * The workspace shortcuts, and why these are a second mechanism.
 *
 * Bare letters only work on the dashboard — inside the workspace every
 * keystroke belongs to whatever has focus, usually a shell. So the workspace
 * needs modified keys, and by default those are positional: the Nth icon in
 * the rail is MOD+N. Positional is a good default precisely because it is not
 * a preference — reorder the rail and the numbers follow, so the tooltip never
 * lies.
 *
 * But positional is also an opinion, and someone who thinks of chat as MOD+C
 * should not have to drag their rail to get it. A custom chord overrides the
 * position for that view; everything unbound stays positional.
 */
const CHORD_KEY = "agentglass.chords";

/** Chords the app itself owns. Rebinding these would take away zoom, the
 *  palette, the workspace toggle, or cycling — with no way back. */
const CHORD_RESERVED = new Set(["k", "\\", "[", "]", "0", "=", "+", "-", "_"]);

let chordCache: Partial<Record<ViewId, string>> | null = null;

export function chords(): Partial<Record<ViewId, string>> {
  if (chordCache) return chordCache;
  let stored: unknown = null;
  try { stored = JSON.parse(localStorage.getItem(CHORD_KEY) || "null"); } catch { /* corrupt */ }
  const out: Partial<Record<ViewId, string>> = {};
  if (stored && typeof stored === "object") {
    for (const [id, k] of Object.entries(stored as Record<string, unknown>)) {
      if (VIEWS.some((v) => v.id === id) && typeof k === "string" && k.length === 1) out[id as ViewId] = k;
    }
  }
  chordCache = out;
  return chordCache;
}

/** What actually reaches a view: the custom chord, else its rail position. */
export function chordFor(id: ViewId, order: ViewId[]): string {
  const custom = chords()[id];
  if (custom) return custom;
  const i = order.indexOf(id);
  return i >= 0 && i < 9 ? String(i + 1) : "";
}

/**
 * Which view a modified key opens, or null.
 *
 * Custom chords are resolved first, so binding MOD+2 to chat takes that key
 * away from whatever sits second in the rail rather than being shadowed by it
 * — the explicit choice has to win over the implicit one, or setting it looks
 * broken.
 */
export function viewForChord(key: string, order: ViewId[]): ViewId | null {
  const map = chords();
  for (const id of order) if (map[id] === key) return id;
  if (key >= "1" && key <= "9") {
    const at = order[Number(key) - 1];
    // A digit still held by a custom chord elsewhere is not also positional.
    if (at && !map[at]) return at;
  }
  return null;
}

export function rebindChord(id: ViewId, key: string, order: ViewId[]): RebindResult {
  if (key.length !== 1) return { ok: false, error: "pick a single character" };
  const k = key.toLowerCase();
  if (CHORD_RESERVED.has(k)) return { ok: false, error: `${MOD_LABEL}${key} belongs to the app` };
  const taken = order.find((v) => v !== id && chordFor(v, order) === k);
  if (taken) return { ok: false, error: `already opens ${taken}` };
  chordCache = { ...chords(), [id]: k };
  persistChords();
  return { ok: true };
}

export function clearChord(id: ViewId) {
  const next = { ...chords() };
  delete next[id];
  chordCache = next;
  persistChords();
}

export function resetChords() {
  chordCache = {};
  persistChords();
}

export const chordsCustomised = (): boolean => Object.keys(chords()).length > 0;

function persistChords() {
  try { localStorage.setItem(CHORD_KEY, JSON.stringify(chordCache)); } catch { /* non-fatal */ }
  for (const fn of listeners) fn();
}
