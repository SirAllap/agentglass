import type { PendingGate, SessionRollup, PrSummary, DockerContainer } from "../../../shared/types.ts";
import { sessionTitle } from "../lib/format.ts";
import { baseName } from "../../../shared/projectKey.ts";
import { halt, type Halt, type HaltInput } from "./haltState.ts";

/**
 * "What wants me right now", for a phone.
 *
 * Deliberately not `collectAttention()`. That merges the desktop's sources —
 * the live event stream, and chats kept in localStorage — and a phone has
 * neither: the socket is not subscribed here (a reconnecting socket behind a
 * dark screen is a worse deal than a poll), and localStorage is per-device, so
 * the phone has never seen those chats. What a phone *does* have is the four
 * things below, and they are the ones worth waking up for.
 *
 * The output is data, not JSX: what each item means is worth a test, and what
 * it looks like is not.
 */

export type NowTone = "crit" | "bad" | "good" | "plain";

/** What produced an item, so the view can offer the right buttons and the
 *  right screen to open. */
export type NowOrigin =
  | { t: "gate"; gate: PendingGate }
  | { t: "session"; session: SessionRollup }
  | { t: "pr-red"; pr: PrSummary; root: string }
  | { t: "pr-ready"; pr: PrSummary; root: string }
  | { t: "pr-review"; pr: PrSummary; root: string }
  | { t: "container"; container: DockerContainer }
  | { t: "halt"; root: string; halt: Halt };

export interface NowItem {
  id: string;
  /**
   * What this card is reporting, as a string that stays put while the item does
   * and differs the moment its state moves. It is what "Later" is keyed on, so
   * a card comes back by itself once there is something new to say — see
   * snooze.ts.
   *
   * Every kind writes its own, because only the kind knows which of its fields
   * are the news and which merely tick. `idle 5m` and `Exited (1) 3 hours ago`
   * are in the copy and are not in here.
   */
  mark: string;
  tone: NowTone;
  /** The eyebrow: what kind of thing this is, in the user's words. */
  kind: string;
  title: string;
  sub: string;
  /** A command or other verbatim string worth showing exactly as it is. */
  code?: string;
  /**
   * When this happened — absent when the item honestly has no moment.
   *
   * A halted repository and a stopped container both used `now`, which is not a
   * timestamp: it made the card's header read "now" forever, and inside a band
   * it made the item beat everything real, so a repository mid-rebase sorted
   * above an agent that was blocked and waiting. Items without one sort last in
   * their band and draw no age at all.
   */
  ts?: number;
  origin: NowOrigin;
}

/** Blocked first: an agent waiting on a permission is stopped dead, and every
 *  second of that is wasted. Then things that are broken, then things that are
 *  finished and only need a nod. Recency breaks ties inside a band. */
const RANK: Record<NowTone, number> = { crit: 0, bad: 1, good: 2, plain: 3 };

/** An agent that has said nothing for this long, without having ended, has
 *  almost certainly stopped and is waiting on a human. Under it, it is
 *  probably just thinking. */
const QUIET_MS = 4 * 60_000;
/** Past this, it is not "just stopped" any more, it is yesterday's business
 *  and it does not belong in a queue you are meant to be able to empty. */
const STALE_MS = 12 * 60 * 60_000;

export interface NowInput {
  gates: PendingGate[];
  sessions: SessionRollup[];
  /** Pull requests already scoped to a repo, tagged with which server-side
   *  filter produced them. `review` is the server's own answer to "waiting on
   *  your review", so it is what that claim rests on rather than a guess. */
  prs: { root: string; repo: string; pr: PrSummary; scope: "mine" | "review" }[];
  containers: DockerContainer[];
  /**
   * Each checkout's git state, keyed by root. A repository stopped half-way
   * through a rebase is the purest form of "something needs a person": nothing
   * in it will move again until somebody decides, and until now the phone was
   * the one place that could not even see it.
   */
  trees?: Record<string, HaltInput | undefined>;
  /** Logins the viewer answers to, for "is this mine". */
  me: string;
  now: number;
}

