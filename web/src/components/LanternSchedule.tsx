/*
 * SCHEDULED STARTS, on the Agents screen — "at 08:00 start this agent, with
 * this prompt, in this checkout".
 *
 * The board is where you look to see who is working; this is where you say
 * who will be. A small dialog (name, checkout, when, prompt, yolo). The ones
 * that are waiting are rows of "Up next" with a Cancel, and one that will
 * never fire is a line of "Clean up".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { wash } from "./git/ui.tsx";
import { ClockIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { INPUT, INPUT_STYLE, EDGE, LINE } from "./workspace/Chrome.tsx";

export interface AgentSchedule {
  id: string; name: string; cwd: string; kind: string; prompt: string; yolo: boolean;
  due: number; created: number; firedAt: number | null; cancelledAt: number | null; result: string;
}


/** The dialog. `checkouts` are the open project's, offered as a list; a path
 *  typed by hand is allowed too and the server decides if it is in scope. */
export function ScheduleDialog({ open, checkouts, onClose, onAdded }: {
  open: boolean; checkouts: string[]; onClose: () => void; onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(checkouts[0] ?? "");
  const [when, setWhen] = useState("08:00");
  const [prompt, setPrompt] = useState("");
  const [yolo, setYolo] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    if (!cwd && checkouts[0]) setCwd(checkouts[0]);
    const t = setTimeout(() => nameRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [open, checkouts, cwd]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.agentSchedule({ name: name.trim(), cwd: cwd.trim(), when: when.trim(), prompt, yolo });
      if (!r.ok) { setErr(r.error ?? "could not schedule"); return; }
      setName(""); setPrompt("");
      onAdded(); onClose();
    } catch { setErr("the server did not answer"); }
    finally { setBusy(false); }
  }, [busy, name, cwd, when, prompt, yolo, onAdded, onClose]);

  const field = "w-full text-[12px] px-2.5 py-1.5 rounded-md outline-none";
  const fieldStyle = { background: "var(--bg)", border: EDGE, color: "var(--text)" } as const;
  const label = (t: string, hint?: string) => (
    <div className="flex items-baseline justify-between gap-2 mb-1 min-w-0">
      <span className="text-[9.5px] uppercase tracking-[0.14em] shrink-0" style={{ color: "var(--text4)" }}>{t}</span>
      {hint && <span className="text-[10px] truncate" style={{ color: "var(--text4)" }}>{hint}</span>}
    </div>
  );

  return (
    <AnimatePresence>
      {open && (
        <Portal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 agx-scrim" style={{ zIndex: 10004 }} onClick={onClose} />
          <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10005 }}>
            <motion.div initial={{ opacity: 0, scale: 0.98, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
              className="pointer-events-auto w-full max-w-[560px] rounded-xl overflow-hidden agx-card" role="dialog" aria-modal="true" aria-label="Schedule an agent">
              <div className="px-5 pt-4 pb-3 flex items-baseline gap-3" style={{ borderBottom: LINE }}>
                <span aria-hidden className="flex"><ClockIcon size={ICON.md} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-semibold" style={{ color: "var(--text)" }}>Schedule an agent</div>
                  <div className="text-[11px]" style={{ color: "var(--text3)" }}>It is seated by name in the checkout, at the time, with the prompt as its first message — the machine has to be awake.</div>
                </div>
              </div>
              <form className="px-5 py-4 flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 160px" }}>
                  <div>
                    {label("Name", "letters, digits, - _ .")}
                    <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-tests" className={INPUT} style={INPUT_STYLE} />
                  </div>
                  <div>
                    {label("When", "08:00 · +30m")}
                    <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="08:00" className={`tabular-nums ${INPUT}`} style={INPUT_STYLE} />
                  </div>
                </div>
                <div>
                  {label("Checkout")}
                  <input value={cwd} onChange={(e) => setCwd(e.target.value)} list="agx-schedule-checkouts" placeholder="/path/to/a/checkout in the open project" className={INPUT} style={INPUT_STYLE} />
                  <datalist id="agx-schedule-checkouts">{checkouts.map((c) => <option key={c} value={c} />)}</datalist>
                </div>
                <div>
                  {label("First message", "optional")}
                  <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Run the full suite, fix what is red, leave a commit per fix. Do not push."
                    className={`${field} resize-y`} style={fieldStyle} />
                </div>
                <label className="flex items-start gap-2 text-[11.5px] cursor-pointer select-none" style={{ color: "var(--text2)" }}>
                  <input type="checkbox" checked={yolo} onChange={(e) => setYolo(e.target.checked)} className="mt-0.5" />
                  <span className="flex flex-col">
                    <span className="whitespace-nowrap">Skip permission prompts</span>
                    <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>Only if Settings allow it — checked again when it fires.</span>
                  </span>
                </label>
                {err && <div className="text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button type="button" onClick={onClose} className="agx-btn text-[11px] px-2.5 py-1 rounded-md" style={{ color: "var(--text2)", border: EDGE }}>Cancel</button>
                  <button type="submit" disabled={busy || !name.trim() || !cwd.trim() || !when.trim()}
                    className="agx-btn text-[11px] px-3 py-1 rounded-md font-medium disabled:opacity-50"
                    style={{ color: "var(--text)", background: wash("--primary", 26), border: `1px solid ${wash("--primary", 55)}` }}>
                    {busy ? "Scheduling…" : "Schedule"}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        </Portal>
      )}
    </AnimatePresence>
  );
}
