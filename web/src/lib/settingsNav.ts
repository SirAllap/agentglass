/*
 * The decisions behind the Settings shell, with no React in them.
 *
 * The nav, the search panel, the page header and the "On this page" index are
 * frames around a page; what each one shows is decided here so it can be
 * asserted without mounting anything (there is no renderer in this project).
 * The components only draw what these functions return.
 *
 * A mark is a fact about a page that the person might care about from the
 * nav: it is on, it is off, it wants them, or an update is waiting. A page
 * with no real signal behind it has no mark at all — nothing in here invents
 * one, and `navMarks` leaves a page out when its fact has not been read yet.
 */
import { SETTINGS_ROWS, expandWord, rowId, rowMatches, searchSettings, type SettingsPage } from "./settingsIndex.ts";

/* ── groups ── */

export type NavGroupId = "general" | "workspace" | "agents" | "library" | "connections" | "system";
export type NavGroupName = "General" | "Workspace" | "Agents" | "Library" | "Connections" | "System";

export interface NavGroup {
  id: NavGroupId;
  /** The `group` a TABS entry carries. */
  name: NavGroupName;
  /** The group's glyph in its chip; drawn by SettingsNav. */
  icon: "cog" | "window" | "bot" | "shelf" | "link";
}

/** Five groups that collapse, in the order they are drawn. */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "general", name: "General", icon: "cog" },
  { id: "workspace", name: "Workspace", icon: "window" },
  { id: "agents", name: "Agents", icon: "bot" },
  { id: "library", name: "Library", icon: "shelf" },
  { id: "connections", name: "Connections", icon: "link" },
];
/** Pinned under the scroller, never collapses: Data & privacy and About. */
export const SYSTEM_GROUP: NavGroup = { id: "system", name: "System", icon: "cog" };
const ALL_GROUPS: readonly NavGroup[] = [...NAV_GROUPS, SYSTEM_GROUP];

export const groupByName = (name: string): NavGroup | undefined => ALL_GROUPS.find((g) => g.name === name);
/** The CSS custom property that tints a group (`--g-agents`), light and dark values in index.css. */
export const hueVar = (g: NavGroupId): string => `var(--g-${g})`;

/** Shut on a first visit: the group a person reaches for least. */
export const DEFAULT_SHUT: readonly NavGroupId[] = ["library"];
export const NAV_SHUT_KEY = "agentglass.settings.navShut";

/** What localStorage held, read defensively: anything that is not a list of
 *  known group ids is the default, so a hand-edited or stale value cannot
 *  hide a group for good. */
export function parseShut(raw: string | null): Set<NavGroupId> {
  if (raw === null) return new Set(DEFAULT_SHUT);
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return new Set(DEFAULT_SHUT);
    return new Set(NAV_GROUPS.filter((g) => v.includes(g.id)).map((g) => g.id));
  } catch { return new Set(DEFAULT_SHUT); }
}
export const serializeShut = (s: ReadonlySet<NavGroupId>): string => JSON.stringify(NAV_GROUPS.filter((g) => s.has(g.id)).map((g) => g.id));

/** Going to a page opens its group, as a link into a shut group would otherwise land on nothing. */
export function openGroupOf(shut: ReadonlySet<NavGroupId>, pageGroup: NavGroupId | undefined): Set<NavGroupId> {
  const next = new Set(shut);
  if (pageGroup) next.delete(pageGroup);
  return next;
}

/* ── marks ── */

export type MarkState = "on" | "off" | "needs" | "update" | "err" | "none";
export interface PageMark {
  state: MarkState;
  /** A needs-you count (or a short word such as "82%"). */
  count?: number | string;
  title?: string;
  /** `err` only: the words of the page header's red chip. */
  chip?: string;
  /** A page that is working and still wants something (hooks wired, gate off): the header keeps its green chip beside the needs-you one. */
  wired?: true;
}
export const NO_MARK: PageMark = { state: "none" };

/** What each fact is, read once when Settings opens. `null` is "not read yet" and draws nothing. */
export interface NavFacts {
  hooksWired: boolean | null;
  /** The gate is switched off in a build that ships one: a decision still waiting for the person. */
  gateOff?: boolean | null;
  tmuxOk: boolean | null;
  /** Tools and services that are missing or not connected. */
  connectionsNeed: number | null;
  /** A paired device is connected right now. */
  remoteLive: boolean | null;
  /** Crash loops and spikes in the server log; 0 is quiet. */
  clickupConnected: boolean | null;
  jiraConnected: boolean | null;
  lanternWatching: boolean | null;
  updateAvailable: boolean | null;
  notificationsOn: boolean | null;
  /** Plugins running now, and plugins waiting on a person's approval. */
  pluginsRunning: number | null;
  pluginsNeed: number | null;
}

