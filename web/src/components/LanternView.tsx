import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { fmtAgo, since as agoSentence } from "../lib/format.ts";
import { jumpToPane } from "../lib/paneJump.ts";
import { subscribeLantern, lanternRows, lanternFailed, lanternWatch, lanternCacheTtlMs, refreshLantern } from "../lib/lanternStore.ts";
import { askLantern, hasLanternTab } from "../lib/lanternAsk.ts";
import { subscribeBench } from "../lib/benchStore.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { edge, wash } from "./git/ui.tsx";
import { modelLabelOf } from "../../../shared/models.ts";
import { ScheduleDialog, ScheduledSection, type AgentSchedule } from "./LanternSchedule.tsx";
import { handOff } from "../lib/lanternAsk.ts";
import { api } from "../lib/api.ts";

/**
 * THE LANTERN. Who needs you, what every agent is working on, and the way there.
 *
 * Translated from Herdr's Lantern plugin — "the herd is in the field; Lantern
 * illuminates who needs you and what they are working toward" — with the one
 * difference that matters: its board is a chat you ask, and this is a screen
 * that answers before you ask. The first line is the whole point. Nobody is
 * stopped on you: a calm sentence and nothing shouting. Somebody is: their
 * card, in red or amber, with why, for how long, and a button that goes there.
 * The rail's icon carries the same number, so you find out from any view.
 *
 * It was a tab inside Clone called "Crew" — where nobody found it, under a
 * name that meant nothing ("it makes no sense to me"), drawn as eighteen
 * identical rows of which sixteen were idle and the two that mattered looked
 * the same as the rest. This orders Lantern's way — stopped on you, then
 * moving, then quiet — and folds the quiet ones behind their count.
 *
 * Deliberately not here, and it is not an oversight: no button starts, stops
 * or queues anything. Lantern's `prompt.md` routes "open X with Codex" and
 * "close that tab" through a mutate gate because Herdr has no other surface
 * for those verbs; this app does (Chat, the tab strip, the Clone's Work tab),
 * and two places that command the same thing is how a run gets lost.
 */
export interface LanternRow {
  name: string;
  /** The Lantern's own chat, when it is on the field: shown aside, never counted. */
  role?: "lantern";
  doing?: string;
  saidAt?: number;
  startedAt?: number;
  worktree?: string;
  branch?: string;
  left?: string;
  paneId?: string;
  /** Whether git already has this branch. Absent when nobody asked — which is
   *  not the same as "nobody merged it", and must not be drawn as if it were. */
  landed?: boolean;
  /** The ref `landed` was measured against. "merged" is half a fact without it. */
  landedInto?: string;
  /** The hooked session behind the row, when this machine knows it. */
  session?: string;
  /** Why it is stopped on a person — see BoardRow.needsYou on the server. A
   *  permission or a held gate is a blockage; "input" is a turn that ended. */
  needsYou?: { kind: "permission" | "input" | "gate"; why: string; since: number };
  from: "said" | "seen";
  state: "working" | "waiting" | "idle";
  /** Who this is and what it has done — see SessionFacts on the server. */
  facts?: {
    model?: string; tools: number; errors: number; turns: number; cost: number;
    startedAt?: number; lastSeen?: number;
    lastTool?: { name: string; what: string; at: number };
    lastAsk?: { text: string; at: number };
    permissionMode?: string;
  };
  /** Its checkout, as git sees it — see GitFacts on the server. */
  git?: { dirty: number; ahead: number; lastCommit?: { subject: string; at: number }; at: number };
}

/** What the watch last found, riding on the board's answer. */
export interface LanternWatch { at: number; flagged: number; every: number; on: boolean }

/* A blockage is red, a turn that merely ended is amber: "needs your
   permission" and "waiting for your input" are both somebody's to answer, and
   the first one is the one the agent cannot get past on its own. */
