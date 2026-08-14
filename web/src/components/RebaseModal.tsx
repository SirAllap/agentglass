/*
 * The interactive-rebase editor: enumerate `base..HEAD` as steps, let the user
 * reorder and reword them, and run the plan as ONE `git rebase -i`.
 *
 * Everything happens in the modal before anything moves: the plan is only sent
 * to the server once the user says "Start rebase", and the server re-validates
 * it (every commit accounted for, exactly once) before git sees a single line.
 *
 * A conflict pauses the rebase as the existing conflict screen — its continue
 * button replays the remaining steps, abort puts the branch back exactly. This
 * modal closes on start; the conflict screen owns the rest.
 */
import { useEffect, useState } from "react";
import { CaretIcon } from "../lib/glyphIcons.tsx";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { api } from "../lib/api.ts";

export type RebaseStep = { action: "pick" | "squash" | "fixup" | "drop" | "reword" | "edit"; hash: string; subject: string; newMessage?: string };

const ACTIONS: RebaseStep["action"][] = ["pick", "squash", "fixup", "reword", "drop", "edit"];
const ACTION_HINT: Record<RebaseStep["action"], string> = {
  pick: "Replay the commit as it is",
  squash: "Fold it into the commit above, keeping its message",
  fixup: "Fold it into the commit above, discarding its message",
  reword: "Replay it with a new message",
  drop: "Leave the commit out",
  edit: "Stop after replaying it, so you can amend it by hand",
};

