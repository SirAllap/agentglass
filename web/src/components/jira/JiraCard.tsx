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
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { fmtAgo } from "../../lib/format.ts";
import { chipInk } from "../../lib/contrast.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { putCard } from "../../lib/prCardStore.ts";
import { TRACKERS } from "../../lib/trackerApi.ts";
import { OfferedPeople } from "../../lib/trackerComment.ts";
import type { Mentionable } from "../../lib/mentions.ts";
import type { ProviderTask, TaskDetail } from "../../../../shared/providers.ts";
import { openCard } from "../../lib/openCard.ts";
import { Composer, COMPOSER_MIN } from "../tasks/Composer.tsx";
import { LINE } from "../workspace/Chrome.tsx";
import { Spinner } from "../Spinner.tsx";
import { JiraCardPrs } from "./JiraCardPrs.tsx";

/** The box may grow to this share of the pane, then scrolls inside; the ClickUp card's share. */
const COMPOSER_SHARE = 0.3;
/** Typing after `@` asks Jira once the keys have paused this long. */
const PEOPLE_WAIT_MS = 250;

type Row = Mentionable & { initials?: string; avatar?: string };

function Author({ who, initials, avatar }: { who: string; initials?: string; avatar?: string }) {
  const [broken, setBroken] = useState(false);
  const size = { width: 18, height: 18, borderRadius: 999 } as const;
  if (avatar && !broken) {
    return <img src={avatar} alt="" title={who} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)}
      className="shrink-0 object-cover" style={size} />;
  }
  return <span title={who} className="shrink-0 inline-flex items-center justify-center text-[9px] font-medium"
    style={{ ...size, background: "var(--bg4)", color: chipInk(null) }}>{initials || "?"}</span>;
}

type Tab = "card" | "github" | "subtasks";

/** Subtasks as the detail read gave them: the key, the title, the status as the site spells it. A row opens the card in the app. */
export function SubtaskRows({ rows }: { rows: ProviderTask[] }) {
  return (
    <div className="flex flex-col" aria-label="Subtasks">
      {rows.map((s) => {
        const k = s.customId ?? s.id;
        return (
          <button key={s.id} onClick={() => openCard(k, k, "jira")} title={`Open ${k}`}
            className="agx-btn flex items-center gap-2 min-w-0 text-left text-[11px] py-1.5" style={{ borderBottom: LINE }}>
            <span className="tabular-nums shrink-0" style={{ color: "var(--text3)" }}>{k}</span>
            <span className="flex-1 min-w-0 truncate" style={{ color: s.statusKind === "done" ? "var(--text3)" : "var(--text)" }}>{s.title}</span>
            <span className="shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>{s.status}</span>
          </button>
        );
      })}
    </div>
  );
}

export function JiraCard({ t, header, writes, onTask }: {
  t: ProviderTask;
  /** The card's facts, drawn above the thread and kept there. */
  header: React.ReactNode;
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

  const read = useCallback(async () => {
    const mine = ++tok.current;
    const r = await api.jiraDetail(key).catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraDetail>>));
    if (mine !== tok.current) return; // another card was picked meanwhile
    if (r.ok && r.detail) {
      setDetail(r.detail); setMore(r.more ?? 0); setErr("");
      onTaskRef.current(r.detail.task);
    } else setErr(r.error || `${key} could not be read`);
  }, [key]);

  useEffect(() => { setDetail(null); setMore(0); setErr(""); void read(); }, [read]);

  /* Which half of the card is on screen. GitHub is there for every card (the
     pull requests are read when it is opened, never before); subtasks only when
     the card has some. A different card starts on the card itself. */
  const [tab, setTab] = useState<Tab>("card");
  useEffect(() => { setTab("card"); }, [key]);
  const subtasks = detail?.subtasks ?? [];
  const view: Tab = tab === "subtasks" && !subtasks.length ? "card" : tab;

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
      <div className="shrink-0" style={{ borderBottom: LINE }}>{header}</div>
      <div className="shrink-0">
        <div className="flex items-center gap-1.5 px-5" style={{ borderBottom: LINE }}>
          {([
            ["card", "Card"],
            ["github", "GitHub"],
            ...(subtasks.length ? [["subtasks", `Subtasks ${subtasks.length}`] as const] : []),
          ] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} aria-current={view === id ? "page" : undefined}
              className="agx-btn text-[10px] uppercase tracking-[0.14em] px-2.5 py-1.5 -mb-px rounded-t-md"
              style={{
                color: view === id ? "var(--text)" : "var(--text3)",
                background: view === id ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
                borderBottom: `2px solid ${view === id ? "var(--primary)" : "transparent"}`,
              }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div ref={listRef} className="agx-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 py-3">
        {view === "github" && <JiraCardPrs query={key} writable={writes} quiet={!writes} />}
        {view === "subtasks" && <SubtaskRows rows={subtasks} />}
        {view === "card" && err && <div className="text-[11px] mb-3" role="alert" style={{ color: "var(--error-ink)" }}>{err}</div>}
        {view === "card" && !detail && !err && <Spinner label="Reading the card…" className="" />}
        {view === "card" && detail && (
          <>
            <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: "var(--text3)" }}>Description</div>
            <div className="agx-cu-body mb-5 min-w-0 break-words">
              {detail.description.trim()
                ? <Markdown text={detail.description} />
                : <span style={{ color: "var(--text4)" }}>No description.</span>}
            </div>
            <div className="text-[10px] uppercase tracking-wide mb-2" style={{ color: "var(--text3)" }}>
              Comments{count ? ` · ${count}` : ""}
            </div>
            {more > 0 && (
              <div className="text-[10.5px] mb-2" style={{ color: "var(--text3)" }}>
                {more} earlier {more === 1 ? "comment is" : "comments are"} only on Jira.
              </div>
            )}
            {!count && <div className="text-[11px]" style={{ color: "var(--text4)" }}>No comments yet.</div>}
            {detail.comments.map((c) => (
              <div key={c.id} className="mb-3.5 flex gap-2.5 min-w-0">
                <Author who={c.who} initials={c.initials} avatar={c.avatar} />
                <div className="min-w-0 flex-1">
                  <div className="text-[10.5px] mb-0.5">
                    <span className="font-semibold" style={{ color: "var(--text2)" }}>{c.who}</span>
                    {c.at > 0 && <span style={{ color: "var(--text4)" }}>{" · "}{fmtAgo(c.at)} ago</span>}
                  </div>
                  <div className="agx-cu-body agx-cu-note min-w-0 break-words"><Markdown text={c.text} /></div>
                </div>
              </div>
            ))}
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
