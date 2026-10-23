/*
 * The Jira card's Activity, inside the card: Jira's own tabs (All, Comments,
 * History, Work log) and its newest-first switch, under the sections and above
 * the composer that stays at the foot of the pane.
 *
 * What each tab costs. Comments and Work log are drawn from the card read
 * (the work log's first 20 entries are a field on it). History is one request
 * the first time History or All is opened, and one more for each 100 earlier
 * entries when asked, never on opening a card. Comments the card read left out
 * and the work log past its first 20 are a request each, when asked.
 *
 * Every state is drawn: reading, failed with a way to try again, empty, and a
 * history that is longer than the site would give.
 *
 * Comments: threads one level deep (Cloud), a reply box at the pane's foot that
 * says whom it answers, your own comment changed in place or deleted after one
 * sentence that says it cannot come back, an "edited" marker and a marker on a
 * comment restricted to a role.
 *
 * Ceiling: the rows are Jira's words as Jira wrote them. A changed comment is
 * sent as Markdown with the people it named, so what Markdown cannot say (a
 * panel, a table cell merge) is flattened the way the card's description would
 * be. The All tab draws a reply in time order with the name it answers, not
 * nested.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { fmtAgo } from "../../lib/format.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { ACTIVITY_TABS, allRows, eventsFor, needsHistory, type ActivityTab } from "../../lib/jiraActivityRows.ts";
import { answeredBy, threadsOf } from "../../lib/jiraThreads.ts";
import type { CardEvent, TaskDetail } from "../../../../shared/providers.ts";
import { EventRun } from "../CardEventRun.tsx";
import { CardTabs } from "../CardChrome.tsx";
import { CommentAction } from "../tasks/CardEdit.tsx";
import { Spinner } from "../Spinner.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import { Section } from "./JiraSections.tsx";
import { Author } from "./Author.tsx";
import { WorklogPanel } from "./JiraWorklog.tsx";
import type { JiraWorkUi } from "./useJiraWork.ts";

type Comment = TaskDetail["comments"][number];

/*
 * The conversation's geometry (the pull request's, TL_CSS in Chrome.tsx), at the
 * size of a side pane: a 28px face where the shared one is 40, and a rail that
 * runs closer to the edge. Scoped under its own class so it neither depends on
 * a view that mounts the shared sheet nor changes it. A small event keeps its
 * date on a line of its own: beside the sentence it left the sentence a few
 * words wide.
 */
const FACE = 28, GAP = 8, RAIL = 12, SPACE = 12, INDENT = RAIL * 2 + 4;
const JTL_CSS = `
.agx-jtl{position:relative;padding-left:${FACE + GAP}px}
.agx-jtl::before{content:"";position:absolute;left:${FACE + GAP + RAIL - 1}px;top:0;bottom:0;width:2px;background:var(--surface-line)}
.agx-jtl.agx-jtl-flat{padding-left:0}
.agx-jtl.agx-jtl-flat::before{left:${RAIL - 1}px}
.agx-jtl .agx-ev{position:relative;margin-bottom:${SPACE}px}
.agx-jtl .agx-ev:last-child{margin-bottom:0}
.agx-jtl .agx-av{position:absolute;left:-${FACE + GAP}px;top:0;display:flex}
.agx-jtl .agx-card{position:relative;background:var(--surface-card)}
.agx-jtl .agx-node{position:absolute;left:${RAIL - 10}px;top:3px;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:9px;background:var(--bg);border:2px solid var(--surface-line);z-index:1}
.agx-jtl .agx-tiny{position:relative;display:flex;flex-wrap:wrap;align-items:flex-start;column-gap:7px;font-size:10.5px;color:var(--text3);padding:4px 0 4px ${INDENT}px;min-height:26px}
.agx-jtl .agx-tiny>span:last-child{flex:0 0 100%;font-size:9.5px}
.agx-jtl .agx-tiny b{color:var(--text2);font-weight:500}
`;
const NEWEST_KEY = "agx.jira.activityNewestFirst";

const readNewest = (): boolean => { try { return localStorage.getItem(NEWEST_KEY) === "1"; } catch { return false; } };
const writeNewest = (on: boolean): void => { try { localStorage.setItem(NEWEST_KEY, on ? "1" : "0"); } catch { /* the choice lasts as long as the page */ } };

