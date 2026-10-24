/**
 * Where a plugin's pixels live between the plugin and the window.
 *
 * A plugin is still a separate process holding a scoped token (plugins.ts).
 * What changes is that it may now say what to show: a panel it declared, a
 * settings page it declared, notes on a pull request if it declared those.
 * It says it as data (shared/pluginUi.ts), this module keeps the latest of
 * each, and the window draws it with its own components. The plugin never
 * gets a handle on the window, and the window never runs a byte of the
 * plugin.
 *
 * Traffic the other way — a click, a submitted form, a note marked resolved —
 * becomes an event in a queue only that plugin can drain, over its own token.
 * The live stream every client shares carries nothing but "look again" pings,
 * so one plugin can never read what somebody typed into another's form.
 *
 * Panels and events are memory only: a panel is whatever the running plugin
 * last drew, and a stopped plugin's panel says so instead of showing a screen
 * nobody is behind. Notes and runs on pull requests are written to disk,
 * because a review read tomorrow is the point of writing one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  type Contributes, type Field, type FieldOption, type NoteReply, type NoteStatus, type PrNote, type PrNotesSummary, type PrRun, type UiAction, type UiNode,
  NOTE_STATUSES, REPLIES_PER_NOTE, coerceValue, validateReplyInput, validReplyBy, resolveSettings, validateNote, validateRun, validateTree, validPrRef,
} from "../../shared/pluginUi.ts";
import { pluginsConfigDir } from "./plugins.ts";
import type { PrChangedEvent } from "./prChanged.ts";
import { headNeedsRead, reviewStale, type HeadRead } from "../../shared/headCompare.ts";
import { forgetAnnotations } from "./inbox-annotations.ts";
import { forgetAccounts } from "./accounts.ts";
import { dropCanvases } from "./plugin-canvas.ts";

export type PluginUiFrame =
  /** `plugin`/`panel` name what was redrawn, so a window fetches that one
   *  panel rather than every plugin's every tree; absent means "the list of
   *  panels itself may have changed". */
  | { kind: "panels"; plugin?: string; panel?: string }
  | { kind: "pr"; repo: string; number: number };

/** plugins.ts says which plugins have a process. Events for one that does
 *  not are dropped rather than queued for whoever next runs under its name. */
let isLive: (plugin: string) => boolean = () => true;
export function setLivenessCheck(fn: (plugin: string) => boolean): void { isLive = fn; }

let onChange: (f: PluginUiFrame) => void = () => {};
/** index.ts wires this to `broadcast`, the same setter shape `setTaskChangeHook` uses. */
export function setPluginUiHook(fn: (f: PluginUiFrame) => void): void { onChange = fn; }

// ---------------------------------------------------------------- panels

interface PanelState { tree: UiNode; updatedAt: number }
const panels = new Map<string, Map<string, PanelState>>();

export function setPanel(plugin: string, c: Contributes, id: string, raw: unknown): { ok: true } | { ok: false; error: string } {
  if (!c.panels?.some((p) => p.id === id)) return { ok: false, error: `panel "${id}" is not declared in this plugin's manifest` };
  if (c.panels?.some((p) => p.id === id && p.canvas)) return { ok: false, error: `panel "${id}" is a live canvas: draw it with operations, POST /plugin/self/panel/${id}/ops` };
  const t = validateTree(raw);
  if (!t.ok) return { ok: false, error: t.error };
  let m = panels.get(plugin);
  if (!m) panels.set(plugin, (m = new Map()));
  m.set(id, { tree: t.value, updatedAt: Date.now() });
  onChange({ kind: "panels", plugin, panel: id });
  return { ok: true };
}

export function panelState(plugin: string, id: string): PanelState | null {
  return panels.get(plugin)?.get(id) ?? null;
}

// ------------------------------------------------------- settings options

/** Choices a plugin found at run time — which agents are installed, which
 *  models an agent offers — for a `select` its manifest could only name. */
const options = new Map<string, Map<string, FieldOption[]>>();

export function setOptions(plugin: string, c: Contributes, key: string, raw: unknown): { ok: true } | { ok: false; error: string } {
  const f = c.settings?.find((x) => x.key === key);
  if (!f) return { ok: false, error: `setting "${key}" is not declared in this plugin's manifest` };
  if (f.type !== "select" && f.type !== "multi") return { ok: false, error: `setting "${key}" has no options to set` };
  if (!Array.isArray(raw)) return { ok: false, error: "options must be a list" };
  const out: FieldOption[] = [];
  for (const o of raw.slice(0, f.type === "multi" ? 2000 : 200)) {
    if (typeof o === "string" && o.length <= 200) out.push({ value: o, label: o });
    else if (o && typeof o === "object" && typeof (o as FieldOption).value === "string") {
      const r = o as FieldOption;
      out.push({ value: r.value.slice(0, 200), label: typeof r.label === "string" ? r.label.slice(0, 120) : r.value.slice(0, 120) });
    }
  }
  let m = options.get(plugin);
  if (!m) options.set(plugin, (m = new Map()));
  m.set(key, out);
  onChange({ kind: "panels" });
  return { ok: true };
}

