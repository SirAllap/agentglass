import { useCallback, useEffect, useState } from "react";
import { fmtAgo } from "../lib/format.ts";
import { jumpToPane } from "../lib/paneJump.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { edge, wash } from "./git/ui.tsx";
import { api, type SeatAnswer } from "../lib/api.ts";

/**
 * THE ORCHESTRATOR — the chair, and who is in it.
 *
 * The Lantern next door is the field: every agent, who is stopped, the way
 * there. This is the post that reads that field for you. Two views rather than
 * one card because they answer different questions — "what is happening" and
 * "who is minding it" — and a screen that answers both answers neither first.
 *
 * THE ORDER ON THIS SCREEN IS THE POINT, and the first draft got it wrong: the
 * doctrine is a page of markdown, so drawn plainly it took two thirds of the
 * screen and the seat's own sentence — the only reason to open this view — sat
 * above it like a caption. So the rules are folded behind one line here. They
 * are the least urgent thing on a screen about somebody who is working right
 * now, and a person who wants them is a person who came to change them.
 *
 * Deliberately NOT here: the board. Two screens drawing the same agents is two
 * screens that can disagree, and the Lantern already draws them properly.
 */
const POWERS: { id: "speak" | "nudge" | "assign"; label: string; what: string }[] = [
  { id: "speak", label: "Speaks", what: "Reads the field and reports. Touches no agent." },
  { id: "nudge", label: "Unsticks", what: "Can prompt an agent that is already running." },
  { id: "assign", label: "Assigns", what: "Can prompt, start and stop named agents." },
];

const here = (p: string) => p.replace(/^\/home\/[^/]+\//, "~/");

/** A small chip in the house style: a wash of its tone, never a solid block. */
function Chip({ tone, title, children }: { tone: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] whitespace-nowrap"
      style={{ color: `var(${tone})`, background: wash(tone, 14), border: `1px solid ${wash(tone, 34)}` }}>
      {children}
    </span>
  );
}

/** One fact under the seat's sentence: a quiet label and a value that reads. */
function Fact({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0" title={title}>
      <span className="text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>{label}</span>
      <span className="text-[11.5px] truncate" style={{ color: "var(--text2)" }}>{value}</span>
    </div>
  );
}

