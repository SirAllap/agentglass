/*
 * SCHEDULED STARTS, on the Lantern — "at 08:00 start this agent, with this
 * prompt, in this checkout", and the list of what is waiting and what fired.
 *
 * The board is where you look to see who is working; this is where you say
 * who will be. A small dialog (name, checkout, when, prompt, yolo), and under
 * the field a quiet section of the schedules: waiting ones with a Cancel,
 * fired ones with what happened — the pane it started in, or why it did not.
 * Same cards as the agents', smaller: one design, not a second one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { edge, wash } from "./git/ui.tsx";

export interface AgentSchedule {
  id: string; name: string; cwd: string; kind: string; prompt: string; yolo: boolean;
  due: number; created: number; firedAt: number | null; cancelledAt: number | null; result: string;
}

const here = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const clock = (t: number) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

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
  const fieldStyle = { background: "var(--bg)", border: edge(14), color: "var(--text)" } as const;
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
              <div className="px-5 pt-4 pb-3 flex items-baseline gap-3" style={{ borderBottom: edge(10) }}>
                <span aria-hidden style={{ fontSize: 16 }}>⏰</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-semibold" style={{ color: "var(--text)" }}>Schedule an agent</div>
                  <div className="text-[11px]" style={{ color: "var(--text3)" }}>It is seated by name in the checkout, at the time, with the prompt as its first message — the machine has to be awake.</div>
                </div>
              </div>
              <form className="px-5 py-4 flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 160px" }}>
                  <div>
                    {label("Name", "letters, digits, - _ .")}
                    <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-tests" className={field} style={fieldStyle} />
                  </div>
                  <div>
                    {label("When", "08:00 · +30m")}
                    <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="08:00" className={`${field} tabular-nums`} style={fieldStyle} />
                  </div>
                </div>
                <div>
                  {label("Checkout")}
                  <input value={cwd} onChange={(e) => setCwd(e.target.value)} list="agx-schedule-checkouts" placeholder="/path/to/a/checkout in the open project" className={field} style={fieldStyle} />
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
                {err && <div className="text-[11px]" style={{ color: "var(--error)" }}>{err}</div>}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button type="button" onClick={onClose} className="agx-btn text-[11px] px-2.5 py-1 rounded-md" style={{ color: "var(--text2)", border: edge(16) }}>Cancel</button>
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

/** The list under the field: waiting first, then what fired and how. */
export function ScheduledSection({ items, onCancel }: { items: AgentSchedule[]; onCancel: (id: string) => void }) {
  if (!items.length) return null;
  const waiting = items.filter((s) => !s.firedAt);
  const fired = items.filter((s) => s.firedAt).slice(0, 6);
  return (
    <section data-lantern-scheduled className="flex flex-col gap-2">
      <div className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>
        Scheduled · {waiting.length}{fired.length ? ` · ${fired.length} fired` : ""}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, alignItems: "start" }}>
        {[...waiting, ...fired].map((s) => {
          const ok = s.firedAt && s.result.startsWith("started");
          const tone = !s.firedAt ? "var(--primary)" : ok ? "var(--success)" : "var(--error)";
          return (
            <div key={s.id} className="agx-card agx-lantern-card flex flex-col gap-1.5 p-3.5 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span aria-hidden className="shrink-0 rounded-full" style={{ width: 8, height: 8, background: tone }} />
                <span className="text-[12.5px] font-semibold truncate" style={{ color: "var(--text)" }} title={s.name}>{s.name}</span>
                <span className="ml-auto shrink-0 text-[10.5px] tabular-nums" style={{ color: tone }} title={new Date(s.due).toLocaleString()}>
                  {s.firedAt ? `fired ${fmtAgo(s.firedAt)} ago` : clock(s.due)}
                </span>
              </div>
              <div className="text-[10.5px] truncate" style={{ color: "var(--text4)" }} title={s.cwd}>{here(s.cwd)}{s.yolo ? " · skips permission prompts" : ""}{s.kind !== "claude" ? ` · ${s.kind}` : ""}</div>
              {s.prompt && <div className="text-[11px] line-clamp-2" style={{ color: "var(--text3)" }} title={s.prompt}>{s.prompt}</div>}
              {s.firedAt && <div className="text-[10.5px]" style={{ color: ok ? "var(--text3)" : "var(--error)" }}>{s.result}</div>}
              {!s.firedAt && (
                <div className="flex justify-end pt-1" style={{ borderTop: edge(8) }}>
                  <button type="button" onClick={() => onCancel(s.id)} className="agx-btn text-[10.5px] px-2 py-0.5 rounded-md" style={{ color: "var(--text3)", border: edge(16) }} title="Cancel this schedule">Cancel</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
