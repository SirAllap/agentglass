/*
 * The Inbox's rows, built from what the phone can read.
 *
 * Six sources, one ordered list: a held command, a settings request, a review
 * asked of you, an agent stopped on somebody, a flight plan waiting for a Go,
 * and a watch that fired. The ordering and the words live in `shared/inbox.ts`;
 * this file is the middle layer that turns each route's own shape into a row and
 * decides, from the pairing's scope, which of them this phone may act on.
 *
 * ── where a plan and a fire sit, and why ─────────────────────────────────
 * A plan waiting for Go is `blocking`: the launch is stopped until somebody
 * answers, which is the word `blocking` means. A watch fire is news, so it is
 * `warn` when it reports a pass and `error` when it reports a failure — the
 * same three words the desk uses, in the same order. That is also what puts a
 * Go card above a fire without either list sorting itself.
 *
 * ── every source is optional, and a missing one is not an empty one ───────
 * A source that did not answer contributes no rows and says so in `missing`;
 * it never empties the list, because an unreachable route and "nothing is
 * waiting" are different answers and only one of them means you can relax.
 * `failed` carries the sentence `describeFailure` produced for that route.
 *
 * ── no renderer ──────────────────────────────────────────────────────────
 * `collectInbox` is data in and data out, which is what lets the test hold the
 * order, the scope and the count against hand-built fixtures instead of a
 * screen. The screens (src/inbox/*) only draw what comes out.
 */
import { attention, howLong, type FieldRow } from "../../../shared/fieldRules.ts";
import { inboxCount, sortInbox, type InboxItem, type InboxSource } from "../../../shared/inbox.ts";
import type { DeviceScope, PendingGate } from "../../../shared/types.ts";
import type { SettingRequestView } from "../../../shared/settingClass.ts";
import { gateDetail, gateWhere, waited } from "./gates.ts";
import { requestTitle } from "./settingsRequests.ts";
import { canAnswer } from "./scope.ts";

export type { InboxItem };

/** A pull request tagged with the checkout that asked, as the fleet holds it. */
export interface ReviewWaiting {
  root: string;
  repo: string;
  pr: { number: number; title: string; author: string; updatedAt?: string };
}

/** The fields of `/agents/board`'s rows this list reads. `FieldRow` is the
 *  same rule the watch and the desk's strip use, so a stopped agent is one
 *  definition in three places. */
export interface StoppedAgent extends FieldRow {
  name?: string;
  session?: string;
  branch?: string;
  worktree?: string;
  /** What it left behind, when it ended a turn without saying it was done. */
  left?: string;
  /** The last hour in five-minute buckets (`seatpulse.ts`), which is the only
   *  sign a status line did not write: a status is a claim, this is movement. */
  pulse?: number[];
}

/** A watch that fired, as `/prs/notify-watch/pending` keeps it. Older than
 *  `shared/types.ts`'s `PrWatchFire` in one way that matters here: the queue
 *  carries no clock, only the order it was decided in (`seq`). */
export interface WatchWaiting {
  seq: number;
  repo: string;
  number: number;
  title?: string;
  /** "CI passed", "CI failed", "New comment". */
  summary: string;
  detail?: string;
  ok: boolean;
  alertId?: string;
  payload?: { title?: string; line?: string; target?: { kind?: string; root?: string } };
}

/** The fields of a flight plan this list reads. A plan is waiting when its
 *  state is `ready`; the rest of its life is Phase 5's. */
export interface PlanWaiting {
  id: string;
  title: string;
  root: string;
  state?: string;
  size?: string;
  updatedAt?: number;
  /** What its builder starts on, and why — the Go card's launch line. */
  launch?: { mode?: string; model?: string; why?: string };
  queued?: boolean;
  stopReason?: string | { text?: string } | null;
}

export interface InboxFailure {
  /** The route's name, not its path: a path on a screen is a code. */
  source: "gates" | "settings" | "reviews" | "agents" | "plans" | "watches";
  error: string;
}

