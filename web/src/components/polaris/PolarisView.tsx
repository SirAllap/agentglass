/*
 * The Polaris view, on its own page in Settings > Agents: one pull request, four
 * stages, one rail of limits, and every door under them.
 *
 * The drawing sits at the top with the doors under it, in six tabs. Everything is
 * a draft until Save changes; Discard puts the stored layer back. The old
 * standalone Polaris card is replaced by this view.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { Switch } from "../SettingRow.tsx";
import { Button, Segmented } from "../workspace/Chrome.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { ChartIcon, EyeIcon, LockIcon, MergeIcon, SparkleIcon } from "../../lib/glyphIcons.tsx";
import { Ph } from "../agents/phosphor.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ContextMenu, MenuRow } from "../ContextMenu.tsx";
import { BenchJobLine, useBenchJob } from "../BenchJobLine.tsx";
import { askBuilderOnBench } from "../../lib/lanternAsk.ts";
import { JOB } from "../../lib/benchJobs.ts";
import { api } from "../../lib/api.ts";
import {
  ALSO_NEVER, DOOR_IDS, DOOR_MODES, GUARDRAILS, PRESETS,
  type DoorId, type DoorValue, type PresetId, type SettingsAnswer,
} from "../../../../shared/polaris.ts";
import { DOOR_COPY, GROUPS } from "../../lib/polarisCopy.ts";
import {
  LIMITS, assistState, assistPrompt, doorActive, limitStep, markOf, onNewSettings, railWords, rowSource, scopeOf, showsParams, twoWay,
  type AssistState,
} from "../../lib/polarisView.ts";
import {
  consentSentence, draftedDoors, draftState, patchDoor, pickPreset, rebaseDraft, safestPosition, saveCommit, savePlan, toggleEnabled, useGlobalDoors,
  type DraftState,
} from "../../lib/polarisDraft.ts";
import { DoorParams } from "./DoorParams.tsx";
import { usePolarisSettings } from "./usePolaris.ts";
import { TAB_KEYS, tabAt } from "../../lib/polarisKeys.ts";
import "./polarisView.css";

const TABS = [
  { id: "Watching", glyph: <EyeIcon size={ICON.sm} />, sub: "Which pull requests Polaris looks at, and how often. It only reads here.", foot: "Watching never replies, pushes or merges." },
  { id: "Signals", glyph: <ChartIcon size={ICON.sm} />, sub: "What wakes Polaris, and what it only notes. A signal starts one turn, never a loop of turns.", foot: "Signals arrive only for pull requests already in Watching." },
  { id: "Landing", glyph: <MergeIcon size={ICON.sm} />, sub: "What may leave the machine. In Guided every one of these asks you before it happens.", foot: "Nothing is sent as you. The wording is always shown first." },
  { id: "Automatic", glyph: <SparkleIcon size={ICON.sm} />, sub: "What Polaris may do without asking. Each door is separate, and each one writes what it did.", foot: "A fix that grows past the task stops and asks you." },
  { id: "Limits", glyph: <Ph name="hourglass-medium" size={ICON.sm} />, sub: "The rail under every stage. A limit is a stop, not a suggestion.", foot: "When a limit is reached, Polaris keeps the branch and asks you." },
  { id: "Guardrails", glyph: <LockIcon size={ICON.sm} />, sub: "Not doors. No preset and no project can switch these off.", foot: "Shown in every preset, even when Polaris is off." },
] as const;
type TabId = (typeof TABS)[number]["id"];

const PRESET_COPY: Record<PresetId, { said: string; foot: string }> = {
  watchOnly: { said: "It looks and reports. Every pull request waits for you.", foot: "Watching · Signals" },
  guided: { said: "It reads a review, fixes what is small, and asks before it lands anything.", foot: "Watching · Signals · Landing" },
  fullAutopilot: { said: "It takes a pull request to a merge when the checks are green.", foot: "All six blocks" },
};
const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** The one word each stage card shows under its name, as the mockup's "replies, reviews, checks". */
const SHORT: Record<DoorId, string> = {
  follow: "replies", dock: "drafts", cards: "cards", signals: "reviews", diagnose: "red checks",
  cleared: "checks", labels: "labels", approvals: "approvals", redsNamed: "red names",
  relaunch: "re-runs", rerunButton: "re-run button", beacon: "messages", match: "match",
  course: "courses", cleanup: "cleanup", startSession: "sessions", lookAgain: "passes",
};

