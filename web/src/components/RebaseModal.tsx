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
import { GitDialog, RefStrip, DialogError, DialogSkeleton } from "./GitDialog.tsx";
import { UNREACHABLE } from "../lib/gitDialog.ts";
import { api } from "../lib/api.ts";
import { Button, INPUT, INPUT_STYLE, EDGE } from "./workspace/Chrome.tsx";
import { Select } from "./Select.tsx";

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
  onDone: (message: string) => void;
}) {
  const [steps, setSteps] = useState<RebaseStep[] | null>(null);
  /** Commits no remote has, from git — not the step count. */
  const [unpushed, setUnpushed] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setSteps(null); setErr(null);
    api.gitRebaseSteps(root, base)
      .then((r) => {
        if (!r.ok || !r.steps?.length) { setErr(r.error || "nothing to rebase"); setSteps([]); return; }
        setSteps(r.steps as RebaseStep[]);
        setUnpushed(r.unpushed ?? null);
      })
      .catch(() => { setErr(UNREACHABLE); setSteps([]); });
  }, [root, base, attempt]);

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
      onDone(`Rebased ${after} commit${after === 1 ? "" : "s"} onto ${base.slice(0, 7)}`);
    } catch { setErr(UNREACHABLE); }
    finally { setBusy(false); }
  };

  const n = steps?.length ?? 0;
  return (
    <GitDialog
      title={`Rebase ${branch}?`}
      subtitle={n ? `Replays ${n} commit${n === 1 ? "" : "s"} above the base, in the order and with the actions you pick.` : "Reads the commits above the base."}
      tone="warn" width={640}
      confirmLabel={busy ? "Rebasing…" : "Start rebase"} confirmDisabled={!n || busy} onConfirm={start}
      reason={n ? `Rewrites ${after} commit${after === 1 ? "" : "s"}${unpushed != null ? `, ${unpushed} not on any remote` : ""}. ORIG_HEAD holds the old tip until the next history move.` : undefined}
      locked={busy} onClose={onClose}
    >
      <RefStrip head={branch} base={base.slice(0, 7)} tone="warn" />
      {steps === null && <DialogSkeleton rows={4} label="Reading commits…" />}
      {err && !n && <DialogError message={err} onRetry={() => setAttempt((a) => a + 1)} />}
      {n > 0 && (
        <div className="space-y-1">
          {steps!.map((s, i) => (
            <div key={s.hash} className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
              style={{ background: s.action === "drop" ? "color-mix(in srgb, var(--error) 7%, transparent)" : "var(--surface-inset)", border: EDGE }}>
              <span className="shrink-0 tabular-nums text-[9.5px] t-dim2 w-4 text-right">{i + 1}</span>
              {/* Reorder. Up/down buttons rather than drag: the codebase
                  has no drag util, and for a list that is at most a few
                  dozen rows, two 14px buttons are faster and forgiving. */}
              <span className="shrink-0 flex gap-0.5">
                <Button tone="quiet" size="compact" square label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><CaretIcon className="rotate-180" /></Button>
                <Button tone="quiet" size="compact" square label="Move down" disabled={i === n - 1} onClick={() => move(i, 1)}><CaretIcon /></Button>
              </span>
              <Select value={s.action} onChange={(v) => setAction(i, v as RebaseStep["action"])} title={ACTION_HINT[s.action]}
                style={{ color: s.action === "drop" ? "var(--error)" : s.action === "reword" ? "var(--primary-hover)" : "var(--text2)" }}
                options={ACTIONS.map((a) => ({ value: a, label: a }))} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px]" title={s.subject} style={{ color: s.action === "drop" ? "var(--text3)" : "var(--text)", textDecoration: s.action === "drop" ? "line-through" : "none" }}>{s.subject}</span>
                {s.action === "reword" && (
                  <input value={s.newMessage ?? ""} onChange={(e) => setMsg(i, e.target.value)} placeholder={s.subject} autoFocus={i === steps!.findIndex((x) => x.action === "reword")}
                    className={`w-full mt-0.5 ${INPUT}`}
                    style={INPUT_STYLE} />
                )}
              </span>
              <span className="shrink-0 tabular-nums text-[9.5px] t-dim2 font-mono">{s.hash.slice(0, 7)}</span>
            </div>
          ))}
        </div>
      )}
      {n > 0 && (
        <div className="text-[10px] t-dim2 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span>{n} commit{n === 1 ? "" : "s"} above the base</span>
          {after !== n && <span style={{ color: "var(--warning-ink)" }}>{drops} dropped → {after} in the result</span>}
          {rewords > 0 && <span style={{ color: "var(--primary-hover)" }}>{rewords} reworded</span>}
          <span className="ml-auto">conflict → resolve, then Continue; Abort puts the branch back</span>
        </div>
      )}
      {err && n > 0 && <DialogError message={err} />}
    </GitDialog>
  );
}
