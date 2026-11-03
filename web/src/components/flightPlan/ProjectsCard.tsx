import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { Strip } from "../../lib/flightPilot.ts";
import { flipMoment, pillWording, momentsLine, momentsOf, MOMENTS, type Moment } from "../../lib/flightProjects.ts";
import { projectName } from "../../lib/flightPlan.ts";
import { LockIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { noteFor, type RowNote } from "../../lib/pilotSettings.ts";
import { FolderIcon } from "./fpIcons.tsx";
import { ModeBadge } from "./PilotStrip.tsx";
import { PROJECT_ON } from "./usePilotFeed.ts";

const REVIEWS = "flightPlan.preflight.reviews";

export interface ProjectRow {
  root: string;
  /** False when the person left this project out of Flight plan. */
  on: boolean;
  strip: Pick<Strip, "mode" | "badge">;
  /** The seat's name; null when nobody sits in this project's chair. */
  seat: string | null;
  /** Plans that wait on the person in the mode the project flies in now. */
  waiting: number;
}

type Reviews = Record<string, { on: Moment[]; own: boolean }>;

/*
 * The Preflight moments of every project, read at the project. `own` is false
 * while the project follows the default: its slot is drawn dashed. A write is
 * optimistic and goes back if the door refuses it.
 */
function useMoments(roots: string[], onWrote: () => void) {
  const [vals, setVals] = useState<Reviews>({});
  const [note, setNote] = useState<RowNote | undefined>();
  const live = useRef(true);
  const key = roots.join("\n");
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const load = useCallback(async () => {
    const rows = await Promise.all((key ? key.split("\n") : []).map(async (r) => {
      const x = await api.settingAt(REVIEWS, r).catch(() => null);
      return [r, { on: momentsOf(x?.value), own: x?.scopedSet === true }] as const;
    }));
    if (live.current) setVals(Object.fromEntries(rows));
  }, [key]);
  useEffect(() => { void load(); }, [load]);
  const flip = async (root: string, m: Moment) => {
    const now = vals[root]?.on ?? [];
    const next = flipMoment(now, m);
    setVals((v) => ({ ...v, [root]: { on: next, own: true } }));
    setNote(undefined);
    const r = await api.settingAtSet(REVIEWS, next, root).catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; applied?: boolean; error?: string }));
    if (!live.current) return;
    const n = noteFor(r);
    setNote(n ?? undefined);
    if (n) void load(); else onWrote();
  };
  return { vals, note, flip, reload: load };
}

/** One row per project in scope: pick one to edit it below; the three moments are edited in place. */
export function ProjectsCard({ rows, selected, onSelect, enabled, onWrote, momentsRef }: {
  rows: ProjectRow[]; selected: string; onSelect: (root: string) => void; enabled: boolean; onWrote: () => void;
  /** Lets the Preflight card below ask this card to read again after it wrote the same key. */
  momentsRef?: { current: (() => void) | null };
}) {
  const m = useMoments(rows.map((r) => r.root), onWrote);
  const [onNote, setOnNote] = useState<RowNote | undefined>();
  /* In or out of Flight plan, for one project. Turning one ON waits for the person when an agent asks; the person's own click applies. */
  const setOn = async (root: string, on: boolean) => {
    const r = await api.settingAtSet(PROJECT_ON, on, root).catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; applied?: boolean; error?: string }));
    setOnNote(noteFor(r) ?? undefined);
    onWrote();
  };
  if (momentsRef) momentsRef.current = () => void m.reload();
  return (
    <section className="ps-card ps-prjs" aria-labelledby="ps-prjs-h">
      <div className="ps-ch">
        <span className="ps-ci"><FolderIcon size={ICON.md} /></span>
        <div><h4 id="ps-prjs-h">Projects</h4><p>Each project flies in its own mode, with its own seat and its own Preflight moments. Pick one to edit it below.</p></div>
        <span className="ps-badge" data-tone={enabled && rows.some((r) => r.on) ? "seat" : "none"}>{pillWording(enabled, rows.filter((r) => r.on).length, rows.length)}</span>
      </div>
      <div className="ps-prj-list" role="radiogroup" aria-labelledby="ps-prjs-h">
        {rows.length === 0 && <p className="ps-prj-empty">No project is open.</p>}
        {rows.map((r) => {
          const v = m.vals[r.root];
          const sel = r.root === selected;
          const name = projectName(r.root);
          return (
            <div key={r.root} className="ps-prj" data-sel={sel || undefined}>
              <button type="button" role="radio" aria-checked={sel} className="ps-prj-pick" onClick={() => onSelect(r.root)} title={r.root}>
                <span className="ps-prj-nm">{name}</span>
                {r.on ? <ModeBadge strip={r.strip} /> : <span className="ps-badge ps-prj-off" data-tone="none">Off</span>}
                <span className="ps-prj-seat" data-none={r.seat === null && r.on ? "" : undefined}>{!r.on ? "Not used here" : r.seat === null ? <><LockIcon size={ICON.xs} />No seat</> : r.seat === "" ? "Seat not read" : r.seat}</span>
                <span className="ps-prj-wait">{!r.on || r.waiting === 0 ? "nothing waits" : `${r.waiting} waiting on you`}</span>
                <span className="ps-prj-sum">{!r.on ? "No Preflight" : v ? momentsLine(v.on) : "not read yet"}</span>
              </button>
              <div className="ps-prj-mom" role="group" aria-label={`Flight plan and Preflight moments for ${name}`}>
                <button type="button" role="switch" aria-checked={r.on} aria-label={`Use Flight plan in ${name}`} className="ps-mom ps-onoff" data-on={r.on || undefined}
                  title={r.on ? "Flight plan is on here. Turn it off to leave this project out." : "Flight plan is off here. Turn it on to use it."} onClick={() => void setOn(r.root, !r.on)}>{r.on ? "On" : "Off"}</button>
                {MOMENTS.map(([k, w]) => {
                  const on = v?.on.includes(k) ?? false;
                  return (
                    <button key={k} type="button" className="ps-mom" aria-pressed={on} data-own={v?.own ? "" : undefined} disabled={!v || !r.on}
                      title={v?.own ? `${w}: this project's own choice` : `${w}: follows the default`} onClick={() => void m.flip(r.root, k)}>{w}</button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="ps-prj-note" data-tone={(m.note ?? onNote)?.kind} aria-live="polite">{m.note ?? onNote ? (m.note ?? onNote)!.text : "A dashed moment follows the default. Mode, seat, moments and On/Off are per project; the budget below is shared by all of them."}</p>
    </section>
  );
}
