import { useEffect, useMemo, useState } from "react";
import { StatusBadge } from "../SettingsKit.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { Card, Sec } from "./OrchKit.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { PresetDiagram } from "./PresetDiagram.tsx";
import type { PolicyRuleState } from "../../lib/api.ts";
import type { Policy } from "../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import { rowId } from "../../lib/settingsIndex.ts";
import { BACK_GONE, BACK_LABEL, appliedLine, applyPreset, presetInForce, scopeWords, backAvailable, backOf, cardUndo, checkSetup, presetDiagram, undoPolicy, presetOffers, type Back, type PresetId, type SetupCheck } from "./orchestrationCopy.ts";

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
 * A press says what it did under the card: the rule added, with a link to it
 * in the list below; a preset already in force is shown as active, and
 * pressing it again saves nothing, so the way back the first press left stays.
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
  const [result, setResult] = useState<{ ruleName: string; changed: boolean } | null>(null);
  useEffect(() => { setBack(readBack(p.root)); setCheck(null); setPending(null); setGone(false); setResult(null); }, [p.root]);
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
    setResult(null);
  }, [back, pending, p.policy, p.root]);

  const offers = useMemo(() => presetOffers(p.readiness, p.policy), [p.readiness, p.policy]);
  const locked = p.inherited || p.busy;
  const canGoBack = backAvailable(back, p.policy);

  const apply = async (id: PresetId, title: string, ruleName: string) => {
    const next = applyPreset(p.policy, id, p.readiness);
    if (!next) return;
    if (presetInForce(p.policy, id, p.readiness)) { setResult({ ruleName, changed: false }); return; }
    const err = await p.onSave(next, "quick");
    if (err) return;
    writeBack(p.root, null);
    setBack(null);
    setGone(false);
    setPending({ before: JSON.stringify(p.policy), back: backOf(p.policy, next, title) });
    setCheck(null);
    setResult({ ruleName, changed: true });
  };
  const showRule = (name: string) =>
    document.querySelector(`[data-row="${rowId(name)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  const undo = async () => {
    if (!canGoBack) return;
    const err = await p.onSave(undoPolicy(p.policy, back), "quick");
    if (err) return;
    writeBack(p.root, null);
    setBack(null);
    setCheck(null);
    setResult(null);
  };

  const undoOnCard = offers.some((o) => cardUndo(back, p.policy, o.title));
  return (
    <div data-orch-presets>
      <Sec n={1} title="Start from a ready-made setup" sub="Each card shows before and after. Nothing running is moved, and you can undo it."
        right={
          <>
            {canGoBack && !undoOnCard && <Button disabled={locked} title={`Undo "${back?.title}"`} onClick={() => void undo()}>{BACK_LABEL}</Button>}
            <Button disabled={!p.readiness} onClick={() => setCheck(checkSetup(p.policy, p.states, p.readiness, p.inherited || p.root === "" ? "global" : p.root))}>Check my setup</Button>
          </>} />
      <div className="agx-presets">
        {offers.map((o) => (
          <article key={o.id} data-row={rowId(o.title)} className="rounded-xl p-4 grid content-start gap-3 min-w-0"
            style={{ background: "var(--bg)", border: o.active ? "1px solid var(--success)" : "1px solid var(--border)", boxShadow: o.active ? "0 0 0 1px var(--success)" : undefined, opacity: p.inherited ? 0.6 : 1 }}>
            <div className="grid gap-1">
              <h3 className="m-0 text-[13px] font-semibold leading-snug" style={{ color: "var(--text)" }}>{o.title}</h3>
              <div className="text-[11px]" style={{ color: "var(--text3)" }}>
                {o.blocked ? o.blocked : o.says.map((line) => <span key={line} className="block">{line}</span>)}
              </div>
            </div>
            <PresetDiagram rows={presetDiagram(p.policy, o.workers)} />
            <div className="flex flex-wrap items-center gap-2 mt-auto">
              {o.active ? (
                <>
                  <StatusBadge tone="ok">{`Applied for ${scopeWords(p.root)}`}</StatusBadge>
                  {cardUndo(back, p.policy, o.title) && <Button disabled={locked} title={`Undo "${back?.title}"`} onClick={() => void undo()}>{BACK_LABEL}</Button>}
                </>
              ) : (
                <>
                  <Button tone="primary" disabled={locked || !!o.blocked} title={o.blocked ?? o.confirm} onClick={() => void apply(o.id, o.title, o.ruleName ?? o.title)}>Use this setup</Button>
                  {o.blocked && p.readiness && <button type="button" className="agx-field-link" onClick={p.onOpenEngines}>See Agent engines</button>}
                </>
              )}
              <span className="text-[11px]" style={{ color: "var(--text3)" }}>{o.confirm}</span>
            </div>
          </article>
        ))}
      </div>
      {result && (
        <p role="status" className="m-0 mt-3 text-[12px] flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: "var(--text)" }}>
          <span>{appliedLine(result.ruleName, result.changed, p.root)}</span>
          {result.changed && canGoBack && <button type="button" className="agx-field-link" disabled={locked} onClick={() => void undo()}>{BACK_LABEL}</button>}
          <button type="button" className="agx-field-link" onClick={() => showRule(result.ruleName)}>See it in Conditions below</button>
          <Button label="Dismiss" square size="compact" onClick={() => setResult(null)}><CloseIcon size={ICON.sm} /></Button>
        </p>)}
      {gone && !canGoBack && <p className="m-0 mt-3 text-[12px]" style={{ color: "var(--text3)" }}>{BACK_GONE}</p>}
      {p.inherited && <p className="m-0 mt-3 text-[12px]" style={{ color: "var(--text3)" }}>This project uses the general setting. Set it for this project first, or pick All projects.</p>}
      {check && (
        <Card style={{ marginTop: 12 }}>
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-2 text-[12px] min-w-0" style={{ color: "var(--text)" }}>
              <b className="text-[13px]">Your setup right now</b>
              <span style={{ color: "var(--text3)" }}>Nothing was started or changed. This is what the policy says when it is read against this machine now.</span>
              <p className="m-0">{check.chair}</p>
              <ul className="m-0 pl-4 grid gap-1">{check.roles.map((r) => <li key={r.id}>{r.line}</li>)}</ul>
              {check.rules.length > 0 && (
                <ul className="m-0 pl-4 grid gap-1" aria-label="What each rule would change">
                  {check.rules.map((r) => <li key={r.id}><b>{r.name}.</b> {r.line}</li>)}
                </ul>)}
            </div>
            <Button onClick={() => setCheck(null)}>Hide</Button>
          </div>
        </Card>
      )}
      {p.note && <div role="alert" className="pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{p.note}</div>}
    </div>
  );
}
