/**
 * What the Activity page says about each row, and how it narrows them.
 *
 * Pure on purpose: every decision the screen makes (which words, which
 * category, what a filter keeps, what the relative time reads) is here, where a
 * test can run it over 0 rows or 4000.
 *
 * What exists as data, honestly: the action log records writes that go through
 * the server (git, docker, pull requests, gates, an agent's panel and settings
 * doors, plugin routes, the policy's own rule on/off). A setting a person
 * changes by hand in the Settings screen is NOT a server write, so it is not
 * here. Worker start/stop have no row of their own either: they show up only
 * when an agent drove them through a door.
 */
import type { ActionRecord, GateRecord } from "../../../shared/types.ts";
import { actorLabel, gateLine, isOrchestration, type ActivityRow } from "./activity.ts";
import { SETTINGS_ROWS } from "./settingsRows.gen.ts";

export type FeedCategory = "settings" | "plugins" | "orchestration" | "code" | "gates";
export type FeedFilter = "all" | FeedCategory | "failures";

export const FEED_FILTERS: { id: FeedFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "settings", label: "Settings" },
  { id: "plugins", label: "Plugins" },
  { id: "orchestration", label: "Orchestration" },
  { id: "code", label: "Code & PRs" },
  { id: "gates", label: "Approvals" },
  { id: "failures", label: "Failures" },
];

const VERBS: Record<string, string> = {
  "/gate/allow": "approved", "/gate/deny": "denied",
  "/git/stage": "staged", "/git/unstage": "unstaged", "/git/discard": "discarded", "/git/commit-staged": "committed",
  "/git/push": "pushed", "/git/pull": "pulled", "/git/fetch": "fetched", "/git/checkout": "checked out",
  "/git/branch-create": "created branch", "/git/branch-delete": "deleted branch", "/git/merge": "merged",
  "/git/rebase": "rebased", "/git/reset": "reset", "/git/tag-create": "created tag", "/git/tag-delete": "deleted tag",
  "/git/worktree-add": "added worktree", "/git/worktree-remove": "removed worktree",
  "/docker/start": "started container", "/docker/stop": "stopped container", "/docker/restart": "restarted container", "/docker/rm": "removed container",
  "/prs/merge": "merged pull request", "/prs/close": "closed pull request", "/prs/review": "reviewed", "/prs/comment": "commented on",
  "/prs/rerun": "re-ran the checks on", "/prs/approve-runs": "approved the workflows on", "/prs/draft": "changed draft state of",
  "policy/on": "turned a rule on", "policy/off": "turned a rule off",
  "chair/no-plan": "found no plan left for", "chair/plan-back": "found a plan again for",
  "jira/session-start-move": "moved a Jira card",
};

/** A route nobody named still reads as words: `/git/stash-drop` -> "stash drop". */
export function verbOf(action: string): string {
  const known = VERBS[action];
  if (known) return known;
  const parts = action.split("/").filter(Boolean);
  const what = parts.slice(1).join(" ").replace(/-/g, " ");
  if (parts[0] === "docker") return `${what} container`;
  if (parts[0] === "prs") return `${what} pull request`;
  return what || action;
}

/** The setting id inside a `/control` target ("as rail2 · plugins.sessionReads.repos"), or "". */
const settingOf = (target: string): string => target.split(" · ").find((t) => /^[a-z]+(\.[A-Za-z]+)+$/.test(t)) ?? "";

export function categoryOf(row: ActivityRow): FeedCategory {
  if (row.kind === "gate") return isOrchestration(row) ? "orchestration" : "gates";
  const a = row.row.action;
  // A door an agent opened: with a dotted setting id in the target it changed a setting, otherwise it opened a panel.
  if (a.startsWith("/control/")) return settingOf(row.row.target) ? "settings" : "orchestration";
  if (isOrchestration(row) && !a.startsWith("policy/")) return "orchestration";
  if (a.startsWith("policy/") || a.startsWith("chair/")) return "orchestration";
  if (a.startsWith("/plugins/") || a.startsWith("/plugin/")) return "plugins";
  if (a.startsWith("/lantern/settings") || a.startsWith("/engines/")) return "settings";
  if (a.startsWith("/gate/")) return "gates";
  return "code";
}

const clean = (s: string) => s.trim();

