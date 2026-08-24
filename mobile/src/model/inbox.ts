/*
 * What is waiting on you, from the three places work arrives from.
 *
 * Pull requests, issues and cards. NOT agents — no held gate, no stopped
 * session, no plan meter. That is the whole rule of this screen and it is a
 * product decision rather than a technical one: what an agent is doing has one
 * home now, the terminal, and a landing screen that mixed "somebody asked for
 * your review" with "a session went quiet four minutes ago" was answering two
 * questions with one list.
 *
 * ── what it replaced, and why that had to go ──────────────────────────────
 * The old Home counted `waitingItems`, whose session rule is `quiet >= 4
 * minutes && quiet <= 12 hours`. On a real machine that made "4 things want
 * you" out of four sessions last touched 21 minutes, 6 hours, 10 hours and 10
 * hours ago — none of which wanted anything. It titled them with
 * `sessionTitle`, which falls back to `source_app:id.slice(0,8)` for
 * hook-only sessions, so the four rows read `orbit:3f9c1a04`.
 *
 * A number nobody believes is worse than no number, and this file exists to
 * make sure every row here is something a person can act on.
 *
 * ── three groups, and the order is the claim ──────────────────────────────
 *   needs  — somebody is blocked on you, or you are blocked on yourself.
 *   ready  — approved and green: the only group whose action is one tap.
 *   moved  — it changed since you last looked. News, not a job.
 *
 * `moved` is last on purpose. It is the only group built from a comparison
 * rather than from a state, so it is the only one that can be wrong about
 * whether you care — see `seenAt` below.
 */
import type { IssueRow, PrSummary } from "../../../shared/types.ts";
import type { ProviderTask } from "../../../shared/providers.ts";

export type InboxGroup = "needs" | "ready" | "moved";
/** Which of the three sources a row came from. Drawn as a mark on the row,
 *  because "#483" and "SHOP-2140" are not tellable apart at a glance and
 *  the mark is what makes a mixed list scannable. */
export type InboxSource = "pr" | "issue" | "card";

export interface InboxItem {
  /** Stable across loads, and the key `seen` is stored under. It has to
   *  survive a title change, so it is built from ids and never from text. */
  id: string;
  group: InboxGroup;
  source: InboxSource;
  title: string;
  sub: string;
  /** When it last moved, in epoch ms. Zero when the source does not say. */
  at: number;
  tone: "bad" | "warn" | "good" | "plain";
  /** Where tapping goes. `root` is the checkout a screen needs to ask about
   *  it; cards have none, because a board is not a checkout. */
  open: { screen: "pr" | "issue" | "card"; id: string; root?: string };
}

/** A pull request with the repository it came from and which server-side
 *  filter produced it — the store's own shape, so the Inbox and the queue read
 *  the same rows. `review` is GitHub's answer to "waiting on your review" and
 *  is never inferred here. */
export interface InboxPr { root: string; repo: string; pr: PrSummary; scope: "mine" | "review" }
/** An issue, with the checkout that can answer about it. */
export interface InboxIssue { root: string; issue: IssueRow }

export interface InboxInput {
  prs: InboxPr[];
  issues: InboxIssue[];
  cards: ProviderTask[];
  /** Epoch ms of when each id was last opened. Missing means never. */
  seen: Record<string, number>;
  now: number;
}

/** Epoch ms from whatever the source calls a timestamp. GitHub sends ISO
 *  strings, ClickUp sends numbers, and an unparseable one is zero rather than
 *  NaN — a NaN would sort to nowhere and compare false against everything. */
export function epoch(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}

/** Failing, in the one sense that is actionable: a check that has finished and
 *  did not pass. A run still going is not a failure yet, and `checksLoaded`
 *  false is "we have not asked", which must never read as green. */
function redChecks(pr: PrSummary): boolean {
  return pr.checksLoaded !== false && (pr.checks?.failure ?? 0) > 0;
}

function greenChecks(pr: PrSummary): boolean {
  const c = pr.checks;
  return pr.checksLoaded !== false && !!c && c.total > 0 && c.failure === 0 && c.pending === 0;
}

/**
 * The whole list, grouped and sorted.
 *
 * Deduplicated by id, because the store fetches `mine` and `review`
 * separately and one pull request can legitimately come back in both — you
 * asked yourself for a review, or you are a reviewer on your own team's
 * branch. Whichever group is more urgent wins; the row appears once.
 */