const active = doorActive;
const groupOf = (tab: TabId) => GROUPS.find((g) => g.id === tab);
const STALE = "The stored setting changed while you were editing. Your draft is kept; Discard shows the stored one.";

/** Assisted setup: one press, one agent session, and every wider or live position comes back as an approval request the person answers. */
function AssistedSetup({ root }: { root: string }) {
  const [state, setState] = useState<AssistState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const open = useBenchJob(root, JOB.polarisSetup, "polaris setup");
  useEffect(() => {
    let live = true;
    void api.workerRoles().then((r) => { if (live) setState(assistState(r)); }).catch(() => { if (live) setState({ ok: false, why: "Could not read which engine is set." }); });
    return () => { live = false; };
  }, []);
  useEffect(() => { setNote(""); }, [root]);
  const go = async () => {
    if (!root || busy) return;
    setBusy(true); setNote("");
    const r = await askBuilderOnBench(root, assistPrompt(root), "polaris setup", JOB.polarisSetup, "polaris setup");
    setBusy(false);
    if (!r.ok) setNote(r.error ?? "Could not open a terminal.");
  };
  const ready = state?.ok === true;
  return (
    <span className="agx-pol-assist">
      {state && !state.ok && <Button size="compact" title={state.why} onClick={() => setNote(state.why)}>Why not?</Button>}
      <Button size="compact" tone="primary" pending={busy} disabled={!root || !ready || busy}
        data-tip={!root ? "Pick a project first: the session opens in it." : "One message of questions. Anything it would put live waits as an approval request."}
        onClick={() => void go()}>{open ? "Open · Show it" : "Assisted setup"}</Button>
      {(open || note) && (
        <span className="agx-pol-assist-line">
          <BenchJobLine root={root} job={JOB.polarisSetup} claim="polaris setup" what="Assisted setup" />
          {note && <span role="alert">{note}</span>}
        </span>
      )}
    </span>
  );
}

/** One door: its name, one line, where its saved value comes from, its positions, the settings they use, and the example behind the info button. */
function DoorLine({ door, value, changed, source, disabled, onMode, onInfo }: {
  door: DoorId; value: DoorValue; changed: boolean; source: string | null; disabled: boolean; onMode: (mode: string) => void; onInfo: () => void;
}) {
  const copy = DOOR_COPY[door];
  const mark = markOf(door, value);
  return (
    <div className="agx-pol-row" data-door={door} data-changed={changed ? "" : undefined}>
      <span className="agx-pol-dot" data-on={active(door, value) ? "" : undefined} aria-hidden />
      <div className="agx-pol-row-text">
        <div className="agx-pol-row-name">
          {copy.name}
          {source && <span className="agx-pol-source" data-layer={source === "Not set" ? "default" : "global"}>{source}</span>}
          {mark && <span className="agx-pol-mark-word" data-live={mark === "Live" ? "" : undefined}>{mark}</span>}
          {changed && <span className="agx-pol-changed">changed</span>}
        </div>
        <div className="agx-pol-row-what">{copy.what}</div>
      </div>
      {twoWay(door) ? (
        <button type="button" role="switch" aria-checked={value.mode !== "off"} aria-label={`${copy.name}: off or on`}
          className="agx-switch-hit" disabled={disabled} onClick={() => onMode(value.mode === "off" ? DOOR_MODES[door][1]! : "off")}>
          <Switch on={value.mode !== "off"} />
        </button>
      ) : (
        <Segmented track compact label={copy.name} value={value.mode} disabled={disabled}
          options={DOOR_MODES[door].map((m) => ({ id: m, label: copy.modes[m] ?? m }))} onChange={onMode} />
      )}
      <Button square size="compact" label={`About ${copy.name}`} title={`Example, and what stays yours: ${copy.name}`} onClick={onInfo}>
        <Ph name="info" size={ICON.sm} />
      </Button>
    </div>
  );
}

