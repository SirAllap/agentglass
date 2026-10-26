/*
 * THE AGENTS SCREEN, AS DECISIONS.
 *
 * Every number, bar and sentence on the screen is worked out here from the
 * rows the server already sends, so the components only draw and a test can
 * pin each rule. There is no model call and no new collection behind any of it.
 *
 * Who is blocked is `attention` in shared/fieldRules.ts, the one rule the
 * watch and the dashboard strip read; this file does not restate it.
 */
import { attention, isGone } from "../../../shared/fieldRules.ts";
import { titleOfMatch } from "./agentRulesView.ts";

const MIN = 60_000;
const HOUR = 3_600_000;

/** The scale of every age bar: four hours fills it. A blocker older than that is as red as it gets. */
export const AGE_SCALE_MS = 4 * HOUR;

/** "3 min", "2 h", "42 d": the card's words for how long. Floored, like `howLong`. */
export function ageWord(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MIN));
  return m < 1 ? "now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}
/** The same, without the space, for the tile's thin rows: "3m", "2h". */
export const ageShort = (ms: number): string => ageWord(ms).replace(" min", "m").replace(" h", "h").replace(" d", "d");

/** How full an age bar is, out of 100: never empty, so a fresh blocker still shows. */
export const agePct = (ms: number, scale = AGE_SCALE_MS): number => Math.min(100, Math.max(2, Math.round((Math.max(0, ms) / scale) * 100)));

/** "acme/orbit": the last two folders of a project root, which is how people say it. */
export function projectLabel(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || root;
}

/** The row's own word for what it is doing, from the tool it last used. */
export type Verb = { word: string; icon: "file-text" | "play" | "pencil-simple" | "magnifying-glass" | "link" };
export function doingVerb(tool: string | undefined): Verb | null {
  if (!tool) return null;
  const t = tool.split("__").pop() || tool;
  if (/^(Read|NotebookRead)$/.test(t)) return { word: "Reading", icon: "file-text" };
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t)) return { word: "Writing", icon: "pencil-simple" };
  if (/^(Grep|Glob|LS)$/.test(t)) return { word: "Searching", icon: "magnifying-glass" };
  if (/^(WebFetch|WebSearch)$/.test(t)) return { word: "Browsing", icon: "link" };
  return { word: t.startsWith("Bash") ? "Running" : "Using", icon: "play" };
}

/** The sentence a held tool call asks: `Run make check?`, `Write docs/guide.md?`. */
export function askLine(tool: string, summary: string): { verb: string; target: string } {
  const t = tool.split("__").pop() || tool;
  const target = summary.trim();
  if (t.startsWith("Bash")) return { verb: "Run", target };
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t)) return { verb: "Write", target };
  if (/^Read$/.test(t)) return { verb: "Read", target };
  if (/^(WebFetch|WebSearch)$/.test(t)) return { verb: "Fetch", target };
  return { verb: "Use", target: target ? `${t} ${target}` : t };
}

/** The tool pattern an "Always allow here" click becomes, in the `launch.deny` syntax. */
export function matchFor(tool: string, summary: string): string {
  const t = tool.trim();
  const s = summary.trim();
  if (!s) return t;
  if (t === "Bash") {
    /* The command's first two words are the habit ("make check", "npm test");
       anything longer would be a rule nobody ever matches twice. */
    const words = s.split(/\s+/).slice(0, 2).join(" ");
    return `Bash(${words}:*)`;
  }
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t)) {
    const dir = s.includes("/") ? s.slice(0, s.lastIndexOf("/") + 1) : "";
    return dir ? `${t}(${dir}**)` : t;
  }
  return t;
}

/** A person's name for a rule pattern: the rules section's own words (lib/agentRulesView.ts), so the card and the list never name one rule two ways. */
export const ruleTitleOf = titleOfMatch;

/** Parse the settings door's diff line for a rule: "Bash(git push:*): never -> allow". */
export function parseRuleDiff(line: string | undefined): { match: string; from: string; to: string } | null {
  const m = /^(.+): (allow|ask|never|no rule) -> (allow|ask|never)$/.exec((line ?? "").trim());
  return m ? { match: m[1]!, from: m[2]!, to: m[3]! } : null;
}

/* ── who is where ─────────────────────────────────────────────────────── */

export interface RowLike {
  name: string; role?: string; paneId?: string; session?: string; branch?: string; worktree?: string;
  state: "working" | "waiting" | "idle"; saidAt?: number; doing?: string; gone?: boolean;
  needsYou?: { kind: string; why: string; since: number };
  facts?: { cost?: number; lastSeen?: number; lastTool?: { name: string; what: string; at: number } };
  pulse?: number[];
}

export interface Sorted<R extends RowLike> { working: R[]; blocked: R[]; idle: R[]; gone: R[] }

/**
 * The field, sorted the way the three cards count it. The Lantern's own chat
 * and the coordinator are set aside: both read this board, and a reader of the
 * board that shows up on it is not work on it.
 *
 *   blocked  a permission or a held gate: it cannot go on without you
 *   working  something ran lately and nobody is stopping it
 *   idle     everything else, including a turn that merely ended (that is most
 *            sessions most of the time, and not an interruption)
 *   gone     a name with no pane and hours of silence: folded, never counted
 */
export function sortField<R extends RowLike>(rows: readonly R[], now = Date.now()): Sorted<R> {
  const out: Sorted<R> = { working: [], blocked: [], idle: [], gone: [] };
  for (const r of rows) {
    if (r.role) continue;
    if (attention(r, now) === "blocked") out.blocked.push(r);
    else if (r.gone || isGone(r, now)) out.gone.push(r);
    else if (r.state === "working") out.working.push(r);
    else out.idle.push(r);
  }
  return out;
}