/**
 * What a person can do to the comments, handed down by the card while writing to
 * Jira is on and the site described the card; absent, the comments are only read.
 * `edit` and `remove` answer with the sentence that says why they did not land,
 * or null when they did.
 */
export interface CommentAct {
  /** Replies are threaded here (Cloud); on Data Center there is no reply control. */
  reply: boolean;
  /** The comment the box at the foot is answering, if any. */
  replyingTo: string | null;
  onReply: (c: Comment | null) => void;
  edit: (c: Comment, text: string) => Promise<string | null>;
  remove: (c: Comment) => Promise<string | null>;
}

const LOCK = "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z";

/** One comment's card: who and when (edited, restricted), its words or the box they are changed in, and what can be done to it. */
function CommentCard({ c, act, root, answers }: { c: Comment; act?: CommentAct; root: Comment; answers?: string }) {
  const [mode, setMode] = useState<"read" | "edit" | "delete">("read");
  const [draft, setDraft] = useState(c.text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (mode === "read") setDraft(c.text); }, [c.text, mode]);
  const gone = useRef(false);
  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);

  const save = async () => {
    if (!act || busy) return;
    if (!draft.trim()) { setErr("A comment cannot be empty: delete it instead"); return; }
    if (draft.trim() === c.text.trim()) { setMode("read"); return; }
    setBusy(true); setErr("");
    const why = await act.edit(c, draft);
    if (gone.current) return;
    setBusy(false);
    if (why) setErr(why); else setMode("read");
  };
  const drop = async () => {
    if (!act || busy) return;
    setBusy(true); setErr("");
    const why = await act.remove(c);
    if (gone.current) return;
    setBusy(false);
    if (why) setErr(why);
  };

  return (
    <div className="agx-card rounded-lg px-3 py-2 min-w-0" style={{ border: EDGE }}>
      <div className="text-[10.5px] mb-1 flex items-center gap-x-1 flex-wrap">
        <span className="font-semibold" style={{ color: "var(--text2)" }}>{c.who}</span>
        {c.at > 0 && <span style={{ color: "var(--text4)" }} title={new Date(c.at).toLocaleString()}>{" · "}{fmtAgo(c.at)} ago</span>}
        {c.edited && <span style={{ color: "var(--text4)" }} title="Changed after it was written">{" · "}edited</span>}
        {answers && <span style={{ color: "var(--text4)" }}>{" · "}replying to {answers}</span>}
        {c.restricted && (
          <span className="inline-flex items-center gap-1 rounded px-1" style={{ color: "var(--warning-ink)", border: EDGE }} title={`Only ${c.restricted} can see this comment`}>
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={LOCK} /></svg>
            Restricted to {c.restricted}
          </span>
        )}
      </div>
      {mode === "edit" ? (
        <div className="flex flex-col gap-1.5">
          <textarea value={draft} autoFocus rows={4} disabled={busy} aria-label="Change this comment"
            onChange={(e) => { setDraft(e.target.value); setErr(""); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
              // Escape closes the box and nothing else: it must not reach the pane behind it.
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMode("read"); setErr(""); }
            }}
            className="w-full text-[11.5px] rounded px-2 py-1.5 outline-none resize-y"
            style={{ background: "var(--bg)", color: "var(--text)", border: EDGE, minHeight: 64 }} />
          <div className="flex items-center gap-2 text-[10.5px]">
            <button className="agx-btn rounded-md px-2 py-0.5" disabled={busy} onClick={() => void save()} style={{ color: "var(--text)", border: EDGE }}>{busy ? "Saving…" : "Save"}</button>
            <button className="agx-btn rounded-md px-2 py-0.5" disabled={busy} onClick={() => { setMode("read"); setErr(""); }} style={{ color: "var(--text3)" }}>Cancel</button>
            <span style={{ color: "var(--text4)" }}>Markdown · Ctrl+Enter saves</span>
          </div>
        </div>
      ) : (
        <div className="agx-cu-body agx-cu-note min-w-0 break-words"><Markdown text={c.text} /></div>
      )}
      {err && <div className="text-[10.5px] mt-1" role="alert" style={{ color: "var(--error-ink)" }}>{err}</div>}
      {act && mode === "read" && (
        <div className="flex items-center gap-1 mt-1.5">
          {act.reply && (
            <CommentAction iconOnly label="Reply" title={`Answer ${root.who} in this thread`} d="M9 14l-5-5 5-5M4 9h9a7 7 0 0 1 7 7v4"
              on={act.replyingTo === root.id} tone="var(--primary)" onClick={() => act.onReply(act.replyingTo === root.id ? null : root)} />
          )}
          {c.mine && (
            <>
              <CommentAction iconOnly label="Edit" title="Change this comment" d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z" onClick={() => { setDraft(c.text); setMode("edit"); }} />
              <span aria-hidden className="mx-0.5" style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--text) 12%, transparent)" }} />
              <CommentAction iconOnly label="Delete" title="Delete this comment" tone="var(--error)" d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" onClick={() => setMode("delete")} />
            </>
          )}
        </div>
      )}
      {/* Asked in place, and said in full: nothing in Jira brings a deleted comment back. */}
      {act && mode === "delete" && (
        <div className="flex items-center gap-2 mt-1.5 text-[10.5px] flex-wrap" role="alertdialog" aria-label="Delete this comment?">
          <span style={{ color: "var(--text2)" }}>Delete this comment for good? Jira cannot bring it back.</span>
          <button className="agx-btn rounded-md px-2 py-0.5" disabled={busy} onClick={() => void drop()} style={{ color: "var(--error-ink)", border: EDGE }}>{busy ? "Deleting…" : "Delete"}</button>
          <button className="agx-btn rounded-md px-2 py-0.5" disabled={busy} onClick={() => { setMode("read"); setErr(""); }} style={{ color: "var(--text3)" }}>Keep it</button>
        </div>
      )}
    </div>
  );
}