export interface InboxAnswers {
  gates?: readonly PendingGate[] | null;
  settings?: readonly SettingRequestView[] | null;
  reviews?: readonly ReviewWaiting[] | null;
  agents?: readonly StoppedAgent[] | null;
  plans?: readonly PlanWaiting[] | null;
  watches?: readonly WatchWaiting[] | null;
  failed?: readonly InboxFailure[];
}

export interface InboxView {
  items: InboxItem[];
  /** The bell's number: exactly `items.length`. */
  count: number;
  /** One sentence per route that did not answer. */
  missing: string[];
}

const SOURCE_WORD: Record<InboxSource, string> = {
  gate: "Gate",
  settings: "Settings",
  review: "Review",
  agent: "Agent",
  plan: "Decision",
  watch: "Watch",
};

/** The chip's word, beside the row. */
export const sourceWord = (source: InboxSource): string => SOURCE_WORD[source];

const FAILURE_WORD: Record<InboxFailure["source"], string> = {
  gates: "Gates",
  settings: "Settings requests",
  reviews: "Review requests",
  agents: "Stopped agents",
  plans: "Flight plans",
  watches: "Watches",
};

/**
 * Why a phone that may not act on a row is not offered its control, in one
 * line. Here rather than in the row's drawing for the reason the ordering is:
 * it is a fact about the pairing, and a test can hold it as data.
 */
export const WHY_NOT = {
  plan: "Go launches a builder and spends a worker. This phone was paired to look only — pair with Everything to say Go.",
  settings: "This phone may only look. Answering a settings request needs the answer access chosen when a phone was paired.",
  watch: "Arming a watch writes a rule on the computer. This phone was paired to look only — pair with Everything to be told when it changes.",
} as const;

/** The last segment of a checkout, the way a row can name a project without
 *  the path. */
const projectOf = (root: string): string => root.split("/").filter(Boolean).pop() ?? root;

function gateRows(gates: readonly PendingGate[], scope: DeviceScope | null | undefined, now: number): InboxItem[] {
  return gates.map((g) => ({
    id: `gate:${g.id}`,
    level: "blocking",
    source: "gate",
    text: `${gateDetail(g)} is held for approval`,
    detail: `${gateWhere(g)} · waiting ${waited(g.created, now)}`,
    at: g.created,
    // Answering is ANSWER_POST; a read phone sees it and cannot.
    canAct: canAnswer(scope),
    action: { kind: "gate", id: g.id },
  }));
}

function settingsRows(
  list: readonly SettingRequestView[], scope: DeviceScope | null | undefined, now: number,
): InboxItem[] {
  return list
    // An expired request is not waiting; the server has already declined it.
    .filter((r) => r.expires > now)
    .map((r) => {
      const minutes = Math.max(0, Math.round((r.expires - now) / 60_000));
      return {
        id: `setting:${r.id}`,
        level: "blocking",
        source: "settings" as const,
        text: requestTitle(r),
        detail: `${r.who} asks · ${minutes ? `expires in ${minutes} min` : "expiring now"}`,
        at: r.at,
        canAct: canAnswer(scope),
        action: { kind: "settings" as const, id: r.id },
      };
    });
}

function reviewRows(reviews: readonly ReviewWaiting[], now: number): InboxItem[] {
  const seen = new Set<string>();
  const out: InboxItem[] = [];
  for (const row of reviews) {
    // Two checkouts of one repository answer with the same pull request.
    const key = `${row.repo}#${row.pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = Date.parse(row.pr.updatedAt ?? "");
    out.push({
      id: `review:${key}`,
      level: "warn",
      source: "review",
      text: `#${row.pr.number} ${row.pr.title}`,
      detail: `${row.repo} · ${row.pr.author} asked for your review`,
      // No date is not "ancient": it joins the newest row of its level rather
      // than jumping ahead of a gate that has been waiting all morning.
      at: Number.isFinite(at) ? at : now,
      canAct: true,
      action: { kind: "review", root: row.root, repo: row.repo, number: row.pr.number },
    });
  }
  return out;
}