const waitTone = (w: NonNullable<LanternRow["needsYou"]>) => (w.kind === "input" ? "var(--warning)" : "var(--error)");
const waitWord = (w: NonNullable<LanternRow["needsYou"]>) =>
  w.kind === "permission" ? "needs your permission" : w.kind === "gate" ? "held at the gate" : "waiting for your next prompt";

/** The last segment of a path — the worktree's own name, which is what people
 *  call it, without the four directories above it that are always the same. */
const here = (p?: string) => (p ? p.replace(/\/+$/, "").split("/").pop() ?? p : "");

/** The tool's own short name: `mcp__plugin_x__mem_save` is "mem_save" to a person. */
const toolShort = (t: string) => t.split("__").pop() || t;

const money = (usd: number) => (usd >= 100 ? `$${Math.round(usd)}` : usd >= 1 ? `$${usd.toFixed(1)}` : usd > 0 ? `$${usd.toFixed(2)}` : "");
const count = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * THE PROMPT CACHE, COUNTED DOWN. A provider keeps a session's prompt cache
 * warm for a window after its last turn (Settings ▸ Agents ▸ Lantern); a turn
 * sent inside it is the cheap one. The last thing the session did is the
 * clock's start — its last tool call or its last sighting — and the card says
 * how long is left, or that it has gone cold. Decides "now or in five".
 */
function cacheLeft(r: LanternRow, ttlMs: number, now = Date.now()): { leftMs: number; warm: boolean } | null {
  const last = Math.max(r.facts?.lastTool?.at ?? 0, r.facts?.lastSeen ?? 0, r.saidAt ?? 0);
  if (!last) return null;
  const leftMs = last + ttlMs - now;
  return { leftMs, warm: leftMs > 0 };
}
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** The tone a card wears: the wait's when stopped on you, the state's otherwise. */
function toneOf(r: LanternRow): string {
  if (r.needsYou) return waitTone(r.needsYou);
  return r.state === "working" ? "var(--success)" : "var(--text4)";
}

/** Where it is, on one line: checkout, branch, and whether the branch is in. */
function Where({ r }: { r: LanternRow }) {
  if (!r.worktree && !r.branch) return null;
  return (
    <div className="flex items-baseline gap-1.5 min-w-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
      {r.worktree && <span className="truncate" title={r.worktree}>{here(r.worktree)}</span>}
      {r.worktree && r.branch && <span aria-hidden className="shrink-0">·</span>}
      {r.branch && <span className="truncate" style={{ color: "var(--primary)" }} title={`branch ${r.branch}`}>{r.branch}</span>}
      {r.branch && r.landed === true && (
        <span className="shrink-0" style={{ color: "var(--success)" }} title={`already merged into ${r.landedInto || "the base"}`}>· in {r.landedInto || "the base"}</span>
      )}
      {r.branch && r.landed === false && (
        <span className="shrink-0" style={{ color: "var(--warning)" }} title={`nobody has merged this into ${r.landedInto || "the base"}`}>· not in {r.landedInto || "the base"}</span>
      )}
    </div>
  );
}

/** The button that goes there — only when there is a there. In the card's
 *  own footer slot, never floating over its text. */
function Go({ paneId, onJump, big }: { paneId?: string; onJump?: (p: string) => void; big?: boolean }) {
  if (!paneId || !onJump) return null;
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onJump(paneId); }}
      title={`Go to ${paneId}`}
      className={`agx-btn shrink-0 rounded-md inline-flex items-center gap-1 ${big ? "px-3 py-1.5 text-[12px] font-medium" : "px-2.5 py-1 text-[11px]"}`}
      style={{ color: "var(--text)", background: wash("--primary", big ? 26 : 16), border: `1px solid ${wash("--primary", big ? 55 : 40)}` }}>
      Go <span aria-hidden>→</span>
    </button>
  );
}

/** A label for a card's line: small caps, tracked, in the quietest ink. Set
 *  at a fixed width so the lines below one another read as a table. */
function Label({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] w-11 pt-px" style={{ color: tone ?? "var(--text4)" }}>{children}</span>;
}