/** The manifest's fields with any run-time options folded in. */
export function fieldsWithOptions(plugin: string, fields: Field[] | undefined): Field[] {
  const m = options.get(plugin);
  return (fields ?? []).map((f) => ((f.type === "select" || f.type === "multi") && m?.has(f.key) ? { ...f, options: m.get(f.key) } : f));
}

export function coerceSettings(fields: Field[] | undefined, raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const f of fields ?? []) {
    if (!Object.prototype.hasOwnProperty.call(raw, f.key)) continue;
    const v = coerceValue(f, (raw as Record<string, unknown>)[f.key]);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

export { resolveSettings };

// ---------------------------------------------------------------- events

export type PluginEvent =
  | { type: "action"; panel?: string; action: UiAction; values?: Record<string, unknown>; at: number }
  | { type: "settings"; settings: Record<string, unknown>; at: number }
  | { type: "note-status"; repo: string; number: number; id: string; status: NoteStatus; at: number; reply?: NoteReply; replies?: NoteReply[] }
  | { type: "pr-open"; repo: string; number: number; at: number }
  | PrChangedEvent
  | { type: "pr-action"; id: string; repo: string; number: number; at: number }
  | { type: "note-action"; id: string; noteId: string; repo: string; number: number; at: number }
  | { type: "run-approve" | "run-skip"; id: string; repo: string; number: number; at: number }
  /** The person pressed a chip in the usage popover (only the desktop window can). */
  | { type: "account.switch"; provider: string; id: string; at: number }
  /** The person asked for the plugin's own page for the accounts of a provider. */
  | { type: "account.manage"; provider: string; at: number };

const MAX_QUEUE = 200;
const queues = new Map<string, PluginEvent[]>();
const waiters = new Map<string, Set<() => void>>();

export function pushEvent(plugin: string, ev: PluginEvent): void {
  if (!isLive(plugin)) return;
  let q = queues.get(plugin);
  if (!q) queues.set(plugin, (q = []));
  q.push(ev);
  // A plugin that stopped draining must not grow this without bound; the
  // oldest click is the one least worth acting on.
  if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
  for (const w of waiters.get(plugin) ?? []) w();
}

/**
 * Long poll: whatever is queued, or wait up to `waitMs` for something to be.
 * A plugin loops on this; a click reaches it in the time one request takes to
 * return, with no socket to hold and nothing for another plugin to overhear.
 */
export async function takeEvents(plugin: string, waitMs: number): Promise<PluginEvent[]> {
  const drain = () => { const q = queues.get(plugin) ?? []; if (queues.has(plugin)) queues.set(plugin, []); return q; };
  if ((queues.get(plugin)?.length ?? 0) > 0 || waitMs <= 0) return drain();
  await new Promise<void>((resolve) => {
    let set = waiters.get(plugin);
    if (!set) waiters.set(plugin, (set = new Set()));
    // A plugin needs one long poll, two across a reconnect. More than a few
    // is a leak or a loop; the oldest is answered now, empty.
    if (set.size >= 4) { const oldest = set.values().next().value; oldest?.(); }
    const done = () => { clearTimeout(t); set!.delete(done); resolve(); };
    const t = setTimeout(done, Math.min(waitMs, 30_000));
    set.add(done);
  });
  return drain();
}

/** A stopped or removed plugin leaves nothing behind that a successor under
 *  the same name would inherit: no screen, no half-read queue. */
export function forgetPlugin(plugin: string): void {
  panels.delete(plugin);
  options.delete(plugin);
  forgetAnnotations(plugin);
  forgetAccounts(plugin);
  dropCanvases(plugin);
  queues.delete(plugin);
  for (const w of waiters.get(plugin) ?? []) w();
  waiters.delete(plugin);
  onChange({ kind: "panels" });
}

// ---------------------------------------------------- notes on pull requests

/** What one run cost, by the UTC day it started. Kept apart from the run: the
 *  run list is capped per pull request, a day's total is not. Set, never added,
 *  so a plugin repeating a run's cost as it grows does not count it twice. */
interface CostRow { plugin: string; id: string; day: string; usd: number }
interface NotesStore { runs: (PrRun & { plugin: string })[]; notes: (PrNote & { plugin: string })[]; costs?: CostRow[] }
/** The ledger keeps this many days; the route answers at most as many. */
export const COST_DAYS_KEPT = 90;

let pathOverride: string | null = null;
/** Test seam, the `__setSavedRepliesPath` shape. */
export function __setPluginNotesPath(p: string | null): void { pathOverride = p; cache = null; summaryCache = null; }

function notesPath(): string {
  return pathOverride ?? join(pluginsConfigDir(), "plugin-notes.json");
}

const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

let cache: NotesStore | null = null;

function load(): NotesStore {
  if (cache) return cache;
  const p = notesPath();
  cache = { runs: [], notes: [] };
  if (offLimits(p) || !existsSync(p)) return cache;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<NotesStore>;
    cache = {
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      costs: Array.isArray(parsed.costs) ? parsed.costs : [],
    };
  } catch {
    // A corrupt file loses the notes, not the server.
  }
  return cache;
}

