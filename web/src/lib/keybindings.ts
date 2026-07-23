import { VIEWS, type ViewId } from "../components/workspace/views.ts";

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
 * needs modified keys, and by default those are positional: the Nth icon in the
 * rail is MOD+N. Positional is a good default precisely because it is not a
 * preference — reorder the rail and the numbers follow, so the tooltip never
 * lies.
 *
 * A custom chord overrides the position, and may carry any combination of
 * modifiers: `mod+alt+j` is as bindable as `mod+j`. Stored normalised —
 * modifiers in a fixed order, key lowercased — because `Ctrl+Alt+J` and
 * `alt+ctrl+j` are the same shortcut and storing both would let one key answer
 * to two entries.
 *
 * `mod` rather than ctrl or meta: it is Ctrl here and ⌘ on a Mac, and a stored
 * binding should survive being carried to a different machine.
 */
const CHORD_KEY = "agentglass.chords";

const IS_MAC = /mac/i.test(typeof navigator !== "undefined" ? (navigator.platform ?? "") : "");

/** Chords the app itself owns. Rebinding these would take away zoom, the
 *  palette, the workspace toggle or cycling, with no way back. */
const CHORD_RESERVED = new Set(["mod+k", "mod+\\", "mod+[", "mod+]", "mod+0", "mod+=", "mod+-", "mod+_", "mod++"]);

/** `Ctrl+Alt+J` -> `mod+alt+j`. Null when nothing but modifiers is held, or
 *  when no modifier is — a bare key is the other binding, not this one. */
export function chordFromEvent(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const k = e.key;
  if (!k || ["Shift", "Control", "Alt", "Meta"].includes(k)) return null;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  // Ctrl on a Mac is a distinct modifier from ⌘; treating it as `mod` there
  // would make ⌃J and ⌘J the same binding.
  const other = IS_MAC ? e.ctrlKey : e.metaKey;
  if (!mod && !e.altKey && !other) return null;
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (other) parts.push(IS_MAC ? "ctrl" : "meta");
  if (e.altKey) parts.push("alt");
  // Only for keys that have no shifted form of their own: Shift+1 already
  // arrives as "!", and recording both would never match.
  if (e.shiftKey && k.length > 1) parts.push("shift");
  parts.push(k.length === 1 ? k.toLowerCase() : k);
  return parts.join("+");
}

/** `mod+alt+j` -> `Ctrl+Alt+J`, or `⌘⌥J` on a Mac. */
export function chordLabel(chord: string): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((m) =>
    m === "mod" ? (IS_MAC ? "⌘" : "Ctrl+")
    : m === "alt" ? (IS_MAC ? "⌥" : "Alt+")
    : m === "shift" ? (IS_MAC ? "⇧" : "Shift+")
    : m === "ctrl" ? "⌃"
    : m === "meta" ? "Meta+"
    : m + "+");
  return mods.join("") + (key.length === 1 ? key.toUpperCase() : key);
}

let chordCache: Partial<Record<ViewId, string>> | null = null;

/** A chord must carry at least one modifier and exactly one key. */
const VALID_CHORD = /^(mod\+|alt\+|shift\+|ctrl\+|meta\+)+[^+]+$/;

export function chords(): Partial<Record<ViewId, string>> {
  if (chordCache) return chordCache;
  let stored: unknown = null;
  try { stored = JSON.parse(localStorage.getItem(CHORD_KEY) || "null"); } catch { /* corrupt */ }
  const out: Partial<Record<ViewId, string>> = {};
  if (stored && typeof stored === "object") {
    for (const [id, k] of Object.entries(stored as Record<string, unknown>)) {
      if (VIEWS.some((v) => v.id === id) && typeof k === "string" && VALID_CHORD.test(k)) out[id as ViewId] = k;
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
  return i >= 0 && i < 9 ? `mod+${i + 1}` : "";
}

/**
 * Which view a chord opens, or null.
 *
 * Custom chords resolve first, so binding mod+2 to chat takes that key from
 * whatever sits second in the rail rather than being shadowed by it — the
 * explicit choice has to beat the implicit one, or setting it looks broken.
 */
export function viewForChord(chord: string, order: ViewId[]): ViewId | null {
  const map = chords();
  for (const id of order) if (map[id] === chord) return id;
  const m = /^mod\+([1-9])$/.exec(chord);
  if (m) {
    const at = order[Number(m[1]) - 1];
    // A position whose view has its own chord is no longer reachable by number.
    if (at && !map[at]) return at;
  }
  return null;
}

export function rebindChord(id: ViewId, chord: string, order: ViewId[]): RebindResult {
  if (!VALID_CHORD.test(chord)) return { ok: false, error: "hold a modifier — Ctrl, Alt or both" };
  if (CHORD_RESERVED.has(chord)) return { ok: false, error: `${chordLabel(chord)} belongs to the app` };
  const taken = order.find((v) => v !== id && chordFor(v, order) === chord);
  if (taken) return { ok: false, error: `already opens ${taken}` };
  chordCache = { ...chords(), [id]: chord };
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