/** One fact, as "number word", digits lined up. */
function Fact({ n, word, tone, title }: { n: string | number; word: string; tone?: string; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 tabular-nums" title={title} style={{ color: tone ?? "var(--text3)" }}>
      <span className="font-medium" style={{ color: tone ?? "var(--text2)" }}>{n}</span>
      <span>{word}</span>
    </span>
  );
}

/** A small chip in the house style: a wash of its tone, never a solid block. */
function Pill({ children, tone, title }: { children: React.ReactNode; tone: string; title?: string }) {
  const c = tone.startsWith("var(") ? tone.slice(4, -1) : "";
  return (
    <span title={title} className="shrink-0 inline-flex items-center rounded-full px-1.5 py-px text-[9.5px] leading-[14px] uppercase tracking-[0.08em]"
      style={{ color: tone, background: c ? wash(c, 12) : "transparent", border: `1px solid ${c ? wash(c, 28) : tone}` }}>
      {children}
    </span>
  );
}

/**
 * ONE AGENT, AS A CARD. Who it is (its name, its model, how long it has been
 * around), where it is (checkout, branch, landed or not), what it is doing
 * (its own word, or its last tool call in the words that call carried), what
 * it was last asked, what it has done (commits over the base, files changed,
 * calls, turns, errors, what it cost), what it needs — and Go.
 *
 * "No useless things": every line is a record this app keeps; a card with
 * nothing to say on a line leaves the line out rather than drawing a dash.
 * Stopped on you, the card wears the wait's colour and leads with the reason.
 */
/**
 * HAND OFF — this session's conversation, summarised, seated as another agent's
 * first message on the bench. Which CLIs are offered is what the machine has;
 * one press per kind, no menu to learn. Only for a row with a session behind
 * it: a run's row or a bare pane has no conversation to hand over.
 */
