/*
 * What `ui.state` and `ui.read` answer with: one provider per panel, each a pure
 * function of plain data, so a test feeds it a fixture and no renderer is needed.
 *
 * Providers read what the STORES and pref modules hold (benchStore,
 * gateStore, diffPrefs, termPrefs…), never component state and never the DOM, so
 * a panel that is not mounted still answers. The gathering lives in
 * uiSnapshotSources.ts; nothing in this file imports a store at runtime.
 *
 * Three rules, enforced where the answer is built and not left to each provider:
 *
 *  1. Two buckets. `state` holds only what the app minted or the owner picked
 *     from a closed set (booleans, numbers, ids, enum words). Every string that
 *     came from outside (a tab title, a path, a URL, a pull
 *     request title, a command a gate is holding) goes under `untrusted`, which
 *     the agent reads as data and never obeys. A string in `state` that does not
 *     look like an id is moved to `untrusted._moved` by `finish`, so a provider
 *     that forgets cannot leak outside text into the bucket an agent trusts.
 *  2. Secrets are redacted by construction. `finish` replaces the value of any
 *     field whose NAME says it is a credential (token, key, secret, password,
 *     credential) with `{set: boolean}`, at any depth, in either bucket, and
 *     strips token-shaped text from every untrusted string. A provider cannot opt
 *     out by building its object differently; web/test/ui-read-guard.test.ts
 *     fails a provider that names such a field anyway.
 *  3. Bounded. `untrusted` is cut to UNTRUSTED_MAX_BYTES; the providers cap their
 *     own lists first, so the cut is the backstop and not the normal case.
 *
 * Data the server already holds (git, pull requests, docker, task lists) is not
 * copied here: a snapshot adds only what the renderer alone knows, and says in
 * `see` which routes carry the rest.
 */
import {
  READ_PANELS, READ_PANELS_LATE, READ_PANELS_NOW, UI_READ_NOT_COVERED, UI_REFUSED_FOR_AGENTS, UNTRUSTED_MAX_BYTES,
  type UiSnapshot,
} from "../../../shared/uiActions.ts";
import { stripSecrets } from "../../../shared/scrub.ts";
import type { DiskCleanReport, PendingGate, ViewId } from "../../../shared/types.ts";
import type { NotifyPrefs } from "../../../shared/notifyPrefs.ts";
import type { BenchState, BenchTab } from "./benchStore.ts";
import type { AccountsOut } from "../../../shared/pluginAccounts.ts";
import type { UsageOpens } from "../../../shared/types.ts";
import type {
  PrefsData, RailData, KeysData, TasksData, AppearanceData, UnderstudyData, HooksData, LanternData, BudgetsData, RecipeRow,
  ReviewPromptRow, SavedReplyRow, TmuxData, PrivacyData, PluginsData, LogData, AboutData,
} from "./paneState.ts";

export type ReadPanel = (typeof READ_PANELS)[number];
export type NowPanel = (typeof READ_PANELS_NOW)[number];
export type LatePanel = (typeof READ_PANELS_LATE)[number];

/** What App holds that no store does: the view, the modals, the selection. */
export interface AppSlice {
  view: ViewId;
  theme: string;
  scale: number;
  workspace: string | null;
  windowMs: number;
  filter: { app: string; type: string; provider: string };
  modals: {
    settings: boolean; palette: boolean; help: boolean; skills: boolean;
    finder: boolean; windows: boolean; projectPicker: boolean; machine: string | null;
  };
  selectedEvent: { id: string; type: string; app: string } | null;
  session: { id: string; app: string } | null;
  peek: { path: string } | null;
  finderPath: string | null;
}

/** Thunks, so a provider reads only the stores it names. */
export interface Sources {
  app(): AppSlice;
  bench(): BenchState;
  gates(): readonly PendingGate[];
  diff(): { split: boolean; wrap: boolean; noWhitespace: boolean; theme: string };
  terminal(): {
    font: string; size: number; cursor: string; lineHeight: number; scrollback: number;
    wordSeparators: string; copyOnSelect: boolean; noteEditor: string;
  };
  browser(): { home: string; engine: string; zoomLevel: number; importHistory: boolean; importBookmarks: boolean };
  notify(): NotifyPrefs;
  prefs(): PrefsData;
  rail(): RailData;
  keys(): KeysData;
  tasks(): TasksData;
  appearance(): AppearanceData;
  understudy(): UnderstudyData | null;
  /** The panes the server holds. Each is one request to the route the pane
   *  itself uses, made when the read is asked and never before. */
  later: {
    hooks(): Promise<HooksData>;
    lantern(): Promise<LanternData>;
    budgets(): Promise<BudgetsData>;
    recipes(): Promise<RecipeRow[]>;
    reviewPrompts(): Promise<ReviewPromptRow[]>;
    savedReplies(): Promise<SavedReplyRow[]>;
    tmux(): Promise<TmuxData>;
    privacy(): Promise<PrivacyData>;
    plugins(): Promise<PluginsData>;
    log(): Promise<LogData>;
    about(): Promise<AboutData>;
    diskClean(): Promise<DiskCleanReport>;
    usageAccounts(): Promise<AccountsOut[]>;
    usageOpens(): Promise<UsageOpens>;
  };
}

