/*
 * What the Overview of a pull request says first, decided apart from the screen.
 *
 * Two questions lead it: can this merge, and if not, why and whose move is it;
 * and who has said what about the code. The first is the merge verdict the
 * merge sheet already uses (`mergeVerdict`, `mergeObstacles`), so the sheet and
 * the overview cannot disagree about whether it is blocked; the second is the
 * desk's per-person roster (shared/reviewRoster.ts), plus one row for each
 * automation account that reviewed, because the desk leaves those out of the
 * count and the phone shows them with a BOT tag instead of hiding them.
 */
import type { PrDetail, PrReview } from "../../../shared/types.ts";
import { mergeVerdict } from "../../../shared/mergeReason.ts";
import { buildRoster, type ReviewerState } from "../../../shared/reviewRoster.ts";
import { mergeObstacles } from "./mergeObstacles.ts";
import type { Mark, Tone } from "./talk.ts";

export interface ReviewerRow {
  key: string;
  login: string;
  bot: boolean;
  team: boolean;
  word: string;
  tone: Tone;
  glyph: Mark;
}

const STATE: Record<ReviewerState, { word: string; tone: Tone; glyph: Mark }> = {
  approved: { word: "Approved", tone: "good", glyph: "ok_circle" },
  "approved-old": { word: "Approved earlier", tone: "good", glyph: "ok_circle" },
  "approved-void": { word: "Approval out of date", tone: "warn", glyph: "alert" },
  changes: { word: "Changes requested", tone: "bad", glyph: "x_circle" },
  "changes-again": { word: "Asked again", tone: "bad", glyph: "x_circle" },
  commented: { word: "Commented", tone: "neutral", glyph: "comment" },
  requested: { word: "Pending", tone: "neutral", glyph: "circle" },
  dismissed: { word: "Dismissed", tone: "neutral", glyph: "draft_circle" },
  team: { word: "Team pending", tone: "neutral", glyph: "people" },
};

const BOT_STATE: Partial<Record<PrReview["state"], { word: string; tone: Tone; glyph: Mark }>> = {
  APPROVED: STATE.approved,
  CHANGES_REQUESTED: STATE.changes,
  COMMENTED: STATE.commented,
};

type ReviewFacts = Pick<PrDetail, "reviews" | "reviewers" | "author" | "timeline" | "threads" | "reviewDecision"> & {
  headSha?: string; gate?: PrDetail["gate"];
};

/** Everybody the review is waiting on or has heard from, people first and in
 *  the desk's order, then automation. */
export function reviewerRows(d: ReviewFacts): ReviewerRow[] {
  /* When each person was last asked, from the timeline: the roster uses it to
     date a request. The same fold the desk's merge box does. */
  const askedAt: Record<string, string> = {};
  for (const e of d.timeline ?? []) {
    const k = (e.detail ?? "").toLowerCase();
    if (e.kind === "review-requested" && k && (!askedAt[k] || e.at > askedAt[k]!)) askedAt[k] = e.at;
  }
  const roster = buildRoster({
    reviews: d.reviews, reviewers: d.reviewers, author: d.author, headSha: d.headSha,
    reviewDecision: d.reviewDecision, gate: d.gate,
    threadAuthors: (d.threads ?? []).filter((t) => !t.isResolved).map((t) => t.comments[0]?.author ?? ""),
    askedAt,
  });
  const out: ReviewerRow[] = roster.entries.map((e) => ({
    key: e.login, login: e.login, bot: false, team: e.state === "team", ...STATE[e.state],
  }));

  const latest = new Map<string, PrReview>();
  for (const r of [...(d.reviews ?? [])].sort((a, b) => (a.submittedAt || "").localeCompare(b.submittedAt || ""))) {
    if (r.isBot && BOT_STATE[r.state]) latest.set(r.author.toLowerCase(), r);
  }
  for (const r of latest.values()) {
    out.push({ key: `bot-${r.author}`, login: r.author, bot: true, team: false, ...BOT_STATE[r.state]! });
  }
  return out;
}

