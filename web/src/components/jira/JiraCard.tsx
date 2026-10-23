/*
 * One Jira card in the side pane: its facts, what was written on it, and a box
 * to answer.
 *
 * The house shape for a side panel: the header (the card's facts) and the
 * composer stay put, and only what is between them scrolls. The composer is
 * the card panel's own (tasks/Composer.tsx), so the toolbar, the preview and
 * the `@` menu are the ones a ClickUp card has; who the menu offers comes from
 * Jira's people search, asked per query because Jira has no list to read whole.
 *
 * Reads: one request when a card is picked (the card with its description and
 * comments). A comment is one write and the card read back, and that answer
 * replaces the thread, so posting costs no second read here.
 */
import { HIT } from "../../lib/iconSize.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { putCard } from "../../lib/prCardStore.ts";
import { TRACKERS } from "../../lib/trackerApi.ts";
import { OfferedPeople } from "../../lib/trackerComment.ts";
import type { Mentionable } from "../../lib/mentions.ts";
import type { ProviderTask, TaskDetail } from "../../../../shared/providers.ts";
import { Composer, COMPOSER_MIN } from "../tasks/Composer.tsx";
import { EDGE, LINE } from "../workspace/Chrome.tsx";
import { readJiraLinks, setJiraWeb, type JiraLinks } from "../../lib/jiraLinks.ts";
import { JiraProps } from "./JiraFacts.tsx";
import { EditNote } from "./EditNote.tsx";
import { useJiraEdit, type JiraEditUi } from "./useJiraEdit.ts";
import type { JiraFollowUi } from "./useJiraFollow.ts";
import { nowOf, stepFor } from "../../lib/jiraEdit.ts";
import { keepThreads } from "../../lib/jiraThreads.ts";
import { JiraActivity, type CommentAct } from "./JiraActivity.tsx";
import { useJiraWork } from "./useJiraWork.ts";
import { useJiraFollow } from "./useJiraFollow.ts";
import { JiraDescription } from "./JiraDescription.tsx";
import { LinkedBlock, SubtasksBlock, WebLinksBlock, type JoinAct } from "./JiraJoins.tsx";
import { madeLink, webAddress } from "../../lib/jiraJoins.ts";
import { AttachmentsBlock, type FileAct } from "./JiraFiles.tsx";
import { LinkedSection, Section, SubtasksSection, WebLinksSection } from "./JiraSections.tsx";
import { Spinner } from "../Spinner.tsx";
import { JiraCardPrs } from "./JiraCardPrs.tsx";
import { mentionsOfCard } from "../../lib/jiraLinks.ts";

/** The box may grow to this share of the pane, then scrolls inside; the ClickUp card's share. */
const COMPOSER_SHARE = 0.3;
/** The line under the header that says what a change did: its height, kept whether or not there is anything to say. */
const NOTE_H = HIT + 8; // the dismiss box plus the note's own bottom padding
/** Typing after `@` asks Jira once the keys have paused this long. */
const PEOPLE_WAIT_MS = 250;

type Row = Mentionable & { initials?: string; avatar?: string };

