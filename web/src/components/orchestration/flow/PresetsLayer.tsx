/*
 * Presets on the canvas: the right drawer the mockup draws over the flow, and the
 * toast that keeps Undo for ten seconds. The semantics are the page card's own:
 * this mounts `useQuickSetup` (offers, apply, the way back kept per scope, check)
 * and adds nothing to it. Hovering or focusing a card only sets `preview`, which
 * the editor draws on the blocks (old → new, nothing written); "Use this preset"
 * adds the one rule the card adds.
 *
 * Its ceiling, stated: the way back is the card's (latest apply only, offered
 * while nothing else changed the policy).
 */
import { useEffect, useRef, useState } from "react";
import type { Flow } from "../../../../../shared/flow.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { checkSetup, BACK_LABEL, type PresetId } from "../orchestrationCopy.ts";
import { useQuickSetup, presetLabel } from "../QuickSetup.tsx";
import { FlowIcon } from "./flowIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { modelId } from "./flowScreenCopy.ts";
import type { Around } from "./AroundFlow.tsx";

export const UNDO_MS = 10_000;

/** The mockup's engine letter for a preset's row, as the cards on the canvas use it. */
const letter = (id: string): string => id === "claude" ? "C" : id === "opencode" ? "O" : id === "codex" ? "X" : (id[0] ?? "?").toUpperCase();

/** The flow's own name for a policy role, so a drawer row and a block never disagree. */
function flowRoleName(flow: Flow | null, role: string): string {
  return flow?.roster.find((r) => r.policyRole === role)?.name ?? role;
}
function flowRoleHue(flow: Flow | null, role: string): string {
  const r = flow?.roster.find((x) => x.policyRole === role);
  return r ? `var(--${r.hue})` : "var(--text4)";
}

export function PresetsLayer(p: {
  a: Around; flow: Flow | null; open: boolean; anchor: HTMLElement | null;
  preview: PresetId | null; onPreview: (id: PresetId | null) => void;
  checked: boolean; onChecked: (on: boolean) => void; onClose: () => void;
}) {
  const { a } = p;
  const policy = a.policy!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuickSetup({
    flow: p.flow, policy, root: a.own ? a.root : "", readiness: a.readiness, states: a.states, inherited: false, busy, note: undefined,
    onSave: async (next) => { setBusy(true); const e = await a.saveRule(next); setBusy(false); setError(e); return e; },
    onOpenEngines: () => openSettings("engines"),
  });
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!q.result?.changed) { setToast(null); return; }
    setToast(q.result.ruleName);
    // One expiry, not a poll: the signal fires once at ten seconds, or is dropped when the toast goes first.
    const expiry = new AbortController();
    AbortSignal.any([AbortSignal.timeout(UNDO_MS), expiry.signal]).addEventListener("abort", () => { if (!expiry.signal.aborted) { setToast(null); q.setResult(null); } }, { once: true });
    return () => expiry.abort();
  }, [q.result]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawer = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!p.open) return;
    drawer.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); p.onPreview(null); p.onClose(); p.anchor?.focus(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [p.open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!p.open) setError(null); }, [p.open]);

  const scopeKey = a.own && a.root ? a.root : "global";
  const lines = p.checked && q.check ? q.check : null;

  return (
    <>
      {p.open && (
        <div className="fe-drawer-scrim" data-presets-scrim onClick={() => { p.onPreview(null); p.onClose(); p.anchor?.focus(); }} />
      )}
      {p.open && (
        <aside ref={drawer} id="fe-presets" className="fe-drawer" role="region" aria-label="Start from a preset" data-presets-drawer>
          <header className="fe-drawerh">
            <b>Start from a preset</b>
            <span className="fe-wedinfo" tabIndex={0} data-tip="Nothing running is moved. Undo puts it back. Each card adds the one rule the page's own preset adds."><FlowIcon name="info" size={ICON.xs} /></span>
            <span className="fe-sp" />
            <button type="button" className="fe-sq" aria-label="Close the presets" data-tip="Close" onClick={() => { p.onPreview(null); p.onClose(); p.anchor?.focus(); }}><FlowIcon name="x" size={ICON.xs} /></button>
          </header>
          <div className="fe-drawerb">
            {q.offers.map((o) => (
              <div key={o.id} className="fe-lv" data-active={o.active ? "" : undefined} data-preset={o.id} title={o.blocked ?? undefined}
                onMouseEnter={() => p.onPreview(o.id)} onMouseLeave={() => p.onPreview(null)} onFocus={() => p.onPreview(o.id)} onBlur={() => p.onPreview(null)}>
                <h4>{o.title}{o.active && <span className="fe-chip fe-chip-acc">Now</span>}<span className="fe-chip">Shipped</span></h4>
                <span className="fe-lvsub">{o.blocked ?? o.says[0]}</span>
                {o.workers && (
                  <div className="fe-pset">
                    {Object.entries(o.workers).slice(0, 4).map(([role, chain]) => chain.length > 0 && (
                      <div key={role}>
                        <span className="fe-dot" style={{ background: flowRoleHue(p.flow, role) }} aria-hidden="true" />
                        <b>{flowRoleName(p.flow, role)}</b>
                        <span className="fe-wk-av" data-engine={chain[0]!.engine} aria-hidden="true">{letter(chain[0]!.engine)}</span>
                        <code>{modelId(chain[0]!.model)}</code>
                      </div>
                    ))}
                  </div>
                )}
                <details className="fe-lvdet">
                  <summary>See details</summary>
                  <ul>{o.says.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  <p>{o.confirm}</p>
                </details>
                <div className="fe-lvacts">
                  <button type="button" className="fe-btn fe-btn-primary" data-size="sm" data-use={o.id} disabled={!!o.blocked || o.active || busy}
                    onClick={() => { void q.apply(o.id, o.title, o.ruleName ?? o.title).then(() => { p.onPreview(null); p.onClose(); }); }}>
                    {o.active ? "Already applied" : "Use this preset"}
                  </button>
                </div>
              </div>
            ))}
            {lines && (
              <div className="fe-precheck" role="status" data-check>
                <b>Your setup right now</b>
                <span>{lines.chair}</span>
                <small>Blocks that cannot start here are marked on the canvas.</small>
              </div>
            )}
            {error && <p className="fe-errline" role="alert">{error}</p>}
          </div>
          <footer className="fe-drawerf">
            <button type="button" className="fe-btn" data-size="sm" disabled={!a.readiness} data-check-btn
              onClick={() => { q.setCheck(checkSetup(policy, a.states, a.readiness, scopeKey, p.flow)); p.onChecked(true); }}>Check my setup</button>
            <span className="fe-sp" />
            <small className="fe-quiet">{a.own ? "Set for this project" : "Set for all projects"}</small>
          </footer>
        </aside>
      )}
      {toast && (
        <div className="fe-toast" role="status" data-toast>
          <span>Added “{toast}”</span>
          <button type="button" className="fe-btn" data-size="sm" disabled={!q.canGoBack || busy} onClick={() => void q.undo().then(() => setToast(null))}>{BACK_LABEL}</button>
        </div>
      )}
    </>
  );
}

export { presetLabel };