function agentRows(agents: readonly StoppedAgent[], now: number): InboxItem[] {
  const out: InboxItem[] = [];
  for (const a of agents) {
    const why = attention(a, now);
    if (!why) continue;
    const since = a.needsYou?.since ?? a.saidAt ?? now;
    const name = a.name?.trim() || "An agent";
    const said = why === "blocked"
      ? `${name} is stopped on you`
      : why === "left"
        ? `${name} ended its turn and nobody came back`
        : `${name} claimed work and went quiet`;
    out.push({
      id: `agent:${a.session ?? a.name ?? since}`,
      // "left" is an abandoned turn, not advice: it is an error, and the desk
      // gives errors their own level for the same reason.
      level: why === "blocked" ? "blocking" : "error",
      source: "agent",
      text: said,
      detail: `${a.doing?.trim() || "no status"} · ${howLong(since, now)}`,
      at: since,
      // Opening the terminal is a GET; the row asks nothing of the scope.
      canAct: true,
      action: { kind: "agent" },
    });
  }
  return out;
}

function planRows(plans: readonly PlanWaiting[], scope: DeviceScope | null | undefined, now: number): InboxItem[] {
  return plans
    .filter((p) => p.state === "ready")
    .map((p) => {
      const stop = typeof p.stopReason === "string" ? p.stopReason : p.stopReason?.text;
      return {
        id: `plan:${p.id}`,
        // Blocking: the builder does not start until somebody says Go or
        // No-go, so the launch IS stopped. It also puts a Go card above
        // everything the machine merely reports, which is the order a person
        // wants when one press costs a worker.
        level: "blocking" as const,
        source: "plan" as const,
        text: `Go or No-go: ${p.title}`,
        detail: [p.size ?? "M", projectOf(p.root), stop].filter(Boolean).join(" · "),
        at: p.updatedAt ?? now,
        // Go launches a builder and spends a worker: POST, so `full`.
        canAct: scope === "full",
        action: { kind: "plan" as const, id: p.id },
      };
    });
}

/**
 * A watch that fired, from the queue the server keeps for whoever was not
 * there to hear it.
 *
 * The queue carries no clock and no order beyond `seq`, so a fire joins the
 * newest row of its level (`at: now`, as a review with no date does) and its id
 * is zero-padded: the sorter's last tiebreak is the id, and that is what keeps
 * two fires from one read in the order the server decided them.
 */
function watchRows(fires: readonly WatchWaiting[], now: number): InboxItem[] {
  return fires.map((f) => {
    const title = (f.payload?.title || f.title || "").trim();
    const said = (f.payload?.line || f.detail || "").trim();
    const root = f.payload?.target?.kind === "pr" ? f.payload.target.root : undefined;
    return {
      id: `watch:${String(f.seq).padStart(6, "0")}`,
      // A fire that reports a failure is something that went wrong; one that
      // reports a pass is worth knowing. Neither is a thing to answer, which
      // is why a plan's Go outranks both.
      level: f.ok ? ("warn" as const) : ("error" as const),
      source: "watch" as const,
      text: title || `${f.summary} · ${f.repo} #${f.number}`,
      detail: [f.repo ? `${f.repo} #${f.number}` : "", said].filter(Boolean).join(" · "),
      at: now,
      // Opening the pull request is a GET and this phone may do it; settling
      // the fire is a POST, so a read pairing sees the row and cannot clear it.
      canAct: true,
      action: { kind: "watch" as const, seq: f.seq, repo: f.repo, number: f.number, ...(root ? { root } : {}) },
    };
  });
}

/**
 * Every row this phone can see, worst first.
 *
 * A source that is `null` or absent contributes nothing and is not a failure —
 * "not asked yet" and "asked and refused" are different, and only the second
 * reaches `missing`.
 */
export function collectInbox(
  answers: InboxAnswers, scope: DeviceScope | null | undefined, now = Date.now(),
): InboxView {
  const items = [
    ...gateRows(answers.gates ?? [], scope, now),
    ...settingsRows(answers.settings ?? [], scope, now),
    ...reviewRows(answers.reviews ?? [], now),
    ...agentRows(answers.agents ?? [], now),
    ...planRows(answers.plans ?? [], scope, now),
    ...watchRows(answers.watches ?? [], now),
  ];
  const ordered = sortInbox(items);
  return {
    items: ordered,
    count: inboxCount(ordered),
    missing: (answers.failed ?? []).map(
      (f) => `${FAILURE_WORD[f.source]} did not answer — ${f.error}`,
    ),
  };
}

