import { useEffect, useMemo, useState } from "react";
import { Disclosure, SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { PanesIcon } from "../settingsNavIcons.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { OrchSeg } from "./OrchKit.tsx";
import { SettingRow } from "../SettingRow.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { agentProvider } from "../../../../shared/agentKinds.ts";
import type { PolicyRuleState } from "../../lib/api.ts";
import type { Policy } from "../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import { rowId } from "../../lib/settingsIndex.ts";
import type { FlowLike } from "../../lib/roleLabel.ts";
import { ALWAYS_PRESETS, BACK_GONE, BACK_LABEL, appliedLine, applyPreset, presetInForce, scopeWords, backAvailable, backOf, cardUndo, checkSetup, presetDiagram, undoPolicy, presetOffers, type Back, type PresetId, type PresetOffer, type SetupCheck } from "./orchestrationCopy.ts";

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
  /** The flow's role names, so the cards and the check say Paco where the flow says Paco. */
  flow?: FlowLike | null;
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

/** The state and the presses of the card, so the page can offer one preset (the usage one) from another card as well. */
export function useQuickSetup(p: QuickSetupProps) {
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

  const offers = useMemo(() => presetOffers(p.readiness, p.policy, p.flow), [p.readiness, p.policy, p.flow]);
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
  return { offers, locked, canGoBack, undoOnCard, back, check, setCheck, gone, result, setResult, apply, undo, showRule };
}

export type QuickSetupState = ReturnType<typeof useQuickSetup>;

const SHORT: Record<PresetId, string> = { "claude-orchestrates": "Claude + others", "all-on-claude": "All on Claude", "save-my-plan": "Save my plan" };
export const presetLabel = (id: PresetId): string => SHORT[id];
