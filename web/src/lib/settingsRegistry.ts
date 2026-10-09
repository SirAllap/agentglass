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
 * Migrated: Appearance, Diff, Rail, Terminal, the part of Notifications that cannot
 * hide a stopped agent, the search engine, what Tasks shows, and the single-key
 * shortcuts. A row an agent must not reach is marked `agentNever="why"` and a
 * whole page left out is in NOT_EXPOSED_ON_PURPOSE with its reason (remote,
 * tokens, plugin trust, the gate and hooks, consent: nothing that gives an agent
 * more power or lets it silence the owner's alerts). Every other pane is listed in
 * NOT_YET_MIGRATED, on purpose: a new pane has to be put on one list or the other, and a test
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
import { focusFollowsMouse, setFocusFollowsMouse } from "./termFocusPref.ts";
import { paneActionsMode, setPaneActionsMode } from "./paneActionsPref.ts";
import { tabGroupsOn, setTabGroupsOn, tabGroupRulesText, setTabGroupRulesText } from "./tabGroups.ts";
import {
  copyOnSelect, setCopyOnSelect, currentNoteEditor, setNoteEditor, NOTE_EDITORS, currentScrollback, setScrollback,
  SCROLLBACK_SIZES, DEFAULT_SCROLLBACK, currentWordSeparators, setWordSeparators, DEFAULT_WORD_SEPARATORS, type NoteEditor,
} from "./termPrefs.ts";
import { notifyQuiet, setNotifyQuiet } from "./sysNotify.ts";
import { ciOnlyApproved, setCiOnlyApproved, CI_ONLY_APPROVED_DEFAULT } from "./ciNotifyPref.ts";
import { talkNotify, setTalkNotify, TALK_NOTIFY_DEFAULT, type TalkNotify } from "./talkNotify.ts";
import { searchEngine, setSearchEngine } from "./browserPrefs.ts";
import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINE_LABELS, type SearchEngine } from "./browserUrl.ts";
import { countedSpacesNow, setCountedSpaces } from "./clickupPrefs.ts";
import { taskLanding, setTaskLanding, type TaskLanding } from "./taskLanding.ts";
import { TASK_SOURCES, taskSourceShown, setTaskSourceShown, shownTaskSources, type TaskSourceId } from "./taskSources.ts";
import { bindings, rebind, DEFAULTS as DEFAULT_BINDINGS, LABELS as KEY_LABELS, type ActionId } from "./keybindings.ts";
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
  validate: Validator;
  /** Apply it. A returned string is the pref module refusing, in its own words
   *  (a key already bound, the last task source): nothing was stored, and the
   *  sentence reaches the row and the agent alike. */
  write(v: SettingValue): void | string;
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
      if (v === null) return { ok: false, error: refusal(s.id, s.validate) };
      const prev = get();
      const token = s.capture ? s.capture() : prev;
      const refused = s.write(v);
      if (typeof refused === "string") return { ok: false, error: refused };
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

/** A validator that can say what it takes, so a refusal names the way out. */
export type Validator = ((raw: unknown) => SettingValue | null) & { accepts?: string | (() => string) };

const accepting = <F extends (raw: unknown) => SettingValue | null>(fn: F, accepts: string | (() => string)): F & { accepts: string | (() => string) } =>
  Object.assign(fn, { accepts });

/** What a refused write says: the setting and what IS accepted, so an agent can
 *  correct itself in one step instead of probing. Measured: the bare "not a
 *  valid value for diff.split" left the caller guessing between "unified",
 *  "side-by-side" and "inline". */
export function refusal(id: string, validate: Validator): string {
  const a = typeof validate.accepts === "function" ? validate.accepts() : validate.accepts;
  return a ? `not a valid value for ${id}; accepted: ${a}` : `not a valid value for ${id}`;
}

const oneOf = <T extends string>(values: readonly T[]) => accepting((raw: unknown): T | null =>
  typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : null,
  `one of ${values.map((v) => (v === "" ? '"" (the default)' : v)).join(", ")}`);

/** A whole number in range; a number outside it is refused, not clamped, so an
 *  agent that asks for 400px hears about it instead of getting 22. */
const intIn = (min: number, max: number) => accepting((raw: unknown): number | null =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null,
  `a whole number from ${min} to ${max}`);

