import { useCallback, useEffect, useState } from "react";
import { fmtAgo } from "../lib/format.ts";
import { jumpToPane } from "../lib/paneJump.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { edge, wash } from "./git/ui.tsx";
import { whatWaits } from "../lib/seatWaiting.ts";
import { api, type SeatAnswer, type SeatTask, type SeatFieldRow, type SeatReportRow } from "../lib/api.ts";
import { Persona } from "./understudy/persona/Persona.tsx";
import { useCosmetic } from "./understudy/persona/cosmeticStore.ts";

/**
 * THE ORCHESTRATOR — who is minding this project, and what they have to go on.
 *
 * The first version of this screen was honest and flat: a card, a list, three
 * boxes and half a page of nothing. What it lacked was not decoration, it was
 * INFORMATION. Every fact on it was a word you had to take on trust, and the
 * three things added here are the same move three times — draw what the app
 * already knows instead of describing it:
 *
 *   the pulse  twelve five-minute counts of tool calls per agent. "Quiet for
 *              an hour" is a claim; a row of bars that falls off a cliff is a
 *              thing you see, and it is what makes a stalled agent findable
 *              without reading.
 *   the dial   how long until the floor wakes the seat. Silence at ten minutes
 *              and silence at four hours are different facts, and only the
 *              second one means nobody is coming.
 *   its day    the last few lines it said. A status light becomes the shape of
 *              a working day, which is the thing you open on a Monday.
 *
 * Deliberately NOT here: the board. The Lantern draws every agent on the
 * machine properly, and two screens drawing the same thing are two screens
 * that can disagree. This is the shortlist for THIS project, with a way across.
 *
 * Motion: only things that are actually moving. The dial's arc, and nothing
 * else — no fade-up on scroll, no lift on hover, no count-up. A row warms and
 * its meaning stays put.
 */
const POWERS: { id: "speak" | "nudge" | "assign"; label: string; what: string }[] = [
  { id: "speak", label: "Speaks", what: "Reads the field and reports. Touches no agent." },
  { id: "nudge", label: "Unsticks", what: "Can prompt an agent that is already running." },
  { id: "assign", label: "Assigns", what: "Can prompt, start and stop named agents." },
];

const here = (p: string) => p.replace(/^\/home\/[^/]+\//, "~/");
const HOUR = 3_600_000;

/** The state colour, decided once, so the field's dot and the queue's rail
 *  cannot drift into two vocabularies for one idea. */
function toneOf(r: SeatFieldRow): string {
  if (r.needsYou) return r.needsYou.kind === "input" ? "--warning" : "--error";
  if (r.state === "working") return "--success";
  return "--text4";
}

function whyLine(r: SeatFieldRow, now: number): string {
  if (r.needsYou) {
    const word = r.needsYou.kind === "permission" ? "permission" : r.needsYou.kind === "gate" ? "at the gate" : "waiting on you";
    return `${word}, ${fmtAgo(r.needsYou.since)}`;
  }
  if (r.state === "working") return r.saidAt ? fmtAgo(r.saidAt) : "working";
  if (r.saidAt && now - r.saidAt > HOUR) return `quiet, ${fmtAgo(r.saidAt)}`;
  return "idle";
}

/**
 * The last hour, as twelve marks.
 *
 * Zero-filled by the server and drawn zero-filled: an empty bucket is the fact
 * worth seeing, and dropping it would give a busy agent and a stopped one the
 * same shape.
 */
function Pulse({ pulse, tone }: { pulse: number[]; tone: string }) {
  const max = Math.max(4, ...pulse);
  const total = pulse.reduce((a, b) => a + b, 0);
  const title = `${total} tool call${total === 1 ? "" : "s"} in the last hour`;
  return (
    <span className="inline-flex items-end gap-px shrink-0" style={{ height: 16 }} title={title} aria-label={title}>
      {pulse.map((n, i) => (
        <span key={i} style={{
          width: 3, borderRadius: 1,
          height: Math.max(2, Math.round((n / max) * 16)),
          background: n > 0 ? wash(tone, 70) : "var(--bg4)",
        }} />
      ))}
    </span>
  );
}

/** The countdown to the floor, drawn round the face. Not a badge: the gap
 *  itself is the information. */
function Dial({ live, wokenAt, floorHours, cos }: {
  live: boolean; wokenAt: number | null; floorHours: number; cos: ReturnType<typeof useCosmetic>;
}) {
  const span = Math.max(1, floorHours) * HOUR;
  const left = wokenAt ? Math.max(0, span - (Date.now() - wokenAt)) : span;
  const frac = Math.min(1, Math.max(0, left / span));
  const R = 30;
  const C = 2 * Math.PI * R;
  const title = !live ? "Nobody is in this seat."
    : wokenAt ? `Woken ${fmtAgo(wokenAt)} ago. Next look within ${Math.max(1, Math.ceil(left / HOUR))} h, or sooner if the field changes.`
      : `Nothing has changed since it sat down. Woken within ${floorHours} h, or sooner if the field does.`;
  return (
    <div className="relative shrink-0" style={{ width: 66, height: 66 }} title={title}>
      <svg viewBox="0 0 66 66" width={66} height={66} className="absolute inset-0" style={{ transform: "rotate(-90deg)" }} aria-hidden>
        <circle cx="33" cy="33" r={R} fill="none" stroke="var(--bg4)" strokeWidth="2.5" />
        {live && (
          <circle cx="33" cy="33" r={R} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - frac)} style={{ transition: "stroke-dashoffset .6s ease" }} />
        )}
      </svg>
      <div className="absolute rounded-full overflow-hidden flex items-center justify-center"
        style={{ inset: 6, background: "var(--bg3)", opacity: live ? 1 : 0.45, filter: live ? undefined : "grayscale(0.6)" }}>
        <Persona px={54} cos={cos} label={live ? "The orchestrator" : "The empty seat"} />
      </div>
      {live && (
        <span aria-hidden className="absolute rounded-full"
          style={{ right: 0, bottom: 2, width: 12, height: 12, background: "var(--success)", border: "2.5px solid var(--bg)" }} />
      )}
    </div>
  );
}