/* ── the agents roster (s23) ──────────────────────────────────────────────

   Read-only, and that is the point of it: starting an agent is a window on
   somebody's computer, so this screen answers "what is running and what does it
   last say" and offers no switch. It is here rather than in its own file
   because it is the same rows the Inbox's agent source reads, given a word each
   — and two shapes of "what is this agent doing" would be two answers. */

export type AgentMood = "working" | "waiting" | "left" | "quiet" | "finished";

export interface AgentLine {
  id: string;
  name: string;
  /** The window or checkout it is in, when the row says. */
  where: string;
  /** One line: the state, how long, and what it said it was on. */
  said: string;
  mood: AgentMood;
  /** The chip's word — the mood, in the second person where it needs to be. */
  word: string;
  /** Newest first. */
  at: number;
  needsYou: boolean;
}

/** The last two buckets carry a life sign: the server's own rule (`movingNow`,
 *  `server/src/seatpulse.ts`), mirrored because the phone cannot import the
 *  server. Ceiling: if that tail changes there, this word is one commit behind. */
const moving = (pulse: number[] | undefined): boolean =>
  !!pulse && pulse.slice(-2).some((n) => n > 0);

const MOOD_WORD: Record<AgentMood, string> = {
  working: "working",
  waiting: "waiting for you",
  left: "ended its turn",
  quiet: "quiet",
  finished: "finished",
};

/**
 * Every agent the computer listed, in the words the roster draws.
 *
 * The three that need somebody come first, because a list of twelve agents
 * whose first row is an idle one hides the row that is stopped on a permission
 * prompt. Inside a mood, the one that has been like that longest leads — the
 * same "who has waited longest" rule the Inbox uses.
 */
export function agentRoster(agents: readonly StoppedAgent[], now = Date.now()): AgentLine[] {
  const out: AgentLine[] = agents.map((a) => {
    const why = attention(a, now);
    const mood: AgentMood = why === "blocked" ? "waiting"
      : why === "left" ? "left"
        : why === "forgotten" ? "quiet"
          : moving(a.pulse) ? "working"
            : "finished";
    const since = a.needsYou?.since ?? a.saidAt ?? now;
    const doing = a.doing?.trim() || a.left?.trim() || "";
    const long = mood === "finished" ? `${howLong(since, now)} ago` : howLong(since, now);
    return {
      id: `agent:${a.session ?? a.name ?? since}`,
      name: a.name?.trim() || "An agent",
      where: (a.worktree || a.branch || "").split("/").filter(Boolean).pop() ?? "",
      said: [`${MOOD_WORD[mood]} ${long}`, doing].filter(Boolean).join(" · "),
      mood,
      word: MOOD_WORD[mood],
      at: since,
      needsYou: mood === "waiting" || mood === "left",
    };
  });
  const rank: Record<AgentMood, number> = { waiting: 0, left: 1, quiet: 2, working: 3, finished: 4 };
  return out.sort((a, b) => rank[a.mood] - rank[b.mood] || a.at - b.at || a.id.localeCompare(b.id));
}

/** "1 working, 1 finished, 1 waiting for you." — the sentence under the list.
 *  Counted from the rows drawn, so the two cannot disagree. */
export function rosterFoot(lines: readonly AgentLine[]): string {
  const n = (mood: AgentMood): number => lines.filter((l) => l.mood === mood).length;
  const parts: string[] = [];
  if (n("working")) parts.push(`${n("working")} working`);
  if (n("finished")) parts.push(`${n("finished")} finished`);
  const need = n("waiting");
  if (need) parts.push(`${need} waiting for you`);
  if (n("left")) parts.push(`${n("left")} ended without saying done`);
  if (n("quiet")) parts.push(`${n("quiet")} quiet for hours`);
  if (!parts.length) return "No agent has reported in this hour.";
  return `${parts.join(", ")}.`;
}