export function RebaseModal({ root, base, branch, onClose, onDone }: {
  root: string;
  /** The commit the rebase starts from — everything above it is on the list. */
  base: string;
  branch: string;
  onClose: () => void;
  /** Called after a successful run so the log can reload. */
  onDone: () => void;
}) {
  const [steps, setSteps] = useState<RebaseStep[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.gitRebaseSteps(root, base)
      .then((r) => {
        if (!r.ok || !r.steps?.length) { setErr(r.error || "nothing to rebase"); setSteps([]); return; }
        setSteps(r.steps as RebaseStep[]);
      })
      .catch((e) => { setErr(String(e)); setSteps([]); });
  }, [root, base]);

  const move = (i: number, dir: -1 | 1) => setSteps((prev) => {
    if (!prev) return prev;
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });

  const setAction = (i: number, action: RebaseStep["action"]) => setSteps((prev) => prev?.map((s, k) => (k === i ? { ...s, action } : s)) ?? prev);
  const setMsg = (i: number, msg: string) => setSteps((prev) => prev?.map((s, k) => (k === i ? { ...s, newMessage: msg } : s)) ?? prev);

  const rewords = steps?.filter((s) => s.action === "reword").length ?? 0;
  const drops = steps?.filter((s) => s.action === "drop").length ?? 0;
  const after = steps ? steps.length - drops : 0;

  const start = async () => {
    if (!steps || busy) return;
    // A reword with an empty message is a reword that keeps the subject —
    // refusing it would be the pedantry nobody asked for.
    const plan = steps.map((s) => (s.action === "reword" && !s.newMessage?.trim() ? { ...s, newMessage: s.subject } : s));
    setBusy(true); setErr(null);
    try {
      const r = await api.gitRebaseRun(root, base, plan);
      if (!r.ok) { setErr(r.error || "rebase failed"); return; }
      onDone();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Portal>
      <AnimatePresence>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 agx-scrim" style={{ zIndex: 10002 }} onClick={onClose} />
        <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10003 }}>
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 340, damping: 30 }}
            className="w-[min(640px,94vw)] max-h-[min(720px,92vh)] rounded-2xl flex flex-col pointer-events-auto"
            style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
          >
            <div className="flex items-center gap-2.5 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
              <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Rebase</span>
              <span className="chip text-[10px]" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 14%, transparent)" }}>⎇ {branch}</span>
              <span className="min-w-0 truncate text-[10.5px] t-dim2 font-mono" title={base}>{base.slice(0, 7)}…</span>
              <CloseButton onClick={onClose} className="ml-auto" />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
              {err && !steps?.length && (
                <div className="text-[11.5px] px-3 py-2 rounded-lg" style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 12%, transparent)" }}>{err}</div>
              )}
              {steps === null && <div className="t-dim2 text-center py-12 text-[12px]">Reading commits…</div>}
              {steps && steps.length > 0 && (
                <div className="space-y-1">
                  {steps.map((s, i) => (
                    <div key={s.hash} className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
                      style={{ background: s.action === "drop" ? "color-mix(in srgb, var(--error) 7%, transparent)" : "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
                      <span className="shrink-0 tabular-nums text-[9.5px] t-dim2 w-4 text-right">{i + 1}</span>
                      {/* Reorder. Up/down buttons rather than drag: the codebase
                          has no drag util, and for a list that is at most a few
                          dozen rows, two 14px buttons are faster and forgiving. */}
                      <span className="shrink-0 flex flex-col">
                        <button disabled={i === 0} onClick={() => move(i, -1)} className="inline-flex items-center justify-center rounded t-dim2 disabled:opacity-25" title="Move up"><CaretIcon className="rotate-180" /></button>
                        <button disabled={i === steps.length - 1} onClick={() => move(i, 1)} className="inline-flex items-center justify-center rounded t-dim2 disabled:opacity-25" title="Move down"><CaretIcon /></button>
                      </span>
                      <select value={s.action} onChange={(e) => setAction(i, e.target.value as RebaseStep["action"])} title={ACTION_HINT[s.action]}
                        className="shrink-0 text-[10px] px-1.5 py-0.5 rounded outline-none"
                        style={{ background: "color-mix(in srgb, var(--bg2) 80%, black)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: s.action === "drop" ? "var(--error)" : s.action === "reword" ? "var(--primary-hover)" : "var(--text2)" }}>
                        {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px]" style={{ color: s.action === "drop" ? "var(--text3)" : "var(--text)", textDecoration: s.action === "drop" ? "line-through" : "none" }}>{s.subject}</span>
                        {s.action === "reword" && (
                          <input value={s.newMessage ?? ""} onChange={(e) => setMsg(i, e.target.value)} placeholder={s.subject} autoFocus={i === steps.findIndex((x) => x.action === "reword")}
                            className="w-full mt-0.5 px-2 py-0.5 rounded text-[11px] outline-none"
                            style={{ background: "color-mix(in srgb, var(--bg2) 70%, black)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", color: "var(--text)" }} />
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-[9.5px] t-dim2 font-mono">{s.hash.slice(0, 7)}</span>
                    </div>
                  ))}
                </div>
              )}
              {steps && steps.length > 0 && (
                <div className="mt-2.5 text-[10px] t-dim2 flex items-center gap-3">
                  <span>{steps.length} commits above the base</span>
                  {after !== steps.length && <span style={{ color: "var(--warning)" }}>{drops} dropped → {after} in the result</span>}
                  {rewords > 0 && <span style={{ color: "var(--primary-hover)" }}>{rewords} reworded</span>}
                  <span className="ml-auto">conflict → resolve, then Continue; Abort puts the branch back</span>
                </div>
              )}
              {err && steps && steps.length > 0 && (
                <div className="mt-2 text-[11px] px-3 py-2 rounded-lg font-mono" style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 12%, transparent)" }}>{err}</div>
              )}
            </div>

            <div className="flex items-center gap-2 px-5 py-3 border-t shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
              <span className="text-[10px] t-dim2">Rewrites {after} unpushed commit{after === 1 ? "" : "s"} — ORIG_HEAD holds the old tip until the next history move.</span>
              <button onClick={start} disabled={!steps?.length || busy}
                className="ml-auto px-3.5 py-1.5 rounded-lg text-[11px] font-medium"
                style={{ background: "var(--primary)", color: "var(--bg)", opacity: !steps?.length || busy ? 0.45 : 1 }}>
                {busy ? "Rebasing…" : `Start rebase`}
              </button>
            </div>
          </motion.div>
        </div>
      </AnimatePresence>
    </Portal>
  );
}