export type SquareKind = "g" | "r" | "i";
/** The working card's squares: one per agent, green, red or grey, at least four so an empty field still has a shape. */
export function squares(counts: { working: number; blocked: number; idle: number }, cap = 10, min = 4): { kinds: SquareKind[]; more: number } {
  const all: SquareKind[] = [
    ...Array<SquareKind>(counts.working).fill("g"), ...Array<SquareKind>(counts.blocked).fill("r"), ...Array<SquareKind>(counts.idle).fill("i"),
  ];
  const shown = all.slice(0, cap);
  while (shown.length < min) shown.push("i");
  return { kinds: shown, more: Math.max(0, all.length - cap) };
}

/** A bar's share of the busiest spender, never below the mockup's $1 floor so small sums read as small. */
export function spendPct(cost: number, all: readonly number[]): number {
  const scale = Math.max(1, ...all);
  return Math.min(100, Math.max(0, Math.round((cost / scale) * 100)));
}
export const dollars = (usd: number): string => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`);

/* ── what waits on the person ─────────────────────────────────────────── */

export interface GateLike { id: string; session_id: string; tool_name: string; summary: string; created: number; where?: string; pane?: string }
export interface NeedLike { id: string; text: string; cost: string; recommend: string; proof: string; created: number }
export interface ReportLike { id: number; agent: string; blocked: string; need: string; at: number }
export interface TaskLike { id: string; title: string; attempts: number; created: number }
export interface RequestLike { id: string; setting: string; label: string; who: string; diff: string[]; at: number }

export type WaitItem =
  | { kind: "permission"; key: string; name: string; branch?: string; paneId?: string; worktree?: string; since: number; why: string; gate?: { id: string; tool: string; summary: string } }
  | { kind: "coordinator"; key: string; since: number; need: NeedLike }
  | { kind: "rule"; key: string; name: string; since: number; request: RequestLike; diff: { match: string; from: string; to: string } | null }
  | { kind: "report"; key: string; name: string; since: number; text: string; paneId?: string }
  | { kind: "task"; key: string; since: number; task: TaskLike };

export const toneOfWait = (k: WaitItem["kind"]): "err" | "warn" => (k === "permission" ? "err" : "warn");

/**
 * Everything that waits on a person, as one list of cards, oldest first inside
 * a kind and blocked agents first overall: the one thing that interrupts you
 * leads, and what a person takes time to decide follows.
 */
export function waitingItems(p: {
  blocked: readonly RowLike[]; gates: readonly GateLike[]; needs: readonly NeedLike[];
  asked: readonly ReportLike[]; orphaned: readonly ReportLike[]; beaten: readonly TaskLike[]; requests: readonly RequestLike[];
}): WaitItem[] {
  const gates = [...p.gates];
  const out: WaitItem[] = [];
  for (const r of p.blocked) {
    const at = gates.findIndex((g) => !!r.session && g.session_id === r.session);
    const g = at >= 0 ? gates.splice(at, 1)[0] : undefined;
    out.push({
      kind: "permission", key: `p-${r.session ?? r.paneId ?? r.name}`, name: r.name, branch: r.branch, worktree: r.worktree, paneId: r.paneId ?? g?.pane,
      since: g?.created ?? r.needsYou!.since, why: r.needsYou!.why,
      ...(g ? { gate: { id: g.id, tool: g.tool_name, summary: g.summary } } : null),
    });
  }
  /* A held call whose row is not on the board is still a call somebody is
     held on: it is drawn, named by where it runs. */
  for (const g of gates) {
    out.push({ kind: "permission", key: `g-${g.id}`, name: g.where || "an agent", paneId: g.pane, since: g.created, why: "", gate: { id: g.id, tool: g.tool_name, summary: g.summary } });
  }
  out.sort((a, b) => a.since - b.since);
  const rest: WaitItem[] = [
    ...p.needs.map((need): WaitItem => ({ kind: "coordinator", key: `n-${need.id}`, since: need.created, need })),
    ...p.requests.map((request): WaitItem => ({ kind: "rule", key: `q-${request.id}`, name: request.who, since: request.at, request, diff: request.setting === "agent.rules" ? parseRuleDiff(request.diff[0]) : null })),
    ...p.asked.map((r): WaitItem => ({ kind: "report", key: `a-${r.id}`, name: r.agent, since: r.at, text: r.need || r.blocked })),
    ...p.orphaned.map((r): WaitItem => ({ kind: "report", key: `o-${r.id}`, name: r.agent, since: r.at, text: `stopped and is no longer here, left blocked: ${r.blocked}` })),
    ...p.beaten.map((task): WaitItem => ({ kind: "task", key: `t-${task.id}`, since: task.created, task })),
  ].sort((a, b) => a.since - b.since);
  return [...out, ...rest];
}

/** The waiting card's thin rows: the oldest three, with who and how long. */
export function waitingMini(items: readonly WaitItem[], now = Date.now()): { name: string; age: string; pct: number; tone: "err" | "warn" }[] {
  return items.slice(0, 3).map((i) => ({
    name: i.kind === "coordinator" ? "coordinator" : i.kind === "task" ? "queue" : i.name,
    age: ageShort(now - i.since), pct: agePct(now - i.since), tone: toneOfWait(i.kind),
  }));
}