function CommentRow({ c, act, answers }: { c: Comment; act?: CommentAct; answers?: string }) {
  return (
    <div className="agx-ev">
      <span className="agx-av"><Author who={c.who} initials={c.initials} avatar={c.avatar} size={FACE} /></span>
      <CommentCard c={c} act={act} root={c} answers={answers} />
    </div>
  );
}

/** A comment and the answers under it, one level deep as Jira draws them. */
function ThreadRow({ root, replies, orphan, act }: { root: Comment; replies: Comment[]; orphan: boolean; act?: CommentAct }) {
  return (
    <div className="agx-ev">
      <span className="agx-av"><Author who={root.who} initials={root.initials} avatar={root.avatar} size={FACE} /></span>
      <CommentCard c={root} act={act} root={root} answers={orphan ? "a comment that is not shown" : undefined} />
      {replies.length > 0 && (
        <div className="mt-2 ml-2 pl-3 flex flex-col gap-2" style={{ borderLeft: "2px solid var(--surface-line)" }} aria-label={`Answers to ${root.who}`}>
          {replies.map((r) => (
            <div key={r.id} className="flex items-start gap-2 min-w-0">
              <span className="mt-0.5 shrink-0"><Author who={r.who} initials={r.initials} avatar={r.avatar} size={20} /></span>
              <div className="min-w-0 flex-1"><CommentCard c={r} act={act} root={root} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type History = { phase: "idle" | "loading" | "ok" | "error"; events: CardEvent[]; next?: number; total: number; error: string };
const NO_HISTORY: History = { phase: "idle", events: [], total: 0, error: "" };

const EMPTY: Record<ActivityTab, string> = {
  all: "Nothing has happened on this card yet.", comments: "No comments yet.", history: "No changes yet.", worklog: "No time has been logged.",
};

const MORE_BTN = "agx-btn text-[10.5px] px-2.5 py-1 rounded-lg";

export function JiraActivity({ cardKey, comments, moreComments, onMoreComments, worklog, worklogMore, act, tracking, work }: {
  cardKey: string;
  /** What can be done to the comments; absent where they are only read. */
  act?: CommentAct;
  comments: Comment[];
  /** Comments the card read left out. */
  moreComments: number;
  /** The comments of one more page, and how many are still left after it. */
  onMoreComments: (page: Comment[], left: number) => void;
  /** The work log's first entries, from the card read. */
  worklog: CardEvent[];
  worklogMore: number;
  /** The card's time tracking, when the site has it on for the card; absent, the work log is only a list. */
  tracking?: TaskDetail["tracking"];
  /** What can be done to the work log; absent where it is only read. */
  work?: JiraWorkUi;
}) {
  const [tab, setTab] = useState<ActivityTab>("comments");
  const [newest, setNewest] = useState(readNewest);
  const [history, setHistory] = useState<History>(NO_HISTORY);
  const [extraLog, setExtraLog] = useState<{ events: CardEvent[]; left: number | null; busy: boolean; error: string }>({ events: [], left: null, busy: false, error: "" });
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const keyRef = useRef(cardKey);
  keyRef.current = cardKey;

  // A different card starts over: its own tab, its own history, nothing of the last one's.
  useEffect(() => {
    setTab("comments"); setHistory(NO_HISTORY); setExtraLog({ events: [], left: null, busy: false, error: "" });
    setMoreBusy(false); setMoreError(""); setOpenRuns(new Set());
  }, [cardKey]);

  // A write to the work log returns the card with its first entries again: the pages read in before it describe a log that has changed.
  const logEpoch = work?.epoch ?? 0;
  useEffect(() => { setExtraLog({ events: [], left: null, busy: false, error: "" }); }, [logEpoch]);

  const loadHistory = useCallback(async (startAt: number) => {
    const forKey = cardKey;
    setHistory((h) => ({ ...h, phase: "loading", error: "" }));
    const r = await api.jiraActivity(forKey, "history", startAt).catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraActivity>>));
    if (forKey !== keyRef.current) return; // another card was picked meanwhile
    if (!r.ok) { setHistory((h) => ({ ...h, phase: "error", error: r.error || "Jira did not answer" })); return; }
    setHistory((h) => ({ phase: "ok", events: [...h.events, ...(r.events ?? [])], next: r.next, total: r.total ?? 0, error: "" }));
  }, [cardKey]);

  // History is asked for when a tab that draws it is opened, once per card, and never otherwise.
  useEffect(() => {
    if (needsHistory(tab) && history.phase === "idle") void loadHistory(0);
  }, [tab, history.phase, loadHistory]);

  const loadMoreComments = async () => {
    const forKey = cardKey;
    setMoreBusy(true); setMoreError("");
    const r = await api.jiraActivity(forKey, "comments", comments.length).catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraActivity>>));
    if (forKey !== keyRef.current) return;
    setMoreBusy(false);
    if (!r.ok || !r.comments) { setMoreError(r.error || "Jira did not answer"); return; }
    onMoreComments(r.comments, Math.max(0, (r.total ?? 0) - comments.length - r.comments.length));
  };

  const loadMoreLog = async () => {
    const forKey = cardKey;
    setExtraLog((x) => ({ ...x, busy: true, error: "" }));
    const r = await api.jiraActivity(forKey, "worklog", worklog.length + extraLog.events.length).catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraActivity>>));
    if (forKey !== keyRef.current) return;
    if (!r.ok) { setExtraLog((x) => ({ ...x, busy: false, error: r.error || "Jira did not answer" })); return; }
    setExtraLog((x) => ({ events: [...x.events, ...(r.events ?? [])], left: r.next === undefined ? 0 : Math.max(0, (r.total ?? 0) - worklog.length - x.events.length - (r.events ?? []).length), busy: false, error: "" }));
  };

  const logEvents = [...worklog, ...extraLog.events];
  const logLeft = extraLog.left ?? worklogMore;
  const runToggle = (id: string) => setOpenRuns((set) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const flip = () => { setNewest((n) => { writeNewest(!n); return !n; }); };

  const moreCommentsBar = moreComments > 0 && (
    <div className="mt-1 mb-2 flex items-center gap-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
      <button onClick={() => void loadMoreComments()} disabled={moreBusy} className={MORE_BTN} style={{ border: EDGE, color: "var(--text2)" }}>
        {moreBusy ? "Reading…" : `Show ${moreComments} more ${moreComments === 1 ? "comment" : "comments"}`}
      </button>
      {moreError && <span role="alert" style={{ color: "var(--error-ink)" }}>{moreError}</span>}
    </div>
  );

  const historyBar = (
    <>
      {history.phase === "loading" && <Spinner label="Reading the history…" className="" />}
      {history.phase === "error" && (
        <div className="text-[10.5px] my-2 flex items-center gap-2" role="alert" style={{ color: "var(--error-ink)" }}>
          <span>{history.error}</span>
          <button onClick={() => void loadHistory(history.events.length ? history.next ?? 0 : 0)} className={MORE_BTN} style={{ border: EDGE, color: "var(--text2)" }}>Try again</button>
        </div>
      )}
      {history.phase === "ok" && history.next !== undefined && (
        <button onClick={() => void loadHistory(history.next!)} className={`${MORE_BTN} my-2`} style={{ border: EDGE, color: "var(--text2)" }}>
          Show {Math.min(100, Math.max(0, history.total - history.events.length))} earlier changes
        </button>
      )}
      {history.phase === "ok" && history.next === undefined && history.total > history.events.length && (
        <div className="text-[10.5px] my-2" style={{ color: "var(--text3)" }}>
          Showing {history.events.length} of {history.total} changes: this Jira gives no more of the history here.
        </div>
      )}
    </>
  );

  const logBar = logLeft > 0 && (
    <div className="my-2 flex items-center gap-2 text-[10.5px]">
      <button onClick={() => void loadMoreLog()} disabled={extraLog.busy} className={MORE_BTN} style={{ border: EDGE, color: "var(--text2)" }}>
        {extraLog.busy ? "Reading…" : `Show ${logLeft} more ${logLeft === 1 ? "entry" : "entries"}`}
      </button>
      {extraLog.error && <span role="alert" style={{ color: "var(--error-ink)" }}>{extraLog.error}</span>}
    </div>
  );

  const total = comments.length + moreComments;
  const tabs = ACTIVITY_TABS.map((t) => ({
    id: t.id, label: t.label,
    ...(t.id === "comments" && total ? { count: total } : t.id === "worklog" && logEvents.length + logLeft ? { count: logEvents.length + logLeft } : {}),
  }));

  let body: React.ReactNode;
  if (tab === "comments") {
    const rows = threadsOf(comments, newest);
    body = (
      <>
        {newest && moreCommentsBar}
        {!rows.length && !moreComments && <div className="text-[11px]" style={{ color: "var(--text4)" }}>{EMPTY.comments}</div>}
        <div className="agx-jtl">{rows.map((t) => <ThreadRow key={t.root.id} root={t.root} replies={t.replies} orphan={t.orphan} act={act} />)}</div>
        {!newest && moreCommentsBar}
      </>
    );
  } else if (tab === "history" || tab === "worklog") {
    const events = eventsFor(tab, history.events, logEvents);
    const shown = newest ? [...events].reverse() : events;
    const empty = tab === "history" ? history.phase === "ok" && !events.length : !events.length && !logLeft;
    body = (
      <>
        {tab === "history" && newest && historyBar}
        {tab === "worklog" && newest && logBar}
        {empty && <div className="text-[11px]" style={{ color: "var(--text4)" }}>{EMPTY[tab]}</div>}
        {tab === "worklog"
          ? (!!shown.length || tracking) && <WorklogPanel events={events} tracking={tracking} work={work} newest={newest} />
          : !!shown.length && <div className="agx-jtl agx-jtl-flat"><EventRun events={shown} flat open onToggle={() => undefined} /></div>}
        {tab === "history" && !newest && historyBar}
        {tab === "worklog" && !newest && logBar}
      </>
    );
  } else {
    const rows = allRows(comments, history.events, logEvents, newest);
    const answered = answeredBy(comments);
    body = (
      <>
        {newest && moreCommentsBar}
        {newest && historyBar}
        {history.phase === "ok" && !rows.length && !moreComments && <div className="text-[11px]" style={{ color: "var(--text4)" }}>{EMPTY.all}</div>}
        <div className="agx-jtl">
          {rows.map((row) => row.kind === "events"
            ? <EventRun key={row.id} events={row.events} open={openRuns.has(row.id)} onToggle={() => runToggle(row.id)} />
            : <CommentRow key={row.comment.id} c={row.comment} act={act} answers={answered.get(row.comment.id)} />)}
        </div>
        {!newest && historyBar}
        {!newest && moreCommentsBar}
      </>
    );
  }

  return (
    <Section id="activity" title="Activity">
      <style>{JTL_CSS}</style>
      {/* The strip stays under the pane's top while the thread scrolls under it. */}
      <div className="sticky top-0 z-[2] -mx-4 px-4 pb-1.5 mb-2" style={{ background: "var(--bg)" }}>
        <CardTabs tabs={tabs} active={tab} onPick={setTab} />
        <div className="flex justify-end mt-1">
          <button onClick={flip} aria-pressed={newest} title="Switch between oldest and newest first"
            className="agx-btn shrink-0 text-[10px] px-2 py-0.5 rounded-md" style={{ border: EDGE, color: "var(--text3)" }}>
            {newest ? "Newest first" : "Oldest first"}
          </button>
        </div>
      </div>
      {body}
    </Section>
  );
}
