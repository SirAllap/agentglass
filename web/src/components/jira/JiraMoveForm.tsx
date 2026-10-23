import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Portal } from "../Portal.tsx";
import { Select } from "../Select.tsx";
import { CloseButton } from "../CloseButton.tsx";
import { CardRef, StatusMove } from "../StepCard.tsx";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../workspace/Chrome.tsx";
import { FIELD_KEY, titleOf, useFocusTrap } from "./JiraStepDialog.tsx";
import { useOwnedQuestion } from "../../lib/layerOwner.ts";
import { WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { footerOf, formView, toSend, type FormPhase, type FormValues } from "../../lib/jiraMoveForm.ts";
import type { StatusWriteResult } from "../../lib/trackerStatus.ts";
import type { JiraMoveField } from "../../../../shared/jiraMoveFields.ts";

/*
 * The form a Jira move opens when its screen asks for something (a resolution,
 * a comment, any required field), in place of being refused.
 *
 * It is built from what the site said the screen holds: each field by its kind,
 * a choice from the site's own list. Every state is drawn in the same place:
 * the field rows keep their height whether they hold a hint or not, and the one
 * button changes its words and not its spot. A required field left empty keeps
 * the button off, so nothing is sent; the sentence under the form says which.
 * What the move will do is listed before the press and the same list says
 * "What happened" after it.
 *
 * Ceiling: one move, one answer; a failure leaves the form as typed so the
 * person can fix and press again, and nothing is retried on its own.
 */

export interface MoveFormSpec {
  card: { key: string; title: string; status: string; statusColor?: string | undefined };
  to: { status: string; color?: string | undefined };
  fields: readonly JiraMoveField[];
  /** Sends the move with what was typed; one request, answered once. */
  run: (values: FormValues) => Promise<StatusWriteResult>;
}
export type MoveFormResult = StatusWriteResult | null;
type Pending = MoveFormSpec & { resolve: (r: MoveFormResult) => void };

const CHOOSE = "";

function Control({ f, value, on, off, bad }: { f: JiraMoveField; value: string | string[] | undefined; on: (v: string | string[]) => void; off: boolean; bad: boolean }) {
  const text = typeof value === "string" ? value : "";
  const edge = { ...INPUT_STYLE, ...(bad ? { boxShadow: "0 0 0 1px var(--error)" } : null) };
  switch (f.kind) {
    case "option":
      return (
        <Select value={text} title={f.name} disabled={off} align="left" placeholder="Choose…" onChange={on}
          options={[{ value: CHOOSE, label: "Choose…", dim: true, disabled: true }, ...(f.choices ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
      );
    case "options": {
      const have = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-col gap-1">
          {(f.choices ?? []).map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--text2)" }}>
              <input type="checkbox" checked={have.includes(c.id)} disabled={off} onChange={(e) => on(e.target.checked ? [...have, c.id] : have.filter((x) => x !== c.id))} />
              {c.name}
            </label>
          ))}
        </div>
      );
    }
    case "comment":
    case "longtext":
      return <textarea value={text} rows={2} disabled={off} aria-label={f.name} className="w-full px-2.5 py-1.5 rounded-lg text-[12px] outline-none" style={{ ...edge, background: "var(--surface-inset)", color: "var(--text)" }} onChange={(e) => on(e.target.value)} />;
    case "number":
      return <input value={text} inputMode="decimal" disabled={off} aria-label={f.name} className={`w-full ${INPUT}`} style={edge} onChange={(e) => on(e.target.value)} />;
    case "date":
      return <input type="date" value={text} disabled={off} aria-label={f.name} className={`w-full ${INPUT}`} style={{ ...edge, colorScheme: "light dark" }} onChange={(e) => on(e.target.value)} />;
    default:
      return <input value={text} disabled={off} aria-label={f.name} className={`w-full ${INPUT}`} style={edge} onChange={(e) => on(e.target.value)} />;
  }
}