/** A setting id as the row in Settings names it; an id no row carries reads as its last word split ("sessionReads" -> "session reads"). */
export function settingLabel(id: string): string {
  const row = SETTINGS_ROWS.find((r) => r.settingId === id);
  if (row) return row.label;
  return (id.split(".").pop() ?? id).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** A `/control` target without its "as <seat>" prefix: that part is already the "who". */
const withoutSeat = (target: string): string => target.split(" · ").filter((t) => !t.startsWith("as ")).join(" · ");

const PLUGIN_VERBS: Record<string, string> = {
  enable: "switched on plugin", disable: "switched off plugin", install: "installed plugin",
  "install-from-catalogue": "installed plugin", update: "updated plugin", remove: "removed plugin",
  "allow-unboxed": "let a plugin run without its box:", action: "ran a plugin action:",
  master: "switched plugins on or off", "session-reads": "changed what plugins may read",
};

/** `/plugins/enable` -> "switched on plugin"; a route nobody named reads as its last word, never a path. */
function pluginWhat(action: string, target: string): string {
  const parts = action.replace(/^\/plugins?\//, "").split("/").filter(Boolean);
  const tail = parts[parts.length - 1] ?? "";
  const name = target || parts.slice(0, -1).join(" ");
  const verb = PLUGIN_VERBS[tail] ?? `changed plugin${tail ? ` (${tail.replace(/-/g, " ")})` : ""}`;
  return name ? `${verb} ${name}` : verb;
}

/** Who settled a gate that no person settled: the rule, the clock or the restart. */
const GATE_DECIDER: Record<string, string> = { rule: "A gate rule", timeout: "The timeout", restart: "The server restart" };

/** Who did it, as a person would say it. "" actor on this machine is "You". */
export function whoOf(row: ActivityRow): string {
  const raw = actorLabel(row);
  if (!raw) return row.kind === "gate" && row.row.resolution !== "human" ? (GATE_DECIDER[row.row.resolution ?? ""] ?? "Nobody") : "You";
  if (raw === "policy") return "The policy";
  if (raw.startsWith("seat:")) return raw.slice(5) ? `Orchestrator ${raw.slice(5)}` : "Orchestrator";
  return raw;
}

export interface FeedLine { who: string; what: string; sub: string; ok: boolean; failure: string }

/** One readable sentence: who, what. `sub` is the detail line; never a raw route. */
export function lineOf(row: ActivityRow): FeedLine {
  const who = whoOf(row);
  if (row.kind === "gate") {
    const g: GateRecord = row.row;
    const { verb, note } = gateLine(g);
    const thing = [g.tool_name, g.summary].filter(Boolean).join(" · ");
    return { who, what: `${verb} ${thing || "a held tool call"}`.trim(), sub: clean([note, g.resolution === "human" && g.reason ? `“${g.reason}”` : ""].filter(Boolean).join(" · ")), ok: g.decision !== "deny", failure: "" };
  }
  const a: ActionRecord = row.row;
  const cat = categoryOf(row);
  let what = verbOf(a.action);
  let sub = a.target;
  if (cat === "settings" && a.action.startsWith("/control/")) {
    const setting = settingOf(a.target);
    what = setting ? `changed the setting “${settingLabel(setting)}”` : "changed a setting";
    sub = withoutSeat(a.target).split(" · ").filter((t) => t !== setting).join(" · ");
  } else if (a.action.startsWith("/control/")) {
    const verb = a.action.slice("/control/".length).replace(/[.-]/g, " ");
    const rest = withoutSeat(a.target);
    what = rest && !verb.endsWith(rest) ? `${verb} ${rest}` : verb; sub = "";
  } else if (cat === "plugins") {
    what = pluginWhat(a.action, a.target); sub = "";
  } else if (a.action.startsWith("policy/")) {
    what = verbOf(a.action); sub = [a.target, a.detail].filter(Boolean).join(" · ");
  } else if (a.target) {
    what = `${what} ${a.target}`; sub = "";
  }
  return { who, what, sub: clean(sub), ok: a.ok, failure: a.ok ? "" : (a.detail ?? "it failed") };
}

/** The sentence alone, for search and for a screen reader. */
export const sentenceOf = (row: ActivityRow): string => { const l = lineOf(row); return `${l.who} ${l.what}`; };

/** "just now", "5 min ago", "3 h ago", then the calendar day. The exact time is the hover. */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 14 ? `${d} d ago` : new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export const exactTime = (at: number): string => new Date(at).toLocaleString();

export const isFailure = (row: ActivityRow): boolean => !lineOf(row).ok;

export function matchesFilter(row: ActivityRow, f: FeedFilter): boolean {
  if (f === "all") return true;
  if (f === "failures") return isFailure(row);
  return categoryOf(row) === f;
}

/** Counts for the chips: each chip shows how many rows IT would keep. Pass the rows already narrowed by the search and person (filter "all"). */
export function filterCounts(rows: ActivityRow[]): Record<FeedFilter, number> {
  const out: Record<FeedFilter, number> = { all: rows.length, settings: 0, plugins: 0, orchestration: 0, code: 0, gates: 0, failures: 0 };
  for (const r of rows) { out[categoryOf(r)]++; if (isFailure(r)) out.failures++; }
  return out;
}

/** Everyone who appears, most active first, then by name. Any count of people, 0 included. */
export function whoOptions(rows: ActivityRow[]): { who: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const w = whoOf(r); m.set(w, (m.get(w) ?? 0) + 1); }
  return [...m].map(([who, n]) => ({ who, n })).sort((a, b) => b.n - a.n || a.who.localeCompare(b.who));
}

/** One pass: category chip, person ("" = everyone) and a search over the sentence and its detail line. */
export function narrow(rows: ActivityRow[], o: { filter: FeedFilter; who: string; query: string }): ActivityRow[] {
  const q = o.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (!matchesFilter(r, o.filter)) return false;
    if (o.who && whoOf(r) !== o.who) return false;
    if (!q) return true;
    const l = lineOf(r);
    return `${l.who} ${l.what} ${l.sub}`.toLowerCase().includes(q);
  });
}
