/*
 * What each Settings pane shows, as plain data, for the agent's reads.
 *
 * Two kinds, and the split is where the value lives:
 *
 *  - Held by the window (localStorage, a store): read at once from the pref
 *    module the pane itself calls. This file composes those getters and adds
 *    none of its own logic.
 *  - Held by the server: read by calling the same `api` function the pane calls,
 *    when the read is asked and not before. There is no cache and no poll, so a
 *    read is as fresh as opening the pane, and costs one request.
 *
 * Every function here chooses its fields by NAME. A result is never passed on
 * whole, so a field the server adds tomorrow (a path to a token file, a plugin's
 * own settings, a repository URL with a password in it) stays out until somebody
 * writes it into the shape below and a test says why it may be there. The shapes
 * are the contract uiSnapshots.ts turns into an answer; strings that came from
 * outside it files under `untrusted`.
 */
import type { ViewId } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { currentScale } from "./uiScale.ts";
import { clock24 } from "./clockPref.ts";
import { splashOn } from "./splashPref.ts";
import { currentAccent } from "./accent.ts";
import { themeMode, desktopPaletteName } from "./themes.ts";
import { VIEW_IDS } from "../../../shared/uiActions.ts";
import {
  bindings, chordFor, hasCustomChord, appChordFor, hasCustomAppChord, isCustomised, chordsCustomised, appChordsCustomised,
  APP_CHORD_DEFAULTS, type AppChordId,
} from "./keybindings.ts";
import { loadRail, railIds, railCustomised } from "../components/workspace/views.ts";
import { taskLanding, lastTaskSource } from "./taskLanding.ts";
import { orderedTaskSources, taskSourceShown, TASK_SOURCES } from "./taskSources.ts";
import { getUnderstudy } from "./understudyStore.ts";
import { paceConfig } from "./paceConfig.ts";
import { usageRefreshOn } from "./usageRefreshPref.ts";
import { chatEnginePref } from "./chatEnginePref.ts";

// ── held by the window ──────────────────────────────────────────────────────

export interface PrefsData { scale: number; clock24: boolean; splash: boolean }
export const readPrefs = (): PrefsData => ({ scale: currentScale(), clock24: clock24(), splash: splashOn() });

export interface RailData { work: string[]; utility: string[]; hidden: string[]; customised: boolean }
export function readRail(): RailData {
  const ids = railIds(loadRail());
  return { work: ids.work, utility: ids.utility, hidden: ids.hidden, customised: railCustomised() };
}

export interface KeysData {
  /** What the owner pressed: their own text, never an instruction. */
  bindings: Record<string, string>;
  chords: Record<string, string>;
  appChords: Record<string, string>;
  customised: { bindings: boolean; chords: boolean; appChords: boolean };
  customChord: string[];
  customAppChord: string[];
}
export function readKeys(): KeysData {
  const views = [...VIEW_IDS] as ViewId[];
  const apps = Object.keys(APP_CHORD_DEFAULTS) as AppChordId[];
  return {
    bindings: { ...bindings() },
    chords: Object.fromEntries(views.map((v) => [v, chordFor(v)])),
    appChords: Object.fromEntries(apps.map((a) => [a, appChordFor(a)])),
    customised: { bindings: isCustomised(), chords: chordsCustomised(), appChords: appChordsCustomised() },
    customChord: views.filter(hasCustomChord),
    customAppChord: apps.filter(hasCustomAppChord),
  };
}

export interface TasksData { landing: string; order: string[]; shown: Record<string, boolean>; last: string | null }
export const readTasks = (): TasksData => ({
  landing: taskLanding(),
  order: orderedTaskSources(),
  shown: Object.fromEntries(TASK_SOURCES.map((s) => [s.id, taskSourceShown(s.id)])),
  last: lastTaskSource(),
});

export interface AppearanceData { mode: string; accent: string; desktopPalette: { source: string; name: string } | null }
export const readAppearance = (): AppearanceData => ({ mode: themeMode(), accent: currentAccent(), desktopPalette: desktopPaletteName() });

