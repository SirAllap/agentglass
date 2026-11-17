import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Filter, SettingRow, Toggle } from "../SettingRow.tsx";
import { Choice } from "../SettingChoice.tsx";
import { useReportHead } from "../SettingsPageState.tsx";
import { SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { PanesIcon } from "../settingsNavIcons.tsx";
import { PAGE_BTN_SM } from "./OrchKit.tsx";
import { StarIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, INPUT, INPUT_STYLE, LINE } from "../workspace/Chrome.tsx";
import { WorkersPage } from "../settings/pages/WorkersPage.tsx";
import { FlowReviewPage } from "../settings/pages/FlowReviewPage.tsx";
import { api, type PolicyRuleState, type SeatAnswer } from "../../lib/api.ts";
import { openSettings } from "../../lib/openSettings.ts";
import type { Policy, PolicyRule } from "../../../../shared/orchestration.ts";
import { usageProvider } from "../../../../shared/orchestration.ts";
import type { EngineReadiness, EnginesReport } from "../../../../shared/types.ts";
import { SWITCHABLE_COMMANDS } from "../../../../shared/workerRoles.ts";
import type { Flow } from "../../../../shared/flow.ts";
import { pathRoles } from "../../../../shared/flow.ts";
import { validatePresetList, type PresetFile, type PresetTarget } from "../../../../shared/preset.ts";
import { readEngines } from "../engines/readEngines.ts";
import { useJiraUnits } from "../../lib/jiraUnits.ts";
import { sessionStartStatusNames } from "../../lib/sessionStartMoveStatus.ts";
import { flowLikeOf } from "../../lib/roleLabel.ts";
import { DoorCard, EnvLimitsCard } from "./DoorValueRow.tsx";
import { SEAT_ROWS, STORED_ROWS } from "./doorSpecs.ts";
import { RuleStrip } from "./RuleStrips.tsx";
import { presetLabel } from "./QuickSetup.tsx";
import { ScopeControl } from "../settings/scope/ScopeControl.tsx";
import { envLoosens, pushSaveToast, useLoosenGate } from "../settings/save/index.ts";
import { useScope } from "../settings/scope/useScope.ts";
import { rootFor, choiceFor, withSaved } from "../settings/scope/scopeModel.ts";
import { LoadFailed, NothingSetUp } from "./OrchStates.tsx";
import { SettingsPage } from "../settings/shell/SettingsPage.tsx";
import { Section } from "../settings/shell/Section.tsx";

/** A state with no policy to draw still sits on the shell's page, so it shares the column (and left edge) of the pages stacked under it. */
const OnFlowPage = ({ children }: { children: React.ReactNode }) => (
  <SettingsPage title="Flow & review" purpose="How work moves between agents, who reviews it, and what Polaris watches."
    sections={[{ id: "canvas", title: "Flow", kind: "normal", body: <Section id="canvas" title="Flow">{children}</Section> }]} />
);
import { Note } from "./SafetyParts.tsx";
import { DenyBox } from "./SafetyParts.tsx";
import { FlowIcon } from "./flow/flowIcons.tsx";
import { FlowSlot } from "./flow/FlowSlot.tsx";
import { MainTrustCard, RefusedSection, SafetySection } from "./flow/FlowSections.tsx";
import { DEFAULT_ROUNDS } from "./flow/flowCopy.ts";
import { OPEN_CONDITIONS, OPEN_PRESETS } from "./flow/FlowSlot.tsx";
import { writeReviewSetting } from "../../lib/reviewRounds.ts";
import { REVIEW_SETTING_IDS, REVIEW_ROUNDS_MIN, REVIEW_ROUNDS_MAX } from "../../../../shared/reviewSettings.ts";
import { MCP_READONLY_KNOWN, mcpModesOf } from "../../../../shared/mcpReadonly.ts";
import { rowId } from "../../lib/settingsIndex.ts";
import { reducedMotion } from "../../lib/lookPrefs.ts";
import { PILOT_CHIP } from "../../lib/pilotSettings.ts";
import type { Pilot } from "../../lib/flightPilot.ts";
import type { HeaderChip } from "../../lib/settingsNav.ts";
import { MOCKUP_INK, OrchestratorHero, type HeroPathStep } from "./OrchestratorHero.tsx";
import { PresetCards } from "./PresetCards.tsx";
import { useRoleCounts } from "../../lib/useRoleCounts.ts";
import { flightOwner } from "../../lib/flowLive.ts";
import { orchestratorCardModel } from "../../lib/orchestratorCardView.ts";
import {
  baseChoice, presetChip, ruleHolds, presetOffers, scopeWords, usageLeft, usageWord, openingScope, recallScope, rememberScope,
  ruleBadge, ruleLine, shippedPresets, stepLimit,
  withEnvelopes, withLimits, withRuleEnabled, LIMIT_RANGE,
} from "./orchestrationCopy.ts";
import { effectiveChoice } from "./flow/canvasRules.ts";

/**
 * How work is handed out: which engine sits in a project's chair, which ones
 * do the work it gives out, and the rules that change that for a while.
 *
 * Only a person changes the policy cards. Nothing on them has a setting id, so an
 * agent can open and read them and cannot write them: the orchestrator works
 * inside this policy. Polaris — its doors, presets and limits — has its own page
 * beside this one (`polaris.*` setting ids), and the card at the foot of this
 * page only points there.
 *
 * Nothing polls. The page reads the policy, the engines, the rules' state and the
 * Polaris doors when it opens, when the project changes and after each save; the
 * server settles a rule's switch and wakes the Polaris sweep on the events that
 * change a reading, so the badges are as fresh as the last time somebody looked.
 */

/** What the view needs of the chair for the project it is showing. */
export interface SeatFacts { live: boolean; model: string; models: { id: string; label: string }[] }

export interface OrchestrationViewProps {
  policy: Policy;
  scope: "project" | "global";
  /** "" is All projects. */
  root: string;
  projects: string[];
  /** The project the app has open: what "Only <project>" means. Defaults to the one on screen, else the first of `projects`. */
  project?: string | null;
  /** What All projects hold, while a project is on screen: the rows compare against it. */
  general?: { policy: Policy; rounds: number } | null;
  /** null until the probe has answered: every engine reads "Checking". */
  readiness: EngineReadiness[] | null;
  states: PolicyRuleState[];
  /** null for All projects, or before the chair has answered. */
  seat: SeatFacts | null;
  /** What this project has spent today, from the stored events the server
   *  keeps; null for All projects, or before the read. */
  todaySpend?: number | null;
  /** The server's sentence for a refusal, by the card that asked. */
  notes: Record<string, string>;
  busy: boolean;
  /** The last policy save through this page was refused: the chip in the scope bar says so. */
  saveFailed?: boolean;
  /** A rule's form or the new-rule form open from the start (a test and a screenshot show it). */
  openRule?: string | "new";
  /** The moment the strips mark as now; the clock when left out. */
  now?: Date;
  /** A section saved or linked to; the retired "block" and anything unknown open Safety and limits. */
  section?: string;
  onRoot: (root: string) => void;
  /** Answers null when it saved, or the server's sentence. */
  onSave: (next: Policy, card: string) => Promise<string | null>;
  onOpenEngines: () => void;
  /** Flow & review (default) or Roles & limits: the same policy, two pages. */
  part?: "flow" | "limits" | "permWorkers" | "permMain";
  /** Drawn directly under the scope bar: the page's own link row, never above the bar. It is handed the scope on screen, because what it says is about that scope. */
  lead?: (root: string) => ReactNode;
  /** The person's own presets, read by the pane. */
  presets?: PresetFile[];
  /** Saves a preset's policy and flow through the page's own routes: null when it saved, else the sentence. */
  onApplyFlow?: (flow: Flow) => Promise<string | null>;
  onSavePreset?: (preset: PresetFile) => Promise<string | null>;
  onDeletePreset?: (name: string) => Promise<string | null>;
  /**
   * The Flow editor, read from the server by its own component: this view makes no request.
   * It opens when `editReq` counts up, and hands back the flow's names for the roles and the flow itself.
   */
  flowSlot?: (editReq: number, onNames: (n: FlowNames, flow: Flow | null) => void, editBlock?: string) => ReactNode;
}

/** The page, drawn from what it is handed: no request is made here. */
/** Whether a sandboxed worker may write the git paths that run code on the next git command. Off is what the sandbox always did. */
function GitInternalsToggle({ root }: { root: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    void api.settingAt("workers.gitInternals", root).catch(() => null).then((r) => { if (live && r?.ok) setOn(r.value === true); });
    return () => { live = false; };
  }, [root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet("workers.gitInternals", !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  return (
    <>
      <span hidden data-setting="workers.gitInternals" />
      <Toggle settingId="workers.gitInternals" on={on} disabled={busy} onClick={() => void flip()} label="Worker git internals"
        hint="Off: a worker cannot write the directory core.hooksPath names (husky, lefthook) or a submodule's git dir, so a hook it plants cannot run later outside the sandbox. On: it can, so use it only for a project whose workers must change them. The CLI keeps .git/hooks and .git/config shut on its own, whatever this says. Only you turn it on." />
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </>
  );
}

/** Whether an engine with no sandbox may run as a worker. Off refuses it. */
function UnwalledEnginesToggle({ root }: { root: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    void api.settingAt("workers.unwalledEngines", root).catch(() => null).then((r) => { if (live && r?.ok) setOn(r.value === true); });
    return () => { live = false; };
  }, [root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet("workers.unwalledEngines", !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  return (
    <>
      <span hidden data-setting="workers.unwalledEngines" />
      <Toggle settingId="workers.unwalledEngines" on={on} disabled={busy} onClick={() => void flip()} label="Engines with no read wall"
        hint="Off: a worker whose engine has no wall of its own runs inside a read wall, and if this machine cannot build one the app refuses to start it. On: it runs anyway, and could read the app's own token and anything else you can. Only you turn it on." />
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </>
  );
}

/** Whether this project's built-in scout (planner) may write its own worktree
 *  and `.agx-tmp`. Off is what a scout always ran; `AGENTGLASS_PLANNER_WRITE`
 *  wins and locks the row. */
function PlannerWriteToggle({ root }: { root: string }) {
  const [on, setOn] = useState(false);
  const [env, setEnv] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    void api.settingAt("workers.plannerWrite", root).catch(() => null).then((r) => {
      if (live && r?.ok) { setOn(r.value === true); setEnv(r.env ?? null); }
    });
    return () => { live = false; };
  }, [root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet("workers.plannerWrite", !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  return (
    <>
      <span hidden data-setting="workers.plannerWrite" />
      <Toggle settingId="workers.plannerWrite" on={on} disabled={busy || !!env} onClick={() => void flip()} label="Planner may write its own worktree and .agx-tmp"
        hint="Off: a scout answers only in its last message, which the app saves to .agx-tmp/plan.md for it. On: a scout's turn gets edit tools too, same as a builder's, scoped to its own worktree. Turning it on waits for you when an agent asks." />
      {env && <div className="mt-1 text-[12px]" style={{ color: "var(--warning-ink)" }}>Set by {env.name} when the server started ({env.value}); this row is locked until it is unset and the server restarts.</div>}
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </>
  );
}

/**
 * The flow's Session start step: on, a worker's first turn moves its Jira
 * card to the status below, through the move door. The status is a picker
 * read from the same place the Jira settings page's workflow map reads its
 * statuses (`useJiraUnits`, held ten minutes, already fetched for that page);
 * free text only when that read fails, so the row still works with no Jira
 * connected or no answer from it.
 */
/** A text field with its Save button, as its own component, not a raw `<input>` inline in a
 *  `control={…}` prop, so settings-page-rules.test.ts's migrated-page sweep
 *  does not read it as a hand-built form. */
function SaveTextField({ settingId, text, onChange, onSave, busy, saved, placeholder, label, numeric }: {
  settingId: string; text: string; onChange: (v: string) => void; onSave: () => void; busy: boolean; saved?: boolean;
  placeholder: string; label?: string; numeric?: boolean;
}) {
  return (
    <div data-setting={settingId} className="flex items-center gap-2">
      <input value={text} spellCheck={false} aria-label={label} placeholder={placeholder} inputMode={numeric ? "numeric" : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSave(); } }}
        className={`min-w-0 flex-1 ${INPUT}`} style={INPUT_STYLE} />
      <Button onClick={onSave} disabled={busy || saved}>{busy ? "Saving…" : "Save"}</Button>
    </div>
  );
}

/** The Claude account (config folder) this project's agents use: a path with Save and Clear. Empty is the default. */
function ClaudeAccountRow({ root }: { root: string }) {
  const [saved, setSaved] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    let tag = true;
    void api.settingAt("workers.claudeConfigDir", root).catch(() => null).then((r) => {
      if (tag && r?.ok && typeof r.value === "string") { setSaved(r.value); setText(r.value); }
    });
    return () => { tag = false; };
  }, [root]);
  const save = async (v: string) => {
    setBusy(true); setErr("");
    const r = await api.settingAtSet("workers.claudeConfigDir", v, root).catch(() => ({ ok: false, error: "Could not reach the server" } as { ok: boolean; error?: string }));
    setBusy(false);
    if (r.ok) { setSaved(v); setText(v); } else setErr(r.error || "Not saved");
  };
  return (
    <SettingRow settingId="workers.claudeConfigDir" label="Claude account for this project"
      hint="Config folder of the Claude login its agents use. Empty is the default."
      status={err ? <StatusBadge tone="err">{err}</StatusBadge> : undefined}
      control={<div className="flex items-center gap-2">
        <SaveTextField settingId="workers.claudeConfigDir" text={text} onChange={setText} onSave={() => void save(text.trim())}
          busy={busy} saved={text.trim() === saved} placeholder="e.g. /home/acme/.claude-work" label="Claude config folder" />
        <Button onClick={() => void save("")} disabled={busy || (saved === "" && text === "")}>Clear</Button>
      </div>} />
  );
}

/** The free-text fallback for the status field, when Jira's own statuses could not be read. */
function StatusTextField({ text, onChange, onSave, busy }: { text: string; onChange: (v: string) => void; onSave: () => void; busy: boolean }) {
  return <SaveTextField settingId="flow.sessionStart.moveStatus" text={text} onChange={onChange} onSave={onSave} busy={busy}
    label="Status to move it to" placeholder="e.g. In Review" />;
}

function FlowAutoContinueToggle({ root }: { root: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    void api.settingAt("flow.autoContinue", root).catch(() => null).then((r) => { if (live && r?.ok) setOn(r.value === true); });
    return () => { live = false; };
  }, [root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet("flow.autoContinue", !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  return (
    <>
      <span hidden data-setting="flow.autoContinue" />
      <Toggle settingId="flow.autoContinue" on={on} disabled={busy} onClick={() => void flip()} label="Auto-continue to next flow role"
        hint="On: when a worker ends with no trailing question, the next role on the flow's path starts in the same tab, same worktree. Off: the tab waits for you, as it always did." />
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </>
  );
}

function NotifyPrReviewsRow({ root }: { root: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [bots, setBots] = useState("");
  const [botsText, setBotsText] = useState("");
  const [botsBusy, setBotsBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api.settingAt("flow.notifyPrReviews", root).catch(() => null).then((r) => { if (live && r?.ok) setOn(r.value === true); });
    void api.settingAt("flow.notifyPrReviews.bots", root).catch(() => null).then((r) => {
      if (!live || !r?.ok) return;
      const v = typeof r.value === "string" ? r.value : "";
      setBots(v); setBotsText(v);
    });
    return () => { live = false; };
  }, [root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet("flow.notifyPrReviews", !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  const saveBots = async (v: string) => {
    setBotsBusy(true);
    const r = await api.settingAtSet("flow.notifyPrReviews.bots", v, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBotsBusy(false);
    if (r.ok && r.applied !== false) { setBots(v); setBotsText(v); }
  };
  return (
    <>
      <span hidden data-setting="flow.notifyPrReviews" />
      <Toggle settingId="flow.notifyPrReviews" on={on} disabled={busy} onClick={() => void flip()} label="Notify the project lead of PR reviews"
        hint="On: a bot review change on an open pull request is told to this project's lead. GitHub's own bot test decides who counts, by default. Off: nothing is read for this." />
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
      <SettingRow settingId="flow.notifyPrReviews.bots" label="Extra logins that count as a bot's review"
        hint="Comma-separated. Only logins GitHub's own test misses; empty is nothing extra, the usual bots already count."
        control={<SaveTextField settingId="flow.notifyPrReviews.bots" text={botsText} onChange={setBotsText} onSave={() => void saveBots(botsText.trim())}
          busy={botsBusy} saved={botsText === bots} placeholder="e.g. my-custom-bot, review-helper" />} />
    </>
  );
}

function NextCardRow({ root }: { root: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [filterId, setFilterId] = useState("");
  const [filterText, setFilterText] = useState("");
  const [filterBusy, setFilterBusy] = useState(false);
  const [cap, setCap] = useState(2);
  const [capBusy, setCapBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api.settingAt("flow.nextCard.enabled", root).catch(() => null).then((r) => { if (live && r?.ok) setOn(r.value === true); });
    void api.settingAt("flow.nextCard.filterId", root).catch(() => null).then((r) => {
      if (!live || !r?.ok) return;
      const v = typeof r.value === "string" ? r.value : "";
      setFilterId(v); setFilterText(v);
    });
    void api.settingAt("flow.nextCard.cap", root).catch(() => null).then((r) => { if (live && r?.ok && typeof r.value === "number") setCap(r.value); });
    return () => { live = false; };
  }, [root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet("flow.nextCard.enabled", !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  const saveFilter = async (v: string) => {
    setFilterBusy(true);
    const r = await api.settingAtSet("flow.nextCard.filterId", v, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setFilterBusy(false);
    if (r.ok && r.applied !== false) { setFilterId(v); setFilterText(v); }
  };
  const saveCap = async (v: number) => {
    setCapBusy(true);
    const r = await api.settingAtSet("flow.nextCard.cap", v, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setCapBusy(false);
    if (r.ok && r.applied !== false) setCap(v);
  };
  return (
    <>
      <span hidden data-setting="flow.nextCard.enabled" />
      <Toggle settingId="flow.nextCard.enabled" on={on} disabled={busy} onClick={() => void flip()} label="Next card: scout a saved filter's members"
        hint="On: every 5 minutes, a saved Jira filter is read and a read-only scout starts for each card it shows that this has not already started one for. Off: nothing is read for this." />
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
      <SettingRow settingId="flow.nextCard.filterId" label="The saved filter to read, by its id"
        hint="The number in the filter's own URL. Empty is off, whatever the switch above says."
        control={<SaveTextField settingId="flow.nextCard.filterId" text={filterText} onChange={setFilterText} onSave={() => void saveFilter(filterText.trim())}
          busy={filterBusy} saved={filterText === filterId} placeholder="e.g. 10042" numeric />} />
      <SettingRow settingId="flow.nextCard.cap" label="Most scouts running at once for this filter"
        hint="1 to 10. The filter is read every 5 minutes either way."
        control={<div data-setting="flow.nextCard.cap"><Select value={String(cap)} busy={capBusy} onChange={(v) => void saveCap(Number(v))}
          options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} /></div>} />
    </>
  );
}

function SessionStartMoveRow({ root }: { root: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [text, setText] = useState("");
  const { state } = useJiraUnits();
  useEffect(() => {
    let live = true;
    void api.settingAt("flow.sessionStart.move", root).catch(() => null).then((r) => { if (live && r?.ok) setOn(r.value === true); });
    void api.settingAt("flow.sessionStart.moveStatus", root).catch(() => null).then((r) => {
      if (!live || !r?.ok) return;
      const v = typeof r.value === "string" ? r.value : "";
      setStatus(v); setText(v);
    });
    return () => { live = false; };
  }, [root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet("flow.sessionStart.move", !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  const saveStatus = async (v: string) => {
    setStatusBusy(true);
    const r = await api.settingAtSet("flow.sessionStart.moveStatus", v, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setStatusBusy(false);
    if (r.ok && r.applied !== false) { setStatus(v); setText(v); }
  };
  // The read the Jira settings page already does: every project's statuses, held ten minutes.
  // A stale list from a failed re-read still beats no picker at all.
  const names = sessionStartStatusNames(state);
  const canPick = names.length > 0;
  return (
    <>
      <span hidden data-setting="flow.sessionStart.move" />
      <Toggle settingId="flow.sessionStart.move" on={on} disabled={busy} onClick={() => void flip()}
        label="Move the card at session start"
        hint="On: a worker's first turn, started for a Jira card, moves it to the status below through the move door (Settings ▸ Jira ▸ Move cards between steps). Off: the card stays where it was, as it always did." />
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
      <SettingRow settingId="flow.sessionStart.moveStatus" label="Status to move it to"
        hint={canPick ? "Read from your Jira projects; matched by name, case-insensitively, against the card's own moves when a worker starts."
          : state.kind === "loading" ? "Reading your statuses…"
            : "Could not read your statuses, so type the name as Jira shows it."}
        control={canPick
          ? <div data-setting="flow.sessionStart.moveStatus"><Select value={status} busy={statusBusy} onChange={(v) => void saveStatus(v)}
              options={[{ value: "", label: "Not set" }, ...names.map((nm) => ({ value: nm, label: nm }))]} /></div>
          : <StatusTextField text={text} onChange={setText} onSave={() => void saveStatus(text.trim())} busy={statusBusy} />} />
    </>
  );
}

/** One of the app's own doors, opened or closed to a worker's shell in this project. Closed is what the lock always was. */
function AppDoorToggle({ door, root, hint }: { door: "agentglass-agent" | "agentglass-ui" | "agentglass-cockpit-mcp"; root: string; hint: string }) {
  const id = `workers.appDoors.${door}`;
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    void api.settingAt(id, root).catch(() => null).then((r) => { if (live && r?.ok) setOn(r.value === true); });
    return () => { live = false; };
  }, [id, root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet(id, !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  return (
    <>
      <Toggle settingId={id} on={on} disabled={busy} onClick={() => void flip()} label={`A worker's shell may run ${door}`} hint={hint} />
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </>
  );
}

/** One command no role's grant can lift, opened or closed to every worker's shell in this project. Closed is what the lock always was. */
function WorkerCommandToggle({ cmd, root }: { cmd: string; root: string }) {
  const key = cmd.replace(/ /g, "-");
  // Open until the project stored false: the server reads `!== false`. Locked until that read answers, so a click cannot flip the wrong way.
  const [on, setOn] = useState(true);
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    void api.settingAt(`workers.commands.${key}`, root).catch(() => null).then((r) => { if (live && r?.ok) { setOn(r.value !== false); setRead(true); } });
    return () => { live = false; };
  }, [key, root]);
  const flip = async () => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet(`workers.commands.${key}`, !on, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setOn(!on);
  };
  return (
    <>
      <Toggle settingId={`workers.commands.${key}`} on={on} disabled={busy || !read} onClick={() => void flip()} label={`A worker's shell may run ${cmd}`}
        hint="Open by default. Closed: the lock refuses it for every worker, whatever a role is granted. Open lifts only that rule; the sandbox and its network and write limits still hold." />
      {note && <div className="mb-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </>
  );
}

/** How long a quiet field may stay quiet, and how long the prompt cache stays warm: the orchestrator's two timing settings, read and saved here. */
function OrchestratorTimingRows() {
  const [wake, setWake] = useState(4);
  const [ttl, setTtl] = useState(5);
  useEffect(() => {
    let live = true;
    void api.seatWake().then((r) => { if (live && r.ok) setWake(r.hours); }).catch(() => undefined);
    void api.lanternSettings().then((r) => { if (live && typeof r.cacheTtlMinutes === "number") setTtl(r.cacheTtlMinutes); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return (
    <>
      <Choice select settingId="seat.wakeHours" label="Wake the orchestrator at least every" value={String(wake)}
        hint="How long a quiet field may stay quiet before it gets a line anyway. Covers every project."
        options={[1, 2, 4, 8, 12, 24].map((h) => ({ v: String(h), label: h === 1 ? "1 hour" : `${h} hours` }))}
        onPick={(h) => { void api.seatWakeSave(Number(h)).then(() => setWake(Number(h))); }} />
      <Choice settingId="lantern.cacheTtlMinutes" label="How long the prompt cache stays warm" value={String(ttl === 60 ? 60 : 5)}
        hint="A turn sent while it is warm is the cheap one."
        options={[{ v: "5", label: "5 min" }, { v: "60", label: "1 hour" }]}
        onPick={(m) => { void api.lanternSettingsSave({ cacheTtlMinutes: Number(m) }).then((r) => { if (r.ok && typeof r.cacheTtlMinutes === "number") setTtl(r.cacheTtlMinutes); }); }} />
    </>
  );
}

export function OrchestrationView(p: OrchestrationViewProps) {
  const { policy, readiness, states, root, notes, busy } = p;
  // The section under the pointer card.
  const [flowNames, setFlowNames] = useState<FlowNames>({});
  /** The flow the editor last read: the hero's path and the presets' target. */
  const [flow, setFlow] = useState<Flow | null>(null);
  /** The names and the flow arrive together, from the slot's one read. */
  const onFlowRead = useCallback((names: FlowNames, read: Flow | null) => { setFlowNames(names); setFlow(read); }, []);
  /** The flow's names for the policy roles: every sentence on this page prints these, never the policy's. */
  const flowLike = useMemo(() => flowLikeOf(flowNames), [flowNames]);
  /** Counts the presses of "Open the Flow editor"; the slot opens the editor when it changes. */
  const [editReq, setEditReq] = useState(0);
  /** The policy role the editor opens selected on; none opens it unselected. */
  const [editBlock, setEditBlock] = useState<string | undefined>(undefined);
  /** The presets sheet under the hero: named setups live behind its chip, not in the page body. */
  const [presetsOpen, setPresetsOpen] = useState(false);
  // The round cap is a server setting the page reads for this project: the limits say when round N+1 does not start.
  const [rounds, setRounds] = useState(DEFAULT_ROUNDS);
  useEffect(() => {
    let live = true;
    void api.settingAt(REVIEW_SETTING_IDS.rounds, root).catch(() => null).then((r) => {
      if (live) setRounds(r?.ok && typeof r.value === "number" ? r.value : DEFAULT_ROUNDS);
    });
    return () => { live = false; };
  }, [root]);

  // The pilot the hero's chip names. Nothing is guessed before the read: the chip is drawn empty.
  const [mode, setMode] = useState("");
  useEffect(() => {
    let tag = true;
    void api.settingAt("flightPlan.pilot", root).catch(() => null).then((r) => {
      if (tag) setMode(r?.ok && typeof r.value === "string" ? PILOT_CHIP[r.value as Pilot] ?? "" : "");
    });
    return () => { tag = false; };
  }, [root]);

  // Nobody sits at a worker role's pane, so only a mode that never draws a
  // dialog is offered. Read once; the save below is immediate, like the rest
  // of this file's plain get/set settings (no draft, no save bar).
  // "" is unset: the server then follows flightPlan.builder.permissions, so the
  // row shows that value as what is in force instead of claiming dontAsk.
  const [permMode, setPermMode] = useState<"" | "dontAsk" | "bypassPermissions">("");
  const [builderPerm, setBuilderPerm] = useState<string>("");
  const [permBusy, setPermBusy] = useState(false);
  useEffect(() => {
    let tag = true;
    void api.settingAt("agents.permissionMode", root).catch(() => null).then((r) => {
      if (tag && r?.ok && (r.value === "dontAsk" || r.value === "bypassPermissions")) setPermMode(r.value);
    });
    void api.settingAt("flightPlan.builder.permissions", root).catch(() => null).then((r) => {
      if (tag && r?.ok && typeof r.value === "string") setBuilderPerm(r.value);
    });
    return () => { tag = false; };
  }, [root]);
  const savePermMode = async (v: "" | "dontAsk" | "bypassPermissions") => {
    setPermBusy(true);
    const r = await api.settingAtSet("agents.permissionMode", v, root).catch(() => ({ ok: false } as const));
    setPermBusy(false);
    if (r.ok) setPermMode(v);
  };

  const [sockets, setSockets] = useState<"off" | "all">("off");
  const [socketsBusy, setSocketsBusy] = useState(false);
  useEffect(() => {
    let tag = true;
    void api.settingAt("workers.unixSockets", root).catch(() => null).then((r) => {
      if (tag && r?.ok && (r.value === "off" || r.value === "all")) setSockets(r.value);
    });
    return () => { tag = false; };
  }, [root]);
  const saveSockets = async (v: "off" | "all") => {
    setSocketsBusy(true);
    const r = await api.settingAtSet("workers.unixSockets", v, root).catch(() => ({ ok: false } as const));
    setSocketsBusy(false);
    if (r.ok) setSockets(v);
  };

  // Whether a worker role's turn loads the checkout's own `.claude/skills` and
  // `.claude/commands` — never its hooks, MCP servers or permissions.allow
  // (headless.ts `stageProjectSkills`). On by default.
  const [projectSkills, setProjectSkills] = useState(true);
  const [skillsBusy, setSkillsBusy] = useState(false);
  useEffect(() => {
    let tag = true;
    void api.settingAt("workers.projectSkills", root).catch(() => null).then((r) => {
      if (tag && r?.ok) setProjectSkills(r.value !== false);
    });
    return () => { tag = false; };
  }, [root]);
  const saveProjectSkills = async (v: boolean) => {
    setSkillsBusy(true);
    const r = await api.settingAtSet("workers.projectSkills", v, root).catch(() => ({ ok: false } as const));
    setSkillsBusy(false);
    if (r.ok) setProjectSkills(v);
  };

  // Which of the person's configured MCP servers (`~/.claude.json`) a worker
  // role's turn is given, and whether each is read-only or may write.
  // Escalation: each one acts with the person's own account, so a widening
  // waits for the person's own click; All, beyond that, is only the
  // person's (shared/settingClass.ts).
  const [mcpAvailable, setMcpAvailable] = useState<string[]>([]);
  const [mcpModes, setMcpModes] = useState<Record<string, "readOnly" | "all">>({});
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpErr, setMcpErr] = useState<string | null>(null);
  const loadMcp = useCallback(() => {
    void api.settingAtGlobal("workers.mcpServers.available").then((r) => { if (r.ok && Array.isArray(r.value)) setMcpAvailable(r.value as string[]); });
    void api.settingAt("workers.mcpServers", root).then((r) => {
      if (r.ok) setMcpModes(mcpModesOf(r.value));
    });
  }, [root]);
  useEffect(() => { loadMcp(); }, [loadMcp]);
  const saveMcp = async (next: Record<string, "readOnly" | "all">) => {
    setMcpBusy(true); setMcpErr(null);
    const r = await api.settingAtSet("workers.mcpServers", next, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setMcpBusy(false);
    if (!r.ok) { setMcpErr(r.error || "Could not save it"); return; }
    if (r.applied === false) { setMcpErr("That change waits for you on the requests card."); loadMcp(); return; }
    loadMcp();
  };
  /** Off -> Read-only (known servers only) -> All -> Off. */
  const cycleMcp = (name: string) => {
    if (mcpBusy) return;
    const cur = mcpModes[name];
    const next = cur === undefined ? (MCP_READONLY_KNOWN.includes(name) ? "readOnly" : "all") : cur === "readOnly" ? "all" : undefined;
    const map = { ...mcpModes };
    if (next) map[name] = next; else delete map[name];
    void saveMcp(map);
  };
  const mcpLabel: Record<"off" | "readOnly" | "all", string> = { off: "Off", readOnly: "Read-only", all: "All" };

  // The permissions are the stored ones: a change is written at once, and the toast's Undo writes the old ones back.
  const env = { ceiling: policy.ceiling, workerDefault: policy.workerDefault };
  const policyNow = useRef(policy); policyNow.current = policy;
  const gate = useLoosenGate();
  const putEnv = (to: typeof env, was: typeof env, row: string) => {
    void save(withEnvelopes(policyNow.current, to), "envelope").then((err) => {
      // Undo puts the old envelopes back; if that loosens (a switch off, a refusal added), it asks like any loosening change.
      if (!err) pushSaveToast("Saved", () => gate.gate(row, envLoosens(to, was), () => putEnv(was, to, row)));
    });
  };
  const setEnv = (next: typeof env) => {
    const back = { ceiling: policyNow.current.ceiling, workerDefault: policyNow.current.workerDefault };
    if (JSON.stringify(next) === JSON.stringify(back)) return;
    gate.gate("env", envLoosens(back, next), () => putEnv(next, back, "env"));
  };
  // A question built from one policy or project must not be answered after either changed: `next` carries the old values.
  const envKey = `${root}|${JSON.stringify(env)}`;
  useEffect(() => { gate.cancel(); }, [envKey, gate.cancel]); // eslint-disable-line react-hooks/exhaustive-deps

  // A project that follows all projects is edited in place: the first change gives it a value of its own.
  const inherited = root !== "" && p.scope === "global";
  const locked = busy;
  const project = p.project !== undefined ? p.project : (root || p.projects[0] || null);
  const choice = choiceFor(root, project);
  const onChoice = (c: "all" | "project") => p.onRoot(rootFor(c, project));
  // A settings search lists matching rows only; a control over them would name a project nothing below is about.
  const listing = useContext(Filter).on;
  const scopeStrip = listing ? null : (
    <div data-scope-bar className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <ScopeControl project={project} projects={p.projects} value={choice} onChange={onChoice} onPick={p.onRoot} />
      {p.lead ? p.lead(root) : undefined}
      {notes.scope && <div role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{notes.scope}</div>}
    </div>
  );
  const policyRef = useRef(policy); policyRef.current = policy;
  const roundsRef = useRef(rounds); roundsRef.current = rounds;
  const save = p.onSave;
  // The global policy and a project's own share rule ids; read the states of this one.
  const scopeKey = inherited || root === "" ? "global" : root;

  const scopeWord = scopeWords(root);
  const setLimit = (k: keyof Policy["limits"], to: number) => {
    const by = to > policy.limits[k] ? 1 : -1;
    void save(withLimits(policy, { [k]: stepLimit(k, policy.limits[k], by) }), "limits");
  };

  const openFlowEditor = (block?: string) => { setEditBlock(block); setEditReq((n) => n + 1); };
  // What a rule that holds right now puts in a seat, the same reading the flow editor draws; the base only where no rule decides.
  const holds = ruleHolds(states, scopeKey);
  const chair = effectiveChoice(policy, holds, "orchestrator") ?? baseChoice(policy, "orchestrator");
  // The board's counts, from the app's one poller: the hero's three numbers and the path's discs.
  // Before the flow is read there is no roster to count, so nothing is counted (not zero).
  const board = useRoleCounts(flow ?? NO_FLOW, root, policy.limits);
  const live = flow ? board : { counts: null, inFlight: null, last: null };
  const left = usageLeft(states, scopeKey);
  const planOf = chair.engine ? usageProvider(chair.engine) : null;
  const planLeft = planOf === null ? undefined : left[planOf];
  const planUsed = typeof planLeft === "number" ? Math.min(100, Math.max(0, Math.round(100 - planLeft))) : null;
  const moveAt = planOf === null ? undefined : policy.rules
    .filter((r) => r.enabled)
    .flatMap((r) => r.when)
    .find((t) => t.kind === "usage" && t.provider === planOf);
  const planMark = moveAt && moveAt.kind === "usage" ? Math.min(100, Math.max(0, 100 - moveAt.remainingAtMost)) : null;
  const readout = orchestratorCardModel(flow ?? NO_FLOW, {
    chair: chair.engine ? { engine: chair.engine, model: chair.model } : null,
    planLeft: left, maxWorkers: policy.limits.maxWorkers,
    last: live.last?.line ?? null, counts: live.counts, todaySpend: p.todaySpend ?? null,
  });
  const steps: HeroPathStep[] = flow ? pathRoles(flow).map((r) => {
    const counts = live.counts?.[r.id];
    const choice = r.policyRole ? (effectiveChoice(policy, holds, r.policyRole) ?? baseChoice(policy, r.policyRole)) : r.chain[0] ?? { engine: "", model: "" };
    return { id: r.id, name: r.name, hue: r.hue, ico: r.ico, engine: choice.engine, run: counts?.run ?? 0, wait: counts?.wait ?? 0, you: r.actor === "person", does: r.does };
  }) : [];

  // Under All projects the flow read is the first project's, so there is no flow above this page for a preset to change.
  const target: PresetTarget = { policy, flow: root ? flow : null };
  const applyPresetHere = async (next: PresetTarget): Promise<string | null> => {
    const what = envLoosens(env, next.policy);
    // A preset that widens write, network, docker or a refusal asks first; nothing is saved until Allow.
    if (what !== null) { gate.gate("preset", what, () => void commitPreset(next)); return "Nothing is saved yet: answer the question below."; }
    return commitPreset(next);
  };
  const commitPreset = async (next: PresetTarget): Promise<string | null> => {
    const e = await save(next.policy, "preset");
    if (e) return e;
    // A preset that carries no flow (under All projects, or the policy parts only) leaves the flow this page read alone.
    if (!next.flow || next.flow === flow) return null;
    setFlow(next.flow);
    return p.onApplyFlow ? p.onApplyFlow(next.flow) : null;
  };
  // The page's one primary action is the hero's, in the body: the page header carries none.
  useReportHead("orchestration", null);
  // A settings search lists matching rows only; the review rows below exist for it.
  const searching = useContext(Filter).on;

  if (p.part === "permWorkers") {
    return (
      <div className="agx-orch agx-flow" style={{ "--accent": MOCKUP_INK.accent } as React.CSSProperties}>
        <div className="agx-flow-pinned">
          {scopeStrip}
        </div>
        <div className="agx-flow-pg">
          {gate.at("env")}
          <SafetySection policy={policy} env={env} onEnv={setEnv} locked={locked}
            note={notes.envelope || notes.limits} root={root}
            onSeeRefused={() => document.getElementById("agx-flow-refused")?.scrollIntoView({ block: "start" })} />
            <SettingsCard title="Git commands" desc="Open by default. Closing one narrows every worker in this project.">
              {SWITCHABLE_COMMANDS.filter((c) => c.startsWith("git ")).map((cmd) => <WorkerCommandToggle key={cmd} cmd={cmd} root={root} />)}
            </SettingsCard>
            <SettingsCard title="Network commands" desc="The Network switch above closes curl and wget as a group; each has its own switch too.">
              {SWITCHABLE_COMMANDS.filter((c) => ["gh", "curl", "wget", "ssh", "scp", "aws", "docker"].includes(c)).map((cmd) => <WorkerCommandToggle key={cmd} cmd={cmd} root={root} />)}
            </SettingsCard>
            <SettingsCard title="This machine" desc="Open by default. Fixed: sudo and git worktree lock, move, repair and unlock are never allowed.">
              {SWITCHABLE_COMMANDS.filter((c) => !c.startsWith("git ") && !["gh", "curl", "wget", "ssh", "scp", "aws", "docker"].includes(c)).map((cmd) => <WorkerCommandToggle key={cmd} cmd={cmd} root={root} />)}
            </SettingsCard>
            <SettingsCard title="agentglass tools" desc="Closed by default. Opening one lifts only the shell's deny rule; the tool still checks who is calling.">
              <span hidden data-setting="workers.appDoors.agentglass-agent" />
              <span hidden data-setting="workers.appDoors.agentglass-ui" />
              <span hidden data-setting="workers.appDoors.agentglass-cockpit-mcp" />
              <AppDoorToggle door="agentglass-agent" root={root} hint="Off: a worker cannot start or message other agents. On lifts only the shell's deny rule; the door still checks who is calling. Only you turn it on." />
              <AppDoorToggle door="agentglass-ui" root={root} hint="Off: a worker cannot read or change this app's settings and rules. On lifts only the shell's deny rule; the door still checks who is calling. Only you turn it on." />
              <AppDoorToggle door="agentglass-cockpit-mcp" root={root} hint="Off: a worker cannot read your sessions, spend and errors. On lifts only the shell's deny rule. Only you turn it on." />
            </SettingsCard>
            <SettingsCard title="Sandbox" icon={<PanesIcon size={ICON.sm} />}>
              <SettingRow settingId="agents.permissionMode" label="Permission mode a worker role starts in"
                hint="Nobody sits at a worker's pane, so only a mode that never draws a dialog is offered. The sandbox and the deny list hold either way. Until it is set here, it follows Flight plan ▸ Builder permissions."
                control={<Select value={permMode} busy={permBusy} onChange={(v) => void savePermMode(v as "" | "dontAsk" | "bypassPermissions")}
                  options={[{ value: "", label: `Follow Flight plan builder (now ${builderPerm === "bypassPermissions" ? "Bypass" : "Ask nothing"})` }, { value: "dontAsk", label: "Ask nothing (refuse)" }, { value: "bypassPermissions", label: "Bypass" }]} />} />
              <SettingRow settingId="workers.unixSockets" label="Worker unix sockets"
                hint="Off keeps every socket out of a worker's shell, so a builder cannot run tmux tests or adb. All opens every Unix socket, agentglass's own tmux socket included: use it for a project whose workers must run tmux or adb tests. Loosening it waits for you when an agent asks."
                control={<div data-setting="workers.unixSockets"><Select value={sockets} busy={socketsBusy} onChange={(v) => void saveSockets(v as "off" | "all")}
                  options={[{ value: "off", label: "Off" }, { value: "all", label: "All" }]} /></div>} />
              <ClaudeAccountRow root={root} />
              <GitInternalsToggle root={root} />
              <UnwalledEnginesToggle root={root} />
              <PlannerWriteToggle root={root} />
              <Toggle settingId="workers.projectSkills" on={projectSkills} disabled={skillsBusy} onClick={() => void saveProjectSkills(!projectSkills)}
                label="Load the project's own skills and commands"
                hint="On: the checkout's .claude/skills and .claude/commands are staged into a plugin this turn alone loads — never its hooks, MCP servers or permissions. Off: a role turn sticks to the person's own skills." />
              <SettingRow settingId="workers.mcpServers" label="MCP servers a worker role may use"
                hint="Off, Read-only or All, per server. Each one acts with the person's own account — turning one on is a request that waits for your click; All, beyond that, is only yours. None are on by default."
                status={mcpErr ? <StatusBadge tone="err">{mcpErr}</StatusBadge> : undefined}
                below={mcpAvailable.length
                  ? <div className="flex flex-wrap gap-2">
                      {mcpAvailable.map((name) => {
                        const mode = mcpModes[name];
                        return (
                          <Button key={name} size="compact" on={!!mode} aria-pressed={!!mode} aria-label={`${name}, ${mcpLabel[mode ?? "off"]}`}
                            disabled={mcpBusy} onClick={() => cycleMcp(name)}>{name} · {mcpLabel[mode ?? "off"]}</Button>
                        );
                      })}
                    </div>
                  : <div className="text-[12px]" style={{ color: "var(--text4)" }}>No MCP servers configured in ~/.claude.json.</div>} />
            </SettingsCard>
          <section id="agx-flow-refused" aria-label="Always refused">
            <RefusedSection policy={policy} locked={locked} note={notes.envelope} scopeWord={scopeWord}
              onDeny={(deny) => setEnv({ ...env, workerDefault: { ...env.workerDefault, deny } })} />
          </section>
        </div>
      </div>
    );
  }
  if (p.part === "permMain") {
    return (
      <div className="agx-orch agx-flow" style={{ "--accent": MOCKUP_INK.accent } as React.CSSProperties}>
        <div className="agx-flow-pinned">
          {scopeStrip}
        </div>
        <div className="agx-flow-pg">
          <MainTrustCard root={root} />
        </div>
      </div>
    );
  }
  if (p.part === "limits") {
    return (
      <WorkersPage limits={policy.limits} rounds={rounds} locked={locked} busy={busy} projectScoped={root !== ""}
        scope={{
          project, projects: p.projects, onPick: p.onRoot, choice, onChoice, note: notes.scope, lead: p.lead ? p.lead(root) : undefined,
          own: root !== "" && !inherited,
          general: p.general ? { ...p.general.policy.limits, rounds: p.general.rounds } : null,
        }}
        machineSlot={<>
          <EnvLimitsCard root={root} title="Machine tuning" />
          <DoorCard title="Launch defaults" specs={STORED_ROWS} root={root} />
        </>}
        onLimit={(k, to) => { const cur = policyRef.current; void save(withLimits(cur, { [k]: Math.min(LIMIT_RANGE[k].max, Math.max(LIMIT_RANGE[k].min, to)) }), "limits"); }}
        onRounds={(to) => {
          const was = roundsRef.current; setRounds(to);
          void writeReviewSetting(REVIEW_SETTING_IDS.rounds, to, root).then((r) => { if (!r.ok) setRounds(was); }).catch(() => setRounds(was));
        }}
        onOpenRoles={() => openSettings("orchestration")} onOpenEngines={() => openSettings("engines")} onOpenPermissions={() => openSettings("permWorkers")} />
    );
  }
  return (
    <FlowReviewPage root={root}
      scopeSlot={scopeStrip}
      flowSlot={
        <div className="agx-orch agx-flow" style={{ "--accent": MOCKUP_INK.accent } as React.CSSProperties}>
          {p.flowSlot?.(editReq, onFlowRead, editBlock)}
          <div className="agx-flow-pg">
            <h2 className="agx-flow-t">Orchestration{" "}
          <span className="agx-flow-inf" tabIndex={0} data-tip="How the work is split between agents, on which engine, and what they may never do.">i</span>
        </h2>

        <OrchestratorHero chair={chair.engine ? { engine: chair.engine, model: chair.model } : null} mode={mode}
          path={steps}
          presetsOpen={presetsOpen} onOpenPresets={() => setPresetsOpen((on) => !on)}
          live={{
            plan: { label: planOf === null ? "Plan used" : `${usageWord(planOf)} plan used`, used: planUsed, mark: planMark },
            flight: live.inFlight && { ...live.inFlight, own: flightOwner(root, p.scope, policy.limits.maxWorkers, p.general?.policy.limits.maxWorkers) },
            today: readout.today === "\u2014" ? null : readout.today,
            // The block's own name and when, never the words a worker wrote: that line is its message, not a reading.
            last: live.last ? { name: steps.find((s) => s.id === live.last!.role)?.name ?? "A block", at: live.last.at } : null,
          }}
          conditionsOn={policy.rules.filter((r) => r.enabled).length}
          onConfigure={() => openFlowEditor()} onOpenConditions={() => openFlowEditor(OPEN_CONDITIONS)} onOpenFlow={() => openFlowEditor()} />

        {presetsOpen && (
          <div className="agx-flow-presets-sheet" data-presets-sheet>
            <PresetCards target={target} projectRoot={root} shipped={shippedPresets(policy, readiness)} mine={p.presets ?? []}
              busy={busy} note={notes.preset} onApply={applyPresetHere}
              onSaveMine={p.onSavePreset} onDeleteMine={p.onDeletePreset} />
            {gate.at("preset")}
          </div>
        )}
          </div>
        </div>
      }
      onOpenPolaris={() => openSettings("polaris")}
      machineSlot={<OrchestratorTimingRows />}
      onOpenConditions={() => openFlowEditor(OPEN_CONDITIONS)} onOpenReviewer={() => openFlowEditor("reviewer")} />
  );
}

/** What the flow calls each block that runs a policy role, by that role's id. */
type FlowNames = Record<string, { name: string; does: string }>;

type FlowSection = "safety" | "refused";

/** A saved or deep-linked section; the retired "block", "keys" (and anything unknown) read as the default. */
export const asSection = (v: unknown): FlowSection => v === "refused" ? v : "safety";

const storage = (): Storage | null => { try { return localStorage; } catch { return null; } };

/** What `useRoleCounts` reads before a project has a flow: a roster of nobody, so no count is invented. */
const NO_FLOW: Flow = { version: 1, path: [], blocks: [], roster: [], stages: [], edges: [] };

export function OrchestrationPane({ onChip, lead, part }: { onChip?: (c: HeaderChip | null) => void; lead?: (root: string) => ReactNode; part?: "flow" | "limits" | "permWorkers" | "permMain" } = {}) {
  // The shared scope: the project the app has open, and whether this page shows it or All projects.
  const sc = useScope();
  const root = sc.root;
  const chosen = { current: sc.chosen };
  const pick = useCallback((r: string) => (r === "" ? sc.setChoice("all") : sc.pick(r)), [sc.setChoice, sc.pick]);
  const [loaded, setLoaded] = useState<{ policy: Policy; scope: "project" | "global"; overrides: string[] } | null>(null);
  const [report, setReport] = useState<EnginesReport | null>(null);
  const [states, setStates] = useState<PolicyRuleState[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [seat, setSeat] = useState<SeatAnswer | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  /** The last save was refused, so the chip in the scope bar says the setting was not kept. */
  const [saveFailed, setSaveFailed] = useState(false);
  const [workspacesKnown, setWorkspacesKnown] = useState(false);
  const [startedGlobal, setStartedGlobal] = useState(false);
  const alive = useRef(true);
  // An effect runs again in development (and whenever React remounts it), and the
  // ref outlives the cleanup: without the reset every later answer is dropped.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadStates = useCallback(() => {
    void api.orchestrationState().then((r) => { if (alive.current && r.ok) setStates(r.rules); }).catch(() => { /* a failed read keeps what is on screen */ });
  }, []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const loadPolicy = useCallback((forRoot: string) => {
    void api.orchestration(forRoot || undefined).then((r) => {
      if (!alive.current) return;
      if (r.ok) { setLoaded({ policy: r.policy, scope: r.scope, overrides: r.overrides }); setLoadError(null); setSaveFailed(false); }
      else setLoadError((r as { error?: string }).error ?? "The server did not answer.");
    }).catch(() => { if (alive.current) setLoadError("Could not reach the server."); }).finally(() => { if (alive.current) setRetrying(false); });
    loadStates();
    if (forRoot) void api.seat(forRoot).then((r) => { if (alive.current) setSeat(r); }).catch(() => { if (alive.current) setSeat(null); });
    else setSeat(null);
  }, [loadStates]);

  useEffect(() => {
    void readEngines((fresh) => api.engines(fresh), setReport, { alive: () => alive.current }).catch(() => { /* the rows say "checking" until it answers */ });
    void api.projects().then((r) => {
      if (!alive.current) return;
      const ws = r.workspaces ?? (r.workspace ? [r.workspace] : []);
      setWorkspaces(ws);
      setWorkspacesKnown(true);
    }).catch(() => { /* no project switch without a list */ });
  }, []);
  useEffect(() => { loadPolicy(root); }, [root, loadPolicy]);

  // What All projects hold, read only while a project is on screen: its rows say whether they differ.
  const [general, setGeneral] = useState<{ policy: Policy; rounds: number } | null>(null);
  useEffect(() => {
    if (!root) { setGeneral(null); return; }
    let live = true;
    void Promise.all([api.orchestration(undefined).catch(() => null), api.settingAtGlobal(REVIEW_SETTING_IDS.rounds).catch(() => null)]).then(([pol, r]) => {
      if (!live) return;
      setGeneral(pol && pol.ok ? { policy: pol.policy, rounds: r?.ok && typeof r.value === "number" ? r.value : DEFAULT_ROUNDS } : null);
    });
    return () => { live = false; };
  }, [root, loaded]);

  // A person's own presets live on the server, per project like the other settings here.
  const [presets, setPresets] = useState<PresetFile[]>([]);
  const loadPresets = useCallback((forRoot: string) => {
    void api.settingAt("orchestration.presets", forRoot).catch(() => null).then((r) => {
      if (!alive.current) return;
      const v = r?.ok ? validatePresetList(r.value ?? []) : null;
      setPresets(v?.ok ? v.value : []);
    });
  }, []);
  useEffect(() => { loadPresets(root); }, [root, loadPresets]);

  /*
   * What this project has spent TODAY. A read of the stored events, not a sum
   * over the board's rows: a row takes its cost with it when its worker leaves,
   * so the same work read $0.00 after a restart. All projects has no one
   * project to spend, so it reads nothing.
   */
  const [spendToday, setSpendToday] = useState<number | null>(null);
  useEffect(() => {
    if (!root) { setSpendToday(null); return; }
    void api.spendToday(root).catch(() => null).then((r) => {
      if (alive.current) setSpendToday(r?.ok && typeof r.usd === "number" ? r.usd : null);
    });
  }, [root]);

  // The header chip names the setup in force: the preset that is on, or none.
  const readiness = report?.engines ?? null;
  useEffect(() => {
    if (!onChip) return;
    if (!loaded) { onChip(null); return; }
    onChip(presetChip(presetOffers(readiness, loaded.policy), presetLabel));
    return () => onChip(null);
  }, [onChip, loaded, readiness]);

  // The scope's own list (useScope: the scanned sweep the Open projects dialog lists, hidden ones out), not a
  // second unscanned read of its own: that read only the registered repos, so the menu showed 2 projects of 13.
  // Saved rules for a hidden repo do not bring it back: Permissions and Workers leave it out too.
  const projects = useMemo(() => withSaved(sc.projects, [...workspaces, ...(loaded?.overrides ?? [])], sc.hidden), [sc.projects, workspaces, loaded?.overrides, sc.hidden]);

  /** Store the person's presets as one list; the door validates it like every other setting. */
  const writePresets = async (next: PresetFile[], failure: string): Promise<string | null> => {
    const r = await api.settingAtSet("orchestration.presets", next, root).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return null;
    if (!r.ok) return r.error ?? failure;
    setPresets(next);
    return null;
  };
  const savePreset = async (preset: PresetFile): Promise<string | null> => {
    const next = [...presets.filter((x) => x.name !== preset.name), preset];
    return writePresets(next, `Could not save "${preset.name}".`);
  };
  const deletePreset = async (name: string): Promise<string | null> => writePresets(presets.filter((x) => x.name !== name), `Could not delete "${name}".`);
  /** A preset's flow half: a flow belongs to one project, so All projects has none to write. */
  const applyFlow = async (flow: Flow): Promise<string | null> => {
    if (!root) return "The permissions and rules were saved. A flow belongs to one project: pick one above, then apply the flow part again.";
    const r = await api.putFlow(root, flow).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return null;
    return r.ok ? null : `The permissions and rules were saved; the flow was not: ${r.error ?? "the server did not answer."}`;
  };

  /** Store the whole policy. Answers null when it saved, or the server's sentence, which also goes under the control that asked; nothing else moves. */
  const save = async (next: Policy, card: string): Promise<string | null> => {
    setBusy(true);
    const r = await api.orchestrationSave(next, root || undefined).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return null;
    setBusy(false);
    setSaveFailed(!r.ok || !r.policy);
    if (!r.ok || !r.policy) { const e = r.error ?? "Could not save."; setNotes((n) => ({ ...n, [card]: e })); return e; }
    setNotes((n) => ({ ...n, [card]: "" }));
    setLoaded({ policy: r.policy, scope: r.scope ?? "global", overrides: r.overrides ?? [] });
    loadStates();
    return null;
  };

  // Nothing open and nothing chosen: say so, and offer the one thing that works without a project.
  if (workspacesKnown && workspaces.length === 0 && !chosen.current && root === "" && !startedGlobal) {
    return <OnFlowPage><NothingSetUp onStart={() => setStartedGlobal(true)} /></OnFlowPage>;
  }

  // Before there is a policy to draw: a failed read says what the server answered, and the wait is a skeleton.
  if (!loaded) {
    if (loadError) {
      return <OnFlowPage><LoadFailed name={root ? root.split("/").filter(Boolean).pop()! : "all projects"} error={loadError} retrying={retrying}
        onRetry={() => { setRetrying(true); loadPolicy(root); }} /></OnFlowPage>;
    }
    return (
      <div className="agx-orch grid gap-3" aria-busy="true" aria-label="Loading">
        <div className="agx-skel rounded-lg" style={{ height: 12, width: 140 }} />
        <div className="agx-skel rounded-lg" style={{ height: 200 }} />
        <div className="agx-skel rounded-lg" style={{ height: 32, width: "60%" }} />
        <div className="agx-presets">{[0, 1, 2].map((i) => <div key={i} className="agx-skel rounded-lg" style={{ height: 200 }} />)}</div>
      </div>
    );
  }
  return (
    <OrchestrationView policy={loaded.policy} scope={loaded.scope} root={root} projects={projects} project={sc.project} general={general}
      readiness={readiness} states={states}
      seat={root && seat ? { live: seat.live && !!seat.seat, model: seat.seat?.model ?? "", models: seat.models } : null}
      todaySpend={spendToday}
      notes={notes} busy={busy} saveFailed={saveFailed} onRoot={pick} onSave={save}
      onOpenEngines={() => openSettings("engines")} lead={lead} part={part}
      presets={presets} onApplyFlow={applyFlow} onSavePreset={savePreset} onDeletePreset={deletePreset}
      flowSlot={(editReq, onNames, editBlock) => <FlowSlot root={root} projects={projects} editReq={editReq} editBlock={editBlock} onNames={onNames} onPolicySaved={() => loadPolicy(root)} />} />
  );
}
