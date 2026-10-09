/*
 * The settings an agent may read and write, as definitions the Settings rows
 * bind to.
 *
 * A row used to know its own setter and nothing else; there was no list of
 * settings anywhere, only the generated list of row LABELS (settingsRows.gen.ts).
 * A SettingDef is that missing thing for the panes migrated so far: an id, the
 * value's check, and the one function that applies it. The row calls
 * `def.set(v)` and so does an agent's `settings.set`, so there is one write path
 * and the two cannot disagree about what a valid value is, which pref module
 * stores it, or what else has to repaint. The def wraps the setter the row
 * always called (setDiffWrap, moveView, applyThemeMode…), so a migration inside
 * the pref module and a legacy-key read apply to an agent's write by
 * construction.
 *
 * What an agent gets is deliberately less than what a row gets:
 *
 *   - Deny by default. A def with no `level` is level 3, and `AGENT_MAX_LEVEL`
 *     is 2, so a setting is writable by an agent only when somebody wrote a 2
 *     next to it on purpose. A setting that has no def at all is "not exposed".
 *   - A secret def answers `{set: true}` and is never written through here.
 *   - Every agent write remembers what it replaced and how to put it back, and
 *     the window shows a chip saying so (AgentChangeChip). The undo goes through
 *     the same def, so it is also validated.
 *
 * Panes migrated so far are Appearance, Diff, Rail and the "How it draws" group
 * of Terminal (MIGRATED below). Every other pane is listed in NOT_YET_MIGRATED,
 * on purpose: a new pane has to be put on one list or the other, and a test
 * fails until it is. Order of rows inside the rail's drawers, and the one-click
 * resets, are row actions and not settings, so they are marked agentExempt.
 */
import { diffSplit, setDiffSplit, diffWrap, setDiffWrap, diffThemePref, setDiffThemePref, DEFAULT_SPLIT, DEFAULT_WRAP } from "./diffPrefs.ts";
import { THEMES as SYNTAX_THEMES } from "./highlight.ts";
import { rendererPref, setRendererPref, type RendererPref } from "./termRenderer.ts";
import {
  TERM_FONTS, CURSORS, SIZE_MIN, SIZE_MAX, DEFAULT_SIZE, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_LINE_HEIGHT,
  currentTermFont, setTermFont, currentTermSize, setTermSize, currentTermLineHeight, setTermLineHeight,
  currentTermCursor, setTermCursor, fontAvailable, type CursorStyle,
} from "./termPrefs.ts";
import { ACCENTS, currentAccent, setAccentPref } from "./accent.ts";
import {
  THEMES, applyTheme, applyThemeMode, chooseTheme, themeMode, desktopPaletteName, type ThemeMode,
} from "./themes.ts";
import { VIEWS, RAIL_PLACES, SHIPPED_RAIL, loadRail, railIds, moveView, saveRail, type RailPlace } from "../components/workspace/views.ts";

export type SettingValue = string | number | boolean;

export type SetResult =
  | { ok: true; prev: SettingValue; value: SettingValue; revert: () => void }
  | { ok: false; error: string };

/** What an agent's write reports. `undo` is the handle the chip (and, once a
 *  reply path exists, the caller) can put the change back with. */
export type AgentSetResult =
  | { ok: true; id: string; prev: SettingValue; value: SettingValue; undo: string; unchanged?: true }
  | { ok: false; error: string };

export type AgentGetResult =
  | { ok: true; id: string; value: SettingValue }
  | { ok: true; id: string; set: boolean }
  | { ok: false; error: string };

export interface SettingDef {
  /** `<pane>.<name>`; the pane is the Settings page it lives on. */
  id: string;
  page: string;
  section: string;
  label: string;
  /** Level an agent needs to WRITE it. Absent is 3, which this window refuses. */
  level?: 1 | 2 | 3;
  secret?: true;
  default: SettingValue;
  get(): SettingValue;
  /** The value as it should be stored, or null when it is not a valid one. */
  validate(raw: unknown): SettingValue | null;
  /** Validate, apply through the pref module's own setter, announce. */
  set(raw: unknown): SetResult;
}

interface DefSpec {
  id: string; page: string; section: string; label: string;
  level?: 1 | 2 | 3; secret?: true;
  default: SettingValue;
  read(): SettingValue;
  validate(raw: unknown): SettingValue | null;
  write(v: SettingValue): void;
  /** What undo needs when the value alone does not say it (the theme mode
   *  forgets which palette it was on). Defaults to the value. */
  capture?(): unknown;
  restore?(token: unknown): void;
}

// ── change announcements ────────────────────────────────────────────────────

/** `by` is who made the change: a mounted row repaints itself, so only an
 *  agent's change needs every other holder of a copy of the value to re-read. */