export function MoveForm({ spec, onDone }: { spec: MoveFormSpec; onDone: (r: MoveFormResult) => void }) {
  const reduced = useReducedMotion() === true;
  const [values, setValues] = useState<FormValues>({});
  const [phase, setPhase] = useState<FormPhase>("idle");
  const [answer, setAnswer] = useState<StatusWriteResult | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLDivElement>(null);

  const view = useMemo(() => formView(spec.fields, values, { phase }), [spec.fields, values, phase]);
  const shown = spec.fields.filter((f) => f.kind !== "unsupported");
  const foot = footerOf({ phase, hint: view.hint, blocked: !!view.blocked, error: answer && !answer.ok ? (answer.conflict ? "Somebody changed this card while you had it open. Close this and try again." : answer.error) : undefined, key: spec.card.key, now: answer?.task?.status });
  const off = phase === "running" || phase === "done";
  const label = phase === "done" ? "Close" : phase === "running" ? "Moving…" : `Move to ${spec.to.status}`;

  const go = async () => {
    if (!view.canSubmit) return;
    setPhase("running");
    const r = await spec.run(toSend(spec.fields, values)).catch((): StatusWriteResult => ({ ok: false, error: "Could not reach the server" }));
    setAnswer(r);
    setPhase(r.ok ? "done" : "failed");
  };
  const close = () => { if (phase !== "running") onDone(phase === "done" ? answer : null); };

  useFocusTrap(true, panel);
  useEffect(() => {
    const t = setTimeout(() => firstField.current?.querySelector<HTMLElement>("button, input, textarea")?.focus(), 40);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Enter" && (phase === "idle" || phase === "failed") && !(e.target instanceof HTMLButtonElement) && (!(e.target instanceof HTMLTextAreaElement) || e.ctrlKey || e.metaKey)) {
        e.preventDefault(); e.stopPropagation(); void go();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const dur = reduced ? 0 : 0.16;
  const tone = foot.tone === "bad" ? "var(--error)" : foot.tone === "good" ? "var(--success)" : "var(--text3)";
  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: dur }}
        className="fixed inset-0 agx-scrim" style={{ zIndex: 10004 }} onClick={close} />
      <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10005 }}>
        <motion.div ref={panel} role="dialog" aria-modal="true" aria-label={titleOf(`Move to ${spec.to.status}`, spec.card.key).replace(/\?$/, "")} data-move-form=""
          initial={{ opacity: 0, scale: 0.98, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: dur }}
          className="pointer-events-auto w-full max-w-[480px] rounded-xl overflow-hidden flex flex-col"
          style={{ background: "var(--surface-card)", border: EDGE, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", maxHeight: "calc(100vh - 48px)" }}>
          <div className="px-4 pt-3.5 pb-3 overflow-y-auto min-h-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-medium min-w-0" style={{ color: "var(--text)" }}>{titleOf(`Move to ${spec.to.status}`, spec.card.key)}</div>
              <CloseButton onClick={close} disabled={phase === "running"} />
            </div>
            <div className="mt-3"><CardRef id={spec.card.key} title={spec.card.title} /></div>
            <div className="mt-3 rounded-lg px-3 py-2.5 flex items-center gap-3" style={{ border: EDGE }} data-move-strip="">
              <span style={FIELD_KEY}>Status</span>
              <StatusMove from={spec.card.status || "No status"} fromColor={spec.card.statusColor} to={spec.to.status} toColor={spec.to.color} />
            </div>

            <div ref={firstField} className="mt-3 grid gap-x-3 gap-y-0.5" style={{ gridTemplateColumns: "96px 1fr" }} data-fields="">
              {shown.map((f) => {
                const empty = view.missing.includes(f.key);
                const problem = view.problems[f.key];
                return (
                  <div key={f.key} className="contents" data-field={f.key} data-field-state={problem ? "invalid" : empty ? "required-missing" : "ok"}>
                    <div className="pt-1.5" style={{ ...FIELD_KEY, alignSelf: "start" }}>{f.name}</div>
                    <div className="min-w-0">
                      <Control f={f} value={values[f.key]} off={off} bad={!!problem} on={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                      {/* The hint row always holds its height, so the form does not jump as it fills in. */}
                      <div className="h-[16px] text-[10.5px] leading-[16px] truncate" style={{ color: problem ? "var(--error)" : "var(--text3)" }}>
                        {problem ?? (f.required && empty ? "Required" : f.required ? "" : "Optional")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {view.notOffered && <div className="mt-1 text-[10.5px]" data-not-offered="" style={{ color: "var(--text3)" }}>{view.notOffered}</div>}

            <div className="mt-3 mb-2 flex items-center gap-2" style={FIELD_KEY}>
              <span>{phase === "done" ? "What happened" : "What will happen"}</span>
              <span className="flex-1" style={{ borderTop: LINE }} />
            </div>
            <ul className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--text)" }} data-effects="">
              <li>{phase === "done" ? `${spec.card.key} moved from ${spec.card.status || "no status"} to ${answer?.task?.status ?? spec.to.status}` : `${spec.card.key} moves from ${spec.card.status || "no status"} to ${spec.to.status}`}</li>
              {view.effects.map((e) => <li key={e}>{e}</li>)}
            </ul>
            <div className="sr-only" role="status" aria-live="polite">{phase === "idle" ? "" : foot.text}</div>
          </div>

          <div className="px-4 pt-2.5 pb-3 flex flex-col gap-2.5" style={{ borderTop: LINE }}>
            <div className="flex items-start gap-1.5 text-[11px] leading-snug min-h-[30px]" data-move-foot={foot.tone} style={{ color: tone }}>
              {foot.tone === "bad" && <WarningIcon size={ICON.sm} className="shrink-0" />}
              <span>{foot.text}</span>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={close} disabled={phase === "running"} className="text-[11px] px-2.5 py-1 rounded disabled:opacity-40 shrink-0"
                style={{ color: "var(--text2)", border: EDGE, visibility: phase === "done" ? "hidden" : "visible" }}>Cancel</button>
              <button onClick={phase === "done" ? close : () => { void go(); }} disabled={phase !== "done" && !view.canSubmit}
                className="text-[11px] px-2.5 py-1 rounded font-medium disabled:opacity-40 min-w-[96px] text-center"
                style={{ color: "var(--on-primary)", background: "var(--primary)" }}>{label}</button>
            </div>
          </div>
        </motion.div>
      </div>
    </>
  );
}

/** `const { show, dialog } = useMoveForm()` — render `dialog`, await `show(spec)`: the move's answer once it landed, null when closed before. */
export function useMoveForm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const open = useRef<Pending | null>(null);
  const noteAsker = useOwnedQuestion(pending, () => open.current?.resolve(null));
  const show = (spec: MoveFormSpec): Promise<MoveFormResult> => new Promise((resolve) => {
    open.current?.resolve(null);
    noteAsker();
    const next: Pending = { ...spec, resolve: (r) => { open.current = null; setPending(null); resolve(r); } };
    open.current = next;
    setPending(next);
  });
  const dialog = (
    <AnimatePresence>
      {pending && <Portal><MoveForm key={pending.card.key} spec={pending} onDone={pending.resolve} /></Portal>}
    </AnimatePresence>
  );
  return { show, dialog };
}