export function SeatView({ onLantern }: { onLantern?: () => void }) {
  const [data, setData] = useState<SeatAnswer | null>(null);
  const [wake, setWake] = useState(4);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [openRules, setOpenRules] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.seat();
      setData(r);
      setError(!r.ok && r.error ? r.error : "");
    } catch { setError("could not read the seat"); }
  }, []);

  useEffect(() => {
    void load();
    void api.seatWake().then((r) => { if (r.ok) setWake(r.hours); }).catch(() => {});
    /* The seat says a line a few times an hour at most; this reads one row and
       one tmux list, so noticing one within a quarter minute is plenty. */
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const root = data?.root ?? "";
  const seat = data?.seat ?? null;
  const powers = seat?.powers ?? "speak";
  const live = data?.live === true;
  const power = POWERS.find((p) => p.id === powers)!;

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
                className="agx-btn text-[10.5px] px-2 py-0.5 rounded" style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
                title="Open the pane it is working in">Go <span aria-hidden>→</span></button>
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
          {data === null ? "reading the seat…" : live ? "Somebody is minding this project" : "Nobody is minding this project"}
        </span>
        {root && <span className="text-[10.5px] truncate" style={{ color: "var(--text4)" }} title={root}>· {here(root)}</span>}
        {error && <span className="text-[10.5px]" style={{ color: "var(--error)" }}>{error}</span>}
      </ViewHeader>

      <div className="flex-1 min-h-0 overflow-y-auto agx-scroll px-5 py-4 flex flex-col gap-5" style={{ background: "var(--bg)" }}>
        {/*
         * WHAT IT SAID, and then the four facts that make it worth believing:
         * when, what the chair may do, what it costs, and when it will next be
         * woken. All of it in one card, because they are one thought.
         */}
        <section className="rounded-lg overflow-hidden" style={{ background: "var(--surface2, var(--bg2))", border: edge(live ? 26 : 14) }}>
          <div className="px-4 pt-3.5 pb-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Its last word</span>
              <span className="flex-1" />
              {live
                ? <Chip tone="--success" title="An agent is in the chair right now — its pane exists on the engine">seated</Chip>
                : <Chip tone="--text4" title="Nobody is in the chair. Its rules and settings are kept.">empty</Chip>}
            </div>
            <p className="text-[14px] leading-relaxed max-w-[95ch]" style={{ color: seat?.lastLine ? "var(--text)" : "var(--text4)" }}>
              {seat?.lastLine
                || (live ? "It has not said anything yet — it reports once it has read the field."
                  : "Nobody has sat here yet. Take the seat and it will read the field and report.")}
            </p>
            {!live && seat?.lastLine ? (
              <p className="text-[10.5px]" style={{ color: "var(--text4)" }}>Said before the chair was emptied. Taking the seat again starts a fresh reading.</p>
            ) : null}
          </div>
          {/* Facts once there are any. Before that the same strip says what
              the seat will DO — four dashes under an empty chair teach nobody
              anything, and this is the one screen a person meets it on. */}
          <div className="px-4 py-2.5 grid grid-cols-2 sm:grid-cols-4 gap-4 border-t" style={{ borderColor: "var(--border, rgba(255,255,255,0.07))", background: wash("--text", 2) }}>
            {live || seat?.lastLine ? (
              <>
                <Fact label="Said" value={seat?.lastTurnAt ? `${fmtAgo(seat.lastTurnAt)} ago` : "not yet"} title="When it last reported a line" />
                <Fact label="Seated" value={live && seat?.startedAt ? `${fmtAgo(seat.startedAt)} ago` : "stood down"} title="When this seating began" />
                <Fact label="May" value={power.label} title={power.what} />
                <Fact label="Woken" value={`on a change · ${wake} h floor`}
                  title="It is prompted when what the field says needs a person changes; the floor is how long a quiet field may stay quiet before it gets a line anyway (Settings → Agents)." />
              </>
            ) : (
              <>
                <Fact label="It reads" value="every agent on this machine" title="The same field the Lantern draws: who is working, who is stopped, and for how long" />
                <Fact label="It says" value="one line, in its own words" title="What you see above — the only thing it reports" />
                <Fact label="It is woken" value={`on a change · ${wake} h floor`} title="Not on a clock: when what the field says needs a person changes" />
                <Fact label="It never" value="merges, pushes or leaves the machine" title="Written into the rules it is seated with" />
              </>
            )}
          </div>
        </section>

        {/*
         * THE WAY ACROSS. One line, never the board: the Lantern draws the
         * agents properly and two screens drawing them is two screens that can
         * disagree. This says how big the field is and gets out of the way.
         */}
        {onLantern && (
          <button type="button" onClick={onLantern}
            className="agx-btn self-start rounded-lg px-3 py-2 flex items-baseline gap-2 text-[11.5px]"
            style={{ background: "var(--surface2, var(--bg2))", border: edge(14), color: "var(--text3)" }}
            title="The field it reads: every agent, who is stopped, and the way to their pane">
            <span style={{ color: "var(--text2)" }}>The field it reads</span>
            <span aria-hidden style={{ color: "var(--text4)" }}>·</span>
            <span style={{ color: "var(--primary)" }}>Lantern <span aria-hidden>→</span></span>
          </button>
        )}

        {/*
         * WHAT IT MAY DO. Three rows rather than a dropdown: the difference
         * between them is a sentence, and a dropdown hides sentences. The
         * change takes effect at the next seating and says so — a setting that
         * pretended to reach inside a prompt already handed to a running CLI
         * would be a setting that lies.
         */}
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>What this chair may do</h2>
            {live && <span className="text-[10px]" style={{ color: "var(--text4)" }}>· takes effect the next time somebody takes the seat</span>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {POWERS.map((p) => {
              const on = p.id === powers;
              return (
                <button key={p.id} type="button" disabled={!!busy || !root}
                  onClick={() => void act("powers", () => api.seatSettingsSave(root, { powers: p.id }))}
                  className="agx-btn text-left rounded-lg px-3 py-2.5 flex flex-col gap-1 disabled:opacity-60"
                  style={{ background: on ? wash("--primary", 10) : "var(--surface2, var(--bg2))", border: `1px solid ${on ? wash("--primary", 45) : "var(--border, rgba(255,255,255,0.08))"}` }}>
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: on ? "var(--primary)" : "transparent", border: `1px solid ${on ? "var(--primary)" : "var(--text4)"}` }} />
                    <span className="text-[12px] font-medium" style={{ color: on ? "var(--text)" : "var(--text2)" }}>{p.label}</span>
                  </span>
                  <span className="text-[11px] leading-snug" style={{ color: "var(--text3)" }}>{p.what}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/*
         * THE RULES, folded. One line saying where they live and how big they
         * are; the page itself only when somebody asks for it.
         */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button type="button" onClick={() => { setOpenRules((v) => !v); setEditing(null); }}
              className="agx-btn flex items-baseline gap-2 min-w-0 text-left rounded px-1 -mx-1 py-0.5">
              <span aria-hidden className="text-[9px]" style={{ color: "var(--text4)" }}>{openRules ? "▾" : "▸"}</span>
              <span className="text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Its rules</span>
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
                  style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>Save</button>
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
              <pre className="rounded-lg px-3 py-2.5 text-[11px] leading-relaxed whitespace-pre-wrap max-h-[52vh] overflow-y-auto agx-scroll"
                style={{ background: "var(--surface2, var(--bg2))", border: edge(14), color: "var(--text3)" }}>
                {data?.doctrineText || "…"}
              </pre>
            )
            : (
              <textarea value={editing} onChange={(e) => setEditing(e.target.value)} spellCheck={false}
                className="rounded-lg px-3 py-2.5 text-[11px] leading-relaxed font-mono w-full h-[52vh]"
                style={{ background: "var(--surface2, var(--bg2))", border: edge(26), color: "var(--text2)" }} />
            ))}
        </section>
      </div>
    </div>
  );
}