export interface UnderstudyData {
  enabled: boolean; halted: boolean; level: string; agreement: number | null;
  classes: { id: string; label: string; lock: string; mode: string; offered: boolean; n: number; hits: number }[];
}
/** The scorecard the store holds, or null before the first frame has arrived. */
export function readUnderstudy(): UnderstudyData | null {
  const f = getUnderstudy();
  if (!f) return null;
  return {
    enabled: f.enabled, halted: f.halted, level: String(f.level), agreement: f.agreement,
    classes: f.classes.map((c) => ({ id: c.id, label: c.label, lock: String(c.lock), mode: String(c.mode), offered: c.offered, n: c.n, hits: c.hits })),
  };
}

// ── held by the server ──────────────────────────────────────────────────────

export interface HooksData {
  installed: boolean; bundled: boolean; gate: boolean; gateBundled: boolean; python: string; settingsPath: string; engine: string;
}
export async function readHooks(): Promise<HooksData> {
  const h = await api.hooksStatus();
  return {
    installed: h.installed, bundled: h.bundled, gate: h.gate, gateBundled: h.gateBundled,
    python: h.python, settingsPath: h.settingsPath, engine: String(chatEnginePref() ?? "default"),
  };
}

export interface LanternData { nudge: boolean; minutes: number; watch: boolean; watchMinutes: number; cacheTtlMinutes: number; wakeHours: number | null }
export async function readLantern(): Promise<LanternData> {
  const [l, w] = await Promise.all([api.lanternSettings(), api.seatWake().catch(() => null)]);
  return { nudge: l.nudge, minutes: l.minutes, watch: l.watch, watchMinutes: l.watchMinutes, cacheTtlMinutes: l.cacheTtlMinutes, wakeHours: w && w.ok ? w.hours : null };
}

export interface BudgetsData {
  rows: { root: string; model: string; limit: number; period: string; spent: number; pct: number; level: string }[];
  models: number;
  pace: { spread: string; workDays: boolean[]; workStart: number; workEnd: number; rollover: boolean; burnWindowHours: number; alertAt: number; timeZone: string };
  usageRefresh: boolean;
}
export async function readBudgets(): Promise<BudgetsData> {
  const b = await api.budgets();
  const p = paceConfig();
  return {
    rows: b.status.map((s) => ({ root: s.budget.root, model: s.budget.model, limit: s.budget.limit, period: String(s.budget.period), spent: s.spent, pct: s.pct, level: s.level })),
    models: b.models.length,
    pace: { spread: p.spread, workDays: [...p.workDays], workStart: p.workStart, workEnd: p.workEnd, rollover: p.rollover, burnWindowHours: p.burnWindowHours, alertAt: p.alertAt, timeZone: p.timeZone },
    usageRefresh: usageRefreshOn(),
  };
}

export interface RecipeRow { id: string; name: string; desc: string; scope: string; repo: string; steps: number; params: number; tmux: boolean; confirm: boolean }
export async function readRecipes(): Promise<RecipeRow[]> {
  const r = await api.recipes();
  return (r.recipes ?? []).map((x) => ({
    id: x.id, name: x.name, desc: x.desc, scope: x.scope, repo: x.repo ?? "",
    steps: x.steps.length, params: x.params?.length ?? 0, tmux: !!x.tmux, confirm: !!x.confirm,
  }));
}

export interface ReviewPromptRow { id: string; title: string; group: string; when: string; builtIn: boolean; hidden: boolean; hasSkill: boolean; chars: number }
export async function readReviewPrompts(): Promise<ReviewPromptRow[]> {
  const r = await api.prPrompts();
  return (r.recipes ?? []).map((x) => ({
    id: x.id, title: x.title, group: String(x.group), when: String(x.when), builtIn: !!x.builtIn, hidden: !!x.hidden,
    hasSkill: !!x.skill, chars: x.body.length,
  }));
}

export interface SavedReplyRow { id: string; title: string; chars: number }
export async function readSavedReplies(): Promise<SavedReplyRow[]> {
  const r = await api.savedReplies();
  return (r.replies ?? []).map((x) => ({ id: x.id, title: x.title, chars: x.text.length }));
}

