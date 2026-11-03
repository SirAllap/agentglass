/*
 * The reviewing block's three settings, drawn in the Flow editor's side panel:
 * who reviews and checks, the most rounds before it stops, and a second
 * reviewer on another model. They are PROJECT settings (`orchestration.review.*`),
 * read and written through the same settings door as the Orchestration page,
 * and each control saves at once; nothing here is copied into the flow.
 *
 * Every label uses the name the flow gives the block, so a person who renamed
 * the Inspector reads their own word. The panel is 292px of content: rows
 * stack, and nothing here is wider than that.
 *
 * Its ceiling, stated: one second reviewer, on one engine and model.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { checkSecondReviewer, isReviewWho, REVIEW_ROUNDS_MAX, REVIEW_ROUNDS_MIN, REVIEW_SETTING_IDS } from "../../../../../shared/reviewSettings.ts";
import type { EngineReadiness } from "../../../../../shared/types.ts";
import { readEngines } from "../../engines/readEngines.ts";
import { PickRow } from "../SafetyParts.tsx";
import { engineOptions } from "../orchestrationCopy.ts";
import { CHECKS, DEFAULT_CHECKS, secondReviewerDefault, type CheckId, type SecondReviewer } from "./flowCopy.ts";
import { ModelInput } from "./ModelInput.tsx";
import { EngineWhy } from "./EngineWhy.tsx";
import { FlowIcon } from "./flowIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";

/** The three labels, in the block's own name. */
export function reviewerLabels(name: string) {
  return {
    who: "Who reviews and checks",
    rounds: `Most rounds before ${name} stops`,
    second: `Second ${name} on another model`,
  };
}

/** The first engine the block is not on and that is ready, as the page's switch picks it. */
export function nextSecond(first: { engine: string } | null, readiness: readonly EngineReadiness[] | null): SecondReviewer | null {
  return secondReviewerDefault(first, engineOptions("worker", readiness));
}

export function ReviewerControls(p: {
  root: string;
  /** What the flow calls this block. */
  name: string;
  /** The engine the block runs on, so the second one starts elsewhere. */
  firstEngine: { engine: string } | null;
  /** The cap now in force (the flow shows the setting). */
  rounds: number;
  /** Saves the cap; answers whether the server kept it. */
  onRounds: (n: number) => Promise<boolean>;
}) {
  const L = reviewerLabels(p.name);
  const [checks, setChecks] = useState<CheckId>(DEFAULT_CHECKS);
  const [second, setSecond] = useState<SecondReviewer | null>(null);
  const [readiness, setReadiness] = useState<EngineReadiness[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const one = (id: string) => api.settingAt(id, p.root).catch(() => null);
    void Promise.all([one(REVIEW_SETTING_IDS.who), one(REVIEW_SETTING_IDS.second)]).then(([w, s]) => {
      if (!alive.current) return;
      setChecks(w?.ok && isReviewWho(w.value) ? w.value : DEFAULT_CHECKS);
      const parsed = s?.ok ? checkSecondReviewer(s.value) : null;
      setSecond(parsed && "value" in parsed ? parsed.value : null);
    });
    void readEngines((fresh) => api.engines(fresh), (r) => { if (alive.current) setReadiness(r.engines); }, { alive: () => alive.current }).catch(() => { /* the tiles say "checking" */ });
    return () => { alive.current = false; };
  }, [p.root]);

  /** The state moves only once the server says it kept the value; a waiting save arrives as `ok: false` with the door's sentence. */
  const save = async (id: string, value: unknown, kept: () => void) => {
    setBusy(true);
    const r = await api.settingAtSet(id, value, p.root).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) { setNote(r.error ?? "Could not save it."); return; }
    setNote("");
    kept();
  };

  const options = engineOptions("worker", readiness);
  const secondDefault = nextSecond(p.firstEngine, readiness);
  const rounds = p.rounds;
  const step = (n: number) => { setBusy(true); void p.onRounds(n).then((kept) => { if (alive.current) { setBusy(false); setNote(kept ? "" : "The cap was not saved."); } }); };

  return (
    <div className="fe-revctl" data-reviewer-controls>
      <div className="fe-field">
        <span className="fe-flabel" id="fe-rev-who">{L.who}</span>
        <div role="radiogroup" aria-labelledby="fe-rev-who" className="fe-who">
          {CHECKS.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={checks === c.id} disabled={busy} onClick={() => void save(REVIEW_SETTING_IDS.who, c.id, () => setChecks(c.id))}>
              <i aria-hidden="true" /><span><b>{c.label}</b><small>{c.hint}</small></span>
            </button>
          ))}
        </div>
      </div>
      <div className="fe-field">
        <span className="fe-flabel">{L.rounds}</span>
        <span className="fe-stepper">
          <button type="button" aria-label="Fewer rounds" disabled={busy || rounds <= REVIEW_ROUNDS_MIN} onClick={() => step(rounds - 1)}><FlowIcon name="minus" size={ICON.xs} /></button>
          <span>{rounds}</span>
          <button type="button" aria-label="More rounds" disabled={busy || rounds >= REVIEW_ROUNDS_MAX} onClick={() => step(rounds + 1)}><FlowIcon name="plus" size={ICON.xs} /></button>
          <small>saves at once</small>
        </span>
      </div>
      <div className="fe-field">
        <div className="fe-revsecond">
          <span className="fe-flabel">{L.second}</span>
          <button type="button" role="switch" aria-checked={!!second} aria-label={L.second} className="fe-switch" data-on={second ? "" : undefined}
            disabled={busy || (!second && !secondDefault)}
            title={!second && !secondDefault ? "Only one engine is ready here: a second one needs another engine." : undefined}
            onClick={() => void save(REVIEW_SETTING_IDS.second, second ? null : secondDefault, () => setSecond(second ? null : secondDefault))}>
            <span className="fe-track" />
          </button>
        </div>
        {second && (
          <>
            <PickRow label="Engine" value={second.engine} disabled={busy || !readiness}
              options={options.map((o) => ({ id: o.value, label: o.label, title: o.hint, disabled: o.disabled }))}
              onChange={(engine) => { const to = { engine, model: "" }; void save(REVIEW_SETTING_IDS.second, to, () => setSecond(to)); }} />
            <EngineWhy engine={second.engine} readiness={readiness} />
            <ModelInput choice={second} label={`Model for the second ${p.name}`} disabled={busy}
              onCommit={(c) => void save(REVIEW_SETTING_IDS.second, c, () => setSecond(c))} />
          </>
        )}
      </div>
      <small className="fe-quiet">One answer per project. They save as soon as you change them.</small>
      {note && <p className="fe-errline" role="alert">{note}</p>}
    </div>
  );
}