function HandOff({ session, kinds }: { session: string; kinds: { id: string; title: string }[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!kinds.length) return null;
  return (
    <span className="inline-flex items-center gap-1" title="Hand this conversation to another agent: a brief of the task, the last turns and the files touched, as its first message">
      <span className="text-[9.5px] uppercase tracking-[0.1em]" style={{ color: "var(--text4)" }}>hand off</span>
      {kinds.map((k) => (
        <button key={k.id} type="button" disabled={busy !== null}
          onClick={async (e) => { e.stopPropagation(); setBusy(k.id); setErr(null); const r = await handOff(session, k.id); setBusy(null); if (!r.ok) setErr(r.error ?? "failed"); }}
          className="agx-btn rounded-full px-1.5 text-[9.5px] leading-[14px] uppercase tracking-[0.08em] disabled:opacity-50"
          style={{ color: "var(--text3)", background: wash("--text", 6), border: `1px solid ${wash("--text", 18)}` }}>
          {busy === k.id ? "…" : k.title.replace(/ Code$/, "")}
        </button>
      ))}
      {err && <span className="text-[10px]" style={{ color: "var(--error)" }}>{err}</span>}
    </span>
  );
}

export function AgentCard({ r, onJump, quiet, cacheTtlMs, kinds }: { r: LanternRow; onJump?: (paneId: string) => void; quiet?: boolean; cacheTtlMs?: number; kinds?: { id: string; title: string }[] }) {
  const w = r.needsYou;
  const cache = cacheTtlMs ? cacheLeft(r, cacheTtlMs) : null;
  const tone = toneOf(r);
  const f = r.facts;
  const g = r.git;
  const since = r.saidAt ?? f?.lastSeen ?? r.startedAt;
  const model = f?.model ? modelLabelOf(f.model) : "";
  const now = r.doing
    ? { text: r.doing, at: r.saidAt, tag: "said" as const }
    : f?.lastTool
      ? { text: f.lastTool.what || toolShort(f.lastTool.name), at: f.lastTool.at, tag: toolShort(f.lastTool.name) }
      : null;
  return (
    <div data-lantern-row={w ? undefined : ""} data-lantern-need={w ? "" : undefined}
      className="agx-card agx-lantern-card relative flex flex-col gap-2.5 p-4 min-w-0"
      style={w ? { borderColor: wash(tone.slice(4, -1), 50), background: `linear-gradient(180deg, ${wash(tone.slice(4, -1), 11)}, var(--surface-card) 55%)` } : undefined}>
      {/* who */}
      <div className="flex items-start gap-2.5 min-w-0">
        <span aria-hidden className="shrink-0 rounded-full mt-1" style={{ width: 8, height: 8, background: tone, boxShadow: w || r.state === "working" ? `0 0 8px ${tone}` : "none" }} />
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`${quiet ? "text-[12px]" : "text-[13.5px]"} font-semibold truncate`} style={{ color: w || r.state === "working" ? "var(--text)" : "var(--text2)" }} title={r.name}>{r.name}</span>
            {r.role === "lantern" && <Pill tone="var(--text4)" title="The Lantern's own chat">lantern</Pill>}
            <span className="ml-auto shrink-0 flex items-center gap-1.5">
              {!w && <Pill tone={tone} title={r.state === "working" ? "something ran in the last ten minutes" : "nothing has run for ten minutes"}>{r.state}</Pill>}
              {model && <Pill tone="var(--text3)" title={f?.model}>{model}</Pill>}
              {since ? <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }} title={new Date(since).toLocaleString()}>{fmtAgo(since)}</span> : null}
            </span>
          </div>
          <Where r={r} />
        </div>
      </div>

      {/* what it needs — leads, in the notification's own words */}
      {w && (
        <div className="flex items-start gap-2 min-w-0 rounded-md px-2.5 py-2" style={{ background: wash(tone.slice(4, -1), 12), border: `1px solid ${wash(tone.slice(4, -1), 30)}` }}>
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[10px] uppercase tracking-wide shrink-0 font-medium" style={{ color: tone }}>{waitWord(w)}</span>
              <span className="ml-auto text-[10.5px] tabular-nums shrink-0" style={{ color: tone }} title={`Stopped on you since ${new Date(w.since).toLocaleString()}`}>for {fmtAgo(w.since)}</span>
            </div>
            {w.why && <div className="text-[11.5px]" style={{ color: "var(--text)" }}>{w.why}</div>}
          </div>
        </div>
      )}

      {/* what it is doing, what it was asked */}
      {(now || (!quiet && f?.lastAsk)) && (
        <div className="flex flex-col gap-1 min-w-0">
          {now && (
            <div className="flex items-start gap-2 min-w-0">
              <Label tone={r.state === "working" ? "var(--success)" : undefined}>now</Label>
              <div className="flex-1 min-w-0 flex flex-col">
                <span className="text-[11.5px] leading-snug line-clamp-2" style={{ color: "var(--text)" }} title={now.text}>{now.text}</span>
                <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>
                  {now.tag}{now.at ? ` · ${fmtAgo(now.at)} ago` : ""}
                </span>
              </div>
            </div>
          )}
          {!quiet && f?.lastAsk && (
            <div className="flex items-start gap-2 min-w-0">
              <Label>asked</Label>
              <span className="flex-1 min-w-0 text-[11px] leading-snug line-clamp-2" style={{ color: "var(--text3)" }} title={f.lastAsk.text}>{f.lastAsk.text}</span>
            </div>
          )}
        </div>
      )}

      {/* what it has done */}
      {(g || f || r.left) && (
        <div className="flex flex-col gap-1 min-w-0">
          {g && (g.ahead > 0 || g.dirty > 0) && (
            <div className="flex items-start gap-2 min-w-0">
              <Label>git</Label>
              <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[10.5px]">
                {g.ahead > 0 && <Fact n={g.ahead} word={g.ahead === 1 ? "commit ahead" : "commits ahead"} tone="var(--primary)" title="commits on this branch its base does not have" />}
                {g.dirty > 0 && <Fact n={g.dirty} word={g.dirty === 1 ? "file changed" : "files changed"} tone="var(--warning)" title="changed and not committed" />}
                {!quiet && g.lastCommit && g.ahead > 0 && (
                  <span className="min-w-0 truncate" style={{ color: "var(--text3)" }} title={`${g.lastCommit.subject} · ${new Date(g.lastCommit.at).toLocaleString()}`}>
                    last: {g.lastCommit.subject}
                  </span>
                )}
              </div>
            </div>
          )}
          {r.left && (
            <div className="flex items-start gap-2 min-w-0">
              <Label>left</Label>
              <span className="flex-1 min-w-0 text-[11px] truncate" style={{ color: "var(--text2)" }} title={r.left}>{r.left}</span>
            </div>
          )}
        </div>
      )}

      {/* the strip: numbers, and Go in its own slot — only when either exists */}
      {(r.paneId || (f && (f.tools > 0 || f.turns > 0 || f.cost > 0))) && (
      <div className="flex items-center gap-3 min-w-0 pt-1" style={{ borderTop: edge(8) }}>
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
          {f && f.tools > 0 && <Fact n={count(f.tools)} word="calls" />}
          {f && f.turns > 0 && <Fact n={count(f.turns)} word={f.turns === 1 ? "turn" : "turns"} />}
          {f && f.errors > 0 && <Fact n={f.errors} word={f.errors === 1 ? "error" : "errors"} tone="var(--warning)" />}
          {f && f.cost > 0 && <Fact n={money(f.cost)} word="" title="what this session has cost so far" />}
          {f?.permissionMode === "bypassPermissions" && <Pill tone="var(--warning)" title="running with permission prompts off">yolo</Pill>}
          {cache && !quiet && (cache.warm
            ? <span className="tabular-nums" style={{ color: "var(--success)" }} title="The prompt cache is still warm: a turn sent now is the cheap one (Settings → Agents → Lantern sets the window)">cache {mmss(cache.leftMs)}</span>
            : <span style={{ color: "var(--text4)" }} title="The prompt cache has gone cold: the next turn pays to rebuild it">cache cold</span>)}
          {f?.startedAt && !quiet && <span style={{ color: "var(--text4)" }} title={new Date(f.startedAt).toLocaleString()}>started {agoSentence(f.startedAt)}</span>}
          {!quiet && r.session && r.role !== "lantern" && kinds && kinds.length > 0 && <HandOff session={r.session} kinds={kinds} />}
        </div>
        <Go paneId={r.paneId} onJump={onJump} big={!!w} />
      </div>
      )}
    </div>
  );
}

