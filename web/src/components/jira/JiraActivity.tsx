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
 * sentence that says it cannot come back, the exact date and "(edited <date>)"
 * with who changed it on hover, a marker on a comment restricted to a role, the
 * people it mentions as chips, and a copy link to the comment in Jira. A change
 * is made in the same composer as a new comment, so `@` picks people there too.
 * No reactions: Jira's public REST has none to read or write.
 *
 * Ceiling: the rows are Jira's words as Jira wrote them. A changed comment is
 * sent as Markdown with the people it named, so what Markdown cannot say (a
 * panel, a table cell merge) is flattened the way the card's description would
 * be. The All tab draws a reply in time order with the name it answers, not
 * nested.
 */
import { tipAttr } from "../../lib/tip.ts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { fmtAgo } from "../../lib/format.ts";
import { Markdown, MarkdownMentions, type MentionChips } from "../../lib/markdown.tsx";
import { commentLink, editedLabel, editedTip, exactDate } from "../../lib/jiraCommentView.ts";
import { initialsOf } from "../../lib/avatarColour.ts";
import type { Mentionable } from "../../lib/mentions.ts";
import { Composer } from "../tasks/Composer.tsx";
import { ACTIVITY_TABS, allRows, eventsFor, needsHistory, type ActivityTab } from "../../lib/jiraActivityRows.ts";
import { answeredBy, threadsOf } from "../../lib/jiraThreads.ts";
import { reducedMotion } from "../../lib/lookPrefs.ts";
import type { CardEvent, TaskDetail } from "../../../../shared/providers.ts";
import { EventRun } from "../CardEventRun.tsx";
import { CommentAction } from "../tasks/CardEdit.tsx";
import { Spinner } from "../Spinner.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, EDGE, Segmented } from "../workspace/Chrome.tsx";
import { JiraSection } from "./JiraSections.tsx";
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
.agx-jtl .agx-tiny{position:relative;display:flex;flex-wrap:wrap;align-items:flex-start;column-gap:6px;font-size:10.5px;color:var(--text3);padding:4px 0 4px ${INDENT}px;min-height:26px}
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
  /** The people `@` offers while a comment is changed, from the card's own search; absent, `@` is only a character. */
  people?: (Mentionable & { initials?: string; avatar?: string })[] | null;
  onPeopleQuery?: (q: string) => void;
  remove: (c: Comment) => Promise<string | null>;
}

/** The ids of the comments to mark "new" (written by somebody else since the card was last looked at). */
const FreshCtx = createContext<ReadonlySet<string>>(new Set());
const commentAnchor = (id: string): string => `jc-${id}`;
/** The card's key and Jira address, for the link to one comment. */
const CardCtx = createContext<{ key: string; url?: string }>({ key: "" });
const LINK_SHOWN_MS = 2000;

/** A person a comment names, drawn as Jira draws one: a pill with their initials. */
export const chip = (name: string, key: string) => (
  <span key={key} className="inline-flex items-center gap-1 rounded-full align-baseline whitespace-nowrap" data-testid="jira-mention"
    style={{ padding: "0 6px 0 2px", lineHeight: "18px", fontSize: "0.95em", background: "color-mix(in srgb, var(--primary) 16%, transparent)", color: "var(--primary-ink, var(--primary))" }}>
    <span aria-hidden className="inline-flex items-center justify-center rounded-full" style={{ width: 14, height: 14, fontSize: 7, fontWeight: 500, background: "var(--bg4)", color: "var(--text2)" }}>{initialsOf(name)}</span>
    {name}
  </span>
);

const LOCK = "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z";