export const NO_FACTS: NavFacts = {
  hooksWired: null, tmuxOk: null, connectionsNeed: null, remoteLive: null,
  clickupConnected: null, jiraConnected: null, lanternWatching: null, updateAvailable: null, notificationsOn: null,
  pluginsRunning: null, pluginsNeed: null,
};

const onOff = (v: boolean | null): PageMark | null => (v === null ? null : { state: v ? "on" : "off" });

/**
 * One mark per page that has a real fact behind it. A page absent from the
 * result is a page with nothing to say.
 *
 * About carries the log count before the update: a crash loop wants somebody,
 * an update only waits; the update still shows as a chip on the page itself.
 */
export function navMarks(f: NavFacts): Record<string, PageMark> {
  const out: Record<string, PageMark> = {};
  const set = (id: string, m: PageMark | null) => { if (m) out[id] = m; };
  set("hooks", f.hooksWired === null ? null : f.hooksWired
    ? (f.gateOff ? { state: "needs", count: 1, title: "The gate is off", wired: true } : { state: "on" })
    : { state: "needs", count: 1, title: "Claude Code hooks are not wired in" });
  set("tmux", f.tmuxOk === null ? null : f.tmuxOk
    ? { state: "on" } : { state: "needs", count: 1, title: "tmux is not on this machine" });
  set("connections", f.connectionsNeed === null || f.connectionsNeed <= 0 ? null
    : { state: "needs", count: f.connectionsNeed, title: `${f.connectionsNeed} ${f.connectionsNeed === 1 ? "tool or service needs" : "tools or services need"} setup` });
  set("remote", onOff(f.remoteLive));
  set("clickup", f.clickupConnected ? { state: "on" } : null);
  set("jira", onOff(f.jiraConnected));
  set("lantern", onOff(f.lanternWatching));
  set("notifications", onOff(f.notificationsOn));
  if (f.pluginsNeed) set("plugins", { state: "needs", count: f.pluginsNeed, title: `${f.pluginsNeed} ${f.pluginsNeed === 1 ? "plugin waits" : "plugins wait"} for your approval` });
  else if (f.pluginsRunning) set("plugins", { state: "on", count: f.pluginsRunning, title: `${f.pluginsRunning} running` });
  if (f.updateAvailable) set("about", { state: "update", title: "An update is ready" });
  return out;
}

/** How many of a group's pages want a person: the number on a collapsed group. A page that failed to read wants one too. */
/** What the nav's legend explains. A red dot (a page that reported a problem) is drawn only while one exists, so its word is only there then. */
export const legendStates = (marks: Readonly<Record<string, PageMark | undefined>>): ("on" | "needs" | "off" | "err")[] =>
  Object.values(marks).some((m) => m?.state === "err") ? ["on", "needs", "off", "err"] : ["on", "needs", "off"];

export const rollup = (marks: readonly PageMark[]): number => marks.filter((m) => m.state === "needs" || m.state === "err").length;

/**
 * What a page reports about itself when it could not read or reach what it
 * shows: the words of its red header chip, and the sentence under the nav dot.
 * The page owns the state (its own fetch failed); the shell only draws it.
 */
export interface PageProblem { chip: string; title: string }

/** What a page says only the person can do: the amber count on the nav and the sentence under it. */
export interface PageNeed { count: number; title: string }

/** Pages' own "needs you" reports as nav marks. Amber is for what a person must do and the title says what;
 *  a problem (red) from the same page still wins in `withProblems`, which runs after this. */
export function withNeeds(marks: Readonly<Record<string, PageMark>>, needs: Readonly<Record<string, PageNeed>>): Record<string, PageMark> {
  const out: Record<string, PageMark> = { ...marks };
  for (const [id, n] of Object.entries(needs)) if (n.count > 0) out[id] = { state: "needs", count: n.count, title: n.title };
  return out;
}

/** Tools & services that want the person: a required tool missing or a tool that needs attention, and a service that
 *  errored. An optional CLI that is not installed and a service nobody connected are neutral on the page, so here too. */
export function connectionsNeeding(deps: readonly { status: string; required?: boolean }[], provs: readonly { state: string }[]): number {
  return deps.filter((d) => d.status === "attention" || (d.status === "missing" && !!d.required)).length
    + provs.filter((p) => p.state === "error").length;
}

/** A page that reported a problem turns its nav mark red, over whatever the open-time facts said:
 *  the fact is a guess from one read, the report is what the page itself just failed at. */
export function withProblems(marks: Readonly<Record<string, PageMark>>, problems: Readonly<Record<string, PageProblem>>): Record<string, PageMark> {
  const out: Record<string, PageMark> = { ...marks };
  for (const [id, p] of Object.entries(problems)) out[id] = { state: "err", title: p.title, chip: p.chip };
  return out;
}