// ── the answer's two buckets ────────────────────────────────────────────────

/** Shaped like something the app minted: no spaces, no slashes, no quotes. */
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:[\]@+-]{0,95}$/;
/** A field NAME that says it holds a credential. camelCase is split first, so
 *  `apiKey` is "api key" and `monkey` is not. */
const SECRET_NAME = /token|secret|passw|credential|apikey|(^|[^a-z])key([^a-z]|$)/;
export const isSecretName = (name: string): boolean => SECRET_NAME.test(name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());

const CLIP = 600;
export const clip = (s: string, n = CLIP): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Where a tab or a preference points, without what a link can carry: no
 *  user:password@, no query string, no fragment (a token rides in all three). */
export function plainUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : `${u.protocol}…`;
  } catch { return ""; }
}

function redactNamed(v: unknown, depth = 0): unknown {
  if (depth > 10 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactNamed(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = isSecretName(k) ? { set: x !== undefined && x !== null && x !== "" && x !== false } : redactNamed(x, depth + 1);
  }
  return out;
}

/** `state` with every outside-looking string taken out, and what was taken. */
function sieve(v: unknown, path: string, moved: Record<string, string>, depth = 0): unknown {
  if (typeof v === "string") {
    if (ID_SHAPE.test(v) || v === "") return v;
    moved[path] = v;
    return "[moved to untrusted]";
  }
  if (depth > 10 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x, i) => sieve(x, `${path}[${i}]`, moved, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = sieve(x, path ? `${path}.${k}` : k, moved, depth + 1);
  return out;
}

function cleanText(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return clip(stripSecrets(v));
  if (depth > 10 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => cleanText(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = cleanText(x, depth + 1);
  return out;
}

const bytes = (v: unknown): number => JSON.stringify(v)?.length ?? 0;

/** Cut `untrusted` to the budget: whole keys while they fit, then a list's
 *  prefix, and anything else is named as omitted. Says so rather than going
 *  quietly short. */
export function bound(u: Record<string, unknown>, max = UNTRUSTED_MAX_BYTES): Record<string, unknown> {
  if (bytes(u) <= max) return u;
  const out: Record<string, unknown> = {};
  let left = max - 64;
  for (const [k, v] of Object.entries(u)) {
    const n = bytes(v);
    if (n <= left) { out[k] = v; left -= n; continue; }
    if (Array.isArray(v)) {
      const keep: unknown[] = [];
      for (const item of v) { const m = bytes(item) + 1; if (m > left) break; keep.push(item); left -= m; }
      out[k] = keep;
      out[`${k}_omitted`] = v.length - keep.length;
    } else out[`${k}_omitted`] = true;
  }
  out._truncated = `untrusted is cut to ${Math.round(max / 1024)} KB`;
  return out;
}

/** The one place an answer is built: every provider goes through here. */
export function finish(s: UiSnapshot): UiSnapshot {
  const moved: Record<string, string> = {};
  const state = sieve(redactNamed(s.state), "", moved) as Record<string, unknown>;
  const untrusted = cleanText(redactNamed({ ...s.untrusted, ...(Object.keys(moved).length ? { _moved: moved } : {}) })) as Record<string, unknown>;
  return { state, untrusted: bound(untrusted), ...(s.see ? { see: s.see } : {}) };
}

/** A panel that only a mounted component can describe. Nothing in this slice is
 *  one (every provider reads a store); the shape is here so the first one that
 *  is does not invent its own. A read never opens anything: the hint tells the
 *  agent to ask for the panel to be opened quietly. */
export const notMounted = (panel: string): UiSnapshot => ({
  state: { mounted: false, hint: "open it quietly", panel }, untrusted: {},
});

// ── providers ───────────────────────────────────────────────────────────────

const MAX_TABS = 40;
const MAX_GATES = 20;
const MAX_MOUNTS = 12;

const count = <T>(xs: readonly T[], by: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[by(x)] = (out[by(x)] ?? 0) + 1;
  return out;
};

const view = (src: Sources): UiSnapshot => {
  const a = src.app();
  const ev = a.selectedEvent;
  return {
    state: {
      view: a.view, theme: a.theme, scale: a.scale, windowMs: a.windowMs,
      hasWorkspace: a.workspace !== null,
      modals: { ...a.modals, event: ev !== null, session: a.session !== null, peek: a.peek !== null },
      filterActive: !!(a.filter.app || a.filter.type || a.filter.provider),
    },
    untrusted: {
      workspace: a.workspace, filter: a.filter, selectedEvent: ev, session: a.session,
      peek: a.peek?.path ?? null, finderPath: a.finderPath,
    },
    see: ["/workspaces", "/stats"],
  };
};

const tabView = (t: BenchTab) => ({
  id: t.id, kind: t.kind, slot: t.slot, title: t.title, path: t.path ?? null, line: t.line ?? null,
  readonly: !!t.readonly, ref: t.ref ?? null, url: t.url ? plainUrl(t.url) : null, agent: t.agent ?? null,
});

const bench = (src: Sources): UiSnapshot => {
  const b = src.bench();
  const roots = Object.entries(b.byRoot);
  const all = roots.flatMap(([, h]) => h.tabs);
  return {
    state: {
      open: b.open, grown: b.grown, zoom: b.zoom, geom: b.geom, fab: b.fab,
      roots: roots.length, tabs: all.length, kinds: count(all, (t) => t.kind),
      activeKind: b.byRoot[b.root]?.tabs.find((t) => t.id === b.byRoot[b.root]?.active)?.kind ?? null,
    },
    untrusted: {
      root: b.root,
      byRoot: roots.slice(0, 8).map(([root, h]) => ({ root, active: h.active, tabs: h.tabs.slice(0, MAX_TABS).map(tabView) })),
    },
    see: ["/terminal/tmux/windows"],
  };
};

const gates = (src: Sources): UiSnapshot => {
  const g = src.gates();
  return {
    state: { count: g.length },
    untrusted: {
      gates: g.slice(0, MAX_GATES).map((x) => ({ id: x.id, tool: x.tool_name, app: x.source_app, where: x.where ?? null, created: x.created, summary: x.summary })),
    },
    see: ["/gate/pending"],
  };
};

const diff = (src: Sources): UiSnapshot => {
  const d = src.diff();
  return { state: { split: d.split, wrap: d.wrap, noWhitespace: d.noWhitespace, syntaxTheme: d.theme }, untrusted: {} };
};

const terminal = (src: Sources): UiSnapshot => {
  const t = src.terminal();
  return {
    state: {
      size: t.size, cursor: t.cursor, lineHeight: t.lineHeight, scrollback: t.scrollback,
      copyOnSelect: t.copyOnSelect, noteEditor: t.noteEditor,
    },
    // A font family and a separator list are the owner's own text; still not an id.
    untrusted: { font: t.font, wordSeparators: t.wordSeparators },
  };
};

const browser = (src: Sources): UiSnapshot => {
  const b = src.browser();
  return {
    state: { engine: b.engine, zoomLevel: b.zoomLevel, importHistory: b.importHistory, importBookmarks: b.importBookmarks },
    untrusted: { home: plainUrl(b.home) },
  };
};

const notifications = (src: Sources): UiSnapshot => {
  const n = src.notify();
  return { state: { none: n.none, kinds: n.kinds, channels: n.channels }, untrusted: {} };
};

// ── the preference panes the window holds ───────────────────────────────────

const prefs = (src: Sources): UiSnapshot => ({ state: { ...src.prefs() }, untrusted: {} });

const rail = (src: Sources): UiSnapshot => ({ state: { ...src.rail() }, untrusted: {} });

/** What the owner pressed is their own text and not an id; it is filed under
 *  `untrusted` like any string the app did not mint. */
const keys = (src: Sources): UiSnapshot => {
  const k = src.keys();
  return {
    state: { customised: k.customised, customChord: k.customChord, customAppChord: k.customAppChord },
    untrusted: { bindings: k.bindings, chords: k.chords, appChords: k.appChords },
  };
};

const tasks = (src: Sources): UiSnapshot => ({ state: { ...src.tasks() }, untrusted: {} });

const appearance = (src: Sources): UiSnapshot => {
  const a = src.appearance();
  const app = src.app();
  return { state: { mode: a.mode, accent: a.accent, theme: app.theme, scale: app.scale }, untrusted: { desktopPalette: a.desktopPalette } };
};

const MAX_CLASSES = 30;
const understudy = (src: Sources): UiSnapshot => {
  const u = src.understudy();
  if (!u) return { state: { loaded: false }, untrusted: {}, see: ["/understudy/scorecard"] };
  const shown = u.classes.slice(0, MAX_CLASSES);
  return {
    state: {
      loaded: true, enabled: u.enabled, halted: u.halted, level: u.level, agreement: u.agreement, classes: u.classes.length,
      rows: shown.map((c) => ({ id: c.id, lock: c.lock, mode: c.mode, offered: c.offered, n: c.n, hits: c.hits })),
    },
    untrusted: { labels: Object.fromEntries(shown.map((c) => [c.id, c.label])) },
    see: ["/understudy/scorecard"],
  };
};

// ── the panes the server holds ──────────────────────────────────────────────

const MAX_ROWS = 50;
/** A list's first rows and how many there were, so a long one says it was cut. */
const head = <T>(xs: readonly T[]): { rows: T[]; count: number; shown: number } => {
  const rows = xs.slice(0, MAX_ROWS);
  return { rows, count: xs.length, shown: rows.length };
};

const hooks = (h: HooksData): UiSnapshot => ({
  state: { installed: h.installed, bundled: h.bundled, gate: h.gate, gateBundled: h.gateBundled },
  untrusted: { python: h.python, settingsPath: h.settingsPath },
  see: ["/hooks/status"],
});

const lantern = (l: LanternData): UiSnapshot => ({ state: { ...l }, untrusted: {}, see: ["/lantern/settings", "/seat/wake"] });

const budgets = (b: BudgetsData): UiSnapshot => {
  const r = head(b.rows);
  const { timeZone, ...pace } = b.pace;
  return {
    state: {
      count: r.count, shown: r.shown, models: b.models, usageRefresh: b.usageRefresh, pace,
      rows: r.rows.map((x) => ({ scope: x.root === "" ? "machine" : "project", anyModel: x.model === "", limit: x.limit, period: x.period, spent: x.spent, pct: x.pct, level: x.level })),
    },
    untrusted: { timeZone, rows: r.rows.map((x) => ({ root: x.root, model: x.model })) },
    see: ["/budgets"],
  };
};

const recipes = (rs: readonly RecipeRow[]): UiSnapshot => {
  const r = head(rs);
  return {
    state: { count: r.count, shown: r.shown, recipes: r.rows.map((x) => ({ id: x.id, scope: x.scope, steps: x.steps, params: x.params, tmux: x.tmux, confirm: x.confirm })) },
    // A recipe's steps are shell commands the owner typed; only how many there are leaves the window.
    untrusted: { recipes: r.rows.map((x) => ({ id: x.id, name: x.name, desc: x.desc, repo: x.repo })) },
    see: ["/recipes"],
  };
};

const reviewPrompts = (rs: readonly ReviewPromptRow[]): UiSnapshot => {
  const r = head(rs);
  return {
    state: { count: r.count, shown: r.shown, prompts: r.rows.map((x) => ({ id: x.id, group: x.group, when: x.when, builtIn: x.builtIn, hidden: x.hidden, edited: x.edited, hasSkill: x.hasSkill, chars: x.chars })) },
    untrusted: { titles: Object.fromEntries(r.rows.map((x) => [x.id, x.title])) },
    see: ["/pr-prompts"],
  };
};

const savedReplies = (rs: readonly SavedReplyRow[]): UiSnapshot => {
  const r = head(rs);
  return {
    state: { count: r.count, shown: r.shown, replies: r.rows.map((x) => ({ id: x.id, chars: x.chars })) },
    untrusted: { titles: Object.fromEntries(r.rows.map((x) => [x.id, x.title])) },
    see: ["/saved-replies"],
  };
};

const tmux = (t: TmuxData): UiSnapshot => {
  const { reasons, binVersion, ...rest } = t;
  // A version banner ("tmux 3.4a") is text the binary printed, not an id.
  return { state: { ...rest }, untrusted: { ...reasons, binVersion }, see: ["/terminal/tmux-status"] };
};

const privacy = (p: PrivacyData): UiSnapshot => ({
  state: { retentionDays: p.retentionDays, pairedDevices: p.pairedDevices, clickup: { set: p.clickupSet } },
  untrusted: { db: p.db, config: p.config },
  see: ["/privacy"],
});

const plugins = (p: PluginsData): UiSnapshot => {
  const r = head(p.plugins);
  return {
    state: {
      master: p.master, count: r.count, shown: r.shown,
      plugins: r.rows.map((x, n) => ({ n, enabled: x.enabled, running: x.running, scope: x.scope, sourceKind: x.sourceKind, hadApproval: x.hadApproval, changedSinceApproval: x.changedSinceApproval })),
    },
    untrusted: { plugins: r.rows.map((x, n) => ({ n, name: x.name, publisher: x.publisher, description: x.description })) },
    see: ["/plugins"],
  };
};

const log = (l: LogData): UiSnapshot => ({
  state: { shown: l.rows.length, failed: l.rows.filter((x) => !x.ok).length, rows: l.rows.map((x) => ({ id: x.id, at: x.at, ok: x.ok })) },
  untrusted: { rows: l.rows.map((x) => ({ id: x.id, actor: x.actor, action: x.action, target: x.target, detail: x.detail })) },
  see: ["/actions"],
});

const about = (a: AboutData): UiSnapshot => {
  const { incoming, blocked, origin, digest, ...rest } = a;
  return {
    state: { ...rest, hasIncoming: incoming.length > 0, blocked: blocked !== "", digest },
    untrusted: { incoming, blocked, origin: plainUrl(origin) },
    see: ["/update/status", "/logs/digest"],
  };
};

/**
 * The disk scan and its plan. A line id is the scan's own spelling (`docker:cache`,
 * `worktree:/home/acme/code/orbit-fix`), which is a path or a name from the disk and
 * not an id the app minted, so the ids an agent needs to stage a selection are
 * under `untrusted` beside the words, and `state` holds the numbers. The plan
 * (safe lines) comes first so a long list cannot cut it off.
 */
const diskClean = (r: DiskCleanReport): UiSnapshot => {
  const safe = head(r.lines.filter((l) => l.verdict === "safe"));
  const rest = head(r.lines.filter((l) => l.verdict !== "safe"));
  const mounts = r.mounts.slice(0, MAX_MOUNTS);
  const at = new Map(mounts.map((m, n) => [m.mount, n] as const));
  const row = (l: DiskCleanReport["lines"][number]) => ({ id: l.id, kind: l.kind, verdict: l.verdict, label: l.label, why: l.why, bytes: l.bytes, mount: at.get(l.mount) ?? null });
  return {
    state: {
      lines: r.lines.length, safe: safe.count, safeBytes: r.safeBytes, planShown: safe.shown, keptShown: rest.shown, scannedAt: r.at, problems: r.problems.length,
      byVerdict: count(r.lines, (l) => l.verdict),
      mounts: mounts.map((m, n) => ({ n, size: m.size, free: m.free, freePct: m.size > 0 ? Math.round((m.free / m.size) * 1000) / 10 : null, safeBytes: m.safeBytes })),
    },
    untrusted: {
      mounts: mounts.map((m, n) => ({ n, mount: m.mount, source: m.source })),
      plan: safe.rows.map(row),
      kept: rest.rows.map(row),
      problems: r.problems,
    },
    see: ["/machine/disk-clean"],
  };
};

/**
 * The accounts a plugin says each provider has. The ids are the plugin's own
 * short spelling (`acme-a`), which an agent needs to stage a proposal; the words
 * a person reads (label, plan) and the plugin's name came from outside, so they
 * are under `untrusted`. No credential is in the list and none can be: the
 * plugin's whole input is refused when a visible string looks like one.
 */
const usageAccounts = (rs: readonly AccountsOut[]): UiSnapshot => ({
  state: {
    providers: rs.map((p) => ({
      provider: p.provider, managedByPlugin: p.managedBy ?? null,
      accounts: p.accounts.map((a) => ({ id: a.id, active: a.active, storage: a.storage, colour: a.colour })),
    })),
  },
  untrusted: { providers: rs.map((p) => ({ provider: p.provider, plugin: p.plugin, accounts: p.accounts.map((a) => ({ id: a.id, label: a.label, plan: a.plan })) })) },
  see: ["/usage/accounts"],
});

/**
 * What gets opened here, most opened first. Every string is an id the window
 * minted (`view:git`) or a date, so all of it is state; none of it is text from
 * outside. Capped, since the table has an id per door.
 */
const MAX_OPENS = 60;
const usage = (u: UsageOpens): UiSnapshot => ({
  state: {
    since: u.since, ids: u.opens.length, total: u.opens.reduce((n, o) => n + o.count, 0),
    shown: Math.min(MAX_OPENS, u.opens.length),
    opens: u.opens.slice(0, MAX_OPENS).map((o) => ({ id: o.id, count: o.count, last: o.last })),
  },
  untrusted: {},
  see: ["/usage/opens"],
});

/** Panel id to provider. Keyed by READ_PANELS_NOW, so a panel with no provider
 *  is a type error here, and a provider for a panel the registry lacks is one too. */
export const PROVIDERS: { [P in NowPanel]: (src: Sources) => UiSnapshot } = {
  view: (s) => finish(view(s)),
  bench: (s) => finish(bench(s)),
  gates: (s) => finish(gates(s)),
  "settings.diff": (s) => finish(diff(s)),
  "settings.terminal": (s) => finish(terminal(s)),
  "settings.browser": (s) => finish(browser(s)),
  "settings.notifications": (s) => finish(notifications(s)),
  "settings.prefs": (s) => finish(prefs(s)),
  "settings.rail": (s) => finish(rail(s)),
  "settings.keys": (s) => finish(keys(s)),
  "settings.tasks": (s) => finish(tasks(s)),
  "settings.appearance": (s) => finish(appearance(s)),
  "settings.understudy": (s) => finish(understudy(s)),
};

/** The same, for the panes the server holds: each asks its route and answers
 *  when it has the reply. Keyed by READ_PANELS_LATE. */
export const LATE_PROVIDERS: { [P in LatePanel]: (src: Sources) => Promise<UiSnapshot> } = {
  "settings.hooks": (s) => s.later.hooks().then((d) => finish(hooks(d))),
  "settings.lantern": (s) => s.later.lantern().then((d) => finish(lantern(d))),
  "settings.budgets": (s) => s.later.budgets().then((d) => finish(budgets(d))),
  "settings.recipes": (s) => s.later.recipes().then((d) => finish(recipes(d))),
  "settings.review-prompts": (s) => s.later.reviewPrompts().then((d) => finish(reviewPrompts(d))),
  "settings.saved-replies": (s) => s.later.savedReplies().then((d) => finish(savedReplies(d))),
  "settings.tmux": (s) => s.later.tmux().then((d) => finish(tmux(d))),
  "settings.privacy": (s) => s.later.privacy().then((d) => finish(privacy(d))),
  "settings.plugins": (s) => s.later.plugins().then((d) => finish(plugins(d))),
  "settings.log": (s) => s.later.log().then((d) => finish(log(d))),
  "settings.about": (s) => s.later.about().then((d) => finish(about(d))),
  "machine.disk": (s) => s.later.diskClean().then((d) => finish(diskClean(d))),
  "usage.accounts": (s) => s.later.usageAccounts().then((d) => finish(usageAccounts(d))),
  usage: (s) => s.later.usageOpens().then((d) => finish(usage(d))),
};

const isLate = (p: ReadPanel): p is LatePanel => (READ_PANELS_LATE as readonly string[]).includes(p);

/** What `ui.read` answers with: at once for a pane the window holds, a promise
 *  for one the server does. */
export const readPanel = (panel: ReadPanel, src: Sources): UiSnapshot | Promise<UiSnapshot> =>
  isLate(panel) ? LATE_PROVIDERS[panel](src) : PROVIDERS[panel as NowPanel](src);

/** `ui.state`: what is open now, and which panels `ui.read` can describe. */
export function uiState(src: Sources): UiSnapshot {
  const a = src.app();
  const open = Object.entries(a.modals).filter(([, v]) => v !== false && v !== null).map(([k]) => k);
  if (a.selectedEvent) open.push("event");
  if (a.session) open.push("session");
  if (a.peek) open.push("peek");
  return finish({
    state: {
      view: a.view, open,
      readers: [...READ_PANELS].map((panel) => ({ panel, needsMount: false, asksServer: isLate(panel) })),
      notCovered: Object.keys(UI_READ_NOT_COVERED),
      refusedForAgents: Object.keys(UI_REFUSED_FOR_AGENTS),
    },
    untrusted: {},
    see: ["ui.read"],
  });
}