const bool = accepting((raw: unknown): boolean | null => (typeof raw === "boolean" ? raw : null), "true or false");

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
    validate: accepting((raw) => (raw === "desktop" ? (desktopPaletteName() ? "desktop" : null) : oneOf(MODE_VALUES)(raw)),
      () => `one of ${[...MODE_VALUES, ...(desktopPaletteName() ? ["desktop"] : [])].join(", ")}`),
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
    validate: accepting((raw) => { const v = oneOf(FONT_IDS)(raw); return v !== null && fontOffered(v) ? v : null; },
      () => `one of ${FONT_IDS.filter(fontOffered).map((v) => (v === "" ? '"" (the default)' : v)).join(", ")}`),
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
    validate: accepting((raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= LINE_HEIGHT_MIN && raw <= LINE_HEIGHT_MAX ? Math.round(raw * 100) / 100 : null),
      `a number from ${LINE_HEIGHT_MIN} to ${LINE_HEIGHT_MAX}`),
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

// ── terminal: the rest of the pane ──────────────────────────────────────────

const MOUSE = "Mouse and clipboard";
const TABS = "Tab groups";
const HISTORY = "History and selection";
/** The longest free text one of these may be (rules and separators, not prose). */
const MAX_TEXT = 200;
const text = accepting((raw: unknown): string | null => (typeof raw === "string" && raw.length <= MAX_TEXT ? raw : null), `a string of at most ${MAX_TEXT} characters`);

const terminalMore: SettingDef[] = [
  defineSetting({
    id: "terminal.focusFollowsMouse", page: "terminal", section: MOUSE, label: "Focus follows mouse", level: 2, default: false,
    read: () => focusFollowsMouse(), validate: bool, write: (v) => setFocusFollowsMouse(v as boolean),
  }),
  defineSetting({
    id: "terminal.paneBar", page: "terminal", section: MOUSE, label: "Bar on a pane", level: 2, default: true,
    // The pref module stores "hover" or "off"; the row is a switch, so the def is one too.
    read: () => paneActionsMode() !== "off", validate: bool, write: (v) => setPaneActionsMode(v ? "hover" : "off"),
  }),
  defineSetting({
    id: "terminal.copyOnSelect", page: "terminal", section: MOUSE, label: "Copy on select", level: 2, default: true,
    read: () => copyOnSelect(), validate: bool, write: (v) => setCopyOnSelect(v as boolean),
  }),
  defineSetting({
    id: "terminal.noteEditor", page: "terminal", section: "Bench note", label: "Note editor", level: 2, default: "builtin",
    read: () => currentNoteEditor(), validate: oneOf(NOTE_EDITORS.map((e) => e.v) as NoteEditor[]), write: (v) => setNoteEditor(v as NoteEditor),
  }),
  defineSetting({
    id: "terminal.tabGroups", page: "terminal", section: TABS, label: "Group tabs by project", level: 2, default: true,
    read: () => tabGroupsOn(), validate: bool, write: (v) => setTabGroupsOn(v as boolean),
  }),
  defineSetting({
    id: "terminal.tabGroupRules", page: "terminal", section: TABS, label: "Group by name", level: 2, default: "",
    read: () => tabGroupRulesText(),
    // Text the module trims to nothing is stored as nothing; say that up front so
    // the value reported back is the value the next read gives.
    validate: accepting((raw) => { const t = text(raw); return t === null ? null : t.trim() === "" ? "" : t; }, text.accepts),
    write: (v) => setTabGroupRulesText(v as string),
  }),
  defineSetting({
    id: "terminal.scrollback", page: "terminal", section: HISTORY, label: "Scrollback", level: 2, default: DEFAULT_SCROLLBACK,
    read: () => currentScrollback(),
    validate: accepting((raw) => (typeof raw === "number" && (SCROLLBACK_SIZES as readonly number[]).includes(raw) ? raw : null),
      `one of ${SCROLLBACK_SIZES.join(", ")} (lines)`),
    write: (v) => setScrollback(v as number),
  }),
  defineSetting({
    id: "terminal.wordSeparators", page: "terminal", section: HISTORY, label: "Word separators", level: 2, default: DEFAULT_WORD_SEPARATORS,
    read: () => currentWordSeparators(), validate: text, write: (v) => setWordSeparators(v as string),
  }),
];

// ── notifications: the ones that cannot hide a stopped agent ────────────────

