import { useEffect, useRef, useState } from "react";
import { clickupPrefs } from "../../lib/clickupPrefs.ts";
import { clickupSteps } from "../../lib/clickupWorkflow.ts";
import { askKey, copyCount, copyPatch, copyPlan, type CopyAnswer, type CopyPlan } from "../../lib/copySteps.ts";
import { JIRA, type StepsPatch } from "../../lib/jiraWorkflow.ts";
import { moments, type Listed, type Step, type StepKind } from "../../lib/workflowMap.ts";
import { Button, INPUT, INPUT_STYLE, Segmented } from "../workspace/Chrome.tsx";
import { hint } from "../TrackerMapParts.tsx";

type Phase = { at: "reading" } | { at: "none" } | { at: "plan"; plan: CopyPlan } | { at: "done"; count: number };

const TITLES = moments(JIRA.nouns);

/**
 * ClickUp's steps, copied onto Jira's map: a status by NAME, a name the site does not have
 * asked one at a time (with its own statuses to pick from, or "skip this step"), a placement
 * Jira already uses asked replace-or-keep, and a ClickUp-only value said out loud. With
 * nothing to ask the copy lands on the press itself.
 */
export function CopyClickUpSteps({ statuses, steps, onSave, onClose }: {
  statuses: readonly Listed[];
  /** Jira's steps as they are now, to tell a placement that is already taken. */
  steps: readonly Step[];
  onSave: (patch: StepsPatch) => Promise<boolean>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ at: "reading" });
  const [answers, setAnswers] = useState<Record<string, CopyAnswer>>({});
  const [replace, setReplace] = useState<StepKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const saved = useRef(false);

  const save = async (patch: StepsPatch, count: number) => {
    setBusy(true);
    const ok = await onSave(patch);
    setBusy(false);
    if (!ok) { setNote("That did not save. Nothing was copied."); return; }
    saved.current = true;
    setPhase({ at: "done", count });
  };

  useEffect(() => {
    let live = true;
    void clickupPrefs().then((prefs) => {
      if (!live) return;
      if (!prefs) { setPhase({ at: "none" }); return; }
      const plan = copyPlan(clickupSteps(prefs), steps, statuses);
      setPhase({ at: "plan", plan });
      /* Nothing to ask: the press is the copy. */
      if (!saved.current && !plan.asks.length && !plan.dropped.length && !plan.steps.some((s) => s.clash)) {
        const patch = copyPatch(plan);
        const count = Object.keys(patch).length;
        if (count) void save(patch, count);
      }
    });
    return () => { live = false; };
    // Read once, when the panel opens: a save re-renders and must not read ClickUp again.
  }, []);

  const box = "p-4 rounded-xl flex flex-col gap-3";
  const style = { background: "var(--bg)", boxShadow: "0 0 0 1px var(--primary)" };

  if (phase.at === "reading") return <div className={box} style={style} role="status">{hint("Reading ClickUp's steps…")}</div>;
  if (phase.at === "none") {
    return (
      <div className={box} style={style} role="status">
        <b className="text-[13px]">Nothing to copy</b>
        <div className="text-[13px]">ClickUp is not connected on this machine, so it has no steps here.</div>
        <div><Button onClick={onClose}>Close</Button></div>
      </div>
    );
  }
  if (phase.at === "done") {
    return (
      <div className={box} style={style} role="status">
        <b className="text-[13px]">Copied {phase.count} {phase.count === 1 ? "step" : "steps"}</b>
        <div className="text-[13px]">They are in the map above. Jira's own steps were left as they were.</div>
        <div><Button tone="primary" onClick={onClose}>Close</Button></div>
      </div>
    );
  }

  const { plan } = phase;
  if (!plan.steps.length) {
    return (
      <div className={box} style={style} role="status">
        <b className="text-[13px]">Nothing to copy</b>
        <div className="text-[13px]">ClickUp has no steps set up here, so there is nothing to bring over.</div>
        <div><Button onClick={onClose}>Close</Button></div>
      </div>
    );
  }
  const list = Object.values(answers);
  const count = copyCount(plan, list, replace);
  const clashes = plan.steps.filter((s) => s.clash);
  const left = plan.asks.filter((a) => answers[askKey(a)] === undefined);
  const answer = (a: CopyPlan["asks"][number], v: string) =>
    setAnswers((cur) => {
      const next = { ...cur };
      if (!v) delete next[askKey(a)];
      else next[askKey(a)] = { kind: a.kind, name: a.name, to: v === "skip" ? null : v };
      return next;
    });

  return (
    <div className={box} style={style} role="region" aria-label="Copy steps from ClickUp">
      <div className="flex flex-col gap-1">
        <b className="text-[13px]">Copy steps from ClickUp</b>
        <div className="text-[13px]">Each step is copied block for block. A status is matched by name; one Jira does not have is asked below, and nothing is saved before you answer.</div>
      </div>

      {clashes.length > 0 && (
        <div className="flex flex-col gap-2">
          {clashes.map((s) => (
            <div key={s.kind} className="flex gap-2 items-center flex-wrap">
              <span className="text-[13px] flex-1 min-w-0">{TITLES[s.kind].title} already has a step here.</span>
              <Segmented label={`${TITLES[s.kind].title}: replace Jira's step?`} value={replace.includes(s.kind) ? "replace" : "keep"}
                onChange={(v) => setReplace((cur) => (v === "replace" ? [...new Set([...cur, s.kind])] : cur.filter((k) => k !== s.kind)))}
                options={[{ id: "keep", label: "Keep Jira's" }, { id: "replace", label: "Replace it" }]} />
            </div>
          ))}
        </div>
      )}

      {plan.asks.length > 0 && (
        <div className="flex flex-col gap-2">
          {plan.asks.map((a) => {
            const v = answers[askKey(a)];
            const id = `copy-${askKey(a).replace(/[^a-z0-9]+/gi, "-")}`;
            return (
              <div key={askKey(a)} className="flex gap-2 items-center flex-wrap">
                <label htmlFor={id} className="text-[13px] flex-1 min-w-0">“{a.name}” is not one of your Jira statuses.</label>
                <select id={id} className={INPUT} style={{ ...INPUT_STYLE, width: 220 }} value={v === undefined ? "" : v.to === null ? "skip" : v.to}
                  onChange={(e) => answer(a, e.target.value)}>
                  <option value="">Pick a status…</option>
                  {a.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                  <option value="skip">Skip this step</option>
                </select>
              </div>
            );
          })}
        </div>
      )}

      {plan.dropped.length > 0 && (
        <ul className="m-0 p-0 flex flex-col gap-1 text-[12px]" style={{ listStyle: "none", color: "var(--text3)" }}>
          {plan.dropped.map((d) => <li key={`${d.kind}:${d.what}`}>Not copied, {d.what}: {d.why}.</li>)}
        </ul>
      )}

      {note && <div role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div>}
      <div className="flex gap-2 items-center flex-wrap">
        <Button tone="primary" pending={busy} disabled={!count} onClick={() => void save(copyPatch(plan, list, replace), count)}>
          {count ? `Copy ${count} ${count === 1 ? "step" : "steps"}` : left.length ? "Answer the statuses above" : "Nothing to copy"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        {left.length > 0 && hint(`${left.length} ${left.length === 1 ? "status still needs" : "statuses still need"} an answer.`)}
      </div>
    </div>
  );
}