export interface TmuxData {
  source: string; binAvailable: boolean; binVersion: string; capability: boolean; confMode: string; overrideActive: boolean;
  broken: boolean; restoreEnabled: boolean; resumeMode: string; prefix: string; terminal: string; lastCaptureAt: number | null;
  /** The reasons and the tmux.conf text the owner typed. */
  reasons: { bin: string; capability: string; broken: string; override: string };
}
export async function readTmux(): Promise<TmuxData> {
  const t = await api.tmuxStatus();
  return {
    source: t.source, binAvailable: t.bin.available, binVersion: t.bin.version ?? "", capability: t.capability.available,
    confMode: t.confMode, overrideActive: t.overrideActive, broken: t.broken, restoreEnabled: t.restoreEnabled,
    resumeMode: t.resumeMode, prefix: t.prefix, terminal: t.terminal, lastCaptureAt: t.lastCaptureAt,
    reasons: { bin: t.bin.reason, capability: t.capability.reason, broken: t.brokenReason, override: t.override },
  };
}

/** The route also names the credentials file; that path is not read here. */
export interface PrivacyData { retentionDays: number; pairedDevices: number; clickupSet: boolean; db: string; config: string }
export async function readPrivacy(): Promise<PrivacyData> {
  const p = await api.privacy();
  return { retentionDays: p.retentionDays, pairedDevices: p.pairedDevices, clickupSet: p.clickup, db: p.db, config: p.config };
}

export interface PluginsData {
  master: boolean;
  plugins: { name: string; publisher: string; description: string; enabled: boolean; running: boolean; scope: string; sourceKind: string; hadApproval: boolean; changedSinceApproval: boolean }[];
}
/** Never the plugin's own `settings`, its install directory, hashes or source URL. */
export async function readPlugins(): Promise<PluginsData> {
  const s = await api.plugins();
  return {
    master: s.master,
    plugins: s.plugins.map((p) => ({
      name: p.name, publisher: p.publisher, description: p.description, enabled: p.enabled, running: p.running,
      scope: String(p.scope), sourceKind: p.source.kind, hadApproval: p.hadApproval,
      changedSinceApproval: p.approvedHash !== null && p.approvedHash !== p.manifestHash,
    })),
  };
}

export interface LogData { rows: { id: number; at: number; actor: string; action: string; ok: boolean; target: string; detail: string }[] }
/** The latest actions only: the pane shows 200, an agent needs the tail. */
export const LOG_ROWS = 30;
export async function readLog(): Promise<LogData> {
  const r = await api.actions(LOG_ROWS);
  return { rows: (r.actions ?? []).slice(0, LOG_ROWS).map((a) => ({ id: a.id, at: a.at, actor: a.actor, action: a.action, ok: a.ok, target: a.target, detail: a.detail ?? "" })) };
}

export interface AboutData {
  version: string; commit: string; stamp: string; builtAt: string; baseTag: string; distance: number; dirty: boolean; dirtyCount: number;
  branch: string; behind: number; ahead: number; available: boolean; blocked: string;
  incoming: { sha: string; subject: string }[];
  digest: { total: number; quiet: boolean; groups: number; crashLoops: number; spikes: number } | null;
  origin: string;
}
export const ABOUT_INCOMING = 10;
export async function readAbout(): Promise<AboutData> {
  const [u, d] = await Promise.all([api.updateStatus(), api.logDigest().catch(() => null)]);
  return {
    version: u.info.version, commit: u.info.commit, stamp: u.info.stamp, builtAt: u.info.builtAt, baseTag: u.info.baseTag,
    distance: u.info.distance, dirty: u.info.dirty, dirtyCount: u.info.dirtyCount, branch: u.branch, behind: u.behind, ahead: u.ahead,
    available: u.available, blocked: u.blocked ?? "", incoming: u.incoming.slice(0, ABOUT_INCOMING).map((c) => ({ sha: c.sha, subject: c.subject })),
    digest: d ? { total: d.total, quiet: d.quiet, groups: d.groups.length, crashLoops: d.crashLoops.length, spikes: d.spikes.length } : null,
    origin: u.info.origin,
  };
}
