import { useEffect, useMemo, useRef, useState } from "react";
import { Portal } from "./Portal.tsx";
import { Button, EDGE, LINE } from "./workspace/Chrome.tsx";
import { DoneIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { api } from "../lib/api.ts";
import { openExternal } from "../lib/externalUrl.ts";
import { putCard } from "../lib/prCardStore.ts";
import {
  NO_WORDS, RARE_LINE, STEP_LABEL, UNSTICK_CONFIRM, UNSTICK_EFFECTS, cardSentence, runUnstick, unstickWhy,
  type CardReading, type StepId, type StepNote, type UnstickDeps, type UnstickFacts, type UnstickGate, type UnstickOutcome,
} from "../../../shared/unstick.ts";

/**
 * The one confirmation before Unstick runs, and the progress after it.
 *
 * Nothing here runs by being opened: an agent can open this dialog on a pull
 * request (the `pr.unstick` door, level 3), and the person's click on the
 * confirm button is the only thing that starts it. When the gate (shared/
 * unstick.ts) says the pull request does not qualify, the dialog says why in a
 * sentence and offers only github.com; there is no button that runs.
 *
 * The steps are `runUnstick`, which stops at the first failure. After a stop the
 * dialog says what state the pull request was left in, and when that is "closed"
 * it offers the reopen as the first thing, ahead of anything else.
 */

export interface UnstickCard { query: string; label: string }

export interface UnstickDialogProps {
  root: string;
  number: number;
  url: string;
  gate: UnstickGate;
  facts: UnstickFacts;
  card: UnstickCard | null;
  /** The behind count after the run, for the Update branch offer. */
  behind: () => number | null;
  /** Re-read the pull request and its branch after any step that changed them. */
  refresh: () => void;
  /** A normal Update branch press, in the panel. */
  onUpdateBranch: () => void;
  onClose: () => void;
}

type Phase = "ask" | "running" | "finished";

/** Deps over the real API; a test or fixture passes its own to the runner instead. */
export function realDeps(root: string, number: number, card: UnstickCard | null): UnstickDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    look: (full) => api.prUnstickLook(root, number, full),
    card: card ? () => readCard(card) : null,
    close: () => api.prUnstickClose(root, number),
    reopen: () => api.prUnstickReopen(root, number),
  };
}

async function readCard(card: UnstickCard): Promise<{ ok: true; card: CardReading } | { ok: false; error: string }> {
  const r = await api.clickupFind(card.query);
  if (!r?.ok || !r.task) return { ok: false, error: r?.error || "the tracker did not answer" };
  putCard(card.query, r.task);
  return { ok: true, card: { id: r.task.id, label: card.label, status: r.task.status, updated: r.task.updated } };
}

const GLYPH: Record<string, string> = { running: "…", pending: "·" };

