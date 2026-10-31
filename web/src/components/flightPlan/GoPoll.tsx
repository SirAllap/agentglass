import { useEffect, useRef, useState } from "react";
import { INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { canGo, goBlocker, kb, openCount, usd, type Plan, type Run } from "../../lib/flightPlan.ts";
import { goSentence, handledLine, hhmm, plural, whoIs, type Handled, type Pilot, type PilotQuestion } from "../../lib/flightPilot.ts";
import { DoneIcon, FlagIcon, HandIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { CrossIcon, PlaneIcon, SealIcon } from "./fpIcons.tsx";

export type CardAnswer = { choiceId: string } | { text: string };
const PILOT_NAME: Record<Pilot, string> = { manual: "Manual", copilot: "Co-pilot", autopilot: "Autopilot" };

/**
 * THE ONE CARD THAT ASKS THE PERSON: a question from the coordinator, or Go.
 * The same component in the popover over the Flying view and in the open plan's
 * column; `popover` adds the close button and the plan/mockup footer's Open.
 *
 * Keyboard: the choices are one radio group (arrows move, the coordinator's pick
 * is chosen to begin with), Enter sends the chosen one or, from the text line, the
 * text; a pointer click on a card sends it at once. Nothing is sent by arrowing.
 */
export function GoCard({ plan, run, pilot, handled, question, busy, error, popover, onGo, onNoGo, onAnswer, onTakeOver, onStop, onSee, onClose }: {
  plan: Plan; run: Run | null; pilot: Pilot; handled: Handled; question?: PilotQuestion | null;
  busy: boolean; error: string; popover?: boolean;
  onGo: () => void; onNoGo: (reason: string) => void; onAnswer: (a: CardAnswer) => void; onTakeOver: () => void; onStop: () => void;
  /** Show the plan with its findings (the popover closes behind it). */
  onSee?: () => void; onClose?: () => void;
}) {
  const decided = plan.state === "launched" || plan.state === "no-go";
  const variant = decided ? "decided" : question ? (question.answer ? "answered" : "question") : "go";
  const [text, setText] = useState("");
  const [pick, setPick] = useState<string | null>(() => question?.choices.find((c) => c.recommended)?.id ?? null);
  const textRef = useRef<HTMLInputElement>(null);
  const armed = useRef(false);
  const sending = useRef(false);
  const first = useRef<HTMLFieldSetElement>(null);
  useEffect(() => { sending.current = false; }, [busy, error, question?.answer]);
  useEffect(() => { if (popover) (first.current?.querySelector<HTMLInputElement>("input:checked") ?? first.current?.querySelector<HTMLInputElement>("input") ?? textRef.current)?.focus(); }, [popover, variant]);

  const send = (a: CardAnswer) => { if (busy || sending.current) return; sending.current = true; onAnswer(a); };
  const t = text.trim();
  const why = goBlocker(plan);
  const open = openCount(run);
  const x = onClose && popover ? <button type="button" className="gc-x" aria-label="Close" title="Close (Esc)" onClick={onClose}><CrossIcon size={ICON.sm} /></button> : null;
  const tile = (icon: React.ReactNode) => <span className="gc-tile" aria-hidden="true">{icon}</span>;

  if (variant === "decided") {
    return (
      <section className="gc" data-v="decided" aria-label={plan.state === "launched" ? "Go said" : "Sent back"}>
        <div className="gc-h">{tile(<DoneIcon size={ICON.sm} />)}<div><div className="gc-t">{plan.title}</div><div className="gc-from">{plan.state === "launched" ? `Go was said${plan.decision ? ` by ${whoIs(plan.decision.by)} at ${hhmm(plan.decision.at)}` : ""}.` : "No-go, with a reason."}</div></div><span className="gc-badge">{plan.state === "launched" ? "Go said" : "Sent back"}</span>{x}</div>
        <p className="gc-quote">{plan.state === "no-go" ? `“${plan.decision?.reason ?? ""}” — the plan goes back to the author with this line. Nothing launches.` : "Where the builder is and what it is doing is in the status block of the plan."}</p>
      </section>
    );
  }

  if (variant === "answered" && question?.answer) {
    return (
      <section className="gc" data-v="answered" aria-label={`Answered: ${plan.title}`}>
        <div className="gc-h">{tile(<DoneIcon size={ICON.sm} />)}<div><div className="gc-t">{plan.title}</div><div className="gc-from">answered by {question.answer.by === "person" ? "you" : question.answer.by} {hhmm(question.answer.at)} · <b>the orchestrator</b> is updating the plan</div></div><span className="gc-badge">Answered</span>{x}</div>
        <p className="gc-quote" aria-live="polite">“{question.answer.text}” — the plan is updated from it{pilot === "autopilot" ? "; Autopilot goes on without you" : ""}.</p>
      </section>
    );
  }

  const footer = (left: React.ReactNode, right?: React.ReactNode) => (
    <div className="gc-f">{left}{right && <div className="sp">{right}</div>}</div>
  );

  if (variant === "question" && question) {
    const line = handledLine(handled);
    const n = question.choices.length;
    return (
      <section className="gc" data-v="question" aria-label={`One question from the orchestrator about ${plan.title}`}>
        <div className="gc-h">{tile(<HandIcon size={ICON.sm} />)}<div><div className="gc-t" title={plan.title}>{plan.title}</div><div className="gc-from">asked by <b>the orchestrator</b>{run ? " · after Preflight" : ""} · {hhmm(question.askedAt)}</div></div><span className="gc-badge">1 question</span>{x}</div>
        <h3>{question.text}</h3>
        {question.detail && <p className="gc-ctx">{question.detail}</p>}
        <form onSubmit={(e) => { e.preventDefault(); if (document.activeElement === textRef.current && t) send({ text: t }); else if (pick) send({ choiceId: pick }); else if (t) send({ text: t }); }}>
          {n > 0 && (
            <fieldset className="gc-choices" ref={first} style={{ ["--cols" as string]: Math.min(3, n) }} disabled={busy} aria-label="The orchestrator's options">
              {question.choices.map((c) => (
                <label key={c.id} className="gc-ch" data-rec={c.recommended ? "" : undefined} onPointerDown={() => { armed.current = true; }} onClick={() => { if (armed.current) { armed.current = false; send({ choiceId: c.id }); } }}>
                  <input type="radio" name={`gc-${question.id}`} value={c.id} checked={pick === c.id} onChange={() => setPick(c.id)} />
                  {c.recommended && <span className="gc-rec">orchestrator’s pick</span>}
                  <b>{c.label}</b>{c.detail && <span>{c.detail}</span>}
                </label>
              ))}
            </fieldset>
          )}
          <div className="gc-free">
            <input ref={textRef} className={INPUT} style={INPUT_STYLE} aria-label="Your own answer" placeholder="Or say it in one line — it goes to the orchestrator" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn field" aria-busy={busy || undefined} disabled={busy || (!t && !pick)}>Send</button>
          </div>
        </form>
        {error && <p className="gc-err" role="alert">{error}</p>}
        {footer(
          <>{line && <><span className="ok"><DoneIcon size={ICON.xs} /></span><span>Already handled: {line}</span>{onSee && <button type="button" className="gc-link" onClick={onSee}>See</button>}</>}</>,
          <><button type="button" className="btn ghost" disabled={busy} onClick={onTakeOver}><HandIcon size={ICON.xs} />Take over this plan</button><button type="button" className="btn ghost" disabled={busy} onClick={onStop}>Stop it</button></>,
        )}
      </section>
    );
  }

  const answers = handled.fixed + handled.contested + handled.dismissed;
  return (
    <section className="gc" data-v="go" aria-label={`Go or No-go: ${plan.title}`}>
      <div className="gc-h">{tile(<FlagIcon size={ICON.sm} />)}<div><div className="gc-t" title={plan.title}>{plan.title}</div><div className="gc-from">ready · {answers ? <><b>the orchestrator</b> answered {plural(answers, "finding")}</> : "nothing to answer"} · {PILOT_NAME[pilot]}</div></div><span className="gc-badge">Go?</span>{x}</div>
      <h3 title={plan.title}>{plan.state === "go" ? `Launch “${plan.title}”?` : `Go for “${plan.title}”?`}</h3>
      <p className="gc-ctx">{goSentence(plan, run)}</p>
      {(why || open > 0) && <p className="gc-ctx" style={{ marginTop: 6, color: "var(--text3)" }}>{why ?? `${plural(open, "finding")} open, advisory. Go launches the plan as written.`}</p>}
      <form onSubmit={(e) => { e.preventDefault(); if (t && !busy) onNoGo(t); }}>
        <div className="gc-free">
          <input ref={textRef} className={INPUT} style={INPUT_STYLE} aria-label="No-go reason, optional" placeholder="No-go reason (optional) — it goes to the orchestrator" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
          <button type="button" className="btn nogo field" disabled={busy} onClick={() => onNoGo(t)}>No-go</button>
          <button type="button" className="btn go" data-big disabled={busy || !canGo(plan)} title={why ?? undefined} onClick={onGo}><PlaneIcon size={ICON.sm} />{plan.state === "go" ? "Launch" : "Go"}</button>
        </div>
      </form>
      <p className="gc-err" role="alert">{error}</p>
      {popover && onSee && footer(<><span>Plan, mockup and the {plural(answers, "answer")}</span><button type="button" className="gc-link" onClick={onSee}>Open</button></>)}
    </section>
  );
}

/** `withPlan`: the run read a flight plan's text, which the certificate does not list among its files. */
export function Certificate({ run, cap, withPlan }: { run: Run; cap: number; withPlan?: boolean }) {
  const c = run.certificate;
  if (!c) return null;
  const files = [...c.files.map((f) => ({ ...f, shown: f.path })), ...c.mockups.map((m) => ({ ...m, shown: `mockup/${m.path.split("/").pop()}` }))];
  const read = files.length + (withPlan ? 1 : 0);
  const at = new Date(c.createdAt);
  return (
    <div className="cert">
      <div className="hd"><span className="seal"><SealIcon size={14} /></span><b>Preflight certificate</b><span style={{ fontSize: 10.1, color: "var(--text3)" }}>{at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span></div>
      <div className="big">Saw <em>no conversation</em>. Read <em>{read === 1 ? "this file" : `these ${read} files`}</em>, nothing else.</div>
      <div className="files">
        {files.map((f) => <div key={f.path} className="file"><span>{f.shown.split("/").slice(-3).join("/")}</span><span>{kb(f.bytes)} · {f.sha256.slice(0, 4)}…</span></div>)}
        {c.skipped.map((s) => <div key={s.path} className="file"><span>{s.path.split("/").pop()}</span><span>skipped · {s.reason}</span></div>)}
      </div>
      <div className="cfoot">
        <span>Model</span><span>{c.model}</span>
        <span>Cost</span><span>{usd(c.costUsd)} of {usd(cap)} cap<div className="costbar"><i style={{ width: `${Math.min(100, (c.costUsd / (cap || 1)) * 100)}%` }} /></div></span>
        <span>Isolation</span><span>{c.isolation}</span>
      </div>
    </div>
  );
}