/** Coalesced: a plugin writing progress is many upserts a second, and the
 *  file is rewritten whole. One write per quarter second at most, off the
 *  request that caused it. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save(): void {
  // Every write to the store passes here, so this is the one place the
  // summary read is thrown away.
  summaryCache = null;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 250);
}
function saveNow(): void {
  const p = notesPath();
  if (!cache || offLimits(p)) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cache) + "\n", { mode: 0o600 });
  } catch {
    /* best effort, like every other store here */
  }
}

/** Per pull request per plugin, and per plugin overall. The first keeps a
 *  review re-run a hundred times to its last hundred runs; the second is what
 *  keeps a plugin gone wrong — posting to PR 1, 2, 3, … — from filling the
 *  disk, since repository and number are the plugin's to choose. */
const MAX_RUNS_PER_PR = 100;
const MAX_NOTES_PER_PR = 2000;
const MAX_RUNS_PER_PLUGIN = 5_000;
const MAX_NOTES_PER_PLUGIN = 20_000;
const MAX_BYTES_PER_PLUGIN = 40_000_000;

function bytesOf(plugin: string, s: NotesStore): number {
  let n = 0;
  for (const x of s.notes) if (x.plugin === plugin) n += (x.body?.length ?? 0) + x.title.length + 200 + (x.replies?.reduce((m, r) => m + r.text.length + 100, 0) ?? 0);
  for (const x of s.runs) if (x.plugin === plugin) n += (x.summary?.length ?? 0) + x.title.length + 200;
  for (const x of s.costs ?? []) if (x.plugin === plugin) n += 80;
  return n;
}

export function upsertRun(plugin: string, c: Contributes, raw: unknown): { ok: true } | { ok: false; error: string } {
  if (!c.prNotes) return { ok: false, error: "this plugin's manifest does not declare prNotes" };
  const r = validateRun(raw);
  if (!r.ok) return r;
  const s = load();
  const run: PrRun & { plugin: string } = { ...r.value, plugin };
  const i = s.runs.findIndex((x) => x.plugin === plugin && x.id === run.id);
  // The person's answer to a needs-ok run stands until the plugin moves the
  // run on; a plugin repeating needs-ok while it waits does not unsay it.
  if (i >= 0 && s.runs[i]!.state === "needs-ok" && run.state === "needs-ok" && s.runs[i]!.decision) run.decision = s.runs[i]!.decision;
  // Likewise the app's own record of a publication: a plugin cannot send it and a re-run of the same id does not erase it.
  if (i >= 0 && s.runs[i]!.published) run.published = s.runs[i]!.published;
  if (run.costUsd !== undefined && !recordCost(s, plugin, run)) return { ok: false, error: "this plugin's notes are over their size limit" };
  if (i < 0 && s.runs.filter((x) => x.plugin === plugin).length >= MAX_RUNS_PER_PLUGIN) {
    return { ok: false, error: `this plugin already keeps ${MAX_RUNS_PER_PLUGIN} runs` };
  }
  if (bytesOf(plugin, s) + (run.summary?.length ?? 0) > MAX_BYTES_PER_PLUGIN) {
    return { ok: false, error: "this plugin's notes are over their size limit" };
  }
  if (i >= 0) s.runs[i] = { ...run, startedAt: s.runs[i]!.startedAt };
  else s.runs.push(run);
  const mine = s.runs.filter((x) => x.plugin === plugin && x.repo === run.repo && x.number === run.number);
  if (mine.length > MAX_RUNS_PER_PR) {
    const drop = new Set(mine.sort((a, b) => a.startedAt - b.startedAt).slice(0, mine.length - MAX_RUNS_PER_PR).map((x) => x.id));
    s.runs = s.runs.filter((x) => !(x.plugin === plugin && drop.has(x.id)));
  }
  save();
  onChange({ kind: "pr", repo: run.repo, number: run.number });
  return { ok: true };
}

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