export type SettingChange = { id: string; by: "row" | "agent" | "undo" };
const listeners = new Set<(c: SettingChange) => void>();
/** Told on every change through a def, whoever made it. In-window only: this is
 *  a function call, not a socket, and nothing polls. */
export function subscribeSettings(fn: (c: SettingChange) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
let announcing: SettingChange["by"] = "row";
const announce = (id: string) => { for (const fn of [...listeners]) fn({ id, by: announcing }); };

function defineSetting(s: DefSpec): SettingDef {
  const get = () => s.read();
  const def: SettingDef = {
    id: s.id, page: s.page, section: s.section, label: s.label, level: s.level, secret: s.secret, default: s.default,
    get,
    validate: s.validate,
    set(raw) {
      const v = s.validate(raw);
      if (v === null) return { ok: false, error: `not a valid value for ${s.id}` };
      const prev = get();
      const token = s.capture ? s.capture() : prev;
      s.write(v);
      announce(s.id);
      return {
        ok: true, prev, value: v,
        revert: () => {
          if (s.restore) s.restore(token); else s.write(prev);
          announce(s.id);
        },
      };
    },
  };
  return def;
}

const oneOf = <T extends string>(values: readonly T[]) => (raw: unknown): T | null =>
  typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : null;

/** A whole number in range; a number outside it is refused, not clamped, so an
 *  agent that asks for 400px hears about it instead of getting 22. */
const intIn = (min: number, max: number) => (raw: unknown): number | null =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;

const bool = (raw: unknown): boolean | null => (typeof raw === "boolean" ? raw : null);

// ── appearance ──────────────────────────────────────────────────────────────

const currentThemeId = (): string => document.documentElement.getAttribute("data-theme") || "";
/** Mode and palette are one thing seen two ways (a palette pick sets the mode),
 *  so undoing either has to put both back. */
const captureTheme = () => ({ mode: themeMode(), theme: currentThemeId() });
const restoreTheme = (t: unknown) => {
  const { mode, theme } = t as { mode: ThemeMode; theme: string };
  if (mode === "custom") chooseTheme(theme); else applyThemeMode(mode);
};

const MODE_VALUES = ["system", "dark", "light"] as const;
const PALETTE_IDS = THEMES.map((t) => t.id);
const ACCENT_IDS = ACCENTS.map((a) => a.id);

const appearance: SettingDef[] = [
  defineSetting({
    id: "appearance.mode", page: "appearance", section: "", label: "Mode", level: 2, default: "system",
    read: () => themeMode(),
    // `desktop` is on offer only where the desktop publishes a palette, like the row.
    validate: (raw) => (raw === "desktop" ? (desktopPaletteName() ? "desktop" : null) : oneOf(MODE_VALUES)(raw)),
    write: (v) => { applyThemeMode(v as ThemeMode); },
    capture: captureTheme, restore: restoreTheme,
  }),
  defineSetting({
    id: "appearance.theme", page: "appearance", section: "", label: "Theme", level: 2, default: "graphite",
    read: () => currentThemeId(),
    validate: oneOf(PALETTE_IDS),
    write: (v) => { chooseTheme(v as string); },
    capture: captureTheme, restore: restoreTheme,
  }),
  defineSetting({
    id: "appearance.accent", page: "appearance", section: "", label: "Accent", level: 2, default: "",
    read: () => currentAccent(),
    validate: oneOf(ACCENT_IDS),
    // The pref is stored, then the theme is laid again so the overlay (or its
    // removal, for "Theme") lands: the picker has always done both.
    write: (v) => { setAccentPref(v as string); applyTheme(currentThemeId()); },
  }),
];

// ── diff ────────────────────────────────────────────────────────────────────

const SYNTAX_IDS = ["auto", ...SYNTAX_THEMES.map((t) => t.id)];

const diff: SettingDef[] = [
  defineSetting({
    id: "diff.split", page: "diff", section: "How a diff opens", label: "Default view", level: 2, default: DEFAULT_SPLIT ? "split" : "inline",
    read: () => (diffSplit() ? "split" : "inline"),
    validate: oneOf(["split", "inline"] as const),
    write: (v) => setDiffSplit(v === "split"),
  }),
  defineSetting({
    id: "diff.wrap", page: "diff", section: "How a diff opens", label: "Wrap long lines", level: 2, default: DEFAULT_WRAP,
    read: () => diffWrap(), validate: bool, write: (v) => setDiffWrap(v as boolean),
  }),
  defineSetting({
    id: "diff.syntaxTheme", page: "diff", section: "How a diff opens", label: "Diff syntax theme", level: 2, default: "auto",
    read: () => diffThemePref(), validate: oneOf(SYNTAX_IDS), write: (v) => setDiffThemePref(v as string),
  }),
];

// ── terminal: how it draws ──────────────────────────────────────────────────

const DRAWS = "How it draws";
const FONT_IDS = TERM_FONTS.map((f) => f.id);
// The faces the row offers: bundled ones, and the system ones this machine has.
const fontOffered = (id: string) => { const f = TERM_FONTS.find((x) => x.id === id); return !!f && (f.bundled || fontAvailable(f.family) || id === ""); };

const terminal: SettingDef[] = [
  defineSetting({
    id: "terminal.renderer", page: "terminal", section: DRAWS, label: "Terminal renderer", level: 2, default: "auto",
    read: () => rendererPref(), validate: oneOf(["auto", "gpu", "canvas", "dom"] as const),
    write: (v) => setRendererPref(v as RendererPref),
  }),
  defineSetting({
    id: "terminal.font", page: "terminal", section: DRAWS, label: "Font", level: 2, default: "",
    read: () => currentTermFont(),
    validate: (raw) => { const v = oneOf(FONT_IDS)(raw); return v !== null && fontOffered(v) ? v : null; },
    write: (v) => setTermFont(v as string),
  }),
  defineSetting({
    id: "terminal.fontSize", page: "terminal", section: DRAWS, label: "Font size", level: 2, default: DEFAULT_SIZE,
    read: () => currentTermSize(), validate: intIn(SIZE_MIN, SIZE_MAX), write: (v) => setTermSize(v as number),
  }),
  defineSetting({
    id: "terminal.lineHeight", page: "terminal", section: DRAWS, label: "Line height", level: 2, default: DEFAULT_LINE_HEIGHT,
    read: () => currentTermLineHeight(),
    // Hundredths, the way the stepper moves it; the pref module clamps on read as well.
    validate: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= LINE_HEIGHT_MIN && raw <= LINE_HEIGHT_MAX ? Math.round(raw * 100) / 100 : null),
    write: (v) => setTermLineHeight(v as number),
  }),
  defineSetting({
    id: "terminal.cursor", page: "terminal", section: DRAWS, label: "Cursor", level: 2, default: "block",
    read: () => currentTermCursor(), validate: oneOf(CURSORS.map((c) => c.v) as CursorStyle[]),
    write: (v) => setTermCursor(v as CursorStyle),
  }),
];

