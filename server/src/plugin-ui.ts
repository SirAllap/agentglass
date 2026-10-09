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
  type Contributes, type Field, type FieldOption, type NoteStatus, type PrNote, type PrRun, type UiAction, type UiNode,
  NOTE_STATUSES, coerceValue, resolveSettings, validateNote, validateRun, validateTree, validPrRef,
} from "../../shared/pluginUi.ts";
import { pluginsConfigDir } from "./plugins.ts";
import { forgetAnnotations } from "./inbox-annotations.ts";
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
  | { type: "note-status"; repo: string; number: number; id: string; status: NoteStatus; at: number }
  | { type: "pr-open"; repo: string; number: number; at: number }
  | { type: "pr-action"; id: string; repo: string; number: number; at: number };

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
  dropCanvases(plugin);
  queues.delete(plugin);
  for (const w of waiters.get(plugin) ?? []) w();
  waiters.delete(plugin);
  onChange({ kind: "panels" });
}

// ---------------------------------------------------- notes on pull requests

interface NotesStore { runs: (PrRun & { plugin: string })[]; notes: (PrNote & { plugin: string })[] }

let pathOverride: string | null = null;
/** Test seam, the `__setSavedRepliesPath` shape. */
export function __setPluginNotesPath(p: string | null): void { pathOverride = p; cache = null; }

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
  for (const x of s.notes) if (x.plugin === plugin) n += (x.body?.length ?? 0) + x.title.length + 200;
  for (const x of s.runs) if (x.plugin === plugin) n += (x.summary?.length ?? 0) + x.title.length + 200;
  return n;
}

export function upsertRun(plugin: string, c: Contributes, raw: unknown): { ok: true } | { ok: false; error: string } {
  if (!c.prNotes) return { ok: false, error: "this plugin's manifest does not declare prNotes" };
  const r = validateRun(raw);
  if (!r.ok) return r;
  const s = load();
  const run = { ...r.value, plugin };
  const i = s.runs.findIndex((x) => x.plugin === plugin && x.id === run.id);
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
  n.updatedAt = Date.now();
  save();
  pushEvent(plugin, { type: "note-status", repo: n.repo, number: n.number, id, status: n.status, at: n.updatedAt });
  onChange({ kind: "pr", repo: n.repo, number: n.number });
  return { ok: true };
}

/** Removing a plugin removes what it wrote. Disabling one does not: a review
 *  stays readable while the reviewer is switched off. */
export function dropNotesOf(plugin: string): void {
  const s = load();
  const before = s.runs.length + s.notes.length;
  s.runs = s.runs.filter((r) => r.plugin !== plugin);
  s.notes = s.notes.filter((n) => n.plugin !== plugin);
  if (s.runs.length + s.notes.length !== before) save();
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
  cache = { runs: [], notes: [] };
}