function recordCost(s: NotesStore, plugin: string, run: PrRun): boolean {
  const costs = (s.costs ??= []);
  const day = utcDay(run.startedAt);
  const row = costs.find((x) => x.plugin === plugin && x.id === run.id);
  if (row) { row.usd = run.costUsd!; row.day = day; }
  else {
    if (bytesOf(plugin, s) + 80 > MAX_BYTES_PER_PLUGIN) return false;
    costs.push({ plugin, id: run.id, day, usd: run.costUsd! });
  }
  const oldest = utcDay(Date.now() - COST_DAYS_KEPT * 86_400_000);
  if (costs.some((x) => x.day < oldest)) s.costs = costs.filter((x) => x.day >= oldest);
  return true;
}

/**
 * What runs cost, per plugin per UTC day, newest day first. Read-only: the
 * Usage screen reads it later. `plugin` narrows it to one; `days` (1-90,
 * default 30) is how far back.
 */
export function costByDay(plugin?: unknown, days?: unknown): { ok: true; days: { plugin: string; day: string; usd: number; runs: number }[] } | { ok: false; error: string } {
  if (plugin !== undefined && plugin !== null && plugin !== "" && (typeof plugin !== "string" || !validReplyBy(`agent:${plugin}`))) return { ok: false, error: "plugin is not a plugin name" };
  let back = 30;
  if (days !== undefined && days !== null && days !== "") {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > COST_DAYS_KEPT) return { ok: false, error: `days must be a whole number from 1 to ${COST_DAYS_KEPT}` };
    back = n;
  }
  const since = utcDay(Date.now() - (back - 1) * 86_400_000);
  const by = new Map<string, { plugin: string; day: string; usd: number; runs: number }>();
  for (const c of load().costs ?? []) {
    if ((plugin && c.plugin !== plugin) || c.day < since) continue;
    const key = `${c.plugin}\u0000${c.day}`;
    const row = by.get(key) ?? { plugin: c.plugin, day: c.day, usd: 0, runs: 0 };
    row.usd = Math.round((row.usd + c.usd) * 1e4) / 1e4;
    row.runs++;
    by.set(key, row);
  }
  return { ok: true, days: [...by.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.plugin.localeCompare(b.plugin))) };
}

/** The person pressed Approve run or Skip on a run waiting for their OK. Told
 *  to the plugin that wrote the run, and remembered so a second press does
 *  not send a second event. Nothing else changes: the plugin moves the run on. */
export function decideRun(plugin: string, id: unknown, decision: unknown): { ok: true } | { ok: false; error: string } {
  if (decision !== "approve" && decision !== "skip") return { ok: false, error: "decision must be approve or skip" };
  if (typeof id !== "string") return { ok: false, error: "id is required" };
  const run = load().runs.find((x) => x.plugin === plugin && x.id === id);
  if (!run) return { ok: false, error: "no such run" };
  if (run.state !== "needs-ok") return { ok: false, error: "that run is not waiting for an OK" };
  if (run.decision) return { ok: false, error: `already answered: ${run.decision}` };
  run.decision = decision;
  save();
  pushEvent(plugin, { type: decision === "approve" ? "run-approve" : "run-skip", id, repo: run.repo, number: run.number, at: Date.now() });
  onChange({ kind: "pr", repo: run.repo, number: run.number });
  return { ok: true };
}

/** A declared finding button was pressed. Only the plugin that wrote the
 *  finding, only an action it declared; the plugin is told which finding. */
export function pressNoteAction(plugin: string, c: Contributes, actionId: unknown, noteId: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof actionId !== "string" || !c.noteActions?.some((a) => a.id === actionId)) return { ok: false, error: "that plugin declares no such finding action" };
  if (typeof noteId !== "string") return { ok: false, error: "noteId is required" };
  const n = load().notes.find((x) => x.plugin === plugin && x.id === noteId);
  if (!n) return { ok: false, error: "no such note" };
  pushEvent(plugin, { type: "note-action", id: actionId, noteId, repo: n.repo, number: n.number, at: Date.now() });
  return { ok: true };
}

/** A plugin answering a finding's thread: "Ask the agent" answered. */
export const PLUGIN_REPLIES_PER_HOUR = 30;
const replyLog = new Map<string, number[]>();