export function UnstickDialog(props: UnstickDialogProps) {
  /* The gate and the facts as they were when the dialog opened. The run re-reads the pull request, and
     what it reads afterwards (closed, or fixed) must not rewrite the question that was asked. */
  const [first] = useState(() => ({ gate: props.gate, facts: props.facts }));
  const p = { ...props, gate: first.gate, facts: first.facts };
  const [phase, setPhase] = useState<Phase>("ask");
  const [steps, setSteps] = useState<Partial<Record<StepId, StepNote>>>({});
  const [outcome, setOutcome] = useState<UnstickOutcome | null>(null);
  const [cardNow, setCardNow] = useState<CardReading | null | "reading" | "error">(p.card ? "reading" : null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [behindAfter, setBehindAfter] = useState<number | null>(null);
  const startedRef = useRef(false);

  // The card as it reads now, so the person sees what they are about to be told about later.
  useEffect(() => {
    if (!p.card) return;
    let live = true;
    void readCard(p.card).then((r) => { if (live) setCardNow(r.ok ? r.card : "error"); }).catch(() => { if (live) setCardNow("error"); });
    return () => { live = false; };
  }, [p.card?.query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "running") { e.preventDefault(); e.stopPropagation(); p.onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, p.onClose]);

  const why = useMemo(() => p.gate.show ? unstickWhy(p.gate.signal, p.gate.minutes, p.facts.headSha, p.facts.refSha) : "", [p.gate, p.facts.headSha, p.facts.refSha]);

  const run = async () => {
    if (startedRef.current || !p.gate.show) return;
    startedRef.current = true;
    setPhase("running");
    const out = await runUnstick(realDeps(p.root, p.number, p.card), (n) => setSteps((s) => ({ ...s, [n.step]: n })));
    setOutcome(out);
    p.refresh();
    if (out.ok) setBehindAfter(p.behind());
    setPhase("finished");
  };

  const reopenNow = async () => {
    setBusy("reopen");
    const r = await api.prUnstickReopen(p.root, p.number).catch((e) => ({ ok: false, error: String(e) }));
    setBusy("");
    setNote(r.ok ? "The pull request is open again." : `Could not reopen it: ${(r.error ?? "").slice(0, 200)}`);
    p.refresh();
  };

  const putBack = async () => {
    if (!outcome || !outcome.card.changed || !p.card) return;
    const id = (outcome.cardAfter ?? outcome.cardBefore)?.id;
    if (!id) return;
    setBusy("card");
    const r = await api.clickupStatus(id, outcome.card.from, outcome.cardAfter?.updated).catch((e) => ({ ok: false, error: String(e), conflict: false, task: undefined }));
    setBusy("");
    if (r.ok) putCard(p.card.query, "task" in r ? r.task : undefined);
    setNote(r.ok ? `${p.card.label} is back to ${outcome.card.from}.`
      : "conflict" in r && r.conflict ? "Somebody moved the card in the meantime; it was left as it is." : `Could not move the card: ${(r.error ?? "").slice(0, 200)}`);
  };

  const refused = !p.gate.show;
  const cardBlocks = !!p.card && (cardNow === "reading" || cardNow === "error");
  const left = outcome && !outcome.ok && outcome.pr !== "open";
  const touched = outcome && !outcome.ok && outcome.closeSent;

  return (
    <Portal>
      <div className="fixed inset-0 agx-scrim" style={{ zIndex: 10004 }} onClick={() => { if (phase !== "running") p.onClose(); }} />
      <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10005 }}>
        <div role="dialog" aria-modal="true" aria-label="Unstick this pull request"
          className="pointer-events-auto w-full max-w-[560px] max-h-full overflow-y-auto rounded-xl"
          style={{ background: "var(--surface-card)", border: EDGE, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
          <div className="px-4 py-3.5">
            <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>
              {refused ? "This pull request does not need unsticking" : (phase === "ask" ? `Unstick #${p.number}?` : `Unstick #${p.number}`)}
            </div>

            {phase === "ask" && (
              <>
                <p className="text-[11.5px] leading-relaxed mt-2" style={{ color: "var(--text2)" }}>
                  {refused ? NO_WORDS[(p.gate as { reason: keyof typeof NO_WORDS }).reason] : why}
                </p>
                {!refused && (
                  <>
                    <div className="text-[10px] uppercase tracking-[.12em] mt-3" style={{ color: "var(--text3)" }}>What will happen</div>
                    <ul className="mt-1.5 flex flex-col gap-1.5 text-[11.5px] leading-snug list-disc pl-4" style={{ color: "var(--text2)" }}>
                      {UNSTICK_EFFECTS.map((t) => <li key={t}>{t}</li>)}
                    </ul>
                    <div className="text-[10px] uppercase tracking-[.12em] mt-3" style={{ color: "var(--text3)" }}>Linked card</div>
                    <p className="text-[11.5px] mt-1" style={{ color: "var(--text2)" }}>
                      {!p.card ? "None found on this pull request, so nothing will be checked afterwards."
                        : cardNow === "reading" ? `${p.card.label} — reading its status…`
                        : cardNow === "error" || cardNow === null ? `${p.card.label} — its status could not be read. The run will not start without it.`
                        : <><b style={{ fontWeight: 600, color: "var(--text)" }}>{p.card.label}</b> is now <b style={{ fontWeight: 600, color: "var(--text)" }}>{cardNow.status}</b>. Check it after.</>}
                    </p>
                  </>
                )}
                <p className="text-[11px] mt-3" style={{ color: "var(--text3)" }}>{RARE_LINE}</p>
              </>
            )}

            {phase !== "ask" && (
              <ol className="mt-2.5 flex flex-col gap-1.5" aria-live="polite">
                {(Object.keys(STEP_LABEL) as StepId[]).filter((s) => steps[s]).map((s) => {
                  const n = steps[s]!;
                  return (
                    <li key={s} className="flex items-start gap-2 text-[11.5px] leading-snug">
                      <span aria-hidden className="shrink-0 w-4 grid place-items-center pt-px"
                        style={{ color: n.status === "failed" ? "var(--error)" : n.status === "done" ? "var(--success)" : "var(--text3)" }}>
                        {n.status === "done" ? <DoneIcon size={ICON.xs} /> : n.status === "failed" ? <WarningIcon size={ICON.xs} /> : (GLYPH[n.status] ?? "–")}
                      </span>
                      <span style={{ color: n.status === "failed" ? "var(--text)" : "var(--text2)" }}>
                        {STEP_LABEL[s]}
                        {n.text && <span className="block" style={{ color: n.status === "failed" ? "var(--error)" : "var(--text3)" }}>{n.text}</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}

            {phase === "finished" && outcome && (
              <div className="mt-3 flex flex-col gap-2 text-[11.5px] leading-snug" style={{ color: "var(--text2)" }}>
                {outcome.ok
                  ? <p>Done. The pull request is open and follows its branch.</p>
                  : <p style={{ color: "var(--text)" }}>{left ? "It was left " + (outcome.pr === "closed" ? "closed." : "in a state to check on github.com.")
                    : touched ? "It was closed and reopened during this run, so a tracker bot or a chat notice may have fired. Check the card and the pull request."
                    : "Nothing was changed."}</p>}
                {(p.card && outcome.card && (outcome.cardBefore || outcome.cardAfter)) && (
                  <p>{outcome.cardAfter ? cardSentence(p.card.label, outcome.card) : `${p.card.label} could not be read again. Check its status.`}</p>
                )}
                {outcome.ok && (behindAfter ?? 0) > 0 && (
                  <p>It is still {behindAfter} commit{behindAfter === 1 ? "" : "s"} behind its base. Update branch is yours to press; it is not run for you.</p>
                )}
                {note && <p style={{ color: "var(--text)" }}>{note}</p>}
              </div>
            )}
          </div>

          <div className="px-4 py-2.5 flex items-center justify-end gap-2 flex-wrap" style={{ borderTop: LINE }}>
            {phase === "ask" && (
              <>
                <Button size="compact" onClick={() => openExternal(p.url)}>Open on github.com</Button>
                <Button size="compact" autoFocus onClick={p.onClose}>{refused ? "Close" : "Cancel"}</Button>
                {!refused && (
                  <Button size="compact" tone="warn" disabled={cardBlocks} onClick={() => void run()}>{UNSTICK_CONFIRM}</Button>
                )}
              </>
            )}
            {phase === "running" && <span className="text-[11px]" style={{ color: "var(--text3)" }}>Running. Closing this window is held until it stops.</span>}
            {phase === "finished" && (
              <>
                {outcome && !outcome.ok && outcome.pr !== "open" && !note.startsWith("The pull request is open") && (
                  <Button size="compact" tone="warn" pending={busy === "reopen"} disabled={!!busy} onClick={() => void reopenNow()}>Reopen it now</Button>
                )}
                {outcome && outcome.card.changed && p.card && !note.includes("back to") && (
                  <Button size="compact" pending={busy === "card"} disabled={!!busy} onClick={() => void putBack()}>Put {p.card.label} back to {outcome.card.from}</Button>
                )}
                {outcome?.ok && (behindAfter ?? 0) > 0 && (
                  <Button size="compact" tone="warn" onClick={() => { p.onClose(); p.onUpdateBranch(); }}>Update branch</Button>
                )}
                <Button size="compact" onClick={() => openExternal(p.url)}>Open on github.com</Button>
                <Button size="compact" tone="primary" onClick={p.onClose}>Close</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