export interface MergeBanner {
  tone: Tone;
  title: string;
  text: string;
  /** Whether the merge sheet has something to say: an open pull request. */
  open: boolean;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A sentence. The first word is capitalised only when it is one of ours: a
 *  login or a check's name is written as it is, and "bob asked for changes"
 *  must not become "Bob". */
const sentence = (s: string, ours: boolean): string => (s ? `${ours ? s[0]!.toUpperCase() + s.slice(1) : s}.` : "");

type BannerFacts = Pick<PrDetail, "state" | "isDraft" | "mergeState" | "checks" | "reviewDecision" | "baseRefName" | "author" | "humanReview" | "threads"> & {
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"; mergedBy?: string | null;
};

/**
 * The strip across the top of the Overview: is it blocked, why, and who moves.
 *
 * "Blocked" is GitHub's own answer (`mergeVerdict`), not a mood. A person's
 * request for changes on a pull request GitHub would still take is said as it
 * is — it will land over that review — rather than as a block it is not.
 */
export function mergeBanner(d: BannerFacts): MergeBanner {
  if (d.state === "MERGED") {
    return { tone: "neutral", title: "Merged", text: sentence(`Merged into ${d.baseRefName}${d.mergedBy ? ` by ${d.mergedBy}` : ""}`, true), open: false };
  }
  if (d.state !== "OPEN") return { tone: "neutral", title: "Closed", text: "It was closed without merging.", open: false };

  const human = d.humanReview && typeof d.humanReview === "object" && d.humanReview.kind ? d.humanReview : null;
  const blocking = human?.kind === "changes" && !human.cleared ? human.who : [];
  const open = (d.threads ?? []).filter((t) => !t.isResolved).length;
  const gate = mergeVerdict(d.mergeState, d.checks);
  const obstacles = mergeObstacles({
    mergeState: d.mergeState, checks: d.checks, reviewDecision: d.reviewDecision, isDraft: d.isDraft,
    baseRefName: d.baseRefName, mergeable: d.mergeable,
  });

  /* `ours` marks a clause in this file's own words, which starts a sentence
     with a capital; a person's or a check's name starts it as written. */
  const why: { text: string; ours: boolean }[] = [];
  const add = (text: string, ours = true): void => { why.push({ text, ours }); };
  if (d.isDraft) add("it is a draft");
  if (blocking.length) add(`${list(blocking)} asked for changes`, false);
  else if (d.reviewDecision === "CHANGES_REQUESTED") add("changes were requested");
  else if (d.reviewDecision === "REVIEW_REQUIRED") add("it needs an approval");
  if (open > 0) add(`${open} ${open === 1 ? "thread is" : "threads are"} open`);
  for (const o of obstacles) {
    if (o.title === "It is a draft" || o.title === "Changes were requested" || o.title === "Needs an approval") continue;
    const named = o.opens === "checks" && o.title.endsWith(" failed") && !/^\d+ more /.test(o.title);
    add(named ? o.title : o.title[0]!.toLowerCase() + o.title.slice(1), !named);
  }

  /* Whose move: the author fixes what is wrong with the branch, the reviewer
     answers what they asked. Said once, for the first thing that applies. */
  const branch = d.isDraft || obstacles.some((o) => o.opens === "checks" || /^(Conflicts|Behind)/.test(o.title));
  const who = branch ? { text: `${d.author || "the author"} has to fix it`, ours: !d.author }
    : blocking.length ? { text: `${list(blocking)} has to approve again`, ours: false }
    : human?.kind === "awaiting" && human.who.length ? { text: `Waiting on ${list(human.who)}`, ours: true }
    : null;

  const text = [
    sentence(list(why.map((w) => w.text)), why[0]?.ours ?? true),
    who ? sentence(who.text, who.ours) : "",
  ].filter(Boolean).join(" ");
  if (gate.blocked || d.isDraft) return { tone: "bad", title: "Merging is blocked", text: text || sentence(gate.line, false), open: true };
  if (why.length) return { tone: "warn", title: "GitHub will take it, with a catch", text, open: true };
  return { tone: "good", title: gate.line, text: "Nothing is standing in the way.", open: true };
}