// ── rail: which drawer each view sits in ────────────────────────────────────

/** Where a view lands when it is put in a drawer by choosing the drawer: the end
 *  of the top group, the front of the others. What the row's Select has always done. */
export function placeInRail(viewId: string, place: RailPlace): void {
  const v = VIEWS.find((x) => x.id === viewId);
  if (!v) return;
  moveView(v.id, place, place === "work" ? railIds(loadRail()).work.length : 0);
}

const rail: SettingDef[] = VIEWS.map((v) => defineSetting({
  id: `rail.place.${v.id}`, page: "rail", section: "What is on the rail", label: `${v.label} on the rail`, level: 2,
  // Where the shipped rail puts it; differs per view.
  default: RAIL_PLACES.find((p) => SHIPPED_RAIL[p].some((x) => x.id === v.id)) ?? "hidden",
  read: () => RAIL_PLACES.find((p) => railIds(loadRail())[p].includes(v.id)) ?? "hidden",
  validate: oneOf(RAIL_PLACES),
  write: (p) => placeInRail(v.id, p as RailPlace),
  // The whole layout, because one move shifts its neighbours.
  capture: () => railIds(loadRail()),
  restore: (t) => saveRail(t as ReturnType<typeof railIds>),
}));

// ── the registry ────────────────────────────────────────────────────────────

export const SETTING_DEFS: readonly SettingDef[] = [...appearance, ...diff, ...terminal, ...rail];

/** Which panes (and, for Terminal, which groups) have been migrated. A row in
 *  here must carry a settingId or be marked agentExempt; a guard test reads this. */
export const MIGRATED: Readonly<Record<string, "all" | readonly string[]>> = {
  appearance: "all",
  diff: "all",
  rail: "all",
  terminal: [DRAWS],
};

/** The panes with nothing migrated yet. Every Settings page is on exactly one of
 *  the two lists, so adding a page forces a decision rather than a silent gap. */
export const NOT_YET_MIGRATED = [
  "prefs", "notifications", "keys", "browser", "tasks", "hooks", "lantern", "understudy", "budgets", "recipes",
  "review-prompts", "saved-replies", "connections", "clickup", "remote", "plugins", "tmux", "privacy", "about", "log", "onboarding",
] as const;

/** The highest level of write an agent may make from this window. */
export const AGENT_MAX_LEVEL = 2;

/** Whether a row in (pane, section) is expected to be bound to a def. */
export function isMigrated(pane: string, section: string): boolean {
  const m = MIGRATED[pane];
  return m === "all" || (Array.isArray(m) && m.includes(section));
}

/** A settingId on a row may name a family (`rail.place.*`) when the row draws
 *  one control per member; it is valid when at least one def has the prefix. */
