/*
 * The orchestrator's sheet: everything about the chair in one place — the engine
 * and model the policy gives it, the Flight plan's pilot, the most it may grant
 * a worker, and the sentence saying what it does with code (those radios stay on
 * the reviewing block: one home).
 *
 * Each control saves at once: the chair through `/orchestration` (the page's own
 * save path), the pilot and the ceiling through the routes that own them. A
 * refusal is the server's sentence, drawn under the control that produced it.
 */
import { useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { engineOptions, pickEngine, withBaseChoice, withEnvelopes } from "../orchestrationCopy.ts";
import { PickRow, EnvelopeRows } from "../SafetyParts.tsx";
import { SettingRow } from "../../SettingRow.tsx";
import { Select } from "../../Select.tsx";
import { FlowIcon } from "./flowIcons.tsx";
import { codeWord } from "../../../lib/orchestratorCardView.ts";
import type { Envelope, Policy } from "../../../../../shared/orchestration.ts";
import type { ReviewWho } from "../../../../../shared/reviewSettings.ts";
import { DEFAULT_PILOT_SETTINGS, PILOT_KEYS, decode, encode } from "../../../lib/pilotSettings.ts";
import type { Pilot } from "../../../lib/flightPilot.ts";
import type { Flow } from "../../../../../shared/flow.ts";
import { reviewerName } from "./workerDraft.ts";
import type { Around } from "./AroundFlow.tsx";

const SELECT = "agx-select rounded-lg px-2 py-1.5 text-[12px] outline-none w-full justify-between";
const PILOT_WORD: Record<Pilot, string> = { manual: "Manual: every Go is yours", copilot: "Co-pilot: it answers, you say Go", autopilot: "Autopilot: it says Go itself" };

/** The ceiling is policy, so it goes out with the whole policy: the same call the page makes. */
export const saveCeiling = (a: Around, ceiling: Envelope): Promise<string | null> => {
  const policy = a.policy;
  if (!policy) return Promise.resolve("The policy could not be read.");
  return a.saveRule(withEnvelopes(policy, { ceiling, workerDefault: policy.workerDefault }));
};

/** The pilot is a project setting of its own; it saves at once and answers the server's sentence, or null. */
export async function savePilot(root: string, pilot: Pilot): Promise<string | null> {
  const r = await api.settingAtSet(PILOT_KEYS.pilot.id, encode("pilot", pilot), root).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
  return r.ok ? null : r.error ?? "The server did not take it.";
}

export function OrchestratorSheet(p: {
  a: Around;
  flow: Flow;
  /** The project whose chair this is; "" under All projects, where a pilot cannot be chosen. */
  root: string;
  /** `orchestration.review.who`, read by the editor: the radios live on the reviewing block. */
  reviewWho: ReviewWho | null;
  onClose: () => void;
}) {
  const policy = p.a.policy;
  const choice = policy?.base.orchestrator.value[0] ?? null;
  const [pilot, setPilot] = useState<Pilot | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const options = engineOptions("orchestrator", p.a.readiness, choice ? { engine: choice.engine, why: "The main agent's engine is set when the seat opens; another engine in the chair comes later." } : undefined);
  const models = p.root ? p.a.seat?.models ?? [] : null;

  useEffect(() => {
    let live = true;
    if (!p.root) { setPilot(null); return; }
    void api.settingAt(PILOT_KEYS.pilot.id, p.root).then((r) => {
      const v = r?.ok ? decode("pilot", r.value) : undefined;
      if (live) setPilot(v ?? DEFAULT_PILOT_SETTINGS.pilot);
    }).catch(() => { if (live) setPilot(DEFAULT_PILOT_SETTINGS.pilot); });
    return () => { live = false; };
  }, [p.root]);

  // Escape closes the sheet, and the flow editor's own handler leaves it alone while this is open.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [p]);

  const put = async (next: Policy) => {
    setBusy(true);
    const e = await p.a.saveRule(next);
    setBusy(false);
    setNote(e ?? "");
  };
  const setPilotTo = async (v: Pilot) => {
    setBusy(true);
    setPilot(v);
    const e = await savePilot(p.root, v);
    setBusy(false);
    setNote(e ?? "");
  };
  const setCeilingTo = async (ceiling: Envelope) => {
    setBusy(true);
    const e = await saveCeiling(p.a, ceiling);
    setBusy(false);
    setNote(e ?? "");
  };

  return (
    <div className="fe-dialog" onPointerDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="fe-dlg fe-wed fe-os" role="dialog" aria-modal="true" aria-labelledby="fe-os-title">
        <div className="fe-sheethead">
          <span className="fe-ico" aria-hidden="true"><FlowIcon name="spark" size={17} /></span>
          <div>
            <h2 id="fe-os-title">Orchestrator</h2>
            <p>{p.a.own ? "This project's chair · saves at once" : "The chair every project without its own uses · saves at once"}</p>
          </div>
          <span className="fe-sp" />
          <button className="fe-sq" type="button" title="Close" aria-label="Close" onClick={p.onClose}><FlowIcon name="x" size={12} /></button>
        </div>

        <div className="fe-wedbody">
          <nav className="fe-wednav" aria-label="Sections">
            <button type="button" aria-current="true">Who sits there</button>
            <button type="button" onClick={() => document.getElementById("fe-os-pilot")?.scrollIntoView({ block: "start", behavior: "smooth" })}>Flight plan</button>
            <button type="button" onClick={() => document.getElementById("fe-os-ceiling")?.scrollIntoView({ block: "start", behavior: "smooth" })}>What it may grant</button>
          </nav>

          <div className="fe-wedscroll">
            {note && <p className="fe-errline" role="alert">{note}</p>}
            {!policy ? <p className="fe-quiet">{p.a.note || "Reading the policy…"}</p> : (
              <>
                <section className="fe-wedsec">
                  <h3>Who sits there</h3>
                  <PickRow label="Engine" ctl="engine" value={choice?.engine ?? ""} disabled={busy || !p.a.readiness}
                    options={options.map((o) => ({ id: o.value, label: o.label, title: o.hint, disabled: o.disabled }))}
                    onChange={(engine) => { const c = pickEngine(options, choice, engine); if (c) void put(withBaseChoice(policy, "orchestrator", c)); }} />
                  {models ? (
                    <PickRow label="Model" ctl="model" value={choice?.model ?? ""} disabled={busy}
                      options={[{ id: "", label: "its default" }, ...models.map((m) => ({ id: m.id, label: m.label }))]}
                      onChange={(model) => { if (choice) void put(withBaseChoice(policy, "orchestrator", { engine: choice.engine, model })); }} />
                  ) : <p className="fe-wedquiet">The main agent's model is chosen per project, never for all of them. Click a project at the top right (not All projects) and the model selector appears here.</p>}
                  <p className="fe-wedquiet">The seat the orchestrator sits in follows this choice the next time it is seated.</p>
                </section>

                <section className="fe-wedsec">
                  <h3>What it does with code</h3>
                  <p className="fe-wedval">{codeWord(p.reviewWho)}</p>
                  <p className="fe-wedquiet">Set on the reviewing block ({reviewerName(p.flow)}): it is a worker's property, and it has one home.</p>
                </section>

                <section className="fe-wedsec" id="fe-os-pilot">
                  <h3>Flight plan</h3>
                  <SettingRow label="Who flies a project's plans" hint="Manual: every Go is yours. Co-pilot: it answers the findings, you say Go. Autopilot: it says Go itself."
                    control={<Select value={pilot ?? ""} disabled={busy || !p.root || !pilot} title="Pilot" className={SELECT}
                      options={pilot ? (Object.keys(PILOT_WORD) as Pilot[]).map((v) => ({ value: v, label: PILOT_WORD[v] })) : [{ value: "", label: "reading…" }]}
                      onChange={(v) => { if (v) void setPilotTo(v as Pilot); }} />} />
                  <p className="fe-wedquiet">{p.root ? "Autopilot is the person's alone: an agent cannot turn it on, from any door." : "A pilot is chosen per project. Click a project at the top right and the control appears here."}</p>
                </section>

                <section className="fe-wedsec" id="fe-os-ceiling">
                  <h3>The most it may grant a worker</h3>
                  <EnvelopeRows prefix="At most: " env={policy.ceiling} locked={busy} onChange={(ceiling) => void setCeilingTo(ceiling)} />
                  <p className="fe-wedquiet">A worker's own default has to stay inside this. Lowering it below the default is refused, and the server's sentence is what you read here.</p>
                </section>
              </>
            )}
          </div>
        </div>

        <div className="fe-sheetfoot fe-wedfoot">
          <span className="fe-badge" data-tone="off"><i />Every control saves at once</span>
          <span className="fe-sp" />
          <button className="fe-btn" type="button" onClick={p.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
