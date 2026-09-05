import { VIEWS, workIds, type ViewId } from "../components/workspace/views.ts";

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
export function chordFromEvent(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  /*
   * A digit is the KEY YOU PRESSED, whatever the layout makes of it.
   *
   * Ctrl+Alt is AltGr on a Spanish keyboard, and AltGr+1..4 there are `|`, `@`,
   * `#` and `~` — so `Ctrl+Alt+4` arrived as `mod+alt+~` and matched nothing.
   * Reported as "ctrl alt 4 does not open the card". `code` is the physical key and
   * says `Digit4` on every layout; the number row and the keypad both answer to
   * the digit somebody is looking at on the keycap.
   *
   * Only for digits. A letter's `key` is already layout-correct and using
   * `code` there would bind Dvorak users to QWERTY positions.
   */
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code ?? "");
  const k = digit ? digit[1]! : e.key;
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
  /*
   * Shift counts for named keys and for LETTERS, and for nothing else.
   *
   * A letter arrives shifted as its uppercase form — "P", not "p" — so the
   * identity is unambiguous once lowercased, and dropping the shift made
   * Ctrl+Shift+P and Ctrl+P the same chord. That mattered the moment something
   * wanted Ctrl+Shift+P: in a terminal Ctrl+P is readline's previous-command
   * and Ctrl+Shift+P is free, which is the whole reason every terminal-adjacent
   * app binds the shifted one.
   *
   * Punctuation is different and is left alone: Shift+1 already arrives as "!",
   * so its shifted form IS the key, and recording shift as well would produce a
   * chord that can never match what the keyboard sends.
   */
  const letter = k.length === 1 && /^[A-Za-z]$/.test(k);
  if (e.shiftKey && (k.length > 1 || letter)) parts.push("shift");
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

/**
 * What actually reaches a view: the custom chord, else its position in the
 * work drawer — and nothing at all if it is not in the work drawer.
 *
 * The rail reads the layout itself rather than taking an order to index into.
 * There are two lists it could plausibly be handed now (the top drawer, or
 * everything the rail draws) and only one of them is right, so passing the
 * wrong one was a bug waiting at five call sites.
 */
export function chordFor(id: ViewId): string {
  const custom = chords()[id];
  if (custom) return custom;
  const i = workIds().indexOf(id);
  return i >= 0 && i < 9 ? `mod+${i + 1}` : "";
}

/** Whether this view's chord was chosen rather than inherited from position. */
export const hasCustomChord = (id: ViewId): boolean => !!chords()[id];

/**
 * Which view a chord opens, or null.
 *
 * Custom chords resolve first, so binding mod+2 to chat takes that key from
 * whatever sits second in the work drawer rather than being shadowed by it —
 * the explicit choice has to beat the implicit one, or setting it looks broken.
 *
 * A hidden view still answers to a chord somebody bound to it by hand. Hiding
 * takes a view off the rail, not out of the app, and the caller's job is to put
 * it back on the way in — a key that silently does nothing is a worse answer
 * than a tab reappearing.
 */
export function viewForChord(chord: string): ViewId | null {
  const map = chords();
  for (const v of VIEWS) if (map[v.id] === chord) return v.id;
  const m = /^mod\+([1-9])$/.exec(chord);
  if (m) {
    const at = workIds()[Number(m[1]) - 1];
    // A position whose view has its own chord is no longer reachable by number.
    if (at && !map[at]) return at;
  }
  return null;
}

