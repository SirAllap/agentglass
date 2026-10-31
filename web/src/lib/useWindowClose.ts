/*
 * The one door every "close" goes through: the tab's x, a middle click, the
 * window menu, the dead pane's Close window and a project's Close all.
 *
 * The decision is lib/closeRules.ts; this holds the two small pieces of state
 * around it: a question waiting for an answer (only when an agent would be
 * stopped), and the toast that follows a close (Reopen for a few seconds).
 */
import { useCallback, useState } from "react";
import type { TmuxWindow } from "../../../shared/types.ts";
import { closeVerdict, closedSentence, reopenPlan, type CloseVerdict, type ReopenStep } from "./closeRules.ts";
import type { TmuxCmdBody } from "./tmuxCmd.ts";

export interface CloseAsk {
  ids: string[];
  verdict: Extract<CloseVerdict, { ask: true }>;
  /** The tab (or button) the question hangs from. */
  anchor: DOMRect | null;
}

export interface ClosedToast {
  /** A new close replaces the toast, and restarts its clock. */
  n: number;
  sentence: string;
  steps: ReopenStep[];
}

export interface WindowCloser {
  ask: CloseAsk | null;
  toast: ClosedToast | null;
  /** Close these windows, asking first only when an agent would be stopped. */
  request: (ids: readonly string[], opts?: { anchor?: Element | null; project?: string }) => void;
  confirm: () => void;
  keep: () => void;
  reopen: () => void;
  dismissToast: () => void;
}

export function useWindowClose(windows: readonly TmuxWindow[], root: string, cmd: (body: TmuxCmdBody) => void): WindowCloser {
  const [ask, setAsk] = useState<CloseAsk | null>(null);
  const [toast, setToast] = useState<ClosedToast | null>(null);
  const [n, setN] = useState(0);

  const run = useCallback((ids: readonly string[]) => {
    const targets = windows.filter((w) => ids.includes(w.id));
    if (!targets.length) return;
    const steps = reopenPlan(windows, ids);
    for (const t of targets) cmd({ cmd: "kill", window: t.id });
    setN((k) => k + 1);
    setToast({ n: n + 1, sentence: closedSentence(targets), steps });
  }, [windows, cmd, n]);

  const request = useCallback<WindowCloser["request"]>((ids, opts) => {
    const targets = windows.filter((w) => ids.includes(w.id));
    if (!targets.length) return;
    const verdict = closeVerdict(targets, opts?.project);
    if (!verdict.ask) { setAsk(null); run(ids); return; }
    setAsk({ ids: [...ids], verdict, anchor: opts?.anchor?.getBoundingClientRect() ?? null });
  }, [windows, run]);

  return {
    ask, toast, request,
    confirm: () => { if (ask) { const ids = ask.ids; setAsk(null); run(ids); } },
    keep: () => setAsk(null),
    reopen: () => {
      if (!toast) return;
      for (const s of toast.steps) cmd({ cmd: "reopen", name: s.name, root: s.cwd ?? root, window: s.anchor, after: s.after });
      setToast(null);
    },
    dismissToast: () => setToast(null),
  };
}
