/*
 * The "Clean up local leftovers" button and its badge on a merged or closed PR
 * (mockup frames 2, 4 and 5). Self-contained: give it the project root and the
 * PR number; it reads the project's cleanup.mode and the dry-run plan itself,
 * and opens the CleanupDialog. Shown only when the mode is not Off, and the button only when the plan lists something.
 * Hook point: PrPanel.tsx, in the footer of the merged/closed section.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { modeOf } from "../lib/cleanupSettings.ts";
import { actionView, leftAfter, showsAction, type Plan } from "../lib/cleanupPr.ts";
import { offerFor, stateOfPlan } from "../lib/leftovers.ts";
import { isRunning, subscribeRuns } from "../lib/cleanupEvents.ts";
import { LockIcon, SparkleIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { CleanupDialog } from "./CleanupDialog.tsx";
import "./cleanupPr.css";

export function CleanupPrAction({ root, pr, state }: { root: string; pr: number; state: "MERGED" | "CLOSED" | "OPEN" }): ReactElement | null {
  const [mode, setMode] = useState<ReturnType<typeof modeOf> | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  /* Bytes the last run of this PR removed: with nothing left the badge says "Cleaned up", not "No leftovers". */
  const [freed, setFreed] = useState<number | null>(null);
  const [busy, setBusy] = useState(() => isRunning(root, pr));
  const seq = useRef(0);
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    setMode(null);
    api.settingAt("cleanup.mode", root).then((m) => { if (alive.current) setMode(modeOf(m.value)); }).catch(() => { if (alive.current) setMode("ask"); });
  }, [root]);

  const read = useCallback(() => {
    setPlan(null); setFailed(false);
    const mine = ++seq.current; // two reads in flight: only the newest may draw
    const fail = (): void => { if (alive.current && mine === seq.current) { setPlan(null); setFailed(true); } };
    api.cleanupPlan(root, pr).then((r) => { if (!alive.current || mine !== seq.current) return; if (r.ok && r.plan) setPlan(r.plan); else fail(); }).catch(fail);
  }, [root, pr]);
  const on = mode !== null && showsAction(mode, state);
  useEffect(() => { if (on) read(); }, [on, read]);

  /* A run of this PR ended anywhere (this dialog, the merge, the toast's Details): the report's own re-read says what is left, so the view changes at once. With no re-read the plan is read again. */
  useEffect(() => subscribeRuns((e) => {
    if (e.repo !== root || e.pr !== pr) return;
    setBusy(e.phase === "start");
    if (e.phase !== "end" || !alive.current) return;
    if (e.report) setFreed((f) => (f ?? 0) + e.report!.freedBytes);
    const left = e.report ? leftAfter(e.report) : null;
    const blocks = e.report?.remaining?.blocks ?? [];
    const p = planRef.current;
    if (left === 0 && blocks.length === 0 && p) { seq.current++; setFailed(false); setPlan({ ...p, items: [], blocks: [] }); }
    else read();
  }), [root, pr, read]);
  useEffect(() => { setFreed(null); setBusy(isRunning(root, pr)); }, [root, pr]);

  if (!on) return null;
  const v = actionView(plan, freed);
  /* One rule for every surface (lib/leftovers.ts): a button only when the plan has a real item; reading and a failed read draw none. */
  const offer = offerFor(stateOfPlan(plan, failed), "panel");
  return (
    <div className="agx-cp" data-cleanup-action="">
      <span className="agx-cp-fl"><LockIcon size={ICON.sm} /><span>{v.blocked ? `Blocked: ${v.blocked}` : "Nothing on GitHub changes"}</span></span>
      {offer.skeleton && <i className="agx-sk" aria-hidden style={{ width: 96, height: 18 }} />}
      {offer.muted && offer.chip && <span className="agx-cp-badge" data-tone="none" title={offer.tooltip}><WarningIcon size={ICON.xs} />{offer.chip}</span>}
      {plan && v.badge && <span className="agx-cp-badge" data-tone={v.tone} title={offer.tooltip || undefined}>{v.tone !== "none" && <SparkleIcon size={ICON.xs} />}{v.badge}</span>}
      {offer.button && <button type="button" className={`agx-cln-btn primary agx-cp-btn`} data-status="ready" data-strong={v.strong ? "" : undefined}
        disabled={busy || !!v.blocked} onClick={() => setOpen(true)}
        title={v.blocked || "See what would be removed from this computer. Nothing is removed until you confirm."}>
        <SparkleIcon size={ICON.xs} />{busy ? "Cleaning up\u2026" : "Clean up local leftovers"}
      </button>}
      {open && <CleanupDialog repo={root} pr={pr} onClose={() => setOpen(false)} />}
    </div>
  );
}
