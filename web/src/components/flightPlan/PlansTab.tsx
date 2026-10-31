import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Markdown } from "../../lib/markdown.tsx";
import { api } from "../../lib/api.ts";
import { filesWord, kb, lastName, splitPlan, stationStates, written, type PlanDetail } from "../../lib/flightPlan.ts";
import { builderFacts, flightNow, hhmm, lasted, stateSentence, stepsOf, type FlightItem, type Pilot, type PilotSnapshot } from "../../lib/flightPilot.ts";
import { StateTile } from "./StateBadge.tsx";
import { MockupThumb } from "./MockupThumb.tsx";
import { PlanCompare } from "./PlanCompare.tsx";
import { FindingsCard } from "./FindingsCard.tsx";
import { Certificate } from "./GoPoll.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { ArrowLeftIcon, DocIcon, FrameIcon } from "./fpIcons.tsx";
import { FlightList, type RowDo } from "./FlightList.tsx";
import { Trajectory } from "./Trajectory.tsx";

function Main({ d, it, snap, preflightOn, cap, now, pilot, onChanged, onSettings, onBack, onTakeOver }: {
  d: PlanDetail; it: FlightItem; snap: PilotSnapshot; preflightOn: boolean; cap: number; now: number; pilot: Pilot; onChanged: () => void; onSettings: () => void; onBack: () => void; onTakeOver: () => void;
}) {
  const { plan, run } = d;
  const [more, setMore] = useState(false);
  const [compare, setCompare] = useState(false);
  useEffect(() => setCompare(false), [plan.id]);
  const { head, rest } = useMemo(() => splitPlan(plan.planMd), [plan.planMd]);
  const states = stationStates(plan, run, preflightOn);
  /* Edited after Preflight means the text moved past the version the reviewer read; saving the same text, or a Preflight that read the latest, never shows it. */
  const edited = plan.reviewedVersion != null && plan.version != null && plan.version !== plan.reviewedVersion;
  const n = flightNow(it, snap, now);
  const since = plan.stateSince ?? plan.launched?.at ?? plan.updatedAt;
  const sizeLabel = plan.size;
  // An HTML mockup that pulls its own stylesheet draws blank here (no network, no script), so the card shows a picture of it when there is one; Open mockup opens the first mockup itself.
  const mockAt = Math.max(0, plan.mockups.findIndex((m) => m.kind !== "html"));
  const mock = plan.mockups[0];
  const version = plan.version ?? 1;
  /* The first text is v1; Compare is offered once there is a later one. */
  const compareBtn = version > 1 ? <button type="button" className="btn sm" aria-expanded={compare} onClick={() => setCompare((v) => !v)}>Compare with v1</button> : null;
  const subs = [plan.taskId ?? "typed", written(plan) ? "written" : "writing", plan.visual ? `${plan.mockups.length} ${plan.mockups.length === 1 ? "screen" : "screens"}` : "", run?.certificate ? `${filesWord(run.certificate.files.length + run.certificate.mockups.length + 1)} · $${run.certificate.costUsd.toFixed(2)}` : "", run?.certificate ? `${run.certificate.findings.filter((f) => f.action && f.action !== "ask").length} of ${run.certificate.findings.length}` : "", plan.state === "launched" ? "Go" : "waiting", ""];
  return (
    <section className="main" aria-label="Open plan">
      <button type="button" className="btn sm pv-back" onClick={onBack}><ArrowLeftIcon size={ICON.xs} />Flying</button>
      <div className="ttl">
        <div style={{ flex: 1 }}>
          <h4>{plan.title}</h4>
          <div className="meta">
            {sizeLabel && <span className="size">{sizeLabel}</span>}
            {[plan.taskId, lastName(plan.root), plan.decision ? `${plan.state === "no-go" ? "No-go" : "Go"} by ${plan.decision.by}` : ""].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      <div className="pv-status" data-sid={n.state.id} data-tone={n.state.tone}>
        <StateTile state={n.state} detail />
        <div className="body">
          <div className="since">since {hhmm(since)} · {lasted(since, now)}</div>
          <p className="say" title={stateSentence(n)}>{stateSentence(n)}</p>
          <div className="facts">
            <div><em>Happening</em><span title={n.bold}>{n.bold}</span></div>
            <div><em>Next</em><span title={n.next}><i data-tone={n.state.tone} />{n.next}</span></div>
            <div className={n.report ? undefined : "gap"}><em>Last report</em><span title={n.report ?? undefined}>{n.report ?? "none yet"}</span></div>
          </div>
        </div>
      </div>
      <div className="traj"><Trajectory states={states} subs={subs} flight={{ state: n.state, steps: stepsOf(plan, it.facts) }} /></div>

      <div className="card">
        <div className="ch"><span className="ci"><DocIcon /></span><h5>The flight plan</h5>{(version > 1 || edited) && <span className="chip off"><i />{[version > 1 ? `v${version}` : "", edited ? "edited after Preflight" : ""].filter(Boolean).join(" · ")}</span>}{!mock && compareBtn}</div>
        <div className="csub">What will be built, written so a reader with no context can follow it.</div>
        <div className="doc">
          {plan.planMd.trim()
            ? <Markdown text={more ? plan.planMd : head} />
            : <p>The author has not saved the plan yet. It appears here the moment it does.</p>}
        </div>
        {compare && <PlanCompare planId={plan.id} planMd={plan.planMd} n={1} onClose={() => setCompare(false)} />}
        {rest.length > 0 && !more && (
          <button type="button" className="fold" onClick={() => setMore(true)}>
            ▸ {rest.slice(0, 3).map((r) => r.title).join(", ")}{rest.length > 3 ? "…" : ""} · {rest.length} more {rest.length === 1 ? "section" : "sections"}
          </button>
        )}
      </div>

      {(plan.visual || plan.mockups.length > 0) && (
        <div className="card">
          <div className="ch"><span className="ci"><FrameIcon /></span><h5>Mockup</h5>
            {run?.certificate?.mockups.length ? <span className="chip ok"><i />read by Preflight</span> : plan.mockups.length ? null : <span className="chip warn"><i />needed before Go</span>}
          </div>
          <div className="csub">Visual plans carry their mockup; the reviewer reads it with the text.</div>
          {mock ? (
            <div className="mock">
              <div className="thumb" role="img" aria-label={`Mockup: ${mock.path.split("/").pop()}`}>
                <div className="bar"><i /><i /><i /></div>
                <MockupThumb planId={plan.id} n={mockAt + 1} kind={plan.mockups[mockAt]!.kind} name={mock.path.split("/").pop() ?? ""} />
              </div>
              <div className="mk-r">
                <div className="kv">
                  <span>File</span><span>{mock.path.split("/").slice(-2).join("/")}</span>
                  <span>Kind</span><span>{mock.kind === "html" ? "HTML page" : "image"}</span>
                  <span>Count</span><span>{plan.mockups.length} {plan.mockups.length === 1 ? "mockup" : "mockups"}{run?.certificate?.mockups[0] ? ` · ${kb(run.certificate.mockups[0].bytes)}` : ""}</span>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button type="button" className="btn sm" onClick={() => void api.previewOpen(mock.path)}>Open mockup</button>
                  {compareBtn}
                </div>
              </div>
            </div>
          ) : <div className="doc"><p>This plan is visual. The author attaches a mockup before Go.</p></div>}
        </div>
      )}

      <FindingsCard plan={plan} run={run} preflightOn={preflightOn} cap={cap} onChanged={onChanged} onSettings={onSettings} now={now} pilot={pilot} onTakeOver={onTakeOver} />
    </section>
  );
}

/** The Flying tab: one row per flight, and the open plan (its text, mockup and findings, with the card that asks) when a row was opened. */
export function PlansTab({ items, details, loading, snap, selected, open, now, preflightOn, cap, pilotFor, renderCard, onOpen, onBack, onCard, onDo, onChanged, onTakeOver, onSettings, onHistory, onCompose }: {
  items: FlightItem[]; details: PlanDetail[]; loading: boolean; snap: PilotSnapshot; selected: string | null; open: boolean; now: number; preflightOn: boolean; cap: number;
  pilotFor: (id: string) => Pilot; renderCard: (id: string) => ReactNode;
  onOpen: (id: string) => void; onBack: () => void; onCard: (id: string) => void; onDo: RowDo; onChanged: () => void; onTakeOver: (id: string) => void;
  onSettings: () => void; onHistory: () => void; onCompose: () => void;
}) {
  const sel = open ? details.find((d) => d.plan.id === selected) ?? null : null;
  const selIt = sel ? items.find((x) => x.plan.id === sel.plan.id) ?? null : null;
  if (!sel || !selIt) return <FlightList items={items} loading={loading} snap={snap} now={now} onOpen={onOpen} onCard={onCard} onDo={onDo} onHistory={onHistory} onCompose={onCompose} />;
  return (
    <div className="cols">
      <Main d={sel} it={selIt} snap={snap} preflightOn={preflightOn} cap={cap} now={now} pilot={pilotFor(sel.plan.id)} onChanged={onChanged} onSettings={onSettings} onBack={onBack} onTakeOver={() => onTakeOver(sel.plan.id)} />
      <aside className="side pv ps" aria-label="Go or No-go">
        {renderCard(sel.plan.id)}
        {builderFacts(sel.plan).length > 0 && (
          <section className="pv-facts" aria-label="Builder">
            <h5>Builder</h5>
            <dl>{builderFacts(sel.plan).map((f) => <div key={f.k}><dt>{f.k}</dt><dd data-bad={f.bad ? "" : undefined} title={f.v}>{f.v}</dd></div>)}</dl>
          </section>
        )}
        {sel.run?.certificate && <Certificate run={sel.run} cap={cap} withPlan />}
      </aside>
    </div>
  );
}