export function rebindChord(id: ViewId, chord: string): RebindResult {
  if (!VALID_CHORD.test(chord)) return { ok: false, error: "hold a modifier — Ctrl, Alt or both" };
  if (CHORD_RESERVED.has(chord)) return { ok: false, error: `${chordLabel(chord)} belongs to the app` };
  const taken = VIEWS.find((v) => v.id !== id && chordFor(v.id) === chord);
  if (taken) return { ok: false, error: `already opens ${taken.label}` };
  // App actions are checked here too, even though App resolves views first: a
  // view that shadowed the file palette would leave that key looking broken
  // from the other setting's point of view. Refuse rather than steal — the same
  // rule the single-letter bindings follow.
  const app = appActionForChord(chord);
  if (app) return { ok: false, error: `already opens ${APP_CHORD_LABELS[app].label}` };
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

/* -------------------------------------------------------- app-action chords */

/**
 * Chords that open something which is not a view.
 *
 * A third mechanism, and it earns its keep: the two above answer "which of the
 * rail's tabs" and "which single letter on the dashboard". The file palette is
 * neither — it has no tab, it must work while a shell has focus, and it must
 * work from every view including the ones that are not the workspace at all.
 *
 * Kept rebindable rather than reserved, unlike ⌘K and the zoom keys. Those are
 * structural: lose them and you cannot get the palette or your eyesight back.
 * This one opens a search you can also reach by other means, and it lands in a
 * terminal — the one place in this app where a chord is genuinely somebody
 * else's. If it collides with something in your shell you must be able to move
 * it, and that is a preference, not a fault.
 */
export type AppChordId = "files.palette" | "bench.toggle" | "pane.git" | "pane.diff" | "pane.pr" | "pane.card";

/**
 * Ctrl+Shift+P, not Ctrl+P — the same reasoning as isFindChord in termKeys.ts.
 *
 * Ctrl+P is readline's previous-command, and tmux, vim and emacs all spend it
 * too. Binding it would break the program inside the shell in order to add a
 * feature to the app around it. VS Code, GNOME Terminal and Konsole all settled
 * on the shifted form for exactly this reason.
 */
export const APP_CHORD_DEFAULTS: Record<AppChordId, string> = {
  "files.palette": "mod+shift+p",
  /*
   * Ctrl+Alt+A for the bench, and the Alt is what makes it safe.
   *
   * This one also has to survive a live shell, and the shifted forms are
   * crowded: Ctrl+Shift+A is "select all" in half the terminals and a tmux
   * prefix in some configurations. Alt-modified chords are the ones a terminal
   * passes through as an escape sequence nothing common binds — and it is the
   * chord the floating workspace this is modelled on already uses, which is one
   * less thing to relearn.
   */
  "bench.toggle": "mod+alt+a",
  /*
   * The four doors of the pane you are typing in, as the four digits.
   *
   * The twins of the buttons that pane draws in its corner — for the hand
   * already on the keyboard, and the only way in when the block is folded away
   * or switched off.
   *
   * NOT tmux bindings, and that is the whole design. The obvious spelling was
   * `prefix p`, and prefix + p is tmux's own "previous window" — as prefix + d
   * is detach and prefix + c is a new window. Taking those would break the
   * three chords somebody uses most to give them one they use rarely. An app
   * chord never reaches tmux at all.
   *
   * Digits rather than initials: "maybe it could be ctrl alt 1/2/3/4, I think
   * that is easier" — and they are, because the block they belong to is a 2×2
   * read the same way. 1 and 2 on top are the checkout (git, changes); 3 and 4
   * underneath are the work (the pull request, the card).
   *
   * Alt-modified for the same reason the bench is: Ctrl+Shift+letter is
   * crowded in a live shell, and Alt chords arrive as an escape sequence
   * nothing common binds.
   */
  "pane.git": "mod+alt+1",
  "pane.diff": "mod+alt+2",
  "pane.pr": "mod+alt+3",
  "pane.card": "mod+alt+4",
};

export const APP_CHORD_LABELS: Record<AppChordId, { label: string; hint: string }> = {
  "files.palette": {
    label: "Find a file",
    hint: "search any checkout from anywhere — names, contents, or what you opened recently",
  },
  "bench.toggle": {
    label: "The bench",
    hint: "the floating window and its tabs — a shell, a file, a note, an agent — over whatever you were looking at",
  },
  "pane.git": {
    label: "This pane's source control",
    hint: "opens Source control on the worktree the pane you are typing in is working in",
  },
  "pane.diff": {
    label: "This pane's changes",
    hint: "opens File changes on that worktree — the same door the pane's second button opens",
  },
  "pane.pr": {
    label: "This pane's pull request",
    hint: "opens the pull request of the tmux pane you are typing in — the same door its corner button opens",
  },
  "pane.card": {
    label: "This pane's card",
    hint: "opens the card the pane's branch came from, in Tasks or in your tracker",
  },
};

const APP_CHORD_KEY = "agentglass.appChords";

let appChordCache: Partial<Record<AppChordId, string>> | null = null;

const APP_CHORD_IDS = Object.keys(APP_CHORD_DEFAULTS) as AppChordId[];

function appChords(): Partial<Record<AppChordId, string>> {
  if (appChordCache) return appChordCache;
  let stored: unknown = null;
  try { stored = JSON.parse(localStorage.getItem(APP_CHORD_KEY) || "null"); } catch { /* corrupt */ }
  const out: Partial<Record<AppChordId, string>> = {};
  if (stored && typeof stored === "object") {
    for (const [id, k] of Object.entries(stored as Record<string, unknown>)) {
      if (APP_CHORD_IDS.includes(id as AppChordId) && typeof k === "string" && VALID_CHORD.test(k)) {
        out[id as AppChordId] = k;
      }
    }
  }
  appChordCache = out;
  return appChordCache;
}

/** What actually opens it: the chosen chord, else the shipped one. */
export const appChordFor = (id: AppChordId): string => appChords()[id] ?? APP_CHORD_DEFAULTS[id];

/** Whether this action's chord was chosen rather than shipped. */
export const hasCustomAppChord = (id: AppChordId): boolean => !!appChords()[id];

/** Which app action a chord runs, or null. */
export function appActionForChord(chord: string): AppChordId | null {
  for (const id of APP_CHORD_IDS) if (appChordFor(id) === chord) return id;
  return null;
}

export function rebindAppChord(id: AppChordId, chord: string): RebindResult {
  if (!VALID_CHORD.test(chord)) return { ok: false, error: "hold a modifier — Ctrl, Alt or both" };
  if (CHORD_RESERVED.has(chord)) return { ok: false, error: `${chordLabel(chord)} belongs to the app` };
  // Both directions, because both would otherwise be silently shadowed: App
  // checks view chords before app actions, so a collision would take THIS key
  // away rather than the view's, and the setting would look like it did nothing.
  const view = VIEWS.find((v) => chordFor(v.id) === chord);
  if (view) return { ok: false, error: `already opens ${view.label}` };
  /*
   * Compared as strings on purpose.
   *
   * There is one app action today, so `a !== id` narrows the element type to
   * `never` and the label lookup stops compiling — for a check that is dead
   * code now and load-bearing the moment a second one exists. Widening the
   * comparison keeps the check written rather than deleting it and having to
   * remember it later.
   */
  const self: string = id;
  for (const a of APP_CHORD_IDS) {
    if ((a as string) === self) continue;
    if (appChordFor(a) === chord) return { ok: false, error: `already opens ${APP_CHORD_LABELS[a].label}` };
  }
  appChordCache = { ...appChords(), [id]: chord };
  persistAppChords();
  return { ok: true };
}

export function resetAppChords() {
  appChordCache = {};
  persistAppChords();
}

export const appChordsCustomised = (): boolean => Object.keys(appChords()).length > 0;

function persistAppChords() {
  try { localStorage.setItem(APP_CHORD_KEY, JSON.stringify(appChordCache)); } catch { /* non-fatal */ }
  for (const fn of listeners) fn();
}
