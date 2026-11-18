/*
 * The Card tab's lifecycle, from the mockup (variant C): one block with the headline and its button, chips for the facts that
 * exist, one thin step bar with the tracker status, and a disclosure that opens the steps and the timeline with its role chips. It paints what lib/cardLifecycle.ts joined and decides nothing: a fact that came back absent is not drawn.
 */
import { useState, type CSSProperties } from "react";
import { ROLES, rolesWithRows, type Lifecycle, type Role, type StageView, type TimelineRow } from "../../../lib/cardLifecycle.ts";
import { ROLE_LABEL } from "../../../lib/cardRoles.ts";
import { openFlightPlan } from "../../../lib/flightPlanNav.ts";
import { Button } from "../../workspace/Chrome.tsx";
import { JD_DOT } from "./metrics.ts";

const when = (at: number): string => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The words a step says for itself, for the screen reader and the opened list. */
const STATE_WORD: Record<StageView["state"], string> = { done: "done", current: "current", todo: "not reached", skipped: "skipped" };

/** The bar's caption: the current step (or the last one reached) and where it sits, "PR 5 of 7". Nothing reached: the first. */
export function barCaption(stages: readonly StageView[], errored = false): string {
  if (!stages.length) return "";
  let at = stages.findIndex((s) => s.state === "current");
  if (at < 0) at = Math.max(0, stages.map((s) => s.state).lastIndexOf("done"));
  if (errored) return `${stages[at]!.label} errored`;
  return `${stages[at]!.label} ${at + 1} of ${stages.length}`;
}

/** Facts that exist, as chips: cost, the pull request, the checks. A fact with no reading is not drawn. */
function Chips({ life, onPr }: { life: Lifecycle; onPr: (() => void) | undefined }) {
  const cost = life.tiles.find((t) => t.id === "cost");
  const checks = life.tiles.find((t) => t.id === "checks");
  if (!cost && life.prNumber === null && !checks) return null;
  return (
    <div className="agx-jd-chips">
      {cost && <span className="agx-jd-chip">Cost <b className="tabular-nums">{cost.value}</b></span>}
      {life.prNumber !== null && (onPr
        ? <button type="button" className="agx-jd-chip" data-open onClick={onPr}>PR <b className="tabular-nums">#{life.prNumber}</b></button>
        : <span className="agx-jd-chip">PR <b className="tabular-nums">#{life.prNumber}</b></span>)}
      {checks && <span className="agx-jd-chip" data-tone={checks.tone}>Checks <b className="tabular-nums">{checks.value}</b></span>}
    </div>
  );
}

/** One thin bar of segments, one per step, and under it the caption and the tracker's status in its own upper case. */
function StepBar({ life }: { life: Lifecycle }) {
  const bad = life.next.tone === "bad";
  const caption = barCaption(life.stages, bad);
  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <div className="agx-jd-seg" role="img" aria-label={caption}>
        {life.stages.map((s) => <i key={s.id} data-state={s.state} data-bad={s.state === "current" && bad ? "" : undefined} />)}
      </div>
      <div className="agx-jd-segl">
        <span>{caption}</span>
        {life.status && <span className="agx-jd-status">{life.status.toUpperCase()}</span>}
      </div>
    </div>
  );
}

export function StageList({ stages }: { stages: readonly StageView[] }) {
  return (
    <ol className="agx-jd-steps" aria-label="Steps">
      {stages.map((s) => (
        <li key={s.id} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
          <span className="agx-jd-step-m" aria-hidden />
          <span className="agx-jd-step-l">{s.label}</span>
          <span className="agx-jd-step-s">{STATE_WORD[s.state]}{s.at ? `, ${when(s.at)}` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

/** Fewer events than this and the role filter has nothing to narrow. */
export const ROLE_FILTER_MIN = 5;

export function Timeline({ rows }: { rows: readonly TimelineRow[] }) {
  const [only, setOnly] = useState<ReadonlySet<Role>>(new Set());
  const present = rolesWithRows(rows);
  const shown = only.size ? rows.filter((r) => r.role && only.has(r.role)) : rows;
  const toggle = (r: Role) => setOnly((cur) => { const n = new Set(cur); if (n.has(r)) n.delete(r); else n.add(r); return n; });
  if (!rows.length) return null;
  return (
    <section aria-label={`Timeline, ${rows.length} ${rows.length === 1 ? "event" : "events"}`} className="flex flex-col min-w-0" style={{ gap: 8, "--jd-dot": `${JD_DOT}px` } as CSSProperties}>
      {/* The role chips only narrow the list below; with a handful of events there is nothing to narrow, and two coloured
          pills under the heading read as buttons that start something (measured: Builder and Verifier over two events
          were taken for "open a terminal"). So they show from ROLE_FILTER_MIN events, with a word that says what they do. */}
      {present.length > 1 && rows.length >= ROLE_FILTER_MIN && (
        <div className="agx-jd-roles" role="group" aria-label="Show only one role's events">
          <span className="agx-jd-ev-at">Show</span>
          {ROLES.filter((r) => present.includes(r)).map((r) => (
            <button key={r} type="button" className="agx-jd-role" data-role={r} aria-pressed={only.has(r)} onClick={() => toggle(r)}>{ROLE_LABEL[r]}</button>
          ))}
        </div>
      )}
      <ol className="agx-jd-tl">
        {shown.map((r) => (
          <li key={r.id} className="agx-jd-ev" data-tone={r.tone}>
            <span className="agx-jd-ev-dot" aria-hidden />
            <div className="flex items-baseline flex-wrap min-w-0" style={{ gap: 8 }}>
              {r.role && <span className="agx-jd-role-tag" data-role={r.role}>{ROLE_LABEL[r.role]}</span>}
              <span className="agx-jd-ev-t">{r.title}</span>
              <span className="flex-1" />
              <span className="agx-jd-ev-at tabular-nums">{r.at ? when(r.at) : "now"}</span>
            </div>
            {r.detail && <div className="agx-jd-ev-d">{r.detail}</div>}
            {r.plan && <button type="button" className="agx-jd-link" onClick={() => openFlightPlan({ plan: r.plan })}>Open plan</button>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One block: the headline and its button, the chips, the bar, and a disclosure that opens the full steps and the timeline in place. */
export function LifecycleBlocks({ life, onAct, onPr }: { life: Lifecycle; onAct: () => void; onPr?: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const { next } = life;
  const n = life.timeline.length;
  const showBtn = next.kind !== "none" && next.kind !== "send";
  return (
    <section className="agx-jd-work" data-tone={next.tone === "bad" || next.tone === "warn" ? next.tone : undefined} aria-label="Card work">
      <div className="flex items-start min-w-0" style={{ gap: 12 }}>
        <div className="flex-1 min-w-0">
          <div className="agx-jd-next-t">{next.title}</div>
          <div className="agx-jd-next-b">{next.body}</div>
        </div>
        {showBtn && <Button size="hit" className="shrink-0" onClick={onAct}>{next.kind === "open-worker" ? "Open terminal" : next.label}</Button>}
      </div>
      <Chips life={life} onPr={onPr} />
      <StepBar life={life} />
      <button type="button" className="agx-jd-more" aria-expanded={open} aria-controls="agx-jd-work-more" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide steps" : "Show steps"}{n ? ` and ${n} ${n === 1 ? "event" : "events"}` : ""}
      </button>
      {open && (
        <div id="agx-jd-work-more" className="flex flex-col min-w-0" style={{ gap: 12 }}>
          <StageList stages={life.stages} />
          <Timeline rows={life.timeline} />
        </div>
      )}
    </section>
  );
}