// Not here, on purpose: the kind and channel switches, "Silence all", the voices
// (one of them is Silent), and the two rows that read other apps' notifications.
// Each decides whether an agent that is blocked on the owner can reach them.
const notifications: SettingDef[] = [
  defineSetting({
    id: "notifications.quiet", page: "notifications", section: "How it reaches you", label: "Quiet — only what is stopped interrupts", level: 2, default: true,
    read: () => notifyQuiet(), validate: bool, write: (v) => setNotifyQuiet(v as boolean),
  }),
  defineSetting({
    id: "notifications.ciOnlyApproved", page: "notifications", section: "Pull requests", label: "Checks: only when the pull request is approved", level: 2,
    default: CI_ONLY_APPROVED_DEFAULT, read: () => ciOnlyApproved(), validate: bool, write: (v) => setCiOnlyApproved(v as boolean),
  }),
  defineSetting({
    id: "notifications.talk", page: "notifications", section: "Pull requests", label: "Conversation: when somebody says something", level: 2, default: TALK_NOTIFY_DEFAULT,
    read: () => talkNotify(), validate: oneOf(["everything", "reviews", "off"] as TalkNotify[]), write: (v) => setTalkNotify(v as TalkNotify),
  }),
];

// ── browser: where an address-bar word goes ─────────────────────────────────

// Not here: the home page (a page the browser opens by itself, with the owner's
// sessions) and the cookie and history import (credentials).
const browser: SettingDef[] = [
  defineSetting({
    id: "browser.searchEngine", page: "browser", section: "", label: "Search engine", level: 2, default: DEFAULT_SEARCH_ENGINE,
    read: () => searchEngine(), validate: oneOf(Object.keys(SEARCH_ENGINE_LABELS) as SearchEngine[]), write: (v) => setSearchEngine(v as SearchEngine),
  }),
];

// ── tasks: what the view shows ──────────────────────────────────────────────

const TASK_LANDINGS = ["last", "all", ...TASK_SOURCES.map((s) => s.id)] as TaskLanding[];
const tasks: SettingDef[] = [
  defineSetting({
    id: "tasks.landing", page: "tasks", section: "Opens on", label: "Tasks view opens on", level: 2, default: "last",
    read: () => taskLanding(), validate: oneOf(TASK_LANDINGS), write: (v) => setTaskLanding(v as TaskLanding),
  }),
  ...TASK_SOURCES.map((src) => defineSetting({
    id: `tasks.source.${src.id}`, page: "tasks", section: "Task sources", label: `${src.label} in the Tasks view`, level: 2, default: true,
    read: () => taskSourceShown(src.id), validate: bool,
    // The module keeps the last visible source and says nothing; an agent, and
    // the row, are told instead of being shown a switch that did not move.
    write: (v) => {
      if (!v && taskSourceShown(src.id) && shownTaskSources().length <= 1) return "at least one task source stays shown";
      setTaskSourceShown(src.id, v as boolean);
    },
  })),
];

// ── clickup: the part of the page that is not the connection ────────────────

/** Space ids as one comma-separated string (a def's value is a scalar), "" for none chosen. Digits only:
 *  an id is the one thing this can name, and anything else is refused rather than saved to match nothing. */
const spaceIds = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const ids = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length > 200 || ids.some((x) => !/^[0-9]{1,20}$/.test(x))) return null;
  return [...new Set(ids)].join(",");
};
const splitIds = (v: SettingValue): string[] => String(v).split(",").filter(Boolean);

const clickup: SettingDef[] = [
  defineSetting({
    id: "clickup.statusSpaces.counted", page: "clickup", section: "", label: "Spaces that count for statuses", level: 2, default: "",
    read: () => countedSpacesNow().join(","), validate: spaceIds,
    // The same save the page's buttons make, through /clickup/prefs; the pick is re-read locally, never from ClickUp.
    write: (v) => { setCountedSpaces(splitIds(v)); },
  }),
];

// ── keys: the single-letter shortcuts ───────────────────────────────────────

// Not here: the view chords and the "even inside a shell" app chord. Those are
// delivered while a terminal has the focus, so a binding made for the owner could
// shadow a key their shell needs; they stay the owner's to press.
const keys: SettingDef[] = (Object.keys(KEY_LABELS) as ActionId[]).map((a) => defineSetting({
  id: `keys.binding.${a}`, page: "keys", section: "Keys", label: KEY_LABELS[a].label, level: 2, default: DEFAULT_BINDINGS[a],
  read: () => bindings()[a],
  // Length is the module's to judge ("pick a single character"), in its own words.
  validate: accepting((raw) => (typeof raw === "string" && raw.length >= 1 && raw.length <= 16 ? raw : null), "a key, 1 to 16 characters"),
  // The module refuses a reserved key and one another action holds, in words.
  write: (v) => { const r = rebind(a, v as string); if (!r.ok) return r.error; },
}));