export function SeatView({ onLantern }: { onLantern?: () => void }) {
  const [data, setData] = useState<SeatAnswer | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [openRules, setOpenRules] = useState(false);
  const [adding, setAdding] = useState("");
  const [proof, setProof] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [saying, setSaying] = useState("");
  const [sentTo, setSentTo] = useState("");
  const cos = useCosmetic();

  const load = useCallback(async () => {
    try {
      const r = await api.seat();
      setData(r);
      setError(!r.ok && r.error ? r.error : "");
    } catch { setError("could not read the seat"); }
  }, []);

  useEffect(() => {
    void load();
    /* The seat says a line a few times an hour and the pulse moves in
       five-minute steps: a quarter minute is current enough and rare enough
       to cost nothing. */
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const root = data?.root ?? "";
  const seat = data?.seat ?? null;
  const powers = seat?.powers ?? "speak";
  const live = data?.live === true;
  const power = POWERS.find((p) => p.id === powers)!;
  const tasks: SeatTask[] = data?.tasks ?? [];
  const waiting = tasks.filter((t) => !t.doneAt && !t.takenAt && t.attempts < 2);
  const out = tasks.filter((t) => !t.doneAt && t.takenAt);
  const stuck = tasks.filter((t) => !t.doneAt && !t.takenAt && t.attempts >= 2);
  const done = tasks.filter((t) => t.doneAt);
  const field = data?.field ?? [];
  const need = field.filter((r) => r.needsYou);
  /*
   * NAMES THAT ARE NOT AGENTS ANY MORE.
   *
   * Measured on this screen: seventeen rows, thirteen of them sessions that
   * had ended a day or two earlier, and one a pane left behind by a stopped
   * agent. The server marks them (`isGone`) and the CLI's readout already
   * folded them; this screen went on drawing all seventeen, which is what made
   * a field of four reachable agents read as a crowd.
   */
  const reachable = field.filter((r) => !r.gone);
  const past = field.filter((r) => r.gone);
  const models = data?.models ?? [];
  const chosen = seat?.model || data?.defaultModel || "";
  const lines = data?.lines ?? [];
  const reports: SeatReportRow[] = data?.reports ?? [];
  const now = Date.now();
  /* Nothing came back, or what came back was a refusal: everything below is
     unknown, not empty. */
  const unread = data === null || data.ok === false;
  /*
   * ADOPTED SEATS WEAR THE LABEL, NOT THE CREDENTIAL.
   *
   * A seat this app OPENS gets a token of its own, and `speak` is then a wall:
   * the server refuses its prompt. A seat that was already running when it
   * adopted the chair holds the machine's token like any other session, and
   * nothing here can take that away from a process that already exists. So the
   * strip says which it is. Claiming a wall this app is not holding would be
   * the worst kind of lie a permissions control can tell.
   */
  const adopted = !!seat?.adoptedPane && live;
  const shown = [...waiting, ...stuck, ...out, ...(showDone ? done : done.slice(0, 1))];

  /*
   * WHAT IS WAITING ON YOU — the first thing on the screen, because it is the
   * question the screen exists to answer. The rule lives in `whatWaits`, with
   * its tests; this only draws it.
   */
  const wait = whatWaits(field, reports, tasks);
  const { stopped: stoppedOnYou, asked, orphaned, beaten } = wait;
  const waitingCount = wait.count;

  const act = async (what: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(what); setError("");
    try {
      const r = await fn();
      if (!r.ok && r.error) setError(r.error);
    } catch { setError("that did not go through"); }
    finally { setBusy(""); await load(); }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <ViewHeader label="Orchestrator"
        actions={
          <>
            {live && data?.agent?.paneId && (
              <button type="button" onClick={() => jumpToPane(data.agent!.paneId)}
                className="agx-btn text-[11px] px-2.5 py-1 rounded font-medium"
                style={{ color: "var(--text)", background: wash("--primary", 18), border: `1px solid ${wash("--primary", 45)}` }}
                title="Open the pane it is working in">Go to its pane</button>
            )}
            {live
              ? <button type="button" disabled={!!busy} onClick={() => void act("closing", () => api.seatClose(root))}
                  className="agx-btn text-[10.5px] px-2 py-0.5 rounded disabled:opacity-60" style={{ color: "var(--text3)", border: edge(20) }}
                  title="Empty the chair. Its rules and its settings are kept.">{busy === "closing" ? "Standing down…" : "Stand down"}</button>
              : <button type="button" disabled={!!busy || !root} onClick={() => void act("opening", () => api.seatOpen(root))}
                  className="agx-btn text-[11px] px-2.5 py-1 rounded font-medium disabled:opacity-60"
                  style={{ color: "var(--text)", background: wash("--primary", 22), border: `1px solid ${wash("--primary", 50)}` }}
                  title="Seat an agent in this project's chair, with the rules below">{busy === "opening" ? "Seating…" : "Take the seat"}</button>}
          </>
        }>
        <span className="text-[12px]" style={{ color: live ? "var(--text2)" : "var(--text4)" }}>
          {unread ? "could not read the seat" : live ? "Somebody is minding this project" : "Nobody is minding this project"}
        </span>
        {root && <span className="text-[10.5px] truncate" style={{ color: "var(--text4)" }} title={root}>· {here(root)}</span>}
        {error && <span className="text-[10.5px]" style={{ color: "var(--error)" }}>{error}</span>}
      </ViewHeader>

      {/*
       * EACH COLUMN SCROLLS ON ITS OWN.
       *
       * One scroller over both put the seat's own sentence — the reason to
       * open this view — off the top of the screen as soon as somebody read
       * down a field of twenty agents. The header stays, the sentence stays,
       * and the long list moves under them.
       */}
      <div className="flex-1 min-h-0 overflow-hidden" style={{ background: "var(--bg)" }}>
        <div className="grid h-full" style={{ gridTemplateColumns: "minmax(0,1.7fr) minmax(0,1fr)" }}>
          {/* ── what it said, and the work ─────────────────────────── */}
          <div className="flex flex-col gap-5 px-5 py-4 min-w-0 min-h-0 overflow-y-auto agx-scroll" style={{ borderRight: "1px solid var(--border)" }}>
            <div className="flex gap-3.5 items-start">
              <Dial live={live} wokenAt={data?.wokenAt ?? null} floorHours={data?.floorHours ?? 4} cos={cos} />
              <div className="flex flex-col gap-1.5 min-w-0 pt-0.5">
                <p className="text-[15.5px] leading-snug max-w-[92ch]"
                  style={{ color: unread ? "var(--warning)" : seat?.lastLine ? "var(--text)" : "var(--text4)" }}>
                  {unread ? "This screen could not read the seat, so it cannot say who is minding this project."
                    : seat?.lastLine
                    || (live ? "It has not said anything yet. It reports once it has read the field."
                      : "Nobody has sat here yet. Take the seat and it will read the field and report.")}
                </p>
                <div className="flex flex-wrap items-center gap-x-1.5 text-[10.5px]" style={{ color: "var(--text3)" }}>
                  {seat?.lastTurnAt ? <><span>said {fmtAgo(seat.lastTurnAt)} ago</span><span style={{ color: "var(--text4)" }}>·</span></> : null}
                  {lines.length > 1 ? <><span>{lines.length} rounds kept</span><span style={{ color: "var(--text4)" }}>·</span></> : null}
                  <span>{live ? "woken on a change" : "chair empty"}</span>
                  <span style={{ color: "var(--text4)" }}>·</span>
                  <span title={power.what}>{power.label.toLowerCase()}</span>
                  {chosen ? <><span style={{ color: "var(--text4)" }}>·</span><span>{models.find((m) => m.id === chosen)?.label ?? chosen}</span></> : null}
                </div>
              </div>
            </div>

            {/* WHAT IS WAITING ON YOU. First, and quiet when there is nothing:
                a heading over an empty box is a screen that cries wolf, and
                "nobody needs you" is an answer worth reading. */}
            <section className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>Waiting on you</h2>
                <span className="text-[11px]" style={{ color: waitingCount ? "var(--warning)" : "var(--text3)" }}>
                  {waitingCount ? `${waitingCount} ${waitingCount === 1 ? "thing" : "things"}` : "nothing right now"}
                </span>
              </div>
              {waitingCount === 0 ? (
                <p className="text-[11px] max-w-[80ch]" style={{ color: "var(--text4)" }}>
                  Nobody is stopped, nothing is asking for a decision, and no task has beaten two agents.
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {stoppedOnYou.map((r) => (
                    <li key={`s-${r.name}`} className="flex items-start gap-2.5 py-1">
                      <span aria-hidden className="shrink-0 self-stretch" style={{ width: 2, borderRadius: 2, background: "var(--error)" }} />
                      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <span className="text-[12.5px] leading-snug" style={{ color: "var(--text)" }}>
                          <span style={{ color: "var(--text2)" }}>{r.name}</span> is stopped at a prompt
                        </span>
                        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{r.needsYou?.why}</span>
                      </span>
                      <span className="shrink-0 flex items-center gap-2 text-[10.5px] whitespace-nowrap pt-0.5" style={{ color: "var(--text3)" }}>
                        {r.needsYou ? fmtAgo(r.needsYou.since) : ""}
                        {r.paneId && (
                          <button type="button" onClick={() => jumpToPane(r.paneId!)}
                            className="agx-btn text-[10px] rounded px-1.5 py-0.5" style={{ color: "var(--primary)", border: edge(14) }}>Go</button>
                        )}
                      </span>
                    </li>
                  ))}
                  {asked.map((r) => (
                    <li key={`a-${r.id}`} className="flex items-start gap-2.5 py-1">
                      <span aria-hidden className="shrink-0 self-stretch" style={{ width: 2, borderRadius: 2, background: "var(--warning)" }} />
                      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <span className="text-[12.5px] leading-snug" style={{ color: "var(--text)" }}>
                          <span style={{ color: "var(--text2)" }}>{r.agent}</span> {r.need ? "needs a decision" : "is blocked"}
                        </span>
                        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{r.need || r.blocked}</span>
                      </span>
                      <span className="shrink-0 text-[10.5px] whitespace-nowrap pt-0.5" style={{ color: "var(--text3)" }}>{fmtAgo(r.at)}</span>
                    </li>
                  ))}
                  {orphaned.map((r) => (
                    <li key={`o-${r.id}`} className="flex items-start gap-2.5 py-1">
                      <span aria-hidden className="shrink-0 self-stretch" style={{ width: 2, borderRadius: 2, background: "var(--text4)" }} />
                      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <span className="text-[12.5px] leading-snug" style={{ color: "var(--text)" }}>
                          <span style={{ color: "var(--text2)" }}>{r.agent}</span> stopped and is no longer here
                        </span>
                        {/* The one kind that vanishes if nothing says it: the
                            work is blocked and its owner is gone, so nobody is
                            coming back for it. */}
                        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>left blocked: {r.blocked}</span>
                      </span>
                      <span className="shrink-0 text-[10.5px] whitespace-nowrap pt-0.5" style={{ color: "var(--text4)" }}>{fmtAgo(r.at)}</span>
                    </li>
                  ))}
                  {beaten.map((t) => (
                    <li key={`b-${t.id}`} className="flex items-start gap-2.5 py-1">
                      <span aria-hidden className="shrink-0 self-stretch" style={{ width: 2, borderRadius: 2, background: "var(--warning)" }} />
                      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <span className="text-[12.5px] leading-snug" style={{ color: "var(--text)" }}>{t.title}</span>
                        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
                          has beaten {t.attempts} agents — a third go is not the answer
                        </span>
                      </span>
                      <span className="shrink-0 text-[10.5px] whitespace-nowrap pt-0.5" style={{ color: "var(--text3)" }}>{fmtAgo(t.created)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {live && (data?.screen ?? "").trim() !== "" && (
              /* OVER ITS SHOULDER. The pane it runs in, last few lines, read
                 off tmux on the same poll as everything else. Not a terminal:
                 you cannot type here, and the button beside it goes to the
                 real one. */
              <section className="rounded-md overflow-hidden" style={{ border: edge(14), background: "var(--bg)" }}>
                <div className="flex items-center gap-2 px-3 py-1.5 text-[10.5px]"
                  style={{ color: "var(--text3)", borderBottom: `1px solid var(--border)`, background: "var(--bg2)" }}>
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)" }} />
                  <span>over its shoulder</span>
                  <span style={{ color: "var(--text4)" }}>· pane {data?.agent?.paneId ?? ""}</span>
                  <span className="flex-1" />
                  {data?.agent?.paneId && (
                    <button type="button" onClick={() => jumpToPane(data.agent!.paneId)}
                      className="agx-btn text-[10.5px]" style={{ color: "var(--primary)" }}>Open it</button>
                  )}
                </div>
                {/* No sideways scroll: a pane is 200 columns and this box is
                    not, so a long line WRAPS. The first version had
                    `overflow-x: auto` and gave a person a horizontal scrollbar
                    to read one line of somebody else's terminal, which nobody
                    is going to do. The server has already cut the chrome out
                    (see `shoulder`), so this only draws. */}
                <pre className="px-3 py-2 text-[11px] leading-relaxed"
                  style={{ color: "var(--text3)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {data?.screen}
                </pre>
              </section>
            )}

            {/*
              * THE TRAY — what the agents actually sent, in the shape the brief
              * asks for.
              *
              * The report was already the seat's cheapest way to know: four
              * fields instead of a paragraph, in one call instead of five
              * messages. Drawing it here costs a person nothing and answers the
              * question this screen exists for — who is stuck — without opening
              * anybody's pane. Blocked and needs are the two lines worth a
              * colour; state and cost are the record.
              */}
            {reports.length > 0 && (
              <section className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2.5">
                  <h2 className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>What they sent</h2>
                  <span className="text-[11px]" style={{ color: "var(--text3)" }}>
                    {(data?.unread ?? 0) > 0
                      ? `${data?.unread} the seat has not read yet`
                      : "the seat has read all of these"}
                  </span>
                </div>
                <ul className="flex flex-col">
                  {reports.map((r) => {
                  /*
                   * A BLOCKER FROM AN AGENT THAT IS GONE IS HISTORY.
                   *
                   * Measured on this screen: two reports from a test agent,
                   * dead two hours earlier, still drawn in red and amber as if
                   * somebody were waiting on a decision right now. "Blocked"
                   * is a claim about the present, and the agent that made it
                   * has to still be there for the claim to hold. The words are
                   * kept — what an agent said is the record — they just stop
                   * shouting.
                   */
                  const alive = field.some((f) => !f.gone && f.name === r.agent);
                  return (
                    <li key={r.id} className="flex items-start gap-2.5 py-1.5">
                      <span aria-hidden className="shrink-0 rounded-full"
                        title={r.readAt ? "the seat has read this" : "waiting for the seat"}
                        style={{
                          /* Off the spacing scale on purpose: this centres the
                             dot on the cap height of the 12px name beside it,
                             which is an optical alignment to a glyph and not a
                             gap between two things. */
                          marginTop: 6,
                          width: 6, height: 6,
                          background: r.readAt ? "transparent" : "var(--primary)",
                          border: r.readAt ? "1px solid var(--text4)" : undefined,
                        }} />
                      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <span className="flex items-baseline gap-2 min-w-0">
                          <span className="text-[12px] shrink-0" style={{ color: "var(--text2)" }}>{r.agent}</span>
                          <span className="text-[12.5px] leading-snug min-w-0" style={{ color: "var(--text)" }}>
                            {r.state || "said nothing about its state"}
                          </span>
                        </span>
                        {r.blocked && <span className="text-[11px] leading-snug" style={{ color: alive ? "var(--error)" : "var(--text4)" }}>blocked: {r.blocked}</span>}
                        {r.need && <span className="text-[11px] leading-snug" style={{ color: alive ? "var(--warning)" : "var(--text4)" }}>needs: {r.need}</span>}
                        {!alive && (r.blocked || r.need) && (
                          <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>
                            {r.agent} is no longer on the field — this is what it said, not what is true now
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 flex items-baseline gap-2 text-[10.5px] whitespace-nowrap pt-0.5" style={{ color: "var(--text4)" }}>
                        {r.cost ? <span title="what it says this has cost so far">{r.cost}</span> : null}
                        <span>{fmtAgo(r.at)}</span>
                      </span>
                    </li>
                  );
                  })}
                </ul>
              </section>
            )}

            <section className="flex flex-col gap-2.5">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>The queue</h2>
                <span className="text-[11px]" style={{ color: "var(--text3)" }}>
                  {tasks.length === 0 ? "nothing on the list"
                    : `${waiting.length} waiting, ${out.length} out${stuck.length ? `, ${stuck.length} need you` : ""}${done.length ? `, ${done.length} landed` : ""}`}
                </span>
              </div>

              {/* Two fields: a task with no stated proof is a task whose "done"
                  is somebody's prose. Not required — an unstated proof is
                  allowed and drawn as missing rather than refused, because a
                  made-up proof is worse than an admitted absence. */}
              <form className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = adding.trim();
                  if (!t) return;
                  void act("task", async () => {
                    const r = await api.seatTaskAdd(root, t, proof.trim());
                    if (r.ok) { setAdding(""); setProof(""); }
                    return r;
                  });
                }}>
                <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Ask the seat to see something done"
                  className="flex-1 min-w-0 rounded-md px-2.5 py-1.5 text-[12px]"
                  style={{ background: "var(--bg2)", border: edge(18), color: "var(--text)" }} />
                <input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="done when… a test, a file, an output"
                  className="min-w-0 rounded-md px-2.5 py-1.5 text-[12px]"
                  style={{ flex: "0 1 42%", background: "var(--bg2)", border: edge(18), color: "var(--text3)" }} />
                <button type="submit" disabled={!adding.trim() || !!busy || !root}
                  className="agx-btn shrink-0 text-[11px] px-2.5 py-1.5 rounded disabled:opacity-50"
                  style={{ color: "var(--text2)", border: edge(20) }}>Add</button>
              </form>

              {tasks.length === 0 ? (
                <p className="text-[11px] max-w-[80ch]" style={{ color: "var(--text4)" }}>
                  A seat with no queue still reads the field and reports. The queue is for work you want handed out:
                  it picks who, opens the agent, and never merges or pushes what comes back.
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {shown.map((t) => {
                    const beaten = !t.doneAt && !t.takenAt && t.attempts >= 2;
                    const rail = t.doneAt ? "--success" : t.takenAt ? "--primary" : beaten || !t.proof ? "--warning" : "--text4";
                    return (
                      /* Flex, not a grid with row spans. The first attempt gave
                         the rail and the status `gridRow: 1 / span 3`, which
                         pushed the title into the wrong track and made every
                         row three lines tall. A rail, a column, and a status
                         is what this is. */
                      <li key={t.id} className="flex items-start gap-2.5 rounded-md py-1.5 pr-2">
                        <span aria-hidden className="shrink-0 self-stretch"
                          style={{ width: 2, borderRadius: 2, background: `var(${rail})` }} />
                        <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                          <span className="text-[12.5px] leading-snug" title={t.detail || t.title}
                            style={{ color: t.doneAt ? "var(--text4)" : "var(--text)", textDecoration: t.doneAt ? "line-through" : undefined }}>{t.title}</span>
                          <span className="text-[10.5px] leading-snug" style={{ color: t.proof || t.doneAt ? "var(--text3)" : "var(--warning)" }}>
                            {t.doneAt ? (t.outcome || "done") : t.proof ? `done when ${t.proof}` : "nothing says what would prove this done"}
                          </span>
                        </span>
                        <span className="shrink-0 flex items-center gap-2 text-[11px] whitespace-nowrap pt-0.5" style={{ color: "var(--text3)" }}>
                          {t.doneAt ? fmtAgo(t.doneAt)
                            : t.takenAt ? <><span style={{ color: "var(--primary)" }}>{t.takenBy || "unnamed"}</span>, {fmtAgo(t.takenAt)}</>
                            : beaten ? <span style={{ color: "var(--warning)" }}>needs you</span> : "waiting"}
                          <button type="button" disabled={!!busy} onClick={() => void act("drop", () => api.seatTaskDrop(root, t.id))}
                            className="agx-btn text-[10px] rounded px-1.5 py-0.5 disabled:opacity-50"
                            style={{ color: "var(--text4)", border: edge(12) }} title="Take it off the list">Drop</button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {done.length > 1 && (
                <button type="button" onClick={() => setShowDone((v) => !v)}
                  className="agx-btn self-start text-[11px] pl-3" style={{ color: "var(--primary)" }}>
                  {showDone ? "Hide what landed" : `${done.length - 1} more landed`}
                </button>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button type="button" onClick={() => { setOpenRules((v) => !v); setEditing(null); }}
                  className="agx-btn flex items-baseline gap-2 min-w-0 text-left rounded px-1 -mx-1 py-0.5">
                  <span aria-hidden className="text-[9px]" style={{ color: "var(--text4)" }}>{openRules ? "▾" : "▸"}</span>
                  <span className="text-[11.5px]" style={{ color: "var(--text2)" }}>Its rules</span>
                  <span className="text-[10.5px] truncate" style={{ color: "var(--text4)" }} title={data?.doctrine}>
                    {data ? `${here(data.doctrine)} · ${Math.max(1, Math.round((data.doctrineText.length || 0) / 1024))} KB` : "…"}
                  </span>
                </button>
                <span className="flex-1" />
                {openRules && editing === null && (
                  <button type="button" disabled={!data} onClick={() => setEditing(data?.doctrineText ?? "")}
                    className="agx-btn text-[10.5px] px-2 py-0.5 rounded" style={{ color: "var(--text3)", border: edge(20) }}>Edit</button>
                )}
                {editing !== null && (
                  <>
                    <button type="button" onClick={() => setEditing(null)}
                      className="agx-btn text-[10.5px] px-2 py-0.5 rounded" style={{ color: "var(--text3)", border: edge(20) }}>Cancel</button>
                    <button type="button" disabled={!!busy}
                      onClick={() => void act("doctrine", async () => {
                        const r = await api.seatDoctrineSave(root, editing ?? "");
                        if (r.ok) setEditing(null);
                        return r;
                      })}
                      className="agx-btn text-[10.5px] px-2 py-0.5 rounded disabled:opacity-60"
                      style={{ color: "var(--text)", border: `1px solid ${wash("--primary", 45)}` }}>Save</button>
                  </>
                )}
              </div>
              {!openRules && (
                <p className="text-[11px] max-w-[80ch]" style={{ color: "var(--text4)" }}>
                  This file is the prompt: it is read again every time the seat is taken, so a line changed there is a rule
                  changed on the next seating. It lives outside the repository, because work notes are not the project's.
                </p>
              )}
              {openRules && (editing === null
                ? (
                  <pre className="rounded-md px-3 py-2.5 text-[11px] leading-relaxed whitespace-pre-wrap max-h-[52vh] overflow-y-auto agx-scroll"
                    style={{ background: "var(--bg2)", border: edge(14), color: "var(--text3)" }}>
                    {data?.doctrineText || "…"}
                  </pre>
                )
                : (
                  <textarea value={editing} onChange={(e) => setEditing(e.target.value)} spellCheck={false}
                    className="rounded-md px-3 py-2.5 text-[11px] leading-relaxed font-mono w-full h-[52vh]"
                    style={{ background: "var(--bg2)", border: edge(26), color: "var(--text2)" }} />
                ))}
            </section>
          </div>

          {/* ── the field, and the day ─────────────────────────────── */}
          {/* The column scrolls; the strip at its foot does not. What this
              chair may do, which model and how often it is woken are settings
              you touch twice a month — they belong where a person can always
              find them, not twenty agents down a list. */}
          <div className="flex flex-col min-w-0 min-h-0" style={{ background: "var(--bg2)" }}>
          <div className="flex flex-col gap-5 px-5 py-4 min-w-0 min-h-0 flex-1 overflow-y-auto agx-scroll">
            <section className="flex flex-col gap-1">
              <h2 className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>The field it keeps</h2>
              <p className="text-[10.5px] pb-1.5" style={{ color: "var(--text3)" }}>
                {reachable.length
                  ? <>{reachable.length} in this project, and the last hour of each.{need.length ? <> <span style={{ color: "var(--error)" }}>{need.length} stopped on you.</span></> : null}</>
                  : "Nobody is working in this project right now."}
                {onLantern && <> <button type="button" onClick={onLantern} className="agx-btn" style={{ color: "var(--primary)" }}>Lantern →</button></>}
              </p>
              {/*
                * ONE MESSAGE, EVERYBODY.
                *
                * The same paragraph pasted five times is five turns of the most
                * expensive context on the machine, and that is what this
                * replaces. It sends as YOU, not as the seat — the seat's own
                * powers decide what the seat may do, and this is the person at
                * the keyboard talking to their own agents.
                */}
              {field.length > 0 && (
                <form className="flex gap-2 pb-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = saying.trim();
                    if (!t) return;
                    void act("broadcast", async () => {
                      const r = await api.agentsBroadcast(t);
                      if (r.ok) {
                        setSaying("");
                        const got = r.result?.sent.filter((x) => x.outcome === "sent" || x.outcome === "queued").length ?? 0;
                        const asked = r.result?.asked ?? 0;
                        /* Named counts, not "sent": an agent whose pane is gone
                           takes the message nowhere, and a person told "sent"
                           would wait for an answer that cannot come. */
                        setSentTo(got === asked ? `said to all ${asked}` : `said to ${got} of ${asked}`);
                      }
                      return r;
                    });
                  }}>
                  <input value={saying} onChange={(e) => { setSaying(e.target.value); setSentTo(""); }}
                    placeholder={`Say something to all ${field.length}`}
                    className="flex-1 min-w-0 rounded-md px-2.5 py-1.5 text-[12px]"
                    style={{ background: "var(--bg)", border: edge(18), color: "var(--text)" }} />
                  <button type="submit" disabled={!saying.trim() || !!busy}
                    className="agx-btn shrink-0 text-[11px] px-2.5 py-1.5 rounded disabled:opacity-50"
                    style={{ color: "var(--text2)", border: edge(20) }}>
                    {busy === "broadcast" ? "Sending…" : "Say to all"}
                  </button>
                </form>
              )}
              {sentTo && <p className="text-[10.5px] pb-1.5" style={{ color: "var(--text3)" }}>{sentTo}</p>}
              {reachable.map((r) => {
                const tone = toneOf(r);
                return (
                  <button key={`${r.name}-${r.session ?? r.paneId ?? ""}`} type="button"
                    onClick={() => { if (r.paneId) jumpToPane(r.paneId); }}
                    disabled={!r.paneId}
                    className="agx-row grid items-center rounded-md py-1.5 px-1.5 -mx-1.5 text-left disabled:cursor-default"
                    style={{ gridTemplateColumns: "7px minmax(0,1fr) auto auto", columnGap: 9 }}
                    title={r.doing || r.needsYou?.why || r.name}>
                    <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: `var(${tone})` }} />
                    <span className="text-[12px] truncate" style={{ color: "var(--text)" }}>{r.name}</span>
                    <Pulse pulse={r.pulse} tone={tone} />
                    <span className="text-[10.5px] whitespace-nowrap" style={{ color: r.needsYou ? `var(${tone})` : "var(--text3)" }}>
                      {whyLine(r, now)}
                    </span>
                  </button>
                );
              })}
              {/* The ones that are gone: a count and their names, on one line.
                  Not dropped — the row is still a fact with a time on it — and
                  not drawn as thirteen agents either. */}
              {past.length > 0 && (
                <p className="text-[10.5px] pt-1.5" style={{ color: "var(--text4)" }}
                  title={past.map((r) => r.name).join(", ")}>
                  {past.length} more {past.length === 1 ? "name has" : "names have"} no pane here and {past.length === 1 ? "has" : "have"} been
                  quiet for hours: {past.slice(0, 6).map((r) => r.name).join(", ")}{past.length > 6 ? `, +${past.length - 6}` : ""}
                </p>
              )}
            </section>

            <section className="flex flex-col gap-1">
              <h2 className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>Its day</h2>
              <p className="text-[10.5px] pb-1.5" style={{ color: "var(--text3)" }}>One line per round, newest first.</p>
              {lines.length === 0
                ? <p className="text-[11px]" style={{ color: "var(--text4)" }}>Nothing said yet. It reports one line per round, and they collect here.</p>
                : (
                  <ol className="flex flex-col" style={{ paddingLeft: 4 }}>
                    {lines.map((l, i) => (
                      <li key={`${l.at}-${i}`} className="grid gap-2.5 py-2 relative"
                        style={{ gridTemplateColumns: "38px 1fr", paddingLeft: 14 }}>
                        <span aria-hidden className="absolute" style={{
                          left: 0, width: 1, background: "var(--border)",
                          top: i === 0 ? 15 : 0,
                          bottom: i === lines.length - 1 ? "calc(100% - 15px)" : 0,
                        }} />
                        <span aria-hidden className="absolute rounded-full" style={{
                          left: -2.5, top: 12, width: 6, height: 6,
                          background: i === 0 ? "var(--primary)" : "var(--bg4)",
                          boxShadow: i === 0 ? `0 0 0 3px ${wash("--primary", 20)}` : undefined,
                        }} />
                        <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }}>
                          {new Date(l.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}
                        </span>
                        <span className="text-[11.5px] leading-snug" style={{ color: i === 0 ? "var(--text2)" : "var(--text3)" }}>{l.line}</span>
                      </li>
                    ))}
                  </ol>
                )}
            </section>

          </div>

            <section className="flex flex-wrap items-center gap-2 text-[10.5px] px-5 py-3 shrink-0"
              style={{ color: "var(--text3)", borderTop: "1px solid var(--border)", background: "var(--bg2)" }}>
              <span title={adopted
                ? "This session was already running when it took the chair, so it holds the machine's credential like any other. These are its stated rules; what actually holds the line is the gate on anything that leaves the machine, and its own doctrine."
                : "Enforced by the server: a seat set to Speaks is refused if it tries to prompt an agent."}>
                {adopted ? "It says it" : "This chair"}
              </span>
              <span className="inline-flex rounded overflow-hidden" style={{ border: edge(18) }}>
                {POWERS.map((p, i) => (
                  <button key={p.id} type="button" disabled={!!busy || !root}
                    title={adopted ? `${p.what} (stated, not enforced: this seat was adopted)` : p.what}
                    onClick={() => void act("powers", () => api.seatSettingsSave(root, { powers: p.id }))}
                    className="agx-btn px-2 py-0.5 text-[10.5px] disabled:opacity-60"
                    style={{
                      color: p.id === powers ? "var(--text)" : "var(--text3)",
                      background: p.id === powers ? wash("--primary", 16) : "transparent",
                      borderRight: i < POWERS.length - 1 ? "1px solid var(--border)" : undefined,
                    }}>{p.label}</button>
                ))}
              </span>
              <select value={chosen} disabled={!!busy || !root}
                onChange={(e) => void act("model", () => api.seatSettingsSave(root, { model: e.target.value }))}
                className="rounded px-1.5 py-0.5 text-[10.5px]"
                style={{ background: "var(--bg)", border: edge(18), color: "var(--text2)" }}
                title="A seat reads a board and writes a sentence a few times an hour. It is not the model you sit in front of.">
                {[...(chosen && !models.some((m) => m.id === chosen) ? [{ id: chosen, label: `${chosen} (not in this build's list)` }] : []), ...models]
                  .map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <span>· {data?.floorHours ?? 4} h floor</span>
              {adopted
                ? <span style={{ color: "var(--warning)" }} title="Powers are enforced with a credential handed out when this app opens a seat. An adopted one already had the machine's.">· stated, not enforced</span>
                : live ? <span style={{ color: "var(--text4)" }}>· changes apply at the next seating</span> : null}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