export type PluginReplied = { ok: true; replies: NoteReply[] } | { ok: false; error: string; status: 400 | 404 | 429 };

/**
 * Stored like a person's reply but never sent anywhere: `by` is
 * `agent:<plugin name>`, GitHub is not an option, and the plugin is not told
 * (it knows what it said, and an echo would feed a plugin that answers every
 * event). Same caps as a person's, plus a per-plugin hourly cap, because a
 * loop here would fill every finding's thread.
 */
export async function replyAsPlugin(plugin: string, c: Contributes, raw: unknown, now = Date.now()): Promise<PluginReplied> {
  if (!c.prNotes) return { ok: false, status: 400, error: "this plugin's manifest does not declare prNotes" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 400, error: "send {id, text}" };
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== "string") return { ok: false, status: 400, error: "id is required" };
  const v = validateReplyInput({ text: b.text });
  if (!v.ok) return { ok: false, status: 400, error: v.error.replace("reply.text", "text") };
  const n = load().notes.find((x) => x.plugin === plugin && x.id === b.id);
  if (!n) return { ok: false, status: 404, error: "no such note" };
  if ((n.replies?.length ?? 0) >= REPLIES_PER_NOTE) return { ok: false, status: 400, error: `a finding keeps at most ${REPLIES_PER_NOTE} replies` };
  const recent = (replyLog.get(plugin) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PLUGIN_REPLIES_PER_HOUR) {
    replyLog.set(plugin, recent);
    return { ok: false, status: 429, error: `at most ${PLUGIN_REPLIES_PER_HOUR} replies an hour per plugin; try again later` };
  }
  recent.push(now);
  replyLog.set(plugin, recent);
  n.replies = [...(n.replies ?? []), { id: replyId(), text: v.value.text, at: now, by: `agent:${plugin}` }];
  n.updatedAt = now;
  save();
  onChange({ kind: "pr", repo: n.repo, number: n.number });
  return { ok: true, replies: n.replies };
}

/** A plugin closing its OWN finding: its Re-check found the bug fixed. */
export const PLUGIN_STATUS_PER_HOUR = 60;
const statusLog = new Map<string, number[]>();

export type PluginResolved = { ok: true; status: "resolved"; unchanged?: true } | { ok: false; error: string; status: 400 | 404 | 409 | 429 };

/**
 * `open -> resolved`, nothing else. The person outranks the plugin: a finding
 * whose status the person set (even one they reopened) is refused with 409, as
 * is anything already closed, so this can never reopen or overwrite. Another
 * plugin's finding is a 404, as if it did not exist. The plugin is NOT told
 * (no `note-status` event: a plugin that re-checks on every status event would
 * feed itself); the window learns at once through `onChange`. Stored with who
 * and when, so the card can say "resolved by acme-review".
 */
export function resolveOwnNote(plugin: string, c: Contributes, raw: unknown, now = Date.now()): PluginResolved {
  if (!c.prNotes) return { ok: false, status: 400, error: "this plugin's manifest does not declare prNotes" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 400, error: "send {id, status: \"resolved\"}" };
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== "string") return { ok: false, status: 400, error: "id is required" };
  if (b.status !== "resolved") return { ok: false, status: 400, error: "a plugin can only mark its own finding resolved; dismissing and reopening are the person's" };
  const n = load().notes.find((x) => x.plugin === plugin && x.id === b.id);
  if (!n) return { ok: false, status: 404, error: "no such note" };
  if (n.statusBy === "person") return { ok: false, status: 409, error: "the person set this finding's status; a plugin cannot change it" };
  if (n.status !== "open") {
    if (n.status === "resolved" && n.statusAgent === `agent:${plugin}`) return { ok: true, status: "resolved", unchanged: true };
    return { ok: false, status: 409, error: `this finding is already ${n.status}; a plugin only closes an open one` };
  }
  const recent = (statusLog.get(plugin) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PLUGIN_STATUS_PER_HOUR) {
    statusLog.set(plugin, recent);
    return { ok: false, status: 429, error: `at most ${PLUGIN_STATUS_PER_HOUR} status changes an hour per plugin; try again later` };
  }
  recent.push(now);
  statusLog.set(plugin, recent);
  n.status = "resolved";
  n.statusBy = "plugin";
  n.statusAgent = `agent:${plugin}`;
  n.statusAt = now;
  n.updatedAt = now;
  save();
  onChange({ kind: "pr", repo: n.repo, number: n.number });
  return { ok: true, status: "resolved" };
}

/**
 * Add or update notes. A note the person already marked resolved or
 * dismissed keeps that status when the plugin sends it again — the person's
 * word outranks the plugin's, the same rule a reviewer follows when it
 * re-reads a thread somebody else closed.
 */
