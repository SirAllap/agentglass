/*
 * The Diff view, rebuilt.
 *
 * What it is for: reading what has changed across every checkout on this
 * machine, one file at a time. What went wrong with the last one is worth
 * writing down, because most of the decisions here are a reaction to it.
 *
 * It listed rows that were really `FileChange` events — an agent's Edit call —
 * so every field a changed file needs was invented: the time became the time of
 * the request, the section name became the literal string "unstaged", and a
 * row's identity changed when you ran `git add`, which threw away the selection
 * and the review tick mid-read. It carried the full diff of 400 files to render
 * one, at 1.1 MB every four seconds. And it put a filter box and eleven 9.5px
 * chips — two rows of them — above the first file name, all of them the same
 * weight, so the control that decides WHAT THE LIST IS looked exactly like the
 * one that decides how it is sorted.
 *
 * So the shape here is: one decision in the header, sections that are the unit
 * of work (a checkout, headed by its branch), and a row that answers what
 * changed, when, and by how much. Everything else — grouping, folding, the
 * hidden counts — lives in one menu, because those are questions you ask
 * occasionally and the file list is the thing you came for.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useCloseWithOwner } from "../../lib/layerOwner.ts";
import type { ChangeRow } from "../../../../shared/types.ts";
import {
  diffStateKey, filterRows, groupRows, reviewKeyOf, rowByKey, statusWord, totalsOf, useChangeRows, useFileDiff,
  visibleRows, whenLabel, type DiffMode, type DiffState, type GroupBy, type RowGroup,
  binaryWord, oldPathFor, nextUnread, unreadCount,
} from "../../lib/changeRows.ts";
import { useIncremental } from "../../lib/useIncremental.ts";
import { openPeek } from "../../lib/openPeek.ts";
import { groupHunks } from "../../lib/changeGroups.ts";
import { useSidebarWidth } from "../../lib/sidebarWidth.ts";
import { SidebarGrip } from "../SidebarGrip.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { Badge, Button, CHIP_ICON, FilterField, IconChip, Segmented, LINE } from "../workspace/Chrome.tsx";
import { viewHeaderClass, viewHeaderStyle } from "../workspace/ViewHeader.tsx";
import { diffSplit, diffWrap, setDiffSplit, setDiffWrap, diffNoWhitespace, setDiffNoWhitespace } from "../../lib/diffPrefs.ts";
import { subscribeWorktreeJump, worktreeJump, requestWorktreeJump } from "../../lib/worktreeJump.ts";
import { hunkChanges, hunkWithoutWhitespace } from "../../lib/diffNoWhitespace.ts";
import { useDiffHighlight, HiliteCtx } from "../../lib/diffHighlight.ts";
import { DiffToolbar } from "./DiffToolbar.tsx";
import { api } from "../../lib/api.ts";
import { SplitDiff, UnifiedDiff, SCROLLBAR_CSS, SPLIT_SEL_CSS, LINEBTN_CSS, type LinePick, type LineSel } from "./DiffLines.tsx";
import { CommentBox, CommentCard, ReviewTray, type SendOutcome } from "./DiffReview.tsx";
import {
  addComment, anchorLabel, captureSnippet, checkAtSend, clearReview, composeReview, editComment, isStale,
  removeComment, reviewFor, setFrame, settleReview, subscribeReviews, type Review, type ReviewComment, type StaleFile,
} from "../../lib/diffReview.ts";
import { requestTermIssue } from "../../lib/termIssue.ts";
import { AgentIcon, FileIcon, IconLabel } from "../../lib/glyphIcons.tsx";
import { authorsIndex, headingAuthors, rowAuthorsTitle, sectionAuthors } from "../../lib/treeAuthors.ts";

/* Storage keys are v3 on purpose: the two before them stored a group-by that no
   longer exists and ticks keyed by an id that no longer exists either. */
const K_MODE = "agentglass.diff.v3.mode";
const K_GROUP = "agentglass.diff.v3.groupBy";
const K_REVIEW = "agentglass.diff.v3.reviewed";
const K_IGNORED = "agentglass.diff.v3.showIgnored";
const K_OUTSIDE = "agentglass.diff.v3.showOutside";

/** Ticks are kept by row key, which survives staging and re-cloning. Capped so a
 *  year of reading cannot grow the entry without bound; the OLDEST go, because
 *  the tick you set five minutes ago is the one you are using. */
const REVIEW_MAX = 2000;

const read = <T,>(key: string, fallback: T, parse: (raw: string) => T): T => {
  try { const raw = localStorage.getItem(key); return raw == null ? fallback : parse(raw); } catch { return fallback; }
};
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