export function settingIdResolves(id: string, defs: readonly SettingDef[] = SETTING_DEFS): boolean {
  return id.endsWith(".*") ? defs.some((d) => d.id.startsWith(id.slice(0, -1))) : defs.some((d) => d.id === id);
}

// ── the agent's side ────────────────────────────────────────────────────────

/** One agent write, kept so it can be taken back and shown. */
export interface AgentChange {
  handle: string;
  id: string;
  label: string;
  prev: SettingValue;
  value: SettingValue;
  at: number;
  /** Still offered on the chip. Cleared by undo, dismissal and expiry; the
   *  record stays so the handle keeps meaning something. */
  shown: boolean;
  undone: boolean;
  revert: () => void;
}

const KEPT = 20;
/** How many agent writes the window remembers. */
export const AGENT_CHANGES_KEPT = KEPT;

export interface SettingsApi {
  list(): { id: string; page: string; section: string; label: string; writable: boolean; secret: boolean; value?: SettingValue }[];
  get(id: unknown): AgentGetResult;
  set(id: unknown, value: unknown): AgentSetResult;
  undo(handle: string): boolean;
  dismiss(handle: string): void;
  changes(): readonly AgentChange[];
  subscribeChanges(fn: () => void): () => void;
}

/**
 * The agent-facing functions over a list of defs. The defs are a parameter so a
 * test can hand it a secret, a level-3 setting and a def that was never
 * migrated and watch each be refused; the app uses `settings` below.
 */
export function makeSettings(defs: readonly SettingDef[], now: () => number = Date.now): SettingsApi {
  const byId = new Map(defs.map((d) => [d.id, d] as const));
  let log: AgentChange[] = [];
  let seq = 0;
  const watchers = new Set<() => void>();
  const touch = () => { log = [...log]; for (const fn of [...watchers]) fn(); };

  const find = (id: unknown) => (typeof id === "string" ? byId.get(id) : undefined);

  return {
    list: () => defs.map((d) => ({
      id: d.id, page: d.page, section: d.section, label: d.label,
      // Secrets are listed, so the agent knows they exist, and never writable.
      writable: !d.secret && (d.level ?? 3) <= AGENT_MAX_LEVEL,
      secret: !!d.secret,
      ...(d.secret ? {} : { value: d.get() }),
    })),
    get(id) {
      const d = find(id);
      if (!d) return { ok: false, error: "not exposed" };
      if (d.secret) return { ok: true, id: d.id, set: !!d.get() };
      return { ok: true, id: d.id, value: d.get() };
    },
    set(id, value) {
      const d = find(id);
      if (!d) return { ok: false, error: "not exposed" };
      if (d.secret) return { ok: false, error: "secret: not writable through this channel" };
      if (!((d.level ?? 3) <= AGENT_MAX_LEVEL)) return { ok: false, error: "needs a higher level than this channel grants" };
      announcing = "agent";
      let r: SetResult;
      try { r = d.set(value); } finally { announcing = "row"; }
      if (!r.ok) return r;
      // Already that value: nothing was replaced, so there is nothing to undo and
      // no chip to show. This is also what a second window of the same app sees,
      // since a command is delivered to every window and they share one store;
      // without it that window offered an "x → x" chip whose Undo did nothing.
      if (r.prev === r.value) return { ok: true, id: d.id, prev: r.prev, value: r.value, undo: "", unchanged: true };
      const handle = `u${++seq}`;
      log = [...log, { handle, id: d.id, label: d.label, prev: r.prev, value: r.value, at: now(), shown: true, undone: false, revert: r.revert }].slice(-KEPT);
      touch();
      return { ok: true, id: d.id, prev: r.prev, value: r.value, undo: handle };
    },
    undo(handle) {
      const c = log.find((x) => x.handle === handle);
      if (!c || c.undone) return false;
      announcing = "undo";
      try { c.revert(); } finally { announcing = "row"; }
      c.undone = true;
      c.shown = false;
      touch();
      return true;
    },
    dismiss(handle) {
      const c = log.find((x) => x.handle === handle);
      if (c && c.shown) { c.shown = false; touch(); }
    },
    changes: () => log,
    subscribeChanges: (fn) => { watchers.add(fn); return () => { watchers.delete(fn); }; },
  };
}

export const settings = makeSettings(SETTING_DEFS);

/** The def a Settings row binds to. Throws on a typo, at the first render. */
export function setting(id: string): SettingDef {
  const d = SETTING_DEFS.find((x) => x.id === id);
  if (!d) throw new Error(`no setting ${id}`);
  return d;
}

/** The chip's subject: the newest change still on offer. */
export function shownChange(log: readonly AgentChange[]): AgentChange | null {
  for (let i = log.length - 1; i >= 0; i--) if (log[i]!.shown) return log[i]!;
  return null;
}