/** Kept names for the two shapes the field has: stopped on you, and not. */
export function NeedsYouCard(p: { r: LanternRow; onJump?: (paneId: string) => void }) { return <AgentCard {...p} />; }
export function LanternLine(p: { r: LanternRow; onJump?: (paneId: string) => void; quiet?: boolean }) { return <AgentCard {...p} />; }

const GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 14, alignItems: "start" };

export function LanternView({ active }: { active: boolean }) {
  const all = useSyncExternalStore((l) => subscribeLantern(l, active), lanternRows, lanternRows);
  const failed = useSyncExternalStore((l) => subscribeLantern(l, false), lanternFailed, lanternFailed);
  const watch = useSyncExternalStore((l) => subscribeLantern(l, false), lanternWatch, lanternWatch);
  const cacheTtlMs = useSyncExternalStore((l) => subscribeLantern(l, false), lanternCacheTtlMs, lanternCacheTtlMs);
  const [showIdle, setShowIdle] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  /* Scheduled starts: read with the view, refreshed after a change. */
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [checkouts, setCheckouts] = useState<string[]>([]);
  const [scheduling, setScheduling] = useState(false);
  /* The agent CLIs on this machine, for the cards' hand-off. Read once per open. */
  const [kinds, setKinds] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!active) return;
    api.agentKinds().then((r) => setKinds((r.agents ?? []).filter((a) => a.installed).map((a) => ({ id: a.id, title: a.title })))).catch(() => {});
  }, [active]);
  const readSchedules = useCallback(() => {
    api.agentSchedules().then((r) => { if (r.ok && r.result) setSchedules(r.result.schedules); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!active) return;
    readSchedules();
    api.agentCheckouts().then((r) => setCheckouts(r.allowed ?? [])).catch(() => {});
    const t = setInterval(readSchedules, 30_000);
    return () => clearInterval(t);
  }, [active, readSchedules]);
  const cancelSchedule = useCallback((id: string) => { void api.agentUnschedule(id).then(readSchedules).catch(() => {}); }, [readSchedules]);
  const jump = useCallback((paneId: string) => { jumpToPane(paneId); }, []);
  /* The chat, on the floating bench — over this view, and from any other.
     See lanternAsk.ts. */
  const ask = useCallback(async () => {
    setAsking("opening…");
    const r = await askLantern();
    setAsking(r.ok ? null : r.error ?? "could not open");
  }, []);

  /* The observer is not on the field it observes: the Lantern's own chat is
     set aside, never counted, never "needs you". */
  const rows = all?.filter((r) => r.role !== "lantern") ?? null;
  /* "Back to the chat" only while the bench actually holds its tab — the
     board's row for a chat that was just ended lingers a few minutes. */
  const lanternOpen = useSyncExternalStore(subscribeBench, hasLanternTab, hasLanternTab);
  /* Two kinds of "needs you", and only one of them is urgent. A permission
     or a held gate is an agent that CANNOT go on without you — red, counted
     on the rail. A turn that ended is an agent that finished and is waiting
     for whatever you say next — amber, its own group, not a number on the
     rail: every session that ever answers you would otherwise be red until
     you typed again. */
  const need = rows?.filter((r) => r.needsYou && r.needsYou.kind !== "input") ?? [];
  const finished = rows?.filter((r) => r.needsYou?.kind === "input") ?? [];
  const working = rows?.filter((r) => !r.needsYou && r.state === "working") ?? [];
  const idle = rows?.filter((r) => !r.needsYou && r.state === "idle") ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <ViewHeader label="Lantern"
        actions={
          <>
            {failed && <span className="text-[10.5px]" style={{ color: "var(--warning)" }} title="The last read failed; this is the previous answer">stale</span>}
            <button type="button" onClick={() => { void refreshLantern(); }} className="agx-btn text-[10.5px] px-2 py-0.5 rounded" style={{ color: "var(--text3)", border: edge(20) }} title="Read the field again now">Refresh</button>
            {rows && (
              <button type="button" onClick={() => setScheduling(true)}
                className="agx-btn text-[10.5px] px-2 py-0.5 rounded" style={{ color: "var(--text3)", border: edge(20) }}
                title="Start an agent later: at a clock time, a date-time, or after a delay">⏰ Schedule…</button>
            )}
            {rows && (
              <button type="button" onClick={() => { void ask(); }} disabled={asking === "opening…"}
                className="agx-btn text-[10.5px] px-2 py-0.5 rounded disabled:opacity-60" style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
                title="A chat on the floating bench that opens with this field as its first message — ask in your own words. Ctrl+Alt+A brings it back from any view.">
                {asking === "opening…" ? "Opening…" : lanternOpen ? "Back to the chat" : "Ask about the agents"}
              </button>
            )}
            {asking && asking !== "opening…" && <span className="text-[10.5px]" style={{ color: "var(--error)" }}>{asking}</span>}
          </>
        }>
        {/*
         * THE FIRST LINE IS THE ANSWER. Lantern's opening sentence: who needs
         * you, then the size of the field. Calm when nobody does — a screen
         * that shouts about sixteen idle agents is a screen you stop opening.
         */}
        <span className="text-[12px]" style={{ color: need.length ? "var(--error)" : "var(--text2)" }}>
          {rows === null ? "reading the agents…"
            : need.length ? `${need.length} agent${need.length === 1 ? "" : "s"} need${need.length === 1 ? "s" : ""} you`
            : rows.length ? "Nobody needs you right now"
            : "Nobody is around"}
        </span>
        {finished.length > 0 && (
          <span className="text-[10.5px]" style={{ color: "var(--warning)" }} title="Turns that ended and are waiting for whatever you say next">
            {finished.length} finished, waiting for you
          </span>
        )}
        {rows !== null && rows.length > 0 && (
          <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>
            {working.length} working · {idle.length} idle
          </span>
        )}
        {/* The watch's one line: that it looks, how often, and what the last
            look found — so "nothing" is a fact with a time on it. */}
        {watch && (
          <span className="text-[10.5px]" style={{ color: "var(--text4)" }}
            title={watch.on ? "The field is re-read on this clock and one notification goes out when something needs you (Settings → Agents → Lantern)" : "Turn the watch on in Settings → Agents → Lantern"}>
            {watch.on
              ? watch.at ? `· watched every ${watch.every} min — last look ${fmtAgo(watch.at)} ago${watch.flagged ? `, ${watch.flagged} flagged` : ", nothing flagged"}` : `· watched every ${watch.every} min`
              : "· watch off"}
          </span>
        )}
      </ViewHeader>

      <div className="flex-1 min-h-0 overflow-y-auto agx-scroll px-5 py-4 flex flex-col gap-6" style={{ background: "var(--bg)" }}>
        {rows !== null && rows.length === 0 && (
          <div className="text-[11.5px] max-w-[70ch]" style={{ color: "var(--text3)" }}>
            An agent appears here when its hooks are wired (Settings → Agents), when it says what it is
            doing — <code>POST /agents/status</code>, which the Lantern reminder asks for — or when the
            Clone starts a run. Nothing is inferred from a window being open: a screen that guesses is a
            screen that lies.
          </div>
        )}

        {need.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--error)" }}>Needs you · {need.length}</div>
            <div style={GRID}>
              {need.map((r) => <AgentCard key={r.paneId ?? r.name} r={r} onJump={jump} cacheTtlMs={cacheTtlMs} kinds={kinds} />)}
            </div>
          </section>
        )}

        {finished.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--warning)" }}>Finished · waiting for you · {finished.length}</div>
            <div style={GRID}>
              {finished.map((r) => <AgentCard key={r.paneId ?? r.name} r={r} onJump={jump} cacheTtlMs={cacheTtlMs} kinds={kinds} />)}
            </div>
          </section>
        )}

        {working.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Working · {working.length}</div>
            <div style={GRID}>
              {working.map((r) => <AgentCard key={r.paneId ?? r.name} r={r} onJump={jump} cacheTtlMs={cacheTtlMs} kinds={kinds} />)}
            </div>
          </section>
        )}

        <ScheduledSection items={schedules} onCancel={cancelSchedule} />

        {idle.length > 0 && (
          <section className="flex flex-col gap-2">
            {/* Folded by default: on a real machine sixteen of eighteen rows
                were idle, and a grid that is mostly the quiet ones is the grid
                the two that matter disappear into. The count stays visible;
                the cards are one press away, and smaller when they come. */}
            <button type="button" onClick={() => setShowIdle((v) => !v)} aria-expanded={showIdle}
              className="agx-btn text-[9.5px] uppercase tracking-[0.14em] inline-flex items-center gap-1.5 self-start" style={{ color: "var(--text4)" }}>
              <span aria-hidden style={{ display: "inline-block", transform: showIdle ? "none" : "rotate(-90deg)" }}>▾</span>
              Idle · {idle.length}
            </button>
            {showIdle && (
              <div style={{ ...GRID, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
                {idle.map((r) => <AgentCard key={r.paneId ?? r.name} r={r} onJump={jump} quiet cacheTtlMs={cacheTtlMs} />)}
              </div>
            )}
          </section>
        )}
      </div>
      <ScheduleDialog open={scheduling} checkouts={checkouts} onClose={() => setScheduling(false)} onAdded={readSchedules} />
    </div>
  );
}
