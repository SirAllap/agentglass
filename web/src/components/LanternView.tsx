import { useState } from "react";
import { fmtAgo, since as agoSentence } from "../lib/format.ts";
import { originLine, type Origin } from "../../../shared/orchestration.ts";
import { wash } from "./git/ui.tsx";
import { modelLabelOf } from "../../../shared/models.ts";
import { handOff } from "../lib/lanternAsk.ts";
import { LINE } from "./workspace/Chrome.tsx";
import { ICON, MIN_BOX } from "../lib/iconSize.ts";
import { CloseButton } from "./CloseButton.tsx";

/**
 * THE LANTERN'S ROWS. What the board says about one agent, and the card that
 * draws one.
 *
 * The Lantern was a screen of its own: who needs you, what every agent is
 * working on, and the way there. It is one screen with the project's chair now
 * (components/agents/AgentsView.tsx), which draws the same rows as a table.
 * What stays here is what other places still import: the row's shape, the
 * chair's, the watch's, and `AgentCard`, which the Settings preview of the
 * Lantern draws. The card is a record of every fact the board keeps about an
 * agent: a card with nothing to say on a line leaves the line out rather than
 * drawing a dash.
 */
export interface LanternRow {
  name: string;
  /** The Lantern's own session, when it is on the field: shown aside, never
   *  counted. Or the project's seat, which the view counts like any agent.
   *  The server's BoardRow.role, both values. */
  role?: "lantern" | "orchestrator";
  /** The project whose chair started this worker, while that chair is occupied. */
  under?: string;
  /** Started by a chair that is not in its seat any more. */
  orphaned?: true;
  /** How the policy started it: kept on the row, so it outlives a restart. */
  startedBy?: Origin;
  /** On the orchestrator's own row: the project it sits for. */
  chairOf?: string;
  doing?: string;
  saidAt?: number;
  startedAt?: number;
  worktree?: string;
  branch?: string;
  left?: string;
  paneId?: string;
  /** What this session called itself before, newest first — see BoardRow.
   *  wasCalled. One card per session; these are the names it folded in. */
  wasCalled?: string[];
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
  /** No pane this machine can see and quiet for hours: a name, not somebody
   *  to talk to. Marked by the server (`isGone`), folded by the view. */
  gone?: boolean;
  /** Who this is and what it has done — see SessionFacts on the server. */
  facts?: {
    model?: string; tools: number; errors: number; turns: number; cost: number;
    startedAt?: number; lastSeen?: number;
    lastTool?: { name: string; what: string; at: number };
    lastAsk?: { text: string; at: number };
    permissionMode?: string;
  };
  /** The last hour of tool calls, twelve five-minute counts, oldest first. */
  pulse?: number[];
  /** Its checkout, as git sees it — see GitFacts on the server. */
  git?: { dirty: number; ahead: number; lastCommit?: { subject: string; at: number }; at: number };
}

/** One occupied chair, riding on the board's answer: what the policy would
 *  seat instead (`next`) and whether the seat has written down what it knows. */
