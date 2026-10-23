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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { putCard } from "../../lib/prCardStore.ts";
import { TRACKERS } from "../../lib/trackerApi.ts";
import { OfferedPeople } from "../../lib/trackerComment.ts";
import type { Mentionable } from "../../lib/mentions.ts";
import type { ProviderTask, TaskDetail } from "../../../../shared/providers.ts";
import { Composer, COMPOSER_MIN } from "../tasks/Composer.tsx";
import { LINE } from "../workspace/Chrome.tsx";
import { readJiraLinks, type JiraLinks } from "../../lib/jiraLinks.ts";
import { JiraProps } from "./JiraFacts.tsx";
import { JiraActivity } from "./JiraActivity.tsx";
import { AttachmentsSection, LinkedSection, Section, SubtasksSection, WebLinksSection } from "./JiraSections.tsx";
import { Spinner } from "../Spinner.tsx";
import { JiraCardPrs } from "./JiraCardPrs.tsx";
import { mentionsOfCard } from "../../lib/jiraLinks.ts";

/** The box may grow to this share of the pane, then scrolls inside; the ClickUp card's share. */
const COMPOSER_SHARE = 0.3;
/** Typing after `@` asks Jira once the keys have paused this long. */
const PEOPLE_WAIT_MS = 250;

type Row = Mentionable & { initials?: string; avatar?: string };

export function JiraCard({ t, header, writes, onTask }: {
  t: ProviderTask;
  /** What stays above the tabs, given how to re-read this card. */
  header: (r: { onRefresh: () => void; refreshing: boolean }) => React.ReactNode;
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

  /* The composer, pinned under the thread. */
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
    setSay(""); setSayErr(""); setSayWarn(""); setPeople(null);
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

  const send = () => {
    if (!say.trim() || saying) return;
    setSaying(true); setSayErr(""); setSayWarn("");
    void TRACKERS.jira.comment(detail?.task ?? t, say, offered.current.named(say)).then((r) => {
      if (!r.ok) { setSayErr(r.error || "Jira refused the comment"); return; } // the draft is kept
      setSay("");
      sent.current = true;
      if (r.task) { onTaskRef.current(r.task); putCard(key, r.task); }
      if (r.detail) { setDetail(r.detail); setMore(r.more ?? 0); }
      else void read();
      if (r.partial) setSayWarn(r.partial);
    }).finally(() => setSaying(false));
  };

  return (
    <div ref={paneRef} className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="shrink-0" style={{ background: "var(--bg)" }}>{header({ onRefresh: refresh, refreshing })}</div>
      <div ref={listRef} className="agx-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-3">
        {err && <div className="text-[11px] mb-3" role="alert" style={{ color: "var(--error-ink)" }}>{err}</div>}
        {!detail && !err && <Spinner label="Reading the card…" className="" />}
        <JiraProps t={detail?.task ?? t} writable={writes} onTask={onTask} facts={detail?.facts} />
        {detail && (
          <>
            <Section id="description" title="Description">
              <div className="agx-cu-body min-w-0 break-words">
                {detail.description.trim()
                  ? <Markdown text={detail.description} />
                  : <span style={{ color: "var(--text4)" }}>No description.</span>}
              </div>
            </Section>
            <AttachmentsSection files={detail.attachments ?? []} />
            <SubtasksSection rows={detail.subtasks} />
            <LinkedSection linked={detail.linked ?? []} />
            <WebLinksSection links={links ? links.web : null} error={links?.error ?? ""} />
            <Section id="development" title="Development">
              <JiraCardPrs query={key} writable={writes} quiet={!writes} mentions={mentions} />
            </Section>
            <JiraActivity cardKey={key} comments={detail.comments} moreComments={more} worklog={detail.events ?? []} worklogMore={detail.worklogMore ?? 0}
              onMoreComments={(page, left) => { setDetail((d) => (d ? { ...d, comments: [...d.comments, ...page] } : d)); setMore(left); }} />
          </>
        )}
      </div>

      {/* With writes off the pane has said so once, above; there is no box and no second sentence here. */}
      {writes && <div className="shrink-0 px-4 pt-2 pb-3" style={{ borderTop: LINE }}>
        <Composer value={say} growTo={sayCap} onChange={(v) => { setSay(v); setSayErr(""); }} busy={saying}
          placeholder={`Comment on ${key}. Markdown, and @ to mention somebody.`}
          sendLabel="Comment"
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