export interface NavPageIn { id: string; label: string; group: string }
export interface NavPage extends NavPageIn { mark: PageMark }
export interface NavSection { group: NavGroup; pages: NavPage[]; shut: boolean; rollup: number }
export interface NavModel { sections: NavSection[]; system: NavSection | null }

/**
 * The nav, ready to draw: pages filed under their group in the order given
 * (TABS order is the nav order), a group with no page dropped, a shut group
 * carrying the count of its pages that want you. A page filed under no group
 * ("" or "Get started") is in no section, which is how Activity stays link-only.
 */
export function buildNav(pages: readonly NavPageIn[], marks: Readonly<Record<string, PageMark | undefined>>, shut: ReadonlySet<NavGroupId>): NavModel {
  const section = (g: NavGroup): NavSection | null => {
    const ps = pages.filter((p) => p.group === g.name).map((p) => ({ ...p, mark: marks[p.id] ?? NO_MARK }));
    if (!ps.length) return null;
    return { group: g, pages: ps, shut: g.id !== "system" && shut.has(g.id), rollup: rollup(ps.map((p) => p.mark)) };
  };
  return {
    sections: NAV_GROUPS.map(section).filter((s): s is NavSection => s !== null),
    system: section(SYSTEM_GROUP),
  };
}

/* ── page header chips ── */

export type ChipTone = "ok" | "warn" | "err" | "info" | "off" | "saving";
export interface HeaderChip { tone: ChipTone; text: string }

/** The words a page's own on and off mean. A page not listed says nothing for them. */
const STATE_WORDS: Record<string, { on?: string; off?: string }> = {
  hooks: { on: "Hooks wired" },
  tmux: { on: "tmux ready" },
  notifications: { on: "On", off: "Silenced" },
  lantern: { on: "Watching", off: "Paused" },
  jira: { on: "Connected", off: "Not connected" },
  clickup: { on: "Connected" },
  remote: { on: "Device connected", off: "No device" },
};

/** Chips for a page header, from the page's mark and nothing else: the header
 *  can never say something the nav does not. A write that is out adds "Saving"
 *  after the verdict: the page keeps saying what it was while it saves. */
export function headerChips(id: string, mark: PageMark, saving = false, saved = false, own?: readonly HeaderChip[]): HeaderChip[] {
  /* A page that counts its own things (engines: ready, need you, not installed) says so in its words;
     a page that could not be read keeps the red chip. */
  const chips = own?.length && mark.state !== "err" ? [...own] : markChips(id, mark);
  if (saving) return [...chips, { tone: "saving", text: "Saving" }];
  return saved ? [...chips, { tone: "ok", text: "Saved" }] : chips;
}

function markChips(id: string, mark: PageMark): HeaderChip[] {
  if (mark.state === "err") return [{ tone: "err", text: mark.chip ?? "Not reachable" }];
  const w = STATE_WORDS[id] ?? {};
  if (id === "plugins" && mark.state === "on") return [{ tone: "ok", text: `${mark.count} running` }];
  if (mark.state === "on" && w.on) return [{ tone: "ok", text: w.on }];
  if (mark.state === "off" && w.off) return [{ tone: "off", text: w.off }];
  if (mark.state === "needs") {
    /* Says what, in the page's own words: a count of "needs you" with nothing
       named is a mark nobody can act on. A page that works and still wants a
       decision (hooks wired, gate off) keeps its green word beside it. */
    const needs: HeaderChip = { tone: "warn", text: mark.title ?? "Needs you" };
    return mark.wired && w.on ? [{ tone: "ok", text: w.on }, needs] : [needs];
  }
  if (mark.state === "update") return [{ tone: "info", text: "Update available" }];
  return [];
}

/* ── search ── */

export type MatchIn = "help" | "names";

export interface SearchHit {
  pane: string;
  /** "" is a page-level hit: land on the page, there is no row to flash. */
  row: string;
  label: string;
  section: string;
  hint: string;
}
export interface SearchPage { pane: string; label: string; group: NavGroup | null; hits: SearchHit[] }
export interface SearchModel {
  pages: SearchPage[];
  /** Every hit in the order it is drawn: what ↑↓ walks and Enter reads. */
  flat: SearchHit[];
}

const hintOf = new Map<string, string>();
const hintFor = (pane: string, label: string): string => {
  if (!hintOf.size) for (const r of SETTINGS_ROWS) hintOf.set(`${r.pane}\u0000${rowId(r.label)}`, r.hint);
  return hintOf.get(`${pane}\u0000${rowId(label)}`) ?? "";
};

/**
 * What the query finds, as pages each holding the rows that matched, in rank
 * order: the page whose best row ranks first comes first, and a page's rows
 * keep their own rank. "Names" narrows to rows whose own label answers the
 * query (and to pages whose title does); "Names + help" also reads hints,
 * section titles and a page's keyword bag, which is what the index always did.
 */
