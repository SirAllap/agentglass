/*
 * The projects of this site and the statuses each has, read once and shared.
 *
 * The same idea as clickupSpaces: the "What we found" card and the map's
 * coverage lines are one read, not two. The server holds the answer ten minutes
 * (and Jira is asked for nothing on a recount); this holds it as long, and a
 * Re-read press goes past this one and the cards the server holds, not its ten-minute
 * list of a project's statuses. A refusal is not kept: it is shown as one and
 * the last good answer stays on screen beside it, so a step is never rewritten
 * from nothing.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import type { JiraUnit } from "../../../shared/jiraStatusUnits.ts";

const TTL = 10 * 60_000;

export type UnitsState =
  | { kind: "loading"; stale?: JiraUnit[] }
  | { kind: "ok"; units: JiraUnit[]; at: number; note?: string; counted: string[] }
  | { kind: "empty"; at: number }
  | { kind: "error"; error: string; throttled: boolean; stale?: JiraUnit[]; staleAt?: number };

let held: { units: JiraUnit[]; at: number; note?: string; counted: string[] } | null = null;
let inflight: Promise<UnitsState> | null = null;
const listeners = new Set<(s: UnitsState) => void>();

const fresh = (): UnitsState | null => {
  if (!held || Date.now() - held.at >= TTL) return null;
  return held.units.length ? { kind: "ok", ...held } : { kind: "empty", at: held.at };
};

/** `force` is the Re-read press and goes past every cache. `local` goes past this one only: a changed pick is a new answer from what the server holds. */
export function readUnits(force = false, local = false): Promise<UnitsState> {
  const now = force || local ? null : fresh();
  if (now) return Promise.resolve(now);
  if (inflight && !force && !local) return inflight;
  const p: Promise<UnitsState> = api.jiraStatusUnits(force)
    .then((r): UnitsState => {
      if (!r.ok) return { kind: "error", error: r.error || "Jira did not answer", throttled: r.throttled === true, stale: held?.units, staleAt: held?.at };
      const units = r.spaces ?? [];
      const note = r.note;
      held = { units, at: Date.now(), counted: r.counted ?? [], ...(note ? { note } : null) };
      return units.length ? { kind: "ok", ...held } : { kind: "empty", at: held.at };
    })
    .catch((): UnitsState => ({ kind: "error", error: "Could not reach the server", throttled: false, stale: held?.units, staleAt: held?.at }))
    .finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

/** The pick of counted projects changed: read the answer again past the held one and tell every holder. */
export function recountUnits(): void {
  void readUnits(false, true).then((s) => { for (const l of listeners) l(s); });
}

/** The credential changed: what was read under the old one goes. */
export function __forgetJiraUnits(): void { held = null; inflight = null; }

export function useJiraUnits(enabled = true): { state: UnitsState; reread: () => void } {
  const [state, setState] = useState<UnitsState>(() => fresh() ?? { kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listeners.add(setState);
    void readUnits().then((s) => { if (live) setState(s); });
    return () => { live = false; listeners.delete(setState); };
  }, [enabled]);
  const reread = useCallback(() => {
    setState((s) => ({ kind: "loading", stale: s.kind === "ok" ? s.units : s.kind === "error" ? s.stale : undefined }));
    void readUnits(true).then((s) => { setState(s); for (const l of listeners) l(s); });
  }, []);
  return { state, reread };
}

/**
 * Which projects count, as the last read says. Synchronous, because a SettingDef reads synchronously: with
 * nothing read yet it answers the default (none chosen) and starts the one read that will say.
 */
export function countedUnitsNow(): string[] {
  if (!held) { void readUnits(); return []; }
  return held.counted;
}

/** Save the pick of counted projects (the local settings file; nothing is asked of Jira) and re-answer from what the server holds. */
export function setCountedUnits(ids: string[]): Promise<boolean> {
  return api.setJiraCounted(ids).then((r) => { if (r?.ok) recountUnits(); return !!r?.ok; }).catch(() => false);
}