export function buildQueue({ gates, sessions, prs, containers, trees, me, now }: NowInput): NowItem[] {
  const out: NowItem[] = [];

  for (const [root, tree] of Object.entries(trees ?? {})) {
    const h = halt(tree);
    if (!h) continue;
    out.push({
      id: `halt:${root}`,
      // The state and how many files are still in the way. Resolving one of
      // three is progress worth being told about; the clock is not in here.
      mark: `halt:${root}:${h.state}:${h.conflicts.length}`,
      tone: "crit",
      kind: "Stopped part-way",
      title: `${baseName(root)}: ${h.title.toLowerCase()}`,
      sub: h.sub,
      // No `ts`: git does not record when it stopped, and the only number to
      // hand is the clock.
      origin: { t: "halt", root, halt: h },
    });
  }

  for (const g of gates) {
    out.push({
      id: `gate:${g.id}`, mark: `gate:${g.id}`, tone: "crit",
      kind: "Blocked · waiting on you",
      title: g.summary || g.tool_name,
      sub: `${g.source_app} · the agent is stopped until you answer`,
      code: g.summary && g.summary !== g.tool_name ? undefined : g.tool_name,
      ts: g.created, origin: { t: "gate", gate: g },
    });
  }

  for (const s of sessions) {
    if (s.ended_at) continue;
    const quiet = now - s.last_seen;
    if (quiet < QUIET_MS || quiet > STALE_MS) continue;
    out.push({
      id: `session:${s.session_id}`,
      // It spoke again: that is the change, even if it has since gone quiet.
      mark: `session:${s.session_id}:${s.last_seen}`,
      tone: "plain",
      kind: "Stopped · wants direction",
      title: sessionTitle(s),
      sub: `${projectName(s)} · idle ${Math.round(quiet / 60_000)}m`,
      ts: s.last_seen, origin: { t: "session", session: s },
    });
  }

  for (const { root, repo, pr, scope } of prs) {
    const mine = scope === "mine" || pr.author === me;
    const red = pr.checksLoaded && pr.checks.failure > 0;
    const green = pr.checksLoaded && pr.checks.failure === 0 && pr.checks.pending === 0 && pr.checks.total > 0;
    const at = Date.parse(pr.updatedAt) || now;

    // Yours and broken: nobody else is going to fix it.
    if (mine && red) {
      out.push({
        id: `red:${repo}#${pr.number}`,
        // A push moves `updatedAt`; a re-run that fails somewhere else moves
        // the failing set. Either is worth surfacing again.
        mark: `red:${repo}#${pr.number}:${pr.updatedAt}:${pr.checks.failing.map((f) => f.name).sort().join(",")}`,
        tone: "bad",
        kind: "CI went red",
        title: `${pr.checks.failing[0]?.name ?? "A check"} is failing on #${pr.number}`,
        sub: `${pr.title} · ${repo}`,
        ts: at, origin: { t: "pr-red", pr, root },
      });
      continue;
    }
    // Yours, green and approved: it only needs a nod, and it is the one thing
    // here that finishes rather than starts work.
    if (mine && green && pr.reviewDecision === "APPROVED" && !pr.isDraft) {
      out.push({
        id: `ready:${repo}#${pr.number}`,
        mark: `ready:${repo}#${pr.number}:${pr.updatedAt}`,
        tone: "good",
        kind: "Ready to merge",
        title: `#${pr.number} ${pr.title}`,
        sub: `Approved · ${pr.checks.total} checks green · ${repo}`,
        ts: at, origin: { t: "pr-ready", pr, root },
      });
      continue;
    }
    // Somebody asked for your eyes.
    if (!mine && scope === "review") {
      out.push({
        id: `review:${repo}#${pr.number}`,
        mark: `review:${repo}#${pr.number}:${pr.updatedAt}`,
        tone: "plain",
        kind: "Review requested",
        title: `#${pr.number} ${pr.title}`,
        sub: `${pr.author} asked you · +${pr.additions} −${pr.deletions} across ${pr.changedFiles} files`,
        ts: at, origin: { t: "pr-review", pr, root },
      });
    }
  }

  for (const c of containers) {
    if (!containerIsWrong(c)) continue;
    const looping = c.state === "restarting";
    out.push({
      id: `ctr:${c.id}`,
      // Not the status line: docker rewrites that every minute ("Exited (1) 3
      // hours ago"), and a mark that ticks is a snooze that never holds.
      mark: `ctr:${c.id}:${c.state}:${exitCode(c) ?? "?"}`,
      tone: "bad",
      kind: "Container down",
      title: looping ? `${c.name} is restarting in a loop` : `${c.name} is ${c.state}`,
      // Docker's own status carries the age — "Exited (1) 3 hours ago" — and
      // it is already in the subtitle above. The header used to read "now" on
      // every one of them.
      sub: `${c.project ? c.project + " · " : ""}${c.status}`,
      origin: { t: "container", container: c },
    });
  }

  // Inside a band, newest first — and anything without a real moment after
  // everything that has one, rather than ahead of all of it.
  return out.sort((a, b) =>
    RANK[a.tone] - RANK[b.tone] || (b.ts ?? -Infinity) - (a.ts ?? -Infinity));
}

/**
 * Whether a container being not-running is a problem.
 *
 * Most of them are not. A migration or a seed job runs once and exits 0, and
 * that is it doing its job — nagging about it means the queue can never be
 * emptied, which is the one thing a queue has to be able to do. So: a
 * restart loop always, a non-zero exit always, and a clean exit never.
 * "created" has never run at all, which is not a thing that broke.
 */
export function containerIsWrong(c: DockerContainer): boolean {
  if (c.state === "running" || c.state === "created") return false;
  if (c.state === "restarting" || c.state === "dead") return true;
  const code = exitCode(c);
  return code == null ? true : code !== "0";
}

/** Docker writes the code into the status: "Exited (0) 3 hours ago". */
function exitCode(c: DockerContainer): string | null {
  return c.status.match(/\((\d+)\)/)?.[1] ?? null;
}

/** One rule for naming a project — see shared/projectKey.ts. This was the
 *  third copy of it on the phone, and the three did not agree on separators or
 *  on what to do when a path was empty. */
function projectName(s: SessionRollup): string {
  return s.project_path ? baseName(s.project_path) : (s.source_app || "unknown");
}