export function groupSearch(ql: string, pages: readonly (SettingsPage & { group: string })[], mode: MatchIn): SearchModel {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ranked = searchSettings(ql, [...pages]).filter((r) => {
    if (mode === "help") return true;
    return rowMatches(r.row ? r.label : byId.get(r.pane)?.label ?? "", ql);
  });
  const order: string[] = [];
  const by = new Map<string, SearchHit[]>();
  for (const r of ranked) {
    if (!by.has(r.pane)) { by.set(r.pane, []); order.push(r.pane); }
    by.get(r.pane)!.push({ pane: r.pane, row: r.row, label: r.label, section: r.section, hint: r.row ? hintFor(r.pane, r.label) : "" });
  }
  const out = order.map((pane) => ({ pane, label: byId.get(pane)?.label ?? pane, group: groupByName(byId.get(pane)?.group ?? "") ?? null, hits: by.get(pane)! }));
  return { pages: out, flat: out.flatMap((p) => p.hits) };
}

/** The line over the results: "5 settings on 3 pages for “deny”". */
export function searchSummary(model: SearchModel, q: string): string {
  const n = model.flat.length, p = model.pages.length;
  return `${n} setting${n === 1 ? "" : "s"} on ${p} page${p === 1 ? "" : "s"} for “${q.trim()}”`;
}

/** ↑ and ↓ over the drawn rows; past either end it wraps, so the keys never dead-end. */
export function moveSelection(i: number, delta: 1 | -1, n: number): number {
  return n <= 0 ? 0 : (((i + delta) % n) + n) % n;
}

/** What Enter does: the page and row to land on, or null when nothing is selected. */
export function jumpTarget(model: SearchModel, i: number): { pane: string; row: string } | null {
  const h = model.flat[Math.min(Math.max(i, 0), model.flat.length - 1)];
  return h ? { pane: h.pane, row: h.row } : null;
}

/** Words a hit was reached through only by a synonym ("chime" for "sound"): said once, so a search never silently swaps a word. */
export function synonymsUsed(ql: string, model: SearchModel): string[] {
  const texts = model.flat.map((h) => `${h.label} ${h.section}`.toLowerCase());
  const used = new Set<string>();
  for (const w of ql.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const e of expandWord(w)) if (e.synonym && texts.some((t) => t.includes(e.word))) used.add(e.word);
  }
  return [...used];
}

/** `text` cut into runs, the ones a typed word (or a synonym of it) matched flagged, for a <mark>. */
export function highlightParts(text: string, ql: string): { t: string; hit: boolean }[] {
  const words = [...new Set(ql.trim().toLowerCase().split(/\s+/).filter(Boolean).flatMap((w) => expandWord(w).map((e) => e.word)))]
    .sort((a, b) => b.length - a.length);
  if (!words.length || !text) return [{ t: text, hit: false }];
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(" + words.map(esc).join("|") + ")", "i");
  // split with one capture group puts every match at an odd index
  return text.split(re).map((t, i) => ({ t, hit: i % 2 === 1 })).filter((p) => p.t !== "");
}

/* ── On this page ── */

export interface CardInfo { title: string; tone: string | null }
export interface TocItem { id: string; label: string; dot: "ok" | "warn" | "err" | null }

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "card";

/**
 * The index of a page, from the titles of its cards. A card with no title has
 * no entry, and a page with fewer than two titled cards has no index (one
 * entry is a link to the page you are on). Anchors are `c-<title>`, with a
 * counter when two cards share a title. A card's header badge decides its dot:
 * ok, warn and err draw one; off and checking do not, since nothing in them
 * asks for a look.
 */
export function tocItems(cards: readonly CardInfo[]): TocItem[] {
  const seen = new Map<string, number>();
  const items = cards.filter((c) => c.title.trim()).map((c) => {
    const base = `c-${slug(c.title)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const dot: TocItem["dot"] = c.tone === "ok" || c.tone === "warn" || c.tone === "err" ? c.tone : null;
    return { id: n === 1 ? base : `${base}-${n}`, label: c.title.trim(), dot };
  });
  return items.length < 2 ? [] : items;
}

/** The entry that is current: of the cards whose top has reached `line` (a
 *  sticky header's bottom edge, plus a little), the one that got there most
 *  recently, which is the one whose top is nearest the line. In one column that is the
 *  last in order; in two or three it is not, because the second column's first
 *  card sits above the first column's third. Equal tops go to the earlier card.
 *  Before any has reached the line, the first. */
export function currentToc(tops: readonly number[], line: number): number {
  let cur = 0, best = -Infinity;
  tops.forEach((t, i) => { if (t <= line && t > best) { cur = i; best = t; } });
  return cur;
}
