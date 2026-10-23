import { useEffect, useMemo, useState } from "react";
import { SettingRow } from "../SettingRow.tsx";
import { SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { Button } from "../workspace/Chrome.tsx";
import type { PolicyRuleState } from "../../lib/api.ts";
import type { Policy } from "../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import { BACK_GONE, BACK_LABEL, applyPreset, backAvailable, backOf, checkSetup, undoPolicy, presetOffers, type Back, type PresetId, type SetupCheck } from "./orchestrationCopy.ts";

/**
 * Named setups, built from what this machine can run, and a dry run of the
 * setup in force.
 *
 * Applying is one click on the card; the sentence that says what it does sits
 * on the card, so there is nothing to read after pressing. It goes through the
 * page's own save, which is the policy route: only the person can write it, the
 * ceiling and the schema judge it, and a refusal is the server's sentence under
 * the card with nothing changed.
 *
 * "Check my setup" calls `checkSetup`, which is a function of what the page
 * already holds. It makes no request and writes nothing.
 *
 * The way back is kept in this browser, per scope: a convenience for this
 * window, not the policy's history. It goes with the browser's storage. It is
 * offered only while the stored policy is exactly what applying left, and it
 * removes only the rules the preset added; after any other edit the card says
 * the way back is gone.
 */
const KEY = (root: string) => `agx.orchestration.back:${root || "*"}`;

function readBack(root: string): Back | null {
  try {
    const raw = localStorage.getItem(KEY(root));
    return raw ? (JSON.parse(raw) as Back) : null;
  } catch { return null; }
}
function writeBack(root: string, b: Back | null): void {
  try {
    if (b) localStorage.setItem(KEY(root), JSON.stringify(b));
    else localStorage.removeItem(KEY(root));
  } catch { /* no storage: the way back is simply not offered */ }
}

export interface QuickSetupProps {
  policy: Policy;
  root: string;
  readiness: EngineReadiness[] | null;
  states: PolicyRuleState[];
  /** A project that uses the general setting cannot be written until it has its own. */
  inherited: boolean;
  busy: boolean;
  note: string | undefined;
  /** Answers null when it saved, or the server's sentence. */
  onSave: (next: Policy, card: string) => Promise<string | null>;
  onOpenEngines: () => void;
}

export function QuickSetup(p: QuickSetupProps) {
  const [back, setBack] = useState<Back | null>(null);
  const [check, setCheck] = useState<SetupCheck | null>(null);
  // An apply that saved, waiting for the page to hold the policy the server
  // stored: the way back compares against that, not against what was sent.
  const [pending, setPending] = useState<{ before: string; back: Back } | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => { setBack(readBack(p.root)); setCheck(null); setPending(null); setGone(false); }, [p.root]);
  useEffect(() => {
    if (!pending || JSON.stringify(p.policy) === pending.before) return;
    const b = { ...pending.back, after: JSON.stringify(p.policy) };
    writeBack(p.root, b);
    setBack(b);
    setPending(null);
  }, [pending, p.policy, p.root]);
  // Any other edit ends the way back for good, and the card says so.
  useEffect(() => {
    if (!back || pending || backAvailable(back, p.policy)) return;
    writeBack(p.root, null);
    setBack(null);
    setGone(true);
  }, [back, pending, p.policy, p.root]);

  const offers = useMemo(() => presetOffers(p.readiness, p.policy), [p.readiness, p.policy]);
  const locked = p.inherited || p.busy;
  const canGoBack = backAvailable(back, p.policy);

  const apply = async (id: PresetId, title: string) => {
    const next = applyPreset(p.policy, id, p.readiness);
    if (!next) return;
    const err = await p.onSave(next, "quick");
    if (err) return;
    writeBack(p.root, null);
    setBack(null);
    setGone(false);
    setPending({ before: JSON.stringify(p.policy), back: backOf(p.policy, next, title) });
    setCheck(null);
  };
  const undo = async () => {
    if (!canGoBack) return;
    const err = await p.onSave(undoPolicy(p.policy, back), "quick");
    if (err) return;
    writeBack(p.root, null);
    setBack(null);
    setCheck(null);
  };

  return (
    <SettingsCard title="Quick setup"
      desc="One click sets how work is handed out, from the engines this machine can run now. Each one adds a rule you can see, edit and remove below."
      actions={
        <>
          {canGoBack && <Button disabled={locked} title={`Undo "${back.title}"`} onClick={() => void undo()}>{BACK_LABEL}</Button>}
          <Button disabled={!p.readiness} onClick={() => setCheck(checkSetup(p.policy, p.states, p.readiness, p.inherited || p.root === "" ? "global" : p.root))}>Check my setup</Button>
        </>}>
      {offers.map((o) => (
        <SettingRow key={o.id} label={o.title} disabled={p.inherited}
          hint={o.blocked ? o.blocked : (
            <>{o.says.map((line) => <span key={line} className="block">{line}</span>)}<span className="block">{o.confirm}</span></>)}
          status={o.blocked && p.readiness ? <StatusBadge tone="off">Not available</StatusBadge> : undefined}
          actions={<Button tone="primary" disabled={locked || !!o.blocked} title={o.blocked ?? o.confirm} onClick={() => void apply(o.id, o.title)}>Apply</Button>}
          below={o.blocked && p.readiness ? (
            <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>
              <button type="button" className="agx-field-link" onClick={p.onOpenEngines}>See Agent engines</button>
            </p>) : undefined} />
      ))}
      {gone && !canGoBack && <p className="agx-settings-x m-0 pb-3 text-[12px]" style={{ color: "var(--text3)" }}>{BACK_GONE}</p>}
      {p.inherited && <p className="agx-settings-x m-0 pb-3 text-[12px]" style={{ color: "var(--text3)" }}>This project uses the general setting. Set it for this project first, or pick All projects.</p>}
      {check && (
        <SettingRow label="Your setup right now" hint="Nothing was started or changed. This is what the policy says when it is read against this machine now."
          below={
            <div className="grid gap-2 text-[12px]" style={{ color: "var(--text)" }}>
              <p className="m-0">{check.chair}</p>
              <ul className="m-0 pl-4 grid gap-1">{check.roles.map((r) => <li key={r.id}>{r.line}</li>)}</ul>
              {check.rules.length > 0 && (
                <ul className="m-0 pl-4 grid gap-1" aria-label="What each rule would change">
                  {check.rules.map((r) => <li key={r.id}><b>{r.name}.</b> {r.line}</li>)}
                </ul>)}
            </div>}
          actions={<Button onClick={() => setCheck(null)}>Hide</Button>} />
      )}
      {p.note && <div role="alert" className="agx-settings-x pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{p.note}</div>}
    </SettingsCard>
  );
}