export function upsertNotes(plugin: string, c: Contributes, raw: unknown): { ok: true; count: number } | { ok: false; error: string } {
  if (!c.prNotes) return { ok: false, error: "this plugin's manifest does not declare prNotes" };
  if (!Array.isArray(raw)) return { ok: false, error: "notes must be a list" };
  if (raw.length > 500) return { ok: false, error: "at most 500 notes per request" };
  const valid = [];
  for (const n of raw) {
    const v = validateNote(n);
    if (!v.ok) return v;
    valid.push(v.value);
  }
  const s = load();
  const mineN = s.notes.filter((x) => x.plugin === plugin).length;
  if (mineN + valid.length > MAX_NOTES_PER_PLUGIN) return { ok: false, error: `this plugin already keeps ${mineN} notes, the limit is ${MAX_NOTES_PER_PLUGIN}` };
  const incoming = valid.reduce((n, v) => n + (v.body?.length ?? 0) + v.title.length + 200, 0);
  if (bytesOf(plugin, s) + incoming > MAX_BYTES_PER_PLUGIN) return { ok: false, error: "this plugin's notes are over their size limit" };
  const now = Date.now();
  const touched = new Set<string>();
  for (const v of valid) {
    const i = s.notes.findIndex((x) => x.plugin === plugin && x.id === v.id);
    const prev = i >= 0 ? s.notes[i]! : null;
    // The person's choice stands; the plugin's own earlier choice does not
    // bind it (a bug it marked fixed can come back).
    const personSaid = prev?.statusBy === "person";
    const note: PrNote & { plugin: string } = {
      ...v,
      plugin,
      status: personSaid ? prev!.status : v.status ?? "open",
      statusBy: personSaid ? "person" : "plugin",
      ...(personSaid && prev?.statusAgent ? { statusAgent: prev.statusAgent, statusAt: prev.statusAt } : {}),
      // A plugin sending the finding again does not send the answers to it.
      ...(prev?.replies?.length ? { replies: prev.replies } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    if (i >= 0) s.notes[i] = note; else s.notes.push(note);
    touched.add(`${note.repo}#${note.number}`);
  }
  for (const key of touched) {
    const [repo, num] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
    const mine = s.notes.filter((x) => x.plugin === plugin && x.repo === repo && x.number === num);
    if (mine.length > MAX_NOTES_PER_PR) {
      const drop = new Set(mine.sort((a, b) => a.createdAt - b.createdAt).slice(0, mine.length - MAX_NOTES_PER_PR).map((x) => x.id));
      s.notes = s.notes.filter((x) => !(x.plugin === plugin && drop.has(x.id)));
    }
  }
  save();
  for (const key of touched) {
    const at = key.lastIndexOf("#");
    onChange({ kind: "pr", repo: key.slice(0, at), number: Number(key.slice(at + 1)) });
  }
  return { ok: true, count: valid.length };
}

export function notesFor(repo: unknown, number: unknown): { runs: (PrRun & { plugin: string })[]; notes: (PrNote & { plugin: string })[] } | null {
  const ref = validPrRef(repo, number);
  if (!ref) return null;
  const s = load();
  return {
    runs: s.runs.filter((r) => r.repo === ref.repo && r.number === ref.number).sort((a, b) => a.startedAt - b.startedAt),
    notes: s.notes.filter((n) => n.repo === ref.repo && n.number === ref.number),
  };
}

/**
 * What each pull request's notes add up to, for a board that must not open
 * every conversation to draw a chip.
 *
 * A pure read of the store above: no GitHub request, and the per-request work
 * is a map lookup. The sums are kept until the next write to the store
 * (`save` drops them), so a board load costs one pass over the notes however
 * many times it is asked. The head the caller says is the pull request's
 * current one is NOT cached: it is the list's fact and moves with every push,
 * and `stale` is one string comparison at read time.
 *
 * `idea` counts with `info`: neither one is a defect, and a chip with six
 * severities would be a chip nobody reads.
 */
const SUMMARY_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type SummarySeverity = (typeof SUMMARY_SEVERITIES)[number];

interface SummaryBase {
  repo: string;
  number: number;
  open: Record<SummarySeverity, number>;
  resolved: number;
  dismissed: number;
  lastReviewAt: number | null;
  plugins: string[];
  reviewedSha: string | null;
  /** When that review finished: a head read before this cannot call it stale. */
  reviewedAt: number | null;
}
let summaryCache: Map<string, SummaryBase> | null = null;

function summaryBases(): Map<string, SummaryBase> {
  if (summaryCache) return summaryCache;
  const s = load();
  const out = new Map<string, SummaryBase>();
  const at = (repo: string, number: number): SummaryBase => {
    const k = `${repo}#${number}`;
    let b = out.get(k);
    if (!b) {
      b = { repo, number, open: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, resolved: 0, dismissed: 0, lastReviewAt: null, plugins: [], reviewedSha: null, reviewedAt: null };
      out.set(k, b);
    }
    return b;
  };
  // The head a review covered is the one on the newest finished run; notes
  // only stand in for a plugin that writes none.
  const runAt = new Map<string, number>();
  for (const r of s.runs) {
    if (r.state !== "done") continue;
    const b = at(r.repo, r.number);
    const key = `${r.repo}#${r.number}`;
    const t = r.finishedAt ?? r.startedAt;
    if (b.lastReviewAt === null || t > b.lastReviewAt) b.lastReviewAt = t;
    if (r.sha && t >= (runAt.get(key) ?? 0)) { b.reviewedSha = r.sha; b.reviewedAt = t; runAt.set(key, t); }
    if (!b.plugins.includes(r.plugin)) b.plugins.push(r.plugin);
  }
  const noteAt = new Map<string, number>();
  for (const n of s.notes) {
    const b = at(n.repo, n.number);
    const key = `${n.repo}#${n.number}`;
    if (n.status === "open") b.open[n.severity === "idea" ? "info" : n.severity]++;
    else if (n.status === "resolved") b.resolved++;
    else b.dismissed++;
    if (!b.plugins.includes(n.plugin)) b.plugins.push(n.plugin);
    if (runAt.has(key)) continue;
    if (n.sha && n.updatedAt >= (noteAt.get(key) ?? 0)) { b.reviewedSha = n.sha; b.reviewedAt = n.updatedAt; noteAt.set(key, n.updatedAt); }
    if (b.lastReviewAt === null || n.updatedAt > b.lastReviewAt) b.lastReviewAt = n.updatedAt;
  }
  summaryCache = out;
  return out;
}

/** `heads` maps a pull request number to its current head, when the caller
 *  knows it; without one `headSha` and `stale` are null. A bare sha is vouched
 *  for by the caller; `{sha, at}` says when it was read, and a head read before
 *  the review finished never calls it stale (see reviewStale). */
export function summaryFor(repo: unknown, number: unknown, heads: Record<number, string | HeadRead> = {}): { prs: PrNotesSummary[] } | null {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  let only: number | null = null;
  if (number !== null && number !== undefined && number !== "") {
    const ref = validPrRef(repo, number);
    if (!ref) return null;
    only = ref.number;
  }
  const prs: PrNotesSummary[] = [];
  for (const b of summaryBases().values()) {
    if (b.repo !== repo || (only !== null && b.number !== only)) continue;
    const h = heads[b.number];
    const head = (typeof h === "string" ? h : h?.sha) ?? null;
    const { reviewedAt: _at, ...base } = b;
    prs.push({
      ...base, open: { ...b.open }, plugins: [...b.plugins],
      headSha: head,
      stale: reviewStale(b.reviewedSha, b.reviewedAt, h),
    });
  }
  prs.sort((a, b) => a.number - b.number);
  return { prs };
}

/** Pull requests whose verdict waits on a fresher head: the review is newer
 *  than the head the app holds, or the app holds none. One targeted read of
 *  each answers it. */
export function headsToRead(repo: string, heads: Record<number, string | HeadRead>): number[] {
  const out: number[] = [];
  for (const b of summaryBases().values()) {
    if (b.repo === repo && headNeedsRead(b.reviewedSha, b.reviewedAt, heads[b.number])) out.push(b.number);
  }
  return out;
}

/** The person marked a note. Stored, and told to the plugin that wrote it. */
export function setNoteStatus(plugin: string, id: string, status: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof status !== "string" || !(NOTE_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `status must be one of ${NOTE_STATUSES.join(", ")}` };
  }
  const s = load();
  const n = s.notes.find((x) => x.plugin === plugin && x.id === id);
  if (!n) return { ok: false, error: "no such note" };
  n.status = status as NoteStatus;
  n.statusBy = "person";
  delete n.statusAgent; delete n.statusAt;
  n.updatedAt = Date.now();
  save();
  pushEvent(plugin, { type: "note-status", repo: n.repo, number: n.number, id, status: n.status, at: n.updatedAt, ...(n.replies?.length ? { replies: n.replies } : {}) });
  onChange({ kind: "pr", repo: n.repo, number: n.number });
  return { ok: true };
}

export interface NoteAnswer {
  status?: unknown;
  reply?: unknown;
  /** When sent, must be the note's own pull request. */
  repo?: unknown;
  number?: unknown;
  /** `"user"` or `"agent:<name>"`. */
  by: string;
}

export type NoteAnswered =
  | { ok: true; status: NoteStatus; replies: NoteReply[] }
  | { ok: false; error: string };

let replySeq = 0;
function replyId(): string {
  return `r_${Date.now().toString(36)}${(replySeq++ % 1296).toString(36)}${crypto.randomUUID().slice(0, 4)}`;
}

/**
 * The person (or an agent for them) answers a finding: a reply, a status, or
 * both in one step. Everything is checked before anything is stored. A reply
 * stays on this machine: the only way a finding's words reach GitHub is the
 * person publishing the review as one comment (review-publish.ts).
 */
export function answerNote(plugin: string, id: string, a: NoteAnswer): NoteAnswered {
  let status: NoteStatus | undefined;
  if (a.status !== undefined) {
    if (typeof a.status !== "string" || !(NOTE_STATUSES as readonly string[]).includes(a.status)) {
      return { ok: false, error: `status must be one of ${NOTE_STATUSES.join(", ")}` };
    }
    status = a.status as NoteStatus;
  }
  let reply: { text: string } | undefined;
  if (a.reply !== undefined) {
    const v = validateReplyInput(a.reply);
    if (!v.ok) return v;
    reply = v.value;
  }
  if (!status && !reply) return { ok: false, error: "send a status, a reply, or both" };
  if (!validReplyBy(a.by)) return { ok: false, error: "invalid author" };
  const s = load();
  const find = () => s.notes.find((x) => x.plugin === plugin && x.id === id);
  const n = find();
  if (!n) return { ok: false, error: "no such note" };
  if (a.repo !== undefined || a.number !== undefined) {
    const ref = validPrRef(a.repo, a.number);
    if (!ref) return { ok: false, error: "repo (owner/name) and number must go together" };
    if (ref.repo !== n.repo || ref.number !== n.number) return { ok: false, error: "that note is on another pull request" };
  }
  if (reply && (n.replies?.length ?? 0) >= REPLIES_PER_NOTE) return { ok: false, error: `a finding keeps at most ${REPLIES_PER_NOTE} replies` };
  const cur = n;
  const now = Date.now();
  let added: NoteReply | undefined;
  if (reply) {
    added = { id: replyId(), text: reply.text, at: now, by: a.by };
    if (status === "resolved" || status === "dismissed") added.withStatus = status;
    cur.replies = [...(cur.replies ?? []), added];
  }
  if (status) {
    cur.status = status;
    cur.statusBy = "person";
    delete cur.statusAgent; delete cur.statusAt;
  }
  cur.updatedAt = now;
  save();
  pushEvent(plugin, {
    type: "note-status", repo: cur.repo, number: cur.number, id, status: cur.status, at: now,
    ...(added ? { reply: added } : {}),
    ...(cur.replies?.length ? { replies: cur.replies } : {}),
  });
  onChange({ kind: "pr", repo: cur.repo, number: cur.number });
  return { ok: true, status: cur.status, replies: cur.replies ?? [] };
}

/** The app records that the person published this run's review. Called by the
 *  publish route only, after a human click; no plugin route reaches it. */
export function markRunPublished(plugin: string, runId: string, published: NonNullable<PrRun["published"]>): boolean {
  const run = load().runs.find((x) => x.plugin === plugin && x.id === runId);
  if (!run) return false;
  run.published = published;
  save();
  onChange({ kind: "pr", repo: run.repo, number: run.number });
  return true;
}

/** Removing a plugin removes what it wrote. Disabling one does not: a review
 *  stays readable while the reviewer is switched off. */
export function dropNotesOf(plugin: string): void {
  const s = load();
  const before = s.runs.length + s.notes.length;
  s.runs = s.runs.filter((r) => r.plugin !== plugin);
  s.notes = s.notes.filter((n) => n.plugin !== plugin);
  const costs = s.costs?.length ?? 0;
  s.costs = (s.costs ?? []).filter((x) => x.plugin !== plugin);
  replyLog.delete(plugin);
  statusLog.delete(plugin);
  if (s.runs.length + s.notes.length !== before || s.costs.length !== costs) save();
}

/** Flush a pending coalesced write — on shutdown, and for tests. */
export function flushPluginNotes(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); }
}

/** Test seam. */
export function __resetPluginUi(): void {
  panels.clear();
  options.clear();
  queues.clear();
  waiters.clear();
  cache = { runs: [], notes: [], costs: [] };
  replyLog.clear();
  statusLog.clear();
}