// ── the registry ────────────────────────────────────────────────────────────

export const SETTING_DEFS: readonly SettingDef[] = [...appearance, ...diff, ...terminal, ...terminalMore, ...rail, ...notifications, ...browser, ...tasks, ...clickup, ...keys];

/** Which panes (and, for Terminal, which groups) have been migrated. A row in
 *  here must carry a settingId or be marked agentExempt; a guard test reads this. */
export const MIGRATED: Readonly<Record<string, "all" | readonly string[]>> = {
  appearance: "all",
  diff: "all",
  rail: "all",
  terminal: "all",
  notifications: "all",
  browser: "all",
  tasks: "all",
  /* Only what is not the connection: the page's own refusals are in NEVER_ON_PAGE. */
  clickup: [""],
  keys: "all",
};

/** The panes with nothing migrated yet. Every Settings page is on exactly one of
 *  the two lists, so adding a page forces a decision rather than a silent gap. */
export const NOT_YET_MIGRATED = [
  "prefs", "hooks", "lantern", "understudy", "budgets", "recipes",
  "review-prompts", "saved-replies", "connections", "remote", "plugins", "tmux", "privacy", "about", "log", "onboarding",
] as const;

/**
 * Pages that are not migrated and WILL NOT be without a decision about their
 * risk, with the reason. Every one is also in NOT_YET_MIGRATED (a test holds
 * the two together), so the list of what is merely not done yet is the rest.
 */
export const NOT_EXPOSED_ON_PURPOSE: Readonly<Record<string, string>> = {
  connections: "tokens and credentials of the services the app talks to: an agent never reads or writes them",
  remote: "reaching this machine from outside: who may pair and how is the owner's alone, at any level",
  plugins: "plugin trust and consent: approving what a plugin may do cannot be something another agent does for the owner",
  hooks: "the gate and the hook install decide what an agent may do without asking: no agent edits its own leash",
  understudy: "consent and the level at which a stand-in may decide for the owner",
  lantern: "every setting here is held by the server and changes what the app sends outward (prompts nudged into agents, notification sweeps, the orchestrator's wake that spends tokens), and a def's write is synchronous",
  tmux: "which tmux the terminal runs on and its config text: it changes what runs a shell",
  privacy: "retention and data export: what the app keeps and gives away",
};



/**
 * Pages that carry a def AND something an agent must never reach. The page is
 * migrated for what is not secret-class; what is, is held here with the reason,
 * and a test refuses a def on the page that is a secret or whose id names one of
 * these words (token, connection, workspace, account, credential, remote).
 */
export const NEVER_ON_PAGE: Readonly<Record<string, { pattern: RegExp; why: string }>> = {
  clickup: {
    pattern: /token|connect|workspace|account|credential|secret|remote|writes?\b/i,
    why: "the ClickUp token, the workspace link and the switch that lets agentglass write to a board: what the app is allowed to do with the owner's account is the owner's alone",
  },
};

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
  /** The name the caller stamped on the call (`--as`), if it gave one. */
  as?: string;
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
  list(serverLevel?: number): { id: string; page: string; section: string; label: string; writable: boolean; secret: boolean; value?: SettingValue }[];
  get(id: unknown): AgentGetResult;
  set(id: unknown, value: unknown, as?: string): AgentSetResult;
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
    list: (serverLevel) => defs.map((d) => ({
      id: d.id, page: d.page, section: d.section, label: d.label,
      // Secrets are listed, so the agent knows they exist, and never writable.
      // Writable HERE: the lower of what this window caps an agent at and what the
      // server it is attached to holds, so a read-only server lists nothing writable.
      writable: !d.secret && (d.level ?? 3) <= Math.min(AGENT_MAX_LEVEL, serverLevel ?? AGENT_MAX_LEVEL),
      secret: !!d.secret,
      ...(d.secret ? {} : { value: d.get() }),
    })),
    get(id) {
      const d = find(id);
      if (!d) return { ok: false, error: "not exposed" };
      if (d.secret) return { ok: true, id: d.id, set: !!d.get() };
      return { ok: true, id: d.id, value: d.get() };
    },
    set(id, value, as) {
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
      log = [...log, { handle, id: d.id, label: d.label, prev: r.prev, value: r.value, at: now(), ...(as ? { as } : {}), shown: true, undone: false, revert: r.revert }].slice(-KEPT);
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
