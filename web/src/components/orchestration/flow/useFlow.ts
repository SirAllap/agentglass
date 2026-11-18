/*
 * One project's flow, read from the server and kept as a value the screens
 * edit. A flow that came from the shipped template carries places that are
 * only a starting guess (`x` spaced by a fixed step, `y` at 0); they are
 * dropped here so the canvas lays the blocks out for its own width instead of
 * drawing them across the orchestrator.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Flow } from "../../../../../shared/flow.ts";
import { api } from "../../../lib/api.ts";
import type { FlowLoad } from "../../../lib/flowView.ts";

export interface FlowSource {
  load: FlowLoad;
  scope: "project" | "template" | null;
  /** Who made the last write, when there is a step to undo. */
  undo: { who: string; at: number } | null;
  reload: () => void;
  /** Keep the note the server answered with after a save. */
  noteWrite: (undo: { who: string; at: number } | null | undefined) => void;
  /** Put back the flow from before the last write; the server's sentence when it would not. */
  undoLast: () => Promise<string | null>;
}

export function useFlow(root: string): FlowSource {
  const [load, setLoad] = useState<FlowLoad>({ state: "loading" });
  const [scope, setScope] = useState<"project" | "template" | null>(null);
  const [undo, setUndo] = useState<{ who: string; at: number } | null>(null);
  const [version, setVersion] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!root) { setLoad({ state: "loaded", flow: null }); setScope(null); setUndo(null); return; }
    setLoad({ state: "loading" });
    void api.getFlow(root).then((r) => {
      if (!alive.current) return;
      if (!r.ok) { setLoad({ state: "failed", error: r.error ?? "The server did not answer." }); return; }
      setScope(r.scope);
      setUndo(r.undo ?? null);
      setLoad({ state: "loaded", flow: r.scope === "template" ? { ...r.flow, blocks: [] } : r.flow });
    }).catch(() => { if (alive.current) setLoad({ state: "failed", error: "Could not reach the server." }); });
  }, [root, version]);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const noteWrite = useCallback((next: { who: string; at: number } | null | undefined) => setUndo(next ?? null), []);
  const undoLast = useCallback(async () => {
    const r = await api.undoFlow(root).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!r.ok) return r.error ?? "The server did not undo it.";
    setUndo(r.undo ?? null);
    setVersion((n) => n + 1);
    return null;
  }, [root]);
  return { load, scope, undo, reload, noteWrite, undoLast };
}

export type { Flow };