/** One comment's card: who and when (edited, restricted), its words or the box they are changed in, and what can be done to it. */
function CommentCard({ c, act, root, answers }: { c: Comment; act?: CommentAct; root: Comment; answers?: string }) {
  const fresh = useContext(FreshCtx).has(c.id);
  const [mode, setMode] = useState<"read" | "edit" | "delete">("read");
  const [draft, setDraft] = useState(c.text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (mode === "read") setDraft(c.text); }, [c.text, mode]);
  const gone = useRef(false);
  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);
  const card = useContext(CardCtx);
  const link = commentLink(card.url, card.key, c.id);
  const [copied, setCopied] = useState<"" | "ok" | "no">("");
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(""), LINK_SHOWN_MS); return () => clearTimeout(t); }, [copied]);
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); if (!gone.current) setCopied("ok"); } catch { if (!gone.current) setCopied("no"); }
  };
  const named = useMemo<MentionChips | null>(() => (c.mentions?.length ? { names: c.mentions.map((m) => m.name), chip } : null), [c.mentions]);

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
    <div id={commentAnchor(c.id)} className="agx-card rounded-xl min-w-0" style={{ border: EDGE, padding: "8px 12px" }}>
      <div className="text-[10.5px] mb-1 flex items-center gap-x-1 flex-wrap">
        <span className="font-semibold" style={{ color: "var(--text2)" }}>{c.who}</span>
        {fresh && <span className="agx-jnew" data-testid="jira-comment-new">new</span>}
        {c.at > 0 && <span style={{ color: "var(--text4)" }} data-tip={tipAttr(`${new Date(c.at).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })} · ${fmtAgo(c.at)} ago`)}>{" · "}{exactDate(c.at)}</span>}
        {c.edited && <span style={{ color: "var(--text4)" }} data-tip={tipAttr(editedTip(c.editedAt, c.editedBy))}>{editedLabel(c.at, c.editedAt)}</span>}
        {answers && <span style={{ color: "var(--text4)" }}>{" · "}replying to {answers}</span>}
        {c.restricted && (
          <span className="inline-flex items-center gap-1 rounded px-1" style={{ color: "var(--warning-ink)", border: EDGE }} data-tip={tipAttr(`Only ${c.restricted} can see this comment`)}>
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={LOCK} /></svg>
            Restricted to {c.restricted}
          </span>
        )}
      </div>
      {mode === "edit" ? (
        <Composer value={draft} autoFocus busy={busy} sendLabel="Save" placeholder="Change this comment. Markdown, and @ to mention somebody."
          onChange={(v) => { setDraft(v); setErr(""); }}
          onSend={() => void save()}
          onCancel={() => { setMode("read"); setErr(""); }}
          people={act?.people}
          onNeedPeople={act?.onPeopleQuery ? () => act.onPeopleQuery!("") : undefined}
          onPeopleQuery={act?.onPeopleQuery} />
      ) : (
        <div className="agx-cu-body agx-cu-note min-w-0 break-words">{named ? <MarkdownMentions value={named}><Markdown text={c.text} /></MarkdownMentions> : <Markdown text={c.text} />}</div>
      )}
      {err && <div className="text-[10.5px] mt-1" role="alert" style={{ color: "var(--error-ink)" }}>{err}</div>}
      {mode === "read" && (act || link) && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          {act?.reply && (
            <CommentAction iconOnly label="Reply" title={`Answer ${root.who} in this thread`} d="M9 14l-5-5 5-5M4 9h9a7 7 0 0 1 7 7v4"
              on={act.replyingTo === root.id} tone="var(--primary)" onClick={() => act.onReply(act.replyingTo === root.id ? null : root)} />
          )}
          {link && (
            <CommentAction iconOnly label="Copy link" title="Copy a link to this comment in Jira" d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"
              onClick={() => void copy()} />
          )}
          {copied && <span className="text-[10.5px]" role="status" style={{ color: copied === "ok" ? "var(--success)" : "var(--error-ink)" }}>{copied === "ok" ? "Link copied" : "Could not copy the link"}</span>}
          {act && c.mine && (
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
          <Button size="compact" tone="danger" disabled={busy} onClick={() => void drop()}>{busy ? "Deleting…" : "Delete"}</Button>
          <Button size="compact" tone="quiet" disabled={busy} onClick={() => { setMode("read"); setErr(""); }}>Keep it</Button>
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


export function JiraActivity({ cardKey, cardUrl, comments, moreComments, onMoreComments, worklog, worklogMore, act, tracking, work, fresh = [], onMarkRead }: {
  cardKey: string;
  /** The card's address in Jira, which a comment's link is built on. */
  cardUrl?: string;
  /** The comments new to the person, oldest first: they wear a "new" mark, and Jump to new walks them. */
  fresh?: readonly Comment[];
  /** Mark read: everything on the card counts as read. */
  onMarkRead?: () => void;
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
  const freshIds = useMemo(() => new Set(fresh.map((c) => c.id)), [fresh]);
  const cardCtx = useMemo(() => ({ key: cardKey, url: cardUrl }), [cardKey, cardUrl]);
  const [cursor, setCursor] = useState(-1);
  useEffect(() => { setCursor(-1); }, [cardKey, fresh.length]);
  /* The walk of the pull request's conversation, at this pane's size: each press lands on the next new comment. */
  const jump = useCallback((to: number) => {
    if (!fresh.length) return;
    const n = ((to % fresh.length) + fresh.length) % fresh.length;
    setCursor(n);
    const go = () => {
      const el = document.getElementById(commentAnchor(fresh[n]!.id));
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      el.classList.remove("agx-jfound"); void el.offsetWidth; el.classList.add("agx-jfound");
    };
    if (tab !== "comments" && tab !== "all") { setTab("comments"); requestAnimationFrame(() => requestAnimationFrame(go)); } else go();
  }, [fresh, tab]);
  /* n and p, as on the pull request; ignored while typing. */
  useEffect(() => {
    if (!fresh.length) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "n") { e.preventDefault(); jump(cursor + 1); }
      else if (e.key === "p") { e.preventDefault(); jump(cursor - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fresh.length, cursor, jump]);
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
      <Button size="compact" onClick={() => void loadMoreComments()} disabled={moreBusy}>
        {moreBusy ? "Reading…" : `Show ${moreComments} more ${moreComments === 1 ? "comment" : "comments"}`}
      </Button>
      {moreError && <span role="alert" style={{ color: "var(--error-ink)" }}>{moreError}</span>}
    </div>
  );

  const historyBar = (
    <>
      {history.phase === "loading" && <Spinner label="Reading the history…" className="" />}
      {history.phase === "error" && (
        <div className="text-[10.5px] my-2 flex items-center gap-2" role="alert" style={{ color: "var(--error-ink)" }}>
          <span>{history.error}</span>
          <Button size="compact" onClick={() => void loadHistory(history.events.length ? history.next ?? 0 : 0)}>Try again</Button>
        </div>
      )}
      {history.phase === "ok" && history.next !== undefined && (
        <Button size="compact" className="my-2" onClick={() => void loadHistory(history.next!)}>
          Show {Math.min(100, Math.max(0, history.total - history.events.length))} earlier changes
        </Button>
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
      <Button size="compact" onClick={() => void loadMoreLog()} disabled={extraLog.busy}>
        {extraLog.busy ? "Reading…" : `Show ${logLeft} more ${logLeft === 1 ? "entry" : "entries"}`}
      </Button>
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
    <JiraSection id="activity" title="Activity" bare>
      <CardCtx.Provider value={cardCtx}>
      <FreshCtx.Provider value={freshIds}>
      <style>{JTL_CSS}</style>
      {/* The strip stays under the pane's top while the thread scrolls under it. The card's scroller has 4 px of padding above its content and a sticky box
          stops at the edge of that content, so with top 0 the thread showed in a 4 px band between the section tabs and this strip. top -4 with 4 px of own
          padding puts the strip's opaque background on the scroller's very edge. The Newest/Oldest button is inside the strip, so the two rows are one bar. */}
      <div className="sticky z-[2] -mx-4 px-4 pt-1 pb-1.5 mb-2" style={{ top: -4, background: "var(--bg)" }}>
        <Segmented track label="What to show" value={tab} onChange={setTab} options={tabs.map((x) => ({ id: x.id, label: <>{x.count ? `${x.label} ${x.count}` : x.label}{x.id === "comments" && fresh.length > 0 && <span className="agx-jnew agx-jnew-tab" data-testid="jira-comments-new">{fresh.length} new</span>}</> }))} />
        <div className="flex justify-end gap-1 mt-1">
          {/* Both verbs stay drawn, disabled with the reason, as the pull request's bar does. */}
          <Button size="compact" disabled={!fresh.length} onClick={() => jump(cursor + 1)} data-tip={tipAttr(fresh.length ? "Go to the next new comment (n), the one before with p" : "Nothing new since you last looked")}>
            {cursor < 0 ? "Jump to new" : "Next new"}
          </Button>
          <Button size="compact" disabled={!fresh.length || !onMarkRead} onClick={onMarkRead} data-tip={tipAttr(fresh.length ? "Clear these marks: everything here counts as read" : "Nothing new to mark")}>
            Mark read
          </Button>
          <Button size="compact" onClick={flip} aria-pressed={newest} data-tip={tipAttr("Switch between oldest and newest first")} className="shrink-0">
            {newest ? "Newest first" : "Oldest first"}
          </Button>
        </div>
      </div>
      {body}
      </FreshCtx.Provider>
      </CardCtx.Provider>
    </JiraSection>
  );
}