export function buildInbox(input: InboxInput): InboxItem[] {
  const { prs, issues, cards, seen, now } = input;
  const byId = new Map<string, InboxItem>();

  /** Keeps the more urgent of two rows for the same thing. `needs` outranks
   *  `ready` outranks `moved` — an approved pull request whose checks then went
   *  red is a job, not good news. */
  const rank: Record<InboxGroup, number> = { needs: 0, ready: 1, moved: 2 };
  const put = (item: InboxItem): void => {
    const had = byId.get(item.id);
    if (had && rank[had.group] <= rank[item.group]) return;
    byId.set(item.id, item);
  };

  // ── pull requests ───────────────────────────────────────────────────────
  for (const { root, repo, pr, scope } of prs) {
    const id = `pr:${repo}#${pr.number}`;
    const at = epoch(pr.updatedAt);
    const base = { id, source: "pr" as const, at, open: { screen: "pr" as const, id: String(pr.number), root } };

    // A draft is nobody's problem yet. It is not "review required" and it is
    // not ready — the same rule the list's own chip follows.
    if (pr.isDraft) {
      if (at > (seen[id] ?? 0)) {
        put({ ...base, group: "moved", tone: "plain", title: `#${pr.number} · draft moved`, sub: pr.title });
      }
      continue;
    }

    if (scope === "review") {
      put({
        ...base, group: "needs", tone: "bad",
        title: `#${pr.number} wants your review`,
        sub: `${pr.author} · ${pr.title}`,
      });
      continue;
    }

    // From here it is one of yours.
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      put({
        ...base, group: "needs", tone: "bad",
        title: `#${pr.number} · changes asked${redChecks(pr) ? `, ${pr.checks.failure} failed` : ""}`,
        sub: pr.title,
      });
      continue;
    }
    if (redChecks(pr)) {
      put({
        ...base, group: "needs", tone: "warn",
        title: `#${pr.number} · ${pr.checks.failure} ${pr.checks.failure === 1 ? "check" : "checks"} failed`,
        sub: pr.title,
      });
      continue;
    }
    if (pr.reviewDecision === "APPROVED" && greenChecks(pr) && pr.mergeable !== "CONFLICTING") {
      put({
        ...base, group: "ready", tone: "good",
        title: `#${pr.number} · approved, ${pr.checks.total} green`,
        sub: pr.title,
      });
      continue;
    }
    if (at > (seen[id] ?? 0)) {
      put({ ...base, group: "moved", tone: "plain", title: `#${pr.number} moved`, sub: pr.title });
    }
  }

  // ── issues ──────────────────────────────────────────────────────────────
  for (const { root, issue } of issues) {
    if (issue.state.toLowerCase() === "closed") continue;
    const id = `issue:${root}#${issue.number}`;
    const at = epoch(issue.updatedAt);
    const base = {
      id, source: "issue" as const, at,
      open: { screen: "issue" as const, id: String(issue.number), root },
    };
    // Only the ones on you. An open issue nobody assigned is the backlog, and
    // a backlog in an inbox is how an inbox stops being read.
    if (issue.assignees.length === 0) continue;
    put({
      ...base, group: "needs", tone: "warn",
      title: `Issue #${issue.number} is yours`,
      sub: issue.title,
    });
  }

  // ── cards ───────────────────────────────────────────────────────────────
  for (const card of cards) {
    if (card.statusKind === "done") continue;
    const id = `card:${card.id}`;
    const at = epoch(card.updated);
    const label = card.customId || card.id;
    const base = { id, source: "card" as const, at, open: { screen: "card" as const, id: card.id } };
    if (at > (seen[id] ?? 0)) {
      put({
        ...base, group: "moved", tone: "plain",
        // The workspace's own word for the status, verbatim — renaming
        // somebody's workflow is not ours to do, and the board's people read
        // it at a glance.
        title: `${label} · ${card.status}`,
        sub: card.title,
      });
    }
  }

  /*
   * Sorted inside each group by how long it has been sitting, oldest first.
   *
   * Deliberately not newest-first. Every other list in this app is a feed and
   * shows the latest thing; this one is a queue, and the row that has been
   * waiting longest is the one most likely to be somebody else's afternoon.
   * A row with no timestamp sorts last rather than first — zero is "the source
   * did not say", not "1970".
   */
  const order: InboxGroup[] = ["needs", "ready", "moved"];
  return [...byId.values()].sort((a, b) => {
    if (a.group !== b.group) return order.indexOf(a.group) - order.indexOf(b.group);
    if (!a.at || !b.at) return (b.at ? 1 : 0) - (a.at ? 1 : 0);
    return a.at - b.at;
  });
}

/** The three numbers over the list. Counted from the built rows rather than
 *  from the inputs, so a tile can never disagree with what is under it. */
export function inboxCounts(items: InboxItem[]): { needs: number; failing: number; ready: number } {
  return {
    needs: items.filter((i) => i.group === "needs").length,
    // Named for what it is: rows whose reason is a red check. It is a subset of
    // `needs`, and the tile says "CI failing" rather than implying a fourth group.
    failing: items.filter((i) => i.group === "needs" && i.tone === "warn" && i.source === "pr").length,
    ready: items.filter((i) => i.group === "ready").length,
  };
}

/** What to mark as seen when a row is opened. Its own function so the screen
 *  and its test agree on the shape, and so the cap lives in one place. */
export const SEEN_CAP = 300;

/**
 * Remember that this was looked at, dropping the oldest when it gets long.
 *
 * A cap because this is written to a keystore, which is not a database: a map
 * that grows once per pull request you ever open would eventually be a slow
 * read on every cold start. 300 is several months of a busy repository and
 * nothing that falls out of it can do worse than put one row back in `moved`.
 */
export function remember(seen: Record<string, number>, id: string, at: number): Record<string, number> {
  const next = { ...seen, [id]: at };
  const keys = Object.keys(next);
  if (keys.length <= SEEN_CAP) return next;
  const oldest = keys.sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0)).slice(0, keys.length - SEEN_CAP);
  for (const key of oldest) delete next[key];
  return next;
}
