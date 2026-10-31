/*
 * What a click on a container does. One place for the verbs so the row, the
 * menu, the key and the detail bar cannot disagree. Nothing refetches after a
 * verb: Docker reports the change on its event stream and the data hook hears
 * it, which is also how a change made from a terminal shows up.
 */
import { useCallback, useRef, useState } from "react";
import type { DockerActionResult, DockerContainer } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { displayName } from "../../lib/dockerState.ts";

export type Verb = "start" | "stop" | "restart" | "unpause" | "rm";

const FN = (v: Verb): ((id: string) => Promise<DockerActionResult>) =>
  ({ start: api.dockerStart, stop: api.dockerStop, restart: api.dockerRestart, unpause: api.dockerUnpause, rm: api.dockerRm })[v];
const PAST: Record<Verb, string> = { start: "started", stop: "stopped", restart: "restarted", unpause: "resumed", rm: "removed" };

export function useDockerActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const gone = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((ok: boolean, msg: string) => {
    setToast({ ok, msg });
    if (gone.current) clearTimeout(gone.current);
    gone.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const act = useCallback(async (c: DockerContainer, verb: Verb) => {
    if (busy) return;
    setBusy(c.id);
    try {
      const r = await FN(verb)(c.id);
      flash(r.ok, r.ok ? `${displayName(c)} ${PAST[verb]}` : (r.error || "Failed"));
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(null); }
  }, [busy, flash]);

  /**
   * The same verb across a stack. Sequential, not parallel: compose brings a
   * stack up in dependency order for a reason, and twelve starts at once race a
   * database against the things that need it. Reports what happened, because
   * one container failing among eleven is the case worth naming.
   */
  const group = useCallback(async (cs: DockerContainer[], verb: "start" | "stop" | "restart") => {
    if (busy || !cs.length) return;
    setBusy("group");
    let ok = 0;
    const failed: string[] = [];
    try {
      for (const c of cs) {
        try { if ((await FN(verb)(c.id)).ok) ok++; else failed.push(displayName(c)); }
        catch { failed.push(displayName(c)); }
      }
      flash(!failed.length, failed.length
        ? `${PAST[verb]} ${ok}, failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`
        : `${PAST[verb]} ${ok} container${ok === 1 ? "" : "s"}`);
    } finally { setBusy(null); }
  }, [busy, flash]);

  return { busy, toast, flash, act, group };
}