/** The numbers that cap every stage, as a row of steppers and the door each one belongs to. */
function LimitLine({ door, param, name, hint, value, on, disabled, onChange }: {
  door: DoorId; param: "size" | "cap" | "tries" | "hours"; name: string; hint: string; value: number; on: boolean; disabled: boolean; onChange: (n: number) => void;
}) {
  const step = (dir: -1 | 1) => onChange(limitStep(param, value, dir));
  const low = limitStep(param, value, -1) === value;
  const high = limitStep(param, value, 1) === value;
  return (
    <div className="agx-pol-row agx-pol-limit-row" data-limit={door} data-param={param} data-off={on ? undefined : ""}>
      <span className="agx-pol-dot" data-on={on ? "" : undefined} aria-hidden />
      <div className="agx-pol-row-text">
        <div className="agx-pol-row-name">{name}{!on && <span className="agx-pol-off-chip">door is off</span>}</div>
        <div className="agx-pol-row-what">{hint} Belongs to “{DOOR_COPY[door].name}”.</div>
      </div>
      <div className="agx-pol-stepper">
        <Button label={`Less: ${name}`} square size="compact" disabled={disabled || low} onClick={() => step(-1)}>−</Button>
        <span className="tabular-nums">{param === "hours" ? `${value} h` : value}</span>
        <Button label={`More: ${name}`} square size="compact" disabled={disabled || high} onClick={() => step(1)}>+</Button>
      </div>
    </div>
  );
}

type MenuState = { x: number; y: number; tab: TabId } | null;