export function JiraCard({ t, header, writes, onTask }: {
  t: ProviderTask;
  /** What stays above the tabs, given how to re-read this card. */
  header: (r: { onRefresh: () => void; refreshing: boolean; ed: JiraEditUi; follow: JiraFollowUi }) => React.ReactNode;
  /** Whether writing to Jira is switched on; off draws a line instead of the box. */
  writes: boolean;
  /** The card as a fresher read or a write left it, for the list beside this. */
  onTask: (task: ProviderTask) => void;
}) {
  const key = t.customId ?? t.id;
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [more, setMore] = useState(0);
  const [err, setErr] = useState("");
  const tok = useRef(0);
  const onTaskRef = useRef(onTask);
  onTaskRef.current = onTask;

  const [refreshing, setRefreshing] = useState(false);
  const read = useCallback(async () => {
    const mine = ++tok.current;
    const r = await api.jiraDetail(key).catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraDetail>>));
    if (mine !== tok.current) return; // another card was picked meanwhile
    if (r.ok && r.detail) {
      setDetail(r.detail); setMore(r.more ?? 0); setErr("");
      onTaskRef.current(r.detail.task);
    } else setErr(r.error || `${key} could not be read`);
  }, [key]);
  /* The card's own refresh: the detail read again, the same one a pick makes, no timer and no second request. */
  const refresh = useCallback(() => {
    setRefreshing(true);
    void read().finally(() => setRefreshing(false));
  }, [read]);

  useEffect(() => { setDetail(null); setMore(0); setErr(""); void read(); }, [read]);

  /* A change to the card's Details: one request, whose answer is the card with its Details, so nothing is read again. */
  const editing = useJiraEdit({
    cardKey: key, stamp: (detail?.task ?? t).updated ?? 0,
    onDone: (r) => {
      setDetail((d) => (d ? { ...d, task: r.task, ...(r.facts ? { facts: r.facts } : {}), ...(r.edit ? { edit: r.edit } : {}), ...(r.description !== undefined ? { description: r.description } : {}) } : d));
      onTaskRef.current(r.task); putCard(key, r.task);
    },
    onStale: refresh,
  });
  const ed: JiraEditUi = {
    edit: writes ? detail?.edit : undefined, busy: editing.busy, run: editing.run,
    now: nowOf(detail?.task ?? t, detail?.facts, detail?.edit, detail?.description),
  };

  /* The card's remote links: one request, shared with the Development section (lib/jiraLinks.ts), so opening a card costs two in all. */
  const [links, setLinks] = useState<JiraLinks | null>(null);
  useEffect(() => {
    let on = true;
    setLinks(null);
    void readJiraLinks(key).then((r) => { if (on) setLinks(r); });
    return () => { on = false; };
  }, [key]);
  // The pull requests the card's own words name, from the read already made.
  const mentions = useMemo(() => (detail ? mentionsOfCard(detail) : []), [detail]);

  /* The composer, pinned under the thread. `replyTo` is the comment its next send answers. */
  const [replyTo, setReplyTo] = useState<{ id: string; who: string } | null>(null);
  const [say, setSay] = useState("");
  const [saying, setSaying] = useState(false);
  const [sayErr, setSayErr] = useState("");
  /** Posted, but not everything after it went through: said as a warning. */
  const [sayWarn, setSayWarn] = useState("");
  const offered = useRef(new OfferedPeople());
  const [people, setPeople] = useState<Row[] | null>(null);
  const asking = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    setSay(""); setSayErr(""); setSayWarn(""); setPeople(null); setReplyTo(null);
    offered.current = new OfferedPeople();
    return () => { if (asking.current) clearTimeout(asking.current); };
  }, [key]);
  const askPeople = useCallback((q: string) => {
    if (asking.current) clearTimeout(asking.current);
    asking.current = setTimeout(() => {
      const forKey = key;
      void api.jiraPeople(forKey, q).then((r) => {
        if (forKey !== keyRef.current) return;
        // A failed search keeps what was offered before rather than offering nobody.
        if (r.ok && r.people) setPeople(offered.current.add(r.people));
        else setPeople((p) => p ?? []);
      }).catch(() => { if (forKey === keyRef.current) setPeople((p) => p ?? []); });
    }, PEOPLE_WAIT_MS);
  }, [key]);

  const paneRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [sayCap, setSayCap] = useState(160);
  const atEnd = useRef(false);
  const sent = useRef(false);
  useEffect(() => {
    const pane = paneRef.current;
    const list = listRef.current;
    if (!pane || !list) return;
    const onScroll = () => { atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 4; };
    list.addEventListener("scroll", onScroll, { passive: true });
    let last = list.clientHeight;
    const ro = new ResizeObserver(() => {
      setSayCap(Math.max(COMPOSER_MIN, Math.round(pane.clientHeight * COMPOSER_SHARE)));
      // The box grew, so the thread shrank: a reader at its end stays there.
      if (list.clientHeight !== last && atEnd.current) list.scrollTop = list.scrollHeight;
      last = list.clientHeight;
    });
    ro.observe(pane); ro.observe(list);
    return () => { list.removeEventListener("scroll", onScroll); ro.disconnect(); };
  }, []);
  const count = detail?.comments.length ?? 0;
  useEffect(() => {
    if (!sent.current) return;
    sent.current = false;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [count]);

  /* The card's stamp moved with a change to a comment: read it again, and keep the comments already paged in. */
  const restamp = async () => {
    const r = await api.jiraDetail(key).catch(() => null);
    if (r?.ok && r.detail && keyRef.current === key) { setDetail((d) => (d ? { ...d, task: r.detail!.task } : d)); onTaskRef.current(r.detail.task); }
  };
  const act: CommentAct | undefined = writes && detail?.edit ? {
    reply: detail.edit.reply,
    replyingTo: replyTo?.id ?? null,
    onReply: (c) => setReplyTo(c ? { id: c.id, who: c.who } : null),
    edit: async (c, text) => {
      const r = await api.jiraCommentEdit(key, c.id, text, c.mentions ?? []).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok || !r.comment) return r.error || "Jira refused that change";
      const next = r.comment;
      setDetail((d) => (d ? { ...d, comments: d.comments.map((x) => (x.id === c.id ? { ...x, ...next } : x)) } : d));
      void restamp();
      return r.partial ?? null;
    },
    remove: async (c) => {
      const r = await api.jiraCommentDelete(key, c.id).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused the delete";
      setDetail((d) => (d ? { ...d, comments: d.comments.filter((x) => x.id !== c.id), task: { ...d.task, comments: Math.max(0, (d.task.comments ?? 1) - 1) } } : d));
      setReplyTo((cur) => (cur?.id === c.id ? null : cur));
      void restamp();
      return null;
    },
  } : undefined;

  /* What the card is joined to: each change is one write whose answer is the card again (or its list of addresses), so nothing is read twice.
     The comments stay as they were: a write here did not touch them, and the answer left their threads out. */
  const take = (sent: TaskDetail) => {
    setDetail((d) => (d ? { ...sent, comments: d.comments } : sent));
    onTaskRef.current(sent.task); putCard(key, sent.task);
  };
  /* Time logged on the card: each write is one request whose answer is the card again, so nothing is read twice. The comments stay as
     they were, as for a change to what the card is joined to. Offered only while writing to Jira is on and the site tracks time here. */
  const work = useJiraWork({
    cardKey: key, stamp: (detail?.task ?? t).updated ?? 0,
    onDone: (sent) => take(sent),
    onStale: refresh,
  });

  /* Watching and voting: the account's own marks, one request each, with the counts the card was read with moved by the press. */
  const follow = useJiraFollow({
    cardKey: key, follow: detail?.follow,
    onFollow: (f) => setDetail((d) => (d ? { ...d, follow: f } : d)),
  });

  const joinAct: JoinAct = {
    subtask: async (title) => {
      const r = await api.jiraSubtask(key, title).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused that sub-task";
      if (r.detail) take(r.detail); else void read();
      return null;
    },
    relate: async (other, way) => {
      const r = await api.jiraRelate(key, other, way.typeId, way.outward).catch(() => null);
      if (!r) return { error: "Could not reach agentglass" };
      if (!r.ok) return { error: r.error || "Jira refused that link" };
      if (r.already) return { error: `${key} ${way.phrase} ${other} is already there` };
      if (!r.detail) { void read(); return {}; }
      take(r.detail);
      return { made: madeLink(r.detail.linked, other, way) };
    },
    unrelate: async (l) => {
      const r = await api.jiraUnrelate(key, l.id).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused that change";
      if (r.detail) take(r.detail); else void read();
      return null;
    },
    webAdd: async (url, title) => {
      const r = await api.jiraWebLink(key, url, title).catch(() => null);
      if (!r) return { error: "Could not reach agentglass" };
      if (!r.ok || !r.web) return { error: r.error || "Jira refused that address" };
      setLinks(setJiraWeb(key, r.web));
      if (r.already) return { error: "That address is already on the card" };
      const at = webAddress(url);
      return { made: r.web.find((w) => w.url === at) };
    },
    webRemove: async (w) => {
      const r = await api.jiraWebUnlink(key, w.id).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok || !r.web) return r.error || "Jira refused that change";
      setLinks(setJiraWeb(key, r.web));
      return null;
    },
    onRowTask: (t) => setDetail((d) => (d ? { ...d, subtasks: d.subtasks.map((x) => (x.id === t.id ? t : x)) } : d)),
  };

  /* A file is one write whose answer is the card again, so nothing is read twice. */
  const fileAct: FileAct = {
    add: async (f) => {
      const r = await api.jiraAttach(key, f).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused that file";
      if (r.detail) take(r.detail); else void read();
      return null;
    },
    remove: async (a) => {
      const r = await api.jiraUnattach(key, a.id).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused that change";
      if (r.detail) take(r.detail); else void read();
      return null;
    },
  };

  const send = () => {
    if (!say.trim() || saying) return;
    setSaying(true); setSayErr(""); setSayWarn("");
    void TRACKERS.jira.comment(detail?.task ?? t, say, offered.current.named(say), replyTo?.id).then((r) => {
      if (!r.ok) { setSayErr(r.error || "Jira refused the comment"); return; } // the draft is kept, and so is whom it answers
      setSay(""); setReplyTo(null);
      sent.current = true;
      if (r.task) { onTaskRef.current(r.task); putCard(key, r.task); }
      if (r.detail) { const sent = r.detail; setDetail((d) => ({ ...sent, comments: keepThreads(d?.comments ?? [], sent.comments, replyTo?.id) })); setMore(r.more ?? 0); }
      else void read();
      if (r.partial) setSayWarn(r.partial);
    }).finally(() => setSaying(false));
  };

  return (
    <div ref={paneRef} className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="shrink-0" style={{ background: "var(--bg)" }}>
        {header({ onRefresh: refresh, refreshing, ed, follow })}
        {/* One line is kept for what a change says, empty or not, so what it says never moves the controls under it. */}
        <div style={{ minHeight: ed.edit ? NOTE_H : 0 }}><EditNote note={editing.note} busy={!!editing.busy} onUndo={editing.undo} onClose={editing.clear} /></div>
      </div>
      <div ref={listRef} className="agx-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-3">
        {err && <div className="text-[11px] mb-3" role="alert" style={{ color: "var(--error-ink)" }}>{err}</div>}
        {!detail && !err && <Spinner label="Reading the card…" className="" />}
        <JiraProps t={detail?.task ?? t} writable={writes} onTask={onTask} facts={detail?.facts} ed={ed} />
        {detail && (
          <>
            <JiraDescription text={detail.description} edit={detail.edit} writes={writes} url={t.url} busy={editing.busy === "description"}
              onSave={(md) => { const step = stepFor("description", { value: md }, ed.now); return step ? editing.run(step) : Promise.resolve(false); }} />
            <AttachmentsBlock files={detail.attachments ?? []} card={key} writable={writes} act={fileAct} />
            {writes ? <SubtasksBlock rows={detail.subtasks} parent={detail.task} writable act={joinAct} /> : <SubtasksSection rows={detail.subtasks} />}
            {writes ? <LinkedBlock linked={detail.linked ?? []} card={key} writable act={joinAct} /> : <LinkedSection linked={detail.linked ?? []} />}
            {writes ? <WebLinksBlock links={links ? links.web : null} error={links?.error ?? ""} writable card={key} act={joinAct} /> : <WebLinksSection links={links ? links.web : null} error={links?.error ?? ""} />}
            <Section id="development" title="Development">
              <JiraCardPrs query={key} writable={writes} quiet={!writes} mentions={mentions} />
            </Section>
            <JiraActivity cardKey={key} act={act} comments={detail.comments} moreComments={more} worklog={detail.events ?? []} worklogMore={detail.worklogMore ?? 0} tracking={detail.tracking} work={writes && detail.tracking ? work : undefined}
              onMoreComments={(page, left) => { setDetail((d) => (d ? { ...d, comments: [...d.comments, ...page] } : d)); setMore(left); }} />
          </>
        )}
      </div>

      {/* With writes off the pane has said so once, above; there is no box and no second sentence here. */}
      {writes && <div className="shrink-0 px-4 pt-2 pb-3" style={{ borderTop: LINE }}>
        {replyTo && (
          <div className="flex items-center gap-2 mb-1 text-[10.5px] min-w-0" style={{ color: "var(--text3)" }}>
            <span className="min-w-0 truncate" title="Your comment goes in their thread">Replying to {replyTo.who}</span>
            <button className="agx-btn shrink-0 rounded-md px-1.5 py-0.5" onClick={() => setReplyTo(null)} style={{ color: "var(--text2)", border: EDGE }} title="Add it as a comment of its own, not in their thread">Cancel reply</button>
          </div>
        )}
        <Composer value={say} growTo={sayCap} onChange={(v) => { setSay(v); setSayErr(""); }} busy={saying}
          placeholder={replyTo ? `Answer ${replyTo.who}. Markdown, and @ to mention somebody.` : `Comment on ${key}. Markdown, and @ to mention somebody.`}
          sendLabel={replyTo ? "Reply" : "Comment"}
          people={people}
          onNeedPeople={() => askPeople("")}
          onPeopleQuery={askPeople}
          onSend={send} />
        {sayErr && <div className="text-[10.5px] mt-1" role="alert" style={{ color: "var(--error-ink)" }}>{sayErr}</div>}
        {sayWarn && <div className="text-[10.5px] mt-1" role="status" style={{ color: "var(--warning-ink)" }}>{sayWarn}</div>}
      </div>}
    </div>
  );
}