export function DiffPage({ active }: { active: boolean }) {
  const [mode, setMode] = useState<DiffMode>(() => read(K_MODE, "working", (r) => (r === "committed" ? "committed" : "working")));
  const [groupBy, setGroupBy] = useState<GroupBy>(() =>
    read(K_GROUP, "worktree", (r) => (r === "time" || r === "folder" ? (r as GroupBy) : "worktree")));
  const [q, setQ] = useState("");
  const [showIgnored, setShowIgnored] = useState(() => read(K_IGNORED, false, (r) => r === "1"));
  const [showOutside, setShowOutside] = useState(() => read(K_OUTSIDE, false, (r) => r === "1"));
  const [selKey, setSelKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() =>
    new Set(read<string[]>(K_REVIEW, [], (r) => JSON.parse(r) as string[])));
  const [split, setSplit] = useState(diffSplit);
  const [wrap, setWrap] = useState(diffWrap);
  /* The same preference the pull request panel reads, so the two surfaces open the
     same way — a toggle that means one thing in one panel and nothing in the other is
     the "every panel looks like it came from a different program" this app keeps having to fix. */
  const [noWs, setNoWs] = useState(diffNoWhitespace);
  const [menu, setMenu] = useState(false);

  /*
   * "Open its changes in File changes", honoured.
   *
   * Four buttons in this app ask for exactly this — the terminal's header, two in
   * its worktree picker, and the pull request's own — and every one of them landed
   * you on the whole list: twenty-seven files across six worktrees, with the filter
   * box empty and the six you asked about somewhere in the middle. Reported that
   * way, with the by-hand version of what was expected beside it.
   *
   * The request has always been made. Nothing here had ever read it: `App` routes
   * the view and `GitPanel` serves the `git` half, and when this page was rebuilt
   * (v3) the `diff` half lost its only consumer. So the button switched the view
   * and the scope it carried was dropped on the floor.
   *
   * Served once per request `n`, exactly as Source control does it, so a jump
   * survives arriving while this page was still hidden without being replayed every
   * time it is shown again. And it is a FILTER, not a mode: what it puts in the box
   * is what you would have typed, visible and clearable, rather than a hidden scope
   * that makes the list disagree with the field above it.
   */
  const wtJump = useSyncExternalStore(subscribeWorktreeJump, worktreeJump);
  const wtServed = useRef(0);
  useEffect(() => {
    if (!wtJump || wtJump.view !== "diff" || wtJump.n === wtServed.current) return;
    wtServed.current = wtJump.n;
    /* An empty filter is a real request — "show me everything" — so it is applied
       rather than skipped, which is the difference between this and a guard on
       truthiness. */
    setQ(wtJump.filter ?? "");
    /* The selection belonged to a row that is probably about to be filtered out.
       Dropping it lets the list heal to the first row of what you asked for, which
       is the file you wanted to be looking at. */
    setSelKey(null);
  }, [wtJump]);

  const sidebarW = useSidebarWidth();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => write(K_MODE, mode), [mode]);
  useEffect(() => write(K_GROUP, groupBy), [groupBy]);
  useEffect(() => write(K_IGNORED, showIgnored ? "1" : "0"), [showIgnored]);
  useEffect(() => write(K_OUTSIDE, showOutside ? "1" : "0"), [showOutside]);

  const { rows, truncated, failed, authors, loading, error } = useChangeRows(mode, active);
  const who = useMemo(() => authorsIndex(authors), [authors]);

  /* The counts the chips offer back. Each counts only what IT is hiding, or
     "+2 ignored" shows nothing when the same rows are also outside the project
     and the number reads as a lie. */
  const hiddenIgnored = useMemo(() => rows.reduce((n, r) => n + (r.ignored && (showOutside || !r.outside) ? 1 : 0), 0), [rows, showOutside]);
  const hiddenOutside = useMemo(() => rows.reduce((n, r) => n + (r.outside && (showIgnored || !r.ignored) ? 1 : 0), 0), [rows, showIgnored]);

  const shown = useMemo(
    () => filterRows(visibleRows(rows, showIgnored, showOutside), q),
    [rows, showIgnored, showOutside, q],
  );
  const groups = useMemo(() => groupRows(shown, groupBy), [shown, groupBy]);
  const totals = useMemo(() => totalsOf(shown, reviewed), [shown, reviewed]);

  // The selection heals to something that is on screen — but only when what it
  // pointed at has actually gone, so a poll cannot move the reader.
  const selected = useMemo(() => rowByKey(shown, selKey) ?? shown[0] ?? null, [shown, selKey]);
  useEffect(() => { if (selected && selected.key !== selKey) setSelKey(selected.key); }, [selected, selKey]);

  const body = useFileDiff(selected, mode);

  /*
   * The pending review, for the checkout the selected file is in.
   *
   * Per checkout because that is who receives it: one agent works in one tree,
   * and a review that mixed two would go to one of them with the other's
   * comments in it. Staleness is shown live only for the file on screen — the
   * others are not loaded; Send review fetches every commented file and checks
   * them all before anything goes (see sendReview).
   */
  const root = selected?.repoRoot ?? "";
  const review = useSyncExternalStore(subscribeReviews, () => reviewFor(root));
  const staleIds = useMemo(() => {
    /* Only against THIS file's diff, in this half: for the render between
       selecting a file and its fetch starting, `body` still holds the previous
       one's, and every comment here would flash stale against code it was never
       about. */
    const hunks = selected && body.for === diffStateKey(selected, mode) ? body.diff?.hunks ?? null : null;
    return new Set(review.comments
      .filter((c) => c.path === selected?.path && c.mode === mode && isStale(c, hunks))
      .map((c) => c.id));
  }, [review, body, selected, mode]);

  /*
   * A jump from the tray: select the file, in the half it was written in, and
   * scroll to its line once THAT file's diff is drawn — Body serves it, see there.
   * Selected in an effect rather than here because the other half's list is not
   * loaded yet when the half changes; the effect retries as rows arrive. A jump
   * that cannot land (the file was committed, or reverted, since) expires rather
   * than waiting to fire at whatever file with that path is opened next.
   */
  const [jumpTo, setJumpTo] = useState<{ c: ReviewComment; root: string } | null>(null);
  const jump = useCallback((c: ReviewComment) => {
    if (c.mode !== mode) setMode(c.mode);
    setJumpTo({ c, root });
  }, [root, mode]);
  useEffect(() => {
    if (!jumpTo || jumpTo.c.mode !== mode) return;
    const row = rows.find((r) => r.repoRoot === jumpTo.root && r.path === jumpTo.c.path);
    if (!row) return;
    if (!shown.some((r) => r.key === row.key)) setQ("");
    setSelKey(row.key);
  }, [jumpTo, rows, shown, mode]);
  useEffect(() => {
    if (!jumpTo) return;
    const t = setTimeout(() => setJumpTo(null), 5000);
    return () => clearTimeout(t);
  }, [jumpTo]);
  const jumped = useCallback(() => setJumpTo(null), []);

  /*
   * Send review checks every commented file first, not just the one on screen:
   * an agent edits the file you are NOT looking at as readily as the one you
   * are. Anything stale or uncheckable stops the send and is listed per file in
   * the tray; the next press sends it anyway, with each stale comment marked in
   * the prompt. The check belongs to the review it was run on — any edit to the
   * review drops it, and the next press checks again.
   */
  const [check, setCheck] = useState<{ review: Review; stale: Set<string>; files: StaleFile[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const checked = check && check.review === review ? check : null;

  /** Where the review's terminal request stands, said in the tray. The review is
   *  never cleared by it: the slot empties the moment the request is sent, so
   *  clearing on it dropped the review for a window that never opened (no agent
   *  CLI, a refusing server) with no word of why — and clearing on the ok answer
   *  left nothing to send again when the agent did not start. */
  const [sendingTo, setSendingTo] = useState<(SendOutcome & { root: string }) | null>(null);

  const deliver = useCallback(async (stale: ReadonlySet<string>) => {
    const prompt = composeReview(root, review, stale);
    const label = `review-${(selected?.branch || root.split("/").pop() || "checkout").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    /* A NEW tmux window with an agent already working on it, in the worktree
       the review is about — the same move conflict resolution already makes
       (PrPanel.tsx's "Send to terminal"). Never into whatever
       chat happens to be open in this tree: a chat is its own conversation,
       and a review is a fresh ask, not a reply slipped into one already in
       progress. */
    const answered = requestTermIssue(root, label, prompt, true);
    // It opens somewhere you are not looking, and this used to do its whole
    // job in silence — the review vanished and nothing on screen said where
    // it went. Bring the terminal view forward, the same handoff
    // GitPanel/PrPanel already make for conflicts.
    requestWorktreeJump({ view: "term" });
    setCheck(null);
    const where = root.split("/").pop() ?? root;
    setSendingTo({ root, label, where, state: "waiting" });
    const done = await settleReview(answered);
    // Keyed by root, so an answer for a checkout no longer on screen is not shown on this one.
    setSendingTo({ root, label, where, state: done.ok ? "sent" : "failed", ...(done.ok ? {} : { error: done.error }) });
  }, [root, review, selected?.branch]);

  const sendReview = useCallback(async () => {
    if (!root || !review.comments.length || checking || sendingTo?.state === "waiting") return;
    if (checked) { void deliver(checked.stale); return; }
    setChecking(true);
    const got = await checkAtSend(review.comments, (path, mode) => api.gitFileDiff(root, path, mode, oldPathFor(rows, root, path)).then((d) => d.hunks))
      .finally(() => setChecking(false));
    /* Edited, sent from another window or switched away from while the diffs
       were in flight: this press no longer means this review. */
    if (reviewFor(root) !== review) return;
    if (got.files.length) setCheck({ review, ...got });
    else void deliver(got.stale);
  }, [root, review, checking, checked, deliver, sendingTo?.state, rows]);
  /* What the tray marks stale: the file on screen, live, plus whatever the last
     send check found in the others. */
  const trayStale = useMemo(
    () => (checked ? new Set([...staleIds, ...checked.stale]) : staleIds), [staleIds, checked]);

  const toggleReviewed = useCallback((r: ChangeRow) => {
    setReviewed((prev) => {
      const next = new Set(prev);
      const k = reviewKeyOf(r);
      if (next.has(k)) next.delete(k); else next.add(k);
      const list = [...next].slice(-REVIEW_MAX);
      write(K_REVIEW, JSON.stringify(list));
      return new Set(list);
    });
  }, []);

  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  /* Walking the list with the keyboard, over the FLAT order the eye sees rather
     than per section — a reader pressing j does not think about which section
     they are about to leave. */
  const flat = useMemo(() => groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.rows)), [groups, collapsed]);
  const step = useCallback((dir: 1 | -1) => {
    if (!flat.length) return;
    const i = flat.findIndex((r) => r.key === selected?.key);
    const next = flat[Math.max(0, Math.min(flat.length - 1, (i < 0 ? 0 : i) + dir))];
    if (next) setSelKey(next.key);
  }, [flat, selected]);

  const goNextUnread = useCallback(() => {
    const next = nextUnread(flat, selected?.key ?? null, reviewed);
    if (next) setSelKey(next.key);
  }, [flat, selected, reviewed]);
  const unread = useMemo(() => unreadCount(shown, reviewed), [shown, reviewed]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Never steal a key from something being typed into — the filter box is
      // right there, and j/k are letters.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
      else if (e.key === "n") { e.preventDefault(); goNextUnread(); }
      else if (e.key === " " && selected) { e.preventDefault(); toggleReviewed(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, step, goNextUnread, selected, toggleReviewed]);

  // Keep the selected row in view when the keyboard moved it, and only then:
  // scrolling on every render fights the mouse.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-sel="1"]')?.scrollIntoView({ block: "nearest" });
  }, [selKey]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <style>{SCROLLBAR_CSS}{SPLIT_SEL_CSS}{LINEBTN_CSS}</style>

      <div className={viewHeaderClass} style={viewHeaderStyle}>
        <h2 className="sr-only">Diff</h2>
        {/*
          * The one decision that changes what the list IS, in words and at a
          * legible size. It used to be two of eleven identical 9.5px chips.
          */}
        <Segmented value={mode} options={MODES} onChange={setMode} label="What the list shows" track />

        <span className="flex items-center gap-2.5 text-[11.5px] tabular-nums truncate" style={{ color: "var(--text2)" }}>
          {loading && !rows.length ? <span style={{ color: "var(--text3)" }}>reading git…</span> : (
            <>
              <span><b>{totals.files}</b> {totals.files === 1 ? "file" : "files"}</span>
              <span style={{ color: "var(--success-ink)" }}>+{totals.add}</span>
              <span style={{ color: "var(--error-ink)" }}>−{totals.del}</span>
              <span aria-hidden className="w-px h-3.5" style={{ background: "var(--surface-line)" }} />
              {/* An object, not only a number: how far through the list you are. */}
              <span className="inline-flex items-center gap-1.5" style={{ color: "var(--text3)" }}>
                <span role="progressbar" aria-label="Files read" aria-valuemin={0} aria-valuemax={totals.files} aria-valuenow={totals.done}
                  className="block overflow-hidden rounded-full" style={{ width: 46, height: 4, background: "var(--bg3)" }}>
                  <span className="block h-full" style={{ width: `${totals.files ? (totals.done / totals.files) * 100 : 0}%`, background: "var(--success)" }} />
                </span>
                {totals.done} read
              </span>
            </>
          )}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="shrink-0 flex flex-col min-h-0 agx-sidelist" style={{ width: sidebarW }}>
          <div className="px-2 py-2 shrink-0 flex items-center gap-1.5 relative">
            <FilterField value={q} onChange={setQ} className="min-w-0 flex-1"
              placeholder="Filter by file, folder or branch…" label="Filter the list" />
            <IconChip on={menu} onClick={() => setMenu((v) => !v)} title="List options" expanded={menu} hasPopup>
              <svg width={CHIP_ICON} height={CHIP_ICON} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <circle cx="8" cy="3.2" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="8" cy="12.8" r="1.3" />
              </svg>
            </IconChip>
            {menu && (
              <Menu
                groupBy={groupBy} onGroupBy={(g) => { setGroupBy(g); setMenu(false); }}
                showIgnored={showIgnored} onShowIgnored={() => setShowIgnored((v) => !v)} hiddenIgnored={hiddenIgnored}
                showOutside={showOutside} onShowOutside={() => setShowOutside((v) => !v)} hiddenOutside={hiddenOutside}
                onClose={() => setMenu(false)}
              />
            )}
          </div>

          <List
            ref={listRef}
            groups={groups} collapsed={collapsed} onToggleSection={toggleSection}
            selKey={selected?.key ?? null} onSelect={setSelKey}
            reviewed={reviewed} onToggleReviewed={toggleReviewed}
            groupBy={groupBy} who={who}
            empty={loading && !rows.length ? "Reading git…"
              : error ? error
              /*
               * A filter with nothing under it, and the other half of the view is
               * the likely reason.
               *
               * This page answers two different questions — what a checkout has not
               * committed, and what it committed last — and a jump from somewhere
               * else ("open orbit-1042's changes") cannot know which of them
               * the reader means. Guessing is the wrong fix twice over: it takes a
               * mode away from somebody who chose it, and it is wrong half the time
               * anyway.
               *
               * So the mode is never changed for you, and the empty case is where
               * the ambiguity gets resolved — by the reader, in one press, with the
               * filter kept. No second fetch to find out whether the other mode has
               * anything: that would be this view quietly doing double the work to
               * answer a question nobody has asked yet.
               */
              : q ? (
                <>
                  {mode === "committed" ? "Nothing committed matches that filter" : "Nothing uncommitted matches that filter"}
                  <Button className="mt-2" onClick={() => setMode(mode === "committed" ? "working" : "committed")}
                    title={`Keep the filter and look at ${mode === "committed" ? "what is uncommitted" : "the last commit"} instead`}>
                    Look in {mode === "committed" ? "Uncommitted" : "Last commit"} →
                  </Button>
                </>
              )
              : mode === "committed" ? "No commits in the checkouts in scope"
              : "Nothing uncommitted anywhere"}
            notice={notices({ truncated, failed, hiddenIgnored, hiddenOutside, showIgnored, showOutside })}
          />

          {/* Where you are in the reading, and the way to the next file you have
              not ticked: the list is walked in order with j/k, and the unread ones
              are what is left to do. */}
          <div className="shrink-0 flex items-center gap-2 px-2 py-2 text-[11px]" style={{ borderTop: LINE }}>
            <span className="flex-1 truncate" style={{ color: "var(--text3)" }}>
              {shown.length ? `${unread} unread of ${shown.length}` : ""}
            </span>
            <Button disabled={!unread} onClick={goNextUnread} title="Next file you have not marked read (n)">Next unread ↓</Button>
          </div>
        </div>

        <SidebarGrip />

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {selected
            ? <Body row={selected} state={body} mode={mode}
                split={split} onSplit={(v) => { setSplit(v); setDiffSplit(v); }}
                wrap={wrap} onWrap={(v) => { setWrap(v); setDiffWrap(v); }}
                noWs={noWs} onNoWs={(v) => { setNoWs(v); setDiffNoWhitespace(v); }}
                at={flat.length ? `${Math.max(0, flat.findIndex((r) => r.key === selected.key)) + 1} / ${flat.length}` : ""}
                onStep={step}
                comments={review.comments} staleIds={staleIds} jumpTo={jumpTo} onJumped={jumped} />
            : <Blank title="Nothing selected" icon="doc">The diff of the file you pick shows here.</Blank>}
          {root && review.comments.length > 0 && (
            <ReviewTray key={root} where={selected?.branch || root} review={review} staleIds={trayStale}
              staleFiles={checked?.files ?? null} checking={checking}
              target="a terminal in this checkout"
              outcome={sendingTo && sendingTo.root === root ? sendingTo : null}
              onShowWindow={() => requestWorktreeJump({ view: "term" })}
              onFrame={(f) => setFrame(root, f)} onJump={jump}
              onRemove={(id) => removeComment(root, id)}
              onSend={() => void sendReview()} onDiscard={() => clearReview(root)} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The lines under the list that say what is NOT in it. A list that quietly
 *  leaves things out is the failure this replaces — the old one truncated at 400
 *  rows in repo order and said nothing at all. */
function notices(o: {
  truncated: number; failed: string[];
  hiddenIgnored: number; hiddenOutside: number; showIgnored: boolean; showOutside: boolean;
}): string[] {
  const out: string[] = [];
  if (o.truncated > 0) out.push(`${o.truncated} more rows than this view will hold — narrow the filter to see them`);
  if (o.failed.length) out.push(`${o.failed.length} checkout${o.failed.length === 1 ? "" : "s"} could not be read`);
  if (!o.showIgnored && o.hiddenIgnored > 0) out.push(`${o.hiddenIgnored} ignored hidden`);
  if (!o.showOutside && o.hiddenOutside > 0) out.push(`${o.hiddenOutside} outside this project hidden`);
  return out;
}

/* ── header pieces ────────────────────────────────────────────────────────── */

/* The header's controls come from `workspace/Chrome.tsx`, which is where the
   app's one chip shape lives. The first version of this view declared its own —
   a segmented pill at 11.5px with its own border and inner padding, and a 24px
   icon button — so switching from Source control to Diff visibly changed the
   size of the controls in the same corner of the same bar. */
const MODES = [
  { id: "working" as const, label: "Uncommitted", title: "What every checkout has changed and not committed" },
  { id: "committed" as const, label: "Last commit", title: "The last piece of work committed in each checkout" },
];

const GROUPS: { id: GroupBy; label: string; hint: string }[] = [
  { id: "worktree", label: "By checkout", hint: "One section per worktree, headed by its branch" },
  { id: "time", label: "By day", hint: "One section per day — real times, at last" },
  { id: "folder", label: "By folder", hint: "One section per directory" },
];

function Menu({
  groupBy, onGroupBy, showIgnored, onShowIgnored, hiddenIgnored, showOutside, onShowOutside, hiddenOutside, onClose,
}: {
  groupBy: GroupBy; onGroupBy: (g: GroupBy) => void;
  showIgnored: boolean; onShowIgnored: () => void; hiddenIgnored: number;
  showOutside: boolean; onShowOutside: () => void; hiddenOutside: number;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useCloseWithOwner(onClose, { from: box });
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Deferred: the click that OPENED the menu is still travelling, and binding
    // synchronously closes it again in the same gesture.
    const t = setTimeout(() => document.addEventListener("mousedown", away), 0);
    document.addEventListener("keydown", esc);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [onClose]);

  return (
    <div
      ref={box} role="menu"
      className="absolute right-0 rounded-lg py-1.5 agx-menu"
      style={{ top: 40, minWidth: 240, boxShadow: "0 10px 30px rgba(0,0,0,0.38)", zIndex: 60 }}
    >
      <p className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Group</p>
      {GROUPS.map((g) => (
        <button
          key={g.id} role="menuitemradio" aria-checked={groupBy === g.id}
          onClick={() => onGroupBy(g.id)} title={g.hint}
          className="w-full text-left px-3 py-1.5 text-[11.5px] flex items-center gap-2 hover:bg-white/5"
          style={{ color: groupBy === g.id ? "var(--text)" : "var(--text2)" }}
        >
          <Tick on={groupBy === g.id} />
          {g.label}
        </button>
      ))}
      {(hiddenIgnored > 0 || showIgnored || hiddenOutside > 0 || showOutside) && (
        <>
          <div className="my-1.5 mx-3 h-px" style={{ background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
          <p className="px-3 pb-1.5 text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Also show</p>
          {(hiddenIgnored > 0 || showIgnored) && (
            <button role="menuitemcheckbox" aria-checked={showIgnored} onClick={onShowIgnored}
              className="w-full text-left px-3 py-1.5 text-[11.5px] flex items-center gap-2 hover:bg-white/5" style={{ color: "var(--text2)" }}>
              <Tick on={showIgnored} />
              Files git ignores{hiddenIgnored > 0 && <span className="ml-auto tabular-nums" style={{ color: "var(--text4)" }}>{hiddenIgnored}</span>}
            </button>
          )}
          {(hiddenOutside > 0 || showOutside) && (
            <button role="menuitemcheckbox" aria-checked={showOutside} onClick={onShowOutside}
              className="w-full text-left px-3 py-1.5 text-[11.5px] flex items-center gap-2 hover:bg-white/5" style={{ color: "var(--text2)" }}>
              <Tick on={showOutside} />
              Files outside this project{hiddenOutside > 0 && <span className="ml-auto tabular-nums" style={{ color: "var(--text4)" }}>{hiddenOutside}</span>}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0"
      style={{ opacity: on ? 1 : 0, color: "var(--primary-ink)" }}>
      <path d="M2.5 6.4l2.4 2.4L9.5 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── the list ─────────────────────────────────────────────────────────────── */

function List({
  ref, groups, collapsed, onToggleSection, selKey, onSelect, reviewed, onToggleReviewed, groupBy, who, empty, notice,
}: {
  ref: React.Ref<HTMLDivElement>;
  groups: RowGroup[];
  collapsed: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  selKey: string | null;
  onSelect: (key: string) => void;
  reviewed: ReadonlySet<string>;
  onToggleReviewed: (r: ChangeRow) => void;
  groupBy: GroupBy;
  /** Who is writing into each checkout, and the rows more than one of them edited. */
  who: ReturnType<typeof authorsIndex>;
  /** A node, not a string: when a filter comes from a jump the empty case has
   *  something to OFFER — the other mode, with the filter kept. See `emptyLine`. */
  empty: React.ReactNode;
  notice: string[];
}) {
  /* Sections render incrementally rather than all at once: nineteen checkouts of
     uncommitted work is a few thousand rows, and mounting them costs a visible
     pause on the frame where the view opens. */
  const inc = useIncremental(groups, groupBy);

  return (
    <div ref={ref} onScroll={inc.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto pb-3">
      {!groups.length && <p className="text-center py-10 text-[12px]" style={{ color: "var(--text4)" }}>{empty}</p>}
      {inc.rows.map((g) => {
        const by = sectionAuthors(who, groupBy, g.key);
        const h = by ? headingAuthors(by, g.rows.filter((r) => who.byRow.has(r.key)).length) : null;
        return (
          <section key={g.key}>
            <button
              onClick={() => onToggleSection(g.key)}
              aria-expanded={!collapsed.has(g.key)}
              className="w-full flex items-start gap-1 pl-1.5 pr-2.5 py-1.5 text-left"
              style={{ borderBottom: LINE }}
            >
              <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0 mt-1"
                style={{ color: "var(--text3)", transform: collapsed.has(g.key) ? "rotate(-90deg)" : "none", transition: "transform .12s" }}>
                <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="min-w-0 flex-1 flex flex-col gap-px">
                {/* The branch is line 1 and never shrinks (capped, so a very long one
                    still truncates); what the commit said takes the ellipsis on line 2. */}
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[12px] font-semibold truncate shrink-0 max-w-[85%]" style={{ color: "var(--text)" }}>{g.label}</span>
                  {h && (
                    <span className={h.shared ? "text-[9.5px] px-1 rounded shrink-0" : "text-[10px] truncate min-w-0"} title={h.title}
                      style={h.shared
                        ? { color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 15%, transparent)" }
                        : { color: "var(--text3)", flex: "1 1 0" }}>
                      {h.text}
                    </span>
                  )}
                </span>
                {g.sub && <span className="text-[10.5px] truncate" style={{ color: "var(--text3)" }}>{g.sub}</span>}
              </span>
              <span className="shrink-0 pt-0.5 text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>
                {g.rows.length}
                {"  "}<span style={{ color: "var(--success-ink)" }}>+{g.add}</span>
                {" "}<span style={{ color: "var(--error-ink)" }}>−{g.del}</span>
              </span>
            </button>
            {!collapsed.has(g.key) && (
              <div>
                {g.rows.map((r) => (
                  <FileRow
                    key={r.key} r={r}
                    selected={r.key === selKey}
                    reviewed={reviewed.has(reviewKeyOf(r))}
                    onSelect={() => onSelect(r.key)}
                    onToggleReviewed={() => onToggleReviewed(r)}
                    authors={who.byRow.get(r.key)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {inc.more && (
        <button onClick={inc.showAll} className="w-full py-2 text-[11px] rounded-md hover:bg-white/5" style={{ color: "var(--text3)" }}>
          Show the rest
        </button>
      )}
      {notice.map((n) => (
        <p key={n} className="px-2 pt-2 text-[10.5px]" style={{ color: "var(--text4)" }}>{n}</p>
      ))}
    </div>
  );
}

/** What happened to a file, as a colour and a letter — read before the name is.
 *  A word as well, in the row, for the three cases a diff cannot show. */
const STATUS_STYLE: Record<ChangeRow["status"], { c: string; ch: string }> = {
  added: { c: "var(--success)", ch: "A" },
  untracked: { c: "var(--success)", ch: "A" },
  modified: { c: "var(--info)", ch: "M" },
  deleted: { c: "var(--error)", ch: "D" },
  renamed: { c: "var(--warning)", ch: "R" },
  typechange: { c: "var(--warning)", ch: "T" },
};

function FileRow({ r, selected, reviewed, onSelect, onToggleReviewed, authors }: {
  r: ChangeRow; selected: boolean; reviewed: boolean; onSelect: () => void; onToggleReviewed: () => void;
  /** Set when more than one live session edited this file. */
  authors?: string[];
}) {
  const name = r.path.slice(r.path.lastIndexOf("/") + 1);
  const dir = r.path.slice(0, r.path.length - name.length).replace(/\/$/, "");
  const s = STATUS_STYLE[r.status];
  const word = statusWord(r);

  return (
    <div
      data-sel={selected ? "1" : undefined}
      role="button" tabIndex={-1}
      onClick={onSelect}
      title={r.path}
      className="w-full flex items-center gap-2 pl-3 pr-1.5 py-1.5 cursor-default"
      style={{
        minHeight: 46,
        background: selected ? "color-mix(in srgb, var(--primary) 9%, var(--bg))" : "transparent",
        boxShadow: selected ? "inset 2px 0 0 var(--primary)" : undefined,
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "color-mix(in srgb, var(--text) 4.5%, transparent)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <StatusLetter r={r} />

      {/* The name is line 1 and may wrap to a second line rather than be cut:
          two files whose names share a prefix were indistinguishable truncated.
          Folder, tags and age are line 2. */}
      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="text-[12px] font-semibold leading-[1.3]"
          style={{ color: reviewed ? "var(--text3)" : "var(--text)", overflowWrap: "anywhere", textDecoration: r.status === "deleted" ? "line-through" : undefined }}>{name}</span>
        <span className="flex items-center gap-1.5 min-w-0 text-[10.5px]" style={{ color: "var(--text3)" }}>
          <span className="truncate min-w-0" style={{ flex: "0 1 auto" }}>{dir || "(root)"}</span>
          {word && <Badge tint={s.c} wash={15} tight>{word}</Badge>}
          {r.staged !== "none" && (
            <Badge tint="var(--text3)" fill="var(--text)" tight title={r.staged === "partial" ? "Partly staged" : "Staged"}>
              {r.staged === "partial" ? "part staged" : "staged"}
            </Badge>
          )}
          {/* An agent glyph and a count, not a word: the row is narrow. The tooltip
              names them — in every grouping, since a day or a folder has no "shared"
              heading above to explain the colour. */}
          {authors && (
            <Badge tint="var(--warning-ink)" fill="var(--warning)" wash={15} tight title={rowAuthorsTitle(authors)}>
              <span aria-label={`${authors.length} authors`} className="inline-flex items-center gap-0.5"><AgentIcon size={ICON.xs} />{authors.length}</span>
            </Badge>
          )}
          {/* When it changed — the reason this rebuild exists, and shown only
              because the row no longer carries the time of the request. */}
          <span className="ml-auto shrink-0 tabular-nums">{whenLabel(r.changedAt)}</span>
        </span>
      </span>

      <span className="shrink-0 text-[10.5px] tabular-nums text-right leading-[1.35]" style={{ minWidth: 34 }}>
        {r.additions > 0 && <span className="block" style={{ color: "var(--success-ink)" }}>+{r.additions}</span>}
        {r.deletions > 0 && <span className="block" style={{ color: "var(--error-ink)" }}>−{r.deletions}</span>}
      </span>

      <button
        onClick={(e) => { e.stopPropagation(); onToggleReviewed(); }}
        title={reviewed ? "Mark as not read" : "Mark as read"}
        aria-pressed={reviewed}
        className="shrink-0 inline-flex items-center justify-center rounded-lg"
        style={{ width: HIT, height: HIT, color: reviewed ? "var(--success)" : "var(--text4)" }}
      >
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" fill={reviewed ? "currentColor" : "none"} opacity={reviewed ? 1 : 0.6} />
          {reviewed && <path d="M5 8.3l2 2 4-4.4" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </button>
    </div>
  );
}

/** A is added, M modified, D deleted, R renamed: a letter on a wash, so the
 *  kind of change is never carried by colour alone. */
function StatusLetter({ r, size = 18 }: { r: ChangeRow; size?: number }) {
  const s = STATUS_STYLE[r.status];
  return (
    <span aria-hidden title={statusWord(r) || r.status} className="shrink-0 inline-flex items-center justify-center rounded-md font-bold"
      style={{
        width: size, height: size, fontSize: size > 18 ? 11 : 10, color: s.c,
        background: `color-mix(in srgb, ${s.c} 13%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${s.c} 30%, transparent)`,
      }}>{s.ch}</span>
  );
}

/* ── the diff ─────────────────────────────────────────────────────────────── */

function Body({ row, state, mode, split, onSplit, wrap, onWrap, noWs, onNoWs, at, onStep, comments, staleIds, jumpTo, onJumped }: {
  row: ChangeRow;
  state: DiffState;
  split: boolean; onSplit: (v: boolean) => void;
  wrap: boolean; onWrap: (v: boolean) => void;
  /** Fold whitespace-only changes into context — see diffNoWhitespace.ts. */
  noWs: boolean; onNoWs: (v: boolean) => void;
  /** "3 / 12": where this file is in the list, and the buttons to walk it. */
  at: string; onStep: (dir: 1 | -1) => void;
  mode: DiffMode;
  /** The pending review for this file's checkout — every file's, filtered here. */
  comments: ReviewComment[];
  staleIds: ReadonlySet<string>;
  /** A comment the tray asked to be shown; scrolled to once its line is drawn. */
  jumpTo: { c: ReviewComment; root: string } | null;
  onJumped: () => void;
}) {
  const { hilite, themePref, setThemePref, bold, setBold, hiliteError } = useDiffHighlight(row.path);
  const [copied, setCopied] = useState(false);
  const raw = state.diff?.hunks ?? [];
  /* A hunk that held nothing but whitespace is dropped rather than drawn empty; when
     that leaves none at all, the file says so below instead of rendering as blank. */
  const hunks = useMemo(() => (noWs ? raw.map(hunkWithoutWhitespace).filter(hunkChanges) : raw), [noWs, raw]);
  const allWs = noWs && raw.length > 0 && hunks.length === 0;

  /*
   * Commenting. A "+" on a line opens the box under it; shift-click stretches it
   * to a range, as the pull request's does. The snippet is cut from the RAW
   * hunks, not the whitespace-folded ones on screen: folding changes a line's
   * prefix, and a comment written with Ignore space on would otherwise read as
   * stale the moment it was turned off. The line numbers are the same in both.
   */
  /* The snippet is taken when the line is PICKED, not when the comment is saved:
     the diff re-reads every time an agent writes the file, and a box open for a
     minute would otherwise quote whatever the agent put on that line meanwhile —
     code you never clicked, and never shown stale because it IS the current code.
     The text being typed lives here too, not in the box: an edit above the line
     can remount the box, and a remount must not eat the comment.
     Ranges are one side's: in unified view a removed line is the old side and
     everything else the new, so shift-click from one to the other starts over. */
  type Draft = { side: "LEFT" | "RIGHT"; start: number; end: number; snippet: string[] };
  const [composing, setComposing] = useState<Draft | null>(null);
  const typed = useRef("");
  const ready = state.for === diffStateKey(row, mode) && !state.loading;
  useEffect(() => { setComposing(null); }, [row.key, mode]);
  const startDraft = (side: Draft["side"], start: number, end: number, fresh: boolean) => {
    if (fresh) typed.current = "";
    setComposing({ side, start, end, snippet: captureSnippet(raw, side, start, end) });
  };
  const onPick = (p: LinePick) => {
    if (!ready) return;
    if (p.shift && composing && composing.side === p.side) startDraft(p.side, composing.start, p.line, false);
    else startDraft(p.side, p.line, p.line, true);
  };
  const sel: LineSel = composing ? { start: composing.start, end: composing.end, side: composing.side } : null;
  const save = (body: string) => {
    if (!composing) return;
    const lo = Math.min(composing.start, composing.end), hi = Math.max(composing.start, composing.end);
    addComment(row.repoRoot, { path: row.path, side: composing.side, start: lo, end: hi, body, mode, snippet: composing.snippet });
    typed.current = "";
    setComposing(null);
  };

  /* Under the LAST line a comment covers, keyed by side: a new-side number and
     an old-side number are each unique within a file, so one lookup per row. */
  const here = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      if (c.path !== row.path || c.mode !== mode) continue;
      const k = `${c.side === "RIGHT" ? "R" : "L"}${c.end}`;
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [comments, row.path, mode]);
  const rowAfter = (here.size || composing) ? (newN: number | null | undefined, oldN: number | null | undefined) => {
    const keys = [newN != null ? `R${newN}` : null, oldN != null ? `L${oldN}` : null];
    const cards = keys.flatMap((k) => (k ? here.get(k) ?? [] : []));
    const box = composing && keys.includes(`${composing.side === "RIGHT" ? "R" : "L"}${Math.max(composing.start, composing.end)}`);
    if (!cards.length && !box) return null;
    return (
      <>
        {cards.map((c) => (
          <CommentCard key={c.id} c={c} stale={staleIds.has(c.id)}
            onEdit={(b) => editComment(row.repoRoot, c.id, b)} onRemove={() => removeComment(row.repoRoot, c.id)} />
        ))}
        {box && composing && (
          <CommentBox label={anchorLabel({ path: row.path, mode, ...composing })} initial={typed.current}
            onText={(t) => { typed.current = t; }} onSave={save} onCancel={() => setComposing(null)} />
        )}
      </>
    );
  } : undefined;

  /* A remark about a whole hunk, not one line of it: the hunk's range on the new
     side, or on the old side when it only removed. Unified view only, and that is
     a limit, not a reason: SplitDiff takes no `hunkAction`, and with Split AND
     Wrap on its grid draws no "+" either (the pull request's split has the same
     gap) — there, a comment means turning one of the two off. Both are the shared
     renderer's to grow, which the pull request panel draws too. */
  const hunkAction = (hi: number) => {
    const h = hunks[hi];
    if (!h) return null;
    const side = h.newLines > 0 ? "RIGHT" : "LEFT";
    const start = side === "RIGHT" ? h.newStart : h.oldStart;
    const end = start + (side === "RIGHT" ? h.newLines : h.oldLines) - 1;
    return (
      <button onClick={() => { if (ready) startDraft(side, start, end, true); }} className="agx-btn rounded px-1.5 text-[10.5px]"
        title="Comment on this whole hunk" style={{ color: "var(--text3)", fontFamily: "var(--font-sans, inherit)" }}>
        Comment
      </button>
    );
  };

  const scroller = useRef<HTMLDivElement>(null);
  /* Served only once the diff on screen is the target's own — same checkout,
     file and half, finished loading. Split view draws an invisible twin of each
     card in the left column to keep the rows aligned; the visible one is the one
     to scroll to. */
  useEffect(() => {
    if (!jumpTo || !ready || jumpTo.root !== row.repoRoot || jumpTo.c.path !== row.path || jumpTo.c.mode !== mode) return;
    const c = jumpTo.c;
    const visible = (sel: string) => [...(scroller.current?.querySelectorAll<HTMLElement>(sel) ?? [])]
      .find((e) => !e.closest('[aria-hidden="true"]'));
    (visible(`[data-review-comment="${c.id}"]`) ?? visible(`[data-ln="${c.side === "RIGHT" ? "R" : "L"}${c.start}"]`))
      ?.scrollIntoView({ block: "center" });
    onJumped();
  }, [jumpTo, ready, row.repoRoot, row.path, mode, onJumped]);

  /**
   * Open it in the viewer, the way the pull request does.
   *
   * It used to go to whatever nvim happened to be running — and on a machine
   * with none, it copied a command to the clipboard and called that an answer.
   * One verb, one behaviour: the modal with an editor in it, at the first
   * changed line, with the rest of them down its right.
   */
  const groups = useMemo(() => groupHunks(hunks), [hunks]);
  const openFile = () => {
    openPeek({
      root: row.repoRoot,
      path: `${row.repoRoot}/${row.path}`,
      label: row.path,
      // This is the working tree: his checkout, his branch, opened from a diff
      // of his own changes. The pull request's copy is the read-only case.
      edit: true,
      branch: row.branch || undefined,
      line: groups[0]?.from ?? 1,
      groups,
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${row.repoRoot}/${row.path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* a clipboard that refuses is not worth an error state here */ }
  };

  return (
    <>
      {/* The six diff controls live here, once, shared with the commit modal; the list's
          own controls (filter, grouping) live with the list. */}
      <div className="shrink-0 flex items-center gap-1.5 px-3" style={{ height: 44, borderBottom: LINE }}>
        <DiffToolbar split={split} onSplit={onSplit} wrap={wrap} onWrap={onWrap} noWs={noWs} onNoWs={onNoWs}
          bold={bold} onBold={setBold} themePref={themePref} onTheme={setThemePref} themeError={hiliteError} />
        <span className="flex-1" />
        <span className="text-[11px] tabular-nums" style={{ color: "var(--text3)" }}>{at}</span>
        <Button square tone="quiet" label="Previous file (k)" title="Previous file (k)" onClick={() => onStep(-1)}>
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden><path d="M2.5 7.5L6 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </Button>
        <Button square tone="quiet" label="Next file (j)" title="Next file (j)" onClick={() => onStep(1)}>
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden><path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </Button>
      </div>

      <div className="flex items-center gap-2.5 px-3.5 py-2.5 shrink-0" style={{ borderBottom: LINE, background: "var(--surface-card)" }}>
        <StatusLetter r={row} size={22} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold" style={{ color: "var(--text)" }}>
            <span style={{ overflowWrap: "anywhere" }}>{row.path.slice(row.path.lastIndexOf("/") + 1)}</span>
            {statusWord(row) && <Badge tint={STATUS_STYLE[row.status].c} wash={15} tight>{statusWord(row)}</Badge>}
            {row.branch && <Badge tint="var(--text3)" tight>{row.branch}</Badge>}
          </p>
          <p className="mt-0.5 text-[11px] truncate" style={{ color: "var(--text3)" }} title={`${row.repoRoot}/${row.path}`}>
            {row.path}
            {row.oldPath && <> · renamed from {row.oldPath}</>}
            {row.commit && <> · {row.commit.subject}</>}
            {" · "}{whenLabel(row.changedAt)}
          </p>
        </div>
        {/* Open it where the change is.
            Source control has had this on `e` for a while and the pull request
            has it as a button; this view had neither.
            The line is the first hunk's, not line 1: opening a 900-line file
            you came to BECAUSE of a diff and landing at the top means scrolling
            back to where you already were. */}
        <Button onClick={openFile} disabled={row.status === "deleted"} title="Open it here, at its first change">
          <IconLabel icon={<FileIcon size={ICON.xs} />}>Open</IconLabel>
        </Button>
        <Button onClick={copy} tint={copied ? "var(--success)" : undefined} title="Copy the full path">{copied ? "Copied" : "Copy path"}</Button>
      </div>

      <div ref={scroller} className="agx-scroll flex-1 min-h-0 overflow-auto">
        {state.loading && !state.diff && <Blank title="Reading the diff…" icon="doc" />}
        {/* Every one of these was a blank pane reading "0 hunks" before. A file
            the view cannot show is a thing to SAY, not an empty box. */}
        {!state.loading && state.error && <Blank tone="error" title="This file could not be read" icon="info">{state.error}</Blank>}
        {state.diff?.binary && <Blank title={`Binary file, ${binaryWord(row.status)}`} icon="img">Git cannot show lines for {row.path.slice(row.path.lastIndexOf("/") + 1)}.</Blank>}
        {!state.diff?.binary && !state.error && !hunks.length && !state.loading && (
          /* "No textual change" would be a lie here: there IS one, and it is being
             ignored on purpose. A file that empties because of a toggle has to name
             the toggle, or the reader goes looking for what went wrong. */
          allWs ? (
            <Blank title="Only whitespace changed" icon="info">
              Nothing to show with Ignore space on.
              <Button className="mt-1" onClick={() => onNoWs(false)}>Show the whitespace changes</Button>
            </Blank>
          ) : row.status === "renamed" ? (
            <Blank title="Renamed, contents did not change" icon="doc">{row.oldPath ?? "somewhere"} → {row.path}</Blank>
          ) : row.tooBig ? <Blank title="Too large to diff" icon="doc">Open the file to read it.</Blank>
          : <Blank title="No textual change" icon="doc">Mode or timestamps only.</Blank>
        )}
        {hunks.length > 0 && (
          <HiliteCtx.Provider value={hilite}>
            {split
              ? <SplitDiff hunks={hunks} wrap={wrap} onPick={onPick} sel={sel} rowAfter={rowAfter} />
              : <UnifiedDiff hunks={hunks} wrap={wrap} onPick={onPick} sel={sel} rowAfter={rowAfter} hunkAction={hunkAction} />}
          </HiliteCtx.Provider>
        )}
        {state.diff?.truncated && (
          <p className="px-4 py-3 text-[11px]" style={{ color: "var(--warning-ink)" }}>
            This diff was cut off — the file changed more than this view will render at once.
          </p>
        )}
      </div>
    </>
  );
}

function Blank({ title, icon, tone, children }: { title: string; icon: "doc" | "info" | "img"; tone?: "error"; children?: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="max-w-[440px] flex flex-col items-center gap-2.5 text-center text-[12px]" style={{ color: tone === "error" ? "var(--error)" : "var(--text3)" }}>
        <span aria-hidden className="flex items-center justify-center rounded-xl"
          style={{ width: 46, height: 46, background: "var(--surface-inset)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}>
          <svg width={22} height={22} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            {icon === "doc" && <path d="M4 1.5h5l3.5 3.5v9H4ZM9 1.5V5h3.5" />}
            {icon === "info" && <><circle cx="8" cy="8" r="6" /><path d="M8 7.5V11M8 5v.2" /></>}
            {icon === "img" && <><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="7" r="1.2" /><path d="M2.5 12l4-3.5 3 2.5 2-1.5 2 2" /></>}
          </svg>
        </span>
        <b className="text-[13px]" style={{ color: tone === "error" ? "var(--error)" : "var(--text)" }}>{title}</b>
        {children && <span className="flex flex-col items-center gap-1.5">{children}</span>}
      </div>
    </div>
  );
}
