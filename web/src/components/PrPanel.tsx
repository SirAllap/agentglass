// Pull requests, so a review does not mean opening a browser.
//
// What shapes this panel, all of it learned from real pull requests rather than
// guessed:
//
// 1. The conversation is mostly machines. On a live review, four issue comments
//    were all from CI and one coverage table alone was 46,551 characters, while
//    the single human review that blocked the merge sat last. So it reads in
//    three lanes — humans, line threads, automation — and the machine lane
//    collapses to its digest.
//
// 2. A body is markdown, and prose set to the full width of a 2000px window is
//    unreadable however correct the formatting. Everything written by a person
//    renders through `Md`, which holds a reading measure and centres it.
//
// 3. Diffs are not re-implemented. `SplitDiff`/`UnifiedDiff` from ChangesModal
//    are the app's diff viewer, keybindings and all; a pull request is
//    translated into the `FileChange` they already speak.
//
// 4. Nothing waits on the network. `gh` costs a second or more per call and the
//    server has one thread; every read is a cached answer with its age shown.
import { createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { handoffTo } from "../lib/handoffTo.ts";
import { requestTermIssue } from "../lib/termIssue.ts";
import { diffSplit, diffWrap, diffNoWhitespace, setDiffNoWhitespace } from "../lib/diffPrefs.ts";
import { Portal } from "./Portal.tsx";
import { subscribePrJump, prJump, clearPrJump } from "../lib/prJump.ts";
import { findMention, selectorFor } from "../lib/prMention.ts";
import { fileSection } from "../lib/patchLines.ts";
import { groupPatch } from "../lib/changeGroups.ts";
import { flashElement } from "../lib/flash.ts";
import { shaFromHref } from "../lib/commitLink.ts";
import { viewHeaderClass, viewHeaderStyle } from "./workspace/ViewHeader.tsx";
import { ScopeChip } from "./workspace/Chrome.tsx";
import type {
  PrSummary, PrDetail, PrRepoId, PrThread, PrComment, PrReview, PrReviewer, PrCheck, GitRepoRef, FileChange,
  PrReaction, PrAuthorAssociation, PrEvent, PrCommit, PrFile, PrCheckJob, PrLocalHead,
  ReviewRecipe, ReviewRecipeGroup, ReviewRecipeContext,
} from "../../../shared/types.ts";
import { api, type BranchSpend, type RepoSpend } from "../lib/api.ts";
import {
  allowedMethods, pickMergeMethod, MERGE_LABEL, MERGE_OPTION, type MergeMethod,
} from "../../../shared/mergeMethod.ts";
import { updateBranchMove } from "../lib/updateBranch.ts";
import { depSpec } from "../../../shared/deps.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { useMergeDialog } from "./MergeDialog.tsx";
import { mergeCardRef, mergeNote, statusColor } from "../lib/cardMove.ts";
import { cardPlan, cardPlanNote } from "../lib/cardPlan.ts";
import { cardOf, askingCard, onCard, forgetCard } from "../lib/prCardStore.ts";
import { PeoplePick } from "./PeoplePick.tsx";
import { SCROLLBAR_CSS, LINEBTN_CSS, CODE_FONT_STYLE, UnifiedDiff, SplitDiff, LineMenuCtx, type LinePick, type LineSel } from "./diff/DiffLines.tsx";
import { Toggle } from "./diff/DiffControls.tsx";
import { HiliteCtx, useDiffHighlight } from "../lib/diffHighlight.ts";
import { Select } from "./Select.tsx";
import { parseBody, parseUnifiedDiff, newLineNumbers, diffKind, parseShieldBadge, toggleChecklistItem, type MdBlock, type MdListItem, type ParsedFile } from "../lib/prBody.ts";
import { afterViewed, stepFileIndex, verticalScrollerOf } from "../lib/prNav.ts";
import { buildFileTree, treeOrder, type TreeNode } from "../lib/prFileTree.ts";
import { POLL_MS, SETTLE_MS, settleAfter } from "../lib/prSettle.ts";
import { keepLoadedChecks } from "../lib/prMerge.ts";
import { askingBehind, behindAnswer, forgetBehind, forgetOneBehind, onBehind, refreshBehind } from "../lib/prBehindStore.ts";
import { forgetRollups } from "../lib/prRollupStore.ts";
import {
  anchorId, bootstrapSince, clearSeen, foldedIdx, newKeys, newSince, onSeenChange, readSeen, reviewSpeaks,
  threadLastAt, threadMovedOn, writeSeen, type NewAtom,
} from "../lib/prNew.ts";
import { unreadOf, type Unread } from "../lib/prUnread.ts";
import { quoteReply } from "../lib/prQuote.ts";
import { sinceRange, sinceTitle } from "../lib/prSinceReview.ts";
import { withoutWhitespace } from "../lib/diffNoWhitespace.ts";
import { loginOf, ownersOf } from "../lib/codeowners.ts";
import { UnreadBadge } from "./UnreadBadge.tsx";
import { excerpt, findInDiffs, groupByFile, type Match } from "../lib/diffFind.ts";
import { PrFilterBar } from "./PrFilterBar.tsx";
import { Avatar } from "./Avatar.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { PeekFile, type Peek } from "./PeekFile.tsx";
import { MERGE_WHY, mergeBlockedWhy, checksLine, checksStanding, standingLine, checksShort, mergeVerdict } from "../../../shared/mergeReason.ts";
import { parseQuery, applyFilters, peopleMatched, buildFacets, activeCount, type RepoFacets } from "../lib/prFilter.ts";
import { CodeBlock as MdCodeBlock } from "../lib/mdCode.tsx";
import { externalUrl, openExternal } from "../lib/externalUrl.ts";
import { cardRef, chipAction } from "../lib/cardRef.ts";
import { reviewerRoster, blockingReviewers, reviewVerdict, verdictLine, type ReviewerRow, type ReviewerState } from "../lib/prReviewers.ts";
import { expandRecipe } from "../../../shared/recipeText.ts";
import { suggestRecipeId } from "../../../shared/reviewSuggest.ts";
import { openSettings } from "../lib/openSettings.ts";
import { requestWorktreeJump } from "../lib/worktreeJump.ts";
import { wtCell, wtCellTitle, folderOf } from "../lib/prWorktreeCell.ts";
import { conflictBriefing, CONFLICT_ASK } from "../lib/conflictBrief.ts";
import { openCard } from "../lib/openCard.ts";
import { openIssue } from "../lib/openIssue.ts";
import { useClickupSetup } from "../lib/clickupSetup.ts";
import type { ListStatus as CuStatus, ListMember as CuMember, ProviderTask } from "../../../shared/providers.ts";
import { CloseButton } from "./CloseButton.tsx";
import { ICON } from "../lib/iconSize.ts";
import { CardChip } from "../lib/priority.tsx";
import { ColumnsIcon, InboxIcon, QuoteIcon } from "./settingsNavIcons.tsx";
import { pins, isPinned, togglePin, subscribePins, type Pin } from "../lib/prPins.ts";
import { TriageBoard } from "./TriageBoard.tsx";
import { Inbox } from "./prs/Inbox.tsx";
import { FileRail } from "./FileRail.tsx";

/**
 * The second half of a merge, named once.
 *
 * A merge from the detail view is two writes to two systems: GitHub, then the
 * card's status in ClickUp. The button says which one it is on, and the string
 * is a constant because the tooltip has to recognise it — comparing against a
 * literal typed twice is how the reassuring sentence ("the merge still stands")
 * silently stops appearing after a copy edit.
 */
const MOVING_CARD = "Moving the card…";

type Filter = "mine" | "review" | "all";
type Tab = "overview" | "conversation" | "commits" | "files" | "checks" | "review";
// The open/closed axis, orthogonal to the scope views. "closed" holds merged +
// closed, exactly like GitHub's own Closed tab; "all" is everything.
type StateSel = "open" | "closed" | "all";
const STATES: { id: StateSel; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

/**
 * Saved views: a scope and a query, together, under one name.
 *
 * The three scopes are what the server can fetch; the interesting questions
 * ("what of mine is red", "what of mine could land right now") are a scope plus
 * a filter, and asking them used to mean picking a tab and then building the
 * query by hand every time. A view is only ever shorthand — it writes the same
 * query string the facets write, so the chips below still show what is on and
 * still take it off again.
 */
const VIEWS: { id: string; label: string; scope: Filter; query: string; tint?: string; hint: string }[] = [
  { id: "review", label: "Needs my review", scope: "review", query: "", tint: "var(--warning)", hint: "Somebody asked you to look" },
  { id: "mine", label: "Mine", scope: "mine", query: "", tint: "var(--primary)", hint: "Pull requests you opened" },
  { id: "failing", label: "Failing", scope: "all", query: "checks:red", tint: "var(--error)", hint: "Open here with a red check" },
  { id: "ready", label: "Ready", scope: "all", query: "review:approved checks:green", tint: "var(--success)", hint: "Approved and green — these can land" },
  { id: "all", label: "All", scope: "all", query: "", hint: "Every open pull request" },
];

/*
 * The last thing each pull request said, kept for the session.
 *
 * Module-level rather than state: it has to outlive the component, and nothing
 * renders from it directly — it is consulted once, when a pull request is
 * opened, to decide between showing something and showing nothing.
 *
 * Bounded, and not out of politeness: a PrDetail carries every comment, review
 * thread and commit on a pull request, so a day of reading a busy repository is
 * real memory. Oldest out first, which on this access pattern is the one you
 * are least likely to open again.
 */
const DETAIL_CACHE = new Map<string, PrDetail>();
const DETAIL_CACHE_MAX = 40;
/** A line comment sitting in YOUR unsubmitted review on GitHub. Not a thread —
 *  it has no id to reply to and no state to resolve — and not one of our own
 *  drafts either, which live only in this browser until they are sent. */
type PendingLine = { path: string; line: number | null; startLine?: number | null; body: string; url?: string };

const detailKey = (root: string, n: number) => `${root}#${n}`;
const heldDetail = (root: string, n: number): PrDetail | null => DETAIL_CACHE.get(detailKey(root, n)) ?? null;
function rememberDetail(root: string, n: number, d: PrDetail): void {
  const k = detailKey(root, n);
  DETAIL_CACHE.delete(k);           // re-insert, so it counts as the newest
  DETAIL_CACHE.set(k, d);
  while (DETAIL_CACHE.size > DETAIL_CACHE_MAX) DETAIL_CACHE.delete(DETAIL_CACHE.keys().next().value!);
}

const SEEN_KEY = "agentglass.pr.seen";

/** Which voices the conversation is showing. `new` is not a voice — it is
 *  "only what arrived since I last looked", which cuts across all of them and
 *  is the one filter that answers "where is the reply I came back for". */
type ConvWho = "all" | "human" | "bot" | "new";
const DRAFT_KEY = "agentglass.pr.drafts";
/** The unsent review itself — the verdict you picked and the note you typed,
 *  which used to live only in the Review tab's own state. Switching to Files to
 *  check one more thing threw both away, and there is no worse moment to lose a
 *  paragraph than after you have decided what it says. GitHub keeps it; so do
 *  we, per pull request, until it is sent. */
const REVIEW_KEY = "agentglass.pr.review";
/** How this repository merges, per repository, because that is what the
 *  decision belongs to: a project has a convention, a branch does not. It lived
 *  in the merge button's own state before, so it went back to squash every time
 *  the Overview tab was unmounted — which the Files tab does. */
const METHOD_KEY = "agentglass.pr.method";

/** A review written but not yet submitted. */
export interface ReviewDraft {
  verb: "comment" | "approve" | "request_changes";
  body: string;
}

/** Half-written comments, keyed by where they are being written. Neither queued
 *  nor sent — just typed, and until now thrown away by anything that closed the
 *  box: switching to Checks to see why it is red, and coming back to an empty
 *  composer, is the most expensive way this panel could waste a paragraph. */
const COMPOSE_KEY = "agentglass.pr.compose";
const readStash = (k: string): string => { try { return (JSON.parse(localStorage.getItem(COMPOSE_KEY) || "{}") as Record<string, string>)[k] ?? ""; } catch { return ""; } };
const writeStash = (k: string, v: string) => {
  try {
    const all = JSON.parse(localStorage.getItem(COMPOSE_KEY) || "{}") as Record<string, string>;
    // Deleted first either way, so a key that is being typed into moves to the
    // end of the object and the order below stays "least recently touched".
    delete all[k];
    if (v.trim()) all[k] = v;
    // Nothing ever deletes the stash for a pull request that got merged with a
    // half-written note still in it, so bound it: keys keep insertion order, so
    // the ones that fall off are the ones nobody has touched in longest.
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - 80))) delete all[old];
    localStorage.setItem(COMPOSE_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
};

/** A line comment written but not yet sent — GitHub's "pending review". */
export interface DraftComment {
  path: string;
  /** The last line of the comment — GitHub's `line`. */
  line: number;
  /** The first, when the comment covers a range. Absent for a single line. */
  startLine?: number;
  /** Which side of the diff: RIGHT is the new file, LEFT the old. */
  side?: "LEFT" | "RIGHT";
  body: string;
}

const loadMap = <T,>(k: string): Record<string, T> => {
  try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; }
};
const saveMap = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

function ago(iso: string): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Whether a base branch is the repository's trunk.
 *
 * By name, because the list does not carry the repository's default branch and
 * asking GitHub for it per row would be a request behind a label. The names are
 * a convention rather than a fact, so being wrong is possible — and it is wrong
 * in the safe direction: an unusual trunk gets tinted as if it were a stack,
 * which draws the eye to something real, while a stack can never be quietly
 * shown as the trunk.
 */
const TRUNKS = new Set(["main", "master", "trunk", "develop", "development"]);
const isTrunk = (base: string): boolean => TRUNKS.has(base.toLowerCase());

const stateTint = (p: PrSummary): string => {
  if (p.checks.pending > 0) return "var(--warning)";
  if (p.checks.verdict === "red") return "var(--error)";
  if (p.checks.verdict === "green") return "var(--success)";
  return "var(--text3)";
};

function Dot({ tint, title }: { tint: string; title?: string }) {
  return <span title={title} className="inline-block shrink-0 rounded-full" style={{ width: 6, height: 6, background: tint }} />;
}

function Chip({ text, tint, title }: { text: string; tint: string; title?: string }) {
  return (
    <span title={title} className="shrink-0 text-[10px] px-1.5 py-px rounded-full uppercase tracking-wide"
      style={{ color: tint, background: `color-mix(in srgb, ${tint} 10%, transparent)` }}>{text}</span>
  );
}

/**
 * ClickUp's mark, near enough to be read at eleven pixels.
 *
 * Two stacked chevrons rather than a traced logo: the real one is a filled
 * arrow over a curve, which at this size is a smudge, and every other glyph in
 * this app is a stroke on `currentColor`. What has to survive the shrinking is
 * "the thing that points up" — that is what people recognise it by — so that is
 * what is drawn.
 */

/**
 * The card this pull request came from.
 *
 * ClickUp shows the pull requests a card produced; this is the way back, and it
 * is the walk everybody does by hand — read the id off the branch, switch to
 * the board, paste it in. One press instead.
 *
 * It is shown only when it would WORK, which is three different answers — and
 * which of them applies is `chipAction`'s to decide, not this component's:
 *
 *   the body has a ClickUp address   always — nothing else writes that host
 *   an id in the branch, ClickUp here   yes, if the prefix is this workspace's
 *   an id in the branch, no ClickUp     nothing, rather than a mark for a
 *                                       tracker this machine has never heard of
 *
 * With no ClickUp to land in but an address to hand, it opens ClickUp itself
 * instead of a Tasks view that would only ask you to connect one.
 */
/**
 * The card, as a pill. ONE of these, drawn in two places.
 *
 * The masthead had it and the sidebar had a purple word — the same link, the same
 * destination, two different things to look at. Reported that way: "the go-to-card
 * button has to be exactly the same as the one at the top, with the icon and all".
 * So the pill is a component and both callers render it; a second spelling cannot
 * drift back in.
 */
/* The chip lives in lib/priority.tsx now: the board, this masthead and the
   sidebar were drawing three different things for one card — a logo, a flag,
   and a bare label. One component, one place to change it. */
function CardPill({ label, onClick, title, external, className, priority, status }: {
  label: string;
  onClick: () => void;
  title: string;
  /** Leaving the app — the arrow every chip in here uses for that promise. */
  external?: boolean;
  className?: string;
  priority?: ProviderTask["priority"];
  status?: string;
}) {
  return (
    <span className={`align-middle inline-flex items-center gap-1 ${className ?? ""}`}>
      <CardChip id={label} priority={priority ?? null} status={status} title={title} onOpen={onClick} />
      {external && <span aria-hidden style={{ fontSize: 10, opacity: 0.7, color: "var(--primary)" }}>↗</span>}
    </span>
  );
}

function PrCardChip({ pr, card }: {
  pr: { headRefName?: string; title?: string; body?: string };
  /** The card itself when the saved boards already hold it — for the flag's
   *  colour and the status beside the id. Absent is "we have not seen it". */
  card?: PrSummary["card"];
}) {
  const setup = useClickupSetup();
  const ref = useMemo(() => cardRef(pr), [pr.headRefName, pr.title, pr.body]);
  const go = chipAction(ref, setup);
  if (!ref || !go) return null;

  const inApp = go.in === "tasks";
  return (
    <CardPill
      className="mr-1.5"
      label={ref.label}
      priority={card?.priority ?? null}
      status={card?.status}
      external={!inApp}
      onClick={() => { if (go.in === "tasks") openCard(ref.query, ref.label); else openExternal(go.url); }}
      title={inApp
        ? `Open ${ref.label} in Tasks — the ClickUp card this pull request came from`
        : `Open ${ref.label} in ClickUp`} />
  );
}

/* `humanReview`, not `reviewDecision` — the fourth surface with the same bug.
   GitHub counts the auto-review bot, so this chip called a pull request
   approved that no person had read. See `humanReview` on PrSummary. */
/**
 * The Overview's verdict band, from the SAME field the board's card uses.
 *
 * The two disagreed on one screen — the card said "Waiting on bjorn",
 * this box said "Reviewed, no verdict by the author" — because they asked
 * different questions of different data. `humanReview` is the answer: computed
 * on the server, where the author's login and the outstanding requests are both
 * known, neither of which the browser's roster can see.
 *
 * The roster stays as the fallback for a detail fetched before the field
 * existed, so an old cached pull request still says something rather than
 * nothing.
 */
function p2Verdict(hv: PrSummary["humanReview"], rows: ReviewerRow[]): {
  tint: string; glyph: string; head: string; who?: string; note?: string; url?: string;
} | null {
  const named = (list: string[]) =>
    list.slice(0, 2).join(" and ") + (list.length > 2 ? ` +${list.length - 2}` : "");

  const v = hv && typeof hv === "object" && hv.kind
    ? hv
    : (() => {
      const r = reviewVerdict(rows);
      return r.kind === "none" ? null : { kind: r.kind, who: r.who, mine: false } as NonNullable<PrSummary["humanReview"]>;
    })();
  if (!v) return null;
  const who = named(Array.isArray(v.who) ? v.who : []);

  if (v.kind === "approved") {
    if (v.stale) {
      return { tint: "var(--warning)", glyph: "↻", url: v.url,
        head: v.mine ? "You approved, but it has moved since" : "Approved, but it has moved since",
        who: v.mine ? undefined : who,
        note: "Commits landed after that review — it does not cover what is here now." };
    }
    return { tint: "var(--success)", glyph: "✓", url: v.url,
      head: v.mine ? "You approved" : "Approved", who: v.mine ? undefined : who,
      note: "Whatever is listed below, the review is done" };
  }
  if (v.kind === "changes") {
    /* A band, not a line among the obstacles. It is the same kind of fact as an
       approval — a person decided — and it was drawn as neither. */
    return { tint: "var(--error)", glyph: "✕", url: v.url,
      head: v.mine ? "You asked for changes" : "Changes requested",
      who: v.mine ? undefined : who,
      /*
       * The review still blocks the merge, exactly as GitHub shows it — a
       * re-request does not withdraw it. What was missing is the OTHER half
       * of GitHub's page: the small ↻ that says a follow-up round has
       * already been asked for, so the reader is not left thinking their
       * threads are still the ones to answer when they already answered
       * them and asked again.
       */
      note: v.askedAgain
        ? (v.mine ? "You were asked to look again." : "Applied, and asked to look again — their move now.")
        : "Their threads are the ones to answer." };
  }
  if (v.kind === "awaiting") {
    return { tint: "var(--warning)", glyph: "◯",
      head: v.mine ? "Waiting on you" : "Waiting on review", who: v.mine ? undefined : who,
      note: "Asked for, and not answered yet." };
  }
  return { tint: "var(--text3)", glyph: "💬", url: v.url,
    head: "Reviewed, no verdict", who,
    note: "Somebody wrote, without approving or asking for changes." };
}

function ReviewChip({ v }: { v: PrSummary["humanReview"] }) {
  if (!v) return null;
  /* Capitalised, like GitHub's own — "approved" all lower case beside
     "APPROVED" on the same screen was the inconsistency reported. */
  if (v.kind === "approved") {
    return v.stale
      ? <Chip text="Approved · moved" tint="var(--warning)" />
      : <Chip text="Approved" tint="var(--success)" />;
  }
  if (v.kind === "changes") {
    return v.askedAgain
      ? <Chip text="Changes requested · asked again" tint="var(--error)" />
      : <Chip text="Changes requested" tint="var(--error)" />;
  }
  if (v.kind === "awaiting") return <Chip text="Awaiting review" tint="var(--warning)" />;
  return <Chip text="Commented" tint="var(--text3)" />;
}

function Bar({ parts }: { parts: { pct: number; tint: string }[] }) {
  return (
    <div className="flex-1 h-1.5 rounded-full overflow-hidden flex min-w-[60px]"
      style={{ background: "color-mix(in srgb, var(--border) 35%, transparent)" }}>
      {parts.map((p, i) => <div key={i} style={{ width: `${p.pct}%`, background: p.tint }} />)}
    </div>
  );
}


function Btn({ children, onClick, disabled, danger, primary, ok, warn, title, small, pending }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean;
  danger?: boolean; primary?: boolean; ok?: boolean; warn?: boolean; title?: string; small?: boolean;
  /**
   * This button's own request is in flight.
   *
   * Every action in this panel is a round trip through `gh`, which is a second
   * or two on a good day, and the only feedback was the button going grey — the
   * same grey it wears when it is disabled for a reason that has nothing to do
   * with you. Reported as the worst thing about the app: "we have to give
   * feedback on async requests, ALWAYS".
   *
   * The spinner goes IN the button, before the label, and the label stays: a
   * control that swaps its words for "Working…" moves everything beside it, and
   * you can no longer tell which of three buttons you pressed.
   */
  pending?: boolean;
}) {
  // `warn` is the amber "this mutates the branch" accent, matching the Source
  // Control bar's sync/behind colour (--warning). Used for update-branch, which
  // merges the base into this branch — a consequential action that should not
  // read the same as its plain neighbours.
  const edge = danger ? "var(--error)" : ok ? "var(--success)" : warn ? "var(--warning)" : primary ? "var(--primary)" : "var(--border)";
  return (
    <button onClick={onClick} disabled={disabled || pending} title={pending ? "Working…" : title}
      aria-busy={pending || undefined}
      /*
       * `leading-none`, and it is not a nicety.
       *
       * Buttons with identical classes came out different heights, and the
       * cause is the LABEL: `↗` and `⋯` are not in the UI font, so they arrive
       * from a fallback whose line box is taller, and the button grows to hold
       * it. Measured side by side at the same font-size and padding: 17px for a
       * plain-text label against 21px for one carrying an arrow — a row of
       * three controls at two heights, with nothing in the CSS to explain it.
       *
       * Pinning the line height makes the box the padding's business rather
       * than the glyph's. Same measurement after: 16, 16, 16.
       */
      /*
       * A FIXED height, and the contents centred in it.
       *
       * Two attempts at making these agree failed because both tried to make
       * the box come out the same by accident: same classes, then same line
       * height. It kept not working, because the height was still a function of
       * the label — `↗` and `⋯` are not in the UI font and arrive from a
       * fallback with its own metrics, and a fallback can differ per machine,
       * per theme font setting, per glyph.
       *
       * So the height stops being derived at all. `inline-flex` + `items-center`
       * + an explicit height means a row of these is the same row whatever is
       * written on them, and the padding only decides the width.
       */
      className={`agx-btn rounded inline-flex items-center justify-center whitespace-nowrap leading-none disabled:opacity-40 ${small ? "text-[10px] px-2 h-[24px]" : "text-[10.5px] px-2.5 h-[28px]"}`}
      style={{
        // A plain button's label was --text2, a tier meant for labels beside
        // things — so "Comment" sat at the contrast of a caption next to the
        // button it competes with. It is a control: it reads at full strength,
        // and the border is what says it is the quieter of the two.
        color: primary ? "var(--bg)" : danger ? "var(--error)" : ok ? "var(--success)" : warn ? "var(--warning)" : "var(--text)",
        background: primary ? "var(--primary)" : warn ? "color-mix(in srgb, var(--warning) 16%, transparent)"
          // A quiet button still needs an edge you can find. Transparent on a
          // panel, with a border mixed at half strength, was a label with a
          // suggestion of a box — on the neutral themes, where --border is
          // close to the surface it sits on, it vanished entirely.
          : "color-mix(in srgb, var(--border) 30%, transparent)",
        border: `1px solid color-mix(in srgb, ${edge} ${primary ? 100 : warn ? 55 : 85}%, transparent)`,
        cursor: disabled ? "not-allowed" : "pointer",
        // The filled one carries the weight. On a neutral theme --primary is a
        // grey, so fill alone does not separate the two — the label has to say
        // which is which as well.
        fontWeight: primary ? 600 : warn ? 500 : 500,
      }}>
      {pending && (
        <span className="agx-spin mr-1.5 shrink-0" aria-hidden
          style={{ width: 9, height: 9, borderWidth: 1.5,
            borderColor: primary ? "color-mix(in srgb, var(--bg) 55%, transparent)" : "currentColor",
            borderTopColor: "transparent" }} />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

/**
 * The typography for rendered markdown.
 *
 * A stylesheet rather than inline styles because these rules are about
 * descendants — a heading inside a comment, a cell inside a table — which
 * inline styles cannot reach. `.agx-md` scopes every one of them.
 */
export const MD_CSS = `
/* Feedback, so a press is legible before the work behind it finishes.
   :active answers within one frame; :focus-visible keeps the keyboard
   visible; [data-busy] dims the label and blocks a second press without
   resizing the button, so the row does not jump under the cursor. */
.agx-btn{transition:background .13s,border-color .13s,color .13s,transform .07s}
.agx-btn:active:not(:disabled){transform:translateY(1px) scale(.99)}
.agx-btn:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.agx-btn[data-busy]{pointer-events:none;opacity:.6}
/* A body fills the box it was given. There used to be a 78ch measure here,
   borrowed from prose typography, and it was the wrong rule twice over: this
   panel renders in a monospace face, so ch is a fixed pixel wall (measured at
   584px) rather than a measure that breathes, and it left a third of a card
   empty beside text that stopped in mid-air. GitHub caps nothing here either,
   so the same pull request read narrower in the app than on the page it came
   from. Reading comfort on a wide display is what the panel width is for. */
/* One timeline, one rail. The node says what kind of thing happened; the
   rail says they happened in an order. */
.agx-tl{position:relative;padding-left:26px}
.agx-tl::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;border-radius:2px;background:color-mix(in srgb,var(--border) 42%,transparent)}
.agx-ev{position:relative;margin-bottom:10px}
.agx-ev:last-child{margin-bottom:0}
.agx-node{position:absolute;left:-26px;top:6px;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:9px;background:var(--bg);border:2px solid color-mix(in srgb,var(--text) 24%,transparent)}
/* A small event — opened, force-pushed, review requested. It sits on the same
   rail as the comments but weighs a fraction of one, because it is context
   rather than something anybody said. */
.agx-tiny{position:relative;display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--text3);padding:3px 0;margin-bottom:10px}
.agx-tiny .agx-node{top:1px;width:18px;height:18px;left:-26px}
.agx-tiny b{color:var(--text2);font-weight:500}
/* menus — .agx-menu itself now lives in index.css: it was defined HERE, in a
   <style> this component injects, so a menu in any other panel had no
   background until somebody had opened a pull request. See index.css. */
.agx-mi:hover{background:color-mix(in srgb,var(--primary) 12%,transparent);color:var(--text)}
.agx-mi:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}
/* the "＋" that adds a reviewer or a label, inline with the values it extends */
.agx-inline-add{font-size:10px;padding:1px 6px;border-radius:5px;color:var(--text3);border:1px solid color-mix(in srgb,var(--text) 24%,transparent);transition:color .13s,border-color .13s,background .13s}
.agx-inline-add:hover:not(:disabled){color:var(--primary);border-color:var(--primary);background:color-mix(in srgb,var(--primary) 10%,transparent)}
.agx-inline-add:disabled{opacity:.4;cursor:not-allowed}
/* the viewed switch on a file header — a checkbox does not read as a state you
   are keeping, and "viewed" is state you keep across a whole review */
.agx-sw{position:relative;width:24px;height:14px;border-radius:8px;flex:none;background:color-mix(in srgb,var(--border) 50%,transparent);transition:background .17s}
.agx-sw::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--text3);transition:transform .17s,background .17s}
.agx-sw[data-on="1"]{background:color-mix(in srgb,var(--success) 55%,transparent)}
.agx-sw[data-on="1"]::after{transform:translateX(10px);background:var(--success)}
.agx-hl pre{margin:0;padding:10px 12px;border-radius:8px;overflow-x:auto;background:color-mix(in srgb,var(--bg2) 55%,var(--bg)) !important;border:1px solid color-mix(in srgb,var(--border2) 60%,transparent)}
.agx-hl code{font-size:11.5px;line-height:1.65}
.agx-md .agx-hl{margin:0 0 .85em}
/* The body reads in the theme's brightest text, not a step below it. A pull
   request description is the longest thing anybody reads in this app, and it
   was set in --text2 — a grey chosen for labels, against a dark panel. The
   dimmer tiers still exist and still recede; they are for eyebrows, timestamps
   and hints, which is what "secondary" was supposed to mean. */
.agx-md{margin:0;line-height:1.7;font-size:12.5px;color:var(--text)}
.agx-md>*:first-child{margin-top:0}
.agx-md>*:last-child{margin-bottom:0}
.agx-md p{margin:0 0 .85em}
.agx-md h1,.agx-md h2,.agx-md h3,.agx-md h4,.agx-md h5,.agx-md h6{color:var(--text);font-weight:600;line-height:1.3;margin:1.5em 0 .5em}
.agx-md h1{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid color-mix(in srgb,var(--text) 16%,transparent)}
.agx-md h2{font-size:1.25em;padding-bottom:.25em;border-bottom:1px solid color-mix(in srgb,var(--text) 16%,transparent)}
.agx-md h3{font-size:1.1em}
.agx-md h4,.agx-md h5,.agx-md h6{font-size:1em;color:var(--text2)}
.agx-md a{color:var(--primary);text-underline-offset:2px}
.agx-md strong{color:var(--text);font-weight:600}
.agx-md del{opacity:.6}
/* An inline code span, as a chip you can actually see.
   The wash is mixed from --text, not from --border or a surface: a border is
   whatever a theme wants it to be, and on the neutral ones it sits a hair from
   the panel behind it, so a chip built out of it disappeared and a symbol read
   as ordinary prose. Mixing the *text* colour into transparent always moves
   away from the background, whichever direction the theme runs, so this is a
   step on a dark theme and a step on a light one without a second rule. */
.agx-md code{font-family:var(--diff-font,ui-monospace,monospace);font-size:.88em;background:color-mix(in srgb,var(--text) 13%,transparent);border:1px solid color-mix(in srgb,var(--text) 12%,transparent);padding:.1em .4em;border-radius:5px;color:var(--text)}
/* A mention. Somebody's handle in the middle of prose is a link and reads as one;
   YOUR handle is the thing you scan a page of review for, so it gets the weight
   GitHub gives it — a filled amber chip rather than one more coloured word. */
.agx-mention{color:var(--primary-hover);text-decoration:none;font-weight:500}
.agx-mention:hover{text-decoration:underline}
.agx-mention-you{color:var(--warning);background:color-mix(in srgb,var(--warning) 18%,transparent);border:1px solid color-mix(in srgb,var(--warning) 40%,transparent);border-radius:5px;padding:.05em .3em}
.agx-md pre{background:var(--bg);border:1px solid color-mix(in srgb,var(--text) 16%,transparent);border-radius:6px;padding:.7em .9em;overflow-x:auto;margin:0 0 .9em}
.agx-md pre code{background:none;border:0;padding:0;font-size:.92em;line-height:1.55;color:var(--text)}
.agx-md blockquote{margin:0 0 .9em;padding:.15em 0 .15em .9em;border-left:3px solid color-mix(in srgb,var(--primary) 45%,transparent);color:var(--text2)}
/* The list-style is the point, and its absence is what was reported. This block
   set the indent and coloured the marker but never undid the list-style:none
   that Tailwind's preflight applies to every ul and ol — so there was no marker
   for ::marker to colour, and a review's findings arrived as text nudged 1.5em
   to the right. (No backticks in this comment on purpose: the whole stylesheet
   is a template literal, and one closes it.) */
.agx-md ul,.agx-md ol{margin:0 0 .85em;padding-left:1.5em}
.agx-md ul{list-style:disc}
.agx-md ul ul{list-style:circle}
.agx-md ul ul ul{list-style:square}
.agx-md ol{list-style:decimal}
.agx-md li{margin-bottom:.3em}
.agx-md li::marker{color:var(--primary)}
.agx-md .agx-task{list-style:none;padding-left:0}
.agx-md .agx-task li{display:flex;gap:.55em;align-items:flex-start}
.agx-md .agx-box{flex:none;width:13px;height:13px;margin-top:.28em;border-radius:3px;border:1px solid color-mix(in srgb,var(--text) 24%,transparent);display:inline-flex;align-items:center;justify-content:center;font-size:9px;line-height:1}
.agx-md .agx-box[data-on="1"]{background:var(--primary);border-color:var(--primary);color:var(--bg)}
/* Interactive checkboxes are a button carrying agx-box and agx-btn, so the
   base button chrome — its own background, padding, border and font — has
   to give way to the same 13px square a read-only box already draws. */
button.agx-box{background:none;padding:0;font:inherit;cursor:pointer}
button.agx-box:hover{border-color:color-mix(in srgb,var(--text) 44%,transparent)}
button.agx-box[data-on="1"]:hover{border-color:var(--primary)}
/* A grid of boxes is how a spreadsheet looks, not how a table reads. Rules
   between rows only, a banded head, and one rounded edge around the whole
   thing — the shape GitHub settled on, and the one a coverage report needs to
   be scannable down a column. */
.agx-md .agx-tw{overflow-x:auto;margin:0 0 .9em;max-width:100%;border:1px solid color-mix(in srgb,var(--text) 16%,transparent);border-radius:8px}
.agx-md table{border-collapse:collapse;font-size:.95em;width:100%}
.agx-md th{text-align:left;padding:.55em .9em;background:color-mix(in srgb,var(--border) 22%,transparent);color:var(--text);font-weight:600;border:0;border-bottom:1px solid color-mix(in srgb,var(--text) 16%,transparent);white-space:nowrap}
.agx-md td{padding:.5em .9em;border:0;border-bottom:1px solid color-mix(in srgb,var(--text) 11%,transparent);vertical-align:top;color:var(--text)}
.agx-md tbody tr:last-child td{border-bottom:0}
.agx-md .agx-details{margin:0 0 .9em;border:1px solid color-mix(in srgb,var(--text) 16%,transparent);border-radius:6px;padding:.5em .8em;background:color-mix(in srgb,var(--border) 8%,transparent)}
.agx-md .agx-details>summary{cursor:pointer;color:var(--text);font-weight:600;list-style:revert}
.agx-md .agx-details>div{margin-top:.7em}
.agx-md .agx-suggestion{margin:0 0 .9em;border:1px solid color-mix(in srgb,var(--success) 45%,transparent);border-radius:6px;overflow:hidden}
.agx-md .agx-suggestion-head{font-size:.8em;letter-spacing:.05em;text-transform:uppercase;padding:.35em .8em;color:var(--success);background:color-mix(in srgb,var(--success) 12%,transparent);display:flex;align-items:center;gap:.7em}
.agx-md .agx-suggestion-apply{margin-left:auto;text-transform:none;letter-spacing:0;font-size:.95em;padding:.1em .6em;border-radius:5px;border:1px solid color-mix(in srgb,var(--success) 50%,transparent);color:var(--success);cursor:pointer}
.agx-md .agx-suggestion-apply:disabled{opacity:.45;cursor:default}
.agx-md .agx-suggestion pre{margin:0;border:0;border-radius:0;background:color-mix(in srgb,var(--success) 6%,transparent)}
.agx-md .agx-alert{margin:0 0 .9em;padding:.6em .9em;border-left:3px solid;border-radius:0 6px 6px 0;display:flex;flex-direction:column;gap:.3em}
.agx-md .agx-alert>b{font-size:.82em;letter-spacing:.06em}
.agx-md hr{border:0;border-top:1px solid color-mix(in srgb,var(--text) 16%,transparent);margin:1.2em 0}
.agx-md figure{margin:0 0 .9em}
.agx-md figure img{max-width:100%;border-radius:6px;border:1px solid color-mix(in srgb,var(--text) 16%,transparent);display:block}
.agx-md figcaption{font-size:.85em;color:var(--text3);margin-top:.35em}
`;

/** One markdown block. Images go through the proxy — GitHub's own attachment
 *  URLs answer 404 without the token, and those are the review's evidence. */
/**
 * A proposed replacement, with the button that takes it.
 *
 * GitHub has no API for this — their Apply button is web-only — so the server
 * writes the commit itself: read the file at the head of the branch, splice the
 * lines, commit through `createCommitOnBranch` with the head oid as a guard so
 * a concurrent push is refused rather than clobbered.
 */
function Suggestion({ text }: { text: string }) {
  const ctx = useContext(SuggestCtx);
  return (
    <div className="agx-suggestion">
      <div className="agx-suggestion-head">
        <span>Suggested change</span>
        {ctx && (
          <button onClick={() => ctx.apply(text)} disabled={ctx.busy}
            title="Commit this to the pull request's branch"
            className="agx-btn agx-suggestion-apply">Apply</button>
        )}
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

/** shields.io's own colour words, as this app's palette. */
const SHIELD_TINT: Record<string, string> = {
  brightgreen: "var(--success)", green: "var(--success)", success: "var(--success)",
  yellow: "var(--warning)", yellowgreen: "var(--warning)", orange: "var(--warning)", important: "var(--warning)",
  red: "var(--error)", critical: "var(--error)",
  blue: "var(--info)", informational: "var(--info)", lightblue: "var(--info)",
  lightgrey: "var(--text3)", lightgray: "var(--text3)", grey: "var(--text3)", gray: "var(--text3)", inactive: "var(--text3)",
};

/**
 * A CI badge, drawn from its URL.
 *
 * Two tones, like the real thing: the label sits on a neutral ground and the
 * value takes the colour, so `Coverage 75%` reads as one object and the number
 * is what the eye lands on. An unknown colour word falls back to a hex value if
 * shields was given one, and to the accent otherwise — never to nothing.
 */
function ShieldPill({ label, value, color }: { label: string; value: string; color: string }) {
  const tint = SHIELD_TINT[(color || "").toLowerCase()]
    ?? (/^[0-9a-f]{3,8}$/i.test(color) ? `#${color}` : "var(--primary)");
  return (
    <span className="inline-flex items-stretch rounded overflow-hidden align-middle mb-2 text-[10px] leading-none"
      title={label ? `${label}: ${value}` : value}>
      {label && (
        <span className="px-1.5 py-1" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text2)" }}>{label}</span>
      )}
      <span className="px-1.5 py-1 font-semibold"
        style={{ background: tint, color: "var(--bg)" }}>{value}</span>
    </span>
  );
}

/**
 * A list drawn as the nesting it is, rather than as one flat list with margins.
 *
 * It was flat, and once the markers were switched back on that stopped being a
 * cosmetic difference and started being wrong: every `<li>` of an `<ol>` gets a
 * number, so a bullet nested under step 2 was numbered 3 and pushed step 3 to
 * 5 — a three-step procedure read as five with two invented steps. A sub-list
 * is now a real child list, and it takes its marker from its OWN items, so a
 * bullet under a numbered step is a bullet.
 *
 * Recursive over a flat run because that is the shape the parser produces: each
 * item carries the depth it was written at, and a depth that goes up opens a
 * child, one that goes down closes it.
 */
/** What a `<Md onToggleTask>` hands every checkbox it draws: a shared,
 *  render-pass-only counter (see `Md`) and the callback that turns "box N,
 *  flip it" into a save. */
type TaskWiring = { next: { current: number }; onToggle: (index: number) => void };

function MdList({ items, ordered, wiring }: { items: MdListItem[]; ordered: boolean; wiring?: TaskWiring }) {
  const isTask = items.some((i) => i.checked !== undefined);
  const List = ordered ? "ol" : "ul";
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    // Everything deeper than this item belongs under it.
    const kids: MdListItem[] = [];
    let j = i + 1;
    while (j < items.length && items[j]!.depth > it.depth) { kids.push(items[j]!); j++; }
    /* The index this ONE box gets, claimed at render time — before its kids
       render, so a nested checkbox is numbered after its parent and before
       its parent's siblings, same as it reads in the raw text. */
    const taskIndex = it.checked !== undefined && wiring ? wiring.next.current++ : -1;
    nodes.push(
      <li key={i}>
        {it.checked !== undefined && (
          wiring && taskIndex >= 0 ? (
            <button type="button" className="agx-box agx-btn" data-on={it.checked ? "1" : "0"}
              role="checkbox" aria-checked={it.checked}
              title={it.checked ? "Uncheck" : "Check"}
              onClick={() => wiring.onToggle(taskIndex)}>
              {it.checked ? "✓" : ""}
            </button>
          ) : (
            <span className="agx-box" data-on={it.checked ? "1" : "0"}>{it.checked ? "✓" : ""}</span>
          )
        )}
        <span dangerouslySetInnerHTML={{ __html: it.html }} />
        {kids.length > 0 && <MdList items={kids} ordered={!!kids[0]!.ordered} wiring={wiring} />}
      </li>,
    );
    i = j - 1;
  }
  return <List className={isTask ? "agx-task" : undefined}>{nodes}</List>;
}

function Block({ b, wiring }: { b: MdBlock; wiring?: TaskWiring }) {
  if (b.kind === "heading") {
    const H = (["h1", "h2", "h3", "h4", "h5", "h6"][b.level - 1] ?? "h6") as "h1";
    return <H dangerouslySetInnerHTML={{ __html: b.html }} />;
  }
  if (b.kind === "para") return <p dangerouslySetInnerHTML={{ __html: b.html }} />;
  if (b.kind === "rule") return <hr />;
  if (b.kind === "code") return <MdCodeBlock code={b.text} tag={b.lang} />;
  if (b.kind === "quote") return <blockquote dangerouslySetInnerHTML={{ __html: b.html }} />;
  if (b.kind === "image") {
    // A shields.io badge is text pretending to be a picture. Drawn rather than
    // fetched: the proxy does not allow that host, so every CI comment opened
    // with a broken image where its headline number should have been.
    const badge = parseShieldBadge(b.src);
    if (badge) return <ShieldPill {...badge} />;
    return (
      <figure>
        <img src={api.prAssetUrl(b.src)} alt={b.alt} loading="lazy" />
        {b.alt && <figcaption>{b.alt}</figcaption>}
      </figure>
    );
  }
  if (b.kind === "table") {
    return (
      <div className="agx-tw agx-scroll">
        <table>
          <thead><tr>{b.head.map((h, i) => <th key={i} dangerouslySetInnerHTML={{ __html: h }} />)}</tr></thead>
          <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} dangerouslySetInnerHTML={{ __html: c }} />)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (b.kind === "details") {
    // A real disclosure. Bots fold their output into <details>, and until now
    // the tags came through escaped — the "collapsed" part of a collapsed
    // comment was the one thing that did not work.
    return (
      <details className="agx-details">
        <summary>{b.summary}</summary>
        <div>{b.blocks.map((inner, i) => <Block key={i} b={inner} wiring={wiring} />)}</div>
      </details>
    );
  }
  if (b.kind === "alert") {
    const tint = b.level === "caution" || b.level === "warning" ? "var(--warning)"
      : b.level === "important" ? "var(--primary)"
      : b.level === "tip" ? "var(--success)" : "var(--info)";
    return (
      <div className="agx-alert" style={{ borderColor: tint, background: `color-mix(in srgb, ${tint} 8%, transparent)` }}>
        <b style={{ color: tint }}>{b.level.toUpperCase()}</b>
        <span dangerouslySetInnerHTML={{ __html: b.html }} />
      </div>
    );
  }
  if (b.kind === "suggestion") return <Suggestion text={b.text} />;
  return <MdList items={b.items} ordered={b.ordered} wiring={wiring} />;
}

/*
 * A fenced code block is `mdCode.tsx`'s CodeBlock, the same one every other
 * markdown surface in this app uses. There used to be a second implementation
 * here, and it had two faults that only showed up on a real review:
 *
 *   the theme was never registered. It passed `shikiTheme()` straight to
 *   `codeToHtml` without `ensureTheme`, so tokenising threw unless some OTHER
 *   surface had happened to load that theme in this session — open the diff first
 *   and a pull request's code blocks were coloured, go straight to the pull
 *   request and they were flat grey. Reported as "sometimes the code blocks
 *   lose their colour… I restart the app and look", and the restart was not the fix:
 *   what changed was which surface was opened first.
 *
 *   a fence with no language was never coloured at all. `if (!id) return`, where
 *   the shared one guesses from the code (see guessLang) — and a review pasted
 *   from an editor very often has a bare ``` on it.
 *
 * It also ignored the theme and bold preferences the diff picker sets, and built
 * its output with `dangerouslySetInnerHTML`. One implementation, and none of that
 * can drift apart again.
 */

/** Who `@` completes to and which issues `#` does, for the composer. A context
 *  for the same reason as RepoCtx: the composer is rendered from several places
 *  and none of them should have to carry this. */
export type Mentionables = { users: string[]; issues: { number: number; title: string }[] };
export const MentionCtx = createContext<Mentionables | null>(null);

/** The emoji names the composer offers. Same table the renderer uses. */
const EMOJI_NAMES: Record<string, string> = {
  tada: "🎉", rocket: "🚀", sparkles: "✨", bug: "🐛", fire: "🔥", warning: "⚠️",
  white_check_mark: "✅", x: "❌", "+1": "👍", "-1": "👎", eyes: "👀", heart: "❤️",
  pray: "🙏", clap: "👏", wrench: "🔧", memo: "📝", lock: "🔒", zap: "⚡",
  boom: "💥", art: "🎨", recycle: "♻️", bulb: "💡", mag: "🔍", robot: "🤖",
};

/** The `owner/name` these bodies belong to, so `#123` and bare SHAs can link
 *  somewhere real. A context because `Md` is rendered from a dozen places and
 *  threading a prop through all of them to reach the same value is noise. */
export const RepoCtx = createContext<string | undefined>(undefined);

/**
 * Whose GitHub login this window is signed in as.
 *
 * Only used to mark `@you` in somebody else's prose, which is the difference
 * between a review you have to read all of and a review with one line in it
 * addressed to you. Undefined until the capability call lands, and undefined is
 * simply "no highlight" — never a wrong one.
 */
export const ViewerCtx = createContext<string | undefined>(undefined);

/** How a suggestion block gets applied. Supplied by whichever thread the
 *  comment belongs to, because only it knows the file and the lines; a markdown
 *  block on its own knows neither. Null where there is nothing to apply to (a
 *  suggestion written in the PR body, say). */
export const SuggestCtx = createContext<{ apply: (text: string) => void; busy: boolean } | null>(null);

/**
 * "Open this commit here, if it is one of ours."
 *
 * A reviewer — human or not — writes `8c362cc → c9ed653` and GitHub turns each
 * into a link to that commit. Following one left the app entirely, for a commit
 * that is sitting in the Commits tab two clicks away.
 *
 * A context rather than a prop because `Md` renders inside cards, threads and
 * the rail, several components deep, and threading a handler through all of
 * them to serve one anchor is how a component signature stops meaning anything.
 * Absent — release notes, settings, anywhere with no pull request around it —
 * every link behaves exactly as before.
 *
 * The resolver answers whether it TOOK the commit. A sha from another pull
 * request is not ours to show: the panel holds one pull request's commits and
 * has no diff for anybody else's, so that click still goes to GitHub, which
 * does.
 */
const CommitJumpCtx = createContext<((sha: string) => boolean) | null>(null);


export function Md({ body, className, onToggleTask }: {
  body: string; className?: string;
  /**
   * "GitHub already does this without having to hand-edit the body, by
   * ticking it as a real checkbox": a real, clickable checkbox, same as
   * GitHub's own — never on by default, since a review comment or a bot's
   * digest is not this reader's body to rewrite. Given the WHOLE new body
   * (see `toggleChecklistItem`) rather than an index, so the caller — who
   * owns the write, and knows whether it is even allowed here — has nothing
   * to compute, only to save.
   */
  onToggleTask?: (newBody: string) => void;
}) {
  const repo = useContext(RepoCtx);
  const jump = useContext(CommitJumpCtx);
  /* Who is reading, so `@your-handle` can be marked as addressed to you — the one
     thing in a wall of review you scan for. A context for the same reason as
     RepoCtx: this renderer is called from a dozen places. */
  const viewer = useContext(ViewerCtx);
  const blocks = useMemo(() => parseBody(body, repo, viewer), [body, repo, viewer]);
  /*
   * ONE COUNTER FOR THE WHOLE BODY, not one per list — and a hook, so it has
   * to sit above the early return below it, same as every other hook here.
   *
   * `toggleChecklistItem`'s index is a position in the RAW TEXT — document
   * order, every checkbox counted once, nesting and separate lists included.
   * A fresh counter per `<MdList>` would number each list from zero and flip
   * the wrong line the moment a body has more than one. Reset on every
   * render and mutated during it, never read after — the render order below
   * is depth-first and synchronous, which is what makes handing out
   * `next.current++` in JSX order equal to handing out document order.
   */
  const nextTask = useRef(0);
  nextTask.current = 0;
  if (!body?.trim()) return null;
  /* Delegated from the wrapper rather than handed to each anchor: the markdown
     renderer is shared with chat, the document viewer and the release notes,
     and it should not learn what a pull request is to serve this. */
  const onClick = jump ? (e: React.MouseEvent) => {
    // Never steal a modified click — that is somebody asking for a new window.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const a = (e.target as HTMLElement | null)?.closest?.("a");
    const href = a?.getAttribute("href");
    if (!href) return;
    const sha = shaFromHref(href, repo);
    if (sha && jump(sha)) e.preventDefault();
  } : undefined;
  const wiring: TaskWiring | undefined = onToggleTask
    ? { next: nextTask, onToggle: (i) => onToggleTask(toggleChecklistItem(body, i)) }
    : undefined;
  return <div className={`agx-md ${className ?? ""}`} onClick={onClick}>{blocks.map((b, i) => <Block key={i} b={b} wiring={wiring} />)}</div>;
}

// ---------------------------------------------------------------------------
// diff, through the app's own viewer
// ---------------------------------------------------------------------------

/** Which commit a pull request currently points at — `headSha` when the list
 *  filled it in, the last commit otherwise, and "" when neither is loaded yet.
 *  Used to tell "the same pull request" from "the same pull request, pushed
 *  to", which is the difference between a cached diff and a wrong one. */
function headOfDetail(d: PrDetail | null): string {
  if (!d) return "";
  return d.headSha || (d.commits.length ? d.commits[d.commits.length - 1].oid : "");
}

/** A parsed diff in the shape ChangesModal's viewer speaks. The synthetic
 *  fields are inert — that component reads path, counts and hunks. */
function toFileChange(f: ParsedFile, i: number): FileChange {
  return {
    id: i, timestamp: 0, source_app: "github", session_id: "pr", tool: "PullRequest",
    file_path: f.path, additions: f.additions, deletions: f.deletions, hunks: f.hunks,
  };
}

/**
 * The lines around a hunk, fetched on demand.
 *
 * A diff only carries what GitHub chose to send — three lines of context — so
 * the code just above a change is not in the payload at all and there is
 * nothing to reveal locally. Each expansion asks the server for that slice of
 * the file at this side of the pull request, twenty lines at a time, the way
 * GitHub's own chevrons work.
 */
function ExpandContext({ root, number, path, from, to, side = "RIGHT" }: {
  root: string; number: number; path: string; from: number; to: number; side?: "LEFT" | "RIGHT";
}) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (from > to) return null;
  const load = async () => {
    setBusy(true); setErr(null);
    const r = await api.prFileSlice(root, number, path, side, from, to).catch(() => null);
    setBusy(false);
    if (!r?.ok || !r.lines) { setErr(r?.error || "Could not read that part of the file"); return; }
    setLines(r.lines);
  };
  if (lines) {
    return (
      <div className="whitespace-pre px-3 py-0.5 text-[12px]" style={{ ...CODE_FONT_STYLE, color: "var(--text3)", background: "color-mix(in srgb, var(--border) 8%, transparent)" }}>
        {lines.join("\n")}
      </div>
    );
  }
  return (
    <button onClick={load} disabled={busy} title={`Show lines ${from}-${to}`}
      className="agx-btn w-full text-left px-3 py-0.5 text-[10.5px]"
      style={{ color: err ? "var(--error)" : "var(--text3)", background: "color-mix(in srgb, var(--border) 10%, transparent)" }}>
      {err ?? (busy ? "…" : `⌃⌄ Expand ${to - from + 1} line${to - from ? "s" : ""}`)}
    </button>
  );
}

/**
 * An image, before and after.
 *
 * A unified diff cannot say anything about a PNG — the file list reports it as
 * "no textual diff" and that is the end of it. Both sides are fetched by path
 * and shown next to each other, which is the whole question an image change
 * raises: what did it look like, and what does it look like now. Added and
 * deleted files simply have one side.
 */

function ImageDiff({ root, number, path, status }: {
  root: string; number: number; path: string; status: string;
}) {
  const [sides, setSides] = useState<{ left?: string; right?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const want: ("LEFT" | "RIGHT")[] =
      status === "added" ? ["RIGHT"] : status === "removed" || status === "deleted" ? ["LEFT"] : ["LEFT", "RIGHT"];
    Promise.all(want.map((side) => api.prFileSlice(root, number, path, side).then((r) => [side, r] as const).catch(() => [side, null] as const)))
      .then((res) => {
        if (!live) return;
        const out: { left?: string; right?: string } = {};
        for (const [side, r] of res) {
          // Text came back for an image: that is an SVG, which is both. Render
          // it from a data URL rather than round-tripping the bytes again.
          const url = r?.ok
            ? (r.url || (r.lines ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(r.lines.join("\n"))))}` : ""))
            : "";
          if (url) out[side === "LEFT" ? "left" : "right"] = api.prAssetUrl(url);
        }
        if (!out.left && !out.right) setErr("Could not read the image on either side");
        setSides(out);
      });
    return () => { live = false; };
  }, [root, number, path, status]);

  if (err) return <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>{err}</div>;
  if (!sides) return <Loading label="Loading the image…" size={18} />;
  const pane = (label: string, src?: string, tint?: string) => (
    <div className="flex-1 min-w-0 p-3 flex flex-col gap-1.5 items-start">
      <span className="text-[9.5px] uppercase tracking-wider" style={{ color: tint ?? "var(--text3)" }}>{label}</span>
      {src
        ? <img src={src} alt="" className="max-w-full rounded" style={{ maxHeight: 320, border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", background: "repeating-conic-gradient(color-mix(in srgb, var(--border) 22%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px" }} />
        : <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>—</span>}
    </div>
  );
  return (
    <div className="flex flex-wrap w-full">
      {sides.left !== undefined || sides.right === undefined ? pane("before", sides.left, "var(--error)") : null}
      {sides.right !== undefined || sides.left === undefined ? pane("after", sides.right, "var(--success)") : null}
    </div>
  );
}

function DiffPane({ file, split, wrap, onPick, sel, expand, rowAfter, permalink }: {
  file: FileChange; split: boolean; wrap: boolean;
  onPick?: (p: LinePick) => void; sel?: LineSel;
  /** Renders the "expand" strip above each hunk, when the file is one we can
   *  fetch more of. Absent for a commit diff, which is not a pull request. */
  expand?: (hunkIndex: number) => React.ReactNode;
  /** Renders a review-comment thread inline, under the line it is anchored to.
   *  Called per row with the new/old line numbers; return null for lines with
   *  no comment. Absent for a commit diff, which carries no review threads. */
  rowAfter?: (newN: number | null | undefined, oldN: number | null | undefined) => React.ReactNode;
  /** A GitHub permalink to a line, for the "+" menu's Copy link. Present ⇒ this
   *  is a pull request, so the "+" opens the review menu. */
  permalink?: (line: number, side: "LEFT" | "RIGHT") => string | null;
}) {
  // Syntax highlighting, which this pane never had: `Code` reads the theme out
  // of `HiliteCtx`, and with no Provider above it every PR diff rendered as
  // plain monochrome text while the very same viewer in the changes modal came
  // out coloured. A very long diff drops the theme (not the parse) so a
  // thousand-line file does not spend its time colouring.
  const { hilite } = useDiffHighlight(file.file_path);
  const heavy = file.hunks.reduce((n, h) => n + h.lines.length, 0) > 3000;
  return (
    <HiliteCtx.Provider value={heavy ? { ...hilite, theme: null } : hilite}>
      <LineMenuCtx.Provider value={onPick ? { permalink } : null}>
        {split
          ? <SplitDiff c={file} wrap={wrap} onPick={onPick} sel={sel} rowAfter={rowAfter} />
          : <UnifiedDiff c={file} wrap={wrap} onPick={onPick} sel={sel} hunkAction={expand} rowAfter={rowAfter} />}
      </LineMenuCtx.Provider>
    </HiliteCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// list row
// ---------------------------------------------------------------------------

/** Placeholder rows while the list is on its way.
 *
 *  A spinner says "wait"; these say "a list is coming, roughly this shape",
 *  which is the difference between a pane that feels slow and one that feels
 *  broken. `prefers-reduced-motion` drops the shimmer, not the placeholder. */
/**
 * Waiting, said properly.
 *
 * A line of text in the top-left corner of an otherwise empty pane does not
 * read as "working" — it reads as the whole answer, and a wrong-looking one.
 * A spinner in the middle of the space it is going to fill says where the
 * content will be and that something is still happening.
 *
 * The ring itself is `.agx-spin` from index.css and nothing here. This file
 * used to inject a second rule under that same name, and a `<style>` in the
 * body beats a stylesheet in the head — so mounting this panel restyled every
 * spinner in the app and unmounting it put them back. The reduced-motion pulse
 * that rule argued for was the better answer and moved to index.css with it.
 */
function Loading({ label, fill, size = 22 }: { label: string; fill?: boolean; size?: number }) {
  return (
    <div role="status" aria-live="polite"
      className={`flex flex-col items-center justify-center gap-2.5 ${fill ? "flex-1 min-h-0 self-stretch" : "w-full py-6"}`}
      style={{ color: "var(--text3)" }}>
      <span className="agx-spin shrink-0" style={{ width: size, height: size }} />
      <span className="text-[10.5px]">{label}</span>
    </div>
  );
}

function Skeletons({ n = 6 }: { n?: number }) {
  return (
    <div aria-hidden>
      <style>{`@keyframes agxpulse{0%,100%{opacity:.35}50%{opacity:.7}}
@media (prefers-reduced-motion:reduce){.agx-sk{animation:none!important}}`}</style>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="px-2.5 py-2 border-b" style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <div className="agx-sk rounded" style={{
            height: 8, width: `${58 + ((i * 13) % 34)}%`, background: "color-mix(in srgb, var(--border) 55%, transparent)",
            animation: `agxpulse 1.4s ease-in-out ${i * 0.09}s infinite`,
          }} />
          <div className="agx-sk rounded mt-1.5" style={{
            height: 6, width: `${30 + ((i * 7) % 20)}%`, background: "color-mix(in srgb, var(--border) 38%, transparent)",
            animation: `agxpulse 1.4s ease-in-out ${i * 0.09 + 0.2}s infinite`,
          }} />
        </div>
      ))}
    </div>
  );
}

/**
 * The list's columns, as one string.
 *
 * The heading row and every data row read this same constant, so they cannot
 * drift apart — headings that do not sit over their own values are worse than
 * no headings at all.
 */
const PR_GRID = "78px minmax(0,1fr) 118px 112px 84px 84px";

/**
 * Row backgrounds live here rather than in a `style` prop because an inline
 * background cannot be overridden by `:hover` — the highlighted row would be
 * the one row in the table that did not respond to the pointer.
 */
const PR_ROW_CSS = `
/* Where the jump landed you.
   A scroll that ends in silence is indistinguishable from a scroll that did
   nothing, so the reader carries on scrolling to check — which is exactly the
   behaviour the jump exists to stop. A ring that fades over a second says "this
   one" without leaving a mark that has to be cleared. Honoured for reduced
   motion by holding the ring instead of animating it: the message is the point,
   the animation is only how it is delivered. */
@keyframes agx-found{from{box-shadow:0 0 0 3px color-mix(in srgb, var(--warning) 65%, transparent)}
to{box-shadow:0 0 0 14px transparent}}
.agx-found{animation:agx-found 1100ms ease-out}
@media (prefers-reduced-motion: reduce){.agx-found{animation:none;outline:2px solid var(--warning);outline-offset:2px}}
/* The two links out to GitHub in the header. A border and a hover, because
   grey text with an arrow after it reads as a caption rather than as a
   control — which is what the first attempt at this shipped and what it was
   sent back for. */
.agx-ghchip{border:1px solid color-mix(in srgb, var(--border) 70%, transparent);background:color-mix(in srgb, var(--bg2) 60%, transparent);color:var(--text2)}
.agx-ghchip:hover{border-color:color-mix(in srgb, var(--primary) 55%, transparent);background:color-mix(in srgb, var(--primary) 12%, transparent);color:var(--text)}
.agx-prrow:hover{background:color-mix(in srgb, var(--border) 16%, transparent)}
.agx-prrow[data-active="1"]{background:color-mix(in srgb, var(--primary) 12%, transparent)}
.agx-prrow[data-active="1"]:hover{background:color-mix(in srgb, var(--primary) 18%, transparent)}
`;

/** The state of a pull request as the one glyph the ID column has room for. */
function rowState(p: PrSummary): { tint: string; title: string } {
  if (p.state === "MERGED") return { tint: "var(--primary)", title: "Merged" };
  if (p.state === "CLOSED") return { tint: "var(--text3)", title: "Closed without merging" };
  if (p.isDraft) return { tint: "var(--text3)", title: "Draft" };
  return { tint: "var(--success)", title: "Open" };
}

/**
 * Who was asked to review, as faces.
 *
 * Empty and not-yet-known are different, and the column says so: a dash means
 * nobody was asked, a dimmed ellipsis means the second pass has not landed. The
 * faces come from the login through the app's avatar proxy; a team has no face
 * and gets its initials in a flat badge rather than a portrait of nobody.
 */
/**
 * One requested reviewer's face.
 *
 * A team has no avatar and no login, so asking the proxy for a portrait of
 * "platform" returns a broken image; it gets its initials in a flat badge
 * instead. Shared by the three places that draw a reviewer, which used to
 * disagree — only the list knew teams existed, because only the list was given
 * a shape that could say so.
 */
function ReviewerFace({ r, size }: { r: PrReviewer; size: number }) {
  if (!r.isTeam) return <Avatar login={r.login} size={size} />;
  return (
    <span className="rounded-full inline-flex items-center justify-center shrink-0" title={`${r.login} (team)`}
      style={{ width: size, height: size, fontSize: size * 0.42, color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 24%, transparent)" }}>
      {r.login.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** One reviewer's own verdict, beside their face. A row of faces says who was
 *  asked; it does not say what any of them decided, and that is the half people
 *  came for. */
function ReviewerMark({ state, again }: { state: ReviewerState; again?: boolean }) {
  const spec = state === "approved" ? { g: "✓", c: "var(--success)" }
    : state === "changes" ? { g: "✕", c: "var(--error)" }
    : state === "commented" ? { g: "💬", c: "var(--text3)" }
    : state === "dismissed" ? { g: "⊘", c: "var(--text4)" }
    : { g: "◯", c: "var(--warning)" };
  return (
    <span className="inline-flex items-center gap-0.5">
      {/* Asked again after answering — GitHub's ↻, same as the sidebar's own
          reviewer list draws it, and the same reason a lone tick or cross is
          not the whole story once a follow-up round has been asked for. */}
      {again && <span aria-hidden style={{ color: "var(--text4)", fontSize: 14 }} title="Asked to look again">↻</span>}
      <span aria-hidden style={{ color: spec.c, fontSize: 14 }}>{spec.g}</span>
    </span>
  );
}

function ReviewerStack({ p }: { p: PrSummary }) {
  const list = p.reviewers ?? [];
  if (list.length === 0) {
    const pending = p.checksLoaded === false;
    return (
      <span className="text-[10px]" style={{ color: "var(--text3)" }}
        title={pending ? "Still loading" : "Nobody has been asked to review"}>{pending ? "…" : "—"}</span>
    );
  }
  const shown = list.slice(0, 3);
  const rest = list.length - shown.length;
  return (
    <span className="flex items-center min-w-0" title={`Review requested from ${list.map((r) => r.login).join(", ")}`}>
      {shown.map((r, i) => (
        <span key={r.login} className="shrink-0 rounded-full" style={{ marginLeft: i === 0 ? 0 : -5, boxShadow: "0 0 0 1.5px var(--bg2)" }}>
          <ReviewerFace r={r} size={18} />
        </span>
      ))}
      {rest > 0 && <span className="ml-1 text-[10px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>+{rest}</span>}
    </span>
  );
}

function ChecksCell({ p }: { p: PrSummary }) {
  const c = p.checks;
  const loading = p.checksLoaded === false;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <Dot tint={loading ? "var(--text3)" : stateTint(p)}
        title={loading ? "Check states are still loading" : `${c.success} passed · ${c.failure} failed · ${c.skipped} skipped · ${c.pending} running`} />
      <span className="text-[10.5px] tabular-nums truncate" style={{ color: loading ? "var(--text3)" : "var(--text2)" }}>
        {/* Not yet fetched is not the same as none. Saying "no checks" here
            would be a claim about the repository rather than about us. */}
        {loading ? "Checks…"
          : c.total === 0 ? "No checks"
          : c.pending > 0 ? `${c.total - c.pending}/${c.total}`
          : c.failure > 0 ? `${c.failure} failing` : "Green"}
      </span>
    </span>
  );
}

function PrTableHead() {
  return (
    <div className="grid items-center gap-3 px-3 py-1.5 border-b shrink-0 sticky top-0 z-10 select-none"
      style={{
        gridTemplateColumns: PR_GRID,
        borderColor: "color-mix(in srgb, var(--text) 11%, transparent)",
        // The workspace panel this lives in is painted --bg2; a sticky heading
        // in --bg would read as a band of the wrong colour sliding over the
        // rows rather than as the table's own header.
        background: "var(--bg2)",
        color: "var(--text3)",
        fontSize: 10,
        letterSpacing: ".07em",
        textTransform: "uppercase",
      }}>
      <span>ID</span>
      <span>Title / context</span>
      <span>Reviewers</span>
      <span>Checks</span>
      <span>Updated</span>
      <span />
    </div>
  );
}

/**
 * The pins, centred on the bar.
 *
 * The ones you keep coming back to, one click from wherever you are. This panel
 * shows one pull request at a time, so moving between two of them was a trip:
 * back to the list, find it again in a list that reorders itself by activity,
 * open it — twice a minute while a suite runs, and the row has usually moved
 * since you last looked.
 *
 * It used to be a row of its own under the way back, drawn even when it was
 * empty so that it could not push the masthead down a second after the detail
 * landed. In one bar there is nothing to push: an empty capsule can simply not
 * be there, and the bar it would have sat in is the same height either way. So
 * the list view gets it too — the jump-list is as useful over a table as it is
 * over a pull request — and on a machine with nothing pinned neither view pays
 * anything for it.
 *
 * Centred absolutely rather than laid out between its neighbours: the chips on
 * the left and the Refresh on the right are what the list view draws, and the
 * capsule must not move them. It also means the pins sit in the same place in
 * both views, which is the point of putting them in a shared bar at all.
 */
function PinnedCapsule({ pinned, pinState, selected, current, onOpen }: {
  pinned: Pin[];
  /** The rollup for a pinned pull request, when the current list happens to
   *  carry it. A pin from another scope has no state to show and shows none. */
  pinState: Map<number, PrSummary>;
  selected: number | null;
  /** The pull request on screen, when there is one — it gets the pin control.
   *  Null in the list view, which is why that view is pins-or-nothing. */
  current: { repo: string; number: number; title: string } | null;
  onOpen: (n: number) => void;
}) {
  // Nothing pinned and nothing to pin: no capsule, no gap where one would be.
  if (pinned.length === 0 && !current) return null;
  const currentPinned = !!current && isPinned(current.repo, current.number);

  return (
    <div className="absolute left-1/2 -translate-x-1/2 flex items-center pointer-events-none"
      style={{ maxWidth: "40%" }}>
      <div className="flex items-center gap-1.5 rounded-full pl-2.5 pr-1 py-0.5 min-w-0 overflow-x-auto agx-scroll pointer-events-auto"
        style={{
          background: "color-mix(in srgb, var(--bg3) 85%, transparent)",
          border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
        }}>
        {pinned.length === 0
          ? <span className="text-[10px] shrink-0" style={{ color: "var(--text4)" }}>☆ nothing pinned</span>
          : (
            <span className="text-[10px] uppercase tracking-wider shrink-0" style={{ color: "var(--text4)" }}>Pinned</span>
          )}
        {/*
         * Two actions on one chip: the number opens it, the × takes it off.
         * Taking a pin off used to mean opening the pull request first, which
         * is the trip this bar exists to save. The × is revealed on hover and
         * held open on the one you are reading, so at rest this is a row of
         * numbers rather than a row of numbers and crosses. A span rather than
         * a nested button: a button inside a button is invalid markup and the
         * inner one stops receiving clicks in some engines.
         */}
        {pinned.map((p) => (
          <span key={p.number}
            className="group flex items-center gap-1 rounded-full shrink-0 overflow-hidden pl-1.5"
            style={p.number === selected
              ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }
              : { border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
            {/* A dot, not a coloured number. Colour alone cannot say "green" to
                somebody who cannot see green, and the same dot is what the rows
                in the list use — so the bar and the list agree rather than
                being two vocabularies. */}
            {(() => {
              const sum = pinState.get(p.number);
              if (!sum) return null;
              const c = sum.checks;
              const what = c.pending > 0 ? `${c.pending} still running`
                : c.verdict === "red" ? `${c.failure} failing`
                : c.verdict === "green" ? "all checks passed"
                : "nothing has reported";
              return <Dot tint={stateTint(sum)} title={`#${p.number} — ${what}`} />;
            })()}
            <button onClick={() => onOpen(p.number)} title={p.title}
              className="text-[10px] pr-1 py-px tabular-nums"
              style={{ color: p.number === selected ? "var(--text)" : "var(--text2)" }}>
              #{p.number}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); togglePin(p.repo, p.number, p.title); }}
              title={`Unpin #${p.number}`}
              aria-label={`Unpin #${p.number}`}
              className={`leading-none grid place-items-center ${p.number === selected ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
              style={{ color: "var(--text3)", fontSize: 14, width: 18, height: 18 }}>
              ×
            </button>
          </span>
        ))}
        {/* The control sits IN the bar it feeds, so pressing it explains the bar
            the first time — a pin button somewhere else and a strip of numbers
            up here are two features until you happen to press one and watch the
            other change. */}
        {current && (
          <button
            onClick={() => togglePin(current.repo, current.number, current.title)}
            title={currentPinned
              ? `#${current.number} is on the bar — click to take it off`
              : `Keep #${current.number} on this bar, one click away from anywhere in this panel`}
            className="text-[10px] px-2 py-px rounded-full shrink-0"
            style={currentPinned
              ? { color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }
              : { color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 32%, transparent)", background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
            {currentPinned ? "★ Pinned" : `☆ Pin #${current.number}`}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What this pull request cost on this machine — and the sentence that says what
 * that number is allowed to mean.
 *
 * Every hosted tool in this space reports spend by developer, repository and
 * branch, inferring the mapping from a usage feed that arrives with no checkout
 * attached. Here the events, the worktrees and the pull requests are in one
 * local database, so the same figure is a query (server/src/spend.ts). Which
 * makes it tempting to print `$12.47` and stop — and that would be the one
 * number on this board that quietly overstates what is known.
 *
 * So the tilde is load-bearing. A turn that recorded its own branch is money
 * this branch definitely spent; a turn that recorded none is attributed by the
 * directory it ran in, which is right until the day that worktree was on
 * something else. The moment any of the total comes from the second kind, the
 * chip says `~` and the tooltip says which part and why. Same rule as
 * prWorktreeCell: a state we are only guessing at must never be drawn as one we
 * know.
 *
 * Nothing at all when the branch has no local spend. Not `$0.00` — a branch
 * written on another machine, or before this cockpit was watching, has an
 * unknown cost, and zero is a different claim.
 */
export type SpendChip = {
  text: string;
  title: string;
  /** The caveat in six words, for the one place that has room to print it
   *  instead of hiding it in a tooltip. */
  note: string;
};

const usd = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

export function spendChipFor(b: BranchSpend | undefined | null, repo: RepoSpend | null): SpendChip | null {
  if (!repo?.ok || !b || b.usd <= 0) return null;
  const guessed = b.inferredUsd > 0;
  const lines = [
    guessed
      ? `About ${usd(b.usd)} of local agent spend on ${b.branch}.`
      : `${usd(b.usd)} of local agent spend on ${b.branch}.`,
    `${b.sessions} session${b.sessions === 1 ? "" : "s"} worked on it.`,
  ];
  if (guessed) {
    const where = b.dirs.map(folderOf).join(", ");
    lines.push(
      `${usd(b.namedUsd)} of that came from turns that recorded this branch as they ran.`,
      `${usd(b.inferredUsd)} came from turns that recorded no branch at all and is attributed by where it ran${where ? ` (${where})` : ""} — so an agent working in that folder before this branch existed is counted here too.`,
    );
  }
  if (repo.beforeSeamUsd > 0 && repo.seamDay) {
    lines.push(`Before ${repo.seamDay} this project also spent ${usd(repo.beforeSeamUsd)} that is now kept per day and can no longer be split by branch.`);
  }
  lines.push("Local events only — whatever an agent ran on another machine is not in this.");
  return {
    text: `${guessed ? "~" : ""}${usd(b.usd)}`,
    title: lines.join("\n\n"),
    note: guessed
      ? `${usd(b.namedUsd)} on this branch, ${usd(b.inferredUsd)} attributed by folder`
      : "from turns that recorded this branch",
  };
}


/**
 * One view on the pull-request row.
 *
 * A SEGMENTED CONTROL, not a row of words, which is this app's own answer to
 * the same row in the git panel: "these were 10.5px labels with a superscript
 * count and a leading digit, all in three greys — nine of them in a line, and
 * picking one meant reading all nine".
 *
 * Two things change from what this row used to draw, and both are that answer:
 *
 *   the selected one   is a TINT, not an inversion. Filled `--primary` with
 *                      `--bg` text is the loudest thing this app can paint, and
 *                      it sat on a row you read at a glance twenty times an
 *                      hour. A 18% wash under `--text` says "here" without
 *                      shouting, and leaves the accent free for the one action
 *                      that should lead.
 *   the rest           carry NO border. Seven outlines competing is why nothing
 *                      stood out: a border on every option is a border on none.
 *                      Now the shape of the selected one is the only shape.
 *
 * The count is a real badge rather than a trailing number at 75% opacity —
 * readable at arm's length, which is the distance these are read from.
 */
function Pill({ on, label, icon, dot, count, countTint, title, onClick }: {
  on: boolean;
  label: string;
  icon?: React.ReactNode;
  /** The lane colour, for scopes that have one. Drawn only when unselected —
   *  selected, the tint IS the state, and two colours would compete. */
  dot?: string;
  count?: number;
  /** A count that means something other than "how many are in here". The
   *  inbox's is unread, so it keeps warning colour even when you are elsewhere. */
  countTint?: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} title={title} role="tab" aria-selected={on}
      className="agx-btn text-[10px] leading-none px-2 py-1 rounded-lg flex items-center gap-1.5 shrink-0 transition-all"
      style={{
        color: on ? "var(--text)" : "var(--text3)",
        background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
        border: `1px solid ${on ? "color-mix(in srgb, var(--primary) 42%, transparent)" : "transparent"}`,
        fontWeight: on ? 600 : 400,
      }}>
      {icon}
      {dot && !on && <span className="rounded-full shrink-0" style={{ width: 5, height: 5, background: dot }} />}
      {label}
      {count != null && count > 0 && (
        <span className="tabular-nums text-[9px] px-1.5 py-px rounded-full"
          style={{
            color: countTint ?? (on ? "var(--primary-hover)" : "var(--text3)"),
            background: on
              ? "color-mix(in srgb, var(--primary) 22%, transparent)"
              : `color-mix(in srgb, ${countTint ?? "var(--text)"} ${countTint ? "18%" : "10%"}, transparent)`,
          }}>{count}</span>
      )}
    </button>
  );
}

function PrRow({ p, active, onSelect, onReview, pinned, onTogglePin, q, unread, spend }: {
  p: PrSummary; active: boolean; onSelect: () => void; onReview: () => void;
  /** Remarks since you last looked, or null. The same badge the board's cards
   *  wear — see prUnread.ts. */
  unread?: Unread | null;
  /** What is in the filter box, so a row that is here because of a PERSON can
   *  say which one. Without it a search for "javi" returns rows whose author
   *  column says somebody else, and the list looks like it ignored you. */
  q?: string;
  /** On the bar at the top. Undefined where there is no repository to pin it
   *  against, and the control then does not appear at all. */
  pinned?: boolean; onTogglePin?: () => void;
  /** What this branch has cost locally, already worded — see spendChipFor.
   *  Null both when nothing was spent and when the answer has not landed. */
  spend?: SpendChip | null;
}) {
  const st = rowState(p);
  const shownLabels = p.labels.slice(0, 2);
  return (
    <div data-pr-row={p.number} data-active={active ? "1" : undefined} onClick={onSelect} role="button" tabIndex={-1}
      className="group/prrow grid items-center gap-3 px-3 py-2 border-b cursor-pointer agx-prrow"
      style={{
        gridTemplateColumns: PR_GRID,
        borderColor: "color-mix(in srgb, var(--text) 11%, transparent)",
        boxShadow: active ? "inset 2px 0 0 var(--primary)" : undefined,
      }}>
      <span className="flex items-center gap-1 text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>
        {/*
          * Pin it without opening it.
          *
          * Reported as "how do I pin from here?" — the answer was that you
          * could not: the toggle lived inside the pull request, so putting one
          * on the bar meant taking the trip the bar exists to save.
          *
          * Revealed on hover and held open once pinned, like the × on the chips
          * it feeds, so a list of sixteen rows is not a list of sixteen stars.
          * `stopPropagation`, or the click also opens the row it sits in.
          */}
        {onTogglePin && (
          <button
            onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
            title={pinned ? `Unpin #${p.number}` : `Pin #${p.number} to the bar at the top`}
            aria-label={pinned ? `Unpin #${p.number}` : `Pin #${p.number}`}
            /* Sized here, not inherited. This sat inside a 10.5px row of
               tabular numbers and took its size from them — a control that is
               only a glyph has no words to be read at, so it has to carry its
               own size and its own target rather than borrowing the type scale
               of whatever it was dropped into. */
            className={`shrink-0 leading-none grid place-items-center rounded ${pinned ? "" : "opacity-0 group-hover/prrow:opacity-100 focus:opacity-100"}`}
            style={{
              color: pinned ? "var(--primary-hover)" : "var(--text3)",
              fontSize: 15, width: 22, height: 22,
            }}>
            {pinned ? "★" : "☆"}
          </button>
        )}
        <span title={st.title} style={{ color: st.tint }}>⇅</span>#{p.number}
      </span>

      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-[12px]" style={{ color: "var(--text)" }}>{p.title}</span>
          {/* Before the "here" chip and before the labels: this is the only
              thing on the row that can be true of a pull request nobody has
              touched all week, and the row's second line is where facts about
              the pull request live. */}
          {unread && <UnreadBadge u={unread} />}
          {p.isCurrentBranch && <Chip text="here" tint="var(--primary)" title="This checkout is on that branch" />}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-[10px]" style={{ color: "var(--text3)" }}>
          <span className="truncate shrink-0" style={{ maxWidth: 140 }}>{p.author}</span>
          {/* Why this row is in the answer. Assignees and requested reviewers
              both — on a board they are one question, "where is this person",
              and which hat they wear on a given pull request is not what was
              being asked. */}
          {peopleMatched(p, q ?? "").slice(0, 3).map((login) => (
            <span key={login} className="shrink-0 flex items-center gap-1 rounded px-1"
              title={`${login} is on this pull request`}
              style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 16%, transparent)" }}>
              <Avatar login={login} size={ICON.xs} />
              <span className="truncate" style={{ maxWidth: 110 }}>{login}</span>
            </span>
          ))}
          {/*
            * Where it lands.
            *
            * Asked for, and the interesting case is the one that is easy to
            * miss: most of these go to the trunk, and a stacked one goes to
            * another feature branch. Reading the list, those look identical —
            * and merging a stack thinking it lands on the trunk is a mistake
            * you make once and remember.
            *
            * So the base is always shown, because that is what was asked for,
            * and the one that is NOT the trunk is tinted rather than dimmed.
            * The arrow is there so it reads as a destination and not as one
            * more label.
            */}
          <span className="truncate shrink-0 flex items-center gap-0.5" style={{ maxWidth: 190 }}
            title={`Merges into ${p.baseRefName}`}>
            <span style={{ color: "var(--text4)" }}>→</span>
            <span style={isTrunk(p.baseRefName)
              ? { color: "var(--text3)" }
              : { color: "var(--warning)" }}>{p.baseRefName}</span>
          </span>
          {/* Beside the branch it is about, and set in the row's own dim tone
              rather than a colour: this is a fact about the pull request, not a
              verdict on it, and a board where the expensive ones glow red would
              be answering a question nobody asked while reviewing. Tabular
              figures so a column of them lines up on the decimal point. */}
          {spend && (
            <span className="shrink-0 tabular-nums" title={spend.title}
              style={{ color: "var(--text3)" }}>{spend.text}</span>
          )}
          {p.isDraft ? <Chip text="draft" tint="var(--text3)" /> : <ReviewChip v={p.humanReview} />}
          {shownLabels.map((l) => <Chip key={l.name} text={l.name} tint={l.color ? `#${l.color}` : "var(--primary)"} />)}
          {p.labels.length > shownLabels.length && (
            <span className="tabular-nums shrink-0" title={p.labels.map((l) => l.name).join(", ")}>+{p.labels.length - shownLabels.length}</span>
          )}
        </div>
      </div>

      <ReviewerStack p={p} />
      <ChecksCell p={p} />
      <span className="text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>{ago(p.updatedAt)}</span>

      {/* The row's one action, and the panel's whole reason to exist: hand the
          pull request to the chat rather than to a browser tab. It stops the
          click from also opening the row, which would bury the chat it just
          opened under a detail page nobody asked for. */}
      <button onClick={(e) => { e.stopPropagation(); onReview(); }}
        className="agx-btn text-[10px] px-2 py-1 rounded justify-self-end whitespace-nowrap"
        title="Hand this pull request to the chat for a local review"
        style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text2)" }}>
        Review →
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

export function PrView({ active, onOpenChatWith, onReviewInTerminal, jumpTo }: {
  active: boolean;
  /** An errand another panel sent us on — see lib/openPrs.ts. */
  jumpTo?: import("../lib/openPrs.ts").PrJump | null;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
  /** Hand the review to the user's own tmux instead of to the chat. */
  onReviewInTerminal?: (root: string, number: number, recipe?: string, card?: string) => void;
}) {
  const { ask, askText, dialog } = useDialogs();
  const { askMerge, dialog: mergeDialog } = useMergeDialog();
  // The same test the card chip uses: a ClickUp move is only offered for a
  // reference that is actually ClickUp's. A Jira shop's `ABC-12-thing` branch
  // looks identical, and offering to move a card that does not exist is worse
  // than offering nothing.
  const clickup = useClickupSetup();

  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState("");
  const [repo, setRepo] = useState<PrRepoId | null>(null);
  /** The panel opens on what is waiting on you, not on what you wrote — that
   *  is the question a review dashboard exists to answer. If nothing is waiting
   *  the first load falls through to your own pull requests once, so opening it
   *  never lands on an empty pane. */
  const [filter, setFilter] = useState<Filter>("review");
  const [stateSel, setStateSel] = useState<StateSel>("open");
  /** Cursors we have walked through. `[]` is page 1; each Next pushes the
   *  cursor that fetched the page we are about to show, so Previous is a pop.
   *  GitHub's cursors are opaque and only move forward, so a stack is the only
   *  way back. */
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages[pages.length - 1];
  const fellBack = useRef(false);
  // The filter query for the current scope tab — the single source of truth for
  // both the search box and every facet dropdown (parsed in lib/prFilter.ts).
  // Cleared when the scope changes so each tab (mine / review / all) starts
  // fresh; "all" can be hundreds of rows and a facet beats scrolling.
  const [query, setQuery] = useState("");
  /*
   * Everything in this scope, collected page by page so a text filter can see
   * past the page on screen.
   *
   * Started only when there is free text to match: an idle panel must not walk
   * four requests nobody asked for, and a scope tab is normally read one page
   * at a time on purpose.
   *
   * Capped, and the cap is the honest part. "Mine" is ninety-three rows and
   * sweeps in four calls; "All" is fifteen thousand and would be forty minutes
   * of pagination for a search GitHub can do server-side in one. Past the cap
   * the sweep stops and says how far it got, so a partial answer never poses as
   * a complete one — the box's own "press ⏎ to search them all" is the way out.
   */
  const [sweep, setSweep] = useState<{ key: string; rows: PrSummary[]; done: boolean } | null>(null);
  const sweepKey = `${root}|${filter}|${stateSel}`;
  /*
   * Somebody sent us here looking for one particular pull request.
   *
   * Two things have to be true at once and the first attempt only managed one.
   *
   * It has to FIND the thing: this view opens on "needs my review", falls back
   * to "mine", and defaults to open — so a colleague's merged pull request was
   * filtered out before the search could match it, and the panel said "no open
   * pull requests of yours", which is a true sentence about a question nobody
   * asked. So the arrival widens both to `all`.
   *
   * And it must not COST anything: widening them is a change to how this view
   * is set up, and the first version left it that way. Coming back later, the
   * counts read 111 and 16199 instead of 18 and 389 — somebody's working view,
   * quietly replaced by the side effect of looking up one card. So what was
   * there is remembered and put back the moment the search is cleared.
   */
  const beforeJump = useRef<{ filter: Filter; state: StateSel } | null>(null);
  /**
   * The errand this view has already run.
   *
   * `active` is in the dependencies so a request made while the view is hidden
   * is served when it comes forward — which is right, and was also the bug:
   * the slot in App is never emptied, so EVERY return to this view re-ran the
   * last errand. Leave the pull request you were reading, look at the terminal,
   * come back, and the search box had refilled itself with a question you asked
   * once an hour ago and the pull request you were on was gone. An errand is
   * served once; a NEW one has a new `n` and still arrives.
   */
  const servedJump = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !jumpTo) return;
    if (servedJump.current === jumpTo.n) return;
    servedJump.current = jumpTo.n;
    if (!beforeJump.current) beforeJump.current = { filter, state: stateSel };
    setQuery(jumpTo.query);
    setFilter("all");
    // Only as wide as the errand needs. `all` is every pull request the
    // repository has ever had — 16,199 against 389 open on a real one — and it
    // is asked for only when the thing being looked for is already closed,
    // which the sender knows and says.
    setStateSel(jumpTo.scope === "all" ? "all" : "open");
    fellBack.current = true; // and do not let the empty-list fallback move us
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, jumpTo?.n]);

  // Clearing the search is the signal that the errand is over.
  useEffect(() => {
    if (query || !beforeJump.current) return;
    const was = beforeJump.current;
    beforeJump.current = null;
    setFilter(was.filter);
    setStateSel(was.state);
  }, [query]);
  /*
   * Two searches, and only one of them is automatic.
   *
   * The query filters the rows already loaded LIVE and client-side
   * (visiblePrs), so typing narrows what is on screen instantly and for free.
   *
   * The SERVER copy re-runs `gh` across the pages the client does not hold, and
   * it is now asked for EXPLICITLY — Enter, or the button beside the box. It
   * used to fire on a 400ms debounce, which is fine if you type in bursts and
   * wrong if you do not: typing slowly meant a GitHub search per word, each one
   * blanking the list mid-sentence and racing the next. A debounce is a guess
   * about how fast somebody types, and this one guessed wrong about the maintainer.
   *
   * Clearing the box is the exception, and deliberately so: an empty query is
   * not a search, it is the end of one, and making somebody press Enter to get
   * their list back would be a chore with nothing behind it.
   */
  const [serverQuery, setServerQuery] = useState("");
  useEffect(() => { if (!query.trim() && serverQuery) setServerQuery(""); }, [query, serverQuery]);
  const runSearch = useCallback(() => setServerQuery(query), [query]);
  // A new server search is a new list — start it at page one, never continuing a
  // cursor that belonged to the previous query.
  useEffect(() => { setPages([]); }, [serverQuery]);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [listState, setListState] = useState<{ fetchedAt: number; loading: boolean; checksPending?: boolean; error?: string; needsAuth?: boolean; total?: number; hasNext?: boolean; cursor?: string | null; pageSize?: number }>({ fetchedAt: 0, loading: false });
  // Two different things, which the panel used to conflate. `selected` is the
  // pull request you are *in* — the list gives way to it, as a page.
  // `rowCursor` is only where the keyboard is in the list, so j/k can walk the
  // rows without opening (and fetching) every one it passes over. Named apart
  // from the pagination `cursor` above, which is a GitHub page token.
  const [selected, setSelected] = useState<number | null>(null);
  /* Read from callbacks that must not re-create themselves every time the
     selection changes — and declared HERE, above every one of them, because a
     `const` referenced before its line is a temporal dead zone waiting for the
     day somebody calls one of those during render. */
  const selectedRef = useRef<number | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const [rowCursor, setRowCursor] = useState<number | null>(null);
  /** Whether the pull request's masthead has given its metadata back to the
   *  page. Reset whenever another pull request is opened, or the second one
   *  would open already collapsed with its scroll at the top. */
  /*
   * The facts strip does not fold away any more.
   *
   * It used to collapse once you scrolled — author, branch, reviewers, checks —
   * to buy back a fifth of the window while reading a diff. Two things were
   * wrong with it. Files never did it (that tab does not scroll the page), so
   * one tab kept the strip and the rest lost it, which he reported as an
   * inconsistency. And it changed the HEIGHT of the scroller while you were
   * scrolling it, which is what made "put me back where I was" a race nobody
   * could win — three attempts at remembering a scroll position lost to this.
   *
   * The strip stays. It costs a row; a panel that moves under you costs more.
   */
  const condensed = false;
  /** A file being read whole, over the panel. Null when nothing is open. */
  const [peek, setPeek] = useState<Peek | null>(null);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  /** Showing what was held while the real answer is on its way. Only true when
   *  there was something to show — a cold open has nothing to be stale about. */
  const [detailStale, setDetailStale] = useState(false);
  /**
   * How far behind its base the open pull request's branch is.
   *
   * Asked after the detail is on screen rather than with it: the compare costs
   * about 600ms and nothing on the page is waiting on the answer — the button
   * it decides is an offer, and an offer may arrive a beat late. Null while the
   * question is out, and again for every pull request, because it is a fact
   * about one branch at one moment.
   */
  const [behind, setBehind] = useState<number | null>(null);
  /** The answer is not in yet, which is a different thing from "not behind".
   *  Without it the Update-branch button simply appears a second late, which is
   *  the jump he reported — see the placeholder in Overview. */
  const [behindAsking, setBehindAsking] = useState(false);
  /** And what that branch looks like on THIS machine, which is the half the
   *  Update button never mentioned. Same call, no extra round trip. */
  const [localHead, setLocalHead] = useState<PrLocalHead | null>(null);
  /** Which files would conflict, asked of git rather than of GitHub — GitHub
   *  says THAT a pull request conflicts and never says where. Null until
   *  answered, and only asked for when there is a conflict to explain. */
  const [conflictFiles, setConflictFiles] = useState<{ files: string[]; stale: boolean; resolvedLocally?: { branch: string; ahead: number } } | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  /*
   * The fold has exactly one control — the tab body's scroll — and the Files
   * tab is no longer that scroller. So arriving at Files already folded left
   * the masthead's nine cells hidden with no way to bring them back, including
   * the two facts you open a pull request for. Unfolded on the way in: Files
   * has three columns that scroll on their own, so the room the fold was buying
   * is room it no longer needs to buy.
   */

  /** The description editor has taken the whole column. Lifted out of
   *  <Description> so the shell can hide the masthead, tabs and sidebar behind
   *  it — editing a body is a mode, not a box wedged into the read view. */
  const [editingBody, setEditingBody] = useState(false);
  /** Open a pull request as a page. Back returns to the list, cursor intact. */
  const openPr = useCallback((n: number) => { setRowCursor(n); setSelected(n); setTab("overview"); setEditingBody(false); }, []);
  const backToList = useCallback(() => { setSelected(null); setDetailErr(""); setEditingBody(false); }, []);

  /* Only this repository's: the panel shows one at a time, so a chip opening
     something the list cannot show would be a dead end. */
  /* The third argument is the server snapshot, and without it this component
     cannot be rendered outside a browser at all — React throws before drawing
     anything. That is why no test had ever executed the panel, and why an audit
     could make it return null with the suite still green. `pins` reads a module
     variable, so it is the same answer on both sides. */
  const allPins = useSyncExternalStore(subscribePins, pins, pins);
  const pinned = useMemo(
    () => (repo ? allPins.filter((p) => p.repo === repo.nameWithOwner) : []),
    [allPins, repo]);

  /*
   * What the checks are doing on each pinned pull request.
   *
   * Read out of the list this panel already polls rather than fetched per chip:
   * the bar is a glance, and six requests behind a glance is six requests
   * nobody asked for. A pin whose pull request is not in the current filter —
   * pinned from "mine", looking at "review" — has no state to show and shows
   * none, which is honest and quiet.
   */
  const pinState = useMemo(() => {
    const by = new Map<number, PrSummary>();
    for (const p of prs) by.set(p.number, p);
    return by;
  }, [prs]);

  /**
   * "Open this pull request", asked from somewhere that cannot reach this panel.
   *
   * The notification list in the top bar can be open over any view, and this
   * panel may not be mounted when a row is clicked — so the request is left in a
   * slot and picked up here, the same shape the issues panel uses to start a
   * terminal it cannot reach. Cleared on service, not on arrival, so one made
   * while this was still mounting is not dropped on the way in.
   *
   * The repo is checked rather than assumed. A number alone is not an identity:
   * `#1175` names a different pull request in every repository, and opening the
   * one with that number in whichever repo happens to be selected would be a
   * confident wrong answer. Mismatched, the request waits for the repo it named
   * — switching to it serves the request rather than losing it.
   */
  const jump = useSyncExternalStore(subscribePrJump, prJump, () => null);
  useEffect(() => {
    if (!jump || !repo) return;
    if (jump.repo !== repo.nameWithOwner) {
      /*
       * A request this panel cannot serve, and it must not be left lying there.
       *
       * The panel binds to one repository and picks it once, from `repos[0]`.
       * In a workspace with two, pressing the branch chip in Source control on
       * the SECOND one sent a jump addressed to a repository this panel is not
       * showing: the guard returned, the request stayed in the module slot, and
       * nothing opened — no row, no message, no search. Worse, it stayed
       * pending and would open that pull request later, whenever a panel
       * happened to be bound to the right repository.
       *
       * So it is cleared and answered with the thing that always works: a
       * search for the number. Less than opening it, and visibly something.
       */
      clearPrJump();
      setQuery(String(jump.number));
      setSelected(null);
      flash(false, `#${jump.number} is in ${jump.repo}, and this panel is showing ${repo.nameWithOwner} — searching instead`);
      return;
    }
    clearPrJump();
    /* "Take me to where I was named."
       The inbox knows THAT you were mentioned and nothing about where, so a
       mention notification used to land at the top of a conversation with forty
       entries in it. Remembered here and served below, once the pull request
       this is about has actually loaded. */
    if (jump.mention) wantMention.current = { number: jump.number, n: jump.n };
    openPr(jump.number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, repo, openPr]);

  const [busy, setBusy] = useState(false);
  /** The label passed to `act` for the request in flight — see Btn `pending`. */
  const [busyWhat, setBusyWhat] = useState("");
  /* One scroller serves every tab, so each tab's place in it is remembered here
     and put back on the way in. Cleared when the pull request changes: a new
     page starts at the top, whatever the last one was showing. */
  /** The board card whose action is running — the board disables all of them
   *  while one does, and the spinner belongs to the one you pressed. */
  const [actingOn, setActingOn] = useState<number | null>(null);
  const tabBodyRef = useRef<HTMLDivElement>(null);
  const tabScroll = useRef<Record<string, number>>({});
  useEffect(() => { tabScroll.current = {}; }, [selected]);
  /* Before paint, or the old offset is on screen for a frame and the jump is
     the thing you see instead of the thing you asked for. */
  useLayoutEffect(() => {
    const el = tabBodyRef.current;
    if (!el) return;
    const want = tabScroll.current[tab] ?? 0;
    el.scrollTop = want;
    if (!want) return;
    /*
     * And again, once the tab has its height.
     *
     * A tab's content mounts empty and fills — the diffs highlight, the
     * markdown lays out — so the first assignment is clamped to whatever the
     * box was tall at that instant, which for Commits is nothing. Reported as
     * the scroll resetting when you came back to it. Two frames and a
     * ResizeObserver: the frames cover the ordinary case, the observer the one
     * where the content arrives later than that.
     */
    let alive = true;
    /* The first attempt observed the SCROLLER, whose own box never changes —
       what grows is its content, so the observer never fired and the retry was
       decoration. This watches `scrollHeight` instead, which is the number that
       decides whether the offset can be honoured at all, and keeps trying while
       it is still growing. */
    let tall = el.scrollHeight;
    const started = Date.now();
    const put = () => {
      if (!alive) return;
      const now = el.scrollHeight;
      const grew = now !== tall;
      tall = now;
      if (Math.abs(el.scrollTop - want) > 1 && el.scrollTop < want) el.scrollTop = want;
      /* Stop as soon as it lands, or when the content has been still for a
         while — two seconds is the ceiling, not the plan. */
      if ((Math.abs(el.scrollTop - want) <= 1 && !grew) || Date.now() - started > 8_000) return;
      requestAnimationFrame(put);
    };
    requestAnimationFrame(put);
    /* Eight seconds is a long time to keep pushing a scroller around, so any
       sign of the reader touching it ends the attempt at once. Restoring a
       position on top of somebody who has started reading is worse than not
       restoring it. */
    const stop = () => { alive = false; };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchstart", stop, { passive: true });
    el.addEventListener("keydown", stop);
    return () => {
      alive = false;
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("keydown", stop);
    };
  }, [tab, selected]);
  /** What the merge control is doing right now, "" when it is doing nothing.
   *  A sentence rather than a boolean because the merge is two writes and they
   *  fail differently — see doMerge. */
  const [mergeWork, setMergeWork] = useState("");
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  // Automation comments render in full by default now that they render as
  // markdown rather than as their own source: the fold stays folded, so a 40 KB
  // coverage report is a badge and a summary line until you open it, which is
  // what the digest was protecting against in the first place. The digest is
  // still a click away for a timeline of nothing but CI.
  const [rawBots, setRawBots] = useState(true);
  /* Which voices the Conversation is showing. Up here because the rail's jump
     has to clear it before scrolling — see onGoToMention. */
  const [convWho, setConvWho] = useState<ConvWho>("all");
  const [seen, setSeen] = useState<Record<string, string[]>>(() => loadMap<string[]>(SEEN_KEY));
  const [drafts, setDrafts] = useState<Record<string, DraftComment[]>>(() => loadMap<DraftComment[]>(DRAFT_KEY));
  const [reviews, setReviews] = useState<Record<string, ReviewDraft>>(() => loadMap<ReviewDraft>(REVIEW_KEY));
  const [methods, setMethods] = useState<Record<string, MergeMethod>>(() => loadMap<MergeMethod>(METHOD_KEY));
  const [diff, setDiff] = useState("");
  /** Why there is no diff, when there is a reason. Empty while one is on its
   *  way — the two states used to be the same empty string. */
  const [diffErr, setDiffErr] = useState("");
  const [selFile, setSelFile] = useState<string | null>(null);
  /* What the Files tab is drawing right now, which in one-file mode is the
     first file the filter left when nothing has been clicked. The rail follows
     this rather than the selection, so the column beside a diff is never
     talking about a different file — or, as it was, about no file at all. */
  const [showingFile, setShowingFile] = useState<string | null>(null);
  const [selCommit, setSelCommit] = useState<string | null>(null);
  /* Which commit a reference sent us to, so the row can be scrolled to and
     said out loud. Separate from `selCommit`: that one is "which diff is
     open", and this is "which one you were sent to", which stops being true
     as soon as you look at another. */
  const [commitFocus, setCommitFocus] = useState<string | null>(null);
  /* Grouped once per commit list rather than once per render — see DAY_FMT. */
  const commitDays = useMemo(() => groupCommitsByDay(detail?.commits ?? []), [detail?.commits]);
  const focusedCommitRef = useRef<HTMLDivElement | null>(null);
  /* Scrolled to rather than merely tinted: on a branch of thirty commits the
     one you were sent to is usually below the fold, and a highlight you cannot
     see is the same as no highlight. */
  useEffect(() => {
    if (!commitFocus) return;
    focusedCommitRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [commitFocus, tab]);
  /* It stops being "where you were sent" the moment you open a different one. */
  useEffect(() => {
    if (commitFocus && selCommit && selCommit !== commitFocus) setCommitFocus(null);
  }, [selCommit, commitFocus]);
  // Which commits have their full message open. Separate from `selCommit`, so
  // reading the message costs nothing and does not fetch a diff.
  const [openMsgs, setOpenMsgs] = useState<Set<string>>(new Set());
  // The CI jobs behind this pull request's checks. Fetched only when the checks
  // tab is opened — it costs a couple of REST calls and most visits never look.
  const [jobs, setJobs] = useState<PrCheckJob[]>([]);
  // Fetched once per repo, cached server-side for five minutes: the composer
  // wants an instant dropdown, not a live directory.
  const [mentions, setMentions] = useState<Mentionables | null>(null);
  /* Which login this window is signed in as, asked once. The server answers from
     its own cache (see ghCapability), so this costs nothing per pull request — and
     until it lands, `@somebody` is drawn as a link with no "this is you" on it,
     which is the honest state rather than a guess. */
  const [viewer, setViewer] = useState<string | undefined>(undefined);

  /** A mention asked for and not yet served, by pull request. */
  const wantMention = useRef<{ number: number; n: number } | null>(null);
  useEffect(() => {
    const want = wantMention.current;
    if (!want || !detail || detail.number !== want.number) return;
    /* The login is what a mention is written with, so without it there is
       nothing to look for — and it arrives a moment after the panel does. */
    if (!viewer) return;
    wantMention.current = null;
    const hit = findMention(detail, viewer);
    if (!hit) { flash(false, `Nobody named @${viewer} in #${detail.number} — opened it anyway`); return; }
    // A line comment lives in Files; everything else in the conversation. The
    // "humans only" filter is cleared: a mention by a bot is still a mention.
    if (hit.where === "thread") setTab("files");
    else if (hit.where === "node") { setConvWho("all"); setTab("conversation"); }
    else setTab("overview");
    /* Two frames: one for the tab to render, one for its content to lay out.
       A single one scrolls to an element whose height is still zero. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const sel = selectorFor(hit);
      const el = (sel ? document.querySelector<HTMLElement>(sel) : document.querySelector<HTMLElement>("[data-pr-body]"));
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      flashElement(el);
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, viewer]);
  useEffect(() => {
    let live = true;
    api.prCapability().then((c) => { if (live && c?.login) setViewer(c.login); }).catch(() => { /* no highlight, then */ });
    return () => { live = false; };
  }, []);
  /** The repository's own labels, authors, milestones and branches. Derived
   *  from the loaded page before, which made the Author menu a list of whoever
   *  happened to be on page one. */
  const [facetOpts, setFacetOpts] = useState<RepoFacets | null>(null);
  useEffect(() => {
    if (!active || !root) return;
    let live = true;
    api.prFacets(root)
      .then((r) => { if (live && r.ok && r.data) setFacetOpts(r.data); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, root]);
  useEffect(() => {
    if (!active || !root) return;
    let live = true;
    api.prMentions(root)
      .then((r) => { if (live && r.ok && r.data) setMentions(r.data); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, root]);
  const toggleMsg = (oid: string) => setOpenMsgs((cur) => {
    const next = new Set(cur);
    if (next.has(oid)) next.delete(oid); else next.add(oid);
    return next;
  });
  const [commitText, setCommitText] = useState("");
  const [commitBusy, setCommitBusy] = useState(false);
  const [split, setSplit] = useState(diffSplit);
  const [wrap, setWrap] = useState(diffWrap);
  const detailReq = useRef(0);
  /** Which list request is current. A filter's answer takes seconds, and
   *  without this the slower reply from the filter you just left overwrites the
   *  one you switched to — the old selection reappearing under the new tab. */
  const listReq = useRef(0);
  /** Which whole-PR diff / commit diff is current. Same shape as listReq: the
   *  diff of a pull request (or commit) you have since left can take seconds to
   *  arrive, and without this its late reply overwrites the one you switched to. */
  const diffReq = useRef(0);
  /** The head commit the diff on screen was fetched for, and whether the next
   *  fetch must go past the server's cache. See the effect that compares them. */
  const diffHead = useRef("");
  const diffFresh = useRef(false);
  /*
   * "Ask again for what is in front of me", as a number.
   *
   * Refresh used to force the detail and the board lists and then EMPTY the
   * diff to make its effect run again — so the file you were reading went blank
   * for as long as GitHub took, which is the flicker he asked not to have. And
   * the pieces that live outside the detail (the review GitHub is holding for
   * you) were fetched once when the pull request opened and never again: a line
   * comment deleted in the browser stayed on this screen until you left the
   * pull request and came back.
   *
   * One counter fixes both. Everything that is per-pull-request re-asks when it
   * changes, and nothing is cleared first: what is on screen stays until the
   * new answer lands and replaces it.
   */
  const [detailTick, setDetailTick] = useState(0);
  /** Which (pull request, tick) the diff on screen was fetched for. Replaces
   *  "is `diff` empty?" as the has-it-been-fetched test, which is what forced
   *  the blanking. */
  const diffFetchedFor = useRef("");
  const commitReq = useRef(0);

  const flash = useCallback((ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => {
    if (!active) return;
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      setRoot((cur) => cur || repos[0]?.root || "");
    }).catch(() => {});
  }, [active]);

  /** How far a sweep will walk. Ten pages of the sizes GitHub returns is a few
   *  hundred rows — enough for every scoped tab, and a wall in front of "All". */
  const SWEEP_PAGES = 10;

  useEffect(() => {
    const text = parseQuery(query).text.trim();
    // No text, nothing to sweep for. The scope's own paging is unaffected.
    if (!root || !text) return;
    if (sweep?.key === sweepKey && sweep.done) return;
    let live = true;
    void (async () => {
      const rows: PrSummary[] = [];
      const seen = new Set<number>();
      let after: string | undefined;
      for (let page = 0; page < SWEEP_PAGES; page++) {
        /*
         * Wait for the page to SETTLE before deciding there is not another.
         *
         * This is what limited the sweep to twenty-five rows. The list endpoint
         * answers immediately from cache while it fetches — `loading: true`,
         * and in that state it reports `hasNext: false` and no cursor, because
         * it does not have them yet. The loop read that as the end of the view
         * and stopped on page one, so a filter over ninety-three rows searched
         * twenty-five and said "1 match" with complete confidence.
         *
         * Measured on a real view: the same request answers `hasNext: true`
         * with a cursor once it settles, about a second later.
         */
        let r = await api.prList(root, filter, stateSel, false, after).catch(() => null);
        for (let wait = 0; r?.loading && wait < 20; wait++) {
          await new Promise((res) => setTimeout(res, 400));
          if (!live) return;
          r = await api.prList(root, filter, stateSel, false, after).catch(() => null);
        }
        if (!live || !r) break;
        // Deduplicated on the number: a row can land on two pages when
        // something is opened or closed between the calls that fetch them.
        for (const pr of r.prs) if (!seen.has(pr.number)) { seen.add(pr.number); rows.push(pr); }
        // Published as it grows, so the list fills in rather than appearing
        // whole after four round trips.
        const done = !r.hasNext || !r.cursor || page === SWEEP_PAGES - 1;
        setSweep({ key: sweepKey, rows: [...rows], done });
        if (done) break;
        after = r.cursor!;
      }
    })();
    return () => { live = false; };
    // `sweep` is deliberately absent: it is what this writes, and depending on
    // it would restart the walk on its own first result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, filter, stateSel, sweepKey, query]);

  /** Collecting on a list the server said was not finished yet. Same shape as
   *  `staleTimer` on the detail pane: its refresh is already running, this
   *  picks up the result. Why, and why it backs off: lib/prSettle.ts. */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleDelay = useRef(SETTLE_MS);
  const loadListRef = useRef<((force?: boolean) => void) | null>(null);

  const loadList = useCallback((force = false) => {
    if (!root) return;
    const req = ++listReq.current;
    const want = filter;
    api.prList(root, filter, stateSel, force, cursor, serverQuery).then((r) => {
      if (req !== listReq.current) return; // a newer request already won
      setRepo(r.repo);
      // Same rule as the board: a refresh may add and correct, but it may not
      // un-know. Every fetch starts at the fast pass, so without this a list
      // that had its check states dropped back to "not in yet" on every poll.
      setPrs((cur) => keepLoadedChecks(cur, r.prs));
      setListState({ fetchedAt: r.fetchedAt, loading: r.loading, checksPending: r.checksPending, error: r.error, needsAuth: r.needsAuth, total: r.total, hasNext: r.hasNext, cursor: r.cursor ?? null, pageSize: r.pageSize });
      // The keyboard cursor, never the open pull request. This lands on every
      // poll and on every scope switch, and when the list was a column beside a
      // detail pane, falling back to `prs[0]` only decided which one the pane
      // previewed. Now that a pull request is a page, the same line meant
      // picking a view — or just waiting through a refresh — opened whatever
      // happened to be first. A row is opened when somebody opens it.
      setRowCursor((cur) => (cur && r.prs.some((p) => p.number === cur) ? cur : null));
      const settle = settleAfter(r, settleDelay.current);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = settle.wait == null
        ? null
        : setTimeout(() => { loadListRef.current?.(); }, settle.wait);
      settleDelay.current = settle.next;
      // Nothing waiting on you: show your own instead of an empty pane. Once
      // only, so choosing "Needs my review" yourself is never overruled.
      /* …and never out from under an open pull request. Even with the
         selection now surviving a scope change, a filter that changes itself
         while you are reading is a pane rearranging behind your back. */
      if (want === "review" && stateSel === "open" && r.prs.length === 0 && !r.loading && !r.error
        && !fellBack.current && selectedRef.current == null) {
        fellBack.current = true;
        setFilter("mine");
      }
    }).catch((e) => {
      if (req !== listReq.current) return;
      setListState({ fetchedAt: 0, loading: false, error: String(e) });
    });
  }, [root, filter, stateSel, cursor, serverQuery]);
  loadListRef.current = loadList;

  /**
   * Switching filter empties the pane before anything is fetched.
   *
   * Otherwise the previous filter's selection stays on screen for the second or
   * two the new list takes, and you are reading one pull request under a tab
   * that says you are looking at another.
   */
  const lastScope = useRef<string>("");
  useEffect(() => {
    const scope = `${root}\u0000${filter}\u0000${stateSel}`;
    if (lastScope.current === scope) return; // re-render, not a switch
    /*
     * The panel finishing its own boot is not you switching repository.
     *
     * `root` is empty for the first second — the repository list is a separate
     * call — so the scope changes once from "\u0000open\u0000…" to the real
     * one, and this effect took that for a switch and cleared the selection.
     * Open a pull request inside that second and it threw you back to the
     * board, which is exactly how it was reported: "I open a PR quickly and it
     * sends me back to the board".
     */
    const prev = lastScope.current;
    const first = prev === "" || prev.startsWith("\u0000");
    const sameRepo = prev.slice(0, prev.indexOf("\u0000")) === root;
    lastScope.current = scope;
    if (first) return; // nothing on screen yet to clear
    listReq.current++;
    // Back to page one: a cursor belongs to the search it came from, and
    // carrying it into a different scope asks GitHub to continue a list that no
    // longer exists. The counts go too — they are per-state, and leaving them
    // up is how every pill read 0 after switching to Closed.
    setPages([]);
    setViewCounts({});
    // The rows STAY on screen while the new ones are fetched.
    //
    // Blanking them meant every switch showed a skeleton for as long as GitHub
    // took — about a second and a half, and the round trip is the floor, not
    // something a faster query removes. Keeping the previous list up (dimmed,
    // and labelled as loading) is what GitHub does, and it turns that second and
    // a half from a wait into a redraw. `listReq` still guards the answer, so a
    // slow reply for the scope you left can never land on the one you are in.
    /*
     * The open pull request survives a change of scope in the same repository.
     *
     * A filter is a question about the LIST. The page you are reading is not
     * the list, and closing it because the rows behind it changed is the same
     * mistake the row cursor already avoids two comments up. It also happens on
     * its own: the panel falls back from "Needs my review" to "Mine" when the
     * first comes back empty, so opening a pull request in the first seconds
     * threw you straight back to the board — reported twice, and the second
     * time after the boot guard above had already fixed a different half of it.
     *
     * A different REPOSITORY is another matter: that pull request is not in it.
     */
    if (!sameRepo) {
      setSelected(null);
      setDetail(null);
      setBehind(null);
      setDetailErr("");
    }
    setListState((st) => ({ ...st, loading: true }));
  }, [filter, root, stateSel]);

  // Polling pauses while the view is hidden — no point spending requests on a
  // pane nobody is looking at — and resumes on return. Resuming refreshes; it
  // does not reset.

  /**
   * Warm the states you are not looking at.
   *
   * Each state is its own cache entry on the server, so the first visit to
   * Closed or All paid the whole fetch — about a second and a half of GitHub —
   * while the user watched. Touching them once in the background makes the
   * switch instant. Staggered, because the point is to spend idle time, not to
   * queue three searches behind the one being waited on.
   */
  useEffect(() => {
    if (!active || !root || listState.loading) return;
    const others = (["open", "closed", "all"] as StateSel[]).filter((st) => st !== stateSel);
    const timers = others.map((st, i) => setTimeout(() => {
      void api.prList(root, filter, st, false).catch(() => {});
      void api.prCounts(root, st).catch(() => {});
    }, 1500 + i * 2000));
    return () => timers.forEach(clearTimeout);
  }, [active, root, filter, stateSel, listState.loading]);

  /**
   * Fetch the next page before it is asked for.
   *
   * Each page is its own entry in the server's cache, so touching it once means
   * Next answers from memory instead of waiting on GitHub. Deliberately after a
   * beat, and never while the current page is still loading: the point is to
   * spend the idle time, not to compete for it.
   */
  useEffect(() => {
    if (!active || !root || !listState.hasNext || !listState.cursor || listState.loading) return;
    const next = listState.cursor;
    const t = setTimeout(() => { void api.prList(root, filter, stateSel, false, next).catch(() => {}); }, 900);
    return () => clearTimeout(t);
  }, [active, root, filter, stateSel, listState.hasNext, listState.cursor, listState.loading]);

  /**
   * Warm the filters you are not looking at.
   *
   * Each is its own cache entry on the server, so the first visit to a tab
   * always paid the whole fetch. Touching them once fills the counts and leaves
   * a warm cache to switch into. Staggered, because the server has one thread
   * and three `gh` calls at once is the stall this panel exists to avoid.
   */
  useEffect(() => {
    if (!active || !root) return;
    let live = true;
    // One request for all five numbers, and they are the TRUE totals for the
    // current state — not a tally of the page on screen, which stopped being
    // the answer the moment the list got pages, and not a stale figure carried
    // over from a different state.
    api.prCounts(root, stateSel)
      .then((r) => { if (live && r.ok && r.counts) setViewCounts(r.counts as unknown as Record<string, number>); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, root, stateSel, listState.fetchedAt]);

  /*
   * A wait with a deadline.
   *
   * `gh` is given 25 seconds server-side; the pane was given none, so a request
   * that never came back was a skeleton for ever — the same failure the diff
   * had, in another pane. Past the deadline it becomes a message with a retry,
   * which is something somebody can act on.
   */
  useEffect(() => {
    if (detail || detailErr || selected == null || !root) return;
    const t = setTimeout(
      () => setDetailErr("This is taking longer than usual — GitHub or `gh` has not answered."),
      30_000,
    );
    return () => clearTimeout(t);
  }, [detail, detailErr, selected, root]);

  /** Self-reference, so the stale follow-up can call the loader it lives in
   *  without either one having to be declared before the other. */
  const loadDetailRef = useRef<((n: number, force?: boolean) => void) | null>(null);
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadDetail = useCallback((n: number, force = false) => {
    const req = ++detailReq.current;
    if (staleTimer.current) clearTimeout(staleTimer.current);
    setDetailErr("");
    api.prDetail(root, n, force).then((r) => {
      if (req !== detailReq.current) return; // a later selection already won
      if (r.ok && r.detail) {
        rememberDetail(root, n, r.detail); setDetail(r.detail); setDetailStale(false);
        /*
         * The server handed back what it had rather than making us wait, and
         * said so. That is what makes a restart open on the pull request you
         * were reading instead of on a spinner — but a merge state minutes old
         * is not something to sit on until the twenty-second poll comes round.
         * Its refresh is already running; this collects the result.
         */
        if (r.stale) {
          const again = setTimeout(() => { if (req === detailReq.current) loadDetailRef.current?.(n, true); }, 1_200);
          staleTimer.current = again;
        }
      }
      // A refresh that fails leaves what is on screen alone: the pull request
      // you are reading is better than an error where it used to be.
      else if (!force) setDetailErr(r.error || "");
      else { setDetail(null); setDetailErr(r.error || "Could not load this pull request"); }
    }).catch((e) => { if (req === detailReq.current) setDetailErr(String(e)); })
      .finally(() => { if (req === detailReq.current) setDetailStale(false); });
    /* How far behind its base that branch is comes from the shared store — see
       the effect below. It used to be asked for here, which meant the board
       could know a branch was 222 behind and the page you opened from that
       board went and asked again: seconds of nothing over an answer already in
       memory. */
    /* And, when there is one, WHICH files conflict. GitHub only ever says that
       a pull request is CONFLICTING; naming the files takes a merge, and this
       one happens entirely in git's object database — the checkout is never
       touched. Same request guard, and null on failure: no answer is better
       than the wrong file list. */
    setConflictFiles(null);
    api.prConflictFiles(root, n)
      .then((r) => { if (req === detailReq.current) setConflictFiles(r.ok ? { files: r.conflicts, stale: !!r.stale, resolvedLocally: r.resolvedLocally } : null); })
      .catch(() => { if (req === detailReq.current) setConflictFiles(null); });
  }, [root]);

  /*
   * Ask GitHub a second time when it says it does not know yet.
   *
   * `mergeable` is computed lazily: the first request starts the work and
   * answers UNKNOWN, and a request a moment later gets the result. Nothing here
   * asked again, so the panel sat on "GitHub has not finished working it out"
   * — with no Resolve conflicts button and no conflict in the lane — until the
   * next poll came round. Reported as the button taking an age to appear on a
   * pull request that was already conflicting.
   *
   * Once, not a loop, and only from UNKNOWN. If the second answer is still
   * UNKNOWN then GitHub is genuinely busy and the poll is the right pace;
   * retrying harder would be one request per render on the one field that
   * costs GitHub work to compute.
   */
  const askedAgain = useRef<number | null>(null);
  useEffect(() => {
    const n = detail?.number;
    if (!root || !n || detail?.mergeable !== "UNKNOWN" || askedAgain.current === n) return;
    askedAgain.current = n;
    const t = setTimeout(() => { void loadDetailRef.current?.(n); }, 1500);
    return () => clearTimeout(t);
  }, [root, detail?.number, detail?.mergeable]);
  loadDetailRef.current = loadDetail;

  useEffect(() => {
    if (!active || !root) return;
    loadList();
    const t = setInterval(() => {
      loadList();
      // Keep the open pull request current too. This reads the server's cache,
      // so it only reaches the network when that entry has actually aged out —
      // without it, a comment left while you are reading never appears until
      // you navigate away and back.
      const n = selectedRef.current;
      if (n != null) loadDetail(n);
    }, POLL_MS);
    return () => {
      clearInterval(t);
      // Leaving the view, or changing what is being listed, cancels the
      // collection: it would otherwise land against a scope nobody is looking
      // at any more, and its backoff would still be counting from the old one.
      if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
      settleDelay.current = SETTLE_MS;
    };
  }, [active, root, filter, loadList, loadDetail]);

  /**
   * Load a pull request when the SELECTION changes — never merely because the
   * view became visible again.
   *
   * This effect used to list `active`, so stepping away to the terminal and
   * coming back re-ran it: the open commit, the open file and the fetched diff
   * were all thrown away and the pane went back to "loading". You lost your
   * place for having looked somewhere else for a moment. The view stays mounted
   * the whole time — only its visibility changes — so there is nothing to
   * restore and nothing to reload.
   */
  const loadedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!root || selected == null) { setDetail(null); loadedFor.current = null; return; }
    if (loadedFor.current === selected) return; // same pull request, already here
    loadedFor.current = selected;
    // Clear the previous PR's detail so the pane shows "loading #N" instead of
    // the last PR's data while the new one is in flight. Without this a PR→PR
    // jump silently keeps the old content on screen and reads as a dead click.
    // (The poll-refresh path in loadDetail deliberately keeps the current detail
    // on a failed refresh; that path does not run this effect.)
    /*
     * Show the one you read before, at once, and correct it behind you.
     *
     * The pane used to blank on every open — including a pull request opened a
     * minute ago and unchanged since — and then wait about a second on `gh`.
     * The rows behind it never did that: the list has been served from a cache
     * and refreshed underneath since it was written. The detail simply never
     * got the same treatment.
     *
     * Stale-while-revalidate, the same shape the ClickUp boards use: anything
     * held is painted immediately whatever its age, the request still goes out,
     * and the answer replaces it when it lands. Only a pull request nobody has
     * opened yet gets the empty pane, because only then is there nothing to
     * show instead.
     */
    const held = heldDetail(root, selected);
    setDetail(held); setDetailStale(!!held); setDetailErr("");
    /* The one place emptying is right: this is a DIFFERENT pull request, and
       showing the last one's diff under this one's title would be a lie. */
    setDiff(""); setDiffErr(""); setSelFile(null); setSelCommit(null); setCommitText("");
    diffFetchedFor.current = "";
    loadDetail(selected);
  }, [root, selected, loadDetail]);

  /*
   * A diff that did not arrive is not a diff that is still arriving.
   *
   * A failure set the text to "" and stopped, and "" is also "not fetched yet"
   * — so the Files tab sat on "Loading the diff…" for ever. Reported on a
   * 275-file pull request where GitHub answers the whole-diff endpoint with
   * "HTTP 406: the diff exceeded the maximum number of lines (20000)": a hard
   * no, dressed as a wait, with no way to tell.
   *
   * The error is held so the pane can say what happened, and so this effect
   * does not re-ask on every render for something that will not come.
   */
  useEffect(() => {
    if ((tab !== "files" && tab !== "review") || !detail || !root) return;
    /* The has-it-been-fetched test. `detail` is a new object on every poll, so
       without this the effect would re-ask GitHub several times a minute; with
       it, exactly once per pull request until something asks again. */
    const key = `${detail.number}:${detailTick}`;
    if (diffFetchedFor.current === key) return;
    diffFetchedFor.current = key;
    const req = ++diffReq.current; // a later selection's diff must win over a slow earlier one
    const want = diffFresh.current; diffFresh.current = false;
    const head = headOfDetail(detail);
    api.prDiff(root, detail.number, want).then((r) => {
      if (req !== diffReq.current) return;
      /* The old text stays on screen until this line. A failed re-fetch leaves
         what you were reading alone — the same rule loadDetail follows. */
      if (r.ok) { diffHead.current = head; setDiff(r.text || ""); setDiffErr(r.text ? "" : "GitHub returned an empty diff for this pull request."); }
      else if (!diff) setDiffErr(r.error || "The diff could not be fetched.");
    }).catch((e) => { if (req === diffReq.current && !diff) setDiffErr(String(e)); });
  }, [tab, detail, diff, root, detailTick]);

  /*
   * A push replaces the diff. Nothing used to notice.
   *
   * The text above is fetched once per selected pull request — the effect
   * refuses to re-ask while `diff` holds anything — and the detail beside it is
   * re-read constantly: by the list poll, and by Refresh, which forces it. So
   * after somebody pushes to a pull request you have open, the file LIST is the
   * new one and the diff TEXT is the old one, and a file the push added has a
   * row, a `+42 −0`, and no hunks to draw. That renders as "No textual diff —
   * binary, renamed, or too large to show", which is three wrong answers: the
   * diff was fetched before that file existed. Measured on a pull request with
   * eight pushes in an afternoon; GitHub showed the file fine in the browser.
   *
   * Keyed on the head commit rather than on a timer: it is the thing that
   * actually changes when the diff does, and comparing it costs a string
   * compare per detail load. `diffFresh` then makes the refetch skip the
   * server's own five-minute cache — otherwise the answer to "the head moved"
   * is the same stale text that prompted the question.
   */
  useEffect(() => {
    const head = headOfDetail(detail);
    if (!head || !diffHead.current || head === diffHead.current) return;
    diffFresh.current = true;
    /* Ask again rather than empty it: the diff you are reading is the old one,
       but it is a diff, and a blank pane for the length of a fetch is worse
       than a paragraph that changes under you when the answer lands. */
    setDiffErr("");
    setDetailTick((n) => n + 1);
  }, [detail]);

  // Filter the current scope's rows by the search box: PR number (with or
  // without a leading #), title, or author login. Memoized so a 400-row "all"
  // list does not re-scan on every keystroke or re-render.
  // The query string is the single source of truth; the facet dropdowns are
  // editors of it (see lib/prFilter.ts). `filters` is a pure derivation, never
  // stored, so the bar and the menus can never disagree.
  const filters = useMemo(() => parseQuery(query), [query]);
  /*
   * What the filter runs over: the page on screen, or everything swept.
   *
   * The list is paged by GitHub's cursors, so the panel holds ONE page — and a
   * local filter over one page of four answers "no matches" about rows it has
   * never seen. When there is free text to match, the sweep below walks the
   * rest of the scope in the background and this widens to whatever it has
   * collected so far, growing as it lands.
   */
  const pool = useMemo(
    () => (filters.text.trim() && sweep?.key === sweepKey ? sweep.rows : prs),
    [prs, filters.text, sweep, sweepKey],
  );
  /*
   * Filtered HERE, not only on the server.
   *
   * This was `sortRows`, which is sort-only by its own doc comment — so the box
   * that says "Filter these" filtered nothing, and the only way to find a word
   * was to press Enter and wait on GitHub. Typing "migration" over ninety-three
   * rows did nothing at all until the round trip came back.
   *
   * `applyFilters` is the same predicate the facets already use and was sitting
   * unused. Memoised, so a four-hundred-row scope does not re-scan per
   * keystroke — the reason the sort-only version existed in the first place.
   */
  /*
   * The table's own "only the ones somebody has spoken on" — the board's toggle, in
   * the other surface.
   *
   * Client-side, and it has to be: GitHub cannot answer "since I last looked", because
   * that mark is a timestamp in this browser (see prNew.ts). So this narrows the rows
   * in hand rather than asking for a different set, and the chip says so.
   */
  /*
   * Every mark, not just this pull request's — the list draws a badge per row.
   *
   * The marks are localStorage, so nothing here re-renders when one moves.
   * Reading them once per render would be enough for the first paint and wrong
   * for every one after it: you open a pull request, read it, come back, and the
   * row still says two are waiting. See onSeenChange.
   */
  const [seenTick, bumpSeenTick] = useState(0);
  useEffect(() => onSeenChange(() => bumpSeenTick((n) => n + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seenMarks = useMemo(() => readSeen(), [seenTick]);

  const [unreadOnly, setUnreadOnly] = useState(false);
  const basePrs = useMemo(() => applyFilters(pool, filters), [pool, filters]);
  const unreadPrs = useMemo(
    () => basePrs.filter((p) => unreadOf(p, repo?.key, seenMarks)),
    [basePrs, repo?.key, seenMarks],
  );
  /* Turned off by itself when it would select nothing: a filter with no answers is a
     table that looks empty for a reason nobody can see. */
  useEffect(() => { if (unreadOnly && !unreadPrs.length) setUnreadOnly(false); }, [unreadOnly, unreadPrs.length]);
  const visiblePrs = unreadOnly ? unreadPrs : basePrs;
  const facets = useMemo(() => buildFacets(prs, filters, facetOpts), [prs, filters, facetOpts]);

  /** What each view last counted.
   *
   *  Only the scope currently loaded has rows to count, so a view on another
   *  scope can only report what it last saw — the same deal the panel already
   *  makes for the list itself, which shows its own age rather than pretending
   *  to be live. A view that has never been loaded shows no number at all,
   *  because a made-up one next to "Failing" is worse than none: you would act
   *  on it. */
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});
  /**
   * Only the server's totals. Nothing is counted from the rows on screen.
   *
   * A tally of the current page under a pill that filters the whole repository
   * is not a smaller truth, it is a wrong one — it read "Yoshiofthewire 2" when
   * he has three, because the third is on page four.
   */
  const viewCount = useCallback((v: (typeof VIEWS)[number]): number | null => {
    const exact = viewCounts[v.id];
    return typeof exact === "number" ? exact : null;
  }, [viewCounts]);

  const activeView = VIEWS.find((v) => v.scope === filter && v.query === query.trim());

  /*
   * The board is the way in, and it is remembered.
   *
   * Default on: it is the answer to "what do I do next", which is why the panel
   * is opened. Remembered because somebody who prefers the table should not have
   * to say so every morning.
   */
  const [boardOn, setBoardOn] = useState(() => {
    try { return localStorage.getItem("agentglass.pr.board") !== "0"; } catch { return true; }
  });
  /*
   * A search and the board are answering different questions, and only one of
   * them can be on screen.
   *
   * The board draws `boardMine`/`boardReview` — its own two fetches — and never
   * looks at `prs`, so with the board on, a search ran, counted, and changed
   * nothing: "Searching… 1 of 75", then "388 matches", over the same cards as
   * before. Reported as "on top of that it stops and shows me nothing", and it is exactly
   * right: the search DID finish, and nothing on screen was about it.
   *
   * So a query falls through to the table, which is the surface that can answer
   * it, and the board comes back the moment the box is empty. The board is a
   * standing arrangement rather than a mode you have to restore.
   */
  const searching = query.trim().length > 0;
  /*
   * The inbox is a third surface, not a filter.
   *
   * The board and the table both answer "what is the state of these pull
   * requests"; GitHub's notifications answer "what happened while I was away",
   * which is a different question and the only one that can be about a mention
   * in a comment or an issue that is not a pull request at all. So it replaces
   * the list rather than filtering it, and it wins over both — including over a
   * search, which belongs to the table.
   */
  const [inboxOn, setInboxOn] = useState(false);
  const [inboxUnread, setInboxUnread] = useState(0);
  const boardShown = boardOn && !searching && !inboxOn;
  const setBoard = useCallback((on: boolean) => {
    setBoardOn(on);
    try { localStorage.setItem("agentglass.pr.board", on ? "1" : "0"); } catch { /* private mode */ }
  }, []);

  /*
   * The two scopes the board is built from — and it costs no new request.
   * `viewCount` already warms `mine` and `review` to put numbers on the pills,
   * so these are reads of a cache that exists either way. See stakeFrom.
   */
  /*
   * Whether anything is connected that could resolve a work-item id.
   *
   * Today that means a ClickUp with boards; the question the board asks is the
   * general one — "is there a task provider" — so when a second one exists this
   * is where it is added, not in the card. A machine with none shows no chip at
   * all rather than a dead one: see taskLink.ts.
   *
   * Null while the answer is in flight, which is what stops a chip flashing on
   * and off on a machine that has none.
   *
   * `connected` rather than a count of boards: the built-in board is in that
   * list whether or not a token is, so counting it answered yes everywhere and
   * taskLink.ts's rule — hide a convention-shaped id when nothing can resolve
   * it — never once fired. See ClickUpSetup.
   */
  const taskSetup = useClickupSetup();
  const hasTaskProvider = taskSetup?.connected === true;

  const [boardMine, setBoardMine] = useState<PrSummary[]>([]);
  const [boardReview, setBoardReview] = useState<PrSummary[]>([]);
  /*
   * Neither list has answered yet.
   *
   * Two empty arrays are the initial state AND the "nothing wants anything from
   * you" state, so without this the board asserts the second for the second or
   * two before the first resolves — a claim, and the wrong one.
   */
  const [boardLoading, setBoardLoading] = useState(true);
  /*
   * The board asks again while the check rollups are still out.
   *
   * The two lists arrive in two passes — rows first, checks about four seconds
   * behind — and the board used to read whatever the first pass said and stop
   * there. So after a restart every card sat in the wrong lane until somebody
   * pressed Refresh, which was the only thing that asked again. Reported that
   * way.
   *
   * Counted, not endless: if the rollup never lands (a failed fetch, a rate
   * limit) this must go quiet rather than poll for ever behind a view whose
   * whole promise is that it costs two calls.
   */
  /*
   * Is the board whole?
   *
   * Which lane a pull request belongs in is mostly a question about its checks,
   * and those arrive in the second pass — so a board painted from the first one
   * files what it cannot decide under "yours, in flight" and moves it a few
   * seconds later. Reported as cards hopping between columns while you read.
   *
   * A card that moves on its own is worse than a card that is late, so the
   * skeleton stays up until every row is complete. With a deadline: a rollup
   * that never lands must not mean a board that never draws, and past it the
   * cards say for themselves that their checks are still out.
   */
  const boardWhole = !boardLoading
    && ![...boardMine, ...boardReview].some((p) => p.checksLoaded === false);
  const [boardWaited, setBoardWaited] = useState(false);
  const boardDrawn = useRef(false);
  useEffect(() => { if (boardWhole) boardDrawn.current = true; }, [boardWhole]);
  useEffect(() => {
    boardDrawn.current = false;
    setBoardWaited(false);
    const t = setTimeout(() => setBoardWaited(true), 6_000);
    return () => clearTimeout(t);
  }, [boardOn, root, stateSel]);
  /* Never on a REFRESH: `boardDrawn` means a whole board has been on screen
     once, and last minute's answer beats a skeleton. */
  const boardSettling = !boardWhole && !boardDrawn.current && !boardWaited;

  const [boardTick, setBoardTick] = useState(0);
  /** Set by Refresh, read once by the board's fetch. See the button. */
  const boardForce = useRef(false);
  const boardTries = useRef(0);
  useEffect(() => { boardTries.current = 0; }, [boardOn, root, stateSel]);
  useEffect(() => {
    if (!boardOn) return;
    const waiting = [...boardMine, ...boardReview].some((p) => p.checksLoaded === false);
    if (!waiting || boardTries.current >= 8) return;
    const t = setTimeout(() => { boardTries.current += 1; setBoardTick((n) => n + 1); }, 2_000);
    return () => clearTimeout(t);
  }, [boardOn, boardMine, boardReview]);
  useEffect(() => {
    if (!boardOn || !root) return;
    let live = true;
    setBoardLoading(true);
    /* Settled rather than all: one scope failing must not leave the board
       waiting for ever on the other. A failed list is an empty one, and the
       board then says so honestly instead of spinning. */
    /* Forced only when somebody asked for it. The poll reads the server's
       cache — that is what makes this board cost two calls — and Refresh is the
       one press that means "go and look again". */
    const force = boardForce.current;
    boardForce.current = false;
    void Promise.allSettled([
      api.prList(root, "mine", stateSel, force).then((r) => { if (live) setBoardMine((cur) => keepLoadedChecks(cur, r.prs ?? [])); }),
      api.prList(root, "review", stateSel, force).then((r) => { if (live) setBoardReview((cur) => keepLoadedChecks(cur, r.prs ?? [])); }),
    ]).then(() => { if (live) setBoardLoading(false); });
    return () => { live = false; };
  }, [boardOn, root, stateSel, listState.fetchedAt, boardTick]);

  /**
   * What the agents have spent in this repository, by branch — one request for
   * the whole board.
   *
   * Deliberately not per pull request. This is the heaviest panel in the app and
   * a row-sized question here would be a row-sized round trip; the server
   * answers with the repository's whole map (one SQL group-by plus one `git
   * worktree list`) and the rows look themselves up in it below.
   *
   * Tied to `listState.fetchedAt` so it refreshes on the same beat as the list
   * — including when Refresh is pressed — rather than running a clock of its
   * own. A failure leaves the map empty, and an empty map draws no chips: the
   * board is not worth degrading over a number beside the branch name.
   */
  const [spend, setSpend] = useState<RepoSpend | null>(null);
  useEffect(() => {
    if (!root) { setSpend(null); return; }
    let live = true;
    void api.prSpend(root).then((r) => { if (live) setSpend(r.ok ? r : null); }).catch(() => { if (live) setSpend(null); });
    return () => { live = false; };
  }, [root, listState.fetchedAt]);
  const spendByBranch = useMemo(() => {
    const m = new Map<string, BranchSpend>();
    for (const b of spend?.branches ?? []) m.set(b.branch, b);
    return m;
  }, [spend]);

  // If the cursor's row is filtered out, move it to the first row still visible
  // rather than leaving a phantom highlight on a hidden PR — the same
  // reconciliation loadList does when the list itself changes. Only when a
  // cursor existed; never auto-places one out of the empty initial state. The
  // *open* pull request is deliberately left alone: you asked for that page, and
  // a filter typed underneath it is no reason to close it.
  useEffect(() => {
    if (rowCursor != null && !visiblePrs.some((p) => p.number === rowCursor)) {
      setRowCursor(visiblePrs[0]?.number ?? null);
    }
  }, [visiblePrs, rowCursor]);

  useEffect(() => {
    if (tab !== "checks" || !detail || !root) return;
    let live = true;
    setJobs([]);
    api.prCheckJobs(root, detail.number)
      .then((r) => { if (live && r.ok && r.jobs) setJobs(r.jobs); })
      .catch(() => {});
    return () => { live = false; };
  }, [tab, detail?.number, root]);

  // Keyboard nav over the list, keyboard-first like the files tab (which relies
  // on the same thing: App.tsx ignores bare letters while the workspace is open,
  // so j/k/n/p are free here). Selection is derived, not a second state.
  const listRef = useRef<HTMLDivElement>(null);
  const stepSel = (d: number) => {
    if (!visiblePrs.length) return;
    const i = visiblePrs.findIndex((p) => p.number === rowCursor);
    const ni = i < 0 ? (d > 0 ? 0 : visiblePrs.length - 1) : (i + d + visiblePrs.length) % visiblePrs.length;
    const n = visiblePrs[ni].number;
    setRowCursor(n);
    // Walking past the bottom of the viewport with j should not mean losing the
    // row you are on.
    requestAnimationFrame(() => {
      document.querySelector(`[data-pr-row="${n}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };
  const onListKey = (e: React.KeyboardEvent) => {
    const inInput = /input|textarea/i.test((e.target as HTMLElement)?.tagName ?? "");
    if (e.key === "/" && !inInput) {
      e.preventDefault();
      (document.querySelector("[data-pr-filter-input]") as HTMLInputElement | null)?.focus();
      return;
    }
    if (inInput) { if (e.key === "Escape") (e.target as HTMLElement).blur(); return; }
    const k = e.key.toLowerCase();
    if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); stepSel(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); stepSel(-1); }
    // The list is a page now, so the keyboard needs a way in as well as a way
    // along: Enter opens the row the cursor is on.
    else if (e.key === "Enter" && rowCursor != null) { e.preventDefault(); e.stopPropagation(); openPr(rowCursor); }
    else if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); }
  };
  // Make the list keyboard-ready the moment the panel opens, but never steal
  // focus from a field the user is already in (only claim it off <body>).
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => { if (document.activeElement === document.body) listRef.current?.focus(); });
  }, [active]);

  /*
   * Ignoring whitespace, and where it happens.
   *
   * On the PARSED diff rather than on the request: the patch comes from GitHub
   * already made, so there is no `-w` to pass. A deletion and an addition whose text
   * differs only in blanks are the same line, and drawing them as one context line is
   * what the flag means — see diffNoWhitespace.ts, which also explains why only a
   * LEADING run of such pairs is folded.
   *
   * A preference rather than a per-visit toggle, because a repository that runs a
   * formatter is a repository where it is the right default every time.
   */
  const [noWs, setNoWs] = useState(diffNoWhitespace);
  /*
   * What has moved since your own last review.
   *
   * Held here rather than in the Files tab because two surfaces show it — the tab
   * filters by it and the Overview counts it — and two fetches of the same pair of
   * commits could answer differently for a second, which is a panel disagreeing with
   * itself about what you have read.
   *
   * Asked once per pair of commits: both ends are fixed, so the answer cannot change.
   * Local git answers it — see filesSince for why GitHub's compare endpoint is not the
   * source.
   */
  const since = useMemo(() => sinceRange(detail), [detail]);
  /** Bumped to ask the comparison again — after a fetch, the same two commits have a
   *  different answer, because one of them is finally in this clone. */
  const [sinceTick, setSinceTick] = useState(0);
  const [moved, setMoved] = useState<{ key: string; paths: Set<string>; missing?: boolean } | null>(null);
  useEffect(() => {
    if (!since || !root) { setMoved(null); return; }
    const k = `${since.from}..${since.to}`;
    let live = true;
    api.prFilesSince(root, since.from, since.to)
      .then((r) => { if (live) setMoved({ key: k, paths: new Set(r.paths ?? []), ...(r.missing ? { missing: true } : null) }); })
      .catch(() => { if (live) setMoved({ key: k, paths: new Set() }); });
    return () => { live = false; };
  }, [root, since, sinceTick]);
  /* Only the files this review actually contains. A trunk merge moves files that are
     not part of this pull request at all, and counting those would put a number on the
     chip that the list cannot show. */
  const movedHere = useMemo(
    () => (moved && !moved.missing && detail ? detail.files.filter((f) => moved.paths.has(f.path)).map((f) => f.path) : []),
    [moved, detail],
  );
  /** Bumped to send somebody to Files with the "since your review" filter already on. */
  const [wantSince, setWantSince] = useState(0);
  const parsedRaw = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const clean = useMemo(() => (noWs ? withoutWhitespace(parsedRaw) : null), [noWs, parsedRaw]);
  const parsed = clean?.files ?? parsedRaw;
  /** Files that hold NOTHING but whitespace changes, named for the Files tab: a file
   *  that vanishes from a review with no explanation is a reader wondering what else
   *  went missing. */
  const wsOnly = clean?.onlyWhitespace ?? [];
  const byPath = useMemo(() => {
    const m = new Map<string, FileChange>();
    parsed.forEach((f, i) => m.set(f.path, toFileChange(f, i)));
    return m;
  }, [parsed]);

  const openCommit = useCallback((sha: string) => {
    const req = ++commitReq.current; // invalidates any in-flight commit diff, whether opening another or closing
    if (!root || !sha) { setSelCommit(null); return; }
    setSelCommit(sha); setCommitText(""); setCommitBusy(true);
    api.prCommitDiff(root, sha)
      .then((r) => { if (req === commitReq.current) setCommitText(r.ok ? (r.text || "") : ""); })
      .catch(() => { if (req === commitReq.current) setCommitText(""); })
      .finally(() => { if (req === commitReq.current) setCommitBusy(false); });
  }, [root]);

  /*
   * A commit reference inside a comment, resolved against THIS pull request.
   *
   * Prefix match, because a reference is written short — `8c362cc` is seven
   * characters of a forty-character oid, and both the bot and GitHub write it
   * that way. Seven is enough to be unique on a branch and this only ever
   * searches one branch's commits.
   *
   * Returns false when it is somebody else's commit, and that false is the
   * feature: the panel holds one pull request's commits and has no diff for a
   * commit outside it, so that link keeps going to GitHub, which does.
   */
  const jumpToCommit = useCallback((sha: string): boolean => {
    const hit = detail?.commits.find((c) => c.oid.toLowerCase().startsWith(sha));
    if (!hit) return false;
    setTab("commits");
    openCommit(hit.oid);
    setCommitFocus(hit.oid);
    return true;
  }, [detail, openCommit]);

  const commitFiles = useMemo(() => parseUnifiedDiff(commitText).map(toFileChange), [commitText]);

  /*
   * "We just pushed to this branch, so CI is about to start."
   *
   * The rollup cannot know it: for the seconds between the push landing and
   * GitHub creating the first run, an empty list of checks is indistinguishable
   * from a green one — which is how "Update branch" led straight to "Ready to
   * merge · nothing is standing in the way" over a pull request GitHub was
   * already running three checks on.
   *
   * Held per pull request and with the moment it started, so it clears itself
   * rather than waiting for a state that may never come: a repository that runs
   * nothing on this branch would otherwise say "waiting" forever.
   */
  const [pushed, setPushed] = useState<{ number: number; at: number } | null>(null);
  const AWAIT_CHECKS_MS = 4 * 60_000;

  const act = useCallback(async (label: string, fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>) => {
    if (busy) return false;
    setBusy(true);
    /* WHICH one is running, not just that something is. Every one of these is a
       round trip through `gh`; a row of buttons all going grey says the app is
       busy and not which press it heard. */
    setBusyWhat(label);
    try {
      const r = await fn();
      flash(r.ok, r.ok ? (r.detail || `${label} — done`) : (r.error || `${label} failed`));
      // Refetch whether or not it worked. A failure is not proof that nothing
      // happened: `gh pr merge --delete-branch` exits non-zero when the merge
      // landed and only the branch deletion tripped, and this used to leave the
      // panel showing an open pull request that GitHub had already merged —
      // the one state where being stale actively misleads. Re-reading costs a
      // cached round trip; believing an error about what did not change costs
      // the next decision.
      loadList(true);
      if (selected != null) loadDetail(selected, true);
      return r.ok;
    } catch (e) { flash(false, String(e)); return false; }
    finally { setBusy(false); setBusyWhat(""); }
  }, [busy, flash, loadList, selected, loadDetail]);

  // One picker for the masthead's "＋" and the sidebar's ✎ both — lifted here
  // so it can open from the masthead on every tab, not only where the sidebar
  // renders.
  const fieldPicker = usePrFieldPicker(detail, root, act, flash);

  const key = repo && detail ? `${repo.key}#${detail.number}` : "";

  /*
   * When you last looked at this pull request — and why it is frozen.
   *
   * Read once, when the pull request opens, and held still for as long as it is
   * open. A mark that advanced as you read would erase the very markers it puts
   * up: you would open a conversation with three new replies on it, and by the
   * time the poll came round they would all be "old" without you having found
   * any of them.
   *
   * It moves in exactly two places: when you leave the pull request (you have
   * had your chance to read it) and when you press "Mark read" (you say so).
   */
  const [storedSeen, setStoredSeen] = useState(0);
  const seenKeyRef = useRef("");
  useEffect(() => {
    if (!key) { seenKeyRef.current = ""; setStoredSeen(0); return; }
    if (seenKeyRef.current === key) return;
    /* Leaving one pull request for another writes the mark for the one being
       left — the same thing the unmount below does, and the reason it is a ref:
       by the time this effect runs, `key` is already the new one. */
    const leaving = seenKeyRef.current;
    if (leaving) writeSeen(leaving, Date.now());
    seenKeyRef.current = key;
    setStoredSeen(readSeen()[key] ?? 0);
  }, [key]);
  useEffect(() => () => { if (seenKeyRef.current) writeSeen(seenKeyRef.current, Date.now()); }, []);
  /*
   * And nothing else moves it.
   *
   * There was a `pagehide` + `visibilitychange` writer here for about ten
   * minutes, on the theory that closing the app is another way of leaving a
   * pull request. It is not. Hiding a window is not reading — and the first
   * thing that listener did in the wild was eat his markers when the app was
   * restarted to install the build containing it: "maybe they got marked as
   * read, even though I never clicked mark as read".
   *
   * The mark advances in two places, and both are the reader's own doing:
   * navigating away from this pull request, and pressing the button that says
   * so. Everything else leaves it exactly where it was.
   */

  /*
   * With no mark of your own, your last word on it stands in for one.
   *
   * Reported from the app: everything worked and nothing showed, because the
   * pull request being looked at is precisely the one this browser has never
   * recorded a visit to. "Nothing is new until you have been here once" is
   * defensible and useless — it means the feature introduces itself by doing
   * nothing. See `bootstrapSince`.
   */
  const prSeenAt = useMemo(() => storedSeen || bootstrapSince(detail), [storedSeen, detail]);

  /** Everything said since that mark, oldest first, and the same set by key so
   *  a comment can ask "am I new" without walking the list. */
  const newAtoms = useMemo(() => newSince(detail, prSeenAt), [detail, prSeenAt]);
  const newSet = useMemo(() => newKeys(newAtoms), [newAtoms]);
  const markPrRead = useCallback(() => {
    if (!seenKeyRef.current) return;
    const now = Date.now();
    writeSeen(seenKeyRef.current, now);
    setStoredSeen(now);
  }, []);
  /** Undo that. Throws the mark away, which drops this pull request back to
   *  "everything since my last word", the state it has before any visit. */
  const unmarkPrRead = useCallback(() => {
    if (!seenKeyRef.current) return;
    clearSeen(seenKeyRef.current);
    setStoredSeen(0);
  }, []);
  /*
   * What arrived after your last word, whether or not it has been marked read.
   *
   * Only used to offer the way back: with nothing new, a conversation where
   * somebody answered you an hour ago and you have already cleared the mark is
   * indistinguishable from one where nobody has said anything at all — and the
   * first is worth a line saying the marks can be brought back.
   */
  const sinceMine = useMemo(
    () => (storedSeen ? newSince(detail, bootstrapSince(detail)).length : 0),
    [storedSeen, detail],
  );

  /*
   * Something arrived while you were looking at it.
   *
   * The poll already re-reads the open pull request every twenty seconds; all
   * this does is notice that the answer grew. Announced rather than left to be
   * found: the whole failure this feature is about is a remark that was on the
   * page and invisible, and one that lands while you are reading is the most
   * invisible of the lot — nothing on screen moves.
   *
   * The first answer for a pull request is not an arrival. It is the page
   * loading, and toasting "2 new" at somebody who has just opened it would be
   * announcing the state as if it were an event.
   */
  /*
   * How far behind, from the one place that knows.
   *
   * Read the moment a pull request is opened — instant when the board has
   * already asked — and again whenever an answer lands. `asking` drives the
   * placeholder beside the merge buttons: the space is held while the question
   * is out, rather than a button appearing from nowhere a second later.
   */
  useEffect(() => {
    if (!root || selected == null) { setBehind(null); setLocalHead(null); setBehindAsking(false); return; }
    const n = selected;
    const read = () => {
      const a = behindAnswer(root, n);
      setBehind(a.behind);
      setLocalHead(a.local);
      setBehindAsking(askingBehind(root, n));
    };
    read();
    return onBehind(read);
  }, [root, selected]);

  /*
   * The local half, on its own clock.
   *
   * How far behind the base a branch is takes a comparison over the network and
   * is stable for minutes. Whether your checkout is dirty, or carries a commit
   * GitHub has not seen, changes the moment you type — and both were arriving
   * in one answer held for as long as the slow one was worth holding. Reported
   * both ways round: it offered to fast-forward a checkout that had just gone
   * dirty, and went on refusing one that had just been committed.
   *
   * This read is git only, no network, so it can be asked again while the pull
   * request is open — every eight seconds, and the moment the window comes
   * back, which is when somebody has just been in a terminal doing exactly the
   * thing that changes the answer.
   */
  useEffect(() => {
    const branch = detail?.headRefName;
    /*
     * …and only while this view is the one on screen. The panels stay mounted
     * when you leave them, so this poll and the half-minute one behind it went
     * on asking git about a pull request nobody was looking at, for as long as
     * the app was open — measured at ~158,000 child processes a day on a
     * cockpit parked on the Terminal.
     *
     * `active` is in the dependencies deliberately: without it the effect never
     * re-runs on the way back in, and coming back to a stale count would be a
     * feature lost rather than a cost saved. With it, re-entering runs `read()`
     * and `again()` immediately — so the answer is fresh the instant you look,
     * which is what the `focus`/`visibilitychange` pair below already does for
     * the window.
     */
    if (!active || !root || !branch) return;
    let live = true;
    const read = () => {
      api.prLocalHead(root, branch)
        .then((r) => { if (live && r.ok && r.local) setLocalHead(r.local); })
        .catch(() => {});
    };
    read();
    /* And the count itself, which is the slow half: asked again when you arrive
       and every half minute you stay. It is cached for five minutes for the
       board's sake — twelve comparisons over the network — and five minutes is
       far too long for the pull request in front of you. Measured while he was
       looking at one: the server said 0 behind, GitHub agreed, and the page
       still said 936. */
    const again = () => { refreshBehind(root, selectedRef.current ?? 0); };
    again();
    const slow = setInterval(again, 30_000);
    const t = setInterval(read, 8_000);
    const onBack = () => { if (document.visibilityState === "visible") { read(); again(); } };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      live = false;
      clearInterval(t);
      clearInterval(slow);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [active, root, detail?.headRefName]);

  const arrivedRef = useRef<{ key: string; last: number } | null>(null);
  useEffect(() => {
    const newest = newAtoms.length ? newAtoms[newAtoms.length - 1]!.at : 0;
    const before = arrivedRef.current;
    arrivedRef.current = { key, last: newest };
    if (!key || !before || before.key !== key || newest <= before.last) return;
    const fresh = newAtoms.filter((a) => a.at > before.last);
    const who = [...new Set(fresh.map((a) => a.author))].join(", ");
    flash(true, fresh.length === 1
      ? `${who} just commented — ${fresh[0]!.where}`
      : `${fresh.length} new comments — ${who}`);
  }, [key, newAtoms, flash]);

  // How this repository merges: your last choice on it if it still allows that
  // method, and otherwise the one GitHub's own button would have arrived on.
  const mergeMethod = pickMergeMethod(repo ? methods[repo.key] : undefined, detail?.mergePolicy);
  const setMergeMethod = useCallback((m: MergeMethod) => {
    if (!repo) return;
    setMethods((cur) => { const next = { ...cur, [repo.key]: m }; saveMap(METHOD_KEY, next); return next; });
  }, [repo]);

  // What GitHub already knows you have read, unioned with this browser's copy.
  // GitHub's is the authority — it also un-ticks a file that changed after you
  // marked it — but the local set still counts so a tick shows before the
  // round trip lands.
  const seenFiles = useMemo(() => {
    const local = key ? (seen[key] ?? []) : [];
    const remote = (detail?.files ?? []).filter((f) => f.viewed).map((f) => f.path);
    return [...new Set([...remote, ...local])];
  }, [key, seen, detail]);
  const myDrafts = key ? (drafts[key] ?? []) : [];
  const myReview: ReviewDraft = (key && reviews[key]) || { verb: "comment", body: "" };
  const hasReviewDraft = !!(key && reviews[key]);
  /** Hold the unsent review. Written through to storage on every keystroke —
   *  the whole point is that it survives a tab switch, a closed panel and a
   *  rebuild, and any of those can happen between one key and the next. */
  const setMyReview = useCallback((patch: Partial<ReviewDraft>) => {
    if (!key) return;
    setReviews((cur) => {
      const merged = { ...(cur[key] ?? { verb: "comment" as const, body: "" }), ...patch };
      // An empty note with the default verdict is not a draft — it is the
      // absence of one, and keeping it would leave a "you have a review in
      // progress" mark on every pull request you ever opened.
      const next = { ...cur };
      if (!merged.body.trim() && merged.verb === "comment") delete next[key];
      else next[key] = merged;
      saveMap(REVIEW_KEY, next);
      return next;
    });
  }, [key]);

  /**
   * Mark a file read, here and on GitHub.
   *
   * This used to be local only, so the tick disagreed with github.com, was lost
   * on another machine, and never un-ticked itself when the file changed under
   * you — all three of which GitHub's own state gets right. The local copy is
   * still written first so the switch answers instantly; the network call is
   * the one that makes it true anywhere else.
   */
  const toggleSeen = (path: string) => {
    if (!key) return;
    let nowViewed = false;
    setSeen((cur) => {
      const list = new Set(cur[key] ?? []);
      if (list.has(path)) list.delete(path); else { list.add(path); nowViewed = true; }
      const next = { ...cur, [key]: [...list] };
      saveMap(SEEN_KEY, next);
      return next;
    });
    const id = detail?.nodeId;
    if (id) void api.prFileViewed(root, id, path, nowViewed).catch(() => { /* local tick still stands */ });
  };

  /**
   * Tick, or un-tick, a whole list of files.
   *
   * The reason this exists rather than a loop at the call site: GitHub is told about
   * each one, and forty files is forty requests. They go in a small number at a time
   * so a big review does not open forty sockets, and the local ticks are written ONCE
   * — the state that draws the tree must not be rewritten forty times while the
   * requests are in flight.
   *
   * Nothing waits for GitHub. The tick has always been local-first here (see
   * toggleSeen), and a refusal leaves the local answer standing rather than un-ticking
   * something under the reader's cursor.
   */
  const setSeenMany = (paths: string[], on: boolean) => {
    if (!key || !paths.length) return;
    setSeen((cur) => {
      const list = new Set(cur[key] ?? []);
      for (const p of paths) { if (on) list.add(p); else list.delete(p); }
      const next = { ...cur, [key]: [...list] };
      saveMap(SEEN_KEY, next);
      return next;
    });
    const id = detail?.nodeId;
    if (!id) return;
    void (async () => {
      const AT_A_TIME = 6;
      for (let i = 0; i < paths.length; i += AT_A_TIME) {
        await Promise.allSettled(paths.slice(i, i + AT_A_TIME)
          .map((p) => api.prFileViewed(root, id, p, on).catch(() => {})));
      }
    })();
  };

  /** Queue a line comment into the pending review. The body comes from the
   *  inline composer now, not a one-line dialog, so this just files it. */
  const addDraft = (path: string, line: number, startLine?: number, side?: "LEFT" | "RIGHT", body?: string) => {
    if (!body?.trim() || !key) return;
    setDrafts((cur) => {
      const next = { ...cur, [key]: [...(cur[key] ?? []), { path, line, ...(startLine && startLine !== line ? { startLine } : {}), ...(side ? { side } : {}), body: body.trim() }] };
      saveMap(DRAFT_KEY, next);
      return next;
    });
    flash(true, `Queued — ${(myDrafts.length + 1)} pending comment${myDrafts.length ? "s" : ""}`);
  };

  const dropDraft = (i: number) => {
    if (!key) return;
    setDrafts((cur) => {
      const next = { ...cur, [key]: (cur[key] ?? []).filter((_, j) => j !== i) };
      saveMap(DRAFT_KEY, next);
      return next;
    });
  };

  /** The same drop, addressed by the comment itself. A row in the diff holds
   *  the comment, not its position in a list it never sees — and an index is
   *  the wrong handle for something the user is pointing at. */
  const dropDraftItem = (dc: DraftComment) => {
    const i = myDrafts.indexOf(dc);
    if (i >= 0) dropDraft(i);
  };

  /**
   * One line comment, posted on its own.
   *
   * Sent as a COMMENT review carrying a single comment and no body, because
   * that is the request this panel already knows how to make and it lands the
   * remark on the line immediately. It shows on GitHub as a review with one
   * comment rather than as a lone comment — the difference is a line in the
   * timeline, not in where the remark ends up or who is notified.
   *
   * Deliberately does NOT touch the draft queue: this is the escape hatch for
   * "one typo, right here", which is exactly the case where being made to open
   * and submit a whole review is the wrong shape.
   */
  const postOneComment = async (
    path: string, line: number, startLine: number | undefined,
    side: "LEFT" | "RIGHT" | undefined, body: string,
  ): Promise<boolean> => {
    if (!body.trim()) return false;
    setBusy(true);
    try {
      const r = await api.prReviewWith(root, selected!, "comment", "", [
        { path, line, ...(startLine && startLine !== line ? { startLine } : {}), ...(side ? { side } : {}), body },
      ]);
      flash(r.ok, r.ok ? "Comment posted" : (r.error || "Could not post the comment"));
      if (r.ok) void loadDetail(selected!, true);
      return r.ok;
    } catch (e) { flash(false, String(e)); return false; }
    finally { setBusy(false); }
  };

  const submitReview = async (verb: "approve" | "request_changes" | "comment", body: string) => {
    if (!detail) return;
    const ok = await act("Review", () => api.prReviewWith(root, detail.number, verb, body, myDrafts));
    if (ok && key) {
      setDrafts((cur) => { const next = { ...cur, [key]: [] }; saveMap(DRAFT_KEY, next); return next; });
      // Sent is the one thing that clears it. Anything short of that — closing
      // the panel, switching tabs, a rebuild — leaves the draft where it was.
      setReviews((cur) => { const next = { ...cur }; delete next[key]; saveMap(REVIEW_KEY, next); return next; });
      setTab("conversation");
    }
  };

  /**
   * The merge, asked for properly.
   *
   * Everything the merge decides is now on one form — subject, extended
   * description, what happens to the branch — instead of a one-line prompt
   * that asked for the subject, silently sent an empty body, and deleted the
   * head branch without mentioning it. See MergeDialog for the shape and why.
   *
   * A repository that deletes the head branch on merge does it itself; asking
   * gh to delete it as well is a second call whose best outcome is "already
   * gone" and whose worst is a non-zero exit on a merge that already landed.
   * So that case offers no checkbox and sends no flag.
   *
   * And the card moves with it. Merging here and then dragging the card out of
   * Code Review on the board is two places for one decision, and the second is
   * the one that gets forgotten. It is a SECOND write, to a different system,
   * and is treated like one: only after the merge actually landed, and a
   * refusal from ClickUp never reports the merge as failed — see mergeNote.
   */
  const doMerge = async (method: MergeMethod) => {
    if (!detail) return;
    const head = detail.commits[detail.commits.length - 1]?.oid;
    const choice = await askMerge({
      number: detail.number, title: detail.title, method,
      baseRefName: detail.baseRefName, headRefName: detail.headRefName, headRepoOwner: detail.headRepoOwner,
      commits: detail.commits,
      repoDeletesBranch: !!detail.mergePolicy?.deletesBranch,
      /* `reviewers` is GitHub's OUTSTANDING request list — it drops somebody the
         moment they submit — so a non-empty one on an open pull request is
         exactly "asked, still waiting". Teams included: a team request is a
         person's turn too, just not one person's. */
      awaitingReview: detail.reviewers.map((r) => r.login),
      humanApproved: detail.reviews.some((r) => !r.isBot && r.state === "APPROVED"),
      botApproved: detail.reviews.some((r) => r.isBot && r.state === "APPROVED"),
      card: mergeCardRef(detail, clickup),
    });
    if (!choice) return;
    /*
     * What the merge control says while this runs.
     *
     * `busy` alone could not say it. It is one flag for every action on the
     * panel, so a button reading it can only know that SOMETHING is happening —
     * and the merge button, dimmed and still reading "Squash and merge" through
     * a `gh` subprocess and then a write to ClickUp, read as a button that had
     * not registered the press. That is the state people press twice.
     *
     * Two names rather than one, because these are two writes to two systems
     * and the second is the one that can take a while on somebody else's
     * network. Which half it is on is worth saying: once it reads MOVING_CARD
     * the irreversible part is already done, and the button's tooltip says so
     * — that is the difference between waiting and wondering whether to try
     * the merge again.
     */
    try {
      setMergeWork("Merging…");
      const merged = await act("Merge", () => api.prMerge(root, detail.number, method, {
        deleteBranch: choice.deleteBranch, headSha: head,
        subject: choice.subject, body: choice.body,
      }));
      const move = choice.card;
      if (!merged || !move) return;
      setMergeWork(MOVING_CARD);
      // `updated` is the precondition, not decoration: somebody else moving the
      // card while the merge form was open should come back as a conflict rather
      // than quietly winning.
      const r = await api.clickupStatus(move.id, move.to, move.updated)
        .catch((e) => ({ ok: false, error: String(e) }));
      flash(r.ok, mergeNote(true, {
        asked: true, ok: r.ok, to: move.to,
        unauthorised: "unauthorised" in r ? r.unauthorised : undefined,
        error: r.ok ? undefined : ("conflict" in r && r.conflict ? "somebody moved it while this was open" : r.error),
      }));
    } finally {
      // `finally`, so a throw anywhere above cannot leave the button spinning
      // for ever — a spinner that never stops is a worse lie than no spinner.
      setMergeWork("");
    }
  };

  /**
   * "Merge when green", armed with the method that is on the button.
   *
   * It sent "squash" whatever the menu said, so choosing a merge commit and
   * then arming it queued the opposite of what the button in front of you
   * read — and by the time it fires, nobody is watching.
   */
  const doAutoMerge = () => {
    if (!detail) return;
    act("Auto-merge", () => api.prMerge(root, detail.number, mergeMethod, {
      auto: true, deleteBranch: !detail.mergePolicy?.deletesBranch,
    }));
  };

  /**
   * Close, or reopen a closed one.
   *
   * The menu has offered "Reopen pull request" all along and then called close
   * with `reopen` left false, so reopening was unreachable from the UI while the
   * server supported it the whole time. The dialog was wrong in the same way,
   * asking "Close #N?" over a pull request that was already closed.
   */
  const doClose = async () => {
    if (!detail) return;
    const reopen = detail.state === "CLOSED";
    const ok = await ask({
      title: reopen ? `Reopen #${detail.number}?` : `Close #${detail.number}?`,
      body: reopen
        ? `${detail.title}\n\nIt goes back to open, with its comments and reviews intact.`
        : `${detail.title}\n\nClosed without merging. You can reopen it afterwards.`,
      confirmLabel: reopen ? "Reopen pull request" : "Close pull request", danger: !reopen,
    });
    if (!ok) return;
    await act(reopen ? "Reopen" : "Close", () => api.prClose(root, detail.number, reopen));
  };

  /**
   * Hand a pull request to the chat.
   *
   * Takes a number so a list row can do it without opening the pull request
   * first — the review prompt is built server-side from the number alone, so
   * making the row load a whole detail page just to reach this would be a
   * round trip spent on nothing.
   */
  const doLocalReview = async (n?: number, recipe = "") => {
    const num = n ?? detail?.number;
    if (num == null) return;
    setBusy(true);
    try {
      /* The card id is worked out here and sent, rather than looked up there:
         `cardRef` reads a branch name and a title with rules this app owns, and
         the server has no reader for the tracker at all. Empty is fine — the
         prompt that wants it is the only one that uses it. */
      const card = detail ? cardRef(detail)?.label ?? "" : "";
      const r = await api.prReviewPrompt(root, num, recipe, card);
      if (!r.ok || !r.cwd || !r.prompt) { flash(false, r.error || "Could not prepare the review"); return; }
      if (onOpenChatWith) { onOpenChatWith(r.cwd, r.prompt, `Review #${num}`); flash(true, `#${num} is waiting in chat`); }
      else flash(false, "The chat is not available here");
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); }
  };

  const doEditTitle = async () => {
    if (!detail) return;
    const title = await askText({ title: `Rename #${detail.number}`, confirmLabel: "Save", input: { label: "Title", initial: detail.title } });
    if (!title?.trim() || title.trim() === detail.title) return;
    await act("Edit title", () => api.prEdit(root, detail.number, { title: title.trim() }));
  };

  const doEditBody = async (body: string) => {
    if (!detail) return false;
    return act("Description", () => api.prEdit(root, detail.number, { body }));
  };

  /** Labels and reviewers both take a comma-separated list and diff it against
   *  what is already there, so one box does both adding and removing. */
  const doLabels = async () => {
    if (!detail) return;
    const cur = detail.labels.map((l) => l.name);
    const next = await askText({
      title: `Labels on #${detail.number}`, confirmLabel: "Save",
      input: { label: "Comma-separated — remove one by deleting it", initial: cur.join(", ") },
    });
    if (next == null) return;
    const want = next.split(",").map((s) => s.trim()).filter(Boolean);
    const add = want.filter((l) => !cur.includes(l));
    const remove = cur.filter((l) => !want.includes(l));
    if (add.length === 0 && remove.length === 0) return;
    await act("Labels", () => api.prLabels(root, detail.number, add, remove));
  };

  const doReply = async (t: PrThread, body: string): Promise<boolean> => {
    if (!detail) return false;
    const first = t.comments[0];
    if (typeof first?.databaseId !== "number" || !body.trim()) return false;
    return act("Reply", () => api.prReply(root, detail.number, first.databaseId as number, body));
  };
  /** Toggle an emoji. The node id is the GraphQL one, so the same call serves
   *  the body, a comment, a review and a line comment. */
  /**
   * Take a suggestion.
   *
   * Confirmed first: this writes a commit to somebody's branch, which is not
   * something to do on a stray click. The author of the comment is credited as
   * a co-author, as GitHub does.
   */
  const doApplySuggestion = async (t: PrThread, text: string) => {
    if (!detail || !t.line) return;
    const where = `${t.path}:${t.startLine && t.startLine !== t.line ? `${t.startLine}-${t.line}` : t.line}`;
    const ok = await ask({
      title: `Apply this suggestion to ${t.path.split("/").pop()}?`,
      body: `${where}\n\nCommits to ${detail.headRefName}, crediting ${t.comments[0]?.author ?? "the author"}. If anyone has pushed since this loaded, GitHub refuses rather than overwriting them.`,
      confirmLabel: "Apply suggestion",
    });
    if (!ok) return;
    await act("Suggestion", () => api.prApplySuggestion(root, detail.number, {
      path: t.path, line: t.line!, startLine: t.startLine ?? undefined,
      suggestion: text, author: t.comments[0]?.author,
    }));
  };

  const doReact = async (nodeId: string, content: string, on: boolean) => {
    if (!nodeId) return;
    await act(on ? "Reaction" : "Reaction removed", () => api.prReactTo(root, nodeId, content, on));
  };
  const doReviewers = async () => {
    if (!detail) return;
    // Logins, which is what the endpoint takes. A team arrives here under its
    // name for want of anywhere better to put it — exactly as it did when this
    // list was strings, so nothing about requesting one changes here.
    const cur = detail.reviewers.map((r) => r.login);
    const next = await askText({
      title: `Reviewers on #${detail.number}`, confirmLabel: "Save",
      input: { label: "Comma-separated logins — remove one by deleting it", initial: cur.join(", ") },
    });
    if (next == null) return;
    const want = next.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
    const add = want.filter((l) => !cur.includes(l));
    const remove = cur.filter((l) => !want.includes(l));
    if (add.length === 0 && remove.length === 0) return;
    await act("Reviewers", () => api.prReviewers(root, detail.number, add, remove));
  };

  const doCopyLink = async () => {
    if (!detail) return;
    try { await navigator.clipboard.writeText(detail.url); flash(true, "Link copied"); }
    catch { flash(false, "Could not reach the clipboard"); }
  };

  /** The chase, written for you: who it waits on, what for, where — on the
   *  clipboard always, and down the alerts' channel when one is configured. */
  const doNudge = async () => {
    if (!detail || !root) return;
    const r = await api.prNudge(root, detail.number, true).catch(() => ({ ok: false, error: "the server did not answer" } as { ok: boolean; text?: string; channel?: boolean; sent?: boolean; error?: string }));
    if (!r.ok || !r.text) { flash(false, r.error ?? "Could not compose the nudge"); return; }
    let copied = false;
    try { await navigator.clipboard.writeText(r.text); copied = true; } catch { /* the channel may still have taken it */ }
    if (r.sent) flash(true, copied ? "Nudge sent to the channel, and copied" : "Nudge sent to the channel");
    else if (copied) flash(true, r.channel ? `Nudge copied — the channel refused: ${r.error ?? "unknown"}` : "Nudge copied — paste it where they will see it (no channel is configured)");
    else flash(false, r.error ?? "Could not reach the clipboard");
  };

  /** Hand a failing check to the chat pointed at this project, with the job that
   *  broke named, so the answer is written against the code that failed rather
   *  than a guess from the name of the job. */
  /*
   * The last one that decided for you.
   *
   * A failing check is exactly the case where the terminal is often the right
   * place — you are about to read a log, try a command, and try it again — so
   * sending it to the chat without asking was the wrong default for the wrong
   * reason: it was simply the only path wired in.
   *
   * `to` is the same preference the ClickUp hand-off uses, read here rather
   * than duplicated, so choosing once covers both.
   */
  const askClaudeAboutCheck = async (check: PrCheck, where?: "chat" | "term") => {
    if (!detail) return;
    const to = where ?? handoffTo();
    if (to === "chat" && !onOpenChatWith) return;
    setBusy(true);
    try {
      const r = await api.prReviewPrompt(root, detail.number);
      if (!r.ok || !r.cwd) { flash(false, r.error || "Could not prepare the question"); return; }
      const prompt =
        `The check "${check.name}"${check.workflow ? ` in the ${check.workflow} workflow` : ""} is failing on pull request #${detail.number} (${detail.title}), on branch ${detail.headRefName}.\n\n` +
        `Read the failure with:  gh run view --log-failed --repo <this repo>  (or the run URL below)\n` +
        `Read the change with:  gh pr diff ${detail.number}\n\n` +
        `This working directory is the same project, but not the pull request. Work out why the job is failing and propose the fix. Do not change any files yet.` +
        (check.url ? `\n\nThe run is at ${check.url}.` : "");
      if (to === "term") {
        requestTermIssue(r.cwd, `check-${detail.number}`, prompt, true);
        flash(true, `#${detail.number} is waiting in a pane`);
      } else {
        onOpenChatWith!(r.cwd, prompt, `Check on #${detail.number}`);
        flash(true, `#${detail.number} is waiting in chat`);
      }
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); }
  };

  const doComment = async (body: string) => {
    if (!detail) return false;
    return act("Comment", () => api.prComment(root, detail.number, body));
  };

  const lanes = useMemo(() => {
    if (!detail) return { humans: [] as PrReview[], botReviews: [] as PrReview[], humanComments: [] as PrComment[], bots: [] as PrComment[] };
    // Oldest first, the way a conversation is read — GitHub's order, and the
    // one the replies were written in. The API hands these back newest-first,
    // so a thread arrived answered before it was asked.
    const byTime = <T,>(xs: T[], at: (x: T) => string) =>
      [...xs].sort((p, q) => at(p).localeCompare(at(q)));
    return {
      // `reviewSpeaks` rather than the rule written out here: the counter above
      // the timeline applies the same test, and when the two drifted apart the
      // count said three over two visible markers.
      humans: byTime(detail.reviews.filter((r) => !r.isBot && reviewSpeaks(r)), (r) => r.submittedAt),
      botReviews: byTime(detail.reviews.filter((r) => r.isBot && r.body.trim()), (r) => r.submittedAt),
      humanComments: byTime(detail.comments.filter((c) => !c.isBot), (c) => c.createdAt),
      bots: byTime(detail.comments.filter((c) => c.isBot), (c) => c.createdAt),
    };
  }, [detail]);

  const openThreads = useMemo(() => (detail?.threads ?? []).filter((t) => !t.isResolved), [detail]);
  /* The review you started in GitHub's own UI and never submitted. Read once
     per pull request here rather than inside a tab: Review lists them and Files
     draws them on the lines they belong to, and two fetches would be two
     answers that can disagree. */
  const [held, setHeld] = useState<PendingLine[]>([]);
  useEffect(() => {
    if (!selected) { setHeld([]); return; }
    let alive = true;
    api.prPendingReview(root, selected)
      /* Replaced only when an answer lands, never cleared first — a refresh
         must not blink the drafted comments off the Review tab on its way to
         saying the same thing. An empty answer IS the answer when the draft was
         deleted in the browser, which is what this re-read is for. */
      .then((r) => { if (alive && r.ok) setHeld(r.comments); })
      .catch(() => { /* offline — both tabs still work for what is queued here */ });
    return () => { alive = false; };
  }, [root, selected, detailTick]);
  const d = detail;

  /* Asked once and handed to both readers. The masthead strip and the Overview
   * box are two sentences about the same rollup, and "we pushed a moment ago"
   * is the input that decides whether an empty one means "none" or "not yet" —
   * so it cannot be worked out separately in each place. */
  const awaitingChecks = !!d && !!pushed && pushed.number === d.number && Date.now() - pushed.at < AWAIT_CHECKS_MS;

  // You cannot review your own pull request — GitHub does not offer it either,
  // and a review control on every row buries the ones actually waiting on you.
  // You cannot review your own work, and you cannot review something that has
  // already merged or been closed — GitHub takes the review form away too.
  const canReview = !!d && !d.viewerDidAuthor && d.state === "OPEN";

  const TABS: { id: Tab; label: string; n?: number; warn?: boolean; one?: boolean; hot?: number }[] = d ? [
    { id: "overview", label: "Overview" },
    // `hot` is what has been said since you last looked. Its own field rather
    // than `warn`: amber on Checks means something is broken, and a colleague
    // answering you is not a failure — it is the one thing on this panel worth
    // walking towards.
    { id: "conversation", label: "Conversation", n: lanes.humans.length + lanes.humanComments.length + d.threads.length + lanes.bots.length, hot: newAtoms.length },
    { id: "commits", label: "Commits", n: d.commits.length },
    // `one` because Files stopped being a list of diffs: it is the tree, the
    // diff and the rail at once, and a tab that behaves unlike its neighbours
    // has to say so before you press it rather than after.
    { id: "files", label: "Files", n: d.files.length, one: true },
    { id: "checks", label: "Checks", n: d.checks.total, warn: d.checks.failure > 0 },
    // The dot also means "you have a review written and not sent" — otherwise a
    // draft that survives everything else is invisible from every tab but its
    // own, which is the same as losing it.
    ...(canReview ? [{ id: "review" as Tab, label: "Review", n: myDrafts.length || undefined, warn: d.viewerRequested || hasReviewDraft }] : []),
  ] : [];

  return (
    <RepoCtx.Provider value={repo?.nameWithOwner}>
    <ViewerCtx.Provider value={viewer}>
    <MentionCtx.Provider value={mentions}>
    <div className="flex flex-col h-full min-h-0">
      <style>{SCROLLBAR_CSS}{LINEBTN_CSS}{MD_CSS}{PR_ROW_CSS}</style>

      {/*
       * One bar, where there used to be three.
       *
       * Opening a pull request added a "‹ Pull requests · repo · #507" row and
       * a pinned row under this one, and the two of them cost 70px of the pull
       * request you had just opened — to say where you were, which the panel
       * you are looking at already says, and to hold a jump-list that is empty
       * most of the time. Both fold in here.
       *
       * `relative`, because the pinned capsule is centred on the BAR rather
       * than on the space left over between the chips and the Refresh button.
       * Those two ends are the ones the list view draws, and they have to stay
       * where the list puts them: a header that rearranges itself when you
       * open a card reads as a different screen rather than as the same one,
       * one level down.
       */}
      <div className={`${viewHeaderClass} relative`} style={viewHeaderStyle}>
        <h2 className="sr-only">Pull Requests</h2>
        {/* No repo/worktree picker here: pull requests belong to the GitHub
            remote, and every worktree of a repo shares that one remote — so the
            picker only ever offered a dozen ways to look at the SAME list. The
            repo name, stated once, is all this header needs. */}
        {/* The repo name was a label, and a label is the one thing this header
            had room for that nobody could use. It is the same string either
            way, so it costs no space to make it the way OUT to the thing it
            names: the name opens the repository, and `PRs ↗` beside it opens
            the pull request list — the page somebody looking at this panel is
            most likely to want, and the one that takes the most clicks to
            reach from a repository landing page. */}
        {repo && (
          <span className="flex items-center gap-1.5 min-w-0">
            {/* Two chips rather than two words. Grey text with an arrow after
                it reads as a caption that happens to have punctuation; the
                border and the hover are what say "this is a control", and they
                are the same pill the rest of the app uses for one. Both carry
                the arrow, because either one leaves the app. */}
            {/* `ScopeChip`, like the other four views: this was 10px in a
                rounded-md at half the padding, which made the pull-request
                header's first control visibly smaller than the Terminal's and
                the Git panel's doing the same job one keystroke away. */}
            {([
              { to: "", label: repo.nameWithOwner, hint: `Open ${repo.nameWithOwner} on GitHub`, grow: true },
              { to: "/pulls", label: "PRs", hint: "Open this repository's pull requests on GitHub", grow: false },
            ] as const).map((b) => (
              <ScopeChip key={b.to} label={b.label} trailing="external" title={b.hint}
                className={b.grow ? "min-w-0" : "shrink-0"}
                onClick={() => openExternal(`https://github.com/${repo.nameWithOwner}${b.to}`)} />
            ))}
          </span>
        )}

        {/* The way back, and where you are.
            A page you cannot leave is a trap, and the browser's Back button is
            not ours to borrow — this panel lives inside an app, not a tab. The
            repository is NOT repeated here: it is the chip immediately to the
            left, and it was the widest word in a row that had already said it
            twice. */}
        {selected != null && (
          <>
            <span className="shrink-0" style={{ width: 1, height: 15, background: "color-mix(in srgb, var(--border) 65%, transparent)" }} />
            <button onClick={backToList}
              className="agx-btn inline-flex items-center gap-1.5 shrink-0 text-[10.5px] rounded-md px-1.5 py-0.5"
              style={{ color: "var(--text3)" }}
              title="Back to the list">
              <span aria-hidden>‹</span>
              <span>Pull requests</span>
              <span className="tabular-nums" style={{ color: "var(--text2)" }}>· #{selected}</span>
              {/* What you are reading is the copy from last time, and the real
                  one is on its way. Said quietly and in passing — the
                  alternative was an empty pane, which said nothing at all for
                  a whole second. */}
              {detailStale && <span className="animate-pulse" style={{ color: "var(--primary)" }}>· refreshing</span>}
            </button>
          </>
        )}

        <PinnedCapsule
          pinned={pinned} pinState={pinState} selected={selected}
          current={selected != null && d && repo ? { repo: repo.nameWithOwner, number: d.number, title: d.title } : null}
          onOpen={openPr}
        />

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {toast && <span className="text-[10px] max-w-[380px] truncate" style={{ color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</span>}
          {/* The loud "Loading pull requests…" is for a genuinely empty pane
              only. Once rows are up, the 20-second poll revalidates in the
              background every minute and a half — announcing that each time read
              as the list constantly reloading. With rows in hand it stays as the
              timestamp, and a quiet "· updating" is all a background refresh
              earns. */}
          <span className="text-[10px] tabular-nums" style={{ color: (listState.loading || listState.checksPending) && prs.length === 0 ? "var(--warning)" : "var(--text3)" }}>
            {prs.length === 0
              ? (listState.loading ? "Loading pull requests…"
                : listState.checksPending ? "Loading check states…"
                : listState.fetchedAt ? `⟳ ${ago(new Date(listState.fetchedAt).toISOString())}` : "")
              : (listState.fetchedAt
                ? `⟳ ${ago(new Date(listState.fetchedAt).toISOString())}${listState.loading || listState.checksPending ? " · updating" : ""}`
                : "")}
          </span>
          {/*
            * Refresh means "ask again for what is in front of me".
            *
            * It forced the main list and nothing else: the board'"'"'s own two
            * lists were re-read from the server'"'"'s cache, so a pull request that
            * arrived after that cache was filled stayed invisible however many
            * times it was pressed. Reported that way — a review requested of
            * him, present in the list the server serves, and absent from the
            * lane for it.
            *
            * Now: both board lists forced, the open pull request forced, and
            * the counts that go stale with them dropped.
            *
            * And the diff, which was the last thing here still answering from
            * memory: it is fetched once per selected pull request and was never
            * dropped, so pressing this on a pull request somebody had pushed to
            * re-read everything around a diff that stayed as it was.
            */}
          <Btn onClick={() => {
            forgetBehind();
            forgetRollups();
            boardForce.current = true;
            setBoardTick((n) => n + 1);
            loadList(true);
            if (selected != null) {
              loadDetail(selected, true);
              diffFresh.current = true;
              setDiffErr("");
              /* Everything per-pull-request re-asks off this: the diff, and the
                 review GitHub is holding for you. Nothing is emptied first —
                 pressing Refresh must not make the page you are reading
                 disappear for a second. */
              setDetailTick((n) => n + 1);
            }
          }} disabled={busy} small>Refresh</Btn>
        </div>
      </div>

      {/* List or pull request, never both. The list used to live in a column
          narrow enough that a title was all it could fit, and everything worth
          scanning — who is waiting on it, whether CI is green, how old it is —
          had to be crushed onto a second line or dropped. Given the whole
          width it becomes a table you can read down a column of, and the pull
          request you pick gets the whole width in return. */}
      <div className="flex flex-1 min-h-0">
        {selected == null ? (
        <div className="flex flex-col min-h-0 flex-1 min-w-0">
          <div className="flex gap-1 flex-wrap px-2 py-1.5 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)" }}>
            {/*
              * The board first, and it is not a filter.
              *
              * "Mine" and "Needs my review" were two mutually exclusive pills,
              * so the two populations you care about could never be on screen
              * together. On the board they are two lanes. The pills stay for
              * the scopes that are NOT about you — those are a table, and the
              * table is today's list, untouched.
              */}
            {/* Lit by what is on screen, not by what is stored: while a search
                is up the board is not showing, and a lit pill over a table is
                the panel telling you where you are and being wrong. Pressing it
                mid-search clears the box, which is the only way back. */}
            {/*
              * NOT A TOGGLE, and that was a real bug rather than a matter of
              * taste. The inbox REPLACES what the panel shows — the render is
              * `inboxOn ? <Inbox/> : board ? <TriageBoard/> : <table/>` — so it
              * is a third view, the same kind of thing as the board and the
              * five scopes beside it. Only its button disagreed: nothing else
              * on this row ever cleared `inboxOn`, so with the inbox open,
              * pressing Board or any scope changed the state underneath and
              * left the screen exactly as it was. Asked, looking at it: "I don't
              * see the point of putting a toggle there for it".
              *
              * So all seven are one exclusive group and say so — `role="tab"`,
              * `aria-selected`, one of them lit. Picking any view is picking a
              * view.
              */}
            <Pill on={boardShown} icon={<ColumnsIcon size={ICON.xs} />} label="Board"
              title={searching ? "Clear the search and go back to the lanes" : "Yours and the ones you were asked to look at, in lanes"}
              onClick={() => { if (searching) setQuery(""); setInboxOn(false); setBoard(true); }} />
            {/* Its number is the only one on this row counting things nobody
                has looked at yet, so it keeps the warning colour when it is not
                the view you are in. */}
            <Pill on={inboxOn} icon={<InboxIcon size={ICON.xs} />} label="Inbox"
              title="What happened while you were away — GitHub's notifications, filtered to this repository"
              count={inboxUnread || undefined} countTint="var(--warning)"
              onClick={() => setInboxOn(true)} />
            <span className="self-center shrink-0" style={{ width: 1, height: 12, background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />
            {VIEWS.map((v) => {
              const n = viewCount(v);
              const on = !boardShown && !inboxOn && activeView?.id === v.id;
              return (
                <Pill key={v.id} on={on} label={v.label} title={v.hint}
                  dot={v.tint ?? undefined} count={n ?? undefined}
                  onClick={() => { setInboxOn(false); setBoard(false); setFilter(v.scope); setQuery(v.query); }} />
              );
            })}
            {!activeView && (
              <span className="text-[10px] px-2 py-0.5 rounded-full shrink-0 self-center"
                style={{ color: "var(--text3)", border: "1px dashed color-mix(in srgb, var(--text) 16%, transparent)" }}>Custom</span>
            )}
            {/* Open / Closed / All — the state axis. "Closed" holds merged +
                closed, like GitHub's own Closed tab. */}
            <div className="ml-auto flex rounded-full overflow-hidden shrink-0 self-center" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
              {STATES.map((s) => (
                <button key={s.id} onClick={() => setStateSel(s.id)} title={`Show ${s.label.toLowerCase()} pull requests`}
                  className="agx-btn text-[10px] px-2 py-0.5"
                  style={{
                    color: stateSel === s.id ? "var(--bg)" : "var(--text3)",
                    background: stateSel === s.id ? "var(--primary)" : "transparent",
                  }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {/* Always, once the repository is known — not "once rows arrived".
              The bar is built from the rows, so gating it on them made it drop
              in a second late and shove the board down. It draws its own
              placeholder row until it has something to count. */}
          {repo && (
            <PrFilterBar
              query={query}
              filters={filters}
              facets={facets}
              onQuery={setQuery}
              onSearch={runSearch}
              pending={query.trim() !== serverQuery.trim()}
              searching={listState.loading}
              checksPending={listState.checksPending}
              shown={visiblePrs.length}
              unread={{ count: unreadPrs.length, on: unreadOnly, onToggle: () => setUnreadOnly((v) => !v) }}
        /* How much of the scope the filter actually saw. A count that says "12"
           over a scope of ninety-three, having read twenty-five of them, is a
           number nobody can act on. */
        swept={filters.text.trim() && sweep?.key === sweepKey ? { rows: sweep.rows.length, done: sweep.done } : undefined}
              total={listState.total ?? prs.length}
            />
          )}
          <div ref={listRef} tabIndex={-1} onKeyDown={onListKey} className="flex-1 overflow-y-auto min-h-0 agx-scroll outline-none">
            {inboxOn ? (
              <Inbox repo={repo?.nameWithOwner ?? ""} onFlash={flash} onUnread={setInboxUnread} />
            ) : boardShown && repo && !listState.needsAuth ? (
              /* The board replaces the TABLE, not the panel: every pill, facet
                 and search above stays where it was, and picking any of them
                 switches back to the table it belongs to. */
              <TriageBoard
                mine={boardMine} review={boardReview}
                /*
                 * Every open pull request, not the count for whichever filter
                 * happened to be selected — `listState.total` is the current
                 * scope's, so in board mode it was the size of `mine` and the
                 * sentence read "the other 0 are a table" over three hundred
                 * and eighty-eight of them.
                 */
                total={viewCounts.all ?? listState.total ?? prs.length}
                hasTaskProvider={hasTaskProvider}
                pinned={(n) => isPinned(repo.nameWithOwner, n)}
                onOpen={openPr}
                onTogglePin={(p) => togglePin(repo.nameWithOwner, p.number, p.title)}
                onShowTable={() => { setInboxOn(false); setBoard(false); setFilter("all"); setQuery(""); }}
                busy={busy}
                loading={boardLoading} settling={boardSettling} acting={actingOn} root={root}
                /* `repo.key`, because that is what the conversation's "last
                   looked" marks are written under — see the `key` this panel
                   builds for them. A different spelling of the same repository
                   would give every card a badge for ever. */
                repoKey={repo.key}
                /* Whoever opened them. A pinned pull request of a colleague's
                   is in no lane on this board, which is exactly why the strip
                   exists. */
                pinnedList={pinned}
                onAct={(p, what) => {
                  // Only what this app can really do. `merge` uses the method
                  // the panel already remembers, so the board never quietly
                  // picks a different one from the detail.
                  //
                  // `headSha` is not optional here either, and it used to be
                  // missing. A card lands in "Green, ready to land" because of
                  // its check rollup, and that rollup is about ONE commit; a
                  // merge sent with no head to match against lands on whatever
                  // the tip is when it arrives — the author's push from thirty
                  // seconds ago, untested in this combination and never seen by
                  // the person who pressed the button. The detail view has
                  // always passed it (see doMerge); this was the one merge in
                  // the app that could land a commit nobody had looked at.
                  //
                  // No head means the second pass has not landed, so the row
                  // has no checks either and no lane that offers Merge. Refused
                  // rather than sent unguarded, because "the guard was not
                  // available" is not a reason to skip the guard.
                  if (what === "merge") {
                    if (!p.headSha) { flash(false, "Merge — still reading this one's checks"); return; }
                    setActingOn(p.number);
                    void act("Merge", () => api.prMerge(root, p.number, mergeMethod, { headSha: p.headSha }))
                      .finally(() => setActingOn(null));
                  }
                  else if (what === "rerun") {
                    setActingOn(p.number);
                    void act("Re-run checks", () => api.prRerun(root, p.number)).finally(() => setActingOn(null));
                  }
                  else openPr(p.number);
                }} />
            ) : listState.needsAuth ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                <div style={{ color: "var(--warning)" }}>{listState.error || "The GitHub CLI is not set up"}</div>
                {/* Two steps, and the second is the one people miss: an
                    installed gh that has never logged in reads exactly like a
                    missing one from here. The link is the project's own page,
                    not a package-manager line, because the reader's system is
                    not knowable from here. */}
                <div className="mt-2">
                  Pull requests come from <code>gh</code>. Install it (<code>{depSpec("gh")?.url}</code>), run <code>gh auth login</code>, then refresh.
                </div>
              </div>
            ) : !repo ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>{listState.error || "No GitHub remote on this repository"}</div>
            ) : prs.length === 0 ? (
              listState.loading ? <Skeletons /> : (
                <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                  {(() => {
                    const what = stateSel === "open" ? "open " : stateSel === "closed" ? "closed " : "";
                    return filter === "mine" ? `No ${what}pull requests of yours`
                      : filter === "review" ? "Nothing waiting on your review"
                      : `No ${what}pull requests`;
                  })()}
                </div>
              )
            ) : visiblePrs.length === 0 ? (
              <div className="p-3 text-[11px] flex flex-col items-start gap-1.5" style={{ color: "var(--text3)" }}>
                <span>No pull requests match {activeCount(filters) === 1 ? "this filter" : "these filters"}.</span>
                <button onClick={() => setQuery("")} className="text-[10.5px] px-2 py-0.5 rounded hover:bg-white/5" style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)" }}>Clear filters</button>
              </div>
            ) : (
              // Dimmed, not blanked, while the next scope loads: you can still
              // read what is there, and it is obvious it is being replaced.
              <div style={{ opacity: listState.loading ? 0.45 : 1, transition: "opacity .15s" }}>
                <PrTableHead />
                {visiblePrs.map((p) => (
                  <PrRow key={p.number} p={p} active={p.number === rowCursor} q={filters.text}
                    unread={unreadOf(p, repo?.key, seenMarks)}
                    onSelect={() => openPr(p.number)} onReview={() => doLocalReview(p.number)}
                    pinned={!!repo && isPinned(repo.nameWithOwner, p.number)}
                    spend={spendChipFor(spendByBranch.get(p.headRefName), spend)}
                    onTogglePin={repo ? () => togglePin(repo.nameWithOwner, p.number, p.title) : undefined} />
                ))}
              </div>
            )}
          </div>
          {/* Pages, because a repository has more pull requests than one screen
              of them and the panel used to stop at the first fifty with no way
              to say so. Cursors only move forward, so Previous walks a stack. */}
          {repo && (listState.hasNext || pages.length > 0) && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-t shrink-0 text-[10px]"
              style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)", color: "var(--text3)" }}>
              <button onClick={() => setPages((p) => p.slice(0, -1))} disabled={pages.length === 0 || listState.loading}
                className="agx-btn px-2 py-0.5 rounded disabled:opacity-35"
                style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text2)" }}>‹ Previous</button>
              <span className="tabular-nums">
                Page {pages.length + 1}
                {listState.total != null && listState.pageSize
                  ? ` of ${Math.max(1, Math.ceil(listState.total / listState.pageSize))} · ${listState.total} total`
                  : ""}
              </span>
              <button onClick={() => { if (listState.cursor) setPages((p) => [...p, listState.cursor!]); }}
                disabled={!listState.hasNext || !listState.cursor || listState.loading}
                className="agx-btn ml-auto px-2 py-0.5 rounded disabled:opacity-35"
                style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text2)" }}>Next ›</button>
            </div>
          )}
        </div>
        ) : (
        <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
          {/* Editing the description is a full-column mode: the editor covers
              the masthead, tabs, sidebar and footer, because none of them help
              you write, and the textarea wants every pixel of height. The
              overlay is `absolute inset-0` over a column that already has a
              definite height, so `h-full` inside it fills without a page
              scroll — the whole point of taking over. */}
          {editingBody && d && (
            <div className="absolute inset-0 z-30 flex flex-col" style={{ background: "var(--bg)" }}>
              <BodyEditor
                key={d.number}
                prNumber={d.number}
                initial={d.body}
                busy={busy}
                onOpenGithub={() => openExternal(d.url)}
                onCancel={() => setEditingBody(false)}
                onSave={async (body) => { const ok = await doEditBody(body); if (ok) setEditingBody(false); return ok; }}
              />
            </div>
          )}
          {!d ? (
            /*
             * A wait in the SHAPE of the thing being waited for.
             *
             * It was a spinner in the middle of the pane, so a pull request did
             * not arrive, it REPLACED something: a centred word one moment, and
             * a masthead, a row of tabs and a page of text the next. Everything
             * on screen moved. The skeleton stands where the real blocks will
             * stand, so landing is a fill rather than a jump.
             *
             * An error is a message and belongs at the top where messages go —
             * and it now carries the one thing it never had: a way to try again.
             */
            detailErr ? (
              <div className="p-4 flex items-baseline gap-2 flex-wrap text-[11.5px]" style={{ color: "var(--error)" }}>
                <span>{detailErr}</span>
                <button onClick={() => { setDetailErr(""); if (selected != null) loadDetail(selected, true); }}
                  className="agx-btn px-2 py-0.5 rounded text-[10.5px]"
                  style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
                  Try again
                </button>
              </div>
            ) : <DetailSkeleton number={selected} />
          ) : (
            <>
              {/* `onLocalReview` is wrapped rather than passed by reference:
                  it lands on a click handler, and a bare reference would hand
                  the MouseEvent in as the pull request number. */}
              <Masthead
                d={d} busy={busy}
                onEditTitle={doEditTitle} onDraft={() => act(d.isDraft ? "Mark ready" : "Convert to draft", () => api.prDraft(root, d.number, !d.isDraft))}
                onClose={doClose} onLocalReview={(recipe) => doLocalReview(undefined, recipe)}
                onReviewInTerminal={onReviewInTerminal && d ? (recipe) => onReviewInTerminal(root, d.number, recipe, cardRef(d)?.label ?? "") : undefined}
                condensed={condensed}
                onLabels={doLabels} onReviewers={doReviewers} onCopyLink={doCopyLink} onNudge={doNudge}
                onEditField={fieldPicker.open}
                /* Your review, counted where the panel already counts it — the
                   strip is a reader of these three, never a second source. */
                viewed={seenFiles.length} threads={openThreads.length} queued={myDrafts.length}
                awaitingChecks={awaitingChecks}
                /* Already in hand — the same answer the Update button reads, from
                   the same store, so the header and that button cannot disagree
                   about which checkout this branch is in. */
                localHead={localHead}
              />
              {fieldPicker.node}
              <div className="flex border-b shrink-0 overflow-x-auto items-center" style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)" }}>
                {TABS.map((t) => (
                  <button key={t.id}
                    /* Written from the live element on the way out, as well as
                       on scroll. A tab whose content shrinks is clamped by the
                       browser the moment the new one renders, and a value read
                       after that is zero. */
                    onClick={() => {
                      const el = tabBodyRef.current;
                      if (el && tab !== "files") tabScroll.current[tab] = el.scrollTop;
                      setTab(t.id);
                    }} className="text-[10.5px] px-3 py-1.5 whitespace-nowrap"
                    style={{
                      color: tab === t.id ? "var(--text)" : "var(--text3)",
                      borderBottom: `2px solid ${tab === t.id ? "var(--primary)" : "transparent"}`,
                      background: tab === t.id ? "color-mix(in srgb, var(--primary) 8%, transparent)" : "transparent",
                    }}>
                    {t.label}
                    {/* The count carries the state, so a tab that wants
                        something is amber at the number people already read
                        rather than only at a mark beside it. */}
                    {t.n != null && (
                      <span className="ml-1 tabular-nums" style={t.warn ? { color: "var(--warning)" } : { opacity: .6 }}>{t.n}</span>
                    )}
                    {/* And the dot stays. Colour alone cannot say "amber" to
                        somebody who cannot see it, and Review is often warn
                        with no count at all — a verdict is owed and nothing is
                        queued — which is a tint with nothing to tint. */}
                    {t.warn && <span className="ml-1" style={{ color: "var(--warning)" }}>●</span>}
                    {/* Said as a number, not a dot: "somebody replied" and
                        "seven people replied while you were at lunch" are
                        different sizes of the same news, and the second is why
                        you would leave what you are doing. */}
                    {!!t.hot && (
                      <span className="ml-1.5 text-[9.5px] px-1.5 rounded-full tabular-nums align-middle"
                        title={`${t.hot} new since you last looked`}
                        style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 18%, transparent)",
                          border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>
                        {t.hot} new
                      </span>
                    )}
                    {t.one && (
                      <span className="ml-1.5 text-[10px] px-1 rounded align-middle"
                        title="The tree, the diff and what the rest of the pull request says about the file you are on — all at once"
                        style={{ color: "var(--primary)", border: "1px dashed color-mix(in srgb, var(--primary) 55%, transparent)" }}>
                        one screen
                      </span>
                    )}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-1.5 px-2 shrink-0">
                  {myDrafts.length > 0 && <Chip text={`${myDrafts.length} pending`} tint="var(--warning)" title="Line comments queued but not sent" />}
                  {hasReviewDraft && tab !== "review" && (
                    <button onClick={() => setTab("review")} title="A review written but not sent — it is kept until you send it">
                      <Chip text="draft review" tint="var(--primary)" />
                    </button>
                  )}
                  {d.viewerRequested && tab !== "review" && (
                    <Btn onClick={() => setTab("review")} primary small>Add your review</Btn>
                  )}
                </div>
              </div>

              {/* Prose on the left, metadata on the right — the arrangement
                  GitHub uses. There is no centred measure any more: capped at
                  1180 and centred, a wide window put a third of the panel of
                  empty gutter down the left-hand side while the description
                  wrapped early. The body fills what it is given (the 78ch
                  measure came out of MD_CSS for the same reason), so the
                  column starts at the left edge and the sidebar keeps the
                  right. Files/Checks/Commits already take the full width: a
                  diff and a check list want every pixel. */}
              {/* Files owns its own scrolling and must not also sit inside the
                  page's. With three columns capped by content and a page that
                  could still move underneath them, scrolling anywhere dragged
                  everything a little — which is the "one scroll" this was
                  reported as. Here the tab body is a fixed frame and the
                  columns scroll inside it, which is what the mockup means by
                  putting `overflow:auto` on each of the three. */}
              <CommitJumpCtx.Provider value={jumpToCommit}>
              <div ref={tabBodyRef} className={`flex-1 min-h-0 agx-scroll ${tab === "files" ? "overflow-hidden p-0" : "overflow-y-auto p-3"}`}
                onScroll={(e) => {
                  /*
                   * Files is a frame, not a page, and frames do not scroll.
                   *
                   * `overflow: hidden` stops a SCROLLBAR; it does not stop the
                   * box from being scrolled. Anything inside that reveals
                   * itself — a focused field, a `scrollIntoView` — walks up the
                   * ancestors and moves this one, and with no scrollbar there
                   * is nothing to put it back. Reported as the whole three
                   * columns and the masthead sliding up by a few pixels and
                   * staying there. Snapped back rather than prevented, because
                   * the browser does it for reasons of its own and there is no
                   * one place to intercept.
                   */
                  const el = e.currentTarget;
                  if (tab === "files") {
                    if (el.scrollTop || el.scrollLeft) { el.scrollTop = 0; el.scrollLeft = 0; }
                    return;
                  }
                  const y = el.scrollTop;
                  // Where this TAB was left. One box scrolls all of them, so
                  // without this, reading to the bottom of Conversation and
                  // stepping to Overview landed you at the bottom of Overview —
                  // a page you had never scrolled. Reported exactly that way.
                  tabScroll.current[tab] = y;
                }}>
                {(tab === "overview" || tab === "conversation") ? (
                  <div className="flex gap-4 items-start">
                    <div className="min-w-0 flex-1">
                      {tab === "overview" ? (
                        <Overview
                          d={d} root={root} busy={busy} mergeWork={mergeWork} openThreads={openThreads.length}
                          conversationCount={d.comments.length + d.reviews.length + d.threads.length}
                          behind={behind} behindAsking={behindAsking} localHead={localHead} busyWhat={busyWhat}
                          conflictFiles={conflictFiles}
                          onEditRequest={() => setEditingBody(true)}
                          onToggleTask={(newBody) => { void doEditBody(newBody); }}
                          onLocalReview={(recipe) => doLocalReview(undefined, recipe)}
                          onReviewInTerminal={onReviewInTerminal && d ? (recipe) => onReviewInTerminal(root, d.number, recipe, cardRef(d)?.label ?? "") : undefined}
                          onMerge={doMerge} onClose={doClose}
                          method={mergeMethod} onMethod={setMergeMethod}
                          onUpdateBranch={(syncLocal: boolean) => {
                            // Latched before the call, not after: the refetch
                            // inside `act` is the first read that could see an
                            // empty rollup, so the panel has to already know
                            // why it is empty.
                            setPushed({ number: d.number, at: Date.now() });
                            /* Thrown away AFTER it lands, not before: dropped
                               first, the store simply re-asks GitHub for a
                               count that has not changed yet and caches the old
                               one all over again. */
                            return act("Update branch", () => api.prUpdateBranch(root, d.number, syncLocal))
                              .finally(() => refreshBehind(root, d.number));
                          }}
                          onRerun={() => act("Re-run checks", () => api.prRerun(root, d.number))}
                          onAutoMerge={doAutoMerge}
                          onCancelAutoMerge={() => act("Auto-merge cancelled", () => api.prMerge(root, d.number, mergeMethod, { disableAuto: true }))}
                          onDraft={() => act(d.isDraft ? "Mark ready" : "Convert to draft", () => api.prDraft(root, d.number, !d.isDraft))}
                          onGoThreads={() => setTab("conversation")}
                          movedSince={movedHere.length}
                          onGoMoved={() => { setTab("files"); setWantSince((n) => n + 1); }}
                          awaitingChecks={awaitingChecks}
                        />
                      ) : (
                        <Conversation
                          d={d} lanes={lanes} raw={rawBots} onRaw={setRawBots} busy={busy} onComment={doComment}
                          atoms={newAtoms} newSet={newSet} onMarkRead={markPrRead}
                          sinceMine={sinceMine} onUnmarkRead={unmarkPrRead}
                          onResolve={(t) => act(t.isResolved ? "Unresolve" : "Resolve", () => api.prSetThreadResolved(root, t.id, !t.isResolved))}
                          onReply={doReply}
                          onApply={doApplySuggestion}
                          onReact={doReact}
                          who={convWho} onWho={setConvWho}
                          viewer={viewer}
                          /* Saved through the same act() every other write here goes
                             through, so a refusal is reported in the same strip and
                             the pull request is re-read afterwards. */
                          onSaveComment={(nodeId, kind, body) => act("Save", () => api.prEditComment(root, nodeId, body, kind))}
                          onHideComment={(nodeId, on) => void act(on ? "Hide" : "Unhide", () => api.prHideComment(root, nodeId, on))}
                        />
                      )}
                    </div>
                    <PrSidebar d={d} root={root} onEditField={fieldPicker.open}
                      spend={spendChipFor(spendByBranch.get(d.headRefName), spend)} />
                  </div>
                ) : null}

                {tab === "commits" && (
                  <div className="text-[11px] flex flex-col gap-2">
                    {commitFocus && (
                      <div className="text-[10.5px] px-1" style={{ color: "var(--text3)" }}>
                        Opened from a reference in the conversation.
                      </div>
                    )}
                    {commitDays.map(([day, list]) => (
                      <div key={day}>
                        {/* Grouped by the day they landed, as GitHub does — a
                            long branch reads as a history rather than a list. */}
                        <div className="text-[10px] uppercase tracking-wider mb-1 pl-1" style={{ color: "var(--text3)" }}>{day}</div>
                        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
                          {list.map((c, i) => (
                            <div key={c.oid} data-oid={c.oid}
                              ref={commitFocus === c.oid ? focusedCommitRef : undefined}
                              style={{
                                ...(i ? { borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" } : {}),
                                /* Only until you look at another one. A row that
                                   stays lit after you have moved on is telling
                                   you about a click you have forgotten. */
                                ...(commitFocus === c.oid
                                  ? { background: "color-mix(in srgb, var(--primary) 12%, transparent)",
                                      boxShadow: "inset 2px 0 0 var(--primary)" }
                                  : {}),
                              }}>
                              <button onClick={() => openCommit(selCommit === c.oid ? "" : c.oid)}
                                className="agx-btn w-full text-left flex items-center gap-2 px-2.5 py-2"
                                style={{
                                  opacity: c.isMerge ? 0.6 : 1,
                                  background: selCommit === c.oid ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent",
                                }}>
                                <span className="shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>{selCommit === c.oid ? "▾" : "▸"}</span>
                                <span className="min-w-0 flex-1">
                                  {/* Subject only, in full. The rest of the
                                      message is behind the `…` button, exactly
                                      as GitHub does it: a long body should not
                                      push every other commit off the screen. */}
                                  <span className="block" style={{ color: "var(--text)" }}>
                                    {c.message}
                                    {c.body?.trim() && (
                                      <button
                                        onClick={(ev) => { ev.stopPropagation(); toggleMsg(c.oid); }}
                                        title={openMsgs.has(c.oid) ? "Hide the full message" : "Show the full commit message"}
                                        aria-expanded={openMsgs.has(c.oid)}
                                        className="agx-btn ml-1.5 align-middle text-[10px] px-1.5 rounded leading-none"
                                        style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>…</button>
                                    )}
                                  </span>
                                  {c.body?.trim() && openMsgs.has(c.oid) && (
                                    <span className="block mt-1.5 px-2 py-1.5 rounded text-[10.5px] whitespace-pre-wrap"
                                      style={{ ...CODE_FONT_STYLE, color: "var(--text2)", background: "color-mix(in srgb, var(--border) 14%, transparent)" }}>{c.body.trim()}</span>
                                  )}
                                  <span className="flex items-center gap-1.5 mt-0.5 text-[10px]" style={{ color: "var(--text3)" }}>
                                    {/* Everyone credited. A commit written with an
                                        agent says so here, exactly like GitHub. */}
                                    {(c.authors?.length ? c.authors : [c.author]).slice(0, 3).map((a) => (
                                      <Avatar key={a} login={a} size={14} />
                                    ))}
                                    <span className="truncate">{commitAuthorLine(c)}</span>
                                    {c.committedAt && <span>· {ago(c.committedAt)}</span>}
                                  </span>
                                </span>
                                {c.isMerge && <Chip text="merge" tint="var(--text3)" title="Trunk catch-up, not work to review" />}
                                {c.verified && <Chip text="verified" tint="var(--success)" title="Signature verified by GitHub" />}
                                {c.checks && (
                                  <span className="shrink-0 text-[11px]" title={`Checks on this commit: ${c.checks.toLowerCase()}`}
                                    style={{ color: c.checks === "SUCCESS" ? "var(--success)" : c.checks === "FAILURE" || c.checks === "ERROR" ? "var(--error)" : "var(--warning)" }}>
                                    {c.checks === "SUCCESS" ? "✓" : c.checks === "FAILURE" || c.checks === "ERROR" ? "✕" : "•"}
                                  </span>
                                )}
                                <span className="tabular-nums shrink-0 px-1.5 py-0.5 rounded" style={{ ...CODE_FONT_STYLE, fontSize: "10px", color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>{c.short}</span>
                              </button>
                              {selCommit === c.oid && (
                                <div className="my-2">
                                  {commitBusy ? <Loading label="Loading the diff…" size={18} />
                                    : commitFiles.length === 0 ? <div className="text-[10.5px] p-2" style={{ color: "var(--text3)" }}>This commit changed nothing textual</div>
                                    : <FileStack files={commitFiles} split={split} wrap={wrap} onSplit={setSplit} onWrap={setWrap} scope={c.oid} />}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {d.truncated?.commits && (
                      <div className="text-[10px] px-1" style={{ color: "var(--warning)" }}>
                        Showing the most recent {d.truncated.commits} commits — a branch with more history than that is only listed in full on GitHub.
                      </div>
                    )}
                  </div>
                )}

                {tab === "files" && (
                  /*
                   * One screen: the file list and diff on the left, and the
                   * rest of the pull request about THIS file on the right. The
                   * rail folds away under 1180px — three live columns want the
                   * width, and below it the honest thing is to give the diff
                   * the room and leave these in the tabs they came from.
                   */
                  <div className="flex min-h-0 gap-0 items-start h-full">
                  <div className="flex-1 min-w-0 h-full">
                  <FilesTab
                    d={d} root={root} byPath={byPath} loaded={!!diff} diffErr={diffErr} seenFiles={seenFiles} onSeen={toggleSeen}
                    noWs={noWs} onNoWs={(v) => { setNoWs(v); setDiffNoWhitespace(v); }} wsOnly={wsOnly}
                    onSeenMany={setSeenMany}
                    since={since} moved={moved} movedHere={movedHere} wantSince={wantSince}
                    onRefetchSince={() => setSinceTick((n) => n + 1)}
                    sel={selFile} onSel={setSelFile} onShowing={setShowingFile}
                    split={split} wrap={wrap} onSplit={setSplit} onWrap={setWrap} held={held}
                    drafts={myDrafts} onAddDraft={addDraft} onPostOne={postOneComment} onDropDraft={dropDraftItem}
                    onPeek={async (p) => {
                      // The pull request's copy, not the checkout's. A branch
                      // you do not have out means the path is either missing or
                      // a different version of itself, and opening that under
                      // this file's name is the quiet kind of wrong.
                      const r = await api.prFileTemp(root, d.number, p);
                      if (!r.ok || !r.file) { flash(false, r.error || "Could not fetch that file from GitHub"); return; }
                      /* Open it where the changes are, and hand the viewer the
                         rest of them. Landing at line 1 of a nine-hundred-line
                         file you opened BECAUSE of a diff is the step nobody
                         wants to take twice. */
                      const groups = groupPatch(fileSection(diff, p));
                      setPeek({
                        root, path: r.file,
                        label: `${p} · #${d.number} @ ${r.sha?.slice(0, 7)} · read-only`,
                        line: groups[0]?.from ?? 1,
                        groups,
                      });
                    }}
                    busy={busy} onReply={doReply}
                    onApply={doApplySuggestion}
                    onResolve={(t) => act(t.isResolved ? "Unresolve" : "Resolve", () => api.prSetThreadResolved(root, t.id, !t.isResolved))}
                  />
                  </div>
                  <FileRail d={d} path={showingFile ?? selFile}
                    drafts={myDrafts} held={held}
                    /* The window where the held copy is on screen and the
                       refresh has not landed — exactly when an empty answer is
                       a wait rather than a fact. */
                    loading={detailStale}
                    onGoConversation={() => setTab("conversation")}
                    onGoChecks={() => setTab("checks")}
                    onGoReview={() => setTab("review")}
                    /*
                     * From a quote back to the remark it was cut from. The
                     * segment is forced to "all" first: the row you are going to
                     * may be a bot's, and landing on a Conversation filtered to
                     * Humans would scroll to nothing and look like a dead
                     * button. The scroll is deferred a frame because the tab's
                     * content is not in the DOM until React has drawn it.
                     */
                    onGoToMention={(m) => {
                      if (!m.nodeId) return;
                      setConvWho("all");
                      setTab("conversation");
                      requestAnimationFrame(() => {
                        document.querySelector(`[data-node="${CSS.escape(m.nodeId!)}"]`)
                          ?.scrollIntoView({ block: "center", behavior: "smooth" });
                      });
                    }}
                    /*
                     * The verdict, armed from beside the code rather than in a
                     * tab. It is the panel's own draft — the same one the Review
                     * tab writes and the same one that survives a rebuild — so
                     * pressing Approve here and then opening Review shows
                     * Approve already chosen, and there is only ever one verdict
                     * in flight.
                     */
                    /* `myReview.verb` unconditionally, not gated on there
                       being a stored draft: `setMyReview` DELETES the entry when
                       the verb is "comment" and the body is empty, so pressing
                       Comment with nothing typed un-armed the verdict and left
                       all three buttons unlit — the click read as a dead
                       control. The draft defaults to "comment", so the verb is
                       always an answer. */
                    verdict={myReview.verb}
                    onApprove={canReview ? () => setMyReview({ verb: "approve" }) : undefined}
                    onRequestChanges={canReview ? () => setMyReview({ verb: "request_changes" }) : undefined}
                    onComment={canReview ? () => setMyReview({ verb: "comment" }) : undefined}
                    /* The same draft the Review tab holds — see `body` on the
                       rail. Two boxes with two bodies is a way to lose the one
                       you typed in the other. */
                    body={myReview.body} busyWhat={busyWhat}
                    onBody={canReview ? (v: string) => setMyReview({ body: v }) : undefined}
                    /*
                     * The guard stays here, and it is the Review tab's: the rail
                     * cannot see the body being typed, so it cannot know whether
                     * there is anything to send. Everything except an approval
                     * needs words — a "request changes" with nothing in it is a
                     * notification that asks somebody to guess.
                     */
                    onSubmit={canReview ? () => {
                      if (myReview.verb !== "approve" && !myReview.body.trim() && myDrafts.length === 0) {
                        setTab("review");
                        flash(false, "Say something or queue a line first — only an approval can go on its own");
                        return;
                      }
                      void submitReview(myReview.verb, myReview.body);
                    } : undefined}
                    onMerge={() => doMerge(mergeMethod)}
                    awaitingChecks={awaitingChecks}
                    canMerge={d.mergeState === "CLEAN" || d.mergeState === "BEHIND"} />
                  </div>
                )}

                {tab === "checks" && (
                  <Checks
                    d={d} root={root} jobs={jobs} busy={busy} busyWhat={busyWhat}
                    onRerun={() => act("Re-run checks", () => api.prRerun(root, d.number))}
                    onRerunJobs={(what, id) => act("Re-run", () => api.prRerunJobs(root, what, id))}
                    onAsk={onOpenChatWith ? (k) => askClaudeAboutCheck(k) : undefined}
                  />
                )}

                {tab === "review" && canReview && (
                  <ReviewTab
                    d={d} root={root} held={held} drafts={myDrafts} seen={seenFiles.length} busy={busy} busyWhat={busyWhat}
                    draft={myReview} onDraft={setMyReview}
                    onDrop={dropDraft} onSubmit={submitReview} onGoFiles={() => setTab("files")}
                  />
                )}
              </div>
              </CommitJumpCtx.Provider>

            </>
          )}
        </div>
        )}
      </div>
      {peek && <PeekFile peek={peek} onClose={() => setPeek(null)} />}
      {dialog}
      {mergeDialog}
    </div>
    </MentionCtx.Provider>
    </ViewerCtx.Provider>
    </RepoCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

export type { MergeMethod };


/**
 * The two things worth offering on a conflicted pull request.
 *
 * Both need the merge to exist first, so both press the same button and then
 * differ in where they take you: the resolver, or an agent in a terminal. The
 * preparation is idempotent — a second press adopts the worktree the first one
 * cut — so the pair can be pressed in either order, and the one you did not
 * press stays available.
 */
function ConflictActions({ root, number, branch, base, disabled }: {
  root: string; number: number; branch: string; base: string; disabled?: boolean;
}) {
  const [busy, setBusy] = useState<"" | "open" | "claude">("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const prepare = async (): Promise<{ root: string; conflicts: string[]; clean: boolean } | null> => {
    setErr(""); setNote("");
    const r = await api.prConflict(root, number)
      .catch(() => ({ ok: false, error: "Could not reach the server" } as Awaited<ReturnType<typeof api.prConflict>>));
    if (!r.ok || !r.root) { setErr(r.error || "Could not prepare the merge"); return null; }
    return { root: r.root, conflicts: r.conflicts ?? [], clean: !!r.clean };
  };

  return (
    <>
      <Btn onClick={async () => {
          setBusy("open");
          const p = await prepare();
          setBusy("");
          if (!p) return;
          // Nothing to resolve is a real outcome: the merge went through, and
          // saying so beats opening a resolver with an empty list in it.
          if (p.clean) { setNote(`Merged cleanly in ${p.root.split("/").pop()} — nothing to resolve, just push it`); return; }
          requestWorktreeJump({ view: "git", root: p.root });
        }} disabled={disabled || !!busy} warn
        title={`Merge ${base} into ${branch} in a worktree of its own, and open it here. Your checkout is not touched.`}>
        {busy === "open" ? "Preparing…" : "⚡ Resolve conflicts"}
      </Btn>
      <Btn onClick={async () => {
          setBusy("claude");
          const p = await prepare();
          setBusy("");
          if (!p) return;
          if (p.clean) { setNote(`Merged cleanly in ${p.root.split("/").pop()} — nothing to resolve, just push it`); return; }
          // The same briefing the git panel writes, in a tmux window sitting in
          // the worktree the conflict is actually in — which is the difference
          // between an agent that can fix it and one being told about it.
          requestTermIssue(
            p.root,
            `conflict-${number}`,
            [
              // The briefing reads two things off this — the branch's name and
              // what it was cut from — and a pull request knows both.
              ...conflictBriefing(
                p.root,
                { name: branch, base, upstream: null, ahead: 0, behind: 0, detached: false },
                undefined, "merging", p.conflicts,
              ),
              ...CONFLICT_ASK,
            ].join("\n"),
            true,
          );
          // It opens somewhere you are not looking. Without this the button
          // did its whole job in silence and read as broken.
          setNote(`Claude is on it in a tmux window — "conflict-${number}", in ${p.root.split("/").pop()}`);
        }} disabled={disabled || !!busy}
        title={`Open a tmux window in that worktree with Claude, told which side is which and which files are in conflict.`}>
        {busy === "claude" ? "Preparing…" : "✦ Hand to Claude in a terminal"}
      </Btn>
      {/* On its own line, full width. Squeezed between the buttons it pushed
          them apart and ran off the row — and the sentences that matter here
          are the long ones: they name a path and say what to do with it. */}
      {(err || note) && (
        <span className="basis-full text-[10.5px] leading-snug pt-1" style={{ color: err ? "var(--error)" : "var(--text3)" }}>
          {err || note}
        </span>
      )}
    </>
  );
}

function Overview({ d, root, busy, busyWhat, mergeWork, openThreads, conversationCount, behind, behindAsking, localHead, conflictFiles, method, onMethod, onLocalReview, onReviewInTerminal, onMerge, onClose, onUpdateBranch, onRerun, onAutoMerge, onCancelAutoMerge, onDraft, onGoThreads, onGoMoved, movedSince, onEditRequest, onToggleTask, awaitingChecks }: {
  d: PrDetail;
  /** The checkout this pull request is being read from — where a conflict would
   *  be prepared. */
  root: string;
  busy: boolean;
  /** What the merge is doing, "" when it is not running. `busy` cannot answer
   *  this: it is true for every action on the panel, so a merge button reading
   *  it would say "Merging…" while a comment was being posted. */
  mergeWork: string;
  openThreads: number; conversationCount: number;
  /** How many commits the branch is behind its base, once asked. Null while the
   *  question is still out, which is why the button appears a beat late rather
   *  than the whole page arriving late. */
  behind: number | null;
  /** The local copy of the head branch, or null while the question is out. */
  localHead: PrLocalHead | null;
  /** Which files would conflict, and whether the answer came from a fetch that
   *  worked. Null while the question is out, or when there is no conflict. */
  conflictFiles: { files: string[]; stale: boolean; resolvedLocally?: { branch: string; ahead: number } } | null;
  /** How this repository merges. Owned by the panel, not by this component, so
   *  it survives the Files tab and is remembered for next time. */
  method: MergeMethod; onMethod: (m: MergeMethod) => void;
  onLocalReview: (recipe?: string) => void;
  /** The terminal half of the same choice. Absent where there is no terminal —
   *  the phone — and the button then behaves as it always did. */
  onReviewInTerminal?: (recipe?: string) => void; onMerge: (method: MergeMethod) => void; onClose: () => void;
  onRerun: () => void; onAutoMerge: () => void; onCancelAutoMerge: () => void; onDraft: () => void; onGoThreads: () => void;
  /** Open Files with the "since your review" filter already on. */
  onGoMoved: () => void;
  /** How many of this review's files have changed since your own last review — see
   *  sinceRange. Zero when there is no review of yours, or nothing has moved. */
  movedSince: number;
  /** Still asking how far behind the branch is. The row keeps its place and
   *  says it is working, rather than growing a button a second later. */
  behindAsking?: boolean;
  /** The `act` label of the request in flight, so the button that started it is
   *  the one that spins. */
  busyWhat?: string;
  onUpdateBranch: (syncLocal: boolean) => void;
  onEditRequest: () => void;
  /** A real, clickable checkbox on the description's own checklist — GitHub's
   *  own behaviour, not an edit of the whole body for one tick. Absent while
   *  another write is already running, same as every other action here. */
  onToggleTask?: (newBody: string) => void;
  /** This panel pushed to the branch a moment ago, so runs are expected — see
   *  the note on `pushed`. */
  awaitingChecks?: boolean;
}) {
  const c = d.checks;
  const [allFiles, setAllFiles] = useState(false);
  const canMerge = d.mergeState === "CLEAN";
  /*
   * Behind the base branch is a state GitHub lets you merge from, and we did
   * not.
   *
   * `BEHIND` means the base has moved since this branch last took it — not that
   * anything conflicts, which is `DIRTY`. GitHub's own button is enabled here
   * unless the repository requires branches to be up to date, and the merge
   * succeeds. Disabling it meant a round trip through "Update branch" for a
   * pull request that was going to merge cleanly either way.
   *
   * Offered, not made equal: the button says so in its own colour and asks
   * before it goes, because the thing you are giving up is real — the checks
   * that passed ran against the OLD base, so nobody has tested this exact
   * combination.
   */
  const isBehind = d.mergeState === "BEHIND";
  /*
   * What the checks actually add up to, which is NOT the same question as
   * GitHub's mergeable state — and an empty list is the case where the two
   * disagree hardest. See mergeReason.ts.
   */
  const standing = checksStanding(c, awaitingChecks);
  // Green only when the checks say so too. GitHub calls a pull request CLEAN
  // the moment nothing is blocking it, including before any run exists.
  const allClear = canMerge && standing === "green";
  const verdict = mergeVerdict(d.mergeState, c, awaitingChecks);
  const [confirmBehind, setConfirmBehind] = useState(false);
  // Any change to which pull request is on screen closes the question, so a
  // "yes" can never be answered for a different one than it was asked about.
  useEffect(() => { setConfirmBehind(false); }, [d.number, d.mergeState]);
  // Only the methods this repository permits. Offering one it forbids is a
  // button whose failure you can only discover by pressing it.
  const methods = allowedMethods(d.mergePolicy);
  // Auto-merge is a repository setting that is off by default, and arming it
  // where it is off comes back as a GraphQL mutation name. Say so before the
  // press instead of after it.
  const autoOff = d.mergePolicy ? !d.mergePolicy.auto : false;
  // What the Update button says, and whether it brings this machine along.
  const updateMove = updateBranchMove(behind, d.baseRefName, localHead ?? undefined);
  /**
   * There are conflicts, so nothing on this row that asks GitHub to move the
   * branch may be offered.
   *
   * Not a matter of tidiness. "Update branch" merges the base into the head —
   * the very operation that is already known to conflict — and lands a broken
   * merge on GitHub, in a branch, from a click. The merge buttons come back
   * refused, but only after the confirmation, which teaches you that the
   * confirmation means nothing. Both are removed rather than disabled: a
   * greyed control that is never going to be available in this state is just a
   * thing to wonder about.
   */
  /*
   * git merged the pushed refs a moment ago and found nothing.
   *
   * GitHub computes `mergeable` lazily and keeps the old answer for a while
   * after a push, so "CONFLICTING" survives the very commit that fixed it —
   * measured on #329, which stayed blocked here after the merge was resolved,
   * committed and pushed. When our own merge-tree of the SAME refs GitHub is
   * talking about comes back clean, and the fetch that got them succeeded, git
   * is simply the fresher of the two.
   *
   * `!stale` is what makes that safe: a failed fetch means the refs are from
   * whenever they last came down, and overriding GitHub on the strength of an
   * old copy would be guessing in the direction that unblocks a merge.
   */
  const gitSaysClean = !!conflictFiles && !conflictFiles.stale && conflictFiles.files.length === 0;

  const conflicted = (d.mergeable === "CONFLICTING" && !gitSaysClean)
    // Or because we merged the two trees ourselves and found out. GitHub
    // computes `mergeable` lazily and answers UNKNOWN until somebody asks
    // twice — measured on this repository's own open pull request #464, which
    // GitHub called UNKNOWN while git named the one file it conflicts in. A
    // gate that waits for GitHub to make its mind up is a gate that is open
    // exactly when the answer matters most.
    //
    // A stale answer does not get a vote: if the fetch failed, what is on
    // screen is from whenever the refs were last pulled down, and taking
    // buttons away on that basis would be guessing.
    || (!!conflictFiles && !conflictFiles.stale && conflictFiles.files.length > 0);

  // Whether "Update branch" is offered at all — asked once, because the button
  // and the line that explains what it will not touch have to appear and
  // disappear together.
  const canUpdate = !conflicted && ((behind ?? 0) > 0 || d.mergeState === "BEHIND") && d.viewerCanUpdate !== false;


  return (
    <div className="flex flex-col gap-3">
      {/*
        * "Three of these forty files moved since you reviewed them."
        *
        * The number that decides how a second pass starts, and it was only reachable
        * by opening the Files tab and noticing a chip. Here it is a sentence with the
        * trip attached: pressing it opens Files with the filter already on, which is
        * the whole errand.
        */}
      {movedSince > 0 && (
        <Reason tint="var(--warning)" glyph="↻"
          action={<button onClick={onGoMoved} style={{ color: "var(--primary)" }}>Show them</button>}>
          <b style={{ color: "var(--warning)" }}>{movedSince}</b>
          {movedSince === 1 ? " file has" : " files have"} changed since your review
        </Reason>
      )}

      {d.forcePushedSinceReview && (
        <div className="text-[10.5px] px-2.5 py-2 rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          The author force-pushed after the last review — that review was for code that is no longer here.
        </div>
      )}

      {/* Merged and closed pull requests are history: there is nothing to merge,
          no branch to update, and no draft to go back to. Offering those buttons
          was not just clutter, it was a lie — "Merging is blocked, GitHub has
          not finished working it out" on a pull request that merged an hour ago.
          What is left is what GitHub leaves: what happened, and reopen. */}
      {d.state !== "OPEN" ? (
        <section className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
          <div className="flex gap-2.5 items-start p-3">
            <span className="shrink-0 rounded-full flex items-center justify-center text-[13px]"
              style={{ width: 26, height: 26, background: d.state === "MERGED" ? "var(--primary)" : "color-mix(in srgb, var(--text3) 60%, transparent)", color: "var(--bg)" }}>
              {d.state === "MERGED" ? "⏣" : "⊘"}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold leading-tight" style={{ color: "var(--text)" }}>
                {d.state === "MERGED" ? "Merged" : "Closed without merging"}
              </span>
              <span className="block text-[11px] mt-1.5" style={{ color: "var(--text3)" }}>
                {d.state === "MERGED"
                  ? `${d.mergedBy ? `${d.mergedBy} merged ` : "Merged "}into ${d.baseRefName}${d.mergedAt ? ` ${ago(d.mergedAt)}` : ""}`
                  : `This branch was never merged into ${d.baseRefName}${d.closedAt ? ` · closed ${ago(d.closedAt)}` : ""}`}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap px-3 py-2.5"
            style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
            {d.state === "CLOSED" && <Btn onClick={onClose} disabled={busy} pending={busyWhat === "Reopen"} title="Put it back to open, with its comments and reviews intact">↺ Reopen</Btn>}
            <a href={externalUrl(d.url)} target="_blank" rel="noreferrer noopener" className="text-[10.5px] px-2.5 py-1 rounded"
              style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>Open on GitHub ↗</a>
          </div>
        </section>
      ) : (
      <section className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
        <div className="flex gap-2.5 items-start p-3">
          <span className="shrink-0 rounded-full flex items-center justify-center text-[13px]"
            style={{ width: 26, height: 26,
              background: allClear ? "var(--success)"
                : canMerge && standing === "awaiting" ? "var(--warning)"
                : canMerge ? "var(--text3)"
                : isBehind ? "var(--warning)" : "var(--error)",
              color: "var(--bg)" }}>
            {allClear ? "✓" : canMerge && standing === "awaiting" ? "◯" : canMerge ? "·" : "!"}
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold leading-tight" style={{ color: "var(--text)" }}>
              {/* The shared ladder, so this box and the rail beside the diff
                  cannot reach different verdicts about the same rollup — they
                  did, on two of three cases. The blocked arms keep Overview's
                  own short headlines: there is room for a reason underneath
                  here and there is not in a 320px column. */}
              {verdict.blocked
                ? (isBehind ? "Behind the base branch" : "Merging is blocked")
                : verdict.line}
            </span>
            <span className="block text-[11px] mt-1.5" style={{ color: "var(--text3)" }}>
              {allClear ? "Nothing is standing in the way"
                : canMerge ? standingLine(standing, undefined)
                : isBehind ? `You can merge anyway — ${mergeBlockedWhy(d.mergeState, c).replace(/^The base branch has moved — /, "")}`
                : mergeBlockedWhy(d.mergeState, c)}
            </span>
          </span>
        </div>

        <div style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          {/*
            * WHAT THE REVIEWER DECIDED, first, and drawn even when something
            * else is blocking.
            *
            * This box used to list only obstacles, and a pull request approved
            * sixteen hours earlier read as unapproved: "has this PR of mine been
            * approved... because in the overview it looks like it hasn't". It had been. A
            * failing check and five open threads were on screen; the approval
            * was not, anywhere.
            *
            * Blocked and approved are different facts and both were true — the
            * reviewer decided, CI had not caught up. Showing only the blocking
            * one answers "can I merge" and drops "has anybody looked", which is
            * the question asked first and the only one a person has to answer.
            *
            * FIRST in the list because it is the fact with a human behind it.
            * The rest of these rows are things a machine noticed.
            */}
          {(() => {
            /*
             * ONE SOURCE, and the reason this had to change.
             *
             * The board said "Waiting on bjorn" and this box said
             * "Reviewed, no verdict by the author" about the same pull request,
             * because they asked two different things: the card reads
             * `humanReview`, computed on the server from the reviews, and this
             * read `reviewVerdict` over the roster in the browser. Both were
             * defensible and they disagreed, which makes the app the thing you
             * cannot trust — "it makes no sense".
             *
             * `humanReview` wins because it knows what the browser cannot: who
             * the AUTHOR is (their own comments are not a review), and who is
             * still outstanding (a request GitHub drops the moment it is
             * answered). Both facts are what made the board's answer the right
             * one.
             *
             * ALL FOUR STATES GET THE BAND. Approved was a band and changes
             * requested was a grey line with a cross — same weight for the same
             * kind of fact, which is what was asked for and what makes the two
             * screens finally read alike.
             */
            const v = p2Verdict(d.humanReview, reviewerRoster(d));
            if (!v) return null;
            return (
              <div className="flex gap-2.5 items-center px-3 py-2 text-[12px]"
                style={{
                  background: `color-mix(in srgb, ${v.tint} 10%, transparent)`,
                  borderLeft: `2px solid ${v.tint}`,
                }}>
                <span className="shrink-0 grid place-items-center rounded-full text-[12px]"
                  style={{ width: 22, height: 22, background: v.tint, color: "var(--bg)" }}>
                  {v.glyph}
                </span>
                <span className="min-w-0 flex-1">
                  <b style={{ color: "var(--text)", fontWeight: 600 }}>{v.head}</b>
                  {v.who && <span style={{ color: "var(--text2)" }}>{" by "}{v.who}</span>}
                  {v.note && (
                    <span className="block text-[11px] mt-0.5" style={{ color: "var(--text3)" }}>{v.note}</span>
                  )}
                </span>
                {v.url && (
                  <button className="agx-btn shrink-0 rounded px-1.5 py-0.5 text-[11px]"
                    style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}
                    title="Open the review itself on GitHub"
                    onClick={() => openExternal(v.url!)}>Go to it ↗</button>
                )}
              </div>
            );
          })()}
          {openThreads > 0 && (
            <Reason tint="var(--warning)" glyph="◯" action={<button onClick={onGoThreads} style={{ color: "var(--primary)" }}>Go to thread</button>}>
              {openThreads} review thread{openThreads === 1 ? "" : "s"} still open — <span style={{ color: "var(--text3)" }}>a reply is not a resolve</span>
            </Reason>
          )}
          {c.failure > 0 && (
            <Reason tint="var(--error)" glyph="✕">{c.failing.slice(0, 2).map((f) => f.name).join(", ")}{c.failing.length > 2 ? ` +${c.failing.length - 2} more` : ""} failing</Reason>
          )}
          {/* Not "N checks passed" while some are still going. That line sat
              directly under a header saying merging was blocked, and the two
              disagreed inside one box — see mergeReason.ts. */}
          {/* Said in the box as well as on the button, because the button is
              where you decide and this is where you find out what you are
              deciding. Only while the question is being asked — before that it
              is a warning about something nobody has proposed. */}
          {isBehind && confirmBehind && (
            <Reason tint="var(--warning)" glyph="!"
              action={<button onClick={() => setConfirmBehind(false)} style={{ color: "var(--text3)" }}>Cancel</button>}>
              <b style={{ color: "var(--text)", fontWeight: 500 }}>Merging behind {d.baseRefName}</b>
              {behind ? ` by ${behind} commit${behind === 1 ? "" : "s"}` : ""} — the checks that passed ran against
              the old base, so this exact combination is untested. Press again to go ahead.
            </Reason>
          )}
          {checksLine(c, d.mergeable === "MERGEABLE" ? d.baseRefName : undefined) && (
            <Reason tint={c.pending > 0 ? "var(--warning)" : "var(--success)"} glyph={c.pending > 0 ? "◯" : "✓"}>
              {checksLine(c, d.mergeable === "MERGEABLE" ? d.baseRefName : undefined)}
            </Reason>
          )}
          {/* WHICH files, not just that there are some. GitHub says a pull
              request conflicts and never says where, which leaves you opening
              a worktree to find out whether it is one lockfile or half the
              codebase — a different afternoon either way. Five, because a
              summary that scrolls is not one; the rest is one click. */}
          {/*
            * You have already settled this, here, and not pushed it.
            *
            * GitHub is not stale when it says the pull request conflicts — the
            * merge commit is on this disk and nowhere else, so its answer is
            * correct and useless. What was missing is that the app is looking
            * at the same disk: it can see the base is already merged into the
            * local branch, and it was repeating GitHub's verdict instead of
            * saying so. "Merging is blocked" is true of GitHub and false of
            * you, and the difference is one push.
            */}
          {conflictFiles?.resolvedLocally && conflictFiles.resolvedLocally.ahead > 0 && (
            <Reason tint="var(--success)" glyph="✓">
              <b style={{ color: "var(--text)", fontWeight: 500 }}>Resolved here, not pushed</b>
              {" — "}
              <span className="font-mono">{conflictFiles.resolvedLocally.branch}</span> already has
              {" "}{d.baseRefName} merged into it, {conflictFiles.resolvedLocally.ahead} commit
              {conflictFiles.resolvedLocally.ahead === 1 ? "" : "s"} ahead of what GitHub has.
              <span className="block mt-1" style={{ color: "var(--text3)" }}>
                Push that branch and everything below clears on its own. Until then GitHub is right:
                the merge it would attempt is the one that conflicted.
              </span>
            </Reason>
          )}

          {/* Pushed, and GitHub has simply not recomputed. Said plainly rather
              than left as a red banner nobody can act on: there is nothing to
              do here but wait, and a warning you cannot act on is one you learn
              to scroll past. */}
          {d.mergeable === "CONFLICTING" && gitSaysClean && (
            <Reason tint="var(--success)" glyph="✓">
              <b style={{ color: "var(--text)", fontWeight: 500 }}>Already resolved</b> — git merged
              {" "}{d.headRefName} into {d.baseRefName} just now and found nothing to settle.
              <span className="block mt-1" style={{ color: "var(--text3)" }}>
                GitHub still says it conflicts; it works that out lazily and keeps the old answer for
                a minute or two after a push. Nothing to do.
              </span>
            </Reason>
          )}

          {conflictFiles && conflictFiles.files.length > 0 && (
            <Reason tint={conflictFiles.resolvedLocally ? "var(--text3)" : "var(--error)"}
              glyph={conflictFiles.resolvedLocally ? "·" : "!"}
              action={conflictFiles.files.length > 5
                ? <button onClick={() => setAllFiles((v) => !v)} style={{ color: "var(--primary)" }}>
                    {allFiles ? "Show less" : `+${conflictFiles.files.length - 5} more`}
                  </button>
                : undefined}>
              <b style={{ color: "var(--text)", fontWeight: 500 }}>
                {conflictFiles.files.length} file{conflictFiles.files.length === 1 ? "" : "s"}
              </b> conflict with {d.baseRefName}
              {conflictFiles.stale && <span style={{ color: "var(--text3)" }}> (from your last fetch — GitHub could not be reached)</span>}
              <span className="block mt-1 font-mono text-[10.5px]" style={{ color: "var(--text2)" }}>
                {(allFiles ? conflictFiles.files : conflictFiles.files.slice(0, 5)).map((f) => (
                  <span key={f} className="block truncate" title={f}>{f}</span>
                ))}
              </span>
            </Reason>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap px-3 py-2.5"
          style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
          {/* The methods this repository allows, opening on the one GitHub's
              own button opens on. It used to be all three regardless and it
              always opened on squash — which is both the method a repository
              is most likely to forbid and, on a repository whose convention is
              the merge commit, the opposite of what pressing the blue button
              does. The choice is the panel's, so it survives the Files tab and
              is still there tomorrow. */}
          {!conflicted && (
          <span className="flex items-center rounded overflow-hidden shrink-0" style={{ border: "1px solid var(--primary)" }}>
            <button onClick={() => { if (isBehind && !confirmBehind) { setConfirmBehind(true); return; } onMerge(method); }}
              /* `mergeWork` as well as `busy`, and it is not redundant: the card
                 move runs AFTER the merge action has settled, so for those
                 seconds `busy` is false again and the button was live while the
                 second half of its own operation was still in flight. */
              disabled={busy || !!mergeWork || (!canMerge && !isBehind)}
              title={mergeWork
                ? (mergeWork === MOVING_CARD
                  ? "The pull request is merged. Moving its ClickUp card to the merged status — if this part fails, the merge still stands."
                  : "Merging…")
                : canMerge
                ? `${MERGE_LABEL[method]}${d.mergePolicy?.deletesBranch ? " — GitHub deletes the branch" : " and delete the branch"}`
                : isBehind
                  ? `${d.baseRefName} has moved on${behind ? ` by ${behind} commit${behind === 1 ? "" : "s"}` : ""}. The checks that passed ran against the old base — merging now is untested in this combination.`
                  // The tooltip on the disabled button is where somebody looks
                  // FIRST — it said "A check is failing" over 46 green ones.
                  : mergeBlockedWhy(d.mergeState, c)}
              className="agx-btn text-[10.5px] px-2.5 py-1 disabled:opacity-40"
              /* Striped, not merely a different colour. A colour alone is a
                 thing you have to have learned; a hazard stripe is one nobody
                 mistakes for the ordinary button, and it survives a palette
                 where the accent and the warning are close. */
              style={canMerge && standing === "awaiting"
                ? {
                    // Same hazard stripe as the behind case, and for the same
                    // reason: this is a merge you can perform and probably
                    // should not yet.
                    background: "repeating-linear-gradient(135deg, var(--warning) 0 7px, color-mix(in srgb, var(--warning) 62%, var(--bg)) 7px 14px)",
                    color: "var(--bg)", fontWeight: 600,
                  }
                : isBehind
                ? {
                    background: "repeating-linear-gradient(135deg, var(--warning) 0 7px, color-mix(in srgb, var(--warning) 62%, var(--bg)) 7px 14px)",
                    color: "var(--bg)", fontWeight: 600,
                  }
                : { background: "var(--primary)", color: "var(--bg)", fontWeight: 500 }}>
              {mergeWork
                ? (
                  /* The ring the rest of the app spins, sized to a 10.5px
                     button and tinted to the button's own foreground —
                     `.agx-spin` is drawn in `--primary`, which is this
                     button's BACKGROUND and would have been an invisible
                     spinner on the one control that most needs one. */
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="agx-spin shrink-0"
                      style={{ width: 9, height: 9,
                        borderColor: "color-mix(in srgb, currentColor 30%, transparent)",
                        borderTopColor: "currentColor" }} />
                    {mergeWork}
                  </span>
                )
                : isBehind ? (confirmBehind ? "Merge anyway?" : `${MERGE_LABEL[method]} · behind`) : MERGE_LABEL[method]}
            </button>
            {methods.length > 1 && (
              <Select
                value={method}
                onChange={(v: string) => onMethod(v as MergeMethod)}
                options={methods.map((m) => ({ value: m, ...MERGE_OPTION[m] }))}
                title="Merge method"
                align="right"
                className="text-[10.5px] px-1.5 py-1 outline-none"
                style={{ background: "var(--primary)", color: "var(--bg)", borderLeft: "1px solid color-mix(in srgb, var(--bg) 35%, transparent)" }}
                placeholder=""
              />
            )}
          </span>
          )}
          {/* Auto-merge stays only to be CANCELLED: something armed before the
              conflict appeared is still armed, and taking the button away
              would leave it armed with no way to disarm it. Arming a new one
              over a conflict is not offered. */}
          {d.autoMerge
            ? <Btn onClick={onCancelAutoMerge} disabled={busy} warn pending={busyWhat === "Auto-merge cancelled"} title={`Armed by ${d.autoMerge.enabledBy}`}>Cancel auto-merge</Btn>
            : !conflicted && (
              /* The right button in the waiting window, so it says so there.
                 Somebody who has just restarted CI and wants to stop thinking
                 about this pull request is asking for exactly this. */
              <Btn onClick={onAutoMerge} disabled={busy || autoOff} pending={busyWhat === "Auto-merge"}
                title={autoOff
                  ? "Auto-merge is off for this repository — Settings › General › Pull requests › Allow auto-merge"
                  : awaitingChecks
                    ? `Arm it now and walk away — ${MERGE_LABEL[method].toLowerCase()} the moment the checks that are starting come back green`
                    : `${MERGE_LABEL[method]} automatically once everything passes`}>
                Merge when green
              </Btn>
            )}
          {/*
            * Only when the branch is genuinely behind — and "behind" is a
            * COUNT, not a merge state.
            *
            * This was gated on `mergeState === "BEHIND"` and vanished on the
            * pull requests that needed it most. GitHub reports BEHIND only
            * where the repository requires branches to be up to date before
            * merging; without that protection a branch 194 commits behind its
            * base reports CLEAN. Measured on exactly such a pull request, which
            * is how the button came to be missing from one somebody could see
            * was stale.
            *
            * So the count is asked for separately (see api.prBehind) and the
            * offer says how far, because "Update branch" and "Update branch,
            * you are 194 commits back" are different sentences. The old gate is
            * kept alongside it: on a protected repository BEHIND arrives with
            * the detail, before the count does.
            *
            * viewerCanUpdate stays (undefined = allow): a branch you cannot
            * write to should not offer an action that only comes back "cannot
            * change this locked branch".
            */}
          {/*
            * A conflict is the one blocked state with somewhere to go.
            *
            * Everything else on this row asks GitHub to do something. This one
            * cannot: GitHub is only PREDICTING the conflict, and until the
            * merge exists somewhere there is nothing for any resolver to
            * resolve. So it makes the merge — in a worktree of its own, never
            * the checkout you are standing in — and takes you to the panel that
            * already knows how to work through one, or hands it to an agent in
            * a terminal, which is the other half of what people do with a
            * conflict.
            */}
          {d.mergeable === "CONFLICTING" && (
            <ConflictActions root={root} number={d.number} branch={d.headRefName} base={d.baseRefName} disabled={busy} />
          )}
          {/*
            * The space the answer will fill, while it is being fetched.
            *
            * How far behind the branch is arrives after the pull request does,
            * so this button used to appear out of nowhere and push the rest of
            * the row sideways. Reported as: if we know something is loading,
            * say so there instead of springing a control on somebody.
            */}
          {!canUpdate && behindAsking && !conflicted && d.viewerCanUpdate !== false && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10.5px]"
              style={{ color: "var(--text4)", border: "1px dashed color-mix(in srgb, var(--text) 18%, transparent)" }}>
              <span className="agx-spin" aria-hidden style={{ width: 8, height: 8, borderWidth: 1.5 }} />
              Checking the base…
            </span>
          )}
          {canUpdate && (
            /*
             * Not while the last push is still landing.
             *
             * This button pushes a merge of the base onto the branch, and every
             * push restarts CI. Pressed twice in the window where the checks
             * have not appeared yet — which is exactly the window where the
             * panel used to look green and finished — it throws away a run that
             * had already started and begins another. The behind count is also
             * stale in that window, so the second press is usually for a gap
             * that has already been closed.
             */
            <Btn onClick={() => onUpdateBranch(updateMove.syncLocal)} disabled={busy || !!awaitingChecks} warn
              pending={busyWhat === "Update branch"}
              title={awaitingChecks
                ? "The branch was just updated — waiting for the checks to start. Pushing again would restart them."
                : updateMove.title}>
              {updateMove.label}</Btn>
          )}
          {/* Only with something to re-run. `failure > 0` already implies the
              rollup is populated, so this cannot appear over an empty one. */}
          {c.failure > 0 && <Btn onClick={onRerun} disabled={busy || !!awaitingChecks} pending={busyWhat === "Re-run checks"}
            title={awaitingChecks ? "A new run is already starting from the update" : "Run the failed checks again"}>
            Re-run failed</Btn>}
          <span className="ml-auto flex gap-1.5">
            <Btn onClick={onDraft} disabled={busy} small pending={busyWhat === "Mark ready" || busyWhat === "Convert to draft"}>{d.isDraft ? "Mark ready" : "To draft"}</Btn>
            <Btn onClick={onClose} disabled={busy} danger small pending={busyWhat === "Close"}>Close</Btn>
          </span>
          {/* Last in the row, so its own line is UNDER everything rather than
              between the update button and the pair pinned to the right — which
              is what happened when it sat next to the button that earns it. It
              names a path, so it needs the width. */}
          {canUpdate && updateMove.note && (
            <span className="basis-full text-[10.5px] leading-snug" style={{ color: "var(--text3)" }}>
              {updateMove.note}
            </span>
          )}
        </div>
      </section>
      )}

      <Description d={d} busy={busy} onEdit={onEditRequest} onToggleTask={onToggleTask} />

      <div className="flex gap-1.5 flex-wrap items-center">
        {/* The same two destinations the masthead offers. Two buttons with the
            same name and the same icon behaving differently depending on which
            one you press is worse than neither of them asking: you learn that
            this control lets you choose, and then one of them does not. */}
        {/* One component for both copies of this button. They used to be two
            hand-written menus with the same name, which is how they came to
            offer the same two things in a different order and in different
            alphabets — twice, because the first fix only reached one of
            them. */}
        <ReviewMenu d={d} canTerm={!!onReviewInTerminal}
          onPick={(recipe, where) => (where === "term" ? onReviewInTerminal?.(recipe) : onLocalReview(recipe))} />
        {/* The panel's own Btn, like its neighbour. A hand-rolled anchor with
            its own padding beside a Btn is two heights in a row of two. */}
        {/* `small`, like the Menu it stands beside. Without it this was the
            28px variant next to a 24px one — measured in the running window,
            which is where this should have been checked three attempts ago
            instead of in the stylesheet. */}
        <Btn small onClick={() => openExternal(d.url)} title="Open on GitHub">GitHub ↗</Btn>
      </div>

      {/* Where to go next. Overview answers "can this land"; the conversation is
          usually the reason it cannot, and it should not need finding. */}
      <button onClick={onGoThreads}
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left agx-btn"
        style={{ border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)", background: "color-mix(in srgb, var(--primary) 7%, transparent)" }}>
        <span className="min-w-0">
          <span className="block text-[10px] uppercase tracking-[.13em]" style={{ color: "var(--text3)" }}>Next</span>
          <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>Conversation</span>
        </span>
        <span className="ml-auto text-[10.5px] shrink-0" style={{ color: "var(--primary)" }}>
          {conversationCount === 0 ? "Nothing said yet" : `${conversationCount} comment${conversationCount === 1 ? "" : "s"} and thread${conversationCount === 1 ? "" : "s"}`} →
        </span>
      </button>
    </div>
  );
}

/**
 * The description, and a way to fix it without leaving.
 *
 * Write/Preview rather than a bare textarea: a description is markdown, and
 * finding out how it renders by saving it and looking is not a review flow.
 */
function Description({ d, busy, onEdit, onToggleTask }: {
  d: PrDetail; busy: boolean; onEdit: () => void;
  /** Absent while a write is already running — see the call site. */
  onToggleTask?: (newBody: string) => void;
}) {
  return (
    /* `data-pr-body` is an address, like `data-node` on a timeline entry: a
       mention that lives in the description has to be scrollable-to as well.
       See the jump in the panel. */
    <section data-pr-body className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
      <div className="flex items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        <span className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>description</span>
        {/* Opening the editor is the shell's to do — it takes the whole column,
            so the click has to leave this box entirely. */}
        <span className="ml-auto"><Btn onClick={onEdit} disabled={busy} small>✎ Edit</Btn></span>
      </div>
      <div className="p-3">
        {/* No checklist meter. The boxes are right there, ticked or not, three
            lines below — a bar counting them said nothing the list did not, and
            it said it above the description, where the description should be. */}
        {d.body.trim() ? <Md body={d.body} onToggleTask={busy ? undefined : onToggleTask} /> : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No description.</div>}
      </div>
    </section>
  );
}

/** One toolbar key. `onMouseDown`-preventDefault is the whole trick: a plain
 *  click would blur the textarea first, wiping the selection the transform
 *  needs — so the button never takes focus, and the caret stays where it was. */
function TB({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="agx-btn rounded flex items-center justify-center text-[11px] w-7 h-7 shrink-0"
      style={{ color: "var(--text2)" }}>
      {children}
    </button>
  );
}
function TBSep() {
  return <span className="mx-1 h-4 w-px shrink-0" style={{ background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />;
}

/**
 * The description editor, full-column. A GitHub-style formatting toolbar, and a
 * textarea that fills every pixel of height it is handed and cannot be dragged
 * bigger or smaller — the height belongs to the column, not to a resize grip.
 * Write/Preview and Cancel/Save stay pinned however long the body runs.
 *
 * Images still cannot be uploaded (GitHub has no public attachment API), so the
 * paperclip says so and offers the one thing that works — the same call the
 * comment composer makes.
 */
function BodyEditor({ prNumber, initial, busy, onSave, onCancel, onOpenGithub }: {
  prNumber: number; initial: string; busy: boolean;
  onSave: (body: string) => Promise<boolean>; onCancel: () => void; onOpenGithub: () => void;
}) {
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== initial;

  const save = async () => {
    if (!dirty) { onCancel(); return; }
    setSaving(true);
    // The parent flips edit-mode off when this resolves true; on false we stay
    // put with the text intact so nothing typed is lost to a failed save.
    await onSave(text);
    setSaving(false);
  };

  /** Every toolbar button ends here: read the selection, transform it, write it
   *  back, then re-select so you can keep typing. Without the reselect the caret
   *  jumps to the end and the toolbar is a one-click-only affair. */
  const edit = (fn: (sel: string, start: number, end: number) => { text: string; start: number; end: number }) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const r = fn(text.slice(s, e), s, e);
    setText(r.text);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.start, r.end); });
  };

  const wrap = (mark: string, ph = "text") => edit((sel, s, e) => {
    const body = sel || ph;
    const out = text.slice(0, s) + mark + body + mark + text.slice(e);
    const start = s + mark.length;
    return { text: out, start, end: start + body.length };
  });

  const code = () => edit((sel, s, e) => {
    const before = text.slice(0, s), after = text.slice(e);
    if (sel.includes("\n") || sel === "") {
      const body = sel || "code";
      const out = before + "```\n" + body + "\n```" + after;
      const start = before.length + 4;
      return { text: out, start, end: start + body.length };
    }
    const out = before + "`" + sel + "`" + after;
    return { text: out, start: s + 1, end: s + 1 + sel.length };
  });

  const link = () => edit((sel, s, e) => {
    const label = sel || "text";
    const out = text.slice(0, s) + "[" + label + "](url)" + text.slice(e);
    const start = s + 1 + label.length + 2; // caret lands on `url`
    return { text: out, start, end: start + 3 };
  });

  /** Line-prefix tools (headings, quote, lists). A toggle: if every touched
   *  line already carries its prefix, strip it — same as GitHub's toolbar. */
  const prefixLines = (mark: (i: number) => string) => edit((sel, s, e) => {
    const startOfLine = text.lastIndexOf("\n", s - 1) + 1;
    const head = text.slice(0, startOfLine);
    const block = text.slice(startOfLine, e);
    const after = text.slice(e);
    const lines = block.split("\n");
    const marks = lines.map((_, i) => mark(i));
    const on = lines.every((l, i) => l.startsWith(marks[i]));
    const out = lines.map((l, i) => on ? l.slice(marks[i].length) : marks[i] + l).join("\n");
    return { text: head + out + after, start: startOfLine, end: startOfLine + out.length };
  });

  const mention = () => edit((sel, s, e) => {
    const out = text.slice(0, s) + "@" + sel + text.slice(e);
    return { text: out, start: s + 1, end: s + 1 + sel.length };
  });

  // Drag/paste: a text file drops in as a fenced block; an image cannot (no
  // public GitHub upload API), so it says so and points at GitHub — same shape
  // as the comment composer, and as the paperclip below.
  const TEXTY = /\.(md|txt|log|json|jsonc|ya?ml|toml|ini|csv|tsv|diff|patch|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|c|h|cpp|cs|sh|bash|zsh|sql|html?|css|scss|xml)$/i;
  const takeFiles = async (files: File[]) => {
    if (!files.length) return;
    const img = files.find((f) => f.type.startsWith("image/"));
    if (img) { setAttachNote(img.name); return; }
    const parts: string[] = [];
    for (const f of files.slice(0, 4)) {
      if (!TEXTY.test(f.name) && !f.type.startsWith("text/")) continue;
      const lang = (f.name.split(".").pop() ?? "").toLowerCase();
      parts.push(`**${f.name}**\n\n\`\`\`${lang}\n${(await f.text()).slice(0, 60_000)}\n\`\`\``);
    }
    if (parts.length) setText((t) => (t ? t + "\n\n" : "") + parts.join("\n\n"));
  };

  return (
    <div className="flex flex-col h-full min-h-0"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void takeFiles([...e.dataTransfer.files]); }}
      onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); void takeFiles(fs); } }}>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        <span className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>Editing description</span>
        <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>· #{prNumber}</span>
        {dirty && <span className="text-[8.5px] uppercase tracking-[.13em]" style={{ color: "var(--warning)" }}>unsaved</span>}
        <span className="ml-auto flex gap-1">
          <Btn onClick={() => setPreview(false)} small primary={!preview}>Write</Btn>
          <Btn onClick={() => setPreview(true)} small primary={preview}>Preview</Btn>
        </span>
      </div>

      {!preview && (
        <div className="flex items-center gap-0.5 px-2 py-1 shrink-0 flex-wrap"
          style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <TB title="Heading" onClick={() => prefixLines(() => "### ")}>H</TB>
          <TB title="Bold" onClick={() => wrap("**")}><b>B</b></TB>
          <TB title="Italic" onClick={() => wrap("_")}><i>I</i></TB>
          <TBSep />
          <TB title="Quote" onClick={() => prefixLines(() => "> ")}>&ldquo;</TB>
          <TB title="Code" onClick={code}>&lt;/&gt;</TB>
          <TB title="Link" onClick={link}>🔗</TB>
          <TBSep />
          <TB title="Numbered list" onClick={() => prefixLines((i) => `${i + 1}. `)}>1.</TB>
          <TB title="Bulleted list" onClick={() => prefixLines(() => "- ")}>•</TB>
          <TB title="Task list" onClick={() => prefixLines(() => "- [ ] ")}>☑</TB>
          <TBSep />
          <TB title="Attach an image" onClick={() => setAttachNote("An image")}>📎</TB>
          <TB title="Mention" onClick={mention}>@</TB>
        </div>
      )}

      {attachNote && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[10.5px] shrink-0"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <span className="min-w-0 truncate"><b>{attachNote}</b> can't be attached from here — GitHub has no public upload API for attachments.</span>
          <button onClick={onOpenGithub} className="agx-btn ml-auto shrink-0 px-2 py-0.5 rounded"
            style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>Attach on GitHub ↗</button>
          <button onClick={() => setAttachNote(null)} className="agx-btn shrink-0 px-1" style={{ color: "var(--text3)" }} aria-label="Dismiss">×</button>
        </div>
      )}

      {preview ? (
        <div className="flex-1 min-h-0 overflow-y-auto agx-scroll p-3">
          {text.trim() ? <Md body={text} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          }}
          className="flex-1 min-h-0 w-full p-3 text-[12px] outline-none resize-none agx-scroll"
          style={{ ...CODE_FONT_STYLE, background: "transparent", color: "var(--text2)", lineHeight: 1.6 }}
        />
      )}

      <div className="flex items-center gap-1.5 px-3 py-2 shrink-0"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        <span className="text-[10px]" style={{ color: "var(--text3)" }}>Markdown · ⌘↵ save · Esc cancel</span>
        <span className="ml-auto flex gap-1.5">
          <Btn onClick={onCancel} disabled={saving} small>Cancel</Btn>
          <Btn onClick={save} disabled={saving || busy || !dirty} primary small>{saving ? "Saving…" : "Save"}</Btn>
        </span>
      </div>
    </div>
  );
}

/**
 * A dropdown that closes on an outside click, on Escape, and on choosing
 * something. All three, because a menu that only closes one of those ways is
 * the kind of thing you only notice when it is stuck open over the diff.
 */
function Menu({ label, title, children, align = "right", primary }: {
  /** A node, not just a string: an icon-only trigger used to be a typographic
   *  character, and `⌸` is an APL glyph most fonts do not carry — it fell back
   *  to whatever was nearest, at about six pixels of actual mark. */
  label: React.ReactNode; title?: string; children: (close: () => void) => React.ReactNode; align?: "left" | "right";
  /** For a menu that is an action rather than an overflow — it has to read as
   *  the thing you came here to press, not as a place other things are kept. */
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  // `flex`, and not for layout: a block wrapper around an inline-flex button
  // builds a line box, and the leading above the baseline made this 26.6px tall
  // around a 24px button. Beside a bare Btn with no wrapper, that showed up as
  // the menu sitting 2.6px lower — the last of the four pixels in this row that
  // were never where they looked like they were.
  return (
    <div className="relative shrink-0 flex" ref={box}>
      <Btn onClick={() => setOpen((v) => !v)} title={title} small primary={primary}>{label}</Btn>
      {open && (
        <div className="absolute z-50 mt-1.5 rounded-lg overflow-hidden agx-menu" style={{ [align]: 0, minWidth: 216 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger, kbd }: {
  children: React.ReactNode; onClick: () => void; danger?: boolean; kbd?: string;
}) {
  return (
    <button onClick={onClick} className="agx-mi w-full text-left flex items-center gap-2 px-3 py-1.5 text-[11px]"
      style={{ color: danger ? "var(--error)" : "var(--text2)" }}>
      <span className="min-w-0 truncate">{children}</span>
      {kbd && <span className="ml-auto text-[9.5px] shrink-0" style={{ color: "var(--text3)" }}>{kbd}</span>}
    </button>
  );
}

const MenuSep = () => <div style={{ height: 1, background: "color-mix(in srgb, var(--border) 26%, transparent)", margin: "4px 0" }} />;

const MenuHead = ({ children }: { children: React.ReactNode }) => (
  <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>{children}</div>
);

/**
 * The chat, as an afterthought on a row that is already a button.
 *
 * It was two icons — a terminal and a chat — on a row whose TITLE did a third
 * thing. Reported straight away: pressing the row anywhere but exactly on the
 * `>_` "sends me to the terminal and then nothing happens". A row with three
 * targets and no obvious one is a row you have to aim at, and the whole point
 * of the menu is picking a prompt, not picking a pane.
 *
 * So the row runs it in a terminal — see ReviewMenu — and this is the one
 * exception, kept because the chat pane is genuinely the quicker read
 * sometimes. `stopPropagation`, or it would fire the row's terminal underneath
 * it.
 */
function ChatInstead({ onChat }: { onChat: () => void }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onChat(); }} title="In the chat pane instead"
      className="ml-auto inline-flex items-center justify-center rounded hover:bg-white/10 shrink-0"
      style={{ width: 20, height: 20, color: "var(--text3)" }} aria-label="In the chat pane instead">
      <span className="text-[13px] leading-none">&#8942;</span>
    </button>
  );
}

/**
 * The prompts, once, for every menu that offers them.
 *
 * A module-level cache rather than a fetch per open: the list is a dozen short
 * strings that only change when somebody edits them in Settings, and re-reading
 * it on every click of the button would put a round trip between the press and
 * the menu appearing. `bumpReviewRecipes` is what Settings calls after a save,
 * which is the only event that can invalidate this.
 */
/**
 * The saved replies, read once per window and shared by every composer.
 *
 * Same shape as the recipe cache below it and for the same reason: a dozen composers
 * can be mounted at once (every thread has one), and each of them fetching the same
 * list is a dozen requests for a file that changes when somebody opens Settings.
 */
let replyCache: { id: string; title: string; text: string }[] | null = null;
let replyAsked = false;
const replySubs = new Set<() => void>();
export function bumpSavedReplies(): void { replyCache = null; replyAsked = false; replySubs.forEach((f) => f()); }
function useSavedReplies(): { id: string; title: string; text: string }[] {
  const [, redraw] = useState(0);
  useEffect(() => {
    const fn = () => redraw((n) => n + 1);
    replySubs.add(fn);
    if (!replyAsked) {
      replyAsked = true;
      api.savedReplies().then((r) => { replyCache = r.replies ?? []; replySubs.forEach((f) => f()); }).catch(() => { replyCache = []; });
    }
    return () => { replySubs.delete(fn); };
  }, []);
  return replyCache ?? [];
}

let recipeCache: ReviewRecipe[] | null = null;
const recipeSubs = new Set<() => void>();
export function bumpReviewRecipes(): void { recipeCache = null; recipeSubs.forEach((f) => f()); }
function useReviewRecipes(): ReviewRecipe[] {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    recipeSubs.add(redraw);
    if (!recipeCache) void api.prPrompts().then((r) => { if (r.ok && r.recipes) { recipeCache = r.recipes; redraw(); } }).catch(() => {});
    return () => { recipeSubs.delete(redraw); };
  }, []);
  return recipeCache ?? [];
}

const GROUP_LABEL: Record<ReviewRecipeGroup, string> = {
  reviewing: "Reviewing",
  focused: "One thing only",
  mine: "Your pull request",
  // Never printed by the review menu, which lists its groups by name — it is
  // here because the record is total, and because the day this group does get
  // shown somewhere it must not appear as the word `telling`.
  telling: "Telling somebody",
};

/** The prompt behind the Ping button, by id. In the same catalogue as the
 *  review prompts, and for the same reason: the wording is personal, it is
 *  edited in Settings, and it is stored in the user's own file rather than in
 *  this repository. */
const PING_RECIPE = "ready-for-review";

/**
 * "Review with Claude", with the whole catalogue behind it.
 *
 * Every prompt is always here, and the situation only decides which one is
 * printed at the top under "Suggested". That is the whole design decision: the
 * pull request that forced this feature had been reviewed twice and handed back
 * a third time without the reviewer being re-requested, so a menu that hid
 * prompts GitHub's fields did not ask for would have hidden the one that was
 * wanted.
 *
 * Both destinations on every row, rather than a remembered default: a terminal
 * window and a chat pane are not the same thing badly — the terminal is a real
 * agent in tmux you can attach to and keep working in, the chat is the quicker
 * read — and which one you want depends on the prompt you just picked.
 */
function ReviewMenu({ d, onPick, canTerm, primary = true }: {
  d: PrDetail;
  onPick: (recipe: string, where: "term" | "chat") => void;
  /** False in a window with no terminal to send it to — the row then offers
   *  the chat alone rather than a button that quietly does nothing. */
  canTerm: boolean;
  primary?: boolean;
}) {
  const recipes = useReviewRecipes();
  const suggested = useMemo(() => {
    const mine = [...d.reviews].reverse().find((r) => r.viewerDidAuthor && r.state !== "PENDING");
    const head = d.commits.length ? d.commits[d.commits.length - 1]!.oid : "";
    return suggestRecipeId({
      viewerDidAuthor: d.viewerDidAuthor,
      reviewDecision: d.reviewDecision,
      viewerRequested: d.viewerRequested,
      movedSinceMyReview: !!mine?.commit && !!head && mine.commit !== head,
      reviewsSoFar: d.reviews.filter((r) => r.state !== "PENDING").length,
      blocked: d.mergeable === "CONFLICTING" || d.checks.failure > 0,
      card: cardRef(d)?.label ?? "",
    });
  }, [d]);

  const top = recipes.find((r) => r.id === suggested) ?? recipes[0];
  const groups: ReviewRecipeGroup[] = ["reviewing", "focused", "mine"];

  return (
    <Menu label="✦ Review with Claude ▾" title="Review this pull request" primary={primary}>
      {(close) => (
        <div style={{ maxHeight: "min(62vh, 520px)", overflowY: "auto" }}>
          {/* The suggestion keeps the shape the button had before: a named
              prompt and the two places to run it, one click each. */}
          {top && (
            <>
              <MenuHead>Suggested</MenuHead>
              {/* The same row as every other one, rather than the two
                  destination lines it used to be: one shape to learn, and the
                  suggestion is a prompt like the rest — it is just the one this
                  pull request calls for. */}
              <div role="button" tabIndex={0}
                onClick={() => { close(); onPick(top.id, canTerm ? "term" : "chat"); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); close(); onPick(top.id, canTerm ? "term" : "chat"); } }}
                title={top.skill || top.title}
                className="agx-mi w-full flex items-center gap-2 px-3 py-1.5 text-[11px] cursor-pointer" style={{ color: "var(--text)" }}>
                <span className="min-w-0 truncate flex-1">
                  {top.skill && <span style={{ color: "var(--primary)" }}>/ </span>}
                  {top.title}
                </span>
                <ChatInstead onChat={() => { close(); onPick(top.id, "chat"); }} />
              </div>
            </>
          )}
          {groups.map((g) => {
            const rows = recipes.filter((r) => r.group === g && r.id !== top?.id);
            if (!rows.length) return null;
            return (
              <Fragment key={g}>
                <MenuSep />
                <MenuHead>{GROUP_LABEL[g]}</MenuHead>
                {rows.map((r) => (
                  /* The whole row, not a button inside it: the title used to be
                     the only live part, so a press on the padding beside it did
                     nothing at all. And it runs in a terminal, because that is
                     where a review belongs — a real agent in tmux that survives
                     this app, which you can attach to and keep working in. */
                  <div key={r.id} role="button" tabIndex={0}
                    onClick={() => { close(); onPick(r.id, canTerm ? "term" : "chat"); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); close(); onPick(r.id, canTerm ? "term" : "chat"); } }}
                    title={r.skill || r.title}
                    className="agx-mi w-full flex items-center gap-2 px-3 py-1.5 text-[11px] cursor-pointer" style={{ color: "var(--text2)" }}>
                    <span className="min-w-0 truncate flex-1">
                      {r.skill && <span style={{ color: "var(--primary)" }}>/ </span>}
                      {r.title}
                    </span>
                    <ChatInstead onChat={() => { close(); onPick(r.id, "chat"); }} />
                  </div>
                ))}
              </Fragment>
            );
          })}
          <MenuSep />
          <MenuItem onClick={() => { close(); openSettings("review-prompts"); }}>Edit these prompts…</MenuItem>
        </div>
      )}
    </Menu>
  );
}

/**
 * One cell of the masthead's field strip: a key, and its value under it.
 *
 * It was a 260px block in a six-across row, and that fixed width is where the
 * strip's problem started — six of them fill a wide pane, so there was never
 * room for the two fields the header was missing. A cell is now as wide as
 * what it holds, capped only where a value can run away (people, labels, a
 * branch name), and the row wraps rather than stretching.
 *
 * Key and value are two kinds of text, so they get 6px between them: packed
 * tight, BRANCH read as the first word of the branch name it labels.
 */
function Field({ label, title, max, children }: {
  label: string;
  /** The whole cell's tooltip — a value that is truncated still has to be
   *  readable somehow. */
  title?: string;
  max?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex flex-col gap-1" style={max != null ? { maxWidth: max } : undefined} title={title}>
      <span className="text-[10px] uppercase tracking-[.1em]" style={{ color: "var(--text4)" }}>{label}</span>
      {/* `overflow-hidden`: `max` is a real cap, not just a suggestion — every
          child in here already truncates or refuses to shrink on its own, and
          without a cut edge on the ROW too, content past `max` painted over
          whatever field sits next to it instead of stopping at the boundary
          its own tooltip exists to cover for. */}
      <span className="text-[11px] flex items-center gap-1 min-w-0 overflow-hidden" style={{ color: "var(--text2)" }}>{children}</span>
    </div>
  );
}

/**
 * The identity of the pull request, above the tabs so it survives every tab.
 *
 * Everything here used to live at the top of Overview, which meant that the
 * moment you opened Files you no longer knew whose pull request you were
 * reading or what branch it targeted.
 */
/**
 * The right-hand column, as GitHub has it.
 *
 * Two things at once. It carries the metadata that had nowhere to live —
 * reviewers, assignees, labels, milestone, the issues this closes, who is
 * taking part — and it occupies the space to the right of the prose, which is
 * the reason the reading column can be a fixed, comfortable width instead of
 * stretching to the window and leaving half the panel empty.
 */
function SidebarSection({ title, onEdit, children }: { title: string; onEdit?: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode }) {
  return (
    <div className="py-2.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>{title}</span>
        {onEdit && (
          <button onClick={onEdit} title={`Edit ${title.toLowerCase()}`} aria-label={`Edit ${title.toLowerCase()}`}
            className="agx-btn ml-auto rounded hover:bg-white/5 inline-flex items-center justify-center"
            style={{ color: "var(--text3)", fontSize: 14, width: 20, height: 20 }}>✎</button>
        )}
      </div>
      {children}
    </div>
  );
}

/** Reviewers and assignees are both lists of people. Only a reviewer can be a
 *  team, so an assignee is one with nothing to flag. */
/**
 * Reviewers, the way GitHub lists them: everybody who has reviewed, with their
 * verdict, plus everybody still being waited on.
 *
 * This used to print the OUTSTANDING request list under the heading
 * "Reviewers", so a pull request where everybody had answered — two approvals
 * and one request for changes — said "No reviewers" and left the three faces to
 * the participants row at the bottom, which says nothing about state. Reported
 * with both screens side by side. The roster and its order are in
 * lib/prReviewers.
 */
function ReviewerList({ rows }: { rows: ReviewerRow[] }) {
  if (!rows.length) return <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>No reviewers</span>;
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r) => {
        const mark = REVIEW_MARK[r.state];
        return (
          <span key={r.login} className="flex items-center gap-1.5 text-[11px] min-w-0" style={{ color: "var(--text2)" }}
            title={`${r.login} — ${mark.said}${r.at ? ` ${ago(r.at)}` : ""}${r.again ? " · asked again since" : ""}`}>
            <ReviewerFace r={{ login: r.login, isTeam: r.isTeam }} size={16} />
            <span className="truncate min-w-0">{r.login}</span>
            <span className="flex-1" />
            {/* Asked again after answering — GitHub's ↻, and the reason a green
                tick beside it is not the whole story. */}
            {r.again && <span aria-hidden className="text-[14px] shrink-0" style={{ color: "var(--text4)" }} title="Asked to look again">↻</span>}
            <span aria-hidden className="text-[14px] shrink-0" style={{ color: mark.tint }}>{mark.glyph}</span>
          </span>
        );
      })}
    </div>
  );
}

/** One glyph and one word per verdict. The word is in the tooltip, because the
 *  column is 248px wide and three of these read as a paragraph. */
const REVIEW_MARK: Record<ReviewerState, { glyph: string; tint: string; said: string }> = {
  changes: { glyph: "✕", tint: "var(--error)", said: "asked for changes" },
  awaiting: { glyph: "◯", tint: "var(--text4)", said: "has not answered yet" },
  approved: { glyph: "✓", tint: "var(--success, #98c379)", said: "approved" },
  commented: { glyph: "💬", tint: "var(--text3)", said: "commented" },
  dismissed: { glyph: "⊘", tint: "var(--text4)", said: "review dismissed" },
};

function SidebarPeople({ people, empty }: { people: PrReviewer[]; empty: string }) {
  if (!people.length) return <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{empty}</span>;
  return (
    <div className="flex flex-col gap-1">
      {people.map((p) => (
        <span key={p.login} className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text2)" }}>
          <ReviewerFace r={p} size={16} />{p.login}
        </span>
      ))}
    </div>
  );
}

type PickOption = { value: string; label: string; sub?: string; color?: string; avatar?: string };

/**
 * A GitHub-style chooser: a filter box over a list you tick, instead of a
 * comma-separated line you have to type logins into from memory. The options
 * are the repository's own — `api.prFacets` (labels, assignees, milestones) and
 * `api.prMentions` (collaborators, for reviewers), both cached server-side — so
 * the list is the real set, not whoever happened to appear on the page.
 *
 * Rendered through a Portal and positioned `fixed` under its trigger: the
 * sidebar it opens from scrolls and is only 248px wide, so an absolutely-placed
 * menu would be clipped. Multi-select commits the diff once, when it closes —
 * the way GitHub's label menu does — so ticking four labels is one write, not
 * four. Single-select (milestone) commits on the click.
 */
function FieldPicker({ anchor, title, hint, multi, loading, options, selected, onCommit, onClose, side }: {
  anchor: DOMRect; title: string; hint: string; multi: boolean; loading: boolean;
  options: PickOption[]; selected: string[];
  /** Writes the difference, and says whether it landed. `true` when there was
   *  nothing to write — this is "is it safe to go on", not "did it write". */
  onCommit: (next: string[]) => boolean | Promise<boolean>;
  onClose: () => void;
  /**
   * The other half of the same errand, under the people.
   *
   * Assigning a reviewer here and moving the card in ClickUp are one motion in
   * somebody's head and two applications on the screen. The list of people is
   * three hundred pixels of a tall menu with room to spare beside it, so the
   * other half of the errand goes there — optional, never automatic, and only
   * when the pull request actually has a card.
   */
  side?: (h: {
    folded: boolean;
    onFold: (v: boolean) => void;
    onPlan: (p: { lines: string[]; run: () => Promise<boolean> }) => void;
  }) => React.ReactNode;
}) {
  /* Folded to a line by default, and the line sits ABOVE Done: the errand is
     the reviewer, and this is the thing you may also want. */
  const [sideFolded, setSideFolded] = useState(true);
  const [plan, setPlan] = useState<{ lines: string[]; run: () => Promise<boolean> }>({ lines: [], run: async () => true });
  /* One button for both halves, and a summary before either happens: the two
     writes land on two different companies' servers and only one of them can be
     undone from here. */
  const [asking, setAsking] = useState(false);
  const [running, setRunning] = useState(false);
  /** What went wrong, kept on the menu: it is still open over the toast. */
  const [failed, setFailed] = useState("");
  useEffect(() => { if (!plan.lines.length) setAsking(false); }, [plan.lines.length]);
  const [sel, setSel] = useState<string[]>(selected);
  const [q, setQ] = useState("");
  const selRef = useRef(sel); selRef.current = sel;
  const box = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);

  /*
   * `autoFocus` DOES NOTHING HERE, because this menu lives in a `<Portal>`.
   *
   * React applies `autoFocus` at commit time, in the same pass that first
   * renders this input — and `Portal` only appends its container to
   * `document.body` in ITS OWN effect, which (child effects run before
   * parent effects) fires AFTER this one. So the input gets focused while
   * its container is still a detached node nothing can put the caret in,
   * `.focus()` is a silent no-op on it, and the menu opens with the mouse as
   * the only way in: "without having to go moving the mouse around to click
   * on the input".
   *
   * A `requestAnimationFrame` waits out that race without guessing at a
   * delay: it always fires after every effect in this commit has run,
   * Portal's included, by which point the node is really in the document.
   */
  useEffect(() => {
    const id = requestAnimationFrame(() => filterInput.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    /*
     * Looking away does not write.
     *
     * An outside click used to commit, the way GitHub's own label menu does —
     * and with a Done button on the menu that is a second, invisible way to
     * write: he ticked a reviewer, never pressed Done, and the request went out
     * anyway. One writer, and it is the button. Escape and clicking away both
     * abandon, which is what a button at the bottom promises.
     */
    const away = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (box.current?.contains(t as Node)) return;
      /* A menu opened FROM this picker is not "outside" it. The card's status
         is chosen with the app's own Select, which portals its list to the body
         so it can escape this column's clipping — so the press landed outside
         `box` and closed the whole picker before the choice could be made.
         Reported as "if I click the status, this modal/selector just closes
         on me". */
      if (t?.closest?.("[data-menu-layer]")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    // The menu is placed against a rectangle measured when it opened, so a
    // resize leaves it somewhere else entirely. Closing is honest; writing on
    // the way out is not.
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const toggle = (v: string) => {
    if (!multi) { void onCommit([v]); onClose(); return; }
    setSel((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v]);
  };

  /* What the GitHub half would do — nothing, most of the time. The summary said
     "Set reviewers on GitHub" whether or not a single tick had moved. */
  const ghChanged = sel.filter((x) => !selected.includes(x)).length + selected.filter((x) => !sel.includes(x)).length;

  const t = q.trim().toLowerCase();
  const shown = t ? options.filter((o) => o.label.toLowerCase().includes(t) || o.value.toLowerCase().includes(t) || !!o.sub?.toLowerCase().includes(t)) : options;

  /* One width, always. The menu is already tall — that is the space going
     spare, not the width — so the other half of the errand stacks under the
     people rather than beside them. */
  const W = 300;
  const left = Math.round(Math.max(8, Math.min(anchor.right - W, window.innerWidth - W - 8)));
  const top = Math.round(Math.min(anchor.bottom + 6, window.innerHeight - 140));
  const maxH = Math.max(200, window.innerHeight - top - 12);

  return (
    <Portal>
      <div ref={box} className="fixed rounded-lg overflow-hidden flex flex-col"
        style={{ left, top, width: W, maxHeight: maxH, border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", background: "color-mix(in srgb, var(--bg2) 98%, black)", boxShadow: "0 18px 44px -18px rgba(0,0,0,.8)" }}>
        {/* `min-h-0`, and it is the whole bug: a flex child'"'"'s default floor is
            its content, so the people list grew past the menu instead of
            scrolling inside it — taking the ClickUp half and Done off the
            bottom with it, and leaving nothing to scroll. */}
        <div className="flex flex-col min-w-0 min-h-0 flex-1">
        {/* px-5 to match viewHeaderClass, which is the row directly above this
            one. At px-3 the filter chips started 8px to the left of the repo
            chips they sit under — two left edges in one header, which is the
            kind of thing you notice without being able to name. */}
        <div className="px-5 pt-2 pb-1.5 shrink-0" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <div className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>{title}</div>
          <div className="text-[10px]" style={{ color: "var(--text3)" }}>{hint}</div>
        </div>
        <div className="p-1.5 shrink-0">
          <input ref={filterInput} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…"
            className="w-full px-2 py-1 rounded text-[11px] outline-none"
            style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }} />
        </div>
        <div className="overflow-y-auto agx-scroll flex-1 min-h-0 pb-1">
          {loading ? (
            <div className="px-3 py-3 text-[11px]" style={{ color: "var(--text3)" }}>Loading…</div>
          ) : shown.length === 0 ? (
            <div className="px-3 py-3 text-[11px]" style={{ color: "var(--text3)" }}>No matches.</div>
          ) : shown.map((o) => {
            const on = sel.includes(o.value);
            return (
              <button key={o.value || "∅"} onClick={() => toggle(o.value)}
                className="agx-mi w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
                style={{ color: "var(--text2)" }}>
                <span className="w-3.5 shrink-0 text-center" style={{ color: on ? "var(--primary)" : "transparent" }}>✓</span>
                {o.color != null && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: `#${o.color}` }} />}
                {o.avatar != null && <Avatar login={o.avatar} size={16} />}
                <span className="truncate">{o.label}</span>
                {o.sub && <span className="truncate text-[10px] shrink-0 ml-auto" style={{ color: "var(--text3)" }}>{o.sub}</span>}
              </button>
            );
          })}
        </div>
        </div>
        {side?.({ folded: sideFolded, onFold: setSideFolded, onPlan: setPlan })}
        {multi && (
          <div className="p-1.5 shrink-0 flex flex-col gap-1.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
            {asking && (
              /* What is about to happen, in the order it will happen, and
                 nothing that is not a change. Read once and accepted, rather
                 than two buttons pressed hopefully. */
              <div className="px-1 text-[10.5px]" style={{ color: "var(--text2)" }}>
                <div className="mb-1" style={{ color: "var(--text4)" }}>This will:</div>
                {/* WHO, not just "something will change here".
                    It said "Request reviewers on GitHub" for a step that was
                    taking a reviewer OFF — the same sentence for both
                    directions, while the ClickUp lines under it named the
                    person either way. Reported as: it should say remove that
                    user, with their avatar like adding one has. */}
                {ghChanged > 0 && (() => {
                  const add = sel.filter((x) => !selected.includes(x));
                  const gone = selected.filter((x) => !sel.includes(x));
                  const line = (v: string, on: boolean) => {
                    const o = options.find((x) => x.value === v);
                    return (
                      <div key={`${on ? "+" : "-"}${v}`} className="flex items-center gap-1.5 pl-3">
                        <span className="shrink-0" style={{ color: on ? "var(--success)" : "var(--error)" }}>{on ? "+" : "−"}</span>
                        {o?.avatar != null && <Avatar login={o.avatar} size={14} />}
                        {o?.color != null && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: `#${o.color}` }} />}
                        <span className="truncate">{o?.label ?? v}</span>
                      </div>
                    );
                  };
                  return (
                    <>
                      <div>· {title} on GitHub</div>
                      {add.map((v) => line(v, true))}
                      {gone.map((v) => line(v, false))}
                    </>
                  );
                })()}
                {/* Nothing that is not a change: with an empty plan there is
                    nothing to confirm and this step does not happen at all. */}
                {plan.lines.map((l) => <div key={l}>· {l}</div>)}
              </div>
            )}
            {failed && (
              /* Said here rather than only in the toast: the menu is still open
                 over it, and the toast is behind the menu. */
              <div className="px-1 text-[10.5px]" style={{ color: "var(--warning)" }}>{failed}</div>
            )}
            <div className="flex items-center gap-2">
              {asking && (
                <button onClick={() => setAsking(false)} className="agx-btn px-2 py-1 rounded text-[10.5px]"
                  style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>Back</button>
              )}
              <button
                onClick={async () => {
                  /* Nothing to confirm when this is only the GitHub half. */
                  if (!plan.lines.length) { void onCommit(selRef.current); onClose(); return; }
                  if (!asking) { setAsking(true); return; }
                  setRunning(true);
                  setFailed("");
                  /* GitHub first, and ClickUp only if it landed — and now it is
                     awaited, which is what makes that sentence true. A card that
                     says "code review, assigned to you" over a pull request
                     nobody was asked to review is a worse state than an
                     unfinished one. */
                  const wrote = await onCommit(selRef.current);
                  if (wrote === false) {
                    setRunning(false);
                    setFailed("GitHub refused that, so the card was left alone.");
                    return;
                  }
                  const moved = await plan.run();
                  setRunning(false);
                  if (!moved) { setFailed("The card did not move — GitHub is done."); return; }
                  onClose();
                }}
                disabled={running}
                className="agx-btn ml-auto px-2.5 py-1 rounded text-[10.5px] inline-flex items-center gap-1.5 disabled:opacity-50"
                style={{ background: "var(--primary)", color: "var(--bg)" }}>
                {running && <span className="agx-spin" aria-hidden style={{ width: 8, height: 8, borderWidth: 1.5, borderColor: "color-mix(in srgb, var(--bg) 55%, transparent)", borderTopColor: "transparent" }} />}
                {/* The button names what it is about to do. "Done · and
                    ClickUp" over a menu where only the card changed claimed a
                    GitHub write that was not going to happen. */}
                {asking
                  ? (ghChanged ? "Yes, do both" : "Yes, move the card")
                  : plan.lines.length
                    ? (ghChanged ? "Done · and ClickUp" : "Move the card")
                    : "Done"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Portal>
  );
}

/**
 * The same errand, on the other board.
 *
 * A reviewer goes on the pull request and the card goes to Code Review — one
 * motion, two applications, and the second one is the one people forget. It is
 * offered beside the people list rather than after it, and nothing here happens
 * until Apply is pressed: assigning on GitHub must never be conditional on
 * ClickUp being reachable, or right, or wanted.
 *
 * Only when the pull request really carries a card. `mergeCardRef` is the
 * strict reader — a reference in a branch name alone is a convention other
 * trackers share — and the same one the merge dialog trusts before it writes.
 */
function ClickUpSide({ d, folded, onFold, onPlan, note }: {
  d: PrDetail;
  /** Folded by default: most presses of this menu are only about the reviewer. */
  folded: boolean;
  onFold: (v: boolean) => void;
  /** How this half says what happened. It used to say nothing at all — which is
   *  why a card that refused two of its three writes looked like a success. */
  note: (ok: boolean, msg: string) => void;
  /**
   * What this half would do, and how to do it — handed up so the menu can put
   * ONE button at the bottom for both halves of the errand.
   *
   * `lines` is the summary somebody confirms. It lists only what actually
   * changes: a card already in Code Review being "moved" to Code Review is not
   * a change, and neither is leaving yourself on it. With nothing in it, this
   * half sends nothing at all and the press is a GitHub assignment.
   */
  onPlan: (plan: { lines: string[]; run: () => Promise<boolean> }) => void;
}) {
  const setup = useClickupSetup();
  /*
   * On the branch and the title, not on the object they arrived in.
   *
   * `d` is a new object on every poll of the pull request, carrying the same
   * card — and this was memoized on `d`, so a new `ref` appeared every few
   * seconds, the effect below started over, and whoever you had just ticked was
   * replaced by whoever the card had on it. Reported after measuring it: "a few
   * seconds later what I had selected has reset to its initial state".
   */
  const ref = useMemo(() => mergeCardRef(d, setup), [d.headRefName, d.title, d.body, setup]);
  /* The card, as a string. Everything below keys off this rather than off `ref`
     — an object rebuilt each render is a dependency that is never equal. */
  const query = ref?.query ?? "";
  const label = ref?.label ?? "";
  const [card, setCard] = useState<{ id: string; title: string; status: string; updated?: number; listId?: string } | null>(null);
  const [statuses, setStatuses] = useState<CuStatus[]>([]);
  const [members, setMembers] = useState<CuMember[] | null>(null);
  const [on, setOn] = useState<Set<number>>(new Set());
  const [was, setWas] = useState<Set<number>>(new Set());
  const [pick, setPick] = useState<string>("");
  const [q, setQ] = useState("");
  /* Folded away, and it comes back.
     This is the optional half of the errand and most presses of this menu are
     only about the reviewer — so it can be put away to a strip, which leaves
     the people list the whole width, and pulled out again with one press. The
     choice is not remembered on purpose: it is per errand, not a setting. */

  const [err, setErr] = useState("");

  useEffect(() => {
    if (!query) return;
    let live = true;
    setErr("");
    void (async () => {
      const found = await api.clickupFind(query).catch(() => null);
      if (!live) return;
      if (!found?.ok || !found.task) { setErr(found?.error || "ClickUp could not find it"); return; }
      const t = found.task;
      const people = new Set<number>((t.people ?? []).map((p) => p.id).filter((n): n is number => n != null));
      setCard({ id: t.id, title: t.title, status: t.status, updated: t.updated, listId: t.listId });
      setOn(people); setWas(new Set(people));
      if (!t.listId) return;
      const [meta, mem] = await Promise.all([
        api.clickupList(t.listId).catch(() => null),
        api.clickupMembers(t.listId).catch(() => null),
      ]);
      if (!live) return;
      const st = meta?.ok ? (meta.statuses ?? []) : [];
      setStatuses(st);
      setMembers(mem?.ok ? (mem.members ?? []) : []);
      /* Code review by default, found by asking the LIST rather than by
         knowing the word: one board's "Code Review" is another's "In review".
         The match is on the name because that is all a status has, and the
         fallback is to leave it exactly where it is. */
      const review = st.find((x) => /review/i.test(x.status) && x.type !== "done" && x.type !== "closed");
      setPick(review && review.status !== t.status ? review.status : "");
    })();
    return () => { live = false; };
  }, [query]);

  const nameOf = useCallback(
    (id: number) => (members ?? []).find((m) => m.id === id)?.name || `#${id}`,
    [members],
  );

  /*
   * Only what actually changes, worked out in one place.
   *
   * A card already in Code Review being "moved" to Code Review is not a change,
   * and leaving yourself on it is not an assignment. With none of them this half
   * is silent and the press is a GitHub assignment, which is exactly what it is.
   */
  const plan = useMemo(
    () => cardPlan({ label, pick, statusNow: card?.status, on, was, nameOf }),
    [label, pick, card?.status, on, was, nameOf],
  );

  const run = useCallback(async () => {
    if (folded || !card || !plan.lines.length) return true;
    /*
     * One write, not three.
     *
     * It used to be a loop of assignments and then the status, each carrying
     * `card.updated` — the stamp read when the menu opened. The first write
     * moves that stamp, so ClickUp refused the rest as "somebody changed this
     * card while you had it open", and nothing checked the answer: he was told
     * the card would move to Code Review, gain Ana and lose him, and what
     * happened was only the first of the three.
     */
    const r = await api.clickupCard(
      card.id,
      { add: plan.add, rem: plan.drop, status: plan.status || undefined },
      card.updated,
    ).catch(() => ({ ok: false, error: "Could not reach the server", task: undefined }));
    note(r.ok, r.ok ? cardPlanNote(plan, label) : (r.error || `${label} did not move`));
    if (r.ok) {
      setWas(new Set(on));
      setPick("");
      const moved = plan.status;
      setCard((c) => c ? { ...c, status: moved || c.status, updated: r.task?.updated ?? c.updated } : c);
      /* The sidebar is holding the status this write just changed. Throwing it
         away is what makes the card's own section agree with the menu that
         moved it, without waiting out the minute. */
      forgetCard(query);
    }
    return r.ok;
  }, [folded, card, plan, on, label, note, query]);

  /* Folded means "not this time": the plan it publishes is empty, so the button
     downstairs goes back to plain Done. It was still announcing its changes
     while put away, which left "Done · and ClickUp" on a menu with nothing
     showing. */
  useEffect(() => { onPlan({ lines: folded ? [] : plan.lines, run }); }, [folded, plan, run, onPlan]);

  /*
   * Every hook above this line, and that is not a style rule.
   *
   * `ref` is null until `useClickupSetup` answers — a read cached for a minute,
   * so on a menu opened a while later the first render has no card and the
   * second one does. With the plan and the write below this return, those two
   * renders ran a different number of hooks, React threw, and the window went
   * black. That is the blank app in his screenshot.
   */
  if (!ref) return null;

  const people = (members ?? []).filter((m) => m.name && (!q.trim() || m.name.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => {
      const ah = on.has(a.id) ? 0 : 1, bh = on.has(b.id) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      if (a.me !== b.me) return a.me ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  if (folded) {
    return (
      <button onClick={() => onFold(false)} title={`Also move ${ref.label} in ClickUp`}
        className="agx-btn shrink-0 w-full flex items-center gap-2 px-3 py-1.5 text-[10.5px]"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", color: "var(--text3)" }}>
        <span aria-hidden>▴</span>
        <span className="truncate">Also move {ref.label} in ClickUp</span>
      </button>
    );
  }

  return (
    /* Under the people, not beside them: the menu'"'"'s height is what was going
       spare. Capped, so the list above it keeps most of the window and this
       never pushes Done off the bottom. */
    <div className="flex flex-col min-w-0 shrink-0" style={{ maxHeight: 260, borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
      <div className="px-4 pt-2 pb-1.5 shrink-0" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold min-w-0 truncate" style={{ color: "var(--text)" }}>
            Also in ClickUp <span style={{ color: "var(--text4)", fontWeight: 400 }}>· optional</span>
          </div>
          <button onClick={() => onFold(true)} title="Leave the card alone — this folds away and comes back on the strip"
            className="agx-btn ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px]"
            style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
            Not now ▾
          </button>
        </div>
        <div className="text-[10px] truncate" style={{ color: "var(--text3)" }} title={card?.title}>
          {ref.label}{card ? ` · ${card.title}` : ""}
        </div>
      </div>
      {err ? (
        <div className="px-3 py-3 text-[11px]" style={{ color: "var(--warning)" }}>{err}</div>
      ) : !card ? (
        <div className="px-3 py-3 text-[11px]" style={{ color: "var(--text3)" }}>Looking it up…</div>
      ) : (
        <>
          <div className="px-2 pt-2 pb-1 shrink-0">
            <div className="text-[9px] uppercase tracking-[0.16em] mb-1" style={{ color: "var(--text4)" }}>Status</div>
            {/* The card's own control, not a second design for the same choice:
                a pill you press that opens a list of pills. A status has a
                colour its board gave it, and a row of bordered words throws
                that away — which is the one thing that makes this list
                readable at a glance. */}
            {/*
              * The app's own Select, not a list drawn in the flow.
              *
              * This was an absolutely-placed panel under the button, inside a
              * column that clips and scrolls and has a "Done" button under it:
              * the list opened INSIDE the container, most of the statuses were
              * unreachable, and near the bottom of the screen there was nowhere
              * for it to go. Reported exactly that way. `Select` portals out of
              * the clipping and flips above the trigger when down does not fit,
              * which is what every other menu in this app does.
              *
              * "leave it where it is" is an option rather than a button above
              * the list, because it is one of the choices — and being the empty
              * value it is also what the control already holds.
              */}
            <Select
              value={pick}
              onChange={setPick}
              title="Status"
              options={[
                { value: "", label: "leave it where it is" },
                ...statuses.filter((x) => x.status !== card.status).map((x) => ({
                  value: x.status, label: x.status, tint: x.color, pill: true,
                  dim: x.type === "done" || x.type === "closed",
                })),
              ]}
            />
            {!pick && (
              <div className="mt-1 text-[9.5px] flex items-center gap-2" style={{ color: "var(--text4)" }}>
                <span>now</span>
                <StatusPill status={card.status} color={statusColor(statuses, card.status)} />
                <span>· unchanged</span>
              </div>
            )}
          </div>
          <div className="px-2 pt-2 shrink-0">
            <div className="text-[9px] uppercase tracking-[0.16em] mb-1" style={{ color: "var(--text4)" }}>Assigned</div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter people…" spellCheck={false}
              className="w-full px-2 py-1 rounded text-[11px] outline-none"
              style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }} />
          </div>
          <div className="overflow-y-auto agx-scroll flex-1 min-h-0 py-1">
            {members === null && <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text3)" }}>Reading the team…</div>}
            {people.map((m) => (
              <button key={m.id} onClick={() => setOn((cur) => { const n = new Set(cur); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                className="agx-mi w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[11px]" style={{ color: "var(--text2)" }}>
                {/* The face, as everywhere else people are drawn in this app.
                    Two initials is a puzzle in a workspace of five hundred. */}
                {m.avatar
                  ? <img src={m.avatar} alt="" loading="lazy" referrerPolicy="no-referrer"
                      style={{ width: 16, height: 16, borderRadius: 999, objectFit: "cover", flexShrink: 0 }} />
                  : <span className="shrink-0 rounded-full inline-flex items-center justify-center"
                      style={{ width: 16, height: 16, background: m.color || "var(--bg4)", color: "#fff", fontSize: 8 }}>
                      {m.initials}
                    </span>}
                <span className="truncate" style={{ color: on.has(m.id) ? "var(--success)" : "var(--text2)" }}>
                  {m.name}{m.me ? " · you" : ""}
                </span>
                {on.has(m.id) && <span className="ml-auto text-[10px]" style={{ color: "var(--success)" }}>✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type Facets = { authors: string[]; assignees: string[]; labels: { name: string; color: string }[]; milestones: string[]; bases: string[] };
type Mentions = { users: string[]; issues: { number: number; title: string }[] };
type SidebarField = "reviewers" | "assignees" | "labels" | "milestone";

type PrAct = (label: string, fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>) => Promise<boolean>;

/**
 * One picker for the whole pull request, shared by the masthead's inline "＋"
 * buttons and the sidebar's ✎ — lifted here because the masthead shows on every
 * tab while the sidebar only shows on two, so a picker owned by the sidebar
 * could not open from the masthead on the Files tab.
 *
 * Returns `open(field, event)` for a trigger to call and the picker `node` to
 * render once. The options are fetched lazily the first time any picker opens
 * (both endpoints are cached server-side, so the second open is instant), and
 * each write goes through the same add/remove endpoints, diffed against what
 * the PR has now.
 */
function usePrFieldPicker(d: PrDetail | null, root: string, act: PrAct,
  /** How to say what happened on the other board — the panel's own toast, so a
   *  ClickUp write reports where every other write reports. */
  note: (ok: boolean, msg: string) => void) {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [mentions, setMentions] = useState<Mentions | null>(null);
  /* CODEOWNERS, read once per checkout when a picker is first opened. Empty rules
     mean "this repository has no CODEOWNERS", which is a fine answer and the common
     one — the picker then behaves exactly as it always did. */
  const [owns, setOwns] = useState<{ rules: { pattern: string; owners: string[] }[]; path?: string }>({ rules: [] });
  const [loading, setLoading] = useState(false);
  const [picker, setPicker] = useState<{ field: SidebarField; anchor: DOMRect } | null>(null);

  const ensureOptions = useCallback(async () => {
    if (facets && mentions) return;
    setLoading(true);
    const [f, m, o] = await Promise.all([api.prFacets(root), api.prMentions(root), api.prCodeowners(root)]);
    if (f.ok && f.data) setFacets(f.data);
    if (m.ok && m.data) setMentions(m.data);
    if (o.ok) setOwns({ rules: o.rules ?? [], ...(o.path ? { path: o.path } : null) });
    setLoading(false);
  }, [root, facets, mentions]);

  const open = useCallback((field: SidebarField, e: React.MouseEvent<HTMLButtonElement>) => {
    setPicker({ field, anchor: e.currentTarget.getBoundingClientRect() });
    void ensureOptions();
  }, [ensureOptions]);
  const close = () => setPicker(null);

  // The picker holds its selection locally and hands back the final set; here
  // we diff it against what the PR has now and write just the delta — the shape
  // the endpoints already take.
  const commit = (was: string[], label: string, fn: (add: string[], remove: string[]) => Promise<{ ok: boolean; error?: string; detail?: string }>) => (next: string[]) => {
    const add = next.filter((x) => !was.includes(x));
    const remove = was.filter((x) => !next.includes(x));
    // Nothing to write is not a failure — and the answer is awaited now, so
    // "GitHub first, and the card only if it landed" is true rather than
    // aspirational.
    if (!add.length && !remove.length) return true;
    return act(label, () => fn(add, remove));
  };

  let node: React.ReactNode = null;
  if (picker && d) {
    const a = picker.anchor;
    if (picker.field === "labels") {
      const was = d.labels.map((l) => l.name);
      node = <FieldPicker anchor={a} title="Apply labels" hint="Tick to add or remove" multi loading={loading}
        options={(facets?.labels ?? []).map((l) => ({ value: l.name, label: l.name, color: l.color }))}
        selected={was} onClose={close} onCommit={commit(was, "Labels", (add, remove) => api.prLabels(root, d.number, add, remove))} />;
    } else if (picker.field === "reviewers") {
      const was = d.reviewers.map((r) => r.login);
      /*
       * Who the repository says should look at this, above everybody else.
       *
       * CODEOWNERS is the answer to "who do I ask", and reading it meant opening the
       * file and matching forty globs by hand — which is the sort of thing that gets
       * skipped, after which the pull request waits a day on somebody who was never
       * asked. The owners of the changed files sort to the top of the list and say how
       * much of the review they own.
       *
       * A TEAM cannot be ticked here: requesting a team review is a different call
       * from requesting a person's, and this list is people. So a team that owns files
       * is named in the hint instead of being offered as something that would not
       * work.
       */
      const owners = ownersOf(owns.rules, d.files.map((f) => f.path));
      const ownedBy = new Map<string, number>();
      const teams: string[] = [];
      for (const o of owners) {
        const login = loginOf(o.owner);
        if (login) ownedBy.set(login.toLowerCase(), o.paths.length);
        else teams.push(`${o.owner} (${o.paths.length})`);
      }
      const people = (mentions?.users ?? []).map((u) => {
        const n = ownedBy.get(u.toLowerCase());
        return { value: u, label: u, avatar: u, ...(n ? { sub: `owns ${n}` } : null) };
      }).sort((x, y) => (ownedBy.get(y.value.toLowerCase()) ?? 0) - (ownedBy.get(x.value.toLowerCase()) ?? 0));
      node = <FieldPicker anchor={a} title="Request reviewers" multi loading={loading}
        hint={teams.length
          ? `Owners first, from ${owns.path ?? "CODEOWNERS"} · ${teams.join(", ")} — ask a team on GitHub`
          : ownedBy.size
          ? `Owners first, from ${owns.path ?? "CODEOWNERS"}`
          : "Collaborators on this repository"}
        options={people}
        side={(h) => <ClickUpSide d={d} note={note} {...h} />}
        selected={was} onClose={close} onCommit={commit(was, "Reviewers", (add, remove) => api.prReviewers(root, d.number, add, remove))} />;
    } else if (picker.field === "assignees") {
      const was = d.assignees;
      node = <FieldPicker anchor={a} title="Assign people" hint="Up to 10 assignees" multi loading={loading}
        options={(facets?.assignees ?? []).map((u) => ({ value: u, label: u, avatar: u }))}
        side={(h) => <ClickUpSide d={d} note={note} {...h} />}
        selected={was} onClose={close} onCommit={commit(was, "Assignees", (add, remove) => api.prAssignees(root, d.number, add, remove))} />;
    } else {
      // Milestone is one-of, not many: picking commits at once, and a leading
      // "No milestone" entry clears it — passing "" to the endpoint, exactly as
      // the old free-text dialog did.
      const was = d.milestone ? [d.milestone] : [""];
      node = <FieldPicker anchor={a} title="Set milestone" hint="Choose one, or clear it" multi={false} loading={loading}
        options={[{ value: "", label: "No milestone" }, ...(facets?.milestones ?? []).map((m) => ({ value: m, label: m }))]}
        selected={was} onClose={close}
        onCommit={(next) => { const title = next[0] ?? ""; return title === (d.milestone ?? "") ? true : act("Milestone", () => api.prMilestone(root, d.number, title)); }} />;
    }
  }

  return { open, node };
}

/**
 * Where the card stands, beside where the pull request stands.
 *
 * The panel already knows which card this is — the masthead chip opens it, and
 * the reviewer menu moves it — and every answer to "has anybody picked this up"
 * was on the other board, behind a click. Two facts, the two that decide
 * whether it is waiting on somebody: the status, in the colour its board gave
 * it, and who is on it.
 *
 * Editable, and that is a reversal. It was read-only because moving a card
 * belonged to the reviewer menu, where it rides along with a GitHub assignment
 * somebody is already making. That is the wrong shape for the thing he
 * actually does: "if I only want to change the card status and the assignee… I
 * don't want to add GH reviewers, only the card… and I don't want to go to the card,
 * I want to do it from the PR".
 *
 * So the status and the people are controls here too. Each press is its own
 * write — there is no Done button and nothing to forget — and the statuses and
 * the team are fetched the first time you open one of them rather than with
 * every pull request.
 */
/**
 * The card's status, changed from here.
 *
 * The list is asked for the first time you open it: a board's statuses are its
 * own — one team's "Code Review" is another's "In review" — and fetching them
 * for every pull request somebody merely looks at is a call per view for a
 * control most views never touch.
 *
 * `updated` rides along with the write. ClickUp refuses a change made against a
 * stamp older than the card's, which is the guard that stopped a batch of three
 * from applying only its first — see the reviewer menu's note.
 */
function CardStatusPick({ task, query, onSaid }: { task: ProviderTask; query: string; onSaid: (s: string) => void }) {
  const [statuses, setStatuses] = useState<CuStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (statuses !== null || !task.listId) return;
    void api.clickupList(task.listId)
      .then((r) => setStatuses(r?.ok ? (r.statuses ?? []) : []))
      .catch(() => setStatuses([]));
  }, [statuses, task.listId]);

  const move = async (status: string) => {
    if (!status || status === task.status || busy) return;
    setBusy(true);
    onSaid("moving…");
    const r = await api.clickupCard(task.id, { status }, task.updated)
      .catch(() => ({ ok: false, error: "Could not reach the server" }));
    setBusy(false);
    onSaid(r.ok ? `now ${status}` : `!${r.error || "ClickUp refused that"}`);
    if (r.ok) forgetCard(query);
  };

  return (
    <span className="min-w-0" onMouseEnter={load}>
      <Select
        value={task.status}
        onChange={(v) => { void move(v); }}
        title="Status"
        options={(statuses ?? [{ status: task.status, color: task.statusColor ?? "", type: task.statusKind ?? "" }])
          .map((x) => ({ value: x.status, label: x.status, tint: x.color, pill: true, dim: x.type === "done" || x.type === "closed" }))}
      />
    </span>
  );
}

/**
 * And who is on it. One press is one write: picking somebody already on the
 * card takes them off, which is what the tick beside their name means.
 */
function CardPeoplePick({ task, query, onSaid }: { task: ProviderTask; query: string; onSaid: (s: string) => void }) {
  const [members, setMembers] = useState<CuMember[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const on = useMemo(
    () => new Set((task.people ?? []).map((p: { id?: number | null }) => p.id).filter((n): n is number => n != null)),
    [task.people],
  );
  const load = useCallback(() => {
    if (members !== null || !task.listId) return;
    void api.clickupMembers(task.listId)
      .then((r) => setMembers(r?.ok ? (r.members ?? []) : []))
      .catch(() => setMembers([]));
  }, [members, task.listId]);

  const toggle = async (m: CuMember) => {
    const off = on.has(m.id);
    setSaving(m.id);
    const r = await api.clickupCard(task.id, off ? { rem: [m.id] } : { add: [m.id] }, task.updated)
      .catch(() => ({ ok: false, error: "Could not reach the server" }));
    setSaving(null);
    onSaid(r.ok ? (off ? `${m.name} off` : `${m.name} on`) : `!${r.error || "ClickUp refused that"}`);
    if (r.ok) forgetCard(query);
  };

  return (
    <>
      {/* The same control the card view uses — see components/PeoplePick. It
          was a plain dropdown of names here, which ran off the bottom right of
          the window and looked nothing like the one two views away. */}
      <button ref={btn} onMouseEnter={load} onClick={() => { load(); setOpen((v) => !v); }}
        className="agx-btn text-left rounded px-1 -mx-1 py-0.5 hover:bg-white/5 text-[11px] flex items-center gap-1.5"
        style={{ color: "var(--text3)" }} title="Put somebody on this card, or take them off">
        <span className="min-w-0 truncate">Assign or unassign…</span>
        <span className="ml-auto shrink-0" style={{ color: "var(--text4)" }}>▾</span>
      </button>
      {open && (
        <PeoplePick
          anchor={btn}
          members={members}
          busy={members === null}
          isOn={(m) => on.has(m.id)}
          isSaving={(m) => saving === m.id}
          onPick={(m) => { void toggle(m); }}
          onClose={() => setOpen(false)}
          face={(m) => (m.avatar
            ? <img src={m.avatar} alt="" loading="lazy" referrerPolicy="no-referrer"
                style={{ width: 16, height: 16, borderRadius: 999, objectFit: "cover", flexShrink: 0 }} />
            : <span className="shrink-0 rounded-full inline-flex items-center justify-center"
                style={{ width: 16, height: 16, background: m.color || "var(--bg4)", color: "#fff", fontSize: 8 }}>{m.initials}</span>)}
        />
      )}
    </>
  );
}
function CardFacts({ d, root }: { d: PrDetail; root: string }) {
  const setup = useClickupSetup();
  /* Whether the agent here can post to Slack — see server/src/slackreach.ts.
     Asked once per mount rather than baked in: somebody connects the
     integration without restarting agentglass, and a button that only appears
     after the next launch reads as broken. */
  const [slack, setSlack] = useState(false);
  const [tell, setTell] = useState<"slack" | "card" | null>(null);
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState("");
  /* The wording the ping is sent with. The same catalogue the review menu
     reads, because it is the same kind of thing: personal, edited in Settings,
     stored in the user's own file and not in this repository. */
  const recipes = useReviewRecipes();
  const repoName = useContext(RepoCtx);
  useEffect(() => {
    let live = true;
    api.notifyReach().then((r) => { if (live) setSlack(!!r?.slack); }).catch(() => { /* assume not */ });
    return () => { live = false; };
  }, []);
  const ref = useMemo(() => mergeCardRef(d, setup), [d.headRefName, d.title, d.body, setup]);
  const query = ref?.query ?? "";
  /* The store tells everyone when an answer lands; this only has to redraw.
     Subscribed before the early return below — a pull request with no card
     still runs every hook, because `setup` arrives a render late and a
     component whose hook count changes takes the window with it. */
  const [, redraw] = useState(0);
  useEffect(() => onCard(() => redraw((n) => n + 1)), []);
  const hit = cardOf(query);
  const asking = askingCard(query);

  if (!ref) return null;

  const task = hit?.task ?? null;
  return (
    <SidebarSection title="ClickUp">
      <div className="flex flex-col gap-1.5 min-w-0">
        {/* The same pill the masthead wears, not a purple word that happens to
            be clickable — one link to one card, drawn one way. */}
        <span className="min-w-0">
          {/* The priority, so this chip is the colour it is everywhere else.
              `task` is a fresh read of the card rather than the board cache the
              row uses, so when the two differ this one is the newer. */}
          <CardPill label={ref.label}
            priority={task?.priority ?? null}
            onClick={() => openCard(ref.query, ref.label)}
            title={`Open ${ref.label} in Tasks${task ? ` — ${task.title}` : ""}${task?.priority ? ` · ${task.priority} priority` : ""}`} />
        </span>
        {/* Something in the hole while it is asked for, rather than a section
            that appears a second after the rest of the sidebar. */}
        {!task ? (
          <span className="text-[10.5px]" style={{ color: asking ? "var(--text3)" : "var(--warning)" }}>
            {asking ? "Reading the card…" : (hit?.error || "ClickUp could not find it")}
          </span>
        ) : (
          <>
            <CardStatusPick task={task} query={query} onSaid={setSaid} />
            {task.people?.length
              ? (
                <div className="flex flex-col gap-1">
                  {task.people.map((p, i) => (
                    <span key={p.id ?? `${p.name}-${i}`} className="flex items-center gap-1.5 text-[11px] min-w-0" style={{ color: "var(--text2)" }}>
                      {/* The face, as everywhere else people are drawn here.
                          Two initials is a puzzle in a workspace of five
                          hundred. */}
                      {p.avatar
                        ? <img src={p.avatar} alt="" loading="lazy" referrerPolicy="no-referrer"
                            style={{ width: 16, height: 16, borderRadius: 999, objectFit: "cover", flexShrink: 0 }} />
                        : <span className="shrink-0 rounded-full inline-flex items-center justify-center"
                            style={{ width: 16, height: 16, background: p.color || "var(--bg4)", color: "#fff", fontSize: 8 }}>
                            {p.initials}
                          </span>}
                      <span className="truncate">{p.name}{p.me ? " · you" : ""}</span>
                    </span>
                  ))}
                </div>
              )
              : <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>No one assigned</span>}
            <CardPeoplePick task={task} query={query} onSaid={setSaid} />

            {/* Telling somebody it is ready.
                Two routes, and they are not the same kind of thing. The card is
                ours to write on — agentglass holds a ClickUp token. Slack is
                not: posting there means holding a workspace token to do what an
                agent already does with its own, so that button gathers the
                facts and opens a tmux tab with an agent on it. Which is also
                why one of them can be missing and the other cannot. */}
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              {slack && (
                <button onClick={() => { setSaid(""); setTell(tell === "slack" ? null : "slack"); setMsg(""); }}
                  className="agx-btn text-[10.5px] px-2 py-0.5 rounded"
                  title="Ask an agent to say it in Slack — it writes the message"
                  style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
                  Ping Slack
                </button>
              )}
              <button onClick={() => { setSaid(""); setTell(tell === "card" ? null : "card"); setMsg(defaultPing(d, whoToTell(task))); }}
                className="agx-btn text-[10.5px] px-2 py-0.5 rounded"
                title="Write a note on this card's activity"
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
                Note on card
              </button>
              {said && <span className="text-[10px]" style={{ color: said.startsWith("!") ? "var(--warning)" : "var(--success)" }}>{said.replace(/^!/, "")}</span>}
            </div>

            {tell && (
              <div className="flex flex-col gap-1.5">
                {/* Two different boxes wearing one control. On the card it is
                    the note itself, prefilled with the sentence you were going
                    to type, and posted as it stands. In Slack the message is
                    the agent's to write, so this is only what you would have
                    added by hand — empty is the common case, and prefilling it
                    would put this app's English into somebody's DM. */}
                <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={3} spellCheck={false}
                  placeholder={tell === "slack" ? "Anything to add — what to look at first, whether it is urgent. Optional." : ""}
                  className="w-full px-2 py-1 rounded text-[11px] outline-none resize-y"
                  style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }} />
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] truncate min-w-0" style={{ color: "var(--text4)" }}>
                    {tell === "slack" ? `an agent writes it${whoToTell(task) ? ` to ${whoToTell(task)!.name}` : ""}, in the words that chat is written in` : `on ${whoToTell(task) ? `the card, to ${whoToTell(task)!.name}` : "the card"}`}
                  </span>
                  <button disabled={sending || (tell === "card" && !msg.trim())} className="agx-btn ml-auto shrink-0 text-[10.5px] px-2 py-0.5 rounded disabled:opacity-40"
                    style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
                    onClick={async () => {
                      const target = whoToTell(task);
                      if (tell === "slack") {
                        /* Handed over rather than sent, and handed to a tmux
                           window rather than to the chat. Slack is not ours to
                           post into — that takes an agent with its own
                           connection — and a message into somebody else's
                           workspace is not a fire-and-forget button: it is
                           worth watching, attached, where you can take the
                           keyboard off it before it says the wrong thing. */
                        const text = pingPrompt(recipes, {
                          number: d.number,
                          repo: repoName ?? "",
                          head: d.commits.length ? d.commits[d.commits.length - 1]!.oid : "",
                          branch: d.headRefName,
                          title: d.title,
                          author: d.author,
                          url: d.url,
                          card: ref.label,
                          // The address of the card actually resolved, not one
                          // built from the id: a message carrying `ORBIT-1042`
                          // and no link is the half that makes somebody search.
                          // Empty until ClickUp answers, which is also when the
                          // rest of this section is still a spinner.
                          cardUrl: task?.url || "",
                          who: target?.name ?? "",
                          note: msg.trim(),
                        });
                        requestTermIssue(root, `slack-${d.number}`, text, true, false, `Ping about #${d.number}`);
                        setTell(null); setSaid(`an agent has it in a tmux tab — "slack-${d.number}"`);
                        return;
                      }
                      if (!task) return;
                      setSending(true);
                      const r = await api.clickupComment(task.id, msg.trim(), target?.id ?? undefined).catch(() => null);
                      setSending(false);
                      if (r?.ok) { setTell(null); setSaid("written on the card"); }
                      else setSaid(`!${r?.error || "ClickUp refused it"}`);
                    }}>
                    {sending ? "Sending…" : tell === "slack" ? "Hand to a tmux tab" : "Write it"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </SidebarSection>
  );
}

/** Who the note is for: whoever is on the card. Falls back to nobody rather
 *  than to the pull request's author — telling somebody their own branch is
 *  ready is the one message that is never useful. */
function whoToTell(task: { people?: { id?: number; name: string }[] } | null): { id?: number; name: string } | null {
  return task?.people?.[0] ?? null;
}

/** The sentence, ready to send. The mention is always there, because a note
 *  that does not name anybody is a note nobody reads as theirs. */
function defaultPing(d: PrDetail, who: { name: string } | null): string {
  return `${who ? `@${who.name} ` : ""}PR ready to review — #${d.number} ${d.title}\n${d.url}`;
}

/**
 * The wording used when the catalogue has none — deleted, or not fetched yet.
 *
 * Short on purpose. It is not a second copy of the shipped prompt to keep in
 * step with it; it is the least that still makes a message rather than a paste,
 * for the seconds before the catalogue arrives and for somebody who deleted the
 * entry and pressed the button anyway.
 */
const FALLBACK_PING = [
  "Ask {who} for a review of pull request #{number} — {title} — in the chat we use for this.",
  "",
  "Not in these words: read the recent messages in the conversation you are posting in and write it the way they are written. Carry the link ({url}), the card ({card} {cardUrl}) and enough about the change to decide when to pick it up.",
  "",
  "{note}",
  "",
  "Show me the draft and where it will land, and wait.",
].join("\n");

/**
 * What the agent is asked to do, in the user's own words.
 *
 * The wording is NOT here. It is `ready-for-review` in the prompt catalogue,
 * which ships a neutral frame and is edited in Settings into whatever somebody
 * actually says to a colleague — their language, their greeting, their sign-off
 * — and stored in their own file. Wording that belongs to a person does not
 * belong in a repository, and this is the one prompt in the app that is read by
 * another human rather than by an agent.
 *
 * Expanded here rather than on the server because this prompt goes straight to
 * a tmux window from the panel; `expandRecipe` is shared so the two cannot
 * disagree about what `{card}` means.
 */
function pingPrompt(recipes: ReviewRecipe[], ctx: ReviewRecipeContext): string {
  const r = recipes.find((x) => x.id === PING_RECIPE);
  const body = (r?.body || "").trim() || FALLBACK_PING;
  const skill = r?.skill ? expandRecipe(r.skill, ctx).trim() : "";
  return [skill, expandRecipe(body, ctx).trim()].filter(Boolean).join("\n\n");
}

function PrSidebar({ d, root, spend, onEditField }: {
  d: PrDetail;
  root: string;
  /** What this branch cost locally, or null. See spendChipFor. */
  spend?: SpendChip | null;
  onEditField: (field: SidebarField, e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    /**
     * Pinned, because it is reference rather than reading.
     *
     * Who is reviewing this, what it is labelled, which milestone it is in —
     * these are the things you look up *while* reading the description, and
     * they were scrolling away with it. On a PR whose body runs to several
     * screens (this app's own do) they were gone by the second one, and the way
     * back was to scroll to the top and lose your place in the prose.
     *
     * `items-start` on the row is what makes this work: a stretched flex child
     * is already as tall as the column beside it, and an element that fills its
     * container has nothing to stick within. The tab strip is a sibling ABOVE
     * the scroll container rather than inside it, so `top-0` is the top of the
     * scrollport and nothing overlaps.
     *
     * The height cap and its scrollbar are a safety valve, not the usual case:
     * five short sections fit anywhere, but a PR with thirty reviewers must not
     * pin a list whose bottom cannot then be reached.
     */
    /*
     * `overflow-x-hidden` EXPLICITLY, and it is not redundant.
     *
     * This carried `overflow-y-auto` alone, which reads as "scroll vertically
     * and leave the other axis be". CSS does not do that: when one axis is a
     * scrolling value and the other is `visible`, the `visible` one computes to
     * `auto` — so the column had a horizontal scrollbar too, and it was on
     * screen, three quarters of the width, under a sidebar whose every section
     * is a narrow label. "It makes no sense for this scroll to be here, there
     * must never be sideways scroll here", and there is nothing here worth reaching
     * sideways for: a long label wants truncating, never a second axis.
     */
    <aside className="sticky top-0 shrink-0 w-[248px] pl-4 hidden lg:block overflow-y-auto overflow-x-hidden agx-scroll overscroll-contain"
      style={{ borderLeft: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", maxHeight: "calc(100vh - 6rem)" }}>
      <SidebarSection title="Reviewers" onEdit={(e) => onEditField("reviewers", e)}>
        {(() => {
          /*
           * THE VERDICT, ABOVE THE ROSTER IT CAME FROM.
           *
           * The masthead used to carry this — "× Changes requested · asked
           * again" — beside a second copy of the same three faces this
           * section already lists below. Two homes for one fact, and the
           * masthead one ran out of room the moment a verdict grew a note of
           * its own. This sidebar is the only one open on every tab, so the
           * headline moves here rather than disappearing with the row it
           * used to sit on.
           */
          const rows = reviewerRoster(d);
          const v = reviewVerdict(rows);
          const tint = v.kind === "approved" ? "var(--success)"
            : v.kind === "changes" ? "var(--error)"
            : v.kind === "awaiting" ? "var(--warning)" : "var(--text3)";
          const mark = v.kind === "approved" ? "✓" : v.kind === "changes" ? "✕"
            : v.kind === "commented" ? "💬" : "◯";
          return (
            <>
              {v.kind !== "none" && (
                <div className="flex items-center gap-1.5 text-[11px] mb-1.5" style={{ color: tint }} title={verdictLine(v)}>
                  <span aria-hidden style={{ fontSize: 14 }}>{mark}</span>
                  <b style={{ fontWeight: 500 }}>
                    {v.kind === "approved" ? "Approved" : v.kind === "changes" ? "Changes requested"
                      : v.kind === "commented" ? "Commented" : "Awaiting"}
                  </b>
                  {v.askedAgain && <span className="truncate" style={{ color: "var(--text4)" }}>· asked again</span>}
                </div>
              )}
              <ReviewerList rows={rows} />
            </>
          );
        })()}
      </SidebarSection>
      <SidebarSection title="Assignees" onEdit={(e) => onEditField("assignees", e)}>
        <SidebarPeople people={d.assignees.map((login) => ({ login }))} empty="No one assigned" />
      </SidebarSection>
      <SidebarSection title="Labels" onEdit={(e) => onEditField("labels", e)}>
        {d.labels.length
          ? <div className="flex flex-wrap gap-1">{d.labels.map((l) => <Chip key={l.name} text={l.name} tint={l.color ? `#${l.color}` : "var(--primary)"} />)}</div>
          : <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>None yet</span>}
      </SidebarSection>
      <SidebarSection title="Milestone" onEdit={(e) => onEditField("milestone", e)}>
        <span className="text-[11px]" style={{ color: d.milestone ? "var(--text2)" : "var(--text3)" }}>{d.milestone || "No milestone"}</span>
      </SidebarSection>
      {/* The one place with room to print the caveat rather than hide it behind
          a hover. The row's chip has to be six characters wide; this column is
          reference material, and a figure that is partly a guess should say so
          in words where words fit. Absent entirely when no local agent has
          spent anything on this branch — see spendChipFor for why that is not
          drawn as zero. */}
      {spend && (
        <SidebarSection title="Local spend">
          <div className="flex flex-col gap-0.5" title={spend.title}>
            <span className="text-[13px] tabular-nums" style={{ color: "var(--text)" }}>{spend.text}</span>
            <span className="text-[10px] leading-snug" style={{ color: "var(--text3)" }}>{spend.note}</span>
          </div>
        </SidebarSection>
      )}
      {d.linkedIssues.length > 0 && (
        <SidebarSection title="Development">
          <div className="flex flex-col gap-1">
            <span className="text-[10px]" style={{ color: "var(--text3)" }}>Merging this closes:</span>
            {/* Into the Issues view, not out to a browser.
                This link has been here for a while and was the only one in the
                app that left: everything else that knows about another view
                goes TO it — a card id opens the board, a PR number opens the
                pull-request panel. The arrow beside it is the way out, kept
                because an issue in another repository is a real case and the
                Issues view reads one repository. See lib/openIssue.ts. */}
            {d.linkedIssues.map((i) => (
              <span key={i.number} className="flex items-center gap-1 min-w-0">
                <button onClick={() => openIssue(i.number)}
                  className="agx-btn text-[11px] truncate text-left min-w-0"
                  style={{ color: "var(--primary)" }}
                  title={`Open #${i.number} in Tasks — ${i.title}`}>#{i.number} {i.title}</button>
                <a href={externalUrl(i.url)} target="_blank" rel="noreferrer noopener"
                  className="agx-btn text-[9px] shrink-0" style={{ color: "var(--text4)" }}
                  title="Open on GitHub">↗</a>
              </span>
            ))}
          </div>
        </SidebarSection>
      )}
      {d.participants.length > 0 && (
        <SidebarSection title={`${d.participants.length} participant${d.participants.length === 1 ? "" : "s"}`}>
          <div className="flex flex-wrap gap-1">
            {d.participants.map((p) => <span key={p} title={p}><Avatar login={p} size={20} /></span>)}
          </div>
        </SidebarSection>
      )}
      {/* Under the GitHub facts, where he asked for it: the pull request first,
          and then the card it came from. */}
      <CardFacts d={d} root={root} />
      {d.autoMerge && (
        <SidebarSection title="Auto-merge">
          <span className="text-[10.5px]" style={{ color: "var(--warning)" }}>
            Armed by {d.autoMerge.enabledBy} ({d.autoMerge.method.toLowerCase()})
          </span>
        </SidebarSection>
      )}
    </aside>
  );
}

/**
 * How a pull request's own state looks: colour, word and glyph.
 *
 * Merged is purple, closed is grey, draft is grey, open is green — GitHub's
 * palette, because everyone already reads it. A closed pull request wearing the
 * green of a passing build (which is what tinting by check verdict did) says
 * exactly the wrong thing.
 */
function prStateBadge(d: { state: PrSummary["state"]; isDraft: boolean }): { tint: string; state: string; glyph: string } {
  if (d.state === "MERGED") return { tint: "var(--primary)", state: "Merged", glyph: "⏣" };
  if (d.state === "CLOSED") return { tint: "var(--text3)", state: "Closed", glyph: "⊘" };
  if (d.isDraft) return { tint: "var(--text3)", state: "Draft", glyph: "◌" };
  return { tint: "var(--success)", state: "Open", glyph: "◉" };
}

function Masthead({ d, busy, onEditTitle, onDraft, onClose, onLocalReview, onReviewInTerminal, onLabels, onReviewers, onCopyLink, onNudge, onEditField, condensed, viewed, threads, queued, awaitingChecks, localHead }: {
  d: PrDetail; busy: boolean;
  /**
   * This branch on THIS machine — which checkout has it, and whether that tree is
   * dirty. Null while the question is out, and the cell is simply absent then:
   * "not checked out anywhere" is a claim, and it is the wrong one to make before
   * the answer has arrived.
   */
  localHead?: PrLocalHead | null;
  onEditTitle: () => void; onDraft: () => void; onClose: () => void; onLocalReview: (recipe?: string) => void;
  /** Absent when the workspace has no terminal to send it to. */
  onReviewInTerminal?: (recipe?: string) => void;
  /** Scrolled past the top: the metadata folds away and the title stays. */
  condensed?: boolean;
  /** The typed dialog behind the overflow menu; the inline ＋ buttons use the
   *  picker instead. */
  onLabels: () => void; onReviewers: () => void; onCopyLink: () => void; onNudge?: () => void;
  /** Opens the shared reviewer/label picker anchored to the clicked ＋. */
  onEditField: (field: SidebarField, e: React.MouseEvent<HTMLButtonElement>) => void;
  /** How far YOUR review has got: files ticked off, threads still open, line
   *  comments written and not sent. The panel owns all three — the strip only
   *  says them. */
  viewed: number; threads: number; queued: number;
  /** This panel pushed to the branch a moment ago, so runs are expected and an
   *  empty rollup means "not started" rather than "none". Same flag Overview
   *  gets, so the two boxes cannot disagree. */
  awaitingChecks?: boolean;
}) {
  /** Says "copied" in place of the branch for a moment. A clipboard write that
   *  looks like nothing happened is a clipboard write people do twice. */
  const [copiedBranch, setCopiedBranch] = useState(false);
  // The PR's own state, which is not the same thing as its check verdict —
  // colouring a merged pull request by whether CI went green says nothing about
  // it being merged. GitHub's palette: open green, merged purple, closed grey,
  // draft grey; each with its own glyph so the state reads without the word.
  const { tint, state, glyph } = prStateBadge(d);
  /*
   * What the checks add up to, asked of the helpers rather than of the rollup.
   *
   * `checksStanding` is where "an empty rollup is not a green one" lives: a
   * head commit that moved a second ago has no runs yet and looks exactly like
   * a repository that runs none, and only the caller knows which. Deciding it
   * again here would be a second opinion on a question that already has an
   * answer, and the header and the Overview box would drift apart the first
   * time either was touched — which is the bug mergeReason.ts was written for.
   *
   * The sentence is the helpers' too, for the same reason: the strip and the
   * box say the same words about the same rollup. `checksLine` covers green
   * and still-running and answers null on the two it deliberately will not
   * speak for — nothing red, and nothing at all.
   *
   * Red is `mergeBlockedWhy`, asked as "UNSTABLE" rather than as this pull
   * request's merge state: the cell is keyed CHECKS, so a conflict with the
   * base is not its answer to give, and UNSTABLE is the state that means "ask
   * the rollup". It names the check, which is the whole point of that helper —
   * a bare count is what sends people to the browser to find out which one.
   */
  const c = d.checks;
  const standing = checksStanding(c, awaitingChecks);
  /*
   * The strip's own wording, which is shorter than Overview's on purpose.
   *
   * The mockup spends this cell on `44/45 running`; the helper spends it on
   * "2 checks passed, 3 checks still running". Both are true and only one fits
   * on a row of nine cells — the sentence belongs in Overview, where there is a
   * paragraph to put it in. Red still names the failing check, because a name
   * is the thing that stops you opening the browser, and the mockup's sample
   * has no red to diverge from.
   */
  /* `success`, never `total`. The rollup's total counts skipped, stale and
     neutral runs as well, so a repository with path-filtered jobs read "45
     passed" in green when forty had run and five had been skipped — and the
     running form said "40/45" when forty-four were already done. Skipped is
     said out loud rather than folded into either number. */
  /* GitHub caps the contexts page at 100 and the server records it. Without
     saying so, a pull request with 130 checks whose only red one is beyond the
     first hundred drew a green dot and "100 passed" while GitHub showed it red. */
  const checksCapped = !!d.truncated?.checks;
  /* Both sentences come out of `mergeReason.ts` now. The compact one had its
     own ladder here and the two drifted within the hour: the cell said "40
     passed · 5 skipped" while its own tooltip, built from `checksLine`, said
     "45 checks passed". */
  const checksStrip = c.failure > 0 ? mergeBlockedWhy("UNSTABLE", c)
    : checksShort(c, checksCapped)
    ?? (standing === "awaiting" ? "waiting for them to start" : "none reported");
  const checksSaid = checksLine(c, undefined, checksCapped)
    ?? (c.failure > 0 ? mergeBlockedWhy("UNSTABLE", c)
      : standing === "awaiting" ? "waiting for them to start"
      : "none reported");
  const checksTint = c.failure > 0 ? "var(--error)"
    /* Never green on a capped page: green is a claim about every check, and
       this is a claim about the hundred that came back. */
    : checksCapped ? "var(--warning)"
    : standing === "green" ? "var(--success)"
    // Nothing reported is grey, never green. The tint is the part of this cell
    // people read from across the desk, so it is the part that must not lie.
    : standing === "none-reported" ? "var(--text3)"
    : "var(--warning)";
  /* Three answers, and the one that matters is "not answered yet" — see wtCell.
     Drawing "not checked out here" while the question is still out would be the
     header claiming the opposite of the truth for the second before it lands. */
  const wt = wtCell(localHead);
  const [copied, setCopied] = useState(false);
  const copyNumber = () => {
    navigator.clipboard?.writeText(`#${d.number}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })
      .catch(() => { /* no clipboard permission */ });
  };
  return (
    <div className="px-3 pt-2.5 pb-2 shrink-0" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-[9.5px] px-1.5 py-0.5 rounded-full align-middle inline-flex items-center gap-1"
            style={{ color: tint, border: `1px solid color-mix(in srgb, ${tint} 45%, transparent)`, background: `color-mix(in srgb, ${tint} 12%, transparent)` }}>
            <span aria-hidden>{glyph}</span>{state}
          </span>
          <span className="text-[14px] leading-snug ml-2" style={{ color: "var(--text)" }}>
            {/* A button, not just text: clicking copies "#NNNNN" to paste as a
                cross-reference, and it looks pressable so that is discoverable. */}
            <button onClick={copyNumber} aria-live="polite"
              title={copied ? "Copied!" : `Copy #${d.number}`}
              className="agx-btn tabular-nums align-middle inline-flex items-center gap-1 mr-1.5 px-1.5 py-0.5 rounded-md text-[12px]"
              style={{ color: copied ? "var(--success)" : "var(--text2)", border: `1px solid color-mix(in srgb, ${copied ? "var(--success) 50%" : "var(--border) 55%"}, transparent)`, background: "color-mix(in srgb, var(--border) 14%, transparent)" }}>
              #{d.number}
              <span aria-hidden style={{ fontSize: 10, opacity: 0.7 }}>{copied ? "✓" : "⧉"}</span>
            </button>
            {/* Beside the number, not down in the fields: this is the pull
                request's OTHER identity — the one the rest of the company files
                it under — and it has to stay on screen once the metadata folds
                away, which is exactly when you are deep enough in a diff to
                have forgotten what the card asked for. */}
            <PrCardChip pr={d} card={d.card} />
            {d.title}
          </span>
        </div>
        {/* Out of the menu and onto the masthead. This is the one action here
            that is the reason the panel exists — handing a pull request to an
            agent instead of to a browser tab — and it was three clicks deep
            behind a ⋯ that also holds "Close pull request". Beside the menu
            rather than inside it. */}
        {/* Two places the same review can happen, and they are not a setting:
            the chat renders from the transcript and keeps the pane out of
            sight, the terminal gives you the session itself, attached, in a tab
            beside your shells. Which one you want depends on whether you intend
            to watch or to join in. */}
        {/* A terminal first, and the chat last, in both copies — see
            ReviewMenu. The chat pane is a second home for a conversation that
            already has one: a real agent in a real tmux window, which survives
            a restart of this app and is where the work continues after the
            review. The chat is kept because it is occasionally the quicker
            read, not because it is the better place to send somebody. */}
        <ReviewMenu d={d} canTerm={!!onReviewInTerminal}
          onPick={(recipe, where) => (where === "term" ? onReviewInTerminal?.(recipe) : onLocalReview(recipe))} />
        {/* Out of the overflow, because it is the most-pressed thing in it.
            "Open on GitHub" is what you reach for whenever this panel does not
            do the thing — and burying the escape hatch two clicks deep is the
            one place it must not be. */}
        {/* The panel's own Btn, `small`, exactly as the two beside it. Written
            by hand first with its own padding, radius and type size, so three
            controls in a row came out three different heights — which is the
            only reason the group looked wrong. */}
        <Btn small onClick={() => openExternal(d.url)} title="Open on GitHub">GitHub ↗</Btn>
        <Menu label="⋯" title="More actions">
          {(close) => (
            <>
              {/* One family of glyphs, all thin outlines on the same optical
                  weight. It had an emoji link among stroked marks, which is the
                  only reason the column looked ragged — a colour pictogram next
                  to line art reads as a different size whatever its em box says.
                  ⧉ for copy is the one the machine panel already uses. */}
              <MenuItem onClick={() => { close(); onEditTitle(); }}>&#9998; Edit title</MenuItem>
              {/* Requesting a review or flipping the draft flag are things you do
                  to a pull request that is still going. On a merged one GitHub
                  does not offer them either. */}
              {d.state === "OPEN" && <>
                <MenuItem onClick={() => { close(); onReviewers(); }}>&#9673; Request a review</MenuItem>
                <MenuItem onClick={() => { close(); onDraft(); }}>◌ {d.isDraft ? "Mark ready for review" : "Convert to draft"}</MenuItem>
              </>}
              <MenuItem onClick={() => { close(); onLabels(); }}>⌗ Edit labels</MenuItem>
              <MenuSep />
              <MenuItem onClick={() => { close(); onCopyLink(); }}>&#9033; Copy link</MenuItem>
              {onNudge && d.state === "OPEN" && (
                <MenuItem onClick={() => { close(); onNudge(); }}>&#128276; Nudge the reviewers</MenuItem>
              )}
              {d.state !== "MERGED" && <>
                <MenuSep />
                <MenuItem onClick={() => { close(); onClose(); }} danger={d.state !== "CLOSED"}>
                  {d.state === "CLOSED" ? "↺ Reopen pull request" : "✕ Close pull request"}
                </MenuItem>
              </>}
            </>
          )}
        </Menu>
      </div>

      {/* One strip, and it carries what a pull request is.

          Packed left and wrapping, not stretched to fill: six fields spread
          across a wide pane put Milestone a screen away from Author, and the
          eye has to travel the whole width to read one header. That spread is
          also why the two fields anybody actually opens a pull request for —
          is it green, does it want something from me — were not here at all:
          there was no room left, so each of them cost a tab.

          Folded away once you start reading. Author, branch, reviewers and the
          rest answer questions you ask on arrival, not questions you ask while
          scrolling a diff — and they were taking a fifth of the window to keep
          answering them. The title, the number and the state stay, because
          those are what tell you which pull request you are still in. */}
      {!condensed && (
      <div className="flex flex-wrap items-start gap-x-5 gap-y-2 mt-2.5 -mx-3 -mb-2 px-3 py-2"
        style={{
          borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)",
          background: "color-mix(in srgb, var(--border) 14%, transparent)",
        }}>
        <Field label="Author"><Avatar login={d.author} size={14} />{d.author}</Field>
        <Field label="Branch" max={460} title={`${d.headRefName} → ${d.baseRefName}`}>
          {/* The branch name is a thing you paste into a shell — `git checkout`,
              a worktree, a comment — and it was selectable text you had to drag
              across, truncated, in a chip. One click copies it. A button rather
              than a click handler on the code element, so it says out loud that
              it does something. */}
          <button
            onClick={() => { void navigator.clipboard?.writeText(d.headRefName); setCopiedBranch(true); setTimeout(() => setCopiedBranch(false), 1400); }}
            title={`${d.headRefName}\n\nClick to copy`}
            className="px-1 py-0.5 rounded text-[10.5px] truncate max-w-full hover:opacity-80 cursor-pointer"
            /* The NAME stays put and the chip tints for a moment. Swapping the
               label for the word "copied" collapsed a forty-character chip to
               six, so the row jumped and "→ master" slid across the header to
               report a success — feedback that moves the thing you were
               reading is worse than none. */
            style={{
              ...CODE_FONT_STYLE,
              color: copiedBranch ? "var(--success)" : "var(--primary)",
              background: copiedBranch
                ? "color-mix(in srgb, var(--success) 18%, transparent)"
                : "color-mix(in srgb, var(--primary) 12%, transparent)",
              transition: "background 120ms, color 120ms",
            }}>
            {d.headRefName}
          </button>
          {/* The base is tinted when it is NOT the trunk, which is the one fact
              about a destination worth a colour — this lands on somebody's
              stack, not on main — and it is the rule the list rows already
              use, so the header and the list say it the same way. */}
          <span style={{ color: "var(--text4)" }}>→</span>
          <span className="truncate" style={{ color: isTrunk(d.baseRefName) ? "var(--text3)" : "var(--warning)" }}>{d.baseRefName}</span>
        </Field>
        {/*
          * Where this branch lives on this machine.
          *
          * Asked for after using the terminal's own header, which carries the
          * worktree with Git and Diff beside it — the pull request knew the branch
          * name and said nothing about the checkout it is sitting in, so "is this
          * the one I have open" was a trip to a shell. It goes next to Branch
          * because it is the same fact continued: the branch, and then where it is.
          *
          * Nothing at all until the answer is in (see the prop), and a plain
          * sentence when the answer is "nowhere" — a branch nobody has checked out
          * is worth knowing about, and it is not an error.
          */}
        {wt.kind !== "unknown" && (
          <Field label="Worktree" max={380} title={wtCellTitle(localHead)}>
            {wt.kind === "here" ? (
              <>
                {/* The same filled pill the terminal's header uses for a
                    worktree, so the two headers say this one thing the same way. */}
                <span className="px-1.5 py-0.5 rounded text-[9.5px] uppercase tracking-wider shrink-0"
                  style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>WT</span>
                <span className="truncate" style={{ color: "var(--text2)" }}>{wt.folder}</span>
                {/* A tree with work in it. The terminal's chip carries a count;
                    the answer here is a yes or no (see PrLocalHead.dirty), so it
                    says that and no more rather than inventing a number. */}
                {wt.dirty && (
                  <span title="That worktree has uncommitted changes" style={{ color: "var(--warning)" }}>●</span>
                )}
                {/* The two trips worth offering, and the same two the terminal
                    offers, through the same request — so a press here and a press
                    there land in the same place. */}
                <button onClick={() => requestWorktreeJump({ view: "git", root: wt.root })}
                  className="agx-btn inline-flex items-center gap-1 px-1.5 rounded shrink-0"
                  title="Open that worktree in Source control"
                  style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
                  Git <span className="t-dim2">↗</span>
                </button>
                <button onClick={() => requestWorktreeJump({ view: "diff", filter: wt.folder })}
                  className="agx-btn inline-flex items-center gap-1 px-1.5 rounded shrink-0"
                  title="Open its changes in File changes"
                  style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
                  Diff <span className="t-dim2">↗</span>
                </button>
              </>
            ) : (
              <span style={{ color: "var(--text3)" }}>not checked out here</span>
            )}
          </Field>
        )}
        <Field label="Changes">
          <span className="tabular-nums" style={{ color: "var(--success)" }}>+{d.additions}</span>
          <span className="tabular-nums" style={{ color: "var(--error)" }}>−{d.deletions}</span>
          <span style={{ color: "var(--text3)" }}>· {d.changedFiles} file{d.changedFiles === 1 ? "" : "s"}</span>
        </Field>
        <Field label="Assignee" max={190}>
          {d.assignees.length === 0
            ? <span style={{ color: "var(--text3)" }}>unassigned</span>
            : d.assignees.map((a) => <span key={a} className="flex items-center gap-1 truncate"><Avatar login={a} size={14} />{a}</span>)}
        </Field>
        <Field label="Milestone" max={190}>
          {d.milestone ? <span className="truncate">{d.milestone}</span> : <span style={{ color: "var(--text3)" }}>none</span>}
        </Field>
        {/*
          * The two the header never had.
          *
          * "Is it green" and "does it want something from me" are the questions
          * a pull request gets opened for, and both of them lived a tab away —
          * so the header answered everything except the reason you came. They
          * are last in the row on purpose: the fields before them say WHICH
          * pull request this is, and these two say what it is doing.
          */}
        <Field label="Checks" max={320} title={`${c.total} check${c.total === 1 ? "" : "s"} · ${checksSaid}`}>
          <Dot tint={checksTint} />
          <span className="truncate">{checksStrip}</span>
        </Field>
        <Field label="Review" title="Your own progress through it — files you have ticked off, threads nobody has resolved, and line comments written but not sent">
          <span className="tabular-nums">{viewed}</span>
          {/* `changedFiles` and not `files.length`: the second is the page
              GitHub returned, which caps, and the cell two positions left says
              `changedFiles` — so on a large pull request the same row read
              "150 files" and "0/100 viewed". */}
          <span style={{ color: "var(--text4)" }}>/{d.changedFiles} viewed</span>
          {/* All three, zeros included, which is the mockup's shape. A cell
              that changes length as the numbers change is harder to scan than
              one that is always the same, and on a row this dense the eye finds
              a number by where it sits rather than by reading across. A zero is
              also an answer: "no threads" is what you wanted to know. */}
          <span style={{ color: "var(--text4)" }}>·</span>
          <span style={{ color: threads > 0 ? "var(--warning)" : "var(--text4)" }}>
            {threads} thread{threads === 1 ? "" : "s"}
          </span>
          <span style={{ color: "var(--text4)" }}>·</span>
          <span style={{ color: queued > 0 ? "var(--primary)" : "var(--text4)" }}>{queued} queued</span>
        </Field>
      </div>
      )}
    </div>
  );
}

function Reason({ tint, glyph, children, action }: { tint: string; glyph: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
      style={{ color: "var(--text)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
      <span className="shrink-0 w-3.5 text-center" style={{ color: tint }}>{glyph}</span>
      <span className="min-w-0">{children}</span>
      {action && <span className="ml-auto shrink-0 text-[10px]">{action}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// files & commits
// ---------------------------------------------------------------------------

function DiffToolbar({ path, add, del, split, wrap, onSplit, onWrap, right }: {
  path?: string; add?: number; del?: number; split: boolean; wrap: boolean;
  onSplit: (v: boolean) => void; onWrap: (v: boolean) => void; right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px] shrink-0"
      style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 10%, transparent)" }}>
      {path && <span className="truncate" style={{ color: "var(--text)" }}>{path}</span>}
      {add != null && <span className="tabular-nums shrink-0" style={{ color: "var(--success)" }}>+{add}</span>}
      {del != null && <span className="tabular-nums shrink-0" style={{ color: "var(--error)" }}>−{del}</span>}
      <span className="ml-auto flex items-center gap-1 shrink-0">
        {right}
        <Toggle on={split} onClick={() => onSplit(!split)} title="Split / unified">{split ? "Split" : "Unified"}</Toggle>
        <Toggle on={wrap} onClick={() => onWrap(!wrap)} title="Toggle line wrap">Wrap</Toggle>
      </span>
    </div>
  );
}

/**
 * Where each file box inside a commit was scrolled to.
 *
 * Every one of them is its own scroller — a diff is capped at 520px and scrolls
 * inside that — so leaving the tab and coming back put every open commit back
 * at the top of every file. Keyed by the thing being read (the commit) and the
 * file, and written on scroll rather than collected on the way out: a node that
 * has left the document reports a scrollTop of zero, which is how the Files tab
 * managed to remember zero perfectly for an hour.
 */
const DIFF_SCROLL = new Map<string, number>();

/** Several files, each with its own header — how a commit reads. */
function FileStack({ files, split, wrap, onSplit, onWrap, scope }: {
  files: FileChange[]; split: boolean; wrap: boolean; onSplit: (v: boolean) => void; onWrap: (v: boolean) => void;
  /** What these files belong to — a commit's sha. Without one nothing is
   *  remembered, which is right for a caller that has no stable identity. */
  scope?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const keyOf = (el: HTMLElement): string | null => {
    const box = el.closest("[data-diff-file]") as HTMLElement | null;
    const path = box?.dataset.diffFile;
    if (!scope || !path) return null;
    // A split diff has two scrollers side by side and they scroll together, but
    // the key still says which, so restoring cannot cross them over.
    return `${scope}:${path}:${(el as HTMLElement).dataset.side ?? "u"}`;
  };
  /* Put back after mount, and keep trying while the diff is still being
     highlighted — the box is short until then and the offset gets clamped. */
  useEffect(() => {
    const root = wrapRef.current;
    if (!root || !scope) return;
    let alive = true;
    const started = Date.now();
    const put = () => {
      if (!alive) return;
      let done = true;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-vscroll]"))) {
        const k = keyOf(el);
        const want = k ? DIFF_SCROLL.get(k) ?? 0 : 0;
        if (!want) continue;
        if (Math.abs(el.scrollTop - want) > 1) { el.scrollTop = want; done = false; }
      }
      if (done || Date.now() - started > 6_000) return;
      requestAnimationFrame(put);
    };
    requestAnimationFrame(put);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, files, split, wrap]);
  return (
    <div ref={wrapRef} className="flex flex-col gap-2"
      /* Capture, because a scroll event does not bubble. */
      onScrollCapture={(e) => {
        const el = e.target as HTMLElement;
        const k = keyOf(el);
        if (k) DIFF_SCROLL.set(k, el.scrollTop);
      }}>
      {files.map((f, i) => (
        <div key={f.file_path} data-diff-file={f.file_path} className="rounded overflow-hidden flex flex-col"
          style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", maxHeight: 520 }}>
          <DiffToolbar path={f.file_path} add={f.additions} del={f.deletions}
            split={split} wrap={wrap} onSplit={i === 0 ? onSplit : onSplit} onWrap={onWrap} />
          <div className="flex-1 min-h-0 flex">
            <DiffPane file={f} split={split} wrap={wrap} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders its children only once they have come near the viewport.
 *
 * Every file on this tab is open by default, which is the right default for
 * reading a change — but mounting sixty syntax-highlighted diffs at once is not
 * a tab you can scroll. This keeps the default and pays for each diff at the
 * moment it is about to be looked at; `once` means scrolling back up does not
 * unmount what you already read.
 */
function LazyMount({ minHeight, children }: { minHeight: number; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) return;
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") { setShown(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setShown(true); io.disconnect(); } }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);
  return <div ref={box} style={shown ? undefined : { minHeight }}>{shown ? children : null}</div>;
}

/** Above this many changed lines a file starts folded. A 4,000-line lockfile is
 *  not something anybody reads, and it should not be what the tab opens on. */
const BIG_FILE_LINES = 600;


/** Generated files GitHub holds behind a "Load diff" button — lockfiles,
 *  minified bundles, source maps. Nobody reads these line by line, and a
 *  4,000-row lockfile is not what the tab should spend its frame budget on. */
const GENERATED_RE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum|flake\.lock)$|\.min\.(js|css)$|\.(map|lock)$/i;
function needsLoadDiff(f: PrFile): boolean {
  return GENERATED_RE.test(f.path) || f.additions + f.deletions > 1500;
}

/** The extension a file is filed under in the facet menu — the last `.suffix`
 *  of the basename, lower-cased (`pnpm-lock.yaml` → `.yaml`). A dotfile or a
 *  file with no extension (`Dockerfile`, `.gitignore`) is filed under its own
 *  name, which is what GitHub does too. */
function fileExt(path: string): string {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : base;
}

/** A one-glyph status marker for the changed-files tree, coloured the way GitHub
 *  colours them: added green, removed red, renamed/copied blue, and a muted ±
 *  for a plain modification. `changeType` arrives lower-cased from the server. */
function statusGlyph(status: string): { ch: string; tint: string; title: string } {
  switch (status) {
    case "added": return { ch: "+", tint: "var(--success)", title: "Added" };
    case "removed":
    case "deleted": return { ch: "−", tint: "var(--error)", title: "Deleted" };
    case "renamed": return { ch: "→", tint: "var(--primary)", title: "Renamed" };
    case "copied": return { ch: "⧉", tint: "var(--primary)", title: "Copied" };
    default: return { ch: "±", tint: "var(--text3)", title: "Modified" };
  }
}

/**
 * "Open the whole file", and the second and a half it takes to say anything.
 *
 * This does not read the checkout: the pull request's copy is fetched from
 * GitHub — the pull request itself to resolve its head, then the file at that
 * commit — so two network round trips happen before a pane can appear. Without
 * a pending state the click answered nothing for a beat, which reads as a click
 * that missed, and the second click starts the whole thing again.
 *
 * Its own component because the state is per file and these are rendered from a
 * list: one flag on the parent would put every Open button in the header into
 * the same spinner.
 */
function PeekButton({ path, onPeek }: { path: string; onPeek: (p: string) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy}
      onClick={async () => { setBusy(true); try { await onPeek(path); } finally { setBusy(false); } }}
      title={busy ? "Fetching this file from GitHub at the pull request's head commit…" : "Open the whole file in an editor"}
      className="agx-btn shrink-0 flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded"
      style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>
      {busy ? <><span className="agx-spin" style={{ width: 9, height: 9 }} />Opening…</> : "⧉ Open"}
    </button>
  );
}

function FileTree({ node, sel, onPick, onPeek, seen, drafts, pending, moved, depth = 0 }: {
  node: TreeNode<PrFile>; sel: string | null; onPick: (p: string) => void;
  /** Open the whole file in an editor, over the panel. The diff shows what
   *  changed; this is for the times the answer is in the part that did not. */
  onPeek?: (p: string) => void | Promise<void>;
  seen: (p: string) => boolean; drafts: (p: string) => number;
  /** How many comments GitHub is holding in an unsubmitted review on this file.
   *  A different thing from `drafts`, which never left this browser, and the
   *  reason the tree needs its own mark: a review you started on the website is
   *  invisible here otherwise, and you find out you had one by submitting. */
  pending: (p: string) => number;
  /** Changed since your own last review. Marked whether or not the list is filtered
   *  to them, because the question "is this one of the three that moved" is asked of
   *  a row while reading it, not only while filtering. */
  moved?: (p: string) => boolean;
  depth?: number;
}) {
  return (
    <>
      {[...node.dirs.values()].map((dir) => (
        <div key={dir.path}>
          <div className="truncate text-[10px] px-1 py-0.5" style={{ paddingLeft: 6 + depth * 10, color: "var(--text3)" }} title={dir.path}>
            {dir.name}
          </div>
          <FileTree node={dir} sel={sel} onPick={onPick} onPeek={onPeek} seen={seen} drafts={drafts} pending={pending} moved={moved} depth={depth + 1} />
        </div>
      ))}
      {node.files.map((f) => {
        const base = f.path.split("/").pop() ?? f.path;
        const on = sel === f.path;
        const n = drafts(f.path);
        const pend = pending(f.path);
        return (
          <button key={f.path} onClick={() => onPick(f.path)}
            // Alt-click opens it whole, which is the gesture that costs nothing
            // to learn because it costs nothing to not know.
            onAuxClick={(e) => { if (e.button === 1 && onPeek) { e.preventDefault(); onPeek(f.path); } }}
            title={`${f.path}${f.status ? ` · ${f.status}` : ""}${onPeek ? " · alt-click to open the whole file" : ""}`}
            onClickCapture={(e) => { if (e.altKey && onPeek) { e.preventDefault(); e.stopPropagation(); onPeek(f.path); } }}
            className="agx-btn w-full text-left flex items-center gap-1 py-0.5 rounded truncate hover:bg-white/5 agx-peekrow"
            style={{
              paddingLeft: 6 + depth * 10, paddingRight: 4,
              background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined,
              color: seen(f.path) ? "var(--text3)" : "var(--text2)",
            }}>
            {/* Which files are new, which changed — the status marker GitHub puts
                on every row of its tree, so an added file reads as added without
                opening it. */}
            {(() => { const g = statusGlyph(f.status); return <span className="shrink-0 text-center leading-none" style={{ width: 12, fontSize: 10, color: g.tint }} title={g.title}>{g.ch}</span>; })()}
            <span className="truncate text-[10.5px]">{base}</span>
            {/* Moved since you reviewed it. A dot rather than a word: the row already
                carries a status glyph, a draft mark and two counts, and the one thing
                this has to do is survive being glanced at. */}
            {moved?.(f.path) && (
              <span className="shrink-0" title="Changed since your last review"
                style={{ width: 6, height: 6, borderRadius: 999, background: "var(--warning)" }} />
            )}
            {/* Something is drafted here, on GitHub. A count would read as the
                thread count two marks along; a speech bubble with a pen says
                what it is, and the title says the rest. */}
            {pend > 0 && (
              <span className="shrink-0 ml-1" title={`${pend} comment${pend === 1 ? "" : "s"} drafted on GitHub in your unsubmitted review`}>
                <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" aria-hidden="true"
                  stroke="var(--primary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 4.2a1.7 1.7 0 0 1 1.7-1.7h7.6a1.7 1.7 0 0 1 1.7 1.7v4.6a1.7 1.7 0 0 1-1.7 1.7H6.4L3.2 13v-2.5h-.7z" />
                  <path d="M6 6.6h4" />
                </svg>
              </span>
            )}
            {n > 0 && <span className="ml-auto text-[10px] shrink-0" style={{ color: "var(--warning)" }}>{n}</span>}
            {f.comments > 0 && <span className="ml-auto text-[10px] shrink-0" style={{ color: "var(--primary)" }}>{f.comments}</span>}
            {seen(f.path) && <span className="ml-auto text-[10px] shrink-0" style={{ color: "var(--success)" }}>✓</span>}
          </button>
        );
      })}
    </>
  );
}

/**
 * The changed-files filter, GitHub's funnel: a menu of the extensions present in
 * this diff (each with its own count) and a toggle for whether files you have
 * already marked viewed still show. `hiddenExts` is the set to leave out — empty
 * means every extension is on, which is why the boxes all start ticked.
 */
function FilesFilterMenu({ facets, hiddenExts, onToggleExt, onClearExts, showViewed, onToggleViewed, viewedCount, shownCount, unseenCount, onSeenAll }: {
  facets: { ext: string; count: number }[];
  hiddenExts: string[]; onToggleExt: (e: string) => void; onClearExts: () => void;
  showViewed: boolean; onToggleViewed: () => void; viewedCount: number;
  /** How many files the filter is showing, and how many of those are unticked —
   *  the two numbers the bulk actions are about. */
  shownCount: number; unseenCount: number;
  /** Tick or un-tick everything on screen. Scoped to what the FILTER is showing on
   *  purpose: "all" meaning "the forty you cannot see either" is how somebody ticks a
   *  review they have not read. */
  onSeenAll: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Keep the panel on screen when the funnel sits near the right edge.
      setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 236) });
    }
  }, [open]);
  const active = hiddenExts.length > 0 || !showViewed;
  const box = (on: boolean) => ({ width: 14, height: 14, borderRadius: 4, border: `1px solid ${on ? "var(--primary)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`, background: on ? "var(--primary)" : "transparent", color: "var(--bg)" });
  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((o) => !o)} title="Filter changed files"
        aria-label="Filter changed files" aria-haspopup="menu" aria-expanded={open}
        className="agx-btn shrink-0 grid place-items-center rounded"
        style={{ width: 24, height: 22, color: active ? "var(--primary)" : "var(--text3)", border: `1px solid color-mix(in srgb, ${active || open ? "var(--primary)" : "var(--border) 45%"}, transparent)` }}>
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5h12L9.3 9v4L6.7 14.3V9L2 3.5Z" /></svg>
      </button>
      {open && (
        <Portal>
          <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => setOpen(false)} />
          <div role="menu" className="fixed p-1.5 rounded-xl flex flex-col overflow-hidden text-[11px]"
            style={{ top: pos.top, left: pos.left, minWidth: 216, maxHeight: "min(60vh, 420px)", zIndex: 9999, background: "color-mix(in srgb, var(--bg2) 97%, black)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)", backdropFilter: "blur(18px)" }}>
            <div className="px-2 pt-1 pb-1 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>File extensions</div>
            <div className="flex flex-col gap-0.5 overflow-y-auto agw-noscrollbar">
              {facets.map((f) => {
                const on = !hiddenExts.includes(f.ext);
                return (
                  <button key={f.ext} role="menuitemcheckbox" aria-checked={on} onClick={() => onToggleExt(f.ext)}
                    className="px-2 py-1.5 rounded-lg text-left flex items-center gap-2 hover:bg-white/5">
                    <span aria-hidden className="shrink-0 grid place-items-center text-[10px]" style={box(on)}>{on ? "✓" : ""}</span>
                    <span className="flex-1 truncate" style={{ ...CODE_FONT_STYLE, color: on ? "var(--text)" : "var(--text3)" }}>{f.ext}</span>
                    <span className="tabular-nums shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>{f.count}</span>
                  </button>
                );
              })}
            </div>
            <button role="menuitemcheckbox" aria-checked={showViewed} onClick={onToggleViewed}
              className="mt-1 px-2 py-1.5 rounded-lg text-left flex items-center gap-2 hover:bg-white/5"
              style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
              <span aria-hidden className="shrink-0 grid place-items-center text-[10px]" style={box(showViewed)}>{showViewed ? "✓" : ""}</span>
              <span className="flex-1" style={{ color: "var(--text2)" }}>Viewed files</span>
              <span className="tabular-nums shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>{viewedCount}</span>
            </button>
            {hiddenExts.length > 0 && (
              <button onClick={onClearExts} className="mt-0.5 px-2 py-1 rounded-lg text-left text-[10.5px] hover:bg-white/5" style={{ color: "var(--text3)" }}>Reset extensions</button>
            )}
            {/*
              * Ticking forty files one at a time is what this replaces — and it is
              * kept here, in the menu, rather than put on the bar: it acts on every
              * file on screen at once, which is not a thing to have under the pointer
              * beside "Unified".
              *
              * Scoped to what the filter shows, and the label says so. "Mark all
              * viewed" that included files the filter is hiding is how somebody ticks
              * a review they have not read.
              */}
            {shownCount > 0 && (
              <>
                <div className="mt-1 mb-0.5" style={{ height: 1, background: "color-mix(in srgb, var(--border) 26%, transparent)" }} />
                <button onClick={() => { onSeenAll(true); setOpen(false); }} disabled={unseenCount === 0}
                  title={`Tick the ${shownCount} file${shownCount === 1 ? "" : "s"} this filter is showing${unseenCount === 0 ? " — they are all ticked already" : ""}`}
                  className="px-2 py-1 rounded-lg text-left text-[10.5px] hover:bg-white/5 disabled:opacity-40"
                  style={{ color: "var(--text2)" }}>
                  ✓ Mark {shownCount} shown as viewed
                </button>
                <button onClick={() => { onSeenAll(false); setOpen(false); }} disabled={viewedCount === 0}
                  title="Un-tick every file this filter is showing"
                  className="px-2 py-1 rounded-lg text-left text-[10.5px] hover:bg-white/5 disabled:opacity-40"
                  style={{ color: "var(--text3)" }}>
                  ↺ Un-tick them
                </button>
              </>
            )}
          </div>
        </Portal>
      )}
    </>
  );
}

/**
 * Search the code of a whole review, GitHub-style — the answer to "where else
 * is this called?" without opening thirteen files and searching each one.
 *
 * Deliberately not the browser's Ctrl+F, which is blind here: files fold when
 * you mark them viewed, diffs are lazy-mounted, and a big file is held behind a
 * button — so most of the review is not in the DOM to be found. This searches
 * the diffs in memory, which are all there, and then opens what it found.
 */
function FindBar({ value, onChange, inputRef, listRef, hits, groups, at, onGo, onClose, fileCount, loaded }: {
  value: string; onChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  listRef: React.RefObject<HTMLDivElement>;
  hits: Match[]; groups: { path: string; matches: Match[] }[]; at: number;
  onGo: (i: number) => void; onClose: () => void;
  fileCount: number; loaded: boolean;
}) {
  const edge = "1px solid color-mix(in srgb, var(--text) 20%, transparent)";
  const typed = value.trim().length >= 2;
  // The index each group's first match sits at, so a row knows its own place in
  // the flat list without the render doing arithmetic per row.
  let running = 0;
  const numbered = groups.map((g) => { const from = running; running += g.matches.length; return { ...g, from }; });
  const nav = (dir: 1 | -1) => onGo(at + dir);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md"
        style={{ background: "var(--bg)", border: edge }}>
        <span className="shrink-0" style={{ color: "var(--primary)" }}>⌕</span>
        <input
          ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={`Search the code of ${fileCount} file${fileCount === 1 ? "" : "s"}…`}
          spellCheck={false} autoComplete="off"
          className="flex-1 min-w-0 bg-transparent outline-none text-[11px]"
          style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}
          onKeyDown={(e) => {
            // Held here rather than on the frame: while you are typing, the
            // frame never sees a key, and Enter has to mean "next" for this to
            // feel like every other find bar ever built.
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
            else if (e.key === "Enter") { e.preventDefault(); nav(e.shiftKey ? -1 : 1); }
            else if (e.key === "ArrowDown") { e.preventDefault(); nav(1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); nav(-1); }
          }}
        />
        <span className="shrink-0 tabular-nums text-[10px] px-1" style={{ color: hits.length ? "var(--text2)" : "var(--text3)" }}>
          {!typed ? "" : hits.length ? `${at + 1} / ${hits.length}` : "no match"}
        </span>
        <span className="shrink-0 flex items-center gap-1">
          <button onClick={() => nav(-1)} disabled={!hits.length} title="Previous match (⇧↵)"
            className="agx-btn text-[11px] leading-none px-1.5 py-1 rounded"
            style={{ border: edge, color: hits.length ? "var(--text2)" : "var(--text4)" }}>↑</button>
          <button onClick={() => nav(1)} disabled={!hits.length} title="Next match (↵)"
            className="agx-btn text-[11px] leading-none px-1.5 py-1 rounded"
            style={{ border: edge, color: hits.length ? "var(--text2)" : "var(--text4)" }}>↓</button>
          <CloseButton onClick={onClose} title="Close (Esc)" style={{ border: edge, color: "var(--text2)" }} className="agx-btn rounded" />
        </span>
      </div>

      {/* The results, not just a counter: seeing the four lines it matched is
          usually the whole answer, and beats being teleported to the first one
          and having to press Enter to survey the rest. */}
      {typed && (
        <div ref={listRef} className="agx-scroll rounded-md overflow-y-auto"
          style={{ maxHeight: "38vh", background: "var(--bg)", border: edge }}>
          {!hits.length ? (
            <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
              {loaded ? <>Nothing matches “{value.trim()}” in this review.</> : <>Still loading the diffs — search will answer once they are in.</>}
            </div>
          ) : (
            <>
              {numbered.map((g) => (
                <div key={g.path}>
                  <div className="sticky top-0 z-[1] px-2.5 py-1 flex items-center gap-2"
                    style={{ background: "color-mix(in srgb, var(--text) 7%, var(--bg))", borderBottom: "1px solid color-mix(in srgb, var(--text) 12%, transparent)" }}>
                    <span className="truncate text-[10.5px]" style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}>{g.path}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-[10px]" style={{ color: "var(--text3)" }}>{g.matches.length}</span>
                  </div>
                  {g.matches.map((m, i) => {
                    const idx = g.from + i;
                    const on = idx === at;
                    const e = excerpt(m);
                    return (
                      <button key={idx} data-hit={on ? "on" : undefined} onClick={() => onGo(idx)}
                        className="w-full text-left flex items-baseline gap-2 px-2.5 py-1 hover:bg-white/5"
                        style={{
                          background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : undefined,
                          // A rail, not a border: the row keeps its height and
                          // the list does not jog by a pixel as you walk it.
                          boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
                        }}>
                        <span className="shrink-0 tabular-nums text-[10px] w-[52px] text-right"
                          style={{ color: m.side === "LEFT" ? "var(--error)" : "var(--text3)" }}>
                          {m.side === "LEFT" ? "−" : ""}{m.line}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-[10.5px]" style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }}>
                          {e.before}
                          <span style={{ background: "color-mix(in srgb, var(--primary) 38%, transparent)", color: "var(--text)", borderRadius: 2, padding: "0 1px" }}>{e.hit}</span>
                          {e.after}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {/* findInDiffs stops at 500. A list that quietly ended early is
                  how you conclude a symbol is used nowhere else. */}
              {hits.length >= 500 && (
                <div className="px-2.5 py-1.5 text-[10px]" style={{ color: "var(--warning)" }}>
                  First 500 matches — narrow the search to see the rest.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The file header's exact height. Fixed rather than whatever its padding adds
 *  up to, so the one pinned bar in this view has a height the scroll maths can
 *  rely on instead of measure. */
const FILE_HEAD_H = 30;

/** The box that actually scrolls an element up and down — see
 *  `verticalScrollerOf`, which is where the rule and the reason live. */
const vScrollerOf = (el: Element): HTMLElement | null =>
  verticalScrollerOf(el as HTMLElement, (e) => getComputedStyle(e).overflowY);

/**
 * The pull request, in the shape it will be, while it is being fetched.
 *
 * A centred spinner is honest about the wait and wrong about the space: the
 * pull request does not arrive, it REPLACES the spinner, and a masthead, a row
 * of tabs and a page of text all appear where a single word was. Standing the
 * blocks where the real ones stand turns landing into a fill.
 */
function DetailSkeleton({ number }: { number: number | null }) {
  const bar = (h: number, w: string, delay: number) => (
    <div className="rounded animate-pulse" aria-hidden
      style={{ height: h, width: w, background: "color-mix(in srgb, var(--text) 7%, transparent)", animationDelay: `${delay}s` }} />
  );
  return (
    <div className="p-3 flex flex-col gap-3" role="status" aria-label={`Loading pull request ${number ?? ""}`}>
      {/* masthead: title, then the strip of facts under it */}
      <div className="flex flex-col gap-2">
        {bar(20, "58%", 0)}
        <div className="flex gap-4">{["96px", "120px", "88px", "104px"].map((w, i) => bar(11, w, 0.05 * (i + 1)))}</div>
      </div>
      {/* the tab row */}
      <div className="flex gap-3 pt-1" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        {["64px", "92px", "70px", "58px", "62px"].map((w, i) => <div key={i} className="pb-2">{bar(11, w, 0.03 * i)}</div>)}
      </div>
      {/* the body: a wide column and the sidebar beside it, same as Overview */}
      <div className="flex gap-4">
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          {["100%", "94%", "88%", "62%"].map((w, i) => bar(12, w, 0.04 * i))}
          <div className="mt-2 rounded-lg animate-pulse" aria-hidden
            style={{ height: 120, background: "color-mix(in srgb, var(--text) 5%, transparent)" }} />
        </div>
        <div className="shrink-0 flex flex-col gap-2" style={{ width: 230 }}>
          {["70%", "88%", "54%", "76%"].map((w, i) => bar(11, w, 0.05 * i))}
        </div>
      </div>
    </div>
  );
}

/** Where the Files tab was left, per pull request. Outside the component
 *  because the component is what goes away when you change tab. */
const FILES_SCROLL = new Map<string, number>();

function FilesTab({ d, root, byPath, loaded, diffErr, seenFiles, onSeen, onSeenMany, noWs, onNoWs, wsOnly, since, moved, movedHere, wantSince, onRefetchSince, sel, onSel, onShowing, split, wrap, onSplit, onWrap, drafts, held, onAddDraft, onPostOne, onDropDraft, onPeek, onResolve, onReply, onApply, busy }: {
  d: PrDetail; root: string; byPath: Map<string, FileChange>; loaded: boolean;
  /** Why the diff is missing, when it is missing for a reason rather than for a
   *  moment. Without it a refusal is drawn as a spinner. */
  diffErr?: string;
  seenFiles: string[]; onSeen: (p: string) => void;
  /** Tick or un-tick everything the filter is showing, in one go. */
  onSeenMany: (paths: string[], on: boolean) => void;
  /** Whitespace-only changes folded into context — see diffNoWhitespace.ts. A
   *  preference, so it is set here and remembered. */
  noWs: boolean; onNoWs: (v: boolean) => void;
  /** Files that hold nothing BUT whitespace changes, and are therefore not in the
   *  list at all while `noWs` is on. Named rather than silently dropped. */
  wsOnly: string[];
  /** Which two commits "since your review" is measuring, and the answer — both held
   *  by the panel, because the Overview shows the same number and the two must not be
   *  able to disagree. */
  since: { from: string; to: string } | null;
  moved: { key: string; paths: Set<string>; missing?: boolean } | null;
  /** The moved files that are actually part of this review. */
  movedHere: string[];
  /** Bumped when somebody asks to arrive with the filter on. */
  wantSince: number;
  /** Ask the panel to compare again — after a fetch has brought the missing commit
   *  into this clone. */
  onRefetchSince: () => void;
  sel: string | null; onSel: (p: string | null) => void;
  /**
   * Which file is ACTUALLY on screen, which is not the same as which one was
   * picked. In one-file mode nothing is picked until you click, and the tab
   * falls back to the first file the filter left — so the diff had a file in it
   * and the rail beside it said "Nothing selected", which is the column
   * disclaiming the very thing the reader is looking at.
   *
   * Reported here rather than recomputed there: the fallback depends on the
   * filter, the hidden extensions and whether viewed files are shown, and all
   * three live in this component.
   */
  onShowing?: (p: string | null) => void;
  split: boolean; wrap: boolean; onSplit: (v: boolean) => void; onWrap: (v: boolean) => void;
  drafts: DraftComment[];
  /** Your unsubmitted review on GitHub, drawn on the lines it belongs to. */
  held: PendingLine[];
  onAddDraft: (path: string, line: number, startLine?: number, side?: "LEFT" | "RIGHT", body?: string) => void;
  /** Post one line comment on its own, now — the other half of what GitHub
   *  offers at the box, beside holding it for a review. */
  onPostOne: (path: string, line: number, startLine: number | undefined, side: "LEFT" | "RIGHT" | undefined, body: string) => Promise<boolean>;
  /** Discard a pending comment from where it is shown, rather than only from
   *  the Review tab it is otherwise buried in. */
  onDropDraft: (d: DraftComment) => void;
  /** Open a file whole, over the panel, in an editor. */
  onPeek?: (path: string) => void | Promise<void>;
  onResolve: (t: PrThread) => void; onReply: (t: PrThread, body: string) => Promise<boolean>;
  onApply?: (t: PrThread, text: string) => void; busy: boolean;
}) {
  /*
   * One file at a time, or the whole stack.
   *
   * This is what makes the middle column a COLUMN rather than a page with a
   * navigator glued to it: with one file in it, the tree, the diff and the rail
   * each do one job and none of them changes what the other two are showing.
   *
   * On by default, and it is a preference rather than a rule because the stack
   * is genuinely better for one thing — reading a small pull request end to end
   * without deciding anything. Nine files is a review; three is a read.
   */
  const [oneFile, setOneFile] = useState(() => {
    try { return localStorage.getItem("agentglass.pr.oneFile") !== "0"; } catch { return true; }
  });
  const setOne = (v: boolean) => {
    setOneFile(v);
    try { localStorage.setItem("agentglass.pr.oneFile", v ? "1" : "0"); } catch { /* private mode */ }
  };

  const draftsFor = (p: string) => drafts.filter((x) => x.path === p).length;
  const heldFor = (p: string) => held.filter((x) => x.path === p).length;
  /** This file's pending comments, keyed the way a diff row asks for them:
   *  the side letter and the line, so a row can find its own without scanning
   *  the whole list on every render. */
  /* The comments GitHub is holding for this file, by line. Read-only: there is
     no API that edits one, so they are drawn and nothing else. Keyed on the new
     side, which is where GitHub reports a pending line comment. */
  const heldBy = (p: string) => {
    const m = new Map<number, PendingLine[]>();
    for (const h of held) {
      if (h.path !== p || h.line == null) continue;
      const arr = m.get(h.line) ?? [];
      arr.push(h);
      m.set(h.line, arr);
    }
    return m;
  };
  const pendingBy = (p: string) => {
    const m = new Map<string, DraftComment[]>();
    for (const dc of drafts) {
      if (dc.path !== p) continue;
      const k = `${dc.side === "LEFT" ? "L" : "R"}${dc.line}`;
      const arr = m.get(k) ?? [];
      arr.push(dc);
      m.set(k, arr);
    }
    return m;
  };
  // For the "+" menu's Copy link: a blob permalink at the PR head commit.
  const repoName = useContext(RepoCtx);
  const headSha = d.commits.length ? d.commits[d.commits.length - 1].oid : "";
  // The text of one line as it stands in the diff — used to seed a "Suggest
  // change" with the line it is about, the way GitHub prefills the block.
  const lineTextAt = (path: string, line: number, side: "LEFT" | "RIGHT"): string => {
    const ch = byPath.get(path);
    if (!ch) return "";
    for (const h of ch.hunks) {
      let oldN = h.oldStart, newN = h.newStart;
      for (const raw of h.lines) {
        if (raw.startsWith("\\")) continue;
        const tag = raw[0], text = raw.slice(1);
        if (tag === "+") { if (side === "RIGHT" && newN === line) return text; newN++; }
        else if (tag === "-") { if (side === "LEFT" && oldN === line) return text; oldN++; }
        else { if ((side === "RIGHT" && newN === line) || (side === "LEFT" && oldN === line)) return text; oldN++; newN++; }
      }
    }
    return "";
  };
  /**
   * The line, or range of lines, a comment is being written about.
   *
   * A plain click starts at that line; shift-click extends from it, which is
   * GitHub's gesture for "this whole block". Kept here rather than in the diff
   * component so the highlight survives a re-render of the file and so only one
   * file can be mid-selection at a time.
   */
  const [selRange, setSelRange] = useState<{ path: string; sel: LineSel } | null>(null);
  // Which line has a NEW-comment composer open, and (for Suggest change) the
  // text it opened with. The composer renders inline under the line via the same
  // rowAfter slot the threads use — GitHub's placement, not a modal.
  const [composing, setComposing] = useState<{ path: string; line: number; startLine?: number; side: "LEFT" | "RIGHT"; initial?: string } | null>(null);
  /** Where a half-written comment is kept: this pull request, this file, this
   *  line. Not the range — a comment stretched over lines 12–18 is still being
   *  written about the line you clicked. */
  const composeStashKey = (path: string, side: "LEFT" | "RIGHT", line: number) =>
    `${root}#${d.number}|${path}|${side === "LEFT" ? "L" : "R"}${line}`;
  // Cancel is the one thing that means "I do not want this". Everything else —
  // closing the box, changing tabs, a rebuild — keeps it.
  const cancelCompose = () => {
    if (composing) writeStash(composeStashKey(composing.path, composing.side, composing.line), "");
    setComposing(null); setSelRange(null);
  };

  /** Turn the open composer into a suggestion, seeded with the line it is
   *  about — what the menu's "Suggest change" used to do, moved to where you
   *  can decide it with the code in front of you. */
  const suggestHere = (f: PrFile, c: NonNullable<typeof composing>) => {
    const body = lineTextAt(f.path, c.line, c.side);
    setComposing({ ...c, initial: `\`\`\`suggestion\n${body}\n\`\`\`\n` });
  };

  const pickLine = (path: string, pk: LinePick) => {
    const cur = selRange?.path === path ? selRange.sel : null;
    if (pk.shift && cur && cur.side === pk.side) {
      const sel = { start: cur.start, end: pk.line, side: pk.side };
      const line = Math.max(sel.start, sel.end), startLine = Math.min(sel.start, sel.end);
      setSelRange({ path, sel });
      setComposing({ path, line, startLine: startLine !== line ? startLine : undefined, side: pk.side });
      return;
    }
    // A single line: mark it (a following shift-click can stretch the range) and
    // open the composer under it. "Suggest change" seeds a ```suggestion block.
    setSelRange({ path, sel: { start: pk.line, end: pk.line, side: pk.side } });
    const initial = pk.mode === "suggest" ? "```suggestion\n" + lineTextAt(path, pk.line, pk.side) + "\n```\n" : undefined;
    setComposing({ path, line: pk.line, side: pk.side, initial });
  };
  /** Unresolved first: a resolved thread is history, an open one is a question. */
  const threadsFor = (p: string) => d.threads.filter((t) => t.path === p)
    .sort((a, b) => Number(a.isResolved) - Number(b.isResolved));
  const frameRef = useRef<HTMLDivElement>(null);
  /*
   * Files scrolls inside itself, so the panel's per-tab memory cannot see it.
   *
   * This component unmounts when you step to another tab, which is why the
   * store is outside it: a ref would go with the component. Keyed by pull
   * request, so a different one starts at the top.
   */
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const key = `${root}#${d.number}`;
    const want = FILES_SCROLL.get(key) ?? 0;
    if (want) {
      let alive = true;
      const started = Date.now();
      const put = () => {
        if (!alive) return;
        if (el.scrollTop < want - 1) el.scrollTop = want;
        if (Math.abs(el.scrollTop - want) <= 1 || Date.now() - started > 8_000) return;
        requestAnimationFrame(put);
      };
      requestAnimationFrame(put);
      return () => { alive = false; };
    }
    return;
  }, [root, d.number]);
  /*
   * How tall the tree may be, measured rather than guessed.
   *
   * It cannot be a percentage: the tree is `sticky` in a row whose height is
   * the diff's, so a percentage would resolve against a column of diff and let
   * the tree grow past the screen. It cannot be `100vh - something` either:
   * that "something" is a guess about everything above this frame, and on a
   * screen where the guess is short the tree comes out taller than its own
   * column — which is the scroll that belongs to nothing, dragging the toolbar
   * and the file list up with it.
   *
   * So: the frame's own height, minus where the tree starts inside it, kept up
   * to date by a ResizeObserver and published as a CSS variable.
   */
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const put = () => el.style.setProperty("--agx-tree-max", `${Math.max(160, el.clientHeight - 76)}px`);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /**
   * How tall the sticky toolbar is, right now.
   *
   * Anything scrolled to — a file picked in the tree, the next hunk, the next
   * file under j/k — otherwise lands underneath it: `scrollIntoView` aligns to
   * the top of the scroll box and knows nothing about a bar floating over that
   * top. Measured rather than guessed, because the bar wraps to two rows on a
   * narrow panel, and fed to `scroll-margin-top`, which is the property
   * `scrollIntoView` actually honours.
   */
  const barRef = useRef<HTMLDivElement>(null);
  /** The frame the running jump has booked, so the next one can take it back. */
  const alignRaf = useRef(0);
  const [barH, setBarH] = useState(76);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setBarH(el.offsetHeight + 10);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /**
   * Scroll to something and put it just under the sticky bar — and STAY on it
   * while the diffs around it mount.
   *
   * The offset first: `scrollIntoView` aligns to the top of the scrollport and
   * the bar floats over that top, so anything asked for lands behind it.
   * `scroll-margin` is the documented cure and did not take here, so this does
   * the arithmetic itself against the real scroll container.
   *
   * Diffs are lazy-mounted (see LazyMount): a file below the fold is a short
   * placeholder until it scrolls near, then it swaps in its real, taller
   * content. A one-shot scroll to the last file therefore landed on where the
   * file was BEFORE the files above it grew — "the end of what's loaded so far",
   * never the file. So this re-aligns every frame, snapping the target back under
   * the bar as the placeholders above it fill in, and only lets go once the
   * target has held still for three frames running (or a ~60-frame ceiling).
   * The element is re-queried each frame because the mount replaces its node —
   * and a `getEl` that comes back empty is a target that has not mounted YET,
   * so it keeps waiting rather than giving up on the first miss. Instant, not
   * smooth: a smooth scroll and a moving target fight each other.
   */
  const scrollToFileStable = (getEl: () => Element | null | undefined) => {
    // One jump at a time. Holding the target for ~24 frames means two jumps
    // asked for in quick succession — j held down, Enter walking the results —
    // would otherwise overlap, and two aligners with different targets writing
    // to the same scrollTop every frame is a shudder, not a scroll.
    cancelAnimationFrame(alignRaf.current);
    let ticks = 0, still = 0, lastTop = NaN;
    const align = () => {
      const el = getEl();
      if (el) {
        // The scroller is resolved per frame, not once: the first frame may
        // only have the file's placeholder, whose scroll parent is the page,
        // while the row that replaces it sits inside the split diff's own
        // horizontally-scrolling pane.
        const sc = vScrollerOf(el);
        if (!sc) { el.scrollIntoView({ block: "start" }); return; }
        // Two pinned things, not one. A LINE has the file's own header pinned
        // above it as well as the toolbar, so aiming at the bar alone parks the
        // line behind the file's name — which is where the first attempt at
        // this put it, four pixels of a highlighted row peeking out. The
        // header's own rectangle is what decides it, not `barH + FILE_HEAD_H`:
        // the bar is measured into state by a ResizeObserver and the header
        // pins against that state, so the two disagree by a few pixels for as
        // long as it takes a re-render — and this runs inside that window.
        // While the file is still below the fold its header has not pinned yet
        // and reads low, which only means the next frame corrects it. A FILE
        // card is the thing that header belongs to, so it takes no allowance.
        const head = el.matches("[data-path]") ? null : el.closest("[data-path]")?.querySelector("[data-file-head]");
        const scTop = sc.getBoundingClientRect().top;
        const floor = Math.max(scTop + (barRef.current?.offsetHeight ?? 76), head?.getBoundingClientRect().bottom ?? 0);
        sc.scrollTop = Math.max(0, sc.scrollTop + (el.getBoundingClientRect().top - floor) - 8);
        const now = el.getBoundingClientRect().top;
        still = !Number.isNaN(lastTop) && Math.abs(now - lastTop) <= 1 ? still + 1 : 0;
        lastTop = now;
      }
      // A floor as well as a ceiling. Stability alone lets go too early: the
      // file card lands where it belongs on the first frame and sits there,
      // "still", while the diff inside it is still a placeholder — so the row
      // that arrives four frames later never gets aimed at. Keep re-aiming for
      // ~24 frames whatever happens, which is a third of a second nobody sees.
      ticks++;
      if (ticks < 60 && (ticks < 24 || still < 3)) alignRaf.current = requestAnimationFrame(align);
    };
    alignRaf.current = requestAnimationFrame(align);
  };
  const [q, setQ] = useState("");
  /*
   * Finding a word across every file, which the browser's own Ctrl+F cannot do
   * here: a file folds when you mark it viewed and the diff is windowed, so
   * half the matches live in nodes that do not exist yet. "Where else is this
   * helper called?" is the question a review asks most, and until now the only
   * way to answer it was to open thirteen files and search each one.
   */
  const [find, setFind] = useState<string | null>(null);
  const [findAt, setFindAt] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const findListRef = useRef<HTMLDivElement>(null);
  // The facet filter: extensions to leave OUT (empty = show every extension),
  // and whether files already marked viewed still show. Both scope one review of
  // one PR.
  const [hiddenExts, setHiddenExts] = useState<string[]>([]);
  const [showViewed, setShowViewed] = useState(true);
  // Folded, not opened: every file is open by default and this records the ones
  // you have put away. Seeded with the files too big to be a sensible default.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // A generated or very large diff is held behind a "Load diff" button even when
  // its file is open — GitHub does the same — so a lockfile does not render a
  // thousand rows nobody reads. This records the ones you asked to load anyway.
  const [loadedDiffs, setLoadedDiffs] = useState<Set<string>>(new Set());
  // Reset per PR — keyed on the NUMBER, not on `d.files`. The 20-second poll
  // hands back a fresh `d.files` array each time; depending on it here meant
  // every background refresh wiped the folds you had made and the filter you had
  // typed, and the re-expansion jumped the page back to the top mid-review.
  useEffect(() => {
    setQ(""); setHiddenExts([]); setShowViewed(true); setLoadedDiffs(new Set());
    setFind(null); setFindAt(0);
    setFolded(new Set(d.files.filter((f) => f.additions + f.deletions > BIG_FILE_LINES).map((f) => f.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.number]);
  // A file already marked viewed arrives folded. Coming back to a half-read
  // review used to reopen every file you had already ticked off, so the eleven
  // you were done with were back in the way and the two still to read were
  // somewhere below them. Marking a file viewed folds it; finding it already
  // viewed should mean the same thing.
  //
  // Once per file, not once per poll: `foldedOnce` is what stops the twenty
  // second refresh from re-folding a viewed file you have deliberately opened
  // back up to look at again.
  const foldedOnce = useRef<Set<string>>(new Set());
  useEffect(() => { foldedOnce.current = new Set(); }, [d.number]);
  useEffect(() => {
    const late = seenFiles.filter((p) => !foldedOnce.current.has(p));
    if (!late.length) return;
    for (const p of late) foldedOnce.current.add(p);
    setFolded((cur) => new Set([...cur, ...late]));
  }, [seenFiles]);

  const extFacets = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of d.files) { const e = fileExt(f.path); m.set(e, (m.get(e) ?? 0) + 1); }
    return [...m.entries()].map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
  }, [d.files]);
  const viewedCount = useMemo(() => d.files.filter((f) => seenFiles.includes(f.path)).length, [d.files, seenFiles]);

  /** Matches for the current find, across every file the list is showing —
   *  computed from the diffs already in hand, so it costs a pass over memory
   *  and no network at all. */
  const findHits = useMemo(() => {
    if (!find || find.trim().length < 2) return [];
    return findInDiffs(d.files.map((f) => ({ path: f.path, change: byPath.get(f.path) })), find);
  }, [find, d.files, byPath]);
  const findGroups = useMemo(() => groupByFile(findHits), [findHits]);

  /** The query this find has already jumped to, so it only ever does so once —
   *  and null while a new one is still waiting to. Declared up here with the
   *  rest of the find state: a ref read by the callbacks below is exactly the
   *  kind of binding that goes temporally dead if it is written underneath
   *  them. */
  const autoJumped = useRef<string | null>(null);

  /** Open a match: unfold the file it is in, load the diff if it was held back,
   *  select the line so the eye lands ON it rather than somewhere in the right
   *  region, and scroll it under the bar. */
  const goToMatch = useCallback((m: Match) => {
    setFolded((cur) => { const n = new Set(cur); n.delete(m.path); return n; });
    setLoadedDiffs((cur) => new Set(cur).add(m.path));
    onSel(m.path);
    setSelRange({ path: m.path, sel: { side: m.side, start: m.line, end: m.line } });
    requestAnimationFrame(() => {
      // Aim for the line, settle for the file. A diff below the fold is still a
      // LazyMount placeholder when this runs, so the row does not exist yet;
      // the aligner re-queries every frame, and picks the line up the moment it
      // mounts. Scoped to the file — "R412" exists in most of them.
      scrollToFileStable(() => {
        const host = frameRef.current?.querySelector(`[data-path="${CSS.escape(m.path)}"]`);
        return host?.querySelector(`[data-ln="${m.side === "LEFT" ? "L" : "R"}${m.line}"]`) ?? host;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSel]);

  /** Step through the results. The index is the cursor; everything else — which
   *  file is open, where the page is — follows from it. */
  const goToIndex = useCallback((i: number) => {
    if (!findHits.length) return;
    const n = ((i % findHits.length) + findHits.length) % findHits.length;
    // Moving by hand settles where this query lands: the jump-to-first below
    // must not come along afterwards and take it back.
    autoJumped.current = (find ?? "").trim();
    setFindAt(n);
    goToMatch(findHits[n]!);
  }, [find, findHits, goToMatch]);

  // A new query starts at its first hit rather than wherever the last one left
  // the cursor, which would be an index into a list that no longer exists.
  useEffect(() => { setFindAt(0); autoJumped.current = null; }, [find]);
  /**
   * Searching takes you there, the way every find bar does.
   *
   * Typing used to only count the matches: the page stayed wherever it was, and
   * seeing the first one meant pressing Enter or clicking a row — so a search
   * answered "there are four" without ever showing you one of them.
   *
   * Once per query, and only the first: pressing Enter or clicking a result
   * moves the cursor on from there and nothing drags it back. A later keystroke
   * is a new query and re-arms it. Held a beat so a word typed at speed jumps
   * once, at the end, rather than chasing each prefix down the file — and armed
   * on `findHits` too, so a query typed while the diffs are still arriving
   * lands the moment they do.
   */
  useEffect(() => {
    if (find === null) return;
    const key = find.trim();
    if (key.length < 2 || autoJumped.current === key || !findHits.length) return;
    const t = setTimeout(() => {
      // Checked again on the way out, not just on the way in: Enter pressed
      // inside those 160ms has already moved the cursor to the second hit, and
      // firing anyway would drag the page back to the first while the counter
      // still read 2 / 4.
      if (autoJumped.current !== null) return;
      autoJumped.current = key;
      goToMatch(findHits[0]!);
    }, 160);
    return () => clearTimeout(t);
  }, [find, findHits, goToMatch]);
  // Keep the active result in view in the list as Enter walks past the bottom.
  useEffect(() => {
    findListRef.current?.querySelector('[data-hit="on"]')?.scrollIntoView({ block: "nearest" });
  }, [findAt]);

  /**
   * Ctrl+F, the key everyone already presses.
   *
   * On `window`, not on the frame: the point is that it works wherever you are
   * on the page, and the frame only sees keys when something inside it has
   * focus. The browser's own find is preventDefault'd away — it cannot see
   * folded files or unmounted rows, so leaving it in place would answer "no
   * results" for a word that is in four files.
   */
  /*
   * …and only while this tab is the thing on screen.
   *
   * The workspace keeps every visited view mounted (see Workspace.tsx), so
   * this effect used to run wherever you were: leave the Files tab open, walk
   * over to the board, press Ctrl+F, and the diff's find opened on a view you
   * could not see. `checkVisibility` on this tab's own box is the honest test —
   * it answers no for a `visibility: hidden` ancestor, which is exactly how a
   * background view is hidden.
   *
   * `capture: true`, and it matters: the shell's own find bar listens on the
   * same window. Capture runs first, so this one gets to decide, and stopping
   * the event there is what keeps the two from both opening. When it declines,
   * it touches nothing and the shell's bar takes it.
   */
  useEffect(() => {
    const onWinKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      // A terminal owns its own keys — a peeked file is being read in nvim, and
      // Ctrl+F there is page-down.
      if ((e.target as HTMLElement)?.closest?.(".xterm")) return;
      const box = frameRef.current as (HTMLElement & { checkVisibility?: () => boolean }) | null;
      if (!box) return;
      if (typeof box.checkVisibility === "function" ? !box.checkVisibility() : !box.offsetParent) return;
      e.preventDefault();
      e.stopPropagation();
      setFind((cur) => cur ?? "");
      requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); });
    };
    window.addEventListener("keydown", onWinKey, true);
    return () => window.removeEventListener("keydown", onWinKey, true);
  }, []);

  const movedSet = useMemo(() => new Set(movedHere), [movedHere]);
  const [sinceOnly, setSinceOnly] = useState(false);
  /* Turned on from outside — the Overview's "3 files changed since your review"
     brings you here with the filter already applied, because arriving at forty files
     and being told to find the three yourself is the trip this feature removes. */
  useEffect(() => { if (wantSince) setSinceOnly(true); }, [wantSince]);
  const [fetching, setFetching] = useState(false);
  /* Turned off by itself when it would select nothing — a filter with no answers is a
     tab that looks empty for a reason nobody can see. */
  useEffect(() => { if (sinceOnly && !movedHere.length) setSinceOnly(false); }, [sinceOnly, movedHere.length]);
  useEffect(() => { setSinceOnly(false); }, [d.number]);

  const shownFiles = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const movedSet = new Set(movedHere);
    const wsSet = new Set(wsOnly);
    const kept = d.files.filter((f) => {
      if (needle && !f.path.toLowerCase().includes(needle)) return false;
      if (hiddenExts.length && hiddenExts.includes(fileExt(f.path))) return false;
      if (!showViewed && seenFiles.includes(f.path)) return false;
      if (sinceOnly && !movedSet.has(f.path)) return false;
      /* A file whose every change was whitespace has nothing left to draw. It leaves
         the list rather than sitting in it with an empty diff — and the line under the
         tree says how many went, because a file that vanishes with no explanation is
         a reader wondering what else did. */
      if (wsSet.has(f.path)) return false;
      return true;
    });
    /* In the order the rail paints them, not the order GitHub sends them — see
       `treeOrder`. Everything downstream calls this list "the files": the tree,
       the stack of diffs, j/k, and what "the next one" means to the Viewed tick.
       They agree only if the list is already in the order you read. */
    return treeOrder(kept);
  }, [d.files, q, hiddenExts, showViewed, seenFiles, sinceOnly, movedHere, wsOnly]);

  /* The same expression the render uses below, so the rail can never name a
     different file from the one drawn. In all-files mode there is no single
     answer and the honest one is none. */
  const showing = oneFile ? (sel ?? shownFiles[0]?.path ?? null) : sel;
  useEffect(() => { onShowing?.(showing); }, [showing, onShowing]);

  const toggleFold = (p: string) => setFolded((cur) => {
    const next = new Set(cur);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });
  // Marking a file viewed folds it away, and un-marking opens it back up — the
  // pairing GitHub uses, so "viewed" clears a read diff off the screen instead of
  // leaving it in the way.
  const seenAndFold = (path: string) => {
    const wasViewed = seenFiles.includes(path);
    onSeen(path);
    setFolded((cur) => {
      const next = new Set(cur);
      if (wasViewed) next.delete(path); else next.add(path);
      return next;
    });
    // Where the tick leaves you — see `afterViewed`. In the stack: marking a
    // file viewed collapses it, everything under it jumps up by however tall it
    // was, and the file you move on to would arrive already scrolled to wherever
    // the last one happened to end, so the next one is put at the top. In one-
    // file mode there is nothing under it to scroll to, so the next file is
    // opened instead.
    const move = afterViewed(shownFiles.map((f) => f.path), path, { oneFile, wasViewed });
    if (move.kind === "stay") return;
    if (move.kind === "open") {
      onSel(move.path);
      const frame = frameRef.current;
      if (frame) vScrollerOf(frame)?.scrollTo({ top: 0 });
      return;
    }
    requestAnimationFrame(() => {
      scrollToFileStable(() => document.querySelector(`[data-path="${move.path}"]`));
    });
  };
  const allFolded = shownFiles.length > 0 && shownFiles.every((f) => folded.has(f.path));

  // The same keyboard model as the changes modal, so the two review surfaces
  // don't diverge: j/k walk the file list, n/p walk the hunks of the open diff,
  // [/] walk the comment threads across every file,
  // x toggles reviewed. The diff itself is ChangesModal's UnifiedDiff/SplitDiff,
  // so its [data-hunk] markers and [data-vscroll] container are reused verbatim.
  const stepFile = (dir: 1 | -1) => {
    const files = shownFiles;
    if (!files.length) return;
    const i = stepFileIndex(files.length, files.findIndex((f) => f.path === sel), dir);
    onSel(files[i].path);
    /*
     * In one-file mode the column is REPLACED, so there is no position to keep:
     * holding the old scroll would drop you into the middle of a file you have
     * not seen the top of. In the stack the opposite is true — the file you
     * came from is still above you and the scroll is the thing being preserved.
     */
    const frame = frameRef.current;
    if (oneFile) { if (frame) vScrollerOf(frame)?.scrollTo({ top: 0 }); }
    else scrollToFileStable(() => frameRef.current?.querySelector('[data-file="active"]'));
  };
  const jumpHunk = (dir: 1 | -1) => {
    const frame = frameRef.current;
    if (!frame) return;
    // The page's scroller, the same one scrollUnderBar uses. It used to look for
    // `[data-vscroll]`, the per-file inner scroller — which no longer exists now
    // that files scroll with the page, so every jump was measured against the
    // wrong box.
    const sc = vScrollerOf(frame) ?? frame;
    const heads = Array.from(sc.querySelectorAll<HTMLElement>("[data-hunk]"));
    if (!heads.length) return;
    const scTop = sc.getBoundingClientRect().top;
    const cur = sc.scrollTop;
    const tops = heads.map((h) => h.getBoundingClientRect().top - scTop + cur);
    // Compare against the first line the reader can actually see, not the raw
    // scrollTop: the sticky bar covers `barH` of it, so a hunk sitting under
    // the bar counts as already passed and "next" would skip the one you are
    // looking for. The same offset comes back off the destination, which is
    // why this cannot use scroll-margin like the others do.
    const eye = cur + barH;
    const target = dir === 1 ? tops.find((t) => t > eye + 4) : [...tops].reverse().find((t) => t < eye - 4);
    sc.scrollTo({ top: Math.max(0, (target ?? (dir === 1 ? tops[tops.length - 1] : tops[0])) - barH - 2), behavior: "smooth" });
  };
  /*
   * The next comment thread, wherever it is.
   *
   * `n` and `p` are hunks here, and they were the only way to walk a review: on
   * twelve files with comments scattered through three of them, finding the next
   * thread was scrolling and looking. `]` and `[` walk the THREADS instead, across
   * files, in the order they are drawn — and an outdated or resolved one is not
   * skipped, because "somebody answered this and I have not read it" is exactly the
   * thing being looked for.
   *
   * Same geometry as jumpHunk, for the same reason: the sticky bar covers `barH` of
   * the page, so the eye is `scrollTop + barH` and the destination gives it back.
   */
  const jumpThread = (dir: 1 | -1) => {
    const frame = frameRef.current;
    if (!frame) return;
    const sc = vScrollerOf(frame) ?? frame;
    const nodes = Array.from(sc.querySelectorAll<HTMLElement>("[data-thread]"));
    if (!nodes.length) return;
    const scTop = sc.getBoundingClientRect().top;
    const cur = sc.scrollTop;
    const tops = nodes.map((n) => n.getBoundingClientRect().top - scTop + cur);
    const eye = cur + barH;
    const target = dir === 1 ? tops.find((t) => t > eye + 4) : [...tops].reverse().find((t) => t < eye - 4);
    /* Past the last one, stay on the last one rather than wrapping to the top: a
       wrap in a long review reads as the page having jumped somewhere else. */
    sc.scrollTo({ top: Math.max(0, (target ?? (dir === 1 ? tops[tops.length - 1] : tops[0])) - barH - 2), behavior: "smooth" });
  };
  const onKey = (e: React.KeyboardEvent) => {
    // Never while a field owns the keys — the PR search box, a comment textarea,
    // or a row's reviewed checkbox. Same guard App.tsx and ChangesModal use.
    const inInput = /input|textarea/i.test((e.target as HTMLElement)?.tagName ?? "");
    if (inInput) return;
    const k = e.key.toLowerCase();
    if (e.key === "]") { e.preventDefault(); e.stopPropagation(); jumpThread(1); return; }
    if (e.key === "[") { e.preventDefault(); e.stopPropagation(); jumpThread(-1); return; }
    if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); stepFile(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); stepFile(-1); }
    else if (k === "n") { e.preventDefault(); e.stopPropagation(); jumpHunk(1); }
    else if (k === "p") { e.preventDefault(); e.stopPropagation(); jumpHunk(-1); }
    else if (k === "x") { e.preventDefault(); e.stopPropagation(); if (sel) seenAndFold(sel); }
    else if (k === "enter" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (sel) toggleFold(sel); }
  };
  // Focus the frame when the files tab mounts, so the keys work without a click
  // first — the same first-frame focus the changes modal does.
  useEffect(() => { requestAnimationFrame(() => frameRef.current?.focus()); }, []);

  return (
    /*
     * This block is one of the one-screen review's two scrollers, and the
     * toolbar rides inside it on purpose. The file headers stick at `barH`, the
     * hunk jump measures its "eye" at `scrollTop + barH`, and both are only
     * true while the bar and the diff share a scroll box. Putting the scroll on
     * the diff column alone would have left the bar outside it and every one of
     * those offsets off by the height of the bar.
     *
     * `vScrollerOf` finds this rather than the page, so j/k and the file jump
     * follow it without being told.
     */
    <div ref={frameRef} tabIndex={-1} onKeyDown={onKey}
      /*
       * Written on every scroll, never on the way out.
       *
       * The first version saved in the effect's cleanup — and by the time a
       * passive cleanup runs the node is already out of the document, where
       * `scrollTop` reads 0. So it faithfully remembered zero, every time, and
       * the tab always came back at the top. Reported as "the scroll position of
       * the open file is never kept".
       */
      onScroll={(e) => { FILES_SCROLL.set(`${root}#${d.number}`, e.currentTarget.scrollTop); }}
      className="agx-col3 agx-scroll text-[11px] flex flex-col gap-2 outline-none">
      {/* One bar, and it stays put: filter, view mode, progress. Everything that
          used to be repeated on each file's own toolbar lives here once.

          A header band, not a floating slab. It used to be the app's darkest
          tone (--bg), rounded, and inset — a dark card hovering over the --bg2
          panel it sits on, which read as not belonging to the app. Now it is
          full-bleed to the panel edges, square, and the panel's OWN --bg2, so it
          reads as one continuous header with the tab row above it, parted only
          by a hairline like every other toolbar here. The box-shadow paints the
          12px the scroll container insets above it (its p-3) in the same tone,
          so nothing bleeds through while it is pinned. */}
      {/* Full-bleed by being flush, not by pulling itself out with a negative
          margin. It used to sit inside the tab body's 12px padding and reach
          past it with `-mx-3`; inside this column's own scroll box that 12px
          became overflow, and a scroll box with something sticking out of it
          draws a scrollbar — one ran the whole width of the app. The column is
          flush now, so there is nothing to pull out of. */}
      <div ref={barRef} className="flex flex-col gap-1 sticky top-0 z-30 px-3 py-2"
        style={{ background: "var(--bg2)", borderBottom: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 px-2 py-1 rounded shrink-0"
          style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
          <span style={{ color: "var(--text3)" }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files…"
            className="bg-transparent outline-none text-[10.5px] w-28" style={{ color: "var(--text)" }} />
          {q && <button onClick={() => setQ("")} title="Clear" style={{ color: "var(--text3)" }}>×</button>}
        </span>
        <FilesFilterMenu
          facets={extFacets} hiddenExts={hiddenExts}
          onToggleExt={(e) => setHiddenExts((cur) => cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e])}
          onClearExts={() => setHiddenExts([])}
          showViewed={showViewed} onToggleViewed={() => setShowViewed((v) => !v)}
          viewedCount={viewedCount}
          shownCount={shownFiles.length}
          unseenCount={shownFiles.filter((f) => !seenFiles.includes(f.path)).length}
          onSeenAll={(on) => onSeenMany(shownFiles.map((f) => f.path), on)}
        />
        {/* The filter to its left narrows the LIST by path; this searches the
            CODE. Two different questions, so they are two different controls —
            and the shortcut is on the button because nobody reads a legend. */}
        <Btn small primary={find !== null}
          title="Search the code of every file in this review (Ctrl+F)"
          onClick={() => {
            if (find !== null) { setFind(null); return; }
            setFind("");
            requestAnimationFrame(() => findRef.current?.focus());
          }}>⌕ Search code</Btn>
        {/*
          * "Since your review", where the filters are.
          *
          * Only when there is a review of yours to measure from and the branch has
          * moved since it — see sinceRange. The three states it can be in are all
          * different sentences, and the tooltip says which: n files moved, nothing
          * moved, or the commit you reviewed is not in this checkout so nothing can
          * be compared.
          */}
        {since && moved?.key === `${since.from}..${since.to}` && (movedHere.length > 0 || moved.missing) && (
          moved.missing
            /* The commit you reviewed is not in this clone — usually because it was
               force-pushed away, or because nothing has fetched since. The chip said
               so and left you to go and do it; it does it. A fetch is read-only on the
               working tree, which is why this is a button rather than a warning. */
            ? <Btn small disabled={fetching}
                title={sinceTitle({ count: 0, from: since.from, missing: true, on: false })}
                onClick={async () => {
                  setFetching(true);
                  await api.gitFetch(root).catch(() => {});
                  setFetching(false);
                  /* Ask again with the same pair: the answer is a different one now
                     that the objects are here. */
                  onRefetchSince();
                }}>
                {fetching ? "Fetching…" : "Fetch to compare"}
              </Btn>
            : <Btn small primary={sinceOnly}
                title={sinceTitle({ count: movedHere.length, from: since.from, on: sinceOnly })}
                onClick={() => setSinceOnly((v) => !v)}>
                Since your review · {movedHere.length}
              </Btn>
        )}
        {/* What git's `-w` does, done on the parsed patch because the patch arrives
            already made. On a formatting pass this is the difference between reading
            a review and reading the file twice. */}
        <Btn small primary={noWs} onClick={() => onNoWs(!noWs)}
          title={noWs
            ? `Ignoring whitespace: a line that only changed its indentation is drawn as unchanged.${wsOnly.length ? ` ${wsOnly.length} file${wsOnly.length === 1 ? "" : "s"} left the list entirely — ${wsOnly.slice(0, 6).join(", ")}${wsOnly.length > 6 ? "…" : ""}` : ""}`
            : "Ignore whitespace — fold a line that only changed its indentation back into context"}>
          ⇥ {noWs ? "Ignoring space" : "Ignore space"}
        </Btn>
        <Btn onClick={() => onSplit(false)} small primary={!split} title="One column, with a “+ Comment” target on every line">Unified</Btn>
        <Btn onClick={() => onSplit(true)} small primary={split} title="Before and after, side by side">Split</Btn>
        <Btn onClick={() => onWrap(!wrap)} small primary={wrap} title="Wrap long lines rather than scrolling them">Wrap</Btn>
        <Btn onClick={() => setFolded(allFolded ? new Set() : new Set(shownFiles.map((f) => f.path)))} small>
          {allFolded ? "Expand all" : "Collapse all"}
        </Btn>
        <span className="ml-auto flex items-center gap-2 min-w-[150px]">
          <span className="tabular-nums shrink-0 text-[10px]" style={{ color: seenFiles.length === d.files.length ? "var(--success)" : "var(--text3)" }}>
            {seenFiles.length} of {d.files.length} viewed
          </span>
          <Bar parts={[{ pct: d.files.length ? (seenFiles.length / d.files.length) * 100 : 0, tint: seenFiles.length === d.files.length ? "var(--success)" : "var(--primary)" }]} />
        </span>
      </div>
      {find !== null && (
        <FindBar
          value={find} onChange={setFind} inputRef={findRef} listRef={findListRef}
          hits={findHits} groups={findGroups} at={findAt}
          onGo={goToIndex} onClose={() => { setFind(null); frameRef.current?.focus(); }}
          fileCount={d.files.length} loaded={loaded}
        />
      )}
      <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--text3)" }}>
        {/* Named for what it does to the middle column, not for a layout — you
            are choosing how much is in front of you. */}
        <span className="inline-flex rounded overflow-hidden shrink-0" style={{ border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>
          {([[true, "One file"], [false, "All files"]] as const).map(([v, label]) => (
            <button key={label} onClick={() => setOne(v)} className="px-2 py-px"
              style={oneFile === v
                ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--text)" }
                : { color: "var(--text3)" }}>{label}</button>
          ))}
        </span>
        <span><b>j/k</b> file · <b>n/p</b> hunk · <b>[/]</b> thread · <b>x</b> viewed · <b>↵</b> fold · <b>⌃F</b> search code</span>
        {shownFiles.length !== d.files.length && <span> · showing {shownFiles.length} of {d.files.length}</span>}
      </div>
      </div>

      {/* Tree on the left, diffs on the right — the arrangement GitHub uses, and
          the only way to keep your bearings in a change that touches thirty
          files. The tree is the navigator; the stack is still the reading. */}
      {/* The row is as tall as the diff, on purpose: the tree is `sticky` inside
          it, and a sticky element only stays put while its own row is still on
          screen. Capping this row to the viewport — which is what the first fix
          for the phantom scroll did — meant the tree unpinned and scrolled away
          with the diff the moment you went past one screen. Reported that way.
          The tree is capped by measurement instead, see `--agx-tree-max`. */}
      <div className="flex gap-3 items-start">
        {/* Always present in one-file mode: it is the only way to reach the
            other eight, so hiding it below five files would strand you. */}
        {(oneFile || shownFiles.length > 4) && (
          <aside className="shrink-0 agx-tree3 sticky top-[68px] z-10 agx-scroll hidden md:block pr-1"
            style={{ borderRight: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
            {/* `showing`, not `sel`.
                
                In one-file mode the first file is on screen before anybody has
                clicked anything, and `sel` is still null — so the pane showed a
                diff while the tree beside it marked nothing, and the row you
                were reading looked no different from the eleven you were not.
                `showing` is the same expression the diff itself renders from,
                which is what makes them agree. */}
            <FileTree
              node={buildFileTree(shownFiles)} sel={showing}
              onPick={(path) => { onSel(path); setFolded((cur) => { const n = new Set(cur); n.delete(path); return n; }); scrollToFileStable(() => frameRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)); }}
              seen={(path) => seenFiles.includes(path)}
              drafts={draftsFor} pending={heldFor} onPeek={onPeek}
              moved={(path) => movedSet.has(path)}
            />
          </aside>
        )}
        <div className="min-w-0 flex-1 flex flex-col gap-2">
      {/* Said out loud, once, under the list: N files are not here because everything
          they changed was whitespace. */}
      {noWs && wsOnly.length > 0 && (
        <div className="px-3 pb-1 text-[10px]" style={{ color: "var(--text3)" }}
          title={wsOnly.join("\n")}>
          {wsOnly.length} file{wsOnly.length === 1 ? "" : "s"} changed only in whitespace and {wsOnly.length === 1 ? "is" : "are"} not shown.
        </div>
      )}
      {shownFiles.length === 0 && (
        <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>
          {q ? `No file matches “${q}”.` : "No files match the current filter."}
        </div>
      )}
      {/* A file list that quietly disagreed with the header count is how nobody
          noticed the hundred-and-first file was missing. Say it. */}
      {d.truncated?.files ? (
        <div className="text-[10px] px-1 py-1" style={{ color: "var(--warning)" }}>
          {/* Nine pages of names are fetched now, so this line means a branch of
              nine hundred files and more — a vendor drop or a generated tree,
              not a review somebody is reading top to bottom. */}
          {d.truncated.files} more file{d.truncated.files === 1 ? "" : "s"} changed than this list holds — a branch this size is only listed in full on GitHub.
        </div>
      ) : null}

      {/*
        * One file, or all of them.
        *
        * The tree stays whole either way — it is the navigator, and a navigator
        * that only lists what is already on screen is a scrollbar.
        */}
      {(oneFile ? shownFiles.filter((f) => f.path === showing) : shownFiles).map((f) => {
        const done = seenFiles.includes(f.path);
        const open = !folded.has(f.path);
        // Same reason as the tree above: what is on screen is what is marked.
        const focused = showing === f.path;
        const nd = draftsFor(f.path);
        const pendingHere = pendingBy(f.path);
        const heldHere = heldBy(f.path);
        /* One whose line the diff does not reach — outdated, or in a hunk that
           is not shown — has no row to sit under. It keeps its place under the
           file rather than disappearing, which is what a comment nobody can
           find amounts to. */
        const heldBelow = held.filter((h) => h.path === f.path && (h.line == null || !heldHere.has(h.line)));
        const heldOnFile = held.filter((h) => h.path === f.path).length;
        const change = byPath.get(f.path);
        // Anchor each thread inline, under the line it is about — GitHub's
        // placement. A thread whose line is not in the diff (outdated, or a
        // context line the hunks do not reach) has no row to sit under, so it
        // keeps its home in the list under the file rather than vanishing.
        const inlineThreads = new Map<number, PrThread[]>();
        const belowThreads: PrThread[] = [];
        for (const t of threadsFor(f.path)) {
          const anchored = t.line != null && !t.isOutdated &&
            !!change?.hunks.some((h) => t.line! >= h.newStart && t.line! <= h.newStart + h.newLines - 1);
          if (anchored) { const arr = inlineThreads.get(t.line!) ?? []; arr.push(t); inlineThreads.set(t.line!, arr); }
          else belowThreads.push(t);
        }
        return (
          <div key={f.path} data-file={focused ? "active" : undefined} data-path={f.path} className="rounded"
            style={{
              // `overflow: clip`, not `hidden`: hidden turns the card into its own
              // scroll container, which would pin the sticky header below to the
              // card instead of the page. clip keeps the rounded corners without
              // that side effect, so the header can stick against the page scroll.
              overflow: "clip",
              border: `1px solid color-mix(in srgb, ${focused ? "var(--primary) 45%" : "var(--border) 30%"}, transparent)`,
              opacity: done && !open ? 0.72 : 1,
              // Hunk headers do not stick here. Two pinned bars stacked on one
              // scroll always leave a row cut in half between them — first the
              // `@@` sat over the file's name, then over a line of code — and
              // there is no offset that removes it, only one that moves it.
              // GitHub pins the file header and lets the hunks scroll, and one
              // pinned thing per file is the shape that has no seam.
              //
              // The standalone diff viewer keeps its sticky hunks: it has no
              // file header above them, so nothing to collide with. Hence a
              // variable defaulting to `sticky` rather than a change to it.
              ["--agx-hunk-pos" as string]: "static",
            }}>
            {/* The file's own header stays put while you read its diff — the
                GitHub behaviour, so the code under the cursor always has a name
                above it. Opaque (the tint mixed into --bg, not laid over
                transparent) so the diff cannot bleed through it while pinned, and
                pinned just under the toolbar. */}
            {/* `data-file-head` so a jump can ask where this ended up rather
                than recompute it from `barH`, which lags a resize by a frame. */}
            <div data-file-head className="flex items-center gap-2 px-2.5 sticky z-20"
              style={{
                top: Math.max(0, barH - 10),
                height: FILE_HEAD_H,
                background: "color-mix(in srgb, var(--border) 12%, var(--bg))",
                borderBottom: open ? "1px solid color-mix(in srgb, var(--border) 25%, transparent)" : undefined,
              }}>
              <button onClick={() => { onSel(f.path); toggleFold(f.path); }} className="flex-1 min-w-0 text-left flex items-center gap-2">
                <span className="shrink-0" style={{ color: "var(--text3)" }}>{open ? "▾" : "▸"}</span>
                <span className="truncate" style={{ ...CODE_FONT_STYLE, color: done ? "var(--text3)" : "var(--text)" }}>{f.path}</span>
                {f.status && f.status !== "modified" && <Chip text={f.status} tint="var(--text3)" />}
                {f.comments > 0 && <Chip text={`${f.comments} open`} tint="var(--warning)" />}
                {/* Both kinds counted, and told apart. They go to the same
                    place when you submit, so a file that says "2 pending" with
                    three comments under it is a file whose header disagrees
                    with itself — but they are not the same thing, and lumping
                    them into one number would say the two you can still edit
                    are three. */}
                {nd > 0 && <Chip text={`${nd} pending`} tint="var(--primary)" title="Queued in your review, in this browser" />}
                {heldOnFile > 0 && (
                  <Chip text={`${heldOnFile} on GitHub`} tint="var(--primary)"
                    title="Drafted in GitHub's review UI and not submitted — sent when you submit from here" />
                )}
                {/* GitHub's own counts, EXCEPT while whitespace is being ignored:
                    then they come from the diff on screen, or a file with 39
                    re-indents and one real change would say +40 above a diff showing
                    one line. The tooltip keeps the original, because "how big is this
                    really" is still a question. */}
                {(() => {
                  const shown = noWs ? byPath.get(f.path) : null;
                  const add = shown ? shown.additions : f.additions;
                  const del = shown ? shown.deletions : f.deletions;
                  const t = shown && (add !== f.additions || del !== f.deletions)
                    ? `+${add} −${del} ignoring whitespace · +${f.additions} −${f.deletions} in full`
                    : undefined;
                  return (
                    <span className="ml-auto shrink-0 flex items-center gap-1.5" title={t}>
                      <span className="tabular-nums" style={{ color: "var(--success)" }}>+{add}</span>
                      <span className="tabular-nums" style={{ color: "var(--error)" }}>−{del}</span>
                    </span>
                  );
                })()}
              </button>
              {/* The diff shows what changed. Often the answer is in the part
                  that did not — the function three lines above, the import at
                  the top — and reaching it meant finding a terminal, getting it
                  into the right checkout, and typing the path, by which point
                  you have lost the list you were working from. */}
              {onPeek && <PeekButton path={f.path} onPeek={onPeek} />}
              {/* "Viewed" is state you keep for the length of a review, not a
                  one-off tick — a switch says that and a checkbox does not. */}
              <button onClick={() => seenAndFold(f.path)} title={done ? "Mark not viewed" : "Mark viewed"}
                aria-pressed={done}
                className="agx-btn shrink-0 flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded"
                style={{ color: done ? "var(--success)" : "var(--text3)", border: `1px solid color-mix(in srgb, ${done ? "var(--success) 50%" : "var(--border) 45%"}, transparent)` }}>
                <span className="agx-sw" data-on={done ? "1" : "0"} />Viewed
              </button>
            </div>
            {open && (
              needsLoadDiff(f) && !loadedDiffs.has(f.path) ? (
                /* Generated or huge — held behind a button, GitHub-style, so a
                   lockfile does not render a thousand rows on open. */
                <div className="p-4 flex flex-col items-center gap-2.5 text-center" style={{ background: "color-mix(in srgb, var(--border) 4%, transparent)" }}>
                  <div className="w-full max-w-[520px] flex flex-col items-start gap-1.5 mb-1" aria-hidden>
                    {[62, 90, 74, 44, 82].map((w, i) => <div key={i} className="rounded" style={{ height: 8, width: `${w}%`, background: "color-mix(in srgb, var(--border) 30%, transparent)" }} />)}
                  </div>
                  <Btn small primary onClick={() => setLoadedDiffs((s) => new Set(s).add(f.path))}>Load diff</Btn>
                  <span className="text-[10px]" style={{ color: "var(--text3)" }}>
                    {GENERATED_RE.test(f.path) ? "Generated file — not rendered by default." : `Large file (${f.additions + f.deletions} changed lines) — load when you need it.`}
                  </span>
                </div>
              ) : (
              <LazyMount minHeight={Math.min(320, 40 + (f.additions + f.deletions) * 18)}>
                {/* No inner scroller: a scroll box inside the page scroll is
                    how a click in the tree lands on a file you then cannot
                    scroll, and it is not what GitHub does. Long files are
                    folded by default instead, which is the honest cap. */}
                {/* No overflow here, deliberately. `overflow-x: auto` alone is
                    not one axis: the other computes to `auto` too, so this was
                    a second scroll container wrapped around the diff's own —
                    two vertical scrollbars side by side at the edge of the
                    column, one of them themed and one of them not, and the
                    inner one behaving like it was dead because the outer had
                    the wheel. Measured in Chrome: `overflow-x:auto` reports
                    `overflowY: auto`. The diff pane inside scrolls itself, and
                    the files column is the one that scrolls vertically. */}
                <div className="flex min-w-0">
                  {/* An image first, and a file with no hunks second.
                      `gh pr diff` still emits a header for a binary file — just
                      "Binary files … differ" and nothing else — so the parser
                      produces an entry with zero hunks. Testing `change` before
                      the image put every PNG down the text path and rendered an
                      empty diff pane, which is why the image viewer never
                      appeared at all. */}
                  {!loaded && diffErr ? (
                    /* Said, not spun. GitHub refuses the whole-diff endpoint
                       past 20,000 lines, and a refusal drawn as a spinner is a
                       pane somebody waits at for ever. */
                    <div className="text-[11px] p-3" style={{ color: "var(--warning)" }}>
                      {diffErr}
                    </div>
                  ) : !loaded ? <Loading label="Loading the diff…" size={18} />
                    : diffKind(f.path, change?.hunks.length ?? 0) === "image"
                      ? <ImageDiff root={root} number={d.number} path={f.path} status={f.status} />
                    : change?.hunks.length ? (
                      <DiffPane
                        file={change} split={split} wrap={wrap}
                        onPick={(pk) => pickLine(f.path, pk)}
                        sel={selRange?.path === f.path ? selRange.sel : null}
                        permalink={repoName && headSha ? (line) => `https://github.com/${repoName}/blob/${headSha}/${f.path}#L${line}` : undefined}
                        rowAfter={(inlineThreads.size || pendingHere.size || heldHere.size || composing?.path === f.path) ? (newN, oldN) => {
                          const ts = newN != null ? inlineThreads.get(newN) : null;
                          // A queued comment has to be visible where it was
                          // written. It used to exist only as a number on the
                          // file's header and a row in the Review tab, so
                          // writing one and returning to the diff showed nothing
                          // at all — the line looked exactly as it had before,
                          // and the only way to check was to leave.
                          const pend = pendingHere.get(`${newN != null ? "R" : "L"}${newN ?? oldN}`) ?? [];
                          const composeHere = composing?.path === f.path &&
                            ((composing.side === "RIGHT" && composing.line === newN) || (composing.side === "LEFT" && composing.line === oldN));
                          const heldOnLine = newN != null ? (heldHere.get(newN) ?? []) : [];
                          if (!ts?.length && !pend.length && !heldOnLine.length && !composeHere) return null;
                          const pfx = composing?.side === "LEFT" ? "L" : "R";
                          // Bounded and pinned to the left so it reads at a sane
                          // width and stays put while the code scrolls sideways.
                          return (
                            <div className="flex flex-col gap-2 my-1.5 px-2" style={{
                              // A positioning wrapper and nothing else. It used
                              // to carry a tinted background and rules of its
                              // own, so a composer sat as a box inside a
                              // slightly wider box — two frames, neither
                              // aligned to the other, which is most of why this
                              // read as older than the app around it. One
                              // visible container: the card below.
                              position: "sticky", left: 0,
                              width: split ? "min(560px, 46vw)" : "min(900px, 92vw)",
                            }}>
                              {ts?.map((t) => <Thread key={t.id} t={t} inline onResolve={onResolve} onReply={onReply} onApply={onApply} busy={busy} />)}
                              {pend.map((dc, i) => (
                                <div key={`p${i}`} className="rounded-lg overflow-hidden text-[11.5px]" style={{
                                  background: "var(--bg2)",
                                  border: "1px dashed color-mix(in srgb, var(--warning) 55%, transparent)",
                                }}>
                                  {/* Dashed and amber: this is written and not
                                      sent. A solid card would read as posted,
                                      which is the one thing it is not. */}
                                  <div className="px-2.5 py-1 flex items-center gap-2 text-[10px]"
                                    style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", color: "var(--warning)" }}>
                                    <span>Pending — sent when you submit the review</span>
                                    <button onClick={() => onDropDraft(dc)} title="Discard this pending comment"
                                      className="agx-btn ml-auto px-1.5 py-0.5 rounded text-[10px]"
                                      style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)" }}>Drop</button>
                                  </div>
                                  <div className="px-2.5 py-2"><Md body={dc.body} /></div>
                                </div>
                              ))}
                              {/* Written in GitHub's own review UI and never
                                  submitted. A third kind of mark on purpose: it
                                  is not a published thread — there is nobody to
                                  reply to and nothing to resolve — and it is not
                                  one of our drafts either, which live in this
                                  browser until they are sent. No Drop, because
                                  no API edits a comment inside somebody's
                                  pending review; offering one would either lie
                                  or delete the whole review to reach one line. */}
                              {heldOnLine.map((h, i) => (
                                <div key={`held-${h.line}-${i}`} className="rounded-lg overflow-hidden"
                                  style={{ border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}>
                                  <div className="px-2.5 py-1 text-[10px] flex items-center gap-2"
                                    style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", color: "var(--text2)" }}>
                                    <span>drafted on GitHub</span>
                                    <span className="ml-auto" style={{ color: "var(--text3)" }}>sent when you submit</span>
                                    {/* The way OUT to the only place it can be
                                        edited. No API changes a comment inside
                                        a pending review without submitting the
                                        review, so the honest affordance is the
                                        page where it can be changed rather than
                                        a button here that would have to lie. */}
                                    {h.url && (
                                      <button onClick={() => openExternal(h.url!)}
                                        title="Edit this pending comment on GitHub"
                                        className="agx-btn shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                                        style={{ color: "var(--primary)" }}>Edit ↗</button>
                                    )}
                                  </div>
                                  <div className="px-2.5 py-2"><Md body={h.body} /></div>
                                </div>
                              ))}
                              {composeHere && composing && (
                                <div className="rounded-lg overflow-hidden" style={{
                                  // The one box. Sat on the panel rather than
                                  // on a tint of its own, and lifted off the
                                  // diff by a shadow the way every other
                                  // floating surface in this app is.
                                  background: "var(--bg2)",
                                  border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)",
                                  boxShadow: "0 12px 30px -14px var(--shadow)",
                                }}>
                                  {/* The line's own actions live here, beside the
                                      box, rather than in a menu you had to get
                                      through to reach the box. Suggesting is a
                                      thing you decide with the code in front of
                                      you, not before you have seen it. */}
                                  <div className="px-3 py-2 text-[11px] flex items-center gap-2" style={{
                                    background: "color-mix(in srgb, var(--border) 22%, transparent)",
                                    borderBottom: "1px solid color-mix(in srgb, var(--text) 16%, transparent)",
                                    color: "var(--text)",
                                  }}>
                                    <span className="min-w-0 truncate">
                                      {composing.startLine ? `Comment on lines ${pfx}${composing.startLine}–${composing.line}` : `Add a comment on line ${pfx}${composing.line}`}
                                    </span>
                                    <span className="ml-auto flex items-center gap-1 shrink-0">
                                      <button onClick={() => suggestHere(f, composing)} title="Prefill a suggestion block with this line"
                                        className="agx-btn px-1.5 py-0.5 rounded text-[10px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>± Suggest</button>
                                      <button onClick={() => { if (repoName && headSha) void navigator.clipboard?.writeText(`https://github.com/${repoName}/blob/${headSha}/${f.path}#L${composing.line}`); }}
                                        disabled={!repoName || !headSha}
                                        title="Copy a link to this line on GitHub"
                                        className="agx-btn px-1.5 py-0.5 rounded text-[10px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>🔗</button>
                                    </span>
                                  </div>
                                  <div className="p-2.5 flex flex-col gap-2">
                                    {/* Two outcomes, the way GitHub has them: post
                                        this one now, or hold it for the review you
                                        are building. Before, everything queued —
                                        so a one-line "typo here" needed a whole
                                        review submitted around it. */}
                                    {/* Neither button is filled, which is what
                                        GitHub does and the reason its pair does
                                        not mislead. Ours had the fill on "Add to
                                        review" — the one that posts nothing —
                                        so the button that looked like the action
                                        was the one that quietly queued a draft.
                                        Equal weight; you read the labels. */}
                                    <Composer initial={composing.initial} autoFocus={!split} busy={busy}
                                      stash={composeStashKey(f.path, composing.side, composing.line)}
                                      placeholder="Leave a comment — markdown works here"
                                      sendLabel={draftsFor(f.path) || drafts.length ? "Add to review" : "Start a review"}
                                      sendTitle="Hold this until you submit the review — the author is notified once, at the end"
                                      quiet
                                      onSend={async (b) => { onAddDraft(f.path, composing.line, composing.startLine, composing.side, b); cancelCompose(); return true; }}
                                      secondary={{
                                        label: "Comment",
                                        title: "Post this now, on its own — the author is notified straight away",
                                        onSend: async (b) => {
                                          const ok = await onPostOne(f.path, composing.line, composing.startLine, composing.side, b);
                                          if (ok) cancelCompose();
                                          return ok;
                                        },
                                      }} />
                                    <button onClick={cancelCompose} className="agx-btn self-start px-2 py-0.5 rounded text-[10px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>Cancel</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        } : undefined}
                        expand={(hi) => {
                          // The gap between the end of the previous hunk and the
                          // start of this one — the lines GitHub did not send.
                          const h = change.hunks[hi];
                          if (!h) return null;
                          const prev = hi > 0 ? change.hunks[hi - 1] : null;
                          const prevEnd = prev ? prev.newStart + prev.newLines - 1 : 0;
                          const from = Math.max(prevEnd + 1, h.newStart - 20);
                          const to = h.newStart - 1;
                          if (to < from) return null;
                          return <ExpandContext root={root} number={d.number} path={f.path} from={from} to={to} />;
                        }}
                      />
                    )
                    /* Two different nothings, and saying the wrong one is how a
                       stale diff looked like a broken file. `change` present
                       with no hunks is GitHub sending a header and no text:
                       binary, a pure rename. `change` ABSENT means this file is
                       not in the diff we hold at all — which, since the file
                       list comes from the detail and the diff does not, means
                       the detail is newer than the text beside it. */
                    : change ? <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>No textual diff — binary, renamed, or too large to show</div>
                    : <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>This file is not in the diff on screen — it arrived with a newer push. Press Refresh.</div>}
                </div>
              </LazyMount>
              )
            )}
            {/* The conversation about THIS file, under it. The count in the
                header said threads existed but you had to leave for the
                conversation tab to read them, which is the wrong way round
                while you are looking at the code they are about. */}
            {open && heldBelow.length > 0 && (
              <div className="px-3 pb-2 flex flex-col gap-2">
                {heldBelow.map((h, i) => (
                  <div key={`heldb-${i}`} className="rounded-lg overflow-hidden"
                    style={{ border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}>
                    <div className="px-2.5 py-1 text-[10px] flex items-center gap-2"
                      style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", color: "var(--text2)" }}>
                      <span>drafted on GitHub{h.line == null ? " · outdated" : `:${h.line}`}</span>
                      <span className="ml-auto" style={{ color: "var(--text3)" }}>the diff does not reach its line</span>
                      {/* And here more than anywhere: this one has no row to sit
                          under, so the page where it lives is the only place it
                          can be seen in context. */}
                      {h.url && (
                        <button onClick={() => openExternal(h.url!)}
                          title="Edit this pending comment on GitHub"
                          className="agx-btn shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                          style={{ color: "var(--primary)" }}>Edit ↗</button>
                      )}
                    </div>
                    <div className="px-2.5 py-2"><Md body={h.body} /></div>
                  </div>
                ))}
              </div>
            )}
            {open && belowThreads.length > 0 && (
              <div className="px-2.5 py-2 flex flex-col gap-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 6%, transparent)" }}>
                {/* Not anchored to a visible line — outdated threads, or ones on
                    context the diff does not reach — so they live under the file
                    rather than inline. */}
                <div className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>Other comments</div>
                {belowThreads.map((t) => (
                  <Thread key={t.id} t={t} onResolve={onResolve} onReply={onReply} onApply={onApply} busy={busy} />
                ))}
              </div>
            )}
          </div>
        );
      })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// conversation
// ---------------------------------------------------------------------------

/** Out to GitHub, for the one thing the panel does not show — the full history
 *  of an edit, a reaction, the blame behind a line. */
/** GitHub's mark, so a link to GitHub says where it goes before you hover it. */
function GhMark({ size = ICON.sm }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * The two things you ever want to do with somebody else's comment: go to it,
 * and hand somebody its address.
 *
 * The arrow alone said "this leaves" and not where to — worth saying, because
 * the same row can send you to ClickUp. The mark says it without a hover.
 *
 * Sized off ICON rather than off the 10px type beside it. An icon-only control
 * inheriting the scale of the line it sits on ends up a target nobody can hit;
 * both of these keep a 20px box whatever the row does.
 */
function GhLink({ href, title }: { href: string; title: string }) {
  // Nothing rather than a link we cannot vouch for: every one of these comes
  // out of an API response, and a link that does not navigate somewhere plain
  // is not one we should be offering.
  const safe = externalUrl(href);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(id);
  }, [copied]);
  if (!safe) return null;
  const box = "shrink-0 inline-grid place-items-center rounded";
  const style = { width: 20, height: 20, color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" };
  /* Two glyphs need more than the square the single-glyph button uses: at 20
     wide the mark and the arrow touched the border and each other. Same height,
     so the pair still reads as one row of controls. */
  const wide = { ...style, width: 32 };
  return (
    <span className="shrink-0 inline-flex items-center gap-1">
      <a href={safe} target="_blank" rel="noreferrer noopener" title={title} className={box} style={wide}>
        <span className="inline-flex items-center" style={{ gap: 2 }}>
          <GhMark size={ICON.xs} />
          {/* Raised like a superscript rather than sat on the baseline, where it
              read as a second glyph of equal weight instead of a modifier. */}
          <span aria-hidden style={{ fontSize: 8, lineHeight: 1, opacity: 0.75, transform: "translateY(-3px)" }}>↗</span>
        </span>
      </a>
      <button type="button" className={box} style={{ ...style, color: copied ? "var(--success)" : style.color }}
        title={copied ? "Link copied" : "Copy a link to this comment"}
        onClick={(e) => {
          e.stopPropagation();
          /* The address, not the text: what you paste into a chat so somebody
             lands on this exact remark. */
          navigator.clipboard?.writeText(safe).then(() => setCopied(true)).catch(() => { /* no clipboard permission */ });
        }}>
        {copied ? (
          <svg viewBox="0 0 16 16" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><path d="M3 8.5l3.2 3.2L13 5" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
            <path d="M6.5 9.5a2.6 2.6 0 0 0 3.9.3l2-2a2.6 2.6 0 0 0-3.7-3.7l-1 1" />
            <path d="M9.5 6.5a2.6 2.6 0 0 0-3.9-.3l-2 2a2.6 2.6 0 0 0 3.7 3.7l1-1" />
          </svg>
        )}
      </button>
    </span>
  );
}

function Lane({ label, extra }: { label: string; extra?: string }) {
  return (
    <div className="flex items-center gap-2 mt-4 mb-2 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>
      <span>{label}</span>{extra && <span>{extra}</span>}
      <span className="flex-1 h-px" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }} />
    </div>
  );
}

/** The eight GitHub allows, with the glyph each one renders as. */
const REACTION_EMOJI: { content: string; glyph: string; title: string }[] = [
  { content: "THUMBS_UP", glyph: "👍", title: "Like" },
  { content: "THUMBS_DOWN", glyph: "👎", title: "Dislike" },
  { content: "LAUGH", glyph: "😄", title: "Laugh" },
  { content: "HOORAY", glyph: "🎉", title: "Hooray" },
  { content: "CONFUSED", glyph: "😕", title: "Confused" },
  { content: "HEART", glyph: "❤️", title: "Heart" },
  { content: "ROCKET", glyph: "🚀", title: "Rocket" },
  { content: "EYES", glyph: "👀", title: "Eyes" },
];

/**
 * Emoji on a comment, as GitHub has them: the ones already pressed are shown
 * with their tally, and a `+` opens the rest. Acknowledging with a reaction is
 * how a thread stays short — the alternative is another comment saying "agreed".
 */
function Reactions({ nodeId, reactions, onReact }: {
  nodeId?: string; reactions?: PrReaction[]; onReact?: (nodeId: string, content: string, on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // Eight emoji at ~26px plus the padding; enough to keep the row on screen
  // when the button sits near the right edge.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: Math.max(6, Math.min(r.left, window.innerWidth - 240)) });
  }, [open]);
  const has = reactions ?? [];
  if (!onReact || !nodeId) {
    if (!has.length) return null;
    return (
      <div className="flex gap-1 flex-wrap mt-2">
        {has.map((r) => <span key={r.content} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text2)" }}>{REACTION_EMOJI.find((e) => e.content === r.content)?.glyph ?? "•"} {r.count}</span>)}
      </div>
    );
  }
  return (
    <div className="flex gap-1 flex-wrap items-center mt-2">
      {has.map((r) => {
        const e = REACTION_EMOJI.find((x) => x.content === r.content);
        return (
          <button key={r.content} onClick={() => onReact(nodeId, r.content, !r.viewerHasReacted)}
            title={r.viewerHasReacted ? "Remove your reaction" : e?.title}
            className="agx-btn text-[10px] px-1.5 py-0.5 rounded-full tabular-nums"
            style={{
              border: `1px solid ${r.viewerHasReacted ? "var(--primary)" : "color-mix(in srgb, var(--border) 45%, transparent)"}`,
              background: r.viewerHasReacted ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
              color: r.viewerHasReacted ? "var(--primary-hover)" : "var(--text2)",
            }}>
            {e?.glyph ?? "•"} {r.count}
          </button>
        );
      })}
      <button ref={btnRef} onClick={() => setOpen((v) => !v)} title="Add a reaction" aria-label="Add a reaction"
        aria-haspopup="menu" aria-expanded={open}
        className="agx-btn text-[10px] px-1.5 py-0.5 rounded-full"
        style={{ border: "1px dashed color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text3)" }}>☺ +</button>
      {/* Through a portal, like every other menu here. Absolutely positioned it
          was a child of the comment card, and the card clips its own rounded
          corners — so the picker opened *inside* the comment and came out as a
          sliver. Fixed coordinates off the button keep it beside the button
          while belonging to nobody's overflow. */}
      {open && (
        <Portal>
          <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => setOpen(false)} />
          <div role="menu" className="fixed flex gap-0.5 p-1 rounded-lg"
            style={{
              top: pos.top, left: pos.left, zIndex: 9999,
              background: "color-mix(in srgb, var(--bg2) 97%, black)",
              border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)",
              boxShadow: "0 24px 60px -18px rgba(0,0,0,.7)",
              backdropFilter: "blur(18px)",
            }}>
            {REACTION_EMOJI.map((e) => {
              const mine = has.find((r) => r.content === e.content)?.viewerHasReacted ?? false;
              return (
                <button key={e.content} title={e.title}
                  onClick={() => { onReact(nodeId, e.content, !mine); setOpen(false); }}
                  className="agx-btn text-[13px] px-1 rounded hover:bg-white/10">{e.glyph}</button>
              );
            })}
          </div>
        </Portal>
      )}
    </div>
  );
}

/** OWNER / MEMBER / CONTRIBUTOR — how much weight a remark carries, at a glance. */
function AssocChip({ a }: { a?: PrAuthorAssociation }) {
  if (!a || a === "NONE" || a === "MANNEQUIN") return null;
  const label = a === "FIRST_TIME_CONTRIBUTOR" || a === "FIRST_TIMER" ? "first-time" : a.toLowerCase();
  const tint = a === "OWNER" || a === "MEMBER" ? "var(--primary)" : "var(--text3)";
  return <Chip text={label} tint={tint} title={`GitHub says this author is ${label}`} />;
}

function Card({ who, chip, when, tone, url, edited, assoc, nodeId, reactions, onReact, fresh, body, mine, minimized, onQuote, onEdit, onHide, editor, children }: {
  who: string; chip?: React.ReactNode; when?: string; tone?: "chg" | "appr" | "bot"; url?: string;
  edited?: string | null; assoc?: PrAuthorAssociation;
  nodeId?: string; reactions?: PrReaction[]; onReact?: (nodeId: string, content: string, on: boolean) => void;
  /**
   * The markdown somebody actually wrote.
   *
   * Two of the menu items below are about the SOURCE rather than the rendering —
   * "Copy Markdown" and "Quote reply" — and taking it off the page would give back
   * the rendered text with the backticks and the `>` gone, which is the one thing
   * neither of them may do.
   */
  body?: string;
  /** Yours, so Edit is offered only where it would work. */
  mine?: boolean;
  /** Already folded away on GitHub. */
  minimized?: boolean;
  /** Seed the composer with this remark quoted. */
  onQuote?: (body: string) => void;
  /** Start editing it here. The editor itself arrives as `editor`. */
  onEdit?: () => void;
  /** Fold it away, or put it back — see hideComment. */
  onHide?: (on: boolean) => void;
  /** An editor for this remark, rendered INSTEAD of it while one is open. */
  editor?: React.ReactNode;
  /** Said since this browser last looked at the pull request. Wins over the
   *  verdict tint: a two-day-old "requested changes" being green or red is
   *  history, and "this arrived while you were away" is news. */
  fresh?: boolean;
  children: React.ReactNode;
}) {
  const edge = fresh ? "var(--warning)"
    : tone === "chg" ? "var(--error)" : tone === "appr" ? "var(--success)" : tone === "bot" ? "var(--info)" : "var(--border)";
  return (
    /* `data-node` is the address the rail jumps to. The timeline's own entry
       key is positional inside a FILTERED lane, so it changes when the Humans
       / Bots segment changes and cannot be used to find a row. A node id is the
       same string the rail already holds. */
    <div data-node={nodeId || undefined} className="rounded-md overflow-hidden mb-2"
      style={{ border: `1px solid color-mix(in srgb, ${edge} ${tone ? 40 : 28}%, transparent)` }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
        style={{ background: `color-mix(in srgb, ${edge} ${tone ? 10 : 14}%, transparent)`, borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        <Avatar login={who} size={17} />
        <b style={{ color: "var(--text)", fontWeight: 500 }}>{who}</b>
        <AssocChip a={assoc} />
        {chip}
        {fresh && (
          <span className="text-[9px] px-1.5 rounded-full"
            style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 16%, transparent)" }}>new</span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {when && <span className="text-[10px]" style={{ color: "var(--text3)" }}>{when}</span>}
          {/* GitHub says "edited" here, and it matters: the words you are
              reading may not be the words that were replied to. */}
          {edited && <span className="text-[10px]" title={`Edited ${ago(edited)}`} style={{ color: "var(--text3)" }}>· edited</span>}
          {url && <GhLink href={url} title="Open on GitHub" />}
          {/*
            * The same menu github.com hangs off a comment, and for the same reason:
            * everything in it is a thing you want while READING one — the link to
            * paste in a message, the source to quote, the fold for a remark that has
            * been answered — and every one of them used to mean opening the browser.
            *
            * Only what can really be done from here is offered: Edit appears on your
            * own, and nothing pretends to a permission it has not got — GitHub
            * refuses what it refuses and the refusal is shown as it comes.
            */}
          {(url || body || onHide) && (
            <Menu label="⋯" title="More actions">
              {(close) => (
                <>
                  {url && (
                    <MenuItem onClick={() => { close(); void navigator.clipboard?.writeText(url).catch(() => {}); }}>
                      &#9033; Copy link
                    </MenuItem>
                  )}
                  {body && (
                    <MenuItem onClick={() => { close(); void navigator.clipboard?.writeText(body).catch(() => {}); }}>
                      &#9033; Copy Markdown
                    </MenuItem>
                  )}
                  {body && onQuote && (
                    <MenuItem onClick={() => { close(); onQuote(body); }}>&#8221; Quote reply</MenuItem>
                  )}
                  {mine && onEdit && <><MenuSep /><MenuItem onClick={() => { close(); onEdit(); }}>&#9998; Edit</MenuItem></>}
                  {onHide && (
                    <MenuItem onClick={() => { close(); onHide(!minimized); }}>
                      {minimized ? "◈ Unhide" : "◇ Hide"}
                    </MenuItem>
                  )}
                </>
              )}
            </Menu>
          )}
        </span>
      </div>
      <div className="px-3 py-2.5">
        {/* An open editor takes the place of the remark rather than sitting under it:
            two copies of the same paragraph, one of them editable, is a reader
            wondering which one is real. */}
        {editor ?? children}
        {!editor && <Reactions nodeId={nodeId} reactions={reactions} onReact={onReact} />}
      </div>
    </div>
  );
}

/**
 * The code a thread is about.
 *
 * Straight from the hunk GitHub stored with the comment. Reconstructing it from
 * the pull request's diff meant the snippet only appeared on tabs that had
 * already fetched that diff — so in the conversation, where the thread actually
 * reads, there was never any code at all. It also survives an outdated thread,
 * whose lines no longer exist in the current diff.
 *
 * Trimmed to the last few lines: a stored hunk runs thirty-odd lines and the
 * comment is about the end of it.
 */
function ThreadSnippet({ hunk, line }: { hunk?: string; line?: number | null }) {
  const rows = useMemo(() => {
    const all = (hunk || "").split(/\r?\n/).filter((l, i) => i > 0 || !l.startsWith("@@"));
    const tail = all.slice(-5);
    // Number the tail against the line the comment landed on, counting back
    // over everything that occupies a line on the new side.
    let n = typeof line === "number" ? line : NaN;
    const nums: (number | null)[] = [];
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i]!.startsWith("-")) { nums[i] = null; continue; }
      nums[i] = Number.isNaN(n) ? null : n--;
    }
    return tail.map((text, i) => ({ text, no: nums[i] ?? null }));
  }, [hunk, line]);

  if (!hunk?.trim()) return null;
  return (
    <div className="text-[10.5px]" style={{ ...CODE_FONT_STYLE, borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
      {rows.map((r, i) => (
        <div key={i} className="flex" style={{
          background: r.text.startsWith("+") ? "color-mix(in srgb, var(--success) 10%, transparent)"
            : r.text.startsWith("-") ? "color-mix(in srgb, var(--error) 10%, transparent)" : undefined,
        }}>
          <span className="shrink-0 text-right select-none tabular-nums px-2"
            style={{ width: 46, color: "var(--text3)", opacity: .7 }}>{r.no ?? ""}</span>
          <span className="min-w-0 flex-1 whitespace-pre overflow-x-auto pr-2 agx-scroll" style={{
            color: r.text.startsWith("+") ? "var(--success)" : r.text.startsWith("-") ? "var(--error)" : "var(--text2)",
          }}>{r.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function Thread({ t, onResolve, onReply, onApply, busy, inline, newSet, cameFrom }: {
  t: PrThread; onResolve: (t: PrThread) => void; onReply: (t: PrThread, body: string) => Promise<boolean>;
  onApply?: (t: PrThread, text: string) => void; busy: boolean;
  /** The comments said since this browser last looked, by `${threadId}:${id}`.
   *  Absent where the question does not arise — a thread drawn under a line in
   *  the diff is somewhere you went deliberately, not somewhere you are being
   *  told to look. */
  newSet?: Set<string>;
  /** The review this thread was submitted with, when it has been pulled out to
   *  the top of the timeline for having moved on since. Without this the
   *  promotion loses the one thing the nesting was for. */
  cameFrom?: string;
  /** Rendered anchored under its line in the diff, not in the file's thread
   *  list: drop the path (obvious from where it sits) and the duplicated code
   *  snippet (the line is right above it). */
  inline?: boolean;
}) {
  // The REST reply endpoint takes the numeric comment id. `id` is a GraphQL
  // node id (`PRRC_kwDO…`) and `Number()` of that is NaN — which is why reply
  // could never have worked before `databaseId` was asked for.
  const canReply = typeof t.comments[0]?.databaseId === "number";
  const [replying, setReplying] = useState(false);
  /*
   * A settled thread arrives folded, which is what GitHub does and what this
   * did not: a pull request that has been worked on carries more resolved
   * argument than live argument, and drawing all of it at full height means the
   * harder somebody worked, the worse the conversation reads. Folded, what is
   * left on screen is the open question.
   *
   * Keyed on the flag rather than set once, so pressing Resolve folds it there
   * and then — the same motion as on GitHub, and the reason you pressed it.
   * Opening it again is one click and the state is local, so it stays open
   * while you read it and folds again on the next load.
   */
  /* A resolved thread with an unread reply in it opens anyway: "resolved" is a
     statement about the code, and somebody answering after it is exactly the
     case where folding hides the thing you came for. */
  const hot = useMemo(
    () => new Set(t.comments.map((c, i) => (newSet?.has(`${t.id}:${c.id}`) ? i : -1)).filter((i) => i >= 0)),
    [t.comments, t.id, newSet],
  );
  const [open, setOpen] = useState(!t.isResolved || hot.size > 0);
  useEffect(() => { setOpen(!t.isResolved || hot.size > 0); }, [t.isResolved, hot.size]);

  /*
   * The middle of a long thread, folded.
   *
   * A thread is read from its ends — what was raised, and what was last said.
   * On the one this was written for, three long comments sat between the reader
   * and the reply they were looking for, and none of the three was the point.
   * The ends stay, anything new stays wherever it sits, and the rest becomes
   * one line you can open.
   */
  const [unfolded, setUnfolded] = useState(false);
  const hidden = useMemo(
    () => (unfolded ? new Set<number>() : foldedIdx(t.comments.length, hot)),
    [unfolded, t.comments.length, hot],
  );
  const last = t.comments[t.comments.length - 1];
  // A suggestion inside this thread knows the file and the lines because the
  // thread does. An outdated thread is refused: its lines have moved, so the
  // range in hand no longer points where the comment meant.
  const suggest = useMemo(
    () => (onApply && !t.isOutdated && t.line ? { apply: (text: string) => onApply(t, text), busy } : null),
    [onApply, t, busy],
  );
  // `data-thread` below is what [ and ] walk in the Files tab. An id would have to be
  // unique across a page that draws the same thread twice (inline in the diff and
  // again under "Other comments"); a marker attribute is enough for "the next one
  // down the page", which is the only question asked of it.
  return (
    <SuggestCtx.Provider value={suggest}>
    <div data-thread={t.id} data-resolved={t.isResolved ? "1" : undefined}
      className={`rounded-md overflow-hidden ${inline ? "" : "mb-2"}`} style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px]"
        style={{ background: "color-mix(in srgb, var(--border) 14%, transparent)",
          borderBottom: open ? "1px solid color-mix(in srgb, var(--text) 11%, transparent)" : undefined }}>
        {t.isResolved && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
            title={open ? "Hide this resolved thread" : "Show this resolved thread"}
            className="agx-btn shrink-0 grid place-items-center rounded"
            style={{ width: 20, height: 20, fontSize: 14, color: "var(--text3)" }}>
            {open ? "▾" : "▸"}
          </button>
        )}
        <span className="truncate" style={{ color: "var(--primary)" }}>
          {inline
            ? (t.startLine && t.line && t.startLine !== t.line ? `Lines ${t.startLine}–${t.line}` : t.line ? `Line ${t.line}` : "Comment")
            : `${t.path}${t.line ? `:${t.line}` : ""}`}
        </span>
        {t.isOutdated && <Chip text="outdated" tint="var(--text3)" title="The code under this comment has changed since" />}
        {/* Where it came from, now that it no longer sits under it. */}
        {cameFrom && (
          <Chip text={`from ${cameFrom}'s review`} tint="var(--text3)"
            title="Submitted with that review, and answered since — so it is shown at the time of its last reply rather than the review's" />
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* How much conversation, and when it last moved. A thread carries two
              dates and only one of them was ever on screen: "opened two days
              ago" says nothing about the argument that happened this morning. */}
          {t.comments.length > 1 && (
            <span className="text-[10px] tabular-nums" style={{ color: "var(--text3)" }}
              title={`Last reply ${ago(last?.createdAt ?? "")}`}>
              {t.comments.length} replies · {ago(last?.createdAt ?? "")}
            </span>
          )}
          {hot.size > 0 && (
            <span className="text-[9.5px] px-1.5 rounded-full tabular-nums"
              style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 16%, transparent)",
                border: "1px solid color-mix(in srgb, var(--warning) 42%, transparent)" }}>
              {hot.size} new
            </span>
          )}
          {t.isResolved ? <Chip text="resolved" tint="var(--success)" /> : <Chip text="open" tint="var(--warning)" />}
          {/* The count is the whole point of a folded row: it says how much is
              under it, so you can tell a one-line "done" from an argument. */}
          {t.isResolved && !open && (
            <button onClick={() => setOpen(true)} className="agx-btn text-[10px] px-1 rounded"
              style={{ color: "var(--text3)" }}>
              Show resolved · {t.comments.length}
            </button>
          )}
          {t.url && <GhLink href={t.url} title="Open this thread on GitHub" />}
        </span>
      </div>
      {open && <>
      {!inline && <ThreadSnippet hunk={t.diffHunk} line={t.originalLine ?? t.line} />}
      {t.comments.map((c, i) => hidden.has(i) ? (
        /* One line where the folded run is, drawn once — at the first of them,
           so the button sits where the missing comments were rather than at the
           end of the thread. */
        i > 0 && !hidden.has(i - 1) ? (
          <button key={c.id} onClick={() => setUnfolded(true)}
            className="agx-btn w-full text-left px-3 py-1.5 text-[10.5px]"
            style={{ color: "var(--text3)", borderTop: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
              background: "color-mix(in srgb, var(--border) 9%, transparent)" }}>
            ▸ {hidden.size} earlier {hidden.size === 1 ? "reply" : "replies"}
          </button>
        ) : null
      ) : (
        <div key={c.id} id={anchorId(`${t.id}:${c.id}`)} className="px-3 py-3 relative"
          style={{
            paddingLeft: i ? 30 : 12,
            /* A reply hangs off what it answers, and now it looks like it. The
               replies were indented by four pixels more than the remark above
               and tinted, which on a long thread reads as "another paragraph"
               rather than as an answer — and with several of them nothing said
               which one was answering which. A hairline between blocks gives
               each its own space; the rail down the left of the indent is the
               line back to the remark they all hang from. */
            borderTop: i ? "1px solid color-mix(in srgb, var(--text) 10%, transparent)" : undefined,
            background: i ? "color-mix(in srgb, var(--border) 9%, transparent)" : undefined,
            /* Last, so it wins over the reply tint above rather than being
               quietly overwritten by it — the whole point is that this one
               block does not look like the others. */
            ...(newSet?.has(`${t.id}:${c.id}`)
              ? { background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                  boxShadow: "inset 2px 0 0 0 var(--warning)" }
              : null),
          }}>
          {i > 0 && (
            <span aria-hidden className="absolute"
              style={{ left: 15, top: 0, bottom: 0, width: 2, borderRadius: 1,
                background: "color-mix(in srgb, var(--primary) 32%, transparent)" }} />
          )}
          <div className="flex items-center gap-1.5 mb-1.5 text-[10px]">
            <Avatar login={c.author} size={15} />
            <b style={{ color: "var(--text)", fontWeight: 500 }}>{c.author}</b>
            {newSet?.has(`${t.id}:${c.id}`) && (
              <span className="text-[9px] px-1.5 rounded-full"
                style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 16%, transparent)" }}>
                new
              </span>
            )}
            {c.isBot && <Chip text="automation" tint="var(--info)" />}
            <span className="ml-auto flex items-center gap-1.5" style={{ color: "var(--text3)" }}>
              {ago(c.createdAt)}
              {c.url && <GhLink href={c.url} title="Open this comment on GitHub" />}
            </span>
          </div>
          <Md body={c.body} />
        </div>
      ))}
      <div className="flex flex-col gap-2 px-3 py-2.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        {/* Reply with the full markdown composer — Write/Preview, mentions, the
            lot — the same box GitHub gives you, not a one-line prompt. Collapsed
            to a slim affordance until you mean it. */}
        {canReply && (replying ? (
          <Composer
            onSend={async (b) => { const ok = await onReply(t, b); if (ok) setReplying(false); return ok; }}
            busy={busy} placeholder="Reply — markdown works here" sendLabel="Reply" autoFocus
            stash={`reply|${t.id}`}
          />
        ) : (
          <button onClick={() => setReplying(true)}
            className="agx-btn w-full text-left px-3 py-1.5 rounded-lg text-[11px]"
            style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", background: "color-mix(in srgb, var(--border) 8%, transparent)" }}>
            Reply…
          </button>
        ))}
        <div className="flex gap-1.5">
          {replying && <Btn onClick={() => setReplying(false)} small>Cancel</Btn>}
          <Btn onClick={() => onResolve(t)} disabled={busy} ok={!t.isResolved} small>{t.isResolved ? "Unresolve" : "Resolve conversation"}</Btn>
        </div>
      </div>
      </>}
    </div>
    </SuggestCtx.Provider>
  );
}

/**
 * The conversation, as one timeline.
 *
 * It used to be four lanes — humans, line threads, automation, raw — each a
 * separate pile under its own rule. That splits a verdict from its reasons and
 * makes "what happened here, in what order" unanswerable: you read a pile of
 * replies, then scrolled back up to find what they were replying to.
 *
 * Now everything that happened is one list in the order it happened, on a rail,
 * with a node per entry saying what kind of thing it was. A review still owns
 * the threads submitted with it, because that grouping IS the meaning: a
 * "requested changes" is a verdict and the threads under it are the reasons.
 */
/** "X and claude committed", or "X, Y and 2 others" — how GitHub credits a
 *  commit that carries Co-authored-by trailers. */
function commitAuthorLine(c: PrCommit): string {
  const who = c.authors?.length ? c.authors : (c.author ? [c.author] : []);
  if (who.length === 0) return "unknown";
  if (who.length === 1) return `${who[0]} committed`;
  if (who.length === 2) return `${who[0]} and ${who[1]} committed`;
  return `${who[0]}, ${who[1]} and ${who.length - 2} other${who.length - 2 === 1 ? "" : "s"} committed`;
}

/** Commits under the day they landed, newest day last (the branch's own order). */
/* One formatter for the whole app. `toLocaleDateString` builds an `Intl`
   formatter on every call, and this runs once per commit: measured at 2.98ms
   for 150 commits and 7.6ms for 400, on every render of the Commits tab —
   which meant every 20s poll and every keystroke in the filter box. */
const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function groupCommitsByDay(commits: PrCommit[]): [string, PrCommit[]][] {
  const out: [string, PrCommit[]][] = [];
  for (const c of commits) {
    const day = c.committedAt ? DAY_FMT.format(new Date(c.committedAt)) : "Undated";
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(c);
    else out.push([day, [c]]);
  }
  return out;
}

const EVENT_GLYPH: Record<string, string> = {
  "force-push": "↻", renamed: "✎", labeled: "🏷", unlabeled: "🏷",
  assigned: "👤", unassigned: "👤", "review-requested": "👁", "review-request-removed": "👁",
  "ready-for-review": "◉", "convert-to-draft": "◌", merged: "⏣", closed: "✕", reopened: "↺",
  "cross-referenced": "🔗", milestoned: "◈", demilestoned: "◈", "head-ref-deleted": "⌫",
  "auto-merge-enabled": "⏱", "auto-merge-disabled": "⏱",
};
const EVENT_TINT: Record<string, string> = {
  "force-push": "var(--warning)", merged: "var(--primary)", closed: "var(--error)",
  reopened: "var(--success)", "ready-for-review": "var(--success)",
};

/** One non-comment event, written the way GitHub words it. */
function TimelineEvent({ e }: { e: PrEvent }) {
  const who = <b style={{ color: "var(--text)" }}>{e.actor || "somebody"}</b>;
  const mono = (t: string) => <code style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}>{t}</code>;
  const said = (() => {
    switch (e.kind) {
      case "force-push": return <>{who} force-pushed {e.detail ? mono(e.detail) : null}</>;
      case "renamed": return <>{who} changed the title to “{e.detail}”</>;
      case "labeled": return <>{who} added the <Chip text={e.detail || ""} tint={e.tint ? `#${e.tint}` : "var(--primary)"} /> label</>;
      case "unlabeled": return <>{who} removed the <Chip text={e.detail || ""} tint="var(--text3)" /> label</>;
      case "assigned": return <>{who} assigned <b style={{ color: "var(--text2)" }}>{e.detail}</b></>;
      case "unassigned": return <>{who} unassigned <b style={{ color: "var(--text2)" }}>{e.detail}</b></>;
      case "review-requested": return <>{who} requested a review from <b style={{ color: "var(--text2)" }}>{e.detail}</b></>;
      case "review-request-removed": return <>{who} withdrew the review request for {e.detail}</>;
      case "ready-for-review": return <>{who} marked this ready for review</>;
      case "convert-to-draft": return <>{who} converted this to a draft</>;
      case "merged": return <>{who} merged this into {mono(e.detail || "")}</>;
      case "closed": return <>{who} closed this</>;
      case "reopened": return <>{who} reopened this</>;
      case "cross-referenced": return <>{who} mentioned this in {e.detail}</>;
      case "milestoned": return <>{who} added this to the {e.detail} milestone</>;
      case "demilestoned": return <>{who} removed this from the {e.detail} milestone</>;
      case "head-ref-deleted": return <>{who} deleted the {mono(e.detail || "")} branch</>;
      case "auto-merge-enabled": return <>{who} armed auto-merge</>;
      case "auto-merge-disabled": return <>{who} cancelled auto-merge{e.detail ? ` (${e.detail})` : ""}</>;
      default: return <>{who} did something</>;
    }
  })();
  const inner = <span>{said} <span style={{ color: "var(--text3)" }}>· {ago(e.at)}</span></span>;
  return (
    <div className="agx-tiny">
      {e.url ? <a href={externalUrl(e.url)} target="_blank" rel="noreferrer noopener" style={{ color: "inherit" }}>{inner}</a> : inner}
    </div>
  );
}

/**
 * A minimap of what is new, down the side of the timeline.
 *
 * The bar above says how many; this says WHERE, against the length of the page
 * they are hiding in — which is the thing a reader is actually estimating while
 * they scroll ("is it worth carrying on, or has it gone past?"). Every entry
 * gets a faint tick and the new ones an amber one, because a rail carrying only
 * the amber marks says where they are without saying how much is between them.
 *
 * Sticky against the scroller so it stays in view like a scrollbar, with a band
 * showing the part of the conversation currently on screen. Measured from the
 * DOM rather than computed: the entries are markdown of unknown height, and
 * anything else would be a guess that drifts the longer the page gets.
 */
function NewRail({ container, atoms, onGo, depKey }: {
  container: React.RefObject<HTMLDivElement | null>;
  atoms: NewAtom[];
  onGo: (i: number) => void;
  /** Changes whenever the timeline is redrawn — the marks are positions, and a
   *  position measured before a filter changed is a lie. */
  depKey: string;
}) {
  const [marks, setMarks] = useState<{ key: string; pct: number; i: number }[]>([]);
  const [rows, setRows] = useState<number[]>([]);
  const [view, setView] = useState<{ top: number; height: number } | null>(null);
  const [tall, setTall] = useState(0);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const scroller = vScrollerOf(el);
    const measure = () => {
      const box = el.getBoundingClientRect();
      const h = box.height || 1;
      const pctOf = (n: Element) => Math.max(0, Math.min(100, ((n.getBoundingClientRect().top - box.top) / h) * 100));
      setMarks(atoms.flatMap((a, i) => {
        const n = document.getElementById(anchorId(a.key));
        return n ? [{ key: a.key, pct: pctOf(n), i }] : [];
      }));
      setRows([...el.querySelectorAll(".agx-ev")].map(pctOf));
      if (scroller) {
        setTall(scroller.clientHeight);
        const sBox = scroller.getBoundingClientRect();
        setView({
          top: Math.max(0, Math.min(100, ((sBox.top - box.top) / h) * 100)),
          height: Math.max(2, Math.min(100, (scroller.clientHeight / h) * 100)),
        });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    scroller?.addEventListener("scroll", measure, { passive: true });
    return () => { ro.disconnect(); scroller?.removeEventListener("scroll", measure); };
  }, [container, atoms, depKey]);

  if (!marks.length) return null;
  return (
    <div className="shrink-0 self-start sticky" aria-hidden
      style={{ top: 0, width: 9, height: tall || 240, position: "sticky" }}>
      <div className="relative w-full h-full rounded"
        style={{ background: "color-mix(in srgb, var(--text) 5%, transparent)" }}>
        {view && (
          <span className="absolute left-0 right-0 rounded"
            style={{ top: `${view.top}%`, height: `${view.height}%`, background: "color-mix(in srgb, var(--text) 7%, transparent)" }} />
        )}
        {rows.map((pct, i) => (
          <span key={`r${i}`} className="absolute rounded-full"
            style={{ top: `calc(${pct}% - 1px)`, left: 3, width: 3, height: 3, background: "color-mix(in srgb, var(--text) 26%, transparent)" }} />
        ))}
        {marks.map((m) => (
          <button key={m.key} onClick={() => onGo(m.i)} title="Go to this one"
            className="absolute rounded-full"
            style={{ top: `calc(${m.pct}% - 2px)`, left: 1, width: 7, height: 5, background: "var(--warning)",
              boxShadow: "0 0 5px color-mix(in srgb, var(--warning) 70%, transparent)", pointerEvents: "auto" }} />
        ))}
      </div>
    </div>
  );
}

function Conversation({ d, lanes, raw, onRaw, onResolve, onReply, onComment, onReact, onApply, busy, who, onWho,
  atoms, newSet, onMarkRead, sinceMine, onUnmarkRead, viewer, onSaveComment, onHideComment }: {
  d: PrDetail;
  lanes: { humans: PrReview[]; botReviews: PrReview[]; humanComments: PrComment[]; bots: PrComment[] };
  raw: boolean; onRaw: (v: boolean) => void;
  onResolve: (t: PrThread) => void; onReply: (t: PrThread, body: string) => Promise<boolean>;
  onApply?: (t: PrThread, text: string) => void;
  onComment: (body: string) => Promise<boolean>;
  onReact: (nodeId: string, content: string, on: boolean) => void;
  busy: boolean;
  /* Held by the panel rather than here, because the rail's jump has to be able
     to clear it: the row you are being sent to may be a bot's, and landing on a
     conversation filtered to Humans scrolls to nothing and reads as a dead
     button. */
  who: ConvWho; onWho: (v: ConvWho) => void;
  /** What has been said since this browser last looked, oldest first, and the
   *  same thing as a set so a comment can ask about itself in one step. */
  atoms: NewAtom[]; newSet: Set<string>; onMarkRead: () => void;
  /** How much arrived after your own last word here, marked read or not. Only
   *  to offer the way back when the marks have been cleared. */
  sinceMine: number; onUnmarkRead: () => void;
  /** Which login is reading, so Edit is offered on your own remarks and nowhere
   *  else. Undefined until the capability call lands — and then nothing is offered,
   *  which is the honest state. */
  viewer?: string;
  /** Save an edited remark. `kind` is which mutation it needs — a review body and a
   *  line comment are different objects on GitHub. */
  onSaveComment?: (nodeId: string, kind: "issue" | "review", body: string) => Promise<boolean>;
  /** Fold one away, or put it back. */
  onHideComment?: (nodeId: string, on: boolean) => void;
}) {
  const [newest, setNewest] = useState(false);
  /** Which remark is being edited here, by node id. One at a time: two open editors
   *  on one conversation is two half-written sentences and a wrong Save. */
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => { setEditing(null); }, [d.number]);
  /** The editor for one remark, or nothing. Built here rather than in `Card`, which
   *  is a presentational component and has no business knowing how a save works. */
  const editorFor = (nodeId: string | undefined, kind: "issue" | "review", body: string) =>
    (nodeId && editing === nodeId && onSaveComment
      ? <Composer initial={body} autoFocus busy={busy} placeholder="Edit this remark — markdown works here"
          sendLabel="Save" onSend={async (b) => { const ok = await onSaveComment(nodeId, kind, b); if (ok) setEditing(null); return ok; }} />
      : undefined);
  /*
   * Quote reply, into the composer at the foot of this conversation.
   *
   * Written into the composer's own stash and the composer remounted to pick it up,
   * rather than lifted into state here: that stash is what already survives leaving
   * the pull request and coming back (see COMPOSE_KEY), so a quote you have not sent
   * yet survives the same way a sentence you were typing does. Appended, never
   * replacing — the quote is usually the second thing in a reply that was already
   * half written.
   */
  const [composerKey, setComposerKey] = useState(0);
  const quote = (body: string) => {
    const key = `say|${d.url}`;
    writeStash(key, quoteReply(readStash(key), body));
    setComposerKey((n) => n + 1);
  };

  /** The three menu props every human remark gets, in one place so a review and a
   *  comment cannot end up with different menus. */
  const acts = (o: { author: string; nodeId?: string; body: string; kind: "issue" | "review"; minimized?: boolean }) => ({
    body: o.body,
    mine: !!viewer && o.author.toLowerCase() === viewer.toLowerCase(),
    minimized: o.minimized,
    onQuote: quote,
    onEdit: o.nodeId && onSaveComment ? () => setEditing(o.nodeId!) : undefined,
    onHide: o.nodeId && onHideComment ? (on: boolean) => onHideComment(o.nodeId!, on) : undefined,
    editor: editorFor(o.nodeId, o.kind, o.body),
  });
  const setWho = onWho;
  const [cursor, setCursor] = useState(-1);
  /* Which person, inside Humans. Its own state and not part of `who`, because
     it has to survive nothing and clear itself the moment you leave the lane —
     a hidden filter is how a conversation reads as empty for no reason. */
  const [person, setPerson] = useState<string | null>(null);
  const [pCursor, setPCursor] = useState(-1);
  useEffect(() => { setPerson(null); setPCursor(-1); }, [who]);
  const tlRef = useRef<HTMLDivElement>(null);

  /*
   * Walk to the next thing said since you last looked.
   *
   * The scroll is the point, and so is the flash: on a conversation this long
   * a jump that lands silently is indistinguishable from a jump that did
   * nothing, and the reader starts scrolling anyway to check. `block: "center"`
   * for the same reason — a reply flush against the top edge of a scroller
   * reads as the top of a section rather than as the thing you were sent to.
   */
  const jump = useCallback((i: number) => {
    const list = atoms;
    if (!list.length) return;
    /* Step over anything with nothing on the page to land on. One counted
       remark that the timeline does not draw used to make the button do
       nothing at all, silently, which reads as broken rather than as a
       disagreement between a counter and a list. The direction of travel is
       kept, so "Next" past a gap is still Next. */
    const step = i < cursor ? -1 : 1;
    let n = ((i % list.length) + list.length) % list.length;
    let el = document.getElementById(anchorId(list[n]!.key));
    for (let tries = 0; !el && tries < list.length; tries++) {
      n = ((n + step) % list.length + list.length) % list.length;
      el = document.getElementById(anchorId(list[n]!.key));
    }
    setCursor(n);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.remove("agx-found");
    void el.offsetWidth; // restart the animation when it is the same element twice
    el.classList.add("agx-found");
  }, [atoms, cursor]);

  /* n and p, because both hands are already on the keyboard when you are
     reading. Ignored while typing — a reply with the letter n in it is not a
     navigation command, and that bug is only found by whoever writes "nothing"
     into a review and watches the page jump. */
  useEffect(() => {
    if (!atoms.length) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "n") { e.preventDefault(); jump(cursor + 1); }
      else if (e.key === "p") { e.preventDefault(); jump(cursor - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atoms.length, cursor, jump]);

  /* A filter that empties itself is a dead end: mark everything read while
     "New" is showing and you are left staring at nothing with no clue why. */
  useEffect(() => { if (who === "new" && !atoms.length) setWho("all"); }, [who, atoms.length, setWho]);
  const kb = Math.round(lanes.bots.reduce((n, c) => n + c.body.length, 0) / 1024);
  const reviewAuthors = new Set(lanes.humans.map((r) => r.author));

  /*
   * The threads that have moved on since the review they were submitted with.
   *
   * A review owns its threads, and that grouping is the meaning of a "requested
   * changes": the verdict, with its reasons under it. But it is also what
   * buries a live argument — the review is dated two days ago, so everything
   * nested under it sits two days back on the page however recently anybody
   * spoke. Measured on a real one: a reply nine minutes old, three comments
   * deep, in the middle of a long page, and no sign anywhere that it existed.
   *
   * So a thread that has been answered SINCE its review comes out to the top
   * level and takes its place by its last reply. It keeps a chip naming the
   * review it came from, so the grouping is still readable — trading one loss
   * for another would not be a fix.
   */
  const cameFrom = new Map<string, string>();
  for (const r of lanes.humans) {
    for (const t of d.threads) {
      if (t.comments[0]?.author !== r.author) continue;
      if (threadMovedOn(t, r.submittedAt)) cameFrom.set(t.id, r.author);
    }
  }
  const orphanThreads = d.threads.filter(
    (t) => cameFrom.has(t.id) || !reviewAuthors.has(t.comments[0]?.author ?? ""),
  );

  /** Who said it, so the timeline can be narrowed to one kind of voice. An
   *  `event` is nobody speaking — a push, a label — and belongs to neither
   *  side, so it shows in the whole timeline and in no filtered view. */
  type Lane = "human" | "bot" | "event";
  /** `ms` is what the timeline sorts on, and for a thread it is its LAST
   *  comment. It used to be the first, which is the ordering bug this whole
   *  feature was written for. */
  /* `author` is whoever's remark this row IS — for a thread, whoever raised it,
     the same rule the lane uses. Absent on events, which nobody said. */
  type Entry = { at: string; ms: number; key: string; lane: Lane; author?: string; hot?: number; node: React.ReactNode; body: React.ReactNode };
  const entries: Entry[] = [];
  const ms = (iso: string) => Date.parse(iso) || 0;
  /** How many of the things said since your last visit are inside this one. */
  const hotOf = (keys: string[]) => keys.filter((k) => newSet.has(k)).length;
  const threadHot = (t: PrThread) => hotOf(t.comments.map((c) => `${t.id}:${c.id}`));

  for (const [i, r] of lanes.humans.entries()) {
    const mine = d.threads.filter((t) => t.comments[0]?.author === r.author && !cameFrom.has(t.id));
    const tone = r.state === "CHANGES_REQUESTED" ? "chg" : r.state === "APPROVED" ? "appr" : undefined;
    entries.push({
      at: r.submittedAt, ms: ms(r.submittedAt), key: `r${i}`, lane: "human", author: r.author,
      hot: hotOf([`r${r.author}-${r.submittedAt}`]) + mine.reduce((n, t) => n + threadHot(t), 0),
      node: <span style={{ color: tone === "chg" ? "var(--error)" : tone === "appr" ? "var(--success)" : "var(--text3)" }}>
        {r.state === "CHANGES_REQUESTED" ? "✕" : r.state === "APPROVED" ? "✓" : "💬"}</span>,
      body: (
        <>
          <span id={anchorId(`r${r.author}-${r.submittedAt}`)} />
          <Card who={r.author} when={ago(r.submittedAt)} url={r.url} tone={tone}
            fresh={newSet.has(`r${r.author}-${r.submittedAt}`)}
            edited={r.editedAt} assoc={r.association} nodeId={r.nodeId} reactions={r.reactions} onReact={onReact}
            {...acts({ author: r.author, nodeId: r.nodeId, body: r.body, kind: "issue" })}
            chip={r.state === "CHANGES_REQUESTED" ? <Chip text="requested changes" tint="var(--error)" />
              : r.state === "APPROVED" ? <Chip text="approved" tint="var(--success)" /> : undefined}>
            {r.body ? <Md body={r.body} />
              : <span style={{ color: "var(--text3)" }}>({r.state.toLowerCase().replace("_", " ")}, no note)</span>}
          </Card>
          {mine.length > 0 && (
            <div className="pl-3 ml-2" style={{ borderLeft: "2px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
              {mine.map((t) => <Thread key={t.id} t={t} onResolve={onResolve} onReply={onReply} onApply={onApply} busy={busy} newSet={newSet} />)}
            </div>
          )}
        </>
      ),
    });
  }
  for (const c of lanes.humanComments) {
    entries.push({
      at: c.createdAt, ms: ms(c.createdAt), key: `c${c.id}`, lane: "human", author: c.author, hot: hotOf([`c${c.id}`]),
      node: <span style={{ color: "var(--text3)" }}>💬</span>,
      body: <><span id={anchorId(`c${c.id}`)} />
        <Card who={c.author} when={ago(c.createdAt)} url={c.url} fresh={newSet.has(`c${c.id}`)}
          edited={c.editedAt} assoc={c.association} nodeId={c.nodeId} reactions={c.reactions} onReact={onReact}
          {...acts({ author: c.author, nodeId: c.nodeId, body: c.body, kind: "issue" })}><Md body={c.body} /></Card></>,
    });
  }
  for (const t of orphanThreads) {
    /*
     * Whose voice this is, read off the thread rather than assumed.
     *
     * It was hard-coded to "human", so every line comment an automation wrote
     * was filed as a person: reported from a pull request nobody had touched
     * except the author, where the Humans tab counted eight and the whole
     * eight were a bot arguing on the diff. The filter exists to answer "has a
     * PERSON said anything", and it was answering "has anything been said".
     *
     * Read off whoever OPENED it, not off "does any human appear in it". A
     * thread is one row in this timeline and the row is headed by the person
     * who raised the point; a reply inside somebody else's thread is part of
     * their remark, not a remark of your own. It is also the only rule that can
     * say "Humans 0" on a pull request where only automation has raised
     * anything — which is the answer he came looking for.
     */
    const lane: Lane = t.comments[0]?.isBot ? "bot" : "human";
    entries.push({
      // Its LAST comment, not its first. A thread nobody has touched sorts
      // exactly where it always did; one that has just been answered arrives
      // where the answer belongs.
      at: t.comments[0]?.createdAt ?? "", ms: threadLastAt(t), key: `t${t.id}`, lane, author: t.comments[0]?.author, hot: threadHot(t),
      node: <span style={{ color: t.isResolved ? "var(--success)" : "var(--warning)" }}>{t.isResolved ? "✓" : "○"}</span>,
      body: <Thread t={t} onResolve={onResolve} onReply={onReply} onApply={onApply} busy={busy}
        newSet={newSet} cameFrom={cameFrom.get(t.id)} />,
    });
  }
  for (const [i, r] of lanes.botReviews.entries()) {
    entries.push({
      at: r.submittedAt, ms: ms(r.submittedAt), key: `br${i}`, lane: "bot", node: <span style={{ color: "var(--info)" }}>⌬</span>,
      body: <Card who={r.author} when={ago(r.submittedAt)} url={r.url} tone="bot"
        nodeId={r.nodeId} reactions={r.reactions} onReact={onReact}
        chip={<Chip text="automation" tint="var(--info)" />}><Md body={r.body} /></Card>,
    });
  }
  for (const c of lanes.bots) {
    entries.push({
      at: c.createdAt, ms: ms(c.createdAt), key: `b${c.id}`, lane: "bot", hot: hotOf([`c${c.id}`]),
      node: <span style={{ color: "var(--info)" }}>⌬</span>,
      body: (
        <Card who={c.author} when={ago(c.createdAt)} url={c.url} tone="bot" chip={<Chip text="automation" tint="var(--info)" />}
          nodeId={c.nodeId} reactions={c.reactions} onReact={onReact}>
          {/* Rendered, not dumped. In full these used to be a <pre> of the raw
              source, so a coverage report arrived as `<!-- Pytest Coverage
              Comment -->` and a wall of pipe characters — the one shape of
              comment that most needs a table to be a table. It goes through the
              same Md as everything else: the table renders, the <details> folds,
              and the shields.io badge becomes a pill instead of a broken image. */}
          {raw
            ? <Md body={c.body} />
            : <span style={{ color: "var(--text2)" }}>{c.digest || "(Nothing worth pulling out)"}</span>}
        </Card>
      ),
    });
  }

  // The events between the remarks: pushes, renames, labels, the merge itself.
  // Without them the conversation reads as if nothing happened between comments
  // — the force-push that invalidated a review simply is not there.
  for (const [i, e] of d.timeline.entries()) {
    entries.push({
      at: e.at, ms: ms(e.at), key: `e${i}`, lane: "event",
      node: <span style={{ color: EVENT_TINT[e.kind] ?? "var(--text3)" }}>{EVENT_GLYPH[e.kind] ?? "•"}</span>,
      body: <TimelineEvent e={e} />,
    });
  }

  entries.sort((a, b) => (newest ? b.ms - a.ms : a.ms - b.ms));

  // Events are not remarks, so they are not counted — Humans plus Bots adds up
  // to All, which is the sum a reader checks. They still show in the whole
  // timeline, where the push that invalidated a review is part of the story.
  const humanCount = entries.filter((e) => e.lane === "human").length;
  const botCount = entries.filter((e) => e.lane === "bot").length;
  const laned = who === "all" ? entries
    : who === "new" ? entries.filter((e) => !!e.hot)
    : entries.filter((e) => e.lane === who);
  /* Who has actually spoken in this lane, most talkative first, counted off the
     rows the timeline draws rather than off the participant list: somebody who
     was requested and never answered is not a filter worth offering. */
  const speakers = (() => {
    const by = new Map<string, number>();
    for (const e of laned) if (e.author) by.set(e.author, (by.get(e.author) ?? 0) + 1);
    return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  })();
  const shown = person ? laned.filter((e) => e.author === person) : laned;
  /* Same dead end as the "New" guard above, one level down: a person picked in
     Humans who then has nothing on screen. Placed HERE and not up with the
     other effects on purpose — `speakers` is computed below them, and a hook
     reading it from up there is the temporal-dead-zone crash that takes the
     whole window black. */
  /* Walking one person's remarks. Same landing as the New walker — centred and
     flashed — because a jump that lands silently on a long page is
     indistinguishable from one that did nothing. */
  const step = (dir: 1 | -1) => {
    if (!shown.length) return;
    const next = ((pCursor + dir) % shown.length + shown.length) % shown.length;
    setPCursor(next);
    const el = document.getElementById(anchorId(shown[next]!.key));
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.remove("agx-found");
    void el.offsetWidth;
    el.classList.add("agx-found");
  };
  const speakerKey = speakers.map(([n]) => n).join("\u0000");
  useEffect(() => {
    if (person && !speakerKey.split("\u0000").includes(person)) { setPerson(null); setPCursor(-1); }
  }, [person, speakerKey]);

  /* The events between the comments. GitHub has no timestamp on either of these
     — "opened" is not on the detail payload and a force-push is a boolean —
     so they are anchored to the ends of the timeline rather than given a time
     they would be making up. */
  const opened = (
    <div key="opened" className="agx-tiny">
      <span className="agx-node">＋</span>
      <span><b>{d.author}</b> opened this pull request from <code style={{ ...CODE_FONT_STYLE, color: "var(--primary)" }}>{d.headRefName}</code> into <code style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }}>{d.baseRefName}</code></span>
    </div>
  );
  /* The real force-push events now come from the timeline with their own
     timestamps, so this is only the *warning* that the newest one invalidated a
     review — a judgement the raw event cannot make. */
  const forced = d.forcePushedSinceReview ? (
    <div key="forced" className="agx-tiny">
      <span className="agx-node" style={{ color: "var(--warning)" }}>↻</span>
      <span style={{ color: "var(--warning)" }}>The last review was for code that is no longer here — it was force-pushed over</span>
    </div>
  ) : null;

  /* `key` so a quote lands: the composer reads its stash when it mounts, which is
     the same mechanism that restores a half-written comment, and remounting is how a
     quote written into that stash reaches the box somebody is about to type in. */
  const composer = <Composer key={composerKey} onSend={onComment} busy={busy} placeholder="Leave a comment — markdown works here" sendLabel="Comment" onOpenGithub={() => openExternal(d.url)} stash={`say|${d.url}`} />;

  if (entries.length === 0) {
    return (
      <div className="text-[11px]">
        <div className="agx-tl">{opened}</div>
        <div className="text-[11px] mb-3" style={{ color: "var(--text3)" }}>Nobody has said anything yet.</div>
        {composer}
      </div>
    );
  }

  return (
    <div className="text-[11px]">
      {/*
        * What has been said since you last looked, and a way to walk to it.
        *
        * The number alone would be no better than GitHub's: knowing there are
        * three is not the same as finding them, and on the pull request this
        * was written for the third one was three comments deep in a thread
        * dated two days earlier. So the bar is a control — next, previous, and
        * where you are in the set — and it says WHERE the one you are on lives,
        * because "src/billing/receipts.py:420" is the part you were looking for
        * when you gave up scrolling.
        */}
      {atoms.length > 0 && (
        /*
         * Pinned to the top of the scroller, because it is a control and not a
         * notice. Reported the moment it worked: "Next" sends you three
         * screens down and the button that says Next is now three screens up,
         * so walking three replies means scrolling back to the top twice.
         *
         * Opaque, not tinted-transparent — comment text slides under it — and
         * the shadow is the trick that covers the scroller's own 12px of top
         * padding: sticky `top: 0` parks against the padding edge, and without
         * the band you get a strip of moving text above a pinned bar.
         */
        <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg text-[10.5px] flex-wrap sticky"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 14%, var(--bg))",
            border: "1px solid color-mix(in srgb, var(--warning) 34%, transparent)",
            position: "sticky", top: 0, zIndex: 8, boxShadow: "0 -12px 0 0 var(--bg)" }}>
          <span aria-hidden>●</span>
          <span><b style={{ fontWeight: 600 }}>{atoms.length}</b> new since you last looked</span>
          {cursor >= 0 && atoms[cursor] && (
            <span style={{ color: "color-mix(in srgb, var(--warning) 80%, var(--text))" }}>
              · {cursor + 1} of {atoms.length} · {atoms[cursor]!.author} · {atoms[cursor]!.where}
            </span>
          )}
          <span className="flex-1" />
          <button onClick={() => jump(cursor - 1)} title="Previous new one (p)"
            className="agx-btn px-1.5 py-0.5 rounded" style={{ color: "inherit", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>◂</button>
          <button onClick={() => jump(cursor + 1)} title="Next new one (n)"
            className="agx-btn px-2 py-0.5 rounded" style={{ color: "inherit", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>
            {cursor < 0 ? "Take me to it" : "Next"} ▸
          </button>
          {/* Clears the marks for good. Its own button because leaving the pull
              request does the same thing silently, and somebody who has read
              the lot while standing on it should not have to leave to say so. */}
          <button onClick={onMarkRead} title="Clear these marks — everything here counts as read"
            className="agx-btn px-1.5 py-0.5 rounded" style={{ color: "inherit", opacity: 0.85 }}>Mark read</button>
        </div>
      )}
      {/* The way back.
          With nothing new, a conversation where somebody answered you an hour
          ago and the mark has since been cleared looks exactly like one where
          nobody has said anything — so the offer is made where the bar would
          have been, quietly. Written because the marks were cleared by an app
          restart with nothing to blame it on and no way to undo it. */}
      {!atoms.length && sinceMine > 0 && (
        <div className="flex items-center gap-2 mb-3 text-[10px]" style={{ color: "var(--text4)" }}>
          <span>Nothing new since you last looked.</span>
          <button onClick={onUnmarkRead} className="agx-btn px-1.5 py-0.5 rounded"
            title="Forget the mark and show everything said after your own last comment"
            style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
            Show the {sinceMine} since your last comment
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 mb-3 text-[10px]" style={{ color: "var(--text3)" }}>
        <span>One timeline — reviews, comments, threads and events in the order they happened</span>
        {d.truncated?.comments ? (
          <span style={{ color: "var(--warning)" }}>· showing the most recent {d.truncated.comments}</span>
        ) : null}
        <span className="flex-1" />
        {lanes.bots.length > 0 && (
          <Btn small onClick={() => onRaw(!raw)}>
            {raw ? "Digest automation" : `Show automation in full · ${kb} KB`}
          </Btn>
        )}
        <Btn small onClick={() => setNewest(false)} primary={!newest}>Oldest</Btn>
        <Btn small onClick={() => setNewest(true)} primary={newest}>Newest</Btn>
      </div>
      {/* Whose remarks. On a real pull request the machines outnumber the people
          two to one, and the review that blocks the merge is somewhere under
          forty coverage reports — "Humans" is the whole reason this tab is
          readable. Counts are on the buttons because an empty result should be
          predictable before it is clicked, not a surprise after — and a
          "Humans 0" is the most useful thing this row can say, so it shows
          wherever there is automation at all rather than only where both sides
          spoke. */}
      {/* "New" earns its place beside the voices even though it is not one:
          on a long pull request it is the only filter that answers the question
          you came back with. It appears only when there is something under it —
          a filter that is always there and usually empty teaches people not to
          press it. */}
      {(botCount > 0 || atoms.length > 0) && (
        <div className="flex mb-3 rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
          {([
            ["all", "All", humanCount + botCount] as const,
            ...(botCount > 0 ? [["human", "Humans", humanCount] as const, ["bot", "Bots", botCount] as const] : []),
            ...(atoms.length ? [["new", "New", atoms.length] as const] : []),
          ]).map(([id, label, n]) => (
            <button key={id} onClick={() => setWho(id)}
              className="agx-btn flex-1 text-[10.5px] py-1.5 flex items-center justify-center gap-1.5"
              style={{
                color: id === "new" && who !== id ? "var(--warning)" : who === id ? "var(--text)" : "var(--text3)",
                background: who === id
                  ? (id === "new" ? "color-mix(in srgb, var(--warning) 22%, transparent)" : "color-mix(in srgb, var(--border) 30%, transparent)")
                  : "transparent",
              }}>
              {label}<span className="tabular-nums opacity-70">{n}</span>
            </button>
          ))}
        </div>
      )}
      {/* Inside Humans, WHO. On a long review the lane is still forty rows and
          the question is usually about one person — so the people who have
          actually spoken get a row of their own, with what each of them said
          counted, and a pair of steps to walk their remarks without scrolling
          past everybody else's.

          Only in this lane, and only past two speakers: a sub-filter offering
          "the author" on a pull request nobody else has touched is a control
          that can only ever do nothing. */}
      {who === "human" && speakers.length > 1 && (
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          {speakers.map(([name, n]) => {
            const on = person === name;
            return (
              <button key={name} onClick={() => { setPerson(on ? null : name); setPCursor(-1); }}
                title={on ? `Show everyone again` : `Only ${name} — ${n} remark${n === 1 ? "" : "s"}`}
                className="agx-btn text-[10.5px] px-2 py-0.5 rounded-full inline-flex items-center gap-1.5 tabular-nums"
                style={{
                  color: on ? "var(--text)" : "var(--text3)",
                  border: `1px solid color-mix(in srgb, var(--text) ${on ? 30 : 16}%, transparent)`,
                  background: on ? "color-mix(in srgb, var(--border) 30%, transparent)" : "transparent",
                }}>
                {name}<span className="opacity-70">{n}</span>
              </button>
            );
          })}
          {person && (
            <span className="inline-flex items-center gap-1 ml-auto">
              {/* Steps rather than a scrollbar: the rows are scattered through a
                  conversation that may be hundreds long, and "the next thing
                  THEY said" is the movement being asked for. */}
              <button onClick={() => step(-1)} title={`Previous remark by ${person}`}
                className="agx-btn inline-grid place-items-center rounded"
                style={{ width: 20, height: 20, color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>↑</button>
              <button onClick={() => step(1)} title={`Next remark by ${person}`}
                className="agx-btn inline-grid place-items-center rounded"
                style={{ width: 20, height: 20, color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>↓</button>
              <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>
                {pCursor >= 0 ? `${pCursor + 1}/${shown.length}` : shown.length}
              </span>
            </span>
          )}
        </div>
      )}
      {/* The timeline, with a rail of marks beside it.
          The rail answers "how much page is between me and the next new thing"
          — which is the question you are actually asking while you scroll, and
          the one a count in a bar cannot answer. */}
      <div className="flex gap-2 items-stretch">
        <div className="agx-tl flex-1 min-w-0" ref={tlRef}>
          {!newest && opened}
          {newest && forced}
          {shown.map((e) => (
            <div key={e.key} className="agx-ev" data-hot={e.hot ? "1" : undefined}>
              <span className="agx-node">{e.node}</span>
              {e.body}
            </div>
          ))}
          {!newest && forced}
          {newest && opened}
        </div>
        {atoms.length > 0 && (
          <NewRail container={tlRef} atoms={atoms} onGo={jump}
            depKey={`${shown.length}|${who}|${newest}|${raw}`} />
        )}
      </div>
      <div className="mt-3">{composer}</div>
    </div>
  );
}

/**
 * Write, preview, send. Shared by the conversation and by anywhere else that
 * takes markdown, so the two never drift into behaving differently.
 */
function Composer({ onSend, busy, placeholder, sendLabel, sendTitle, quiet, onOpenGithub, initial, autoFocus, secondary, stash }: {
  onSend: (body: string) => Promise<boolean>; busy: boolean; placeholder: string; sendLabel: string;
  /** What the main button promises, when the label alone cannot say it. */
  sendTitle?: string;
  /** Do not fill the main button. For a pair of equally weighted outcomes,
   *  where filling one is a claim about which you meant. */
  quiet?: boolean;
  /** A second way to send the same text. On a line comment that is "post this
   *  one now" beside "hold it for the review" — two outcomes GitHub offers at
   *  the box, and which this had collapsed into one. */
  secondary?: { label: string; title?: string; onSend: (body: string) => Promise<boolean> };
  /** Opens this pull request on GitHub — the only place an image can actually
   *  be attached. */
  onOpenGithub?: () => void;
  /** Seed text — e.g. a ```suggestion block prefilled with the line. */
  initial?: string;
  /** Focus the textarea on mount — for a composer that opened on a click. */
  autoFocus?: boolean;
  /** Where to keep the text if it is never sent. Given a key, everything typed
   *  here survives the box being closed, the tab being changed and the app
   *  being rebuilt, and comes back the next time this same box is opened. */
  stash?: string;
}) {
  const [text, setText] = useState(() => (stash ? readStash(stash) : "") || initial || "");
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** The saved replies, shared by every composer on the page — see useSavedReplies. */
  const replies = useSavedReplies();
  /** Drop one in where the caret is, replacing whatever was selected. */
  const insertAtCaret = (body: string) => {
    const ta = taRef.current;
    const at = ta ? ta.selectionStart : text.length;
    const to = ta ? ta.selectionEnd : text.length;
    const next = text.slice(0, at) + body + text.slice(to);
    setText(next);
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(at + body.length, at + body.length); });
  };
  /** Was there something here when the box opened? Worth saying — text that
   *  reappears without explanation reads as a bug, not as a rescue. */
  const [restored, setRestored] = useState(() => !!(stash && readStash(stash).trim()));
  useEffect(() => { if (stash) writeStash(stash, text); }, [stash, text]);

  // `initial` can arrive AFTER the box is open: "± Suggest" prefills a
  // suggestion block into a composer that is already there. useState reads its
  // argument once, so without this the button did nothing whatsoever.
  const seeded = useRef(initial);
  useEffect(() => {
    if (initial == null || initial === seeded.current) return;
    seeded.current = initial;
    // Appended, not substituted: whatever you had already typed about the line
    // is the reason you are suggesting a change to it.
    setText((t) => (t.trim() ? `${t.replace(/\n+$/, "")}\n\n${initial}` : initial));
  }, [initial]);

  /**
   * `@`, `#` and `:` complete.
   *
   * Typing a collaborator's login or an issue number from memory means leaving
   * the panel to look it up, which is exactly the trip this is meant to save.
   * The trigger is the token immediately before the caret; Enter or Tab takes
   * the highlighted match, Escape drops the menu without touching the text.
   */
  const mentions = useContext(MentionCtx);
  const [ac, setAc] = useState<{ kind: "@" | "#" | ":"; q: string; at: number } | null>(null);
  const [acIdx, setAcIdx] = useState(0);

  type AcItem = { insert: string; label: string; hint?: string };
  const matches = useMemo<AcItem[]>(() => {
    if (!ac) return [];
    const q = ac.q.toLowerCase();
    if (ac.kind === "@") {
      return (mentions?.users ?? [])
        .filter((u) => u.toLowerCase().includes(q))
        .slice(0, 8).map((u) => ({ insert: `@${u} `, label: u }));
    }
    if (ac.kind === "#") {
      return (mentions?.issues ?? [])
        .filter((i) => String(i.number).startsWith(q) || i.title.toLowerCase().includes(q))
        .slice(0, 8).map((i) => ({ insert: `#${i.number} `, label: `#${i.number}`, hint: i.title.slice(0, 44) }));
    }
    return Object.keys(EMOJI_NAMES).filter((n) => n.startsWith(q)).slice(0, 8)
      .map((n) => ({ insert: `:${n}: `, label: `${EMOJI_NAMES[n]}  :${n}:` }));
  }, [ac, mentions]);

  const onType = (v: string, caret: number) => {
    setText(v);
    // Only the token the caret is sitting in, and only at a word boundary —
    // an email address must not open a mention menu.
    const before = v.slice(0, caret);
    const m = /(^|[\s(])([@#:])([\w.-]*)$/.exec(before);
    if (!m) { setAc(null); return; }
    setAc({ kind: m[2] as "@", q: m[3] ?? "", at: caret - (m[3]?.length ?? 0) - 1 });
    setAcIdx(0);
  };

  const take = (i: number) => {
    const pick = matches[i];
    if (!ac || !pick) return;
    const next = text.slice(0, ac.at) + pick.insert + text.slice(ac.at + 1 + ac.q.length);
    setText(next);
    setAc(null);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      const pos = ac.at + pick.insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  /**
   * Files dropped or pasted into the composer.
   *
   * A text file is inserted as a fenced code block, which is what you wanted it
   * for and needs nobody's permission. An image cannot be: GitHub has no public
   * attachment-upload API — their paperclip is web-only, and there is no gist
   * mutation or attachments endpoint to stand in for it (checked, not assumed).
   * Rather than invent a place to put the bytes (committing screenshots into the
   * repository is not a favour), it says so and offers the one thing that does
   * work: attaching it on GitHub itself.
   */
  const [imageNote, setImageNote] = useState<string | null>(null);
  const TEXTY = /\.(md|txt|log|json|jsonc|ya?ml|toml|ini|csv|tsv|diff|patch|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|sql|html?|css|scss|xml|svg)$/i;

  const takeFiles = async (files: File[]) => {
    if (!files.length) return;
    const image = files.find((f) => f.type.startsWith("image/"));
    if (image) {
      setImageNote(image.name);
      return;
    }
    const parts: string[] = [];
    for (const f of files.slice(0, 4)) {
      if (!TEXTY.test(f.name) && !f.type.startsWith("text/")) continue;
      // A composer is not a file host: enough to quote, not enough to hang the
      // panel pasting a 40MB log.
      const body = (await f.text()).slice(0, 60_000);
      const lang = (f.name.split(".").pop() ?? "").toLowerCase();
      parts.push(`**${f.name}**\n\n\`\`\`${lang}\n${body}\n\`\`\``);
    }
    if (!parts.length) { setImageNote(files[0]?.name ?? "that file"); return; }
    setText((t) => (t ? `${t}\n\n` : "") + parts.join("\n\n"));
    setImageNote(null);
  };

  /** `which` lets the second button reuse everything around sending — the
   *  guard, the spinner, the clear-on-success — instead of a copy of it that
   *  drifts. */
  const send = async (which: (body: string) => Promise<boolean> = onSend) => {
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await which(text);
    setSending(false);
    if (ok) { setText(""); setPreview(false); }
  };

  return (
    <div className="rounded-lg overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void takeFiles([...e.dataTransfer.files]); }}
      onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); void takeFiles(fs); } }}
      style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        <Btn onClick={() => setPreview(false)} small primary={!preview}>Write</Btn>
        <Btn onClick={() => setPreview(true)} small primary={preview}>Preview</Btn>
        {/*
          * The sentences you write over and over on other people's pull requests.
          *
          * Dropped in at the caret, not over what is in the box: a saved reply is
          * usually the middle of an answer rather than the whole of it. Edited in
          * Settings, and the menu says so instead of leaving an empty list looking
          * like something broken — there are no built-ins, because a canned sentence
          * that ships with the app is the app putting words in somebody's mouth, and
          * these get posted under their name.
          */}
        <span className="ml-auto">
          <Menu label={<QuoteIcon size={ICON.sm} />} title="Saved replies">
            {(close) => (
              <>
                {replies.length === 0 && (
                  <div className="px-3 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>Nothing saved yet.</div>
                )}
                {replies.map((r) => (
                  <MenuItem key={r.id} onClick={() => { close(); insertAtCaret(r.text); }}>{r.title}</MenuItem>
                ))}
                <MenuSep />
                <MenuItem onClick={() => { close(); openSettings("saved-replies"); }}>&#9998; Edit saved replies…</MenuItem>
              </>
            )}
          </Menu>
        </span>
      </div>
      {imageNote && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px]"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <span className="min-w-0 truncate">
            <b>{imageNote}</b> can't be attached from here — GitHub has no public upload API for attachments.
          </span>
          {onOpenGithub && (
            <button onClick={onOpenGithub} className="agx-btn ml-auto shrink-0 px-2 py-0.5 rounded"
              style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>Attach on GitHub ↗</button>
          )}
          <button onClick={() => setImageNote(null)} className="agx-btn shrink-0 px-1" style={{ color: "var(--text3)" }} aria-label="Dismiss">×</button>
        </div>
      )}
      {restored && (
        <div className="flex items-center gap-2 px-2.5 py-1 text-[10px]"
          style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 10%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <span>Picked up where you left off — this was never sent.</span>
          <button onClick={() => setRestored(false)} className="agx-btn ml-auto shrink-0 px-1" style={{ color: "var(--text3)" }} aria-label="Dismiss">×</button>
        </div>
      )}
      {preview ? (
        <div className="p-3 min-h-[80px]">{text.trim() ? <Md body={text} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}</div>
      ) : (
        <div className="relative">
          <textarea
            ref={taRef}
            value={text}
            autoFocus={autoFocus}
            onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            rows={4} placeholder={placeholder}
            onKeyDown={(e) => {
              if (ac && matches.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setAcIdx((i) => (i + 1) % matches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setAcIdx((i) => (i - 1 + matches.length) % matches.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); take(acIdx); return; }
                if (e.key === "Escape") { e.preventDefault(); setAc(null); return; }
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
            }}
            className="w-full p-3 text-[11.5px] outline-none resize-y bg-transparent agx-scroll"
            style={{ color: "var(--text)", lineHeight: 1.6 }}
          />
          {ac && matches.length > 0 && (
            <div className="absolute left-3 bottom-2 z-20 rounded-lg overflow-hidden"
              style={{ background: "color-mix(in srgb, var(--bg2) 97%, black)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", boxShadow: "0 14px 34px -16px rgba(0,0,0,.75)" }}>
              {matches.map((m, i) => (
                <button key={m.label} onMouseEnter={() => setAcIdx(i)} onClick={() => take(i)}
                  className="agx-btn w-full text-left flex items-center gap-2 px-2.5 py-1 text-[11px]"
                  style={{ background: i === acIdx ? "color-mix(in srgb, var(--primary) 22%, transparent)" : "transparent", color: "var(--text2)" }}>
                  <span>{m.label}</span>
                  {m.hint && <span className="truncate text-[10px]" style={{ color: "var(--text3)" }}>{m.hint}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-2.5 py-2"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        {/* With two outcomes, "to send" stops being an answer. The shortcut goes to
            the reversible one on purpose: a queued comment can be dropped before
            the review is submitted, and a posted one has already notified
            somebody. */}
        <span className="text-[10px]" style={{ color: "var(--text2)" }}>
          Markdown · <b>@</b> people · <b>#</b> issues · <b>:</b> emoji · drop a text file · ⌘↵ {secondary ? `for ${sendLabel.toLowerCase()}` : "to send"}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {secondary && (
            <Btn onClick={() => send(secondary.onSend)} disabled={sending || busy || !text.trim()} small
              title={!text.trim() ? "Write something first" : secondary.title}>
              {secondary.label}
            </Btn>
          )}
          <Btn onClick={() => send()} disabled={sending || busy || !text.trim()} primary={!quiet} small
            title={!text.trim() ? "Write something first" : sendTitle}>
            {sending ? "Sending…" : sendLabel}
          </Btn>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

const CHECK_TINT: Record<PrCheck["state"], string> = {
  success: "var(--success)", failure: "var(--error)", pending: "var(--warning)",
  skipped: "var(--text3)", neutral: "var(--text3)",
};
const CHECK_GLYPH: Record<PrCheck["state"], string> = {
  success: "✓", failure: "✕", pending: "•", skipped: "⊘", neutral: "⊘",
};

/** "CI / Tests / django-tests" — the workflow is the prefix, and grouping by
 *  it turns fifty-nine rows into six things you can actually scan. */
function groupOf(k: PrCheck): string {
  if (k.workflow) return k.workflow;
  const parts = k.name.split(" / ");
  return parts.length > 1 ? parts.slice(0, -1).join(" / ") : "Checks";
}

/**
 * One job's log, folded by its own step markers.
 *
 * GitHub Actions writes `##[group]` / `##[endgroup]` around each step and
 * stamps every line with an ISO timestamp. Folding on the first and stripping
 * the second is the difference between a wall of two thousand lines and a list
 * of steps you can open — and the failing step opens itself, because that is
 * the one you came for.
 */
function JobLog({ root, name, jobs }: { root: string; name: string; jobs: PrCheckJob[] }) {
  // Match the check to its job by name; GitHub names them the same thing.
  const job = useMemo(() => jobs.find((j) => j.name === name) ?? jobs.find((j) => name.includes(j.name)), [jobs, name]);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [openSteps, setOpenSteps] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open || !job || text !== null) return;
    let live = true;
    api.prJobLog(root, job.id)
      .then((r) => { if (!live) return; if (r.ok) setText(r.text ?? ""); else setErr(r.error || "Could not read the log"); })
      .catch(() => { if (live) setErr("Could not reach the server"); });
    return () => { live = false; };
  }, [open, job, root, text]);

  const steps = useMemo(() => {
    if (!text) return [];
    const out: { title: string; lines: string[]; failed: boolean }[] = [];
    let cur: { title: string; lines: string[]; failed: boolean } | null = null;
    for (const raw of text.split("\n")) {
      // Strip the timestamp GitHub prefixes to every single line.
      const line = raw.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "");
      const g = line.match(/^##\[group\](.*)$/);
      if (g) { if (cur) out.push(cur); cur = { title: g[1] || "step", lines: [], failed: false }; continue; }
      if (/^##\[endgroup\]/.test(line)) { if (cur) { out.push(cur); cur = null; } continue; }
      const target = cur ?? (out[out.length - 1] && !cur ? null : null);
      if (/^##\[error\]/.test(line) && cur) cur.failed = true;
      if (cur) cur.lines.push(line);
      else if (line.trim()) {
        if (!out.length || out[out.length - 1]!.title !== "output") out.push({ title: "output", lines: [], failed: false });
        out[out.length - 1]!.lines.push(line);
        if (/^##\[error\]/.test(line)) out[out.length - 1]!.failed = true;
      }
      void target;
    }
    if (cur) out.push(cur);
    return out;
  }, [text]);

  // The failing step opens itself.
  useEffect(() => {
    const bad = steps.findIndex((st) => st.failed);
    if (bad >= 0) setOpenSteps((cur) => (cur.has(bad) ? cur : new Set([...cur, bad])));
  }, [steps]);

  if (!job) return null;
  return (
    <div className="px-2.5 pb-2">
      <button onClick={() => setOpen((v) => !v)} className="agx-btn text-[10px] px-2 py-0.5 rounded"
        style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>
        {open ? "▾ Hide log" : "▸ Show log"}
      </button>
      {open && (
        <div className="mt-1.5 rounded overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
          {err ? <div className="p-2 text-[10.5px]" style={{ color: "var(--error)" }}>{err}</div>
            : text === null ? <div className="p-2 text-[10.5px]" style={{ color: "var(--text3)" }}>Reading the log…</div>
            : steps.length === 0 ? <div className="p-2 text-[10.5px]" style={{ color: "var(--text3)" }}>The log is empty.</div>
            : steps.map((st, i) => {
              const on = openSteps.has(i);
              return (
                <div key={i} style={i ? { borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" } : undefined}>
                  <button onClick={() => setOpenSteps((c) => { const n = new Set(c); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    className="agx-btn w-full text-left flex items-center gap-2 px-2 py-1 text-[10.5px]"
                    style={{ background: st.failed ? "color-mix(in srgb, var(--error) 10%, transparent)" : "transparent" }}>
                    <span className="text-[10px]" style={{ color: "var(--text3)" }}>{on ? "▾" : "▸"}</span>
                    <span className="truncate" style={{ color: st.failed ? "var(--error)" : "var(--text2)" }}>{st.title}</span>
                    <span className="ml-auto tabular-nums text-[9.5px]" style={{ color: "var(--text3)" }}>{st.lines.length}</span>
                  </button>
                  {on && (
                    <pre className="overflow-x-auto text-[10px] max-h-80 agx-scroll px-2 py-1"
                      style={{ ...CODE_FONT_STYLE, color: "var(--text3)", background: "var(--bg)" }}>{st.lines.join("\n")}</pre>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function Checks({ d, root, jobs, onRerun, onRerunJobs, onAsk, busy, busyWhat }: { d: PrDetail; root: string; jobs: PrCheckJob[]; onRerun: () => void; onRerunJobs?: (what: "all" | "failed" | "job", id: string) => void; onAsk?: (check: PrCheck) => void; busy: boolean;
  /** Which request is in flight, so the button that started it is the one that
   *  spins — see Btn `pending`. */
  busyWhat?: string }) {
  const c = d.checks;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [showSkipped, setShowSkipped] = useState(false);
  const [openCheck, setOpenCheck] = useState<string | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, PrCheck[]>();
    for (const k of d.checksAll) {
      if (!showSkipped && (k.state === "skipped" || k.state === "neutral")) continue;
      const g = groupOf(k);
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(k);
    }
    const rank = (list: PrCheck[]) => (list.some((k) => k.state === "failure") ? 0 : list.some((k) => k.state === "pending") ? 1 : 2);
    return [...m.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]));
  }, [d.checksAll, showSkipped]);

  const skippedCount = d.checksAll.filter((k) => k.state === "skipped" || k.state === "neutral").length;
  const pct = (n: number) => (c.total ? (n / c.total) * 100 : 0);

  return (
    <div className="text-[11px] flex flex-col gap-2">
      <div className="flex items-center gap-3 p-3 rounded-lg" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
        <span className="shrink-0 rounded-full flex items-center justify-center text-[13px]"
          style={{ width: 26, height: 26, background: c.failure > 0 ? "var(--error)" : c.pending > 0 ? "var(--warning)" : "var(--success)", color: "var(--bg)" }}>
          {c.failure > 0 ? "✕" : c.pending > 0 ? "•" : "✓"}
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold leading-tight" style={{ color: "var(--text)" }}>
            {c.failure > 0 ? `${c.failure} check${c.failure === 1 ? "" : "s"} failing` : c.pending > 0 ? `${c.pending} still running` : "All checks have passed"}
          </span>
          <span className="block text-[11px] mt-1.5 tabular-nums" style={{ color: "var(--text3)" }}>
            {c.skipped} skipped · {c.success} successful · {c.failure} failing
          </span>
        </span>
        <span className="ml-auto shrink-0 flex items-center gap-2">
          {c.failure > 0 && <Btn onClick={onRerun} disabled={busy} small pending={busyWhat === "Re-run checks"}>Re-run failed</Btn>}
          <span className="text-[10px]" style={{ color: "var(--text3)" }}>{c.allDone ? "Notified once, not " + c.total : "You will be told once, at the end"}</span>
        </span>
      </div>
      <Bar parts={[
        { pct: pct(c.success), tint: "var(--success)" },
        { pct: pct(c.failure), tint: "var(--error)" },
        { pct: pct(c.pending), tint: "var(--warning)" },
        { pct: pct(c.skipped), tint: "color-mix(in srgb, var(--text3) 40%, transparent)" },
      ]} />

      {groups.map(([name, list]) => {
        const isOpen = openGroups[name] ?? list.some((k) => k.state === "failure" || k.state === "pending");
        const bad = list.filter((k) => k.state === "failure").length;
        const good = list.filter((k) => k.state === "success").length;
        return (
          <div key={name} className="rounded overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
            <button onClick={() => setOpenGroups((o) => ({ ...o, [name]: !isOpen }))}
              className="w-full text-left flex items-center gap-2 px-2.5 py-1.5"
              style={{ background: "color-mix(in srgb, var(--border) 14%, transparent)" }}>
              <span style={{ color: "var(--text3)" }}>{isOpen ? "▾" : "▸"}</span>
              <b style={{ color: "var(--text)", fontWeight: 500 }}>{name}</b>
              {bad > 0 && <span style={{ color: "var(--error)" }}>{bad} ✕</span>}
              {good > 0 && <span style={{ color: "var(--success)" }}>{good} ✓</span>}
              <span className="ml-auto tabular-nums" style={{ color: "var(--text3)" }}>{list.length}</span>
            </button>
            {isOpen && list.map((k, i) => {
              const bad = k.state === "failure";
              const id = `${name}::${k.name}::${i}`;
              const expanded = bad && openCheck === id;
              return (
                <div key={id} style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: bad ? "color-mix(in srgb, var(--error) 7%, transparent)" : undefined }}>
                  {/* A failing check is the one row on this tab you came for, so
                      it is the one row that opens into somewhere to go next. */}
                  <button onClick={() => bad && setOpenCheck(expanded ? null : id)} disabled={!bad}
                    className="w-full text-left flex items-center gap-2 px-2.5 py-1" style={{ cursor: bad ? "pointer" : "default" }}>
                    <span className="shrink-0 w-3 text-center" style={{ color: CHECK_TINT[k.state] }}>{CHECK_GLYPH[k.state]}</span>
                    <span className="truncate" style={{ color: k.state === "skipped" || k.state === "neutral" ? "var(--text3)" : "var(--text2)" }}>
                      {k.name.startsWith(name) ? k.name.slice(name.length).replace(/^\s*\/\s*/, "") || k.name : k.name}
                    </span>
                    <span className="ml-auto shrink-0 text-[9.5px] uppercase tracking-wide" style={{ color: CHECK_TINT[k.state] }}>{k.state}</span>
                    {bad && <span className="shrink-0" style={{ color: "var(--text3)" }}>{expanded ? "▾" : "▸"}</span>}
                  </button>
                  {expanded && (
                    <div className="flex items-center gap-1.5 flex-wrap px-2.5 pb-2 pt-0.5">
                      {onAsk && <Btn onClick={() => onAsk(k)} primary small title="Check the pull request out locally and hand the failure to Claude">✦ Ask Claude why</Btn>}
                      {k.url && (
                        <a href={externalUrl(k.url)} target="_blank" rel="noreferrer noopener" className="agx-btn text-[10px] px-2 py-0.5 rounded"
                          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>Open run ↗</a>
                      )}
                      <Btn onClick={onRerun} disabled={busy} small pending={busyWhat === "Re-run checks"} title="Re-run every failing check on this pull request">↻ Re-run failed</Btn>
                      {/* GitHub offers all three, and "the whole run failed
                          again for one flaky job" is exactly when you want the
                          single-job one. */}
                      {(() => {
                        const job = jobs.find((j) => j.name === k.name) ?? jobs.find((j) => k.name.includes(j.name));
                        if (!job || !onRerunJobs) return null;
                        return (
                          <>
                            <Btn onClick={() => onRerunJobs("job", job.id)} disabled={busy} small pending={busyWhat === "Re-run"} title={`Re-run only ${job.name}`}>↻ This job</Btn>
                            <Btn onClick={() => onRerunJobs("all", job.runId)} disabled={busy} small pending={busyWhat === "Re-run"} title="Re-run every job in this run, passing ones included">↻ All jobs</Btn>
                          </>
                        );
                      })()}
                    </div>
                  )}
                  {/* The log, here. It used to say "the log lives on GitHub" and
                      send you to a browser for the one thing you opened the
                      check to read. */}
                  {expanded && <JobLog root={root} name={k.name} jobs={jobs} />}
                </div>
              );
            })}
          </div>
        );
      })}

      {skippedCount > 0 && (
        <button onClick={() => setShowSkipped((v) => !v)} className="text-[10px] px-2.5 py-1.5 rounded self-start"
          style={{ color: "var(--text2)", border: "1px dashed color-mix(in srgb, var(--text) 24%, transparent)" }}>
          {showSkipped ? "Hide" : "Show"} {skippedCount} skipped
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// review submission
// ---------------------------------------------------------------------------

/**
 * Finishing a review: a verdict, a note, and everything queued while reading.
 *
 * A tab rather than a sheet, because reviewing is a place you go, not a dialog
 * you dismiss — and because it only exists on pull requests that are somebody
 * else's. The queued comments are the point: GitHub calls this a pending
 * review, and it exists so a reviewer leaves one notification rather than a
 * dozen. The comments and the verdict travel in a single request.
 */
function ReviewTab({ d, root, held, drafts, seen, busy, busyWhat, draft, onDraft, onDrop, onSubmit, onGoFiles }: {
  d: PrDetail; root: string; drafts: DraftComment[]; seen: number; busy: boolean;
  /** The line comments GitHub is holding in a review you started there and
   *  never submitted. Read by the panel so Files can draw them too. */
  held: PendingLine[];
  /** Which request is in flight — see Btn `pending`. */
  busyWhat?: string;
  /** The unsent review, held by the panel and written to storage — not state of
   *  this tab, which stops existing the moment you go and look at Files. */
  draft: ReviewDraft; onDraft: (patch: Partial<ReviewDraft>) => void;
  onDrop: (i: number) => void;
  onSubmit: (verb: "approve" | "request_changes" | "comment", body: string) => void;
  onGoFiles: () => void;
}) {
  const verb = draft.verb;
  const setVerb = (v: ReviewDraft["verb"]) => onDraft({ verb: v });
  const body = draft.body;
  const setBody = (b: string) => onDraft({ body: b });
  const [preview, setPreview] = useState(false);
  /** Which queued comment is open. One at a time on purpose: the row of chips
   *  is the thing that has to stay a row, and opening every remark at once is
   *  the layout this replaced. */
  const [openDraft, setOpenDraft] = useState<number | null>(null);
  /* The line comments GitHub is holding in a review you started in its own UI
     and never submitted. Asked for here rather than carried on PrDetail: only
     this tab needs them, and the answer is yours alone — GitHub shows a pending
     review to nobody but its author. */
  // Dropping one renumbers the rest, so an index held across that change points
  // at somebody else's remark. Closed whenever the queue changes length.
  useEffect(() => { setOpenDraft(null); }, [drafts.length]);
  const nothing = !body.trim() && drafts.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {d.viewerRequested && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[11.5px]"
          style={{ border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)", background: "color-mix(in srgb, var(--warning) 9%, transparent)" }}>
          <Avatar login={d.author} size={18} />
          <span style={{ color: "var(--text2)" }}>
            <b style={{ color: "var(--text)", fontWeight: 500 }}>{d.author}</b> requested your review on this pull request
          </span>
        </div>
      )}

      {/* Full width, now that it is a strip rather than a form. The cap was
          right for the old stacked layout — a five-row field and three cards
          spread across a 1900px window put a label and its input at opposite
          ends of the desk. This one has nothing to spread: the chips fill a row
          and wrap, the verdict stays its own size, and the send goes to the far
          edge where the eye ends up anyway. */}
      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
          style={{ background: "color-mix(in srgb, var(--border) 12%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <b style={{ color: "var(--text)", fontWeight: 500 }}>Finish your review</b>
          <span style={{ color: "var(--text3)" }}>#{d.number}</span>
          <button onClick={onGoFiles} className="ml-auto tabular-nums text-[10px]" style={{ color: seen < d.files.length ? "var(--primary)" : "var(--text3)" }}>
            {seen}/{d.files.length} files viewed
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2.5">
          {/* Queued comments as chips, one open at a time.
              Listed in full, this panel grew with the review: eleven cards and
              the verdict was a scroll away from the evidence it is about. A
              chip says where a remark landed — which is what you check when
              scanning — and opening one is how you re-read it. */}
          {drafts.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider shrink-0 mr-1" style={{ color: "var(--warning)" }}>Pending</span>
                {drafts.map((c, i) => {
                  const on = openDraft === i;
                  const where = `${c.path.split("/").pop()}:${c.startLine && c.startLine !== c.line ? `${c.startLine}–${c.line}` : c.line}`;
                  return (
                    <button key={i} onClick={() => setOpenDraft(on ? null : i)} aria-expanded={on}
                      // The full path in the title: the chip is short because a
                      // row of them has to stay a row, and two files in a pull
                      // request are called models.py more often than not.
                      title={`${c.path}:${c.line}`}
                      className="agx-btn text-[10.5px] px-2 py-0.5 rounded-full shrink-0"
                      style={{
                        color: "var(--warning)",
                        border: `1px ${on ? "solid" : "dashed"} color-mix(in srgb, var(--warning) 55%, transparent)`,
                        background: on ? "color-mix(in srgb, var(--warning) 16%, transparent)" : "transparent",
                        ...CODE_FONT_STYLE,
                      }}>
                      {where} {on ? "▴" : "▾"}
                    </button>
                  );
                })}
              </div>
              {openDraft != null && drafts[openDraft] && (
                <div className="rounded-lg overflow-hidden text-[11.5px]" style={{
                  background: "var(--bg2)",
                  border: "1px dashed color-mix(in srgb, var(--warning) 55%, transparent)",
                }}>
                  <div className="px-2.5 py-1 flex items-center gap-2 text-[10px]"
                    style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", color: "var(--warning)" }}>
                    <span className="min-w-0 truncate" style={{ ...CODE_FONT_STYLE }}>
                      {drafts[openDraft].path}:{drafts[openDraft].startLine && drafts[openDraft].startLine !== drafts[openDraft].line
                        ? `${drafts[openDraft].startLine}–${drafts[openDraft].line}` : drafts[openDraft].line}
                    </span>
                    <button onClick={() => { const i = openDraft; setOpenDraft(null); onDrop(i); }}
                      title="Discard this pending comment"
                      className="agx-btn ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px]"
                      style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)" }}>Drop</button>
                  </div>
                  <div className="px-2.5 py-2"><Md body={drafts[openDraft].body} /></div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
              {/* "Nothing queued" was a lie whenever GitHub was holding a review
                  started on the website: nothing is queued HERE, and something
                  is going out. The box below says how many; this line stops
                  contradicting it. */}
              {held.length > 0
                ? <>Nothing queued from here — {held.length} comment{held.length === 1 ? " is" : "s are"} already drafted on GitHub, below.</>
                : <>No line comments queued here. Open <button onClick={onGoFiles} style={{ color: "var(--primary)" }}>files</button> and
                  use the “+” on a line to attach one.</>}
            </div>
          )}

          {/* A review started in GitHub's own UI and left unsubmitted. Shown
              because the tab used to say nothing was queued while GitHub held
              three comments — and because submitting from here now finishes
              THAT review rather than replacing it. Read-only: editing somebody's
              draft through an API that has no endpoint for it is how they get
              lost. */}
          {held.length > 0 && (
            <div className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
              <div className="px-2.5 py-1.5 text-[10.5px] flex items-center gap-2"
                style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", color: "var(--text2)" }}>
                <span>{held.length} line comment{held.length === 1 ? "" : "s"} drafted on GitHub</span>
                <span className="ml-auto" style={{ color: "var(--text3)" }}>submitting here sends them</span>
              </div>
              {held.map((c, i) => (
                <div key={`${c.path}:${c.line}:${i}`} className="px-2.5 py-2"
                  style={{ borderTop: i ? "1px solid color-mix(in srgb, var(--text) 10%, transparent)" : undefined }}>
                  <div className="text-[10px] tabular-nums flex items-center gap-2">
                    <span className="truncate" title={c.path}>{c.path}{c.line === null ? " · outdated" : `:${c.line}`}</span>
                    {/* The way to change it. Nothing in this app can: the API
                        has no endpoint for a comment inside a pending review,
                        so the button that would edit it here would have to
                        submit the review to do it. */}
                    {c.url && (
                      <button onClick={() => openExternal(c.url!)} title="Edit this comment on GitHub"
                        className="agx-btn shrink-0 ml-auto px-1.5 py-0.5 rounded"
                        style={{ color: "var(--primary)" }}>Edit ↗</button>
                    )}
                  </div>
                  <div className="mt-1"><Md body={c.body} /></div>
                </div>
              ))}
            </div>
          )}

          {/* The verdict and the send, on one row. A three-way switch says these
              are one choice; three stacked cards took six rows to say the same
              thing and pushed the button that ends the review off the fold. */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>
              {([
                ["approve", "✓ Approve", "Submit and mark the pull request approved.", "var(--success)"],
                ["request_changes", "✕ Request changes", "Submit and block the merge until they land.", "var(--error)"],
                ["comment", "💬 Comment", "Submit without a verdict.", "var(--text)"],
              ] as const).map(([id, label, hint, tint], n) => {
                const on = verb === id;
                const off = id !== "comment" && d.viewerDidAuthor;
                return (
                  <button key={id} onClick={() => setVerb(id)} disabled={off} aria-pressed={on}
                    title={off ? "GitHub does not let you approve or block your own pull request" : hint}
                    className="agx-btn text-[11px] px-3 py-1.5 whitespace-nowrap"
                    style={{
                      color: on ? tint : "var(--text2)",
                      fontWeight: on ? 650 : 400,
                      background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                      borderLeft: n === 0 ? undefined : "1px solid color-mix(in srgb, var(--text) 14%, transparent)",
                      boxShadow: on ? "inset 0 -2px 0 var(--primary)" : undefined,
                      opacity: off ? 0.4 : 1, cursor: off ? "not-allowed" : "pointer",
                    }}>{label}</button>
                );
              })}
            </div>
            <span className="ml-auto">
              <Btn onClick={() => onSubmit(verb, body)} disabled={busy || (verb !== "approve" && nothing)} primary
                pending={busyWhat === "Review"}
                title={verb !== "approve" && nothing ? "Say something, or queue a line comment" : undefined}>Submit review</Btn>
            </span>
          </div>

          {/* Optional, and it says so. The note is the one part of a review you
              can leave out — the comments already carry the substance — and a
              five-row box with no label implied the opposite. */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {(["write", "preview"] as const).map((m) => (
                <button key={m} onClick={() => setPreview(m === "preview")} className="text-[10.5px] px-2 py-0.5 rounded"
                  style={{
                    color: (m === "preview") === preview ? "var(--text)" : "var(--text3)",
                    background: (m === "preview") === preview ? "color-mix(in srgb, var(--text) 10%, transparent)" : "transparent",
                  }}>{m === "preview" ? "Preview" : "Write"}</button>
              ))}
              <span className="ml-auto text-[10px]" style={{ color: "var(--text3)" }}>
                {verb !== "approve" && nothing
                  ? "Say something, or queue a line comment from Files."
                  : drafts.length
                    ? `${drafts.length} line comment${drafts.length === 1 ? "" : "s"} go with it — one notification, not ${drafts.length + 1}.`
                    : "Posted publicly to your team."}
              </span>
            </div>
            {preview ? (
              <div className="rounded-md p-2.5 min-h-[56px]" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
                {body.trim() ? <Md body={body} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}
              </div>
            ) : (
              /* Full width, like everything else in the strip. A reading
                 measure was the right instinct and the wrong place for it: the
                 card reaches the edge and a field stopping short of it reads as
                 a mistake, not as care. A summary is a line or two anyway. */
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2}
                placeholder="Summary — optional, markdown works here."
                className="w-full rounded-md p-2.5 text-[11.5px] resize-y" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