export interface LanternChair {
  root: string; name: string; kind: string; model: string;
  next: { engine: string; model: string } | null;
  handedOff: boolean;
  /** The person's own session, adopted into the chair. */
  adopted?: boolean;
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
      {r.branch && <span className="truncate" style={{ color: "var(--primary-ink)" }} title={`branch ${r.branch}`}>{r.branch}</span>}
      {r.branch && r.landed === true && (
        <span className="shrink-0" style={{ color: "var(--success-ink)" }} title={`already merged into ${r.landedInto || "the base"}`}>· in {r.landedInto || "the base"}</span>
      )}
      {r.branch && r.landed === false && (
        <span className="shrink-0" style={{ color: "var(--warning-ink)" }} title={`nobody has merged this into ${r.landedInto || "the base"}`}>· not in {r.landedInto || "the base"}</span>
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
      {err && <span className="text-[10px]" style={{ color: "var(--error-ink)" }}>{err}</span>}
    </span>
  );
}

export function AgentCard({ r, onJump, onClear, quiet, cacheTtlMs, kinds }: { r: LanternRow; onJump?: (paneId: string) => void; onClear?: (name: string) => void; quiet?: boolean; cacheTtlMs?: number; kinds?: { id: string; title: string }[] }) {
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
            {r.role === "lantern" && <Pill tone="var(--text4)" title="The Lantern's own session">lantern</Pill>}
            <span className="ml-auto shrink-0 flex items-center gap-1.5">
              {!w && <Pill tone={tone} title={r.state === "working" ? "something ran in the last ten minutes" : "nothing has run for ten minutes"}>{r.state}</Pill>}
              {model && <Pill tone="var(--text3)" title={f?.model}>{model}</Pill>}
              {since ? <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }} title={new Date(since).toLocaleString()}>{fmtAgo(since)}</span> : null}
              {/* A line a person can take off the board, whoever posted it.
                  Only a said line: a seen row is a hook's sighting and leaves
                  with its pane. Never on a card stopped on you. */}
              {onClear && r.from === "said" && !w && (
                <CloseButton size={ICON.xs} hit={MIN_BOX} onClick={(e) => { e.stopPropagation(); onClear(r.name); }}
                  style={{ color: "var(--text4)" }} title="Clear this line from the board, whoever posted it" />
              )}
            </span>
          </div>
          {(r.startedBy || r.orphaned || (r.under && w)) && (
            <div className="flex items-center gap-1.5 min-w-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
              {/* What is wrong comes first, so a long origin cuts its own tail and never the warning. */}
              {r.orphaned && <span className="shrink-0" style={{ color: "var(--warning-ink)" }} title="The orchestrator that started this worker is not in its chair, so nobody is reading its reports">its orchestrator is gone</span>}
              {r.under && w && <span className="shrink-0" title="Its orchestrator's project">under {here(r.under)}'s chair</span>}
              {r.startedBy && <span className="truncate min-w-0" title={originLine(r.startedBy)}>{r.orphaned || (r.under && w) ? "· " : ""}{originLine(r.startedBy)}</span>}
            </div>
          )}
          <div className="flex items-center gap-1.5 min-w-0">
            <Where r={r} />
            {/*
             * The names this session posted under before.
             *
             * On the metadata line and not beside the title: up there it
             * competed with the one thing the card is read by, and turned
             * `limpieza-worktrees-2026-09-07` into `limpieza-worktree…` to
             * make room for itself. A card that hides its own name to explain
             * its history has the priority backwards. Down here there is room,
             * and it sits with the rest of what this row IS.
             */}
            {r.wasCalled?.length ? (
              <span className="text-[10px] shrink-0" style={{ color: "var(--text4)" }}
                title={`Same session, earlier names: ${r.wasCalled.join(", ")}`}>
                · was {r.wasCalled[0]}{r.wasCalled.length > 1 ? ` +${r.wasCalled.length - 1}` : ""}
              </span>
            ) : null}
          </div>
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
            {/* The notification's own words — a paragraph somebody's session wrote,
                not a label the app composed, so it reads in the prose face like a
                pull request body or a comment (docs/design-system.md, Principles). */}
            {w.why && <div className="text-[11.5px]" style={{ color: "var(--text)", fontFamily: "var(--font-prose)" }}>{w.why}</div>}
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
                <span className="text-[11.5px] leading-snug line-clamp-2" style={{ color: "var(--text)", fontFamily: "var(--font-prose)" }} title={now.text}>{now.text}</span>
                <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>
                  {now.tag}{now.at ? ` · ${fmtAgo(now.at)} ago` : ""}
                </span>
              </div>
            </div>
          )}
          {!quiet && f?.lastAsk && (
            <div className="flex items-start gap-2 min-w-0">
              <Label>asked</Label>
              <span className="flex-1 min-w-0 text-[11px] leading-snug line-clamp-2" style={{ color: "var(--text3)", fontFamily: "var(--font-prose)" }} title={f.lastAsk.text}>{f.lastAsk.text}</span>
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
      <div className="flex items-center gap-3 min-w-0 pt-1" style={{ borderTop: LINE }}>
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
          {f && f.tools > 0 && <Fact n={count(f.tools)} word="calls" />}
          {f && f.turns > 0 && <Fact n={count(f.turns)} word={f.turns === 1 ? "turn" : "turns"} />}
          {f && f.errors > 0 && <Fact n={f.errors} word={f.errors === 1 ? "error" : "errors"} tone="var(--warning)" />}
          {f && f.cost > 0 && <Fact n={money(f.cost)} word="" title="what this session has cost so far" />}
          {f?.permissionMode === "bypassPermissions" && <Pill tone="var(--warning)" title="running with permission prompts off">yolo</Pill>}
          {cache && !quiet && (cache.warm
            ? <span className="tabular-nums" style={{ color: "var(--success-ink)" }} title="The prompt cache is still warm: a turn sent now is the cheap one (Settings → Agents → Lantern sets the window)">cache {mmss(cache.leftMs)}</span>
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