export function PolarisView({ root }: { root: string }) {
  const scope = scopeOf(root);
  const { answer, error, busy, save, reload } = usePolarisSettings(root);
  const [state, setState] = useState<DraftState | null>(null);
  const [tab, setTab] = useState<TabId>("Watching");
  const [info, setInfo] = useState<DoorId | null>(null);
  const [note, setNote] = useState("");
  const [stale, setStale] = useState(false);
  const [menu, setMenu] = useState<MenuState>(null);
  /** The doors Save is waiting for the person's word on: a live position that was not one before. */
  const [confirm, setConfirm] = useState<DoorId[] | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const presetRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // The question takes the focus and gives it back to Save when it closes, so a keyboard user is not left behind it.
  const consentRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (confirm) { asked.current = true; consentRef.current?.focus(); }
    else if (asked.current) { asked.current = false; saveRef.current?.focus(); }
  }, [confirm]);
  // One plan decides what Save writes, what the rows show, and whether a live door needs consent.
  const plan = state ? savePlan(state, scope) : null;

  const rebase = (next: SettingsAnswer) => {
    setState(draftState(next));
    setConfirm(null);
    setStale(false);
  };

  useEffect(() => {
    if (onNewSettings({ hasBase: state !== null, dirty: plan?.dirty ?? false }, answer) === "keep") {
      // The draft stays, measured on the answer the save will write into; a confirmation computed
      // from the answer that just went away is withdrawn and asked again.
      setState((s) => (s && answer ? rebaseDraft(s, answer, scope) : s));
      setConfirm(null);
      setStale(true);
      return;
    }
    if (!answer) { setState(null); return; }
    rebase(answer);
    setNote("");
    setInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the draft is compared with the render that saw the new answer
  }, [answer]);

  useEffect(() => { setState((s) => (s ? { ...s, resets: new Set() } : s)); setConfirm(null); setMenu(null); setInfo(null); }, [root]);
  // The example belongs to its block: opening another block closes it.
  useEffect(() => { setInfo(null); }, [tab]);

  // The drawing's own keys: Alt+1..6 jump between blocks, and Esc closes the example or the question.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirm) { setConfirm(null); return; }
      if (e.key === "Escape" && info) { setInfo(null); return; }
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      const at = tabAt(e);
      if (at !== null) { e.preventDefault(); setTab(TABS[at]!.id); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [info, confirm]);

  if (!answer || !state || !plan) {
    return (
      <div className="agx-polaris" aria-busy="true" aria-label="Loading Polaris">
        {error
          ? <div role="alert" className="agx-pol-error">{error} <Button size="compact" onClick={reload}>Retry</Button></div>
          : <div className="agx-skel rounded-lg" style={{ height: 220 }} />}
      </div>
    );
  }

  const { base, draft } = state;
  // The rows show the position each door would have once saved: a reset shows what it inherits, which can be live.
  const doors = plan.effective.doors;
  const setValue = (door: DoorId) => (patch: Record<string, unknown>) => {
    setConfirm(null);
    setState((s) => s && patchDoor(s, scope, door, patch));
  };
  const choosePreset = (id: PresetId) => {
    setConfirm(null);
    setState((s) => s && pickPreset(s, scope, id));
  };
  const takeSafestPosition = (t: TabId) => {
    setConfirm(null);
    setState((s) => s && safestPosition(s, scope, groupOf(t)?.doors ?? []));
  };
  const useGlobal = (t: TabId) => {
    setConfirm(null);
    setState((s) => s && useGlobalDoors(s, scope, groupOf(t)?.doors ?? []));
  };

  /** One Save: the consent it asked for and the layer it writes come from this one plan. */
  const commit = async (allowed: readonly DoorId[]) => {
    setNote("");
    const { plan: p, layer } = saveCommit(state, answer, scope);
    // The base moved under the confirmation between the question and this click: ask again.
    if (p.consent.some((d) => !allowed.includes(d))) { setConfirm(p.consent); return; }
    const wasEnabled = state.base.enabled;
    let cur = answer;
    if (p.chosen || p.resets.size > 0 || Object.keys(p.edits).length > 0) {
      const r = await save({ settings: layer });
      if (r.error) { setNote(r.error); return; }
      if (r.answer) cur = r.answer;
    }
    if (state.draft.enabled !== wasEnabled) {
      const r = await save({ enabled: state.draft.enabled });
      if (r.error) { setNote(r.error); return; }
      if (r.answer) cur = r.answer;
    }
    rebase(cur);
  };

  /** Save is the consent for every door the rows already show live; one that was not live before asks here first. */
  const askSave = () => {
    const { plan: p } = saveCommit(state, answer, scope);
    if (!p.dirty) return;
    if (p.consent.length > 0) { setConfirm(p.consent); return; }
    void commit([]);
  };

  const discard = () => {
    setState(draftState(answer));
    setConfirm(null);
    setNote("");
    setStale(false);
    setInfo(null);
  };

  const activeTab = TABS.find((t) => t.id === tab)!;
  const group = groupOf(tab);
  const layerDoors = group?.doors ?? [];
  // The button that takes a block back counts what this draft would drop, not only what the layer stores:
  // a pressed preset fills the draft while the stored layer still owns nothing.
  const ownCountOf = (t: TabId) => draftedDoors(state, scope, groupOf(t)?.doors ?? []).length;
  const own = ownCountOf(tab);
  const stageCount = (id: TabId) => {
    const list = groupOf(id)?.doors ?? [];
    return `${list.filter((d) => active(d, doors[d])).length} of ${list.length} on`;
  };
  // The one preset the arrow keys start from: the chosen one, or the first while the setting reads Custom.
  const presetFocus = PRESET_IDS.includes(draft.preset as PresetId) ? (draft.preset as PresetId) : PRESET_IDS[0]!;
  const openMenu = (t: TabId, x: number, y: number) => setMenu({ tab: t, x, y });
  const liveNames = plan.live.map((d) => DOOR_COPY[d].name).join(", ");

  return (
    <section className="agx-polaris" aria-label="Polaris">
      <div className="agx-pol-pinned">
        <div className="agx-pol-head">
          <span className="agx-pol-mark" aria-hidden><Ph name="compass" size={ICON.md} /></span>
          <div className="agx-pol-head-copy">
            <h2 className="agx-pol-title">Polaris</h2>
            <p className="agx-pol-lede">One pull request, four stages, one rail of limits. Every door below is shown here.</p>
          </div>
          <div className="agx-pol-head-actions">
            <AssistedSetup root={root} />
            <button type="button" role="switch" aria-checked={draft.enabled} aria-label="Polaris" disabled={busy}
              className="agx-switch-hit agx-pol-power" onClick={() => setState((s) => s && toggleEnabled(s))}>
              <Switch on={draft.enabled} /><span>{draft.enabled ? "On" : "Off"}</span>
            </button>
          </div>
        </div>

        <div className="agx-pol-presets">
          <span className="agx-pol-label">Preset</span>
          <span className="agx-pol-chip">
            {draft.preset === "custom" || draft.preset === "none" ? "Custom" : PRESETS[draft.preset as PresetId].label}
            {plan.dirty ? " · not saved" : base.preset !== "none" && draft.preset === base.preset ? " · in force" : ""}
          </span>
          <span className="agx-pol-counts">{DOOR_IDS.length} doors · {PRESET_IDS.length} presets</span>
        </div>
        <div className="agx-pol-preset-row" role="radiogroup" aria-label="Preset"
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
            e.preventDefault();
            const at = PRESET_IDS.indexOf(presetFocus);
            const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
            const next = e.key === "Home" ? 0 : e.key === "End" ? PRESET_IDS.length - 1 : (at + (fwd ? 1 : -1) + PRESET_IDS.length) % PRESET_IDS.length;
            const id = PRESET_IDS[next]!;
            choosePreset(id);
            presetRefs.current[id]?.focus();
          }}>
          {PRESET_IDS.map((id) => (
            <button key={id} ref={(el) => { presetRefs.current[id] = el; }} type="button" role="radio" aria-checked={draft.preset === id} disabled={busy}
              tabIndex={presetFocus === id ? 0 : -1} className="agx-pol-preset"
              data-chosen={draft.preset === id ? "" : undefined} onClick={() => choosePreset(id)}>
              <span className="agx-pol-radio" aria-hidden />
              <span className="agx-pol-preset-name">{PRESETS[id].label}{base.preset === id && <span className="agx-pol-chip">In force</span>}</span>
              <span className="agx-pol-preset-said">{PRESET_COPY[id].said}</span>
              <span className="agx-pol-preset-foot">{PRESET_COPY[id].foot}</span>
            </button>
          ))}
        </div>
        {draft.preset === "custom" && (
          <div className="agx-pol-custom">
            <Ph name="pencil-simple" size={ICON.xs} />
            <span>Custom · set door by door. {base.preset === "none" || base.preset === "custom" ? "Your changes are the only ones." : `${PRESETS[base.preset as PresetId].label} still sets the rest.`}</span>
            {base.preset !== "none" && base.preset !== "custom" && (
              <Button size="compact" tone="quiet" onClick={() => choosePreset(base.preset as PresetId)}>Back to {PRESETS[base.preset as PresetId].label}</Button>
            )}
          </div>
        )}

        <div className="agx-pol-rail" aria-label="Four stages">
          {TABS.slice(0, 4).map((t, i) => (
            <div className="agx-pol-rail-cell" key={t.id}>
              {i > 0 && <span className="agx-pol-arrow" aria-hidden><Ph name="arrow-right" size={ICON.xs} /></span>}
              <button type="button" className="agx-pol-stage" data-current={tab === t.id ? "" : undefined}
                aria-pressed={tab === t.id} title={`${t.id}: open its doors`}
                onContextMenu={(e) => { e.preventDefault(); openMenu(t.id, e.clientX, e.clientY); }}
                onKeyDown={(e) => {
                  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu(t.id, r.left + 18, r.bottom - 6);
                  }
                }}
                onClick={() => setTab(t.id)}>
                <span className="agx-pol-stage-head">{t.glyph}<b>{t.id}</b><span className="agx-pol-stage-state">{stageCount(t.id)}</span></span>
                <span className="agx-pol-stage-sub">{groupOf(t.id)?.doors.map((d) => SHORT[d]).join(", ")}</span>
              </button>
            </div>
          ))}
        </div>

        <div className="agx-pol-limits" aria-label="Limits that apply to every stage">
          <span className="agx-pol-label"><Ph name="hourglass-medium" size={ICON.xs} />Limits</span>
          <span className="agx-pol-limit-values">
            {LIMITS.map((l, i) => (
              <span key={l.door}>{i > 0 && <span className="agx-pol-sep"> · </span>}<b>{railWords(l, Number(doors[l.door][l.param]))}</b></span>
            ))}
          </span>
          <span className="agx-pol-applies">applies to every stage</span>
        </div>

        <div className="agx-pol-guards" aria-label="Guardrails">
          <span className="agx-pol-label"><LockIcon size={ICON.xs} />Guardrails</span>
          <span className="agx-pol-guard-list">{GUARDRAILS.slice(0, 3).map((g) => <span key={g.title}><Ph name="check" size={ICON.xs} />{g.title}</span>)}</span>
          <span className="agx-pol-locked">locked in every preset</span>
        </div>

        {!draft.enabled && <div className="agx-pol-off" role="status">Polaris is off. Nothing in these doors runs until you turn it on.</div>}

        {/* The doors that act without asking, named where Save is, not under 17 rows: the person reads it before they press. */}
        {plan.dirty && plan.live.length > 0 && (
          <div className="agx-pol-live" role="status">
            {liveNames} would act without asking once this draft is saved and Polaris is on. Save changes is your consent.
          </div>
        )}

        {/* The tabs and Save stay in the pinned chrome: with the drawing on screen, the block being edited is tall enough to scroll both away. */}
        <div className="agx-pol-tabbar">
          <div className="agx-pol-tabs" role="tablist" aria-label="Polaris doors"
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
              e.preventDefault();
              const at = TABS.findIndex((t) => t.id === tab);
              const next = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
              const id = TABS[next]!.id;
              setTab(id);
              tabRefs.current[id]?.focus();
            }}>
            {TABS.map((t) => (
              <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" aria-selected={tab === t.id}
                id={`pol-tab-${t.id}`} aria-controls={`pol-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
                className="agx-pol-tab" data-current={tab === t.id ? "" : undefined} onClick={() => setTab(t.id)}>{t.id}</button>
            ))}
          </div>
          <div className="agx-pol-savebar">
            <span className="agx-pol-saving" role={note ? "alert" : "status"}>
              {note ? note : stale ? STALE : plan.dirty ? `${plan.unsaved} change${plan.unsaved === 1 ? "" : "s"} not saved` : "All changes saved"}
            </span>
            <Button size="compact" disabled={!plan.dirty || busy} onClick={discard}>Discard</Button>
            <Button size="compact" tone="primary" buttonRef={saveRef} pending={busy} disabled={!plan.dirty || busy} onClick={askSave}>Save changes</Button>
          </div>
        </div>
        {confirm && (
          <div className="agx-pol-consent" role="alertdialog" aria-label="Confirm the doors that act without asking" ref={consentRef} tabIndex={-1}>
            <p className="agx-pol-consent-head">{confirm.map((d) => DOOR_COPY[d].name).join(", ")} would act without asking once saved and Polaris is on.</p>
            <ul>{confirm.map((d) => <li key={d}>{consentSentence(d, plan.effective)}</li>)}</ul>
            <div className="agx-pol-consent-acts">
              <Button size="compact" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button size="compact" tone="primary" pending={busy} disabled={busy} onClick={() => void commit(confirm)}>Save and allow it</Button>
            </div>
          </div>
        )}
      </div>

      <div className="agx-pol-panel" role="tabpanel" id={`pol-panel-${tab}`} aria-labelledby={`pol-tab-${tab}`}>
        <div className="agx-pol-panel-head">
          {activeTab.glyph}
          <div className="agx-pol-panel-copy"><h3>{tab}</h3><p>{activeTab.sub}</p></div>
          <div className="agx-pol-scope">
            <span className="agx-pol-chip">{scope === "project" ? "Set for this project" : "Set for All projects"}</span>
            {scope === "project" && (
              <Button size="compact" disabled={own === 0} title={own === 0 ? "Every door here already follows the global settings." : "These doors follow the global settings again."}
                onClick={() => useGlobal(tab)}>Use global</Button>
            )}
          </div>
        </div>

        {/* One announcement: a reload's error sits here with its Retry; a save's error sits by Save in the pinned chrome. */}
        {error && !note && <div className="agx-pol-error" role="alert">{error} <Button size="compact" onClick={reload}>Retry</Button></div>}

        {group && layerDoors.map((door) => (
          <Fragment key={door}>
            <DoorLine door={door} value={doors[door]}
              changed={plan.moved.includes(door)} source={rowSource(scope, plan.effective.layers[door])} disabled={busy}
              onMode={(mode) => setValue(door)({ mode })}
              onInfo={() => setInfo(info === door ? null : door)} />
            {showsParams(door, doors[door].mode) && (
              <DoorParams door={door} value={doors[door]} disabled={busy} onChange={setValue(door)} />
            )}
          </Fragment>
        ))}

        {tab === "Limits" && LIMITS.map((l) => (
          <LimitLine key={`${l.door}.${l.param}`} door={l.door} param={l.param} name={l.name} hint={l.hint}
            value={Number(doors[l.door][l.param])} on={active(l.door, doors[l.door])} disabled={busy}
            onChange={(n) => setValue(l.door)({ [l.param]: n })} />
        ))}

        {tab === "Guardrails" && (
          <>
            {GUARDRAILS.map((g) => (
              <div className="agx-pol-row" key={g.title} data-guardrail="">
                <span className="agx-pol-dot" data-on="" aria-hidden />
                <div className="agx-pol-row-text"><div className="agx-pol-row-name">{g.title}</div><div className="agx-pol-row-what">{g.detail}</div></div>
                <span className="agx-pol-locked">locked</span>
              </div>
            ))}
            <details className="agx-pol-also">
              <summary>Also never ({ALSO_NEVER.length})</summary>
              <ul>{ALSO_NEVER.map((l) => <li key={l}>{l}</li>)}</ul>
            </details>
          </>
        )}

        {info && (
          <aside className="agx-pol-info" aria-label={`About ${DOOR_COPY[info].name}`}>
            <div className="agx-pol-info-head">
              <span className="agx-pol-label">Example</span>
              <Button square size="compact" label="Close the example" onClick={() => setInfo(null)}><CloseIcon size={ICON.sm} /></Button>
            </div>
            <p><b>{DOOR_COPY[info].name}</b>: {DOOR_COPY[info].example}</p>
            <span className="agx-pol-label">What stays yours</span>
            <p>{DOOR_COPY[info].keep}</p>
          </aside>
        )}

        <div className="agx-pol-foot">
          <span>{activeTab.foot}</span>
          <span className="agx-pol-grow" />
          <span><b>{tab === "Limits" ? `${LIMITS.length} limits` : tab === "Guardrails" ? `${GUARDRAILS.length} rules` : `${layerDoors.length} doors`}</b>
            {tab !== "Limits" && tab !== "Guardrails" ? ` · ${layerDoors.filter((d) => active(d, doors[d])).length} on in ${draft.preset === "custom" || draft.preset === "none" ? "this setting" : PRESETS[draft.preset as PresetId].label}` : ""}
          </span>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={`${menu.tab} menu`} pop>
          <MenuRow onClick={() => { setTab(menu.tab); setMenu(null); }} kbd={TAB_KEYS.open}>Open this block</MenuRow>
          <MenuRow onClick={() => { takeSafestPosition(menu.tab); setMenu(null); }}>Take this block's safest position</MenuRow>
          <MenuRow onClick={() => { useGlobal(menu.tab); setMenu(null); }} disabled={scope !== "project" || ownCountOf(menu.tab) === 0}>Use the general setting</MenuRow>
        </ContextMenu>
      )}
    </section>
  );
}
