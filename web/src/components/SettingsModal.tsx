// Settings — what used to be the "⋯" dropdown.
//
// That menu mixed three unrelated things in one flat list of one-liners:
// preferences you toggle, panels you open, and files you download. Worse, the
// toggles were rendered as their own label ("🔇 Alert sounds — off"), so the
// only way to learn what a click would do was to read the current state and
// invert it in your head — and a stale label read as a broken switch.
//
// Here each kind gets its own section, toggles look like toggles and say what
// they control, and downloads say what you actually get.
import { useModalDialog } from "../lib/focusTrap.ts";
import { PluginSettingsPane } from "./plugins/PluginSettingsPane.tsx";
import {
  reducedMotion, DEFAULT_DENSITY, DEFAULT_UI_FONT, densityPref, setDensityPref, uiFontPref, setUiFontPref, translucentPref, setTranslucentPref,
  reduceMotionChoice, resetReduceMotion,
} from "../lib/lookPrefs.ts";
import { Fragment, createContext, isValidElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RecipesPane } from "./RecipesPane.tsx";
import { ReviewPromptsPane } from "./ReviewPromptsPane.tsx";
import { SavedRepliesPane } from "./SavedRepliesPane.tsx";
import { lastTerminalRoot } from "./TerminalPanel.tsx";
import { Filter, Fold, SettingRow, choiceIsWide, Toggle, Switch, type RowDetail } from "./SettingRow.tsx";
import { resetShown } from "../lib/settingsModified.ts";
import { pageScore, absentFor, rowId, type SettingsPage } from "../lib/settingsIndex.ts";
import { motion, AnimatePresence } from "motion/react";
import { Portal, PortalFloor } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { api, type PrivacyFacts } from "../lib/api.ts";
import { savePaneField as paneFieldSave } from "../lib/paneEngineSave.ts";
import { browserPlaces, CAN_IMPORT_COOKIES, cookieSources, importCookies, forgetCookies, type CookieSource, type CookieImportReply } from "../lib/desktop.ts";
import { loadProfiles } from "../lib/browserProfiles.ts";
import { addVisible, allSites, bestSource, dropVisible, lockedWhy, reachable, siteView } from "../lib/cookiePick.ts";
import { PROVIDERS, type ProviderSpec, type ProviderStatus, type ProviderState, type TrackerChoice } from "../../../shared/providers.ts";
import { useTrackerSetup } from "../lib/trackerSetup.ts";
import { rememberTrackerChoices } from "../lib/trackerView.ts";
import { __forgetClickupPrefs } from "../lib/clickupPrefs.ts";
import { __forgetClickupSpaces } from "../lib/clickupSpaces.ts";
import { ClickUpPane, CardSkillsRow } from "./ClickUpPane.tsx";
import { JiraPane } from "./JiraPane.tsx";
import { __forgetClickupSetup, clickupSetup } from "../lib/clickupSetup.ts";
import { forgetCards } from "../lib/prCardStore.ts";
import { checkedLine } from "../lib/providerFreshness.ts";
import { fmtAgo, minutesAgo } from "../lib/format.ts";
import type { ActionRecord, GateRecord, UnderstudyClassRow, UnderstudyFrame } from "../../../shared/types.ts";
import { mergeActivity, gateLine, actorLabel, activityDays, filterActivity, type ActivityFilter, type ActivityRow, type ActivityRun } from "../lib/activity.ts";
import { useStableFlow } from "./useStableFlow.ts";
import { Ticks } from "./Ticks.tsx";
import { ingestUpdate, isUpdateAvailable } from "../lib/updateStore.ts";
import { ReleaseNotesModal } from "./ReleaseNotesModal.tsx";
import { installedNotes, type NotesTarget } from "../lib/whatsNew.ts";
import { autostartEnabled, setAutostart, isFullscreen, toggleFullscreen, IS_DESKTOP, IS_MAC_DESKTOP, HAS_BROWSER } from "../lib/desktop.ts";
import { overlayOpen } from "../lib/overlays.ts";
import { Select } from "./Select.tsx";
import { GateCard, NewChatsCard, WorkerRolesCard } from "./agents/AgentsCards.tsx";
import { WORKER_ROLES } from "../../../shared/workerRoles.ts";
import { ALARM_VOICES, NOTIFY_VOICES, findVoice, playVoice, type Voice } from "../lib/sounds.ts";
import { alarmVoiceId, setAlarmVoice } from "../lib/alarm.ts";
import { SEARCH_ENGINE_LABELS, type SearchEngine } from "../lib/browserUrl.ts";
import { homePageRaw, setHomePage, searchEngine, importHistory, setImportHistory, importBookmarks, setImportBookmarks, pickImportRows } from "../lib/browserPrefs.ts";
import { RemoteAccessPane } from "./RemoteAccessPane.tsx";
import { NOTIFY_KINDS, NOTIFY_CHANNELS, NOTIFY_KIND_LABEL, NOTIFY_CHANNEL_LABEL, type NotifyKind, type NotifyChannel } from "../../../shared/notifyPrefs.ts";
import { getNotifyPrefs, subscribeNotifyPrefs, saveNotifyPrefs } from "../lib/notifyPrefsStore.ts";
import { PluginsPane } from "./PluginsPane.tsx";
import { TerminalIcon, DiffIcon, BrowserIcon, UnderstudyIcon, LanternIcon, DashIcon } from "./workspace/icons.tsx";
import {
  SlidersIcon, ThemeIcon, BellIcon, SidebarIcon, KeyboardIcon, BudgetIcon, PulseIcon,
  CommandIcon, ReviewIcon, QuoteIcon, PanesIcon, PlugIcon, ServerIcon, PhoneIcon,
  PuzzleIcon, ShieldIcon, InfoIcon, ChecklistIcon, DownloadIcon, ColumnsIcon, ChipIcon, DiamondIcon, FlowIcon, LayersIcon } from "./settingsNavIcons.tsx";
import { resolvePane, openSettings, paneWhenClickupKnown } from "../lib/openSettings.ts";
import { SettingsNav } from "./SettingsNav.tsx";
import { SettingsSearchPanel } from "./SettingsSearchPanel.tsx";
import { SettingsPageHeader } from "./SettingsPageHeader.tsx";
import { SettingsToc } from "./SettingsToc.tsx";
import { NO_FACTS, NO_MARK, groupByName, groupSearch, headerChips, hueVar, connectionsNeeding, navMarks, withNeeds, withProblems, type HeaderChip, type MatchIn, type NavFacts, type PageNeed, type PageProblem } from "../lib/settingsNav.ts";
import { applyProblem, SAVED_MS } from "../lib/settingsStates.ts";
import { PageState, useReportHead, useReportProblem, useReportSaving, useSavePhase, type PageHead, type PageStateSink } from "./SettingsPageState.tsx";
import { RunningPanes } from "./RunningPanes.tsx";
import { THEMES } from "../lib/highlight.ts";
import { BudgetsPane } from "./BudgetsPane.tsx";
import { EnginesPane } from "./engines/EnginesPane.tsx";
import { OrchestrationPane } from "./orchestration/OrchestrationPane.tsx";
import { rendererPref, setRendererPref, type RendererPref } from "../lib/termRenderer.ts";
import { TERM_FONTS, CURSORS, fontAvailable, currentTermFont, currentTermSize, currentTermCursor, currentTermLineHeight, setTermFont, setTermSize, setTermCursor, setTermLineHeight, SIZE_MIN, SIZE_MAX, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_SIZE, DEFAULT_LINE_HEIGHT, type CursorStyle } from "../lib/termPrefs.ts";
import { focusFollowsMouse, setFocusFollowsMouse } from "../lib/termFocusPref.ts";
import { parseRules, setTabGroupsOn, tabGroupRulesText, tabGroupsOn } from "../lib/tabGroups.ts";
import { paneActionsMode, setPaneActionsMode, type PaneActionsMode } from "../lib/paneActionsPref.ts";
import { diffThemePref, setDiffThemePref, diffSplit, diffWrap, setDiffSplit, setDiffWrap, DEFAULT_SPLIT, DEFAULT_WRAP } from "../lib/diffPrefs.ts";
import {
  TASK_SOURCES, taskSourceShown, shownTaskSources,
  orderedTaskSources, moveTaskSource, resetTaskSourceOrder, type TaskSourceId,
} from "../lib/taskSources.ts";
import { taskLanding, type TaskLanding } from "../lib/taskLanding.ts";
import {
  SCROLLBACK_SIZES, DEFAULT_SCROLLBACK, DEFAULT_WORD_SEPARATORS,
  currentScrollback, currentWordSeparators, copyOnSelect, rightClickPaste, currentNoteEditor, NOTE_EDITORS, type NoteEditor,
  setScrollback, setCopyOnSelect, setRightClickPaste,
} from "../lib/termPrefs.ts";
import { fmtScale, DEFAULT_SCALE, SCALES } from "../lib/uiScale.ts";
import { currentAccent, setAccentPref } from "../lib/accent.ts";
import { applyTheme } from "../lib/themes.ts";
import { setting, subscribeSettings } from "../lib/settingsRegistry.ts";
import { DISK_WARN_CHOICES, DISK_WARN_DEFAULT, diskWarnPct } from "../lib/diskWarnPref.ts";
import { autoCheckUpdates } from "../lib/updateCheckPref.ts";
import { LICENCES } from "../lib/licences.gen.ts";
import { humanBytes } from "../lib/paletteModel.ts";
import { MOD_KEY } from "../lib/format.ts";
import { externalUrl } from "../lib/externalUrl.ts";
import type { UpdateStatus, ReleaseNotes, HookSetupStatus, BrowserUseStatus, LogDigest } from "../../../shared/types.ts";
import {
  sysNotifyMode, setSysNotifyMode, setSysNotifyOn, subscribeSysNotifyMode,
  notifyVoiceId, setNotifyVoice,
  notifyCapability, notifyQuiet, subscribeNotifyQuiet,
  appNotify, subscribeAppNotify,
  type SysNotifyMode, type NotifyCapability,
} from "../lib/sysNotify.ts";
import { chatEnginePref, setChatEnginePref, type ChatEnginePref } from "../lib/chatEnginePref.ts";
import type { TmuxEngineInfo } from "../../../shared/types.ts";
import type { DepReport, DepStatus } from "../../../shared/deps.ts";
import { clock24, setClock24 } from "../lib/clockPref.ts";
import { setSplashOn, splashOn } from "../lib/splashPref.ts";
import { usageRefreshOn, setUsageRefreshOn } from "../lib/usageRefreshPref.ts";
import { paceConfig, setPaceConfig, subscribePaceConfig } from "../lib/paceConfig.ts";
import { PACE_MIN_MINUTES, type PaceConfig } from "../../../shared/pace.ts";
import { longWindowUsed, providerUsage, subscribeProviderUsage } from "../lib/usageStore.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { bindings, resetBindings, subscribeBindings, isCustomised, LABELS, DEFAULTS, type ActionId,
         chordFor, hasCustomChord, rebindChord, clearChord, resetChords, chordsCustomised, chordFromEvent, chordLabel,
         appChordFor, hasCustomAppChord, rebindAppChord, resetAppChords, appChordsCustomised,
         APP_CHORD_LABELS, APP_CHORD_DEFAULTS, keyRowName, type AppChordId } from "../lib/keybindings.ts";
import {
  loadRail, subscribeRail, moveView, resetRail, railIds, railCustomised, SHIPPED_RAIL, VIEWS, RAIL_PLACES,
  type RailPlace, type ViewId,
} from "./workspace/views.ts";
import { AppearancePane } from "./ThemePicker.tsx";
import { ShellConsole } from "./ShellConsole.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { keyringRow, credentialsWhere, moveFailed, type KeyringState } from "../lib/keyringRow.ts";
import "./settingsSplit.css";
import "./orchestration/orchestration.css";
import "./settingsGroupB.css";
import { HIT, ICON } from "../lib/iconSize.ts";
import { AgentIcon, CheckboxIcon, ClockIcon, CrossIcon, DiskIcon, EditIcon, IconLabel, LinkIcon, PlusIcon, RefreshIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { ciOnlyApproved } from "../lib/ciNotifyPref.ts";
import { reviewGateOn, setReviewGate } from "../lib/reviewGatePref.ts";
import { AskedAlertLog } from "./AskedAlertLog.tsx";
import { talkNotify, type TalkNotify } from "../lib/talkNotify.ts";
import { RETENTION, setUnderstudyEnabled, useUnderstudy } from "./understudy/UnderstudyPanel.tsx";
import { Appearance } from "./understudy/Appearance.tsx";
import { Teach } from "./understudy/Teach.tsx";
import { Persona } from "./understudy/persona/Persona.tsx";
import { setCosmetic, useCosmetic } from "./understudy/persona/cosmeticStore.ts";
import { emitControl } from "../lib/controlBus.ts";
import { refreshUnderstudy } from "../lib/understudyStore.ts";
import { mutedSources, setMuted, sourceLabel, subscribeMuted } from "../lib/notePolicy.ts";
import { MuteGlyph } from "./TopBarNotes.tsx";
import { Button, RefreshButton, INPUT, INPUT_STYLE, EDGE, LINE, Segmented } from "./workspace/Chrome.tsx";
import { LAUNCH_MODES, LAUNCH_MODE_LABEL, isLaunchMode, parseDenyRules, type LaunchMode } from "../../../shared/launchModes.ts";
import { setLaunchPermissions } from "../lib/launchMode.ts";
import { CheckRow, Disclosure, DownloadButton, SELECT_BOX, SegControl, EmptyState, Field, LinkButton, ProblemNote, SaveBar, SaveChip, SettingsCard, SettingsForm, StatusBadge, helpIdFor, type StatusTone } from "./SettingsKit.tsx";
import { PreviewCard, WithPreview } from "./settings/PreviewCard.tsx";
import { WindowPreview, SidebarPreview, DiffPreview, LanternPreview, BrowserPreview, LiveTabs, type LiveView } from "./settings/previews/index.ts";
import { railItems } from "./settings/previews/MiniApp.tsx";
import { restoredNote } from "../lib/restoredNote.ts";
import { cardIdIn } from "../../../shared/cardRef.ts";
import { pageChips, setPageFact, usePageFacts } from "../lib/pageFacts.ts";
import { COUNTED_VIEWS, railBadgeOn, railBadgesCustomised, railBadgesKey, resetRailBadges, subscribeRailBadges } from "../lib/railBadges.ts";

/** A heading inside a Section, for a pane that answers the same question about
 *  two different sources. Without it "Quiet" and "Alert sounds" sit in one flat
 *  list and you have to read every hint to work out which switch is about your
 *  machine and which is about this app. */
function Group({ children }: { children: React.ReactNode }) {
  // `agx-settings-group-heading` is what index.css hides a group by, when a
  // search has filtered away every row between it and the next one (or the
  // end of the section) — see the CSS comment there for why a sibling
  // selector, not a wrapping container, is what answers it here.
  return (
    <div className="agx-settings-group-heading px-3 pt-2.5 pb-0.5">
      <span className="text-[10px] t-dim2 uppercase tracking-wider">{children}</span>
    </div>
  );
}

/**
 * One row, for every setting in this dialog.
 *
 * There were seven copies of `w-full flex items-center gap-6 px-3.5 py-3` —
 * Toggle, Choice, Stepper, Row, KeyRow and two hand-rolled ones in the browser
 * pane, which had already drifted apart (items-start against items-center) and
 * disagreed about whether the label had a measure at all. That drift is what
 * "cada panel parece de otro programa" was describing: the controls of one
 * pane sat 288px further right than the next, because only some of them capped
 * their text.
 *
 * The layout is a GRID, not flexbox, and that is the fix for the churro.
 * `flex-1` + `shrink-0` with no justify-content parks the control right after
 * the words and leaves every pixel of slack at the END of the line — measured,
 * 286px of it, with the divider running the full width straight past it. Two
 * fixed tracks put every control in the same column instead, and the leftover
 * becomes a page margin outside the container rather than a hole inside it.
 *
 * Polymorphic because a Toggle's row IS the `<button role="switch">` — the
 * whole row is the hit target and the switch's own semantics live on it — so
 * this has to be able to render as a button, a link or a plain div without the
 * caller reaching around it.
 */
/* ────────────────────────────── The setup card ──────────────────────────────
 *
 * For the pages that are not settings at all but a job with an order to it:
 * wiring Claude Code, letting an agent drive the browser. Those were prose
 * with a button at the end, and prose hides two things a checklist shows for
 * free — how many steps there are, and which one you are on.
 *
 * A step whose state we cannot read is `null` rather than false. Claiming a
 * step is undone when the truth is that we cannot tell is worse than saying
 * so: it puts a permanent red mark on a card that can never be completed. Those
 * steps say "your turn" and stay out of the count.
 */
interface SetupStep {
  title: string;
  detail?: React.ReactNode;
  /** true done, false not yet, null "we cannot see this from here". */
  done: boolean | null;
  /** The badge's words: "Done" and "To do" unless a step has better ones. A
   *  step that is not yet done is the person's turn (warning) unless it says
   *  `off`: not open, not installed, nothing to be alarmed by. */
  says?: { done?: string; todo?: string; todoTone?: "warn" | "off" };
  /** Secondary detail under the description, named for what it holds. */
  more?: { summary: string; body: React.ReactNode };
  action?: { label: string; onClick: () => void; busy?: boolean; tone?: "primary" | "danger" };
}

/** A path with the home folder written as ~, which is also how it reads in the docs. */
const tilde = (p: string) => p.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, "~");

/**
 * A checklist as one card: a row per step, its verdict as a badge, the button
 * that fixes that step beside the badge, and "N of M done" at the head. Rows
 * that are not steps (a notice, a way back) go in as children.
 */
function SetupCard({ title, desc, steps, note, error, actions, children, icon, chip }: {
  title: string; desc?: React.ReactNode; steps: SetupStep[]; note?: string | null; error?: string | null;
  actions?: React.ReactNode; children?: React.ReactNode; icon?: React.ReactNode;
  /** The card's verdict in its own words, in place of "N of M done" (the Agents page says "Wired"). */
  chip?: React.ReactNode;
}) {
  const known = steps.filter((s) => s.done !== null);
  const done = known.filter((s) => s.done).length;
  const all = known.length > 0 && done === known.length;
  return (
    <SettingsCard title={title} desc={desc} actions={actions} icon={icon}
      status={chip ?? <StatusBadge tone={all ? "ok" : "off"}>{done} of {known.length} done</StatusBadge>}>
      {steps.map((st) => (
        <SettingRow key={st.title} label={st.title} hint={st.detail} detail={st.more}
          status={st.done === true
            ? <StatusBadge tone="ok">{st.says?.done ?? "Done"}</StatusBadge>
            : st.done === false
              ? <StatusBadge tone={st.says?.todoTone ?? "warn"}>{st.says?.todo ?? "To do"}</StatusBadge>
              : <StatusBadge tone="off">Your step</StatusBadge>}
          actions={st.action
            ? <Button tone={st.action.tone} pending={st.action.busy} onClick={st.action.onClick}>{st.action.label}</Button>
            : undefined} />
      ))}
      {children}
      {(error || note) && (
        <div role={error ? "alert" : "status"} className="agx-settings-x pt-2 pb-3 text-[12px]"
          style={{ color: error ? "var(--error-ink)" : "var(--text2)" }}>
          {error || note}
        </div>
      )}
    </SettingsCard>
  );
}

/**
 * One task source: whether it is on the bar, and where on it.
 *
 * Not a `Toggle`, and the reason is structural rather than cosmetic. `Toggle`
 * makes the WHOLE ROW the button, which is right for a lone switch and makes a
 * second control impossible: the arrows would be buttons inside a button, which
 * is invalid HTML and behaves differently in every browser that has to guess.
 * So this row is a plain div carrying three controls of its own, and the
 * trade — losing the click-anywhere target — buys a keyboard-operable reorder.
 */
const SOURCE_SHORT: Record<TaskSourceId, string> = {
  github: "Issues from the repository you are in.",
  local: "Your own list, from Taskwarrior.",
  clickup: "The boards you work from, and cards assigned to you.",
  jira: "Open cards assigned to you.",
};
function SourceRow({ id, i, n, onChanged, state }: {
  id: TaskSourceId; i: number; n: number; onChanged: () => void;
  /** The source's own connection, where the app can tell: ClickUp and Jira only. */
  state?: "connected" | "off";
}) {
  const s = TASK_SOURCES.find((x) => x.id === id);
  if (!s) return null;
  const on = taskSourceShown(id);
  return (
    <SettingRow settingId={`tasks.source.${id}`} label={s.label} hint={SOURCE_SHORT[id]}
      control={
        <span className="flex items-center gap-2.5 justify-self-end">
          {state && <StatusBadge tone={state === "connected" ? "ok" : "off"}>{state === "connected" ? "Connected" : "Not connected"}</StatusBadge>}
          <span className="flex shrink-0 gap-1">
            {([-1, 1] as const).map((by) => (
              <Button key={by} size="compact" square
                onClick={() => { moveTaskSource(id, by); onChanged(); }}
                disabled={by === -1 ? i === 0 : i === n - 1}
                label={`Move ${s.label} ${by === -1 ? "earlier" : "later"}`}>
                {by === -1 ? "↑" : "↓"}
              </Button>
            ))}
          </span>
          <button role="switch" aria-checked={on} aria-label={s.label}
            onClick={() => { setting(`tasks.source.${id}`).set(!on); onChanged(); }}
            className="agx-btn">
            <Switch on={on} />
          </button>
        </span>
      } />
  );
}

/** A row of mutually exclusive choices, for a preference with three answers
 *  rather than two. A toggle would have forced "show me their message" and
 *  "just tell me someone wrote" to be the same decision. */
function Choice<T extends string>({ label, hint, detail, value, options, onPick, disabled, disabledHint, modified, settingId, wide, select }: {
  /** Longer words behind a "Details" link; the hint stays one line. */
  detail?: RowDetail;
  /** See SettingRow. */
  settingId?: string; agentExempt?: boolean; agentNever?: string;
  label: string; hint: string; value: T; options: { v: T; label: string }[];
  onPick: (v: T) => void; disabled?: boolean; disabledHint?: string; modified?: boolean;
  /** Under the words in a narrow card even when the labels are short: a long hint beside two options squeezes them into a stack. */
  wide?: boolean;
  /** A kit select instead of a segmented set: for a ladder too long to read as buttons (six wake floors). */
  select?: boolean;
}) {
  return (
    <SettingRow label={label} hint={disabled ? disabledHint ?? hint : hint} detail={detail} disabled={disabled} modified={modified} settingId={settingId}
      wide={wide ?? choiceIsWide(options.map((o) => o.label))}
      control={select
        ? <Select value={value} onChange={(v) => onPick(v as T)} disabled={disabled} title={label} options={options.map((o) => ({ value: o.v, label: o.label }))} />
        : <SegControl label={label} value={value} options={options} onPick={onPick} disabled={disabled} />
      } />
  );
}

/** A −/value/+ stepper. A slider would imply the value is continuous and let
 *  you drag the window into a size the cockpit grid can't lay out; the ladder
 *  is short and every rung is one that works, so buttons say more. */
function Stepper({ label, hint, detail, value, onDec, onInc, canDec, canInc, modified, settingId }: {
  /** Longer words behind a "Details" link; the hint stays one line. */
  detail?: RowDetail;
  /** See SettingRow. */
  settingId?: string; agentExempt?: boolean; agentNever?: string;
  label: string; hint: string; value: string; onDec: () => void; onInc: () => void; canDec: boolean; canInc: boolean;
  modified?: boolean;
}) {
  const btn = "w-7 h-7 rounded-md text-[14px] leading-none flex items-center justify-center disabled:opacity-30 enabled:hover:bg-white/10";
  const border = EDGE;
  return (
    <SettingRow label={label} hint={hint} detail={detail} modified={modified} settingId={settingId}
      control={
        <span className="flex items-center gap-1 justify-self-end">
          <button onClick={onDec} disabled={!canDec} className={btn} style={{ border, color: "var(--text2)" }} aria-label="Smaller">−</button>
          {/* Tabular width so stepping 100% → 125% doesn't shuffle the buttons. */}
          <span className="text-[12px] tabular-nums text-center w-[42px]" style={{ color: "var(--text)" }}>{value}</span>
          <button onClick={onInc} disabled={!canInc} className={btn} style={{ border, color: "var(--text2)" }} aria-label="Bigger">+</button>
        </span>
      } />
  );
}

/** The window's display size control: the four common rungs as one segmented choice,
 *  the other six in "Other", so every rung of lib/uiScale.ts stays reachable. */
const SCALE_QUICK = [0.9, 1, 1.1, 1.25];
function ScaleControl({ scale, onZoom }: { scale: number; onZoom: (dir: 1 | -1 | 0) => void }) {
  // The zoom API only nudges one rung at a time; walking to a rung is repeated nudges.
  const goTo = (v: number) => {
    const d = SCALES.indexOf(v) - SCALES.indexOf(scale);
    for (let n = 0; n < Math.abs(d); n++) onZoom(d > 0 ? 1 : -1);
  };
  const quick = SCALE_QUICK.includes(scale);
  return (
    <span className="flex items-center gap-2 flex-wrap justify-start">
      <SegControl label="Display size" value={quick ? String(scale) : undefined}
        options={SCALE_QUICK.map((v) => ({ v: String(v), label: fmtScale(v) }))}
        onPick={(v) => goTo(Number(v))} />
      <select aria-label="Other display size" className={INPUT} style={INPUT_STYLE} value={quick ? "" : String(scale)}
        onChange={(e) => e.target.value && goTo(Number(e.target.value))}>
        <option value="" disabled>Other…</option>
        {SCALES.filter((v) => !SCALE_QUICK.includes(v)).map((v) => <option key={v} value={String(v)}>{fmtScale(v)}</option>)}
      </select>
    </span>
  );
}

/** A badge, not a checkbox: "Done" when the state is already true, a hollow
 *  "Not yet" otherwise, nothing to press either way. Clicking the row still
 *  takes you to where it's fixed. */
function OnboardingMark({ done }: { done: boolean }) {
  return done
    ? <StatusBadge tone="ok">Done</StatusBadge>
    : <StatusBadge tone="off">Not yet</StatusBadge>;
}

function Row({ label, hint, kbd, href, download, onClick }: { label: string; hint: string; kbd?: string; href?: string; download?: string; onClick?: () => void }) {
  return (
    <SettingRow label={label} hint={hint} href={href} download={download} onClick={href ? undefined : onClick}
      control={kbd ? <kbd className="chip text-[11px] t-dim justify-self-end">{kbd}</kbd> : undefined} />
  );
}

type Pane = "recipes" | "review-prompts" | "saved-replies" | "appearance" | "prefs" | "terminal" | "diff" | "tasks" | "privacy" | "notifications" | "browser" | "rail" | "keys" | "lantern" | "log" | "budgets" | "hooks" | "connections" | "engines" | "orchestration" | "clickup" | "jira" | "tmux" | "remote" | "plugins" | "understudy" | "about" | "onboarding"
  /** A plugin's own settings page, one per plugin that declares any. */
  | `plugin:${string}`;
/** "" is a page that is in no group and so not in the nav (see LINK_ONLY).
 *
 *  "Get started" is never in TAB_GROUPS below, on purpose: it is not a ring,
 *  it is a row that answers whether the other rings have anything left to
 *  set up, and a ring with one member that vanishes the moment you finish it
 *  is not a ring. Keeping its own tab entry (for the page title and search)
 *  while leaving it out of the render order lets it live pinned above every
 *  ring instead of filed into one — see the pinned button before the group
 *  loop, which is the only place this literal is read. */
type TabGroup = "General" | "Workspace" | "Agents" | "Library" | "Connections" | "System" | "Get started" | "";
// The nav's groups in drawing order. lib/settingsNav.ts is what draws them
// (NAV_GROUPS, then System pinned) and settings-nav-groups.test.ts holds the
// two lists equal; a group with no page is dropped there.
/*
 * Six groups, each named for the object its pages configure.
 *
 * General is the app window and how it talks to you (startup, look,
 * notifications, sidebar, shortcuts). Workspace is where work happens
 * (terminal, diff, browser, tasks). Agents is the agents themselves and what
 * they spend. Library is text you author and reuse. Connections is what the
 * app reaches out to. System is what it runs on and what it keeps.
 *
 * The old four rings put a view filter (Tasks), a money policy (Budgets), a
 * log and five download links in one drawer called "Your data". A group
 * defined by what its members are NOT ("More", "Tools", "Data") has low
 * information scent; a pane is filed under the OBJECT it configures, never
 * under how often it is opened. Placements whose reason is written beside
 * them in TABS below stay with that reason.
 *
 * Six headers over 22 pages: no group holds a single page, so none is a rule
 * that separates nothing.
 */
/** How long the first Escape stays armed. Long enough to be a second press
 *  rather than a double-tap, short enough that nobody arms it, walks away, and
 *  loses the page to an unrelated keystroke. */
const ESC_CONFIRM_MS = 2200;
const TAB_GROUPS: TabGroup[] = ["General", "Workspace", "Agents", "Library", "Connections", "System"];
/** Pages that are not in the nav on purpose and are reached by a link: the
 *  palette's "Activity log" and a row on Data & privacy, both openSettings("log").
 *  A page reachable by link, still rendered by Settings when it is the pane.
 *  Ceiling: it is a page inside Settings, not a view of its own; a standalone
 *  view is the next step and is not here. */
const LINK_ONLY: Pane[] = ["log"];
// `kw` are the words the search box also matches — the things people call a
// setting that aren't in its label ("keyboard" for Shortcuts, "theme" for
// Appearance), so the box finds a page by what it does, not just its name.
const LAST_PANE_KEY = "agentglass.settings.pane";

/*
 * How well one page answers a query used to be `tabScore`, right here: two
 * tiers, a page's title and its `kw` bag, because `kw` was the only place a
 * row's own words lived and there was no cheaper way to ask "does this page
 * have a row for that". `kw` bags still exist — pageScore still reads them —
 * but the per-row index in settingsRows.gen.ts (generated from the pages
 * themselves, not hand-kept) means a page's ROWS can be scored directly
 * instead of through a bag of words somebody copied out of them. See
 * pageScore in settingsIndex.ts, and settings-search-ranks-matches.test.ts /
 * settings-search-lands-on-a-page.test.ts for what moved with it.
 */

/**
 * One line per page, above whatever it holds.
 *
 * Sections say what a group of rows is; nothing said what the PAGE was. On a
 * list of twenty that is the difference between reading the title and knowing
 * whether you are in the right place — and it is where a page can be honest
 * about its own scope ("only terminals", "paths, not contents") without
 * repeating it in every hint underneath.
 */
/**
 * `status: true` marks a page that reports what is already happening —
 * a scorecard, a log, a "is it ready" check — rather than a page you set.
 * Measured, not renamed: Understudy, Activity and Tools & services are
 * each described by their OWN `what` line above as something that watches
 * or reports, and they render today as the exact same button as
 * Appearance or Shortcuts, which is a switch. The ring each page is filed
 * under (Agents, System, Connections) is right — it says WHAT
 * object the page is about, and that stays; this only says HOW the page
 * behaves once you're on it, which the ring was never meant to answer.
 * Plugins and Remote are not marked: they already carry their own live
 * signal (the badge below, and Plugins' own state dot on its page), and
 * a second, static mark next to a page that already has a real one would
 * be the decorative kind he deletes.
 */
/** Pages with a reset that is always drawn (greyed until something moved), where the mockup has one. */
const ALWAYS_RESET: ReadonlySet<string> = new Set(["prefs", "appearance", "rail"]);
/** The page header's reset button, where it is not "Reset page". */
const RESET_WORD: Record<string, string> = { rail: "Reset rail" };
/** Pages short enough to read whole: they have no "on this page" index. */
const NO_TOC: ReadonlySet<string> = new Set(["prefs", "appearance", "rail", "connections"]);

const TABS: { id: Pane; label: string; group: TabGroup; kw: string; what?: string; status?: boolean; icon: (p: { size?: number }) => React.ReactElement }[] = [
  // "sound" removed: it named the Notifications rows, not anything on this
  // page, and once pageScore reads a page's own rows a stray word in `kw`
  // only wins ties it should lose — "notification sound" now reaches
  // Notifications on the strength of its OWN rows, so Window does not need
  // to keep claiming a word it has nothing behind.
  { id: "prefs", label: "Window & startup", group: "General", kw: "display size zoom clock fullscreen start login launch animation splash preferences", what: "How big the window is and what it does when the machine boots.", icon: SlidersIcon },
  { id: "appearance", label: "Appearance", group: "General", kw: "theme accent colour color dark light mode palette density compact roomy translucent transparent blur reduce motion animation", what: "How the window looks. Every change shows on the right as you make it.", icon: ThemeIcon },
  { id: "notifications", label: "Notifications", group: "General", kw: "notifications sound alert desktop notify quiet chime ping alert sounds message mirror this machine approved reminder alarm somebody says collect without interrupting only when pull request something much them agentglass keep what stopped interrupts muted mute unmute lantern silence none all", what: "What may interrupt you, how loudly, and what became of the ones you asked for.", icon: BellIcon },
  // Next to Shortcuts on purpose: which drawer a view sits in is what decides
  // whether it has a number, so the two pages answer one question between them.
  { id: "rail", label: "Sidebar", group: "General", kw: "rail sidebar views order icons hide show reorder tabs drawer group arrange", what: "Which views get an icon on the rail, and whether they sit at the top or the bottom of it.", icon: SidebarIcon },
  { id: "keys", label: "Shortcuts", group: "General", kw: "keyboard keys bindings shortcut chord rebind reset to defaults columns some others", what: "Every key and chord, by where it works. Rebind one and the app warns before it takes a key twice.", icon: KeyboardIcon },
  { id: "terminal", label: "Terminal", group: "Workspace", kw: "terminal launch permissions permission mode ask auto accept edits bypass yolo deny disallowed tools font size cursor typography monospace face renderer gpu focus follows mouse hover pane sloppy scrollback copy on select right-click paste line height tab tabs group groups grouping project name rules prefix runs on engine own tmux shell", what: "How terminals draw, what pointing does, and what an agent may do the moment a terminal launches it.", icon: TerminalIcon },
  /* Its own page, not a block inside Tools & services: it is the engine
     every pane and every chat runs on, with a binary, a config and a restore of
     its own — three settings deep is not a row in a list of "is it installed".
     Filed beside Terminal, the view that runs on it. */
  { id: "tmux", label: "Pane engine", group: "Workspace", kw: "tmux panes engine pane prefix key binary bundled config override restore reboot layout resume socket status bar chat warm cli claude", what: "The engine under every terminal tab: which tmux, how it is configured, and what survives a reboot.", icon: PanesIcon },
  { id: "diff", label: "Diff", group: "Workspace", kw: "diff split side by side inline unified wrap word wrap changes review default view wrap long lines syntax theme colours", what: "The view you land on, and what happens to a long line.", icon: DiffIcon },
  // Only where there is a browser to configure. A settings tab for something
  // that is not there reads as a broken feature rather than one that doesn't apply.
  // ONE browser page.
  //
  // This was two — "Browser" for the home page and "Agent browser" for
  // everything else, including the login importer. Nobody looking for their
  // logins looks under a heading about agents, and the browser's own menu sent
  // people to the wrong one of the two because I picked the obvious name. A
  // setting is filed under the thing it configures.
  ...(HAS_BROWSER ? [{ id: "browser" as const, label: "Browser", group: "Workspace" as const, kw: "browser web page zoom login cookies import chrome firefox zen profile home search engine", what: "Where the built-in browser starts, and how to bring in the logins you already have.", icon: BrowserIcon }] : []),
  { id: "tasks", label: "Tasks", group: "Workspace", kw: "tasks sources github issues local taskwarrior clickup hide show providers view opens on", what: "Where the Tasks view starts, which trackers feed it, and how a branch finds its card.", icon: ChecklistIcon },
  { id: "hooks", label: "Agents", group: "Agents", kw: "agents hooks claude code install setup worker roles scout builder reviewer verifier lock model gate who answers nobody answers starts in permission mode deny rules opencode qwen how new chats run warm panes browser agent skill drive", what: "Wire Claude Code into the app, decide how new chats run, and which CLI each worker role uses.", icon: PlugIcon },
  { id: "engines", label: "Agent engines", group: "Agents", kw: "engine engines provider hermes opencode codex gemini antigravity claude model version minimum signed in sign-in login orchestrator worker role ready test recheck installed update reporting connect events", what: "Every agent CLI on this machine, what it can do inside agentglass, and what is left to wire.", icon: ChipIcon },
  { id: "orchestration", label: "Orchestration", group: "Agents", kw: "orchestration orchestrator main agent chair policy rule rules worker workers scout builder verifier engine model fallback chain ask when it runs usage weekly 5h plan hours budget ceiling envelope network commit write limits retries minutes per turn project override", what: "Which engine runs a project's main agent and does its work, the rules that change that for a while, and what a worker may do.", icon: FlowIcon },
  { id: "lantern", label: "Lantern", group: "Agents", kw: "lantern reminder status what doing needs you ask sessions working on interval orchestrator seat wake floor chair post", what: "What the Lantern may ask of a session, and how often it looks.", icon: LanternIcon },
  /* Filed beside Agents rather than under System, and the two readings are
     both defensible: it is a store of what you did, and it is a thing that
     watches agents work. It is here because the question people arrive with is
     "what is that face in the rail", and the face is about the work. */
  { id: "understudy", label: "Knowledge", group: "Agents", kw: "knowledge clone learn sources teach precedents decisions bank recall exclusions never see private terms consent portrait persona art look how it looks scorecard watch score", what: "Where the orchestrator learns how you decide — what it may read, what it must never see, and the face it wears.", status: true, icon: UnderstudyIcon },
  { id: "budgets", label: "Usage & budgets", group: "Agents", kw: "usage pace plan budget spend cost limit money threshold codex usage current quota github api rate limit search remaining", what: "Budgets, plan pace, the Codex usage refresh and the GitHub API budget.", icon: BudgetIcon },
  { id: "recipes", label: "Commands", group: "Library", kw: "commands recipes custom script make run shortcut alias task saved own", what: "Commands you keep, with the parts that change asked for when you run them.", icon: CommandIcon },
  /* Filed under the work rather than under the pull-request panel: these are
     prompts an agent is given, and the panel is only where the button happens
     to be. */
  { id: "review-prompts", label: "Review prompts", group: "Library", kw: "review prompts pr pull request claude menu skill re-review reviewer wording edit", what: "What Review with Claude offers, and the words it sends.", icon: ReviewIcon },
  { id: "saved-replies", label: "Saved replies", group: "Library", kw: "saved replies canned comment pr pull request review wording snippet template", what: "The sentences you write over and over on other people's pull requests.", icon: QuoteIcon },
  /* Filed with what you keep and reuse, last in Library: a plugin is
     someone else's code holding a scoped credential to this server — install,
     review what it declares, grant it, take it back. It is not an agent and it
     renders nothing of its own; see the note at the top of server/src/plugins.ts. */
  { id: "plugins", label: "Plugins", group: "Library", kw: "plugins install extension manifest scope review approve enable disable remove entrypoint publisher source running pid re-consent reconsent", what: "Add-ons that read what the app knows. Nothing runs until you have read what it declares and switched it on.", icon: PuzzleIcon },
  /*
   * One page for everything outside this app.
   *
   * They were two — "is this tool installed" and "is this service connected" —
   * and the split is real: a binary is fixed with a package manager, a token
   * with a paste. But nobody arrives here knowing which of those two their
   * problem is. They arrive because a panel is empty, and the question is
   * "what is missing", which had two pages and no single answer.
   *
   * They stay separate INSIDE the page, under their own headings, because the
   * fix paths do not resemble each other for a second.
   */
  /* Named for its contents, not for its drawer: "Connections" inside a group
   called Connections is a heading repeating itself, which is the same noise as
   a heading over one item. */
  { id: "connections", label: "Tools & services", group: "Connections", kw: "requirements dependencies deps tmux git docker install integrations providers connect github gitlab clickup taskwarrior token api credentials account rate limit budget quota", what: "The tools and services this app leans on, and whether they are ready.", status: true, icon: ServerIcon },
  /* Only while ClickUp is connected (see `tabs` in the modal): before that there is no
     workspace for a status to mean anything in, and a page for it would be a dead end. */
  { id: "clickup", label: "ClickUp", group: "Connections", kw: "clickup workflow map steps statuses cards tracker hand off qa review menu merge dialog note assigned people sprint swatch spaces subtasks pull request link", what: "How agentglass uses your ClickUp: the steps you add, tied to your own statuses.", icon: LayersIcon },
  /* Always there, unlike ClickUp's: the form that connects Jira lives on this page. */
  { id: "jira", label: "Jira", group: "Connections", kw: "jira atlassian cloud data center site token email personal access token writes changes projects keys prefixes hand off qa assignee status saved views folders board filter tracker connect disconnect", what: "Your Jira site, what agentglass may change there, and the steps a pull request can run on a card.", icon: DiamondIcon },
  { id: "remote", label: "Remote", group: "Connections", kw: "remote access pair phone tailscale token device", what: "Reach this machine from your phone.", icon: PhoneIcon },
  { id: "privacy", label: "Data & privacy", group: "System", kw: "export download data json csv daily totals markdown events skills catalog take out privacy telemetry data local storage retention database credentials tokens tracking analytics who sees", what: "Where your data is, what leaves this machine, and how to take it out.", icon: ShieldIcon },
  { id: "about", label: "About", group: "System", kw: "about version update release notes changelog credit attribution licence license portrait art", what: "Version, release notes, updates and the third-party licences this build carries.", icon: InfoIcon },
  { id: "log", label: "Activity", group: "", kw: "activity log history events feed", what: "What the app itself has been doing.", status: true, icon: PulseIcon },
  /* Three things, not the eight a checklist usually lists, because three is
     what the app can actually tell without asking you to swear to it: an
     agent wired in, a provider connected, and the pane engine on PATH are
     each one read away (a settings file, a token, a binary). Whether you
     have opened a project, run a chat, or read the docs are not — those are
     either true the moment the app can run at all, or true only if you say
     so, and a step nobody can fail is not a step. Eight-minus-three lies
     would have been worse than three honest ones. */
  { id: "onboarding", label: "Get started", group: "Get started", kw: "get started setup onboarding checklist new agent provider pane engine wired connected ready", what: "Three things this app can tell are done — nothing here to check off yourself.", icon: ChecklistIcon },
];

/**
 * The browser view's two settings.
 *
 * Two, and not the eight a browser's settings screen usually carries, because
 * the other six would be controls for things that do not exist yet — profiles,
 * cookie import, link routing, agent driving. A toggle that saves a preference
 * nothing reads is worse than an absent one: it reports a feature as present
 * and broken instead of absent.
 *
 * State lives in localStorage rather than here, and is read back on mount, so
 * this pane and the view cannot disagree about what was chosen.
 */
function BrowserPane({ children }: { children?: React.ReactNode }) {
  const [home, setHome] = useState(homePageRaw);
  // What the view opens on is the saved address, not the draft in the box.
  const [savedHome, setSavedHome] = useState(homePageRaw);
  const [engine, setEngine] = useState<SearchEngine>(searchEngine);
  // An agent's change to the engine lands while this page may be up.
  useEffect(() => subscribeSettings((c) => { if (c.by !== "row" && c.id === "browser.searchEngine") setEngine(searchEngine()); }), []);
  const [bad, setBad] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = () => {
    const stored = setHomePage(home);
    if (stored === null) { setBad(true); setSaved(false); return; }
    // Show what was actually stored: typing `example.com` and having the box
    // keep saying `example.com` while the browser goes to `https://example.com/`
    // is a small lie about what was saved.
    setHome(homePageRaw());
    setSavedHome(homePageRaw());
    setBad(false);
    setSaved(true);
  };

  return (
    <WithPreview preview={<PreviewCard id="browser" title="New tab"><BrowserPreview home={savedHome} searchEngine={SEARCH_ENGINE_LABELS[engine]} /></PreviewCard>}>
    <SettingsCard title="Where it opens" icon={<BrowserIcon size={ICON.sm} />}>
      <SettingRow
        agentNever="a page the browser opens by itself, with the owner's signed-in sessions: not something an agent points elsewhere"
        label="Home page"
        hint="Where the view opens, and where Home goes. Leave it empty for a blank page."
        below={<>
          <div className="flex items-center gap-2">
            <input
              value={home}
              onChange={(e) => { setHome(e.target.value); setBad(false); setSaved(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
              placeholder="https://duckduckgo.com"
              spellCheck={false}
              aria-label="Home page"
              aria-invalid={bad || undefined}
              className={`min-w-0 flex-1 ${INPUT}`}
              style={{
                ...INPUT_STYLE,
                ...(bad ? { border: "1px solid color-mix(in srgb, var(--error) 60%, transparent)" } : {}),
              }}
            />
            <Button onClick={save}>{saved ? "Saved" : "Save"}</Button>
          </div>
          {bad && (
            <div className="mt-1 text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>
              That is not an address this will open — it takes http(s), or nothing at all.
            </div>
          )}
        </>}
      />

      <SettingRow
        settingId="browser.searchEngine" label="Search engine"
        hint="Used when what you type in the address bar is words rather than an address."
        control={<span className="flex justify-end"><Select
          value={engine}
          options={(Object.keys(SEARCH_ENGINE_LABELS) as SearchEngine[]).map((id) => ({ value: id, label: SEARCH_ENGINE_LABELS[id] }))}
          onChange={(v) => { setting("browser.searchEngine").set(v); setEngine(v as SearchEngine); }}
          align="right"
        /></span>}
      />
    </SettingsCard>
    {children}
    </WithPreview>
  );
}

const PLACE_LABEL: Record<RailPlace, string> = { work: "Top of the rail", utility: "Bottom of the rail", hidden: "Not on the rail" };
/** The counts the preview wears while a view's count badge is on: invented, one to a view. */
const DEMO_COUNT: Record<string, number> = { chat: 2, lantern: 1, tasks: 3 };

/**
 * The rail's layout: the views in their three places, and the one picked.
 *
 * The rail itself is the fast way to do this — pick an icon up and drop it where
 * you want it — but a drag is a poor way to say "and this one I never want to
 * see again", it is unavailable to anyone not using a mouse, and it cannot show
 * the thing that changes when a view moves between groups: its number. So the
 * same three places, spelled out as lists on the left (drag a row, or pick one),
 * and on the right what is true of the picked view: shown or not, top or bottom,
 * whether it wears a count, and the key it answers to — beside the rail itself,
 * drawn on one of the app's own screens.
 */
function RailPane() {
  const rail = useSyncExternalStore(subscribeRail, loadRail, () => SHIPPED_RAIL);
  useSyncExternalStore(subscribeRailBadges, railBadgesKey, railBadgesKey);
  const keys = useSyncExternalStore(subscribeBindings, bindings, bindings);
  /** Which view is being dragged. Held here rather than per row: a drop target has to know what is coming. */
  const [drag, setDrag] = useState<{ id: ViewId; from: RailPlace } | null>(null);
  // The picked view: its controls are on the right and the picture draws it as the active one.
  const [pick, setPick] = useState<ViewId | null>(null);
  const [liveView, setLiveView] = useState<LiveView>("lantern");
  // Where a view goes back to when "Shown on the rail" is turned on again.
  const lastPlace = useRef(new Map<ViewId, RailPlace>());
  const placeOf = (id: ViewId): RailPlace => RAIL_PLACES.find((p) => rail[p].some((x) => x.id === id)) ?? "hidden";
  const first = rail.work[0] ?? rail.utility[0] ?? rail.hidden[0];
  const v = VIEWS.find((x) => x.id === (pick ?? first?.id));
  const move = (id: ViewId, place: RailPlace, to: number) => { setPick(id); moveView(id, place, to); };
  const items = railItems(rail).map((i) => (railBadgeOn(i.id as ViewId) && DEMO_COUNT[i.id] && i.id in COUNTED_VIEWS ? { ...i, badge: true, count: DEMO_COUNT[i.id] } : i));

  const detail = v && (() => {
    const place = placeOf(v.id);
    const list = rail[place];
    const at = list.findIndex((x) => x.id === v.id);
    const key = keys[`view.${v.id}`];
    return (
      <SettingsCard title={v.label} icon={<v.icon size={ICON.sm} />}
        status={<StatusBadge tone={place === "hidden" ? "off" : "ok"}>{place === "hidden" ? "Not on the rail" : "On the rail"}</StatusBadge>}
        actions={<span className="flex items-center gap-1.5">
          <Button size="compact" disabled={place === "hidden" || at <= 0} onClick={() => move(v.id, place, at - 1)}>Move up</Button>
          <Button size="compact" disabled={place === "hidden" || at < 0 || at >= list.length - 1} onClick={() => move(v.id, place, at + 1)}>Move down</Button>
        </span>}>
        <SettingRow
          agentExempt label="Shown on the rail" hint={v.hint}
          control={<button role="switch" aria-checked={place !== "hidden"} aria-label="Shown on the rail" className="agx-btn"
            onClick={() => {
              if (place !== "hidden") { lastPlace.current.set(v.id, place); setPick(v.id); setting(`rail.place.${v.id}`).set("hidden"); }
              else { setPick(v.id); setting(`rail.place.${v.id}`).set(lastPlace.current.get(v.id) ?? (RAIL_PLACES.find((p) => SHIPPED_RAIL[p].some((x) => x.id === v.id)) ?? "work")); }
            }}><Switch on={place !== "hidden"} /></button>} />
        <Choice<"work" | "utility">
          settingId={`rail.place.${v.id}`} label="Sits at"
          hint="Top is where you work and the numbers count; bottom is what you go and look at."
          disabled={place === "hidden"} disabledHint="Not on the rail: turn Shown on the rail on first."
          value={place === "utility" ? "utility" : "work"}
          onPick={(p) => { setPick(v.id); setting(`rail.place.${v.id}`).set(p); }}
          options={[{ v: "work", label: "Top" }, { v: "utility", label: "Bottom" }]} />
        {v.id in COUNTED_VIEWS && (
          <Toggle settingId={`rail.badge.${v.id}`} label="Count badge" hint={COUNTED_VIEWS[v.id as keyof typeof COUNTED_VIEWS]!}
            on={railBadgeOn(v.id)} onClick={() => { setPick(v.id); setting(`rail.badge.${v.id}`).set(!railBadgeOn(v.id)); }} />
        )}
        <SettingRow agentExempt label="Shortcut"
          hint={<>Change this shortcut on the Shortcuts page. <a href="#keys" className="agx-textlink"
            onClick={(e) => { e.preventDefault(); openSettings("keys", rowId(keyRowName(`view.${v.id}`))); }}>Open Shortcuts</a></>}
          control={<span className="agx-keycaps"><kbd>{key === " " ? "space" : key}</kbd></span>} />
        <div className="agx-settings-x pt-3 pb-3" data-preview-slot="rail">
          <div className="text-[12px] font-semibold mb-2" style={{ color: "var(--text)" }}>How the rail looks now</div>
          <div className="mb-2"><LiveTabs view={liveView} onView={setLiveView} /></div>
          <SidebarPreview items={items} selected={v.id} view={liveView} />
        </div>
        <div className="agx-settings-x pb-3 text-[12px]" style={{ color: "var(--text3)" }}>Saved as you go: the rail follows at once.</div>
      </SettingsCard>
    );
  })();

  return (
    <WithPreview preview={detail}>
      {(Object.keys(PLACE_LABEL) as RailPlace[]).map((place) => (
        <SettingsCard key={place} title={PLACE_LABEL[place]} status={<span className="t-dim text-[11px] tabular-nums">{rail[place].length}</span>}>
          {rail[place].length === 0 ? (
            <div onDragOver={(e) => { if (drag) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (drag) { move(drag.id, place, 0); setDrag(null); } }}>
              <EmptyState>{place === "hidden" ? "Nothing put away." : "Drop a view here."}</EmptyState>
            </div>
          ) : rail[place].map((x, i) => {
            const Icon = x.icon;
            const k = keys[`view.${x.id}`];
            const on = x.id === v?.id;
            return (
              /*
               * Drag to reorder, click to pick. The drag handlers ride on the row itself
               * (`rowProps`), not on a div around it: a wrapper takes the row out of the
               * card body and its divider with it.
               */
              <SettingRow key={x.id} agentExempt
                rowProps={{
                  draggable: true, tabIndex: 0, "aria-current": on || undefined,
                  onClick: () => setPick(x.id),
                  onKeyDown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); setPick(x.id); } },
                  onDragStart: (e) => { setDrag({ id: x.id, from: place }); e.dataTransfer.effectAllowed = "move"; },
                  onDragEnd: () => setDrag(null),
                  onDragOver: (e) => { if (drag && drag.id !== x.id) e.preventDefault(); },
                  onDrop: (e) => {
                    e.preventDefault();
                    if (!drag || drag.id === x.id) return;
                    // Dropped ONTO a row means "take its place", the only reading that needs no insertion line to explain it.
                    move(drag.id, place, i);
                    setDrag(null);
                  },
                  style: { opacity: drag?.id === x.id ? 0.4 : 1, cursor: "grab", ...(on ? { background: "color-mix(in srgb, var(--primary) 9%, transparent)", boxShadow: "inset 3px 0 0 var(--primary)" } : null) },
                }}
                label={<span className="flex items-center gap-2.5 min-w-0">
                  <span className="shrink-0 select-none" style={{ color: "var(--text4)" }} aria-hidden title="Drag to reorder">⠿</span>
                  <span className="shrink-0 grid place-items-center w-5" style={{ color: "var(--text2)" }}><Icon size={ICON.md} /></span>
                  <span className="min-w-0">{x.label}</span>
                </span>}
                control={<span className="flex items-center gap-2.5 justify-self-end">
                  <span className="agx-keycaps" title={`${x.label} answers to ${k} on the dashboard`}><kbd>{k === " " ? "space" : k}</kbd></span>
                  <span aria-label={place === "hidden" ? "Not on the rail" : "On the rail"} className="shrink-0 rounded-full"
                    style={{ width: 7, height: 7, ...(place === "hidden" ? { boxShadow: "inset 0 0 0 1px var(--text4)" } : { background: "var(--success)" }) }} />
                </span>} />
            );
          })}
        </SettingsCard>
      ))}
    </WithPreview>
  );
}

/**
 * A group of settings.
 *
 * The rows used to sit on the dialog with nothing between them, which is how a
 * page of twenty settings became forty lines of text that ran into each other.
 * What separates them now is a RULE, and only a rule.
 *
 * The first attempt gave each group a tinted, bordered card. It read as a box
 * on a box wherever the content was already made of boxes — the palette picker,
 * the budget rows, anything with a list in it — and a page of nested containers
 * with two borders between the eye and the text looks amateur however carefully
 * the tones are chosen. A hairline does the whole job: it says where a row ends
 * without adding a surface, and it disappears the moment you are not looking
 * for it, which is what a divider is for.
 *
 * The title is optional, because a page whose only group repeats the page name
 * says "Terminal" twice before the first setting.
 */
/** Panes whose content is a grid or a map of its own: one column of the page, at this width. */
const WIDE_PANES = new Map<string, string>([
  /* The workflow map is a column of step cards beside a column of statuses, with the lines running between them; 1100px is the width that keeps a card's header on two lines. The cap is higher so a wide window can put the other cards in two columns (.wfm in settingsGroupB.css), the map keeping the whole row. */
  ["clickup", "1900px"],
  /* The same map, so the same width: narrower, the statuses fall under the steps and no line is drawn to them. */
  ["jira", "1900px"],
]);

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The hours a plan's weekly budget is spread over. See shared/pace.ts. */
const DAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];
const HOUR_OPTS = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k).map((h) => ({ value: String(h), label: h >= 24 ? "24:00" : `${String(h).padStart(2, "0")}:00` }));

/** The week as the budget sees it: one bar per day, as tall as that day's share of the week.
 *  Today is outlined. A day that earns nothing is a flat line. */
function WeekBars({ cfg }: { cfg: PaceConfig }) {
  const hours = (i: number) => (cfg.spread === "all" ? 24 : cfg.workDays[i] ? Math.max(0, cfg.workEnd - cfg.workStart) : 0);
  const week = [0, 1, 2, 3, 4, 5, 6].map(hours);
  // All ticked-off is "every hour counts" (see PaceLines), so the bars say the same.
  const none = week.every((h) => h === 0);
  const hs = none ? week.map(() => 24) : week;
  const top = Math.max(...hs, 1);
  const today = (new Date().getDay() + 6) % 7;
  return (
    <div className="agx-weekbars" role="img" aria-label={`Share of the week's budget by day: ${hs.map((h, i) => `${DAY_NAMES[i]} ${Math.round((h / (hs.reduce((a, b) => a + b, 0) || 1)) * 100)}%`).join(", ")}`}>
      {hs.map((h, i) => (
        <span key={i} className="agx-weekbar" data-today={i === today ? "" : undefined} data-off={h === 0 ? "" : undefined}>
          <i style={{ height: h === 0 ? 3 : Math.max(8, Math.round((h / top) * 52)) }} />
          <b>{DAY_INITIALS[i]}</b>
        </span>
      ))}
    </div>
  );
}

function PacePane() {
  const cfg = useSyncExternalStore(subscribePaceConfig, paceConfig, paceConfig);
  const working = cfg.spread === "working";
  const week = useWeeklyUsage();
  useReportHead("budgets", week ? { chips: [{ tone: week.used >= cfg.alertAt ? "warn" : "ok", text: `Weekly ${Math.round(week.used)} %` }] } : null);
  return (
    <SettingsCard title="Plan pace" icon={<BudgetIcon size={ICON.sm} />}
      desc="Spreads the week's budget over the days you work, so “runs out Thursday” means something."
      status={week ? <StatusBadge tone={week.used >= cfg.alertAt ? "warn" : "ok"}>{Math.round(week.used)} % of the week</StatusBadge> : undefined}>
      <div className="agx-weekbars-wrap"><WeekBars cfg={cfg} /></div>
      <Choice<PaceConfig["spread"]>
        label="Spread the week's budget over"
        hint="Working hours earn the budget; every hour is a straight line."
        detail={{ summary: "Details", body: <>Working hours earn the budget, so the pace marker holds still overnight and at weekends. Every hour is a straight line across the week.</> }}
        value={cfg.spread}
        onPick={(spread) => setPaceConfig({ spread })}
        options={[{ v: "working", label: "Working hours" }, { v: "all", label: "Every hour" }]} />
      <SettingRow label="Working days" disabled={!working}
        hint={working && !cfg.workDays.some(Boolean) ? "None ticked: every hour counts, as if Every hour were chosen." : "Days that earn budget."}
        control={
          <span className="agx-daychips" role="group" aria-label="Working days">
            {DAY_NAMES.map((d, i) => (
              <button key={d} type="button" disabled={!working} aria-pressed={cfg.workDays[i]} aria-label={d} title={d}
                onClick={() => setPaceConfig({ workDays: cfg.workDays.map((x, j) => (j === i ? !x : x)) })}
                className="agx-daychip disabled:cursor-not-allowed">
                {DAY_INITIALS[i]}
              </button>
            ))}
          </span>
        } />
      <SettingRow label="Work starts" hint="Hour the day begins earning budget." disabled={!working}
        control={<Select value={String(cfg.workStart)} disabled={!working} title="Work starts" options={HOUR_OPTS(0, cfg.workEnd - 1)} onChange={(v) => setPaceConfig({ workStart: Number(v) })} />} />
      <SettingRow label="Work ends" hint="Hour it stops." disabled={!working}
        control={<Select value={String(cfg.workEnd)} disabled={!working} title="Work ends" options={HOUR_OPTS(cfg.workStart + 1, 24)} onChange={(v) => setPaceConfig({ workEnd: Number(v) })} />} />
      <Toggle on={cfg.rollover} onClick={() => setPaceConfig({ rollover: !cfg.rollover })}
        label="Roll unused share forward"
        hint="A quiet Monday leaves more for Tuesday."
        detail={{ summary: "Details", body: <>Room left over from earlier today may be spent later, up to one extra day's share. Off, a day's share is a hard cap.</> }} />
      <Choice<"1" | "3" | "6"> select wide={false}
        label="Recent burn looks back"
        hint="How far back the runs-out projection measures your speed."
        value={String(cfg.burnWindowHours) as "1" | "3" | "6"}
        onPick={(v) => setPaceConfig({ burnWindowHours: Number(v) })}
        options={[{ v: "1", label: "1 hour" }, { v: "3", label: "3 hours" }, { v: "6", label: "6 hours" }]} />
      <Choice<"80" | "90" | "95"> select wide={false}
        label="Alert when a weekly window reaches"
        hint="One notification per window."
        detail={{ summary: "Details", body: <>Only while Usage is on under Notifications (off by default).</> }}
        value={String(cfg.alertAt) as "80" | "90" | "95"}
        onPick={(v) => setPaceConfig({ alertAt: Number(v) })}
        options={[{ v: "80", label: "80 %" }, { v: "90", label: "90 %" }, { v: "95", label: "95 %" }]} />
    </SettingsCard>
  );
}

/** The busiest long window of the plan, as a percent: what the page header says ("Weekly 82 %"). */
function useWeeklyUsage(): { used: number } | null {
  const rows = useSyncExternalStore(subscribeProviderUsage, providerUsage, providerUsage);
  const used = longWindowUsed(rows, PACE_MIN_MINUTES);
  return used === null ? null : { used };
}

/**
 * "Page › Section" — the label above each page's own content while more
 * than one page is showing at once (a search result), so a card of rows
 * with no page title of its own (most of them; the single-page title below
 * only ever names ONE page) does not read as belonging to whichever page
 * happens to be above it. Absent outside search: the single big title
 * already says which page you are on, and a second one under it would
 * repeat it for no reason.
 */
function PageMatchHeading({ id, onOpen }: { id: Pane; onOpen: () => void }) {
  const t = TABS.find((x) => x.id === id);
  if (!t) return null;
  return (
    <button onClick={onOpen}
      className="w-full text-left pt-6 pb-2 px-1 text-[13px] font-semibold uppercase tracking-[0.08em] agx-hover"
      style={{ color: "var(--text3)" }}>
      {t.label}
    </button>
  );
}

/** `headerControl` is a card's master switch, right-aligned in its heading.
 *  Nothing on this slice has a natural spot for one; the notifications page
 *  is the first user. */
function Section({ title, desc, headerControl, children }: {
  title?: string; desc?: string; headerControl?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    /* FLAT ON PURPOSE — a heading and a rows box, siblings.
     *
     * The card, the corner clipping and the gap to the next group are all
     * drawn by `.agx-settings-col .agx-settings-section` in index.css, and
     * that is the whole point: half the settings pages never call this
     * component and build the same two boxes by hand. A card that lived here
     * reached the pages that imported it and left the rest flat, which is how
     * this ended up half-redesigned.
     *
     * agx-settings-section also hides itself when a search has filtered every
     * row inside it away — a heading over nothing reads as a group whose
     * contents failed to load. */
    <div className="agx-settings-section">
      {title && (
        <div className="agx-settings-head flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="agx-settings-head-t">{title}</div>
            {desc && <div className="agx-settings-head-d">{desc}</div>}
          </div>
          {headerControl !== undefined && <div className="shrink-0">{headerControl}</div>}
        </div>
      )}
      <div className="agx-settings-rows">{children}</div>
    </div>
  );
}

/** The chip alone gave no sign that it records: an explicit verb beside it. The
 *  chip stays a target too. A row with two chips (a view with its chord) has
 *  no room for a third control, so it keeps labelled chips only. */
/** A key or chord as keycaps: `Ctrl+Alt+T` draws as Ctrl + Alt + T, one cap each. The whole group is the
 *  button that starts recording, so a click anywhere on it does what Rebind does. */
function KeyCaps({ text, active, custom, faint, onClick, title }: {
  text: string; active?: boolean; custom?: boolean; faint?: boolean; onClick: () => void; title?: string;
}) {
  // A held combination reads as caps joined by "+"; a lone key (or the arrows) is one cap.
  const parts = active || text === "—" || text.length < 2 || !/\w\+./.test(text) ? [text] : text.split("+");
  return (
    <button type="button" onClick={onClick} title={title} aria-label={active ? text : `Recorded: ${text}. Click to record another`}
      className="agx-keycaps" data-active={active ? "" : undefined} data-custom={custom ? "" : undefined} data-faint={faint ? "" : undefined}>
      {parts.map((k, i) => (
        <Fragment key={i}>{i > 0 && <span className="agx-keycaps-plus" aria-hidden>+</span>}<kbd>{k}</kbd></Fragment>
      ))}
    </button>
  );
}

function RebindButton({ capturing, onClick, what }: { capturing: boolean; onClick: () => void; what: string }) {
  return <Button size="compact" onClick={onClick} aria-label={`${capturing ? "Cancel rebinding" : "Rebind"} ${what}`}>{capturing ? "Cancel" : "Rebind"}</Button>;
}

/**
 * Version, and the update that goes with it.
 *
 * Deliberately shows what would arrive before offering to take it: this button
 * builds and runs whatever is on the branch, and "3 commits behind" with the
 * subjects listed is the difference between an informed click and a leap. When
 * it cannot run — a dirty checkout, a diverged branch — it says which, because
 * "update unavailable" sends people looking in the wrong place.
 */
/**
 * What has been done through this cockpit.
 *
 * The dashboard makes real changes — it discards, force-pushes, merges pull
 * requests, removes containers, answers the gate an agent is stopped at — and
 * every one of those was recorded only in a ring buffer that says of itself it
 * is a live view of the session rather than an audit trail. So "who approved
 * that" and "what happened to my branch while I was at lunch" had no answer.
 *
 * Who did it is now a name when there is an honest one. A paired phone carries
 * its own credential and the label somebody accepted when they paired it, so
 * "iPhone · 3f9c21 approved that" is a fact, not an invention — the id comes
 * along because an unnamed device defaults to "A device" and two of those must
 * not read as one. The machine token is still shared and still anonymous, so
 * anything holding it is a place: `local` for this machine's dashboard, and the
 * address for anything else.
 *
 * Two records feed this list, not one. The action log holds what a person asked
 * for; the gates table holds the fate of every held tool call, including the
 * ones a timeout or a restart resolved while nobody was looking. Those changed
 * what an agent did and appear in no action row, because nobody made a request
 * for them — and an outcome nobody chose is the one least likely to be
 * remembered and most worth writing down. See lib/activity.ts for the merge.
 */
function ActivityPane({ open }: { open: boolean }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    // Both records, because neither is the whole story: the action log has only
    // what a person asked for, and a gate the timeout allowed is something that
    // happened without anybody asking. See lib/activity.ts.
    Promise.all([
      api.actions(200).then((r) => r.actions).catch(() => [] as ActionRecord[]),
      // A rule writes a row for every call its allow list waves through, so
      // those are read on their own: in one list of 200 they pushed out the
      // gates nobody decided, which are what this pane exists to show.
      api.gateHistory(200, { ruleAllows: false }).then((r) => r.gates).catch(() => [] as GateRecord[]),
      api.gateHistory(50).then((r) => r.gates).catch(() => [] as GateRecord[]),
    ]).then(([a, g, recent]) => {
      if (!alive) return;
      const seen = new Set(g.map((x) => x.id));
      setRows(mergeActivity(a, [...g, ...recent.filter((x) => !seen.has(x.id))]));
    });
    return () => { alive = false; };
  }, [open]);

  if (!rows) return (
    <SettingsCard title="What this app has done">
      <SettingRow label="Loading…" status={<StatusBadge tone="checking">Checking</StatusBadge>} />
    </SettingsCard>
  );
  if (!rows.length) {
    return (
      <SettingsCard title="What this app has done">
        <SettingRow label="Nothing yet" hint="Every write this dashboard makes is recorded here as it happens."
          detail={{ summary: "What counts as a write", body: "Staging, discarding, pushing, merging, container actions and gate decisions." }} />
      </SettingsCard>
    );
  }

  return (
    <>
      {/* The paragraph that stood here is a row of its own. As a first line of
          the list it read as the first entry in the log — prose at the top of
          a list of events, on the same ground and the same rhythm as them. */}
      <SettingsCard title="What this app has done">
        <SettingRow label="Newest first, kept indefinitely"
          hint="The changes you made, not telemetry."
          detail={{ summary: "What is listed", body: <>Held tool calls appear here whoever resolved them, including the ones the timeout decided while nobody was looking.</> }}
          control={<Segmented label="Show" value={filter} onChange={setFilter}
            options={[{ id: "all", label: "All" }, { id: "orchestration", label: "Orchestration", title: "Only what an orchestrator or the policy did" }]} />} />
      </SettingsCard>
      {/*
        RUNS, not one line each.
       *
        Measured on his own log: twenty-three consecutive lines reading
        "pending review pull request <repo> #375" with "2d" beside every one
        of them. Polling a pull request writes one row per poll, which is
        correct as a record and useless as a page — the reader's question is
        "what happened", and the answer was buried under the same sentence
        printed twenty-three times.
       *
        Consecutive and identical only. Two runs of the same action with
        something else between them stay two runs, because the thing between
        them is the fact that makes the sequence worth reading. And a failure
        never folds into a success: a run collapsed on its words alone would
        hide the one poll out of twenty that came back an error, which is the
        only line on that screen anybody needs.
      */}
      {/* A CARD PER DAY, and the age comes off the rows in it. Every line was
          carrying its own "2d", which on a screen where twenty lines in a row
          share a day is the same word printed twenty times and no answer at
          all to "when was this". Said once, as the card's title, it becomes
          the thing it was trying to be. */}
      {filter === "orchestration" && !filterActivity(rows, filter).length && (
        <SettingsCard title="Orchestration">
          <SettingRow label="Nothing from an orchestrator or the policy yet"
            hint="What a chair does through the app, and when a rule turns on or off, is listed here." />
        </SettingsCard>
      )}
      {activityDays(filterActivity(rows, filter)).map(({ day, runs }) => (
        <SettingsCard key={day} title={day}>
          {runs.map((run) => (
            run.kind === "gate"
              ? <GateLine key={run.key} g={run.row} />
              : <ActionLine key={run.key} a={run.row} times={run.times} />
          ))}
        </SettingsCard>
      ))}
    </>
  );
}

/** The right-hand column: who, then how long ago. Shared so a gate line and a
 *  git line cannot drift into two different ways of saying the same thing. */
function Who({ actor, at }: { actor: string; at: number }) {
  return (
    /* The clock time, not the age. The day is said once above the group, so
       the useful thing on the row is where in that day it fell — and "2d"
       repeated down a column answered a question nobody was asking twice. */
    <span className="text-[11.5px] t-dim tabular-nums whitespace-nowrap"
      title={new Date(at).toLocaleString()}>
      {actor && `${actor} · `}{new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

/**
 * Fold a run of identical neighbours into one row with a count.
 *
 * The key is the WORDS the row would draw plus whether it succeeded, which is
 * exactly the thing the reader would see repeated. Gates never fold: each one
 * is a decision somebody (or the timeout) made about a specific call, so two
 * of them are two facts even when they read the same.
 */
function ActionLine({ a, times = 1 }: { a: ActionRecord; times?: number }) {
  return (
    <SettingRow
      label={<>
        {verb(a.action)}
        {a.target && <span className="t-dim"> {a.target}</span>}
        {times > 1 && <span className="t-dim tabular-nums" title={`${times} of these in a row, newest first`}> ×{times}</span>}
      </>}
      status={a.ok ? undefined : <StatusBadge tone="err">Failed</StatusBadge>}
      hint={!a.ok && a.detail ? <span style={{ color: "var(--error-ink)" }}>{a.detail}</span> : undefined}
      control={<Who actor={actorLabel({ kind: "action", at: a.at, key: "", row: a })} at={a.at} />}
    />
  );
}

/**
 * A held tool call and how it ended.
 *
 * The dot is amber for an outcome nobody chose. "approved" for a call somebody
 * read and "allowed" for one that expired while they were at lunch are opposite
 * facts about whether anybody looked, and in a list of past tense verbs they
 * are one glance apart — so the distinction gets a colour as well as a word.
 */
function GateLine({ g }: { g: GateRecord }) {
  const { verb: did, note } = gateLine(g);
  const nobody = g.resolution !== "human";
  return (
    <SettingRow
      label={<>
        {did}
        <span className="t-dim"> {g.tool_name}{g.summary ? ` · ${g.summary}` : ""}</span>
      </>}
      status={nobody
        ? <StatusBadge tone="warn">{g.resolution === "rule" ? "A gate rule decided" : "Nobody decided"}</StatusBadge>
        : g.decision === "deny" ? <StatusBadge tone="err">Denied</StatusBadge>
        : undefined}
      hint={(note || (g.resolution === "human" && g.reason)) ? <>
        {note && <span className="block" style={{ color: "var(--warning-ink)" }}>{note}</span>}
        {/* The reason a person typed, which lives nowhere else: the agent was
            given it and the action log never carried it. */}
        {g.resolution === "human" && g.reason && (
          <span className="block">“{g.reason}”</span>
        )}
      </> : undefined}
      control={<Who actor={actorLabel({ kind: "gate", at: g.decided_at ?? 0, key: "", row: g })} at={g.decided_at ?? 0} />}
    />
  );
}

/**
 * `/git/branch-delete` reads as a route. "deleted branch" reads as something a
 * person did, which is what a log is for — and past tense, because every line
 * here is already over.
 *
 * Named where naming helps and derived where it does not, so a route added
 * later still produces a readable line instead of nothing.
 */
const VERBS: Record<string, string> = {
  "/gate/allow": "approved", "/gate/deny": "denied",
  "/git/stage": "staged", "/git/unstage": "unstaged",
  "/git/stage-all": "staged everything", "/git/unstage-all": "unstaged everything",
  "/git/discard": "discarded", "/git/commit-staged": "committed",
  "/git/push": "pushed", "/git/pull": "pulled", "/git/fetch": "fetched",
  "/git/checkout": "checked out", "/git/branch-create": "created branch",
  "/git/branch-delete": "deleted branch", "/git/branch-rename": "renamed branch",
  "/git/merge": "merged", "/git/rebase": "rebased", "/git/reset": "reset",
  "/git/stash-push": "stashed", "/git/stash-apply": "applied stash",
  "/git/stash-pop": "popped stash", "/git/stash-drop": "dropped stash",
  "/git/stash-rename": "renamed stash", "/git/stash-to-branch": "branched from stash",
  "/git/stash-partial": "stashed files", "/git/stash-apply-overwrite": "applied stash over",
  "/git/bisect-start": "started a bisect", "/git/bisect-mark": "marked a bisect step", "/git/bisect-reset": "reset the bisect",
  "/git/tag-create": "created tag", "/git/tag-delete": "deleted tag", "/git/tag-push": "pushed tag", "/git/tag-delete-remote": "deleted remote tag",
  "/git/apply-hunk": "staged a hunk", "/git/undo-merge": "undid the merge",
  "/git/worktree-add": "added worktree", "/git/worktree-remove": "removed worktree",
  "/docker/start": "started container", "/docker/stop": "stopped container",
  "/docker/restart": "restarted container", "/docker/rm": "removed container",
  "/prs/merge": "merged pull request", "/prs/close": "closed pull request",
  "/prs/unstick-close": "closed (unstick) pull request", "/prs/unstick-reopen": "reopened (unstick) pull request",
  "/prs/review": "reviewed", "/prs/comment": "commented on",
  "/prs/rerun": "re-ran the checks on", "/prs/draft": "changed draft state of",
  "/chat/send": "started a chat in",
};

function verb(action: string): string {
  const known = VERBS[action];
  if (known) return known;
  const [, family, ...rest] = action.split("/");
  const what = rest.join("/").replace(/-/g, " ");
  if (family === "docker") return `${what} container`;
  if (family === "prs") return `${what} pull request`;
  return what || action;
}

/**
 * The understudy's own page: the master switch, and what it keeps and for how
 * long.
 *
 * Small on purpose. Everything that is a JUDGEMENT — which class stands where,
 * what is in the way of it, what it may never do — is in the view, because it
 * needs the scorecard beside it to mean anything. What is left here is what a
 * settings page is for: the one switch and the facts about storage.
 *
 * The art credit that used to live here moved to the About page — it is a
 * licence obligation, not an understudy setting, and it was only filed here
 * because that is where the portrait art was built. NOTICE.md's pointer moved
 * with it.
 */
/** The score, by kind of decision: how often the clone would have answered as the person did. Only decisions the
 *  person typed or clicked are scored (see UnderstudyClassRow.n), and a kind with none is said once, not drawn. */
function ScoreCard({ frame }: { frame: UnderstudyFrame | null }) {
  const scored = (frame?.classes ?? []).filter((c) => c.n > 0).sort((x, y) => y.n - x.n);
  const idle = (frame?.classes.length ?? 0) - scored.length;
  const total = scored.reduce((n, c) => n + c.n, 0);
  const tone = (raw: number) => (raw >= 0.85 ? "var(--success)" : raw >= 0.5 ? "var(--warning)" : "var(--error)");
  return (
    <SettingsCard title="The score" icon={<BudgetIcon size={ICON.sm} />}
      desc="How often the clone would have answered like you, by kind of decision."
      status={frame?.agreement != null ? <StatusBadge tone="info">{Math.round(frame.agreement)} % agreed</StatusBadge> : <StatusBadge tone="off">Nothing scored yet</StatusBadge>}>
      {scored.map((c) => (
        <SettingRow key={c.id} agentExempt label={c.label} hint={`${c.n} decision${c.n === 1 ? "" : "s"}`}
          control={
            <span className="agx-score" role="img" aria-label={`${Math.round(c.raw * 100)} % of ${c.n}`}>
              <span className="agx-btable-track" style={{ flexBasis: 150 }}><span style={{ width: `${Math.round(c.raw * 100)}%`, background: tone(c.raw) }} /></span>
              <b className="tabular-nums">{Math.round(c.raw * 100)} %</b>
            </span>
          } />
      ))}
      <SettingRow agentExempt label={scored.length ? "Decisions recorded" : "Nothing scored yet"}
        hint={scored.length ? `${idle} other kind${idle === 1 ? " has" : "s have"} no decision yet.` : "Only a decision you typed or clicked is scored: an agent tolerating something is not you agreeing with it."}
        control={scored.length ? <span className="tabular-nums text-[15px] font-semibold">{total.toLocaleString()}</span> : undefined} />
    </SettingsCard>
  );
}

function UnderstudyPane({ open, onLeave }: { open: boolean; onLeave: () => void }) {
  const frame = useUnderstudy();
  const [err, setErr] = useState<string | null>(null);
  const [lookOpen, setLookOpen] = useState(false);

  // The switch has to show the server's answer, not this dialog's guess: it is
  // refused outright when the server has no auth token (there would be no
  // principal to hold the understudy to its allowlist), and a toggle that
  // flipped anyway would be lying about the only thing it says.
  useEffect(() => { if (open) void refreshUnderstudy(); }, [open]);

  const on = !!frame?.enabled;
  useReportHead("understudy", frame ? { chips: [frame.halted ? { tone: "warn", text: "Halted" } : on ? { tone: "ok", text: "On" } : { tone: "off", text: "Off · score kept" }] } : null);
  return (
    <>
      {/* The switch and what it keeps are one card: the second is what the
          first costs, and it was a card of its own below the portrait pickers. */}
      <SettingsCard title="Keeping score" icon={<UnderstudyIcon size={ICON.sm} />}
        desc="A clone learns how you decide and scores itself against your real answers."
        status={<StatusBadge tone={frame?.halted ? "warn" : on ? "ok" : "off"}>{frame?.halted ? "Halted" : on ? "On" : "Off"}</StatusBadge>}>
        <Toggle
          label="Let the clone watch"
          hint={frame?.halted
            ? "Halted — it is enabled and stopped. Switching it on again is what lowers the fence; there is no timer."
            : "Off: nothing new is recorded; the score below is kept."}
          detail={{ summary: "What it records", body: <>Separate from the knowledge below, and off is a reasonable answer: this writes down what a stand-in would have done and scores it against what you did. Reading the bank does not depend on it — the orchestrator remembers you either way.</> }}
          on={on}
          onClick={() => {
            void setUnderstudyEnabled(!on).then((r) => {
              setErr(r.ok ? null : r.error ?? "that did not work");
              void refreshUnderstudy();
            });
          }} />
        {err && <div role="alert" className="agx-settings-x pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
        <SettingRow agentExempt label="What it keeps" hint="Only the decision and its context, never the code."
          detail={{ summary: "What each part keeps, and for how long", body: <>
            <b style={{ fontWeight: 600, color: "var(--text)" }}>Sealed situations, {RETENTION.snapshotDays} days.</b> The material it read, kept only long enough to check a prediction against it. Swept on a fixed window of its own, deliberately not on the events retention you set: turning that off must not silently turn this off too.{" "}
            <b style={{ fontWeight: 600, color: "var(--text)" }}>The fact of a write, {RETENTION.stubDays} days.</b> Route, method and how it answered. Never the request body: there is no column for one.{" "}
            <b style={{ fontWeight: 600, color: "var(--text)" }}>The score, kept.</b> Decisions and refusals do not expire. They are the score, and a score with holes in it is not a score.
          </> }}
          status={<StatusBadge tone="off">{RETENTION.snapshotDays} days</StatusBadge>} />
      </SettingsCard>
      <ScoreCard frame={frame} />
      {/* What it learns from lives on this page, not behind a tab in a
          scoreboard: it decides what the orchestrator knows about you. */}
      <Teach active={open} />
      {/* The look editor is nine screens of pickers: closed until asked for, and drawn OUTSIDE a card when open, because a
          card clips its corners with overflow hidden and the portrait could no longer stick (see UnderstudyLook). */}
      <SettingsCard title="How it looks" icon={<UnderstudyIcon size={ICON.sm} />} desc="The face the clone wears, here and in its own view.">
        <SettingRow agentExempt label="Customise the face" hint="Start from one of the faces, then change what is not you."
          actions={<Button aria-expanded={lookOpen} onClick={() => setLookOpen((v) => !v)}>{lookOpen ? "Hide the look editor" : "Show the look editor"}</Button>} />
      </SettingsCard>
      {lookOpen && <UnderstudyLook classes={frame?.classes ?? []} />}
    </>
  );
}

/**
 * The face, and everything that changes it.
 *
 * The portrait sticks to the top of the pane while the rows scroll under it,
 * because a picker whose result you cannot see while you use it is the one
 * thing a picker must never be — every pick in the first version meant
 * scrolling back up to find out what it did. 192px is twice the art's native
 * size, the largest exact multiple that leaves the rows room beside it.
 *
 * The rows and the portrait read the same store as the understudy view, so
 * there is no Save and nothing to apply: a pick is on both faces at once.
 */
function UnderstudyLook({ classes }: { classes: readonly UnderstudyClassRow[] }) {
  const cos = useCosmetic();
  return (
    /*
     * TWO COLUMNS, and the portrait is the one that stays.
     *
     * "I need the clone anchored, so that when I change the look I can see it
     * without scrolling up and down every time" — and he is right: the pickers
     * run to nine screens of hair, eyes, brows, nose and mouth, so with the
     * face at the top every single pick was a scroll up, a look, and a scroll
     * back down.
     *
     * It was sticky once and I took it out, because the way it was built could
     * not work: it was a child of the rows box INSIDE the card, and a card
     * clips its corners with `overflow: hidden`, which makes it a scroll
     * container that never scrolls — so the portrait stuck to a box it was
     * already inside and stopped moving at all. What it did on the way there
     * was shear the preset tiles in half against an edge with no rule and no
     * shadow.
     *
     * So the portrait comes OUT of the card. It is its own column, and the
     * thing it sticks to is the settings scroller — the one element on this
     * screen that actually scrolls. Nothing between them clips.
     */
    <div className="agx-look">
      <aside className="agx-look-portrait">
        <div className="agx-card p-3.5 flex flex-col items-center gap-3">
          <Persona px={200} cos={cos} label="The clone" />
          <div className="text-[12px] leading-relaxed" style={{ color: "var(--text3)" }}>
            What the clone wears. Start from one of the faces beside this and change what is not you;
            every pick lands here the moment you make it, and in the view.
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <Appearance value={cos} onChange={setCosmetic} classes={classes} />
      </div>
    </div>
  );
}

/**
 * What the server's own error log says. Quiet on purpose: a section you open
 * and a dot on this page's nav row, never a notification — an error the server
 * recovered from is not a person's emergency, only a thing worth knowing.
 */
/** One group of the digest as a row: the message whole (it used to fold to two
 *  lines behind a click, which hid exactly the part that says what failed),
 *  the severity as a badge, and how many times and when in the description.
 *  `overflow-wrap:anywhere` breaks only a token longer than the line, a path or
 *  an address; `break-all` cut "the network" in half. */
function LogRow({ level, count, text, when }: { level: "error" | "warn"; count: string; text: string; when: string }) {
  return (
    <SettingRow
      label={<span style={{ overflowWrap: "anywhere" }}>{text}</span>}
      status={<StatusBadge tone={level === "error" ? "err" : "warn"}>{level === "error" ? "Error" : "Warning"}</StatusBadge>}
      hint={`${count} · ${when}`} />
  );
}

function LogDigestSection({ d }: { d: LogDigest | "failed" | null }) {
  const desc = "Errors and warnings the server logged in the last 24 hours, grouped.";
  const [open, setOpen] = useState(false);
  const ago = (t: number) => minutesAgo(t);
  const note = (text: string) => <SettingRow label={text} />;
  // What the card says before it is opened: the worst thing in the last day, as a count of log lines.
  const counts = d && d !== "failed"
    ? { err: d.crashLoops.reduce((n, l) => n + l.count, 0) + d.groups.filter((g) => g.level === "error").reduce((n, g) => n + g.count, 0), warn: d.groups.filter((g) => g.level === "warn").reduce((n, g) => n + g.count, 0) }
    : { err: 0, warn: 0 };
  return (
    <SettingsCard title="Log digest" icon={<ChecklistIcon />} desc={desc} fold={{ open, onToggle: setOpen }}
      status={d && d !== "failed" ? (d.total === 0 ? <StatusBadge tone="ok">Quiet</StatusBadge> : <StatusBadge tone={counts.err ? "err" : "warn"}>{counts.err ? `${counts.err} error${counts.err === 1 ? "" : "s"}` : `${counts.warn} warning${counts.warn === 1 ? "" : "s"}`}</StatusBadge>) : undefined}>
      {d === "failed" ? note("Could not read the log digest.")
        : !d ? note("Reading…")
        : (
          <>
            {d.crashLoops.map((l) => (
              <LogRow key={`c-${l.sig}`} level="error" count={`${l.count}×`} text={`${l.example} — inside a minute`} when={ago(l.at)} />
            ))}
            {d.spikes.map((sp) => (
              <LogRow key={`s-${sp.sig}`} level="warn" count={`${sp.recent}×`} text={`${sp.example} — last hour, was ${sp.perHourBefore}/h`} when="last hour" />
            ))}
            {d.total === 0
              ? note("Nothing logged in the last 24 hours.")
              : d.groups.map((g) => <LogRow key={g.sig} level={g.level} count={String(g.count)} text={g.example} when={ago(g.last)} />)}
          </>
        )}
    </SettingsCard>
  );
}

function AboutPane({ open }: { open: boolean }) {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  /** Why there is no status, as opposed to it not having arrived yet. Without
   *  this the two are the same state — a failed read left the pane reading
   *  "Reading version…" forever, which is how a 403 on /update/status went
   *  unnoticed: it looked like a slow server rather than a refused request. */
  const [stErr, setStErr] = useState<string | null>(null);
  // Which release's notes are being read, and what came back. Fetched here
  // because the modal is presentational — the automatic caller has to see the
  // answer before it can decide whether to open at all, so neither of them can
  // let the dialog do its own loading. The server holds these for an hour, so
  // reopening the same release is not a round trip that reaches github twice.
  const [want, setWant] = useState<NotesTarget | null>(null);
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [auto, setAuto] = useState(autoCheckUpdates);

  useEffect(() => {
    if (!want) return;
    let live = true;
    setNotes(null);
    api.updateNotes(want.tag)
      .then((r) => { if (live) setNotes(r); })
      .catch(() => { if (live) setNotes({ ok: false, tag: want.tag, notes: "", source: "", error: "Could not reach the server" }); });
    return () => { live = false; };
  }, [want]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    // Straight through the store, so the badge on the settings button and this
    // pane can never disagree about whether an update exists — and so opening
    // the pane refreshes what the background check knows rather than keeping a
    // second, private answer.
    api.updateStatus()
      .then((r) => { ingestUpdate(r); if (live) { setSt(r); setStErr(null); setCheckedAt(Date.now()); } })
      .catch((e) => { if (live) { setSt(null); setStErr(String(e?.message || e) || "the server did not answer"); } });
    return () => { live = false; };
  }, [open]);

  const run = async () => {
    setBusy(true); setErr(null);
    const r = await api.updateRun().catch(() => ({ ok: false, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Update failed to start"); return; }
    setStarted(true);
  };

  /* The button that asks the release feed right now, whatever the timer does. */
  const recheck = async () => {
    setChecking(true);
    try { const r = await api.updateStatus(); ingestUpdate(r); setSt(r); setStErr(null); setCheckedAt(Date.now()); }
    catch (e) { setStErr(String((e as Error)?.message || e) || "the server did not answer"); }
    setChecking(false);
  };
  /* The one thing to do with an update, where the page's one action goes. */
  const canInstall = !!st && !started && !st.blocked && st.behind !== 0;
  useReportHead("about", canInstall && st ? { action: { label: `Install ${st.branch}`, plain: true } } : null, () => void run());

  if (stErr) return (
    <SettingsCard title="This build" icon={<InfoIcon />}
      desc="Which version is running, and whether a newer one is out.">
      <SettingRow agentExempt label="Could not read this build's version"
        status={<StatusBadge tone="err">Unavailable</StatusBadge>}
        hint={<span className="break-all">{stErr}</span>} />
    </SettingsCard>
  );
  if (!st) return (
    <SettingsCard title="This build" icon={<InfoIcon />} desc="Which version is running, and whether a newer one is out.">
      <SettingRow agentExempt label="Reading version…" status={<StatusBadge tone="checking">Checking</StatusBadge>} />
    </SettingsCard>
  );

  // The stamp, not the commit. This row rendered `commit.slice(0, 7)` as seven
  // authoritative hex characters for a build packaged from a dirty tree, so it
  // answered "does this app have the fix from dd1f558?" with the sha of
  // dd1f558's PARENT — confidently, and wrong. `stamp` says `9699619` only when
  // the packaged tree really was that commit and `9699619+dirty.a3f1c2e`
  // otherwise; the fallback is for builds installed before the stamp existed.
  const short = st.info.stamp || (st.info.commit ? st.info.commit.slice(0, 7) : "unknown");
  const dirty = !!st.info.dirty;
  const mine = installedNotes(st.info.baseTag, st.info.distance, st.branch);
  // The same three-way split the rows below draw: an update is on offer only
  // when it is not running, not blocked and the build is behind.
  const offered = !started && !st.blocked && st.behind !== 0;
  return (
    <>
    <SettingsCard title="This build" icon={<InfoIcon />}
      tone={offered ? "decision" : "default"}
      status={offered ? <StatusBadge tone="info">Update available</StatusBadge> : undefined}
      desc="Which version is running, and whether a newer one is out.">
      {/* The build you are running, as a row like any other: what it is on the
          left, and the one thing you can do about it on the right. The notes
          used to appear once, on the launch after an update, and were
          unreachable ever after — dismiss it, or update before it existed, and
          the only copy was on the release page. */}
      <SettingRow agentExempt
        label="Version"
        hint={<>
          <span
            className="tabular-nums"
            title={dirty
              ? `built from an uncommitted tree — ${st.info.dirtyCount} packaged file(s) differ from ${st.info.commit.slice(0, 7)}`
              : st.info.commit}
            style={dirty ? { color: "var(--warning-ink)", fontWeight: 600 } : undefined}>
            commit {short}
          </span>
          {st.info.builtAt && <> · built {new Date(st.info.builtAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })}</>}
        </>}
        control={<span className="t-mono text-[13px] font-semibold">{st.info.version}</span>}
      />

      {/* Said in words, because the stamp alone is only obvious once you know
          the convention. The file list is the answer to the question that had
          no answer today — "whose uncommitted work is in the app I am running"
          — and it is absent outside the desktop shell on purpose. */}
      {dirty && (
        <SettingRow agentExempt
          label="Built from an uncommitted tree"
          status={<StatusBadge tone="warn">Uncommitted</StatusBadge>}
          hint={<>
            {st.info.dirtyCount} packaged file(s) differ from{" "}
            <span className="tabular-nums">{st.info.commit.slice(0, 7)}</span>. No commit reproduces this build.
          </>}
          detail={st.info.dirtyFiles.length > 0 ? {
            summary: "Files that differ from the commit",
            body: (
              <pre className="m-0 text-[11px] whitespace-pre-wrap break-all" style={{ color: "var(--text3)" }}>
                {st.info.dirtyFiles.slice(0, 8).join("\n")}
                {st.info.dirtyFiles.length > 8 ? `\n… and ${st.info.dirtyFiles.length - 8} more` : ""}
              </pre>
            ),
          } : undefined}
        />
      )}

      {/* The outcome of the previous run, which finished after the app it was
          updating had already been stopped — so this is the only place it can
          be reported at all. */}
      {st.last && (
        <SettingRow agentExempt
          label="Last update"
          status={<StatusBadge tone={st.last.ok ? "ok" : "err"}>{st.last.ok ? "Succeeded" : "Failed"}</StatusBadge>}
          hint={new Date(st.last.at).toLocaleString()}
          detail={!st.last.ok && st.last.tail ? {
            summary: "Last lines of the update log",
            body: (
              <pre className="m-0 text-[11px] whitespace-pre-wrap break-all" style={{ color: "var(--text3)" }}>
                {st.last.tail.split("~").filter(Boolean).slice(-6).join("\n")}
              </pre>
            ),
          } : undefined}
        />
      )}

      {started ? (
        <SettingRow agentExempt label="Updating"
          status={<StatusBadge tone="checking">In progress</StatusBadge>}
          hint="The app will close and reopen on its own — this window going away is the update working, not crashing." />
      ) : st.blocked ? (
        <SettingRow agentExempt label="Updating is blocked"
          status={<StatusBadge tone="warn">Blocked</StatusBadge>}
          hint={st.blocked} />
      ) : st.behind === 0 ? (
        <SettingRow agentExempt label="Up to date"
          status={<StatusBadge tone="ok">Current</StatusBadge>}
          hint={st.branch ? `${st.branch} is the newest release.` : undefined} />
      ) : (
        <>
          <SettingRow agentExempt
            label={`${st.branch} is available`}
            hint={st.behind > 1 ? `${st.behind} releases newer than yours.` : "One release newer than yours."}
            actions={<>
              <Button tone="ok" onClick={run} disabled={busy}>
                {busy ? "Starting…" : `Install ${st.branch} & restart`}
              </Button>
              {/* Read before you install, rather than after the app has
                  restarted into it. The tag list below says which releases are
                  coming; this says what is in them. */}
              <Button onClick={() => setWant({ tag: st.branch, title: "What's in this update" })}>
                What's in {st.branch}
              </Button>
            </>}
            below={err ? <div role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{err}</div> : undefined}
            detail={st.incoming.length > 0 ? {
              summary: "Commits in this update",
              body: (
                <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto agx-scroll">
                  {st.incoming.map((c) => (
                    <div key={c.sha} className="flex gap-2 text-[11px] min-w-0">
                      <span className="tabular-nums shrink-0" style={{ color: "var(--primary-ink)" }}>{c.sha}</span>
                      {c.subject && <span className="t-dim2" style={{ overflowWrap: "anywhere" }}>{c.subject}</span>}
                    </div>
                  ))}
                </div>
              ),
            } : undefined}
          />
          {/* The install compiles the release on this machine, so the
              toolchain has to be here before it starts — said up front
              rather than left to fail the build and report it in the panel
              above, after the app has already gone down to restart. */}
          <SettingRow agentExempt
            label="Built on your machine from source"
            hint={<>Needs <span style={{ color: "var(--warning-ink)" }}>git</span> and <span style={{ color: "var(--warning-ink)" }}>bun</span> installed, and is Linux-only for now.</>}
            detail={{
              summary: "How the update is built",
              body: "Compiles the tagged release in its own clone under ~/.cache, then reinstalls and restarts. Your working checkout is never touched, and only published tags are ever offered — commits pushed after a tag stay out until you tag them.",
            }}
          />
        </>
      )}

      <SettingRow agentExempt label="Last update check"
        hint={checkedAt ? `Checked ${minutesAgo(checkedAt)}.` : "Checked when this page opened."}
        actions={<Button pending={checking} onClick={() => void recheck()}>Check for updates</Button>} />
      <Toggle settingId="about.autoCheck" on={auto}
        onClick={() => { setting("about.autoCheck").set(!auto); setAuto(!auto); }}
        label="Look for a newer release by itself"
        hint="Off: the release feed is asked only when you press Check."
        detail={{ summary: "What it asks, and when", body: <>The desktop app asks the repository it was installed from for its newest tag, once shortly after it starts and then every six hours. Nothing else is sent, and a browser tab never does it.</> }} />
      {mine && (
        <SettingRow agentExempt label="Release notes" hint={`What changed in ${mine.tag}.`}
          actions={<Button onClick={() => setWant(mine)}>Open</Button>} />
      )}

      <ReleaseNotesModal
        open={!!want}
        tag={want?.tag ?? ""}
        title={want?.title}
        footnote={want?.footnote}
        loading={!!want && !notes}
        // A release with no annotation, an origin github knows nothing about,
        // a laptop on a train: all of them end here. Saying which is the whole
        // point of a button you pressed on purpose.
        error={notes && !notes.ok ? (notes.error || "No notes for that release") : undefined}
        notes={notes?.notes ?? ""}
        onClose={() => setWant(null)}
      />
    </SettingsCard>
    <AboutCredits />
    </>
  );
}

/**
 * THIS ROW IS NOT DECORATION. The understudy's pixel-art portrait layers are
 * CC BY 4.0 by Viktor Hahn and are compiled into the application binary — a
 * NOTICE file at the root of a source repository is invisible to anybody
 * actually running it, so this row is where the licence obligation is
 * actually discharged. NOTICE.md says so in as many words, and names this
 * page. Do not remove it.
 *
 * It lives on About rather than on Understudy, where it was built: About is
 * where a version, a changelog and a licence are expected to be, and the
 * understudy is not the only thing in this app wearing that art any more.
 */
function AboutCredits() {
  const [all, setAll] = useState(false);
  const shown = LICENCES.slice(0, 6);
  return (
    <SettingsCard title="Licences and credits" icon={<ShieldIcon />}
      desc="What this build is made of, and under which licence.">
      {/* What the app compiles in, with the licence each package declares in its own package.json (gen:licences). */}
      <SettingRow agentExempt label="Built with"
        hint={`${LICENCES.length} packages ship in this build.`}
        below={
          <div className="agx-lic" role="list" aria-label="Packages and their licences">
            {(all ? LICENCES : shown).map((l) => (
              <span key={l.name} role="listitem" className="agx-lic-i"><b>{l.name}</b> <span>{l.licence}</span></span>
            ))}
          </div>
        }
        actions={LICENCES.length > shown.length ? <Button aria-expanded={all} onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `View all ${LICENCES.length}`}</Button> : undefined} />
      <Row label="Portrait art by Viktor Hahn — CC BY 4.0"
        hint="The pixel-art portrait layers are his work, used under the Creative Commons Attribution 4.0 International licence. They are recoloured at paint time and otherwise unmodified."
        href="https://creativecommons.org/licenses/by/4.0/" />
    </SettingsCard>
  );
}

/**
 * Turn Claude Code's event forwarder on or off from inside the app (#187).
 *
 * Someone who installed the binary (the README's advised path) can now enable
 * live streaming and PreToolUse gating without cloning the repo to run a Python
 * script. The write is server-side, idempotent, and backs up settings.json
 * first, so this is a safe thing to offer from a button. Two things it has to
 * say plainly: the hooks load at Claude Code startup, so a running session
 * won't pick them up, and the forwarder itself runs under python3, which the
 * install does not check for.
 */
/**
 * Whether an agent could drive the built-in browser, and what is missing.
 *
 * This pane exists because of one failure and is shaped entirely by it: the
 * skill that tells agents this browser can be driven was written, committed and
 * shipped inside the app — and copied into ~/.claude/skills by nothing at all.
 * The feature was finished and unreachable at the same time, and nothing on any
 * screen said so. It was found by the person using it.
 *
 * So every row here states a fact with the path it was read from, and the three
 * parts are reported separately because they break independently. In
 * particular a dangling CLI link and a missing one are different sentences:
 * `command -v` says yes to the first, which is why it is the one that wastes an
 * afternoon.
 */
/**
 * Bringing existing logins into the built-in browser.
 *
 * The honest framing is the point of every string here. A password manager
 * cannot live in this browser — Electron loads unpacked extensions with no
 * browser action popup and no native messaging, so the unlock flow has nowhere
 * to happen — which leaves the cookies. Handing them over is handing over the
 * sessions themselves, so: nothing is pre-selected, the sites are named, the
 * confirmation is a native dialog the page cannot fake, and there is a way back
 * out that removes those sites and nothing else.
 */
function CookieImport() {
  const [sources, setSources] = useState<CookieSource[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useReportSaving("browser", busy);
  const [filter, setFilter] = useState("");
  // What rides along with the cookies. Read from the stored prefs so a choice
  // sticks between imports; default ON, so leaving them alone brings everything
  // as it always did.
  const [wantHistory, setWantHistory] = useState(importHistory());
  const [wantBookmarks, setWantBookmarks] = useState(importBookmarks());
  // The per-site chooser is behind "Choose sites": a row's Import brings the whole profile in.
  const [showSites, setShowSites] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    void cookieSources().then((r) => {
      if (!r.ok) { setErr(r.error || "Could not look at your browsers"); setSources([]); return; }
      const list = r.sources ?? [];
      setSources(list);
      // The one with the most sites, not the first that happens to be
      // readable — see bestSource(). That distinction was Firefox's three
      // against Zen's two hundred and one.
      const best = bestSource(list);
      if (best) setPick((p) => p || best.id);
    });
  }, []);
  useEffect(() => { if (CAN_IMPORT_COOKIES) load(); }, [load]);

  const current = (sources ?? []).find((s) => s.id === pick) ?? null;

  /* Everything, the moment a browser is chosen. Nothing-by-default reads as
     caution and behaves as an obstacle: with two hundred sites it is not a
     safeguard, it is a reason never to finish. */
  useEffect(() => { setChosen(current ? allSites(current.sites) : new Set()); setFilter(""); }, [current?.id]);

  // The sites the profiles hold between them: what the header says there is to bring in.
  useEffect(() => { setPageFact("importableSites", new Set((sources ?? []).filter((s) => s.readable).flatMap((s) => s.sites.map((x) => x.site))).size); }, [sources]);

  if (!CAN_IMPORT_COOKIES) return null;

  const view = siteView(current?.sites ?? [], filter);
  const total = current?.sites.length ?? 0;

  const run = async (kind: "import" | "forget", src: CookieSource | null = current, only: ReadonlySet<string> = chosen) => {
    const sites = [...only];
    if (!sites.length || !src) return;
    const pick = src.id;
    setBusy(true); setErr(null); setNote(null);
    // Every profile, not the one this panel happens to think of as "the
    // browser". Read at the moment of the click rather than held in state: the
    // browser view may have made one since this dialog opened.
    const profileIds = loadProfiles(globalThis.localStorage ?? null).map((p) => p.id);
    const r = kind === "import" ? await importCookies(pick, sites) : await forgetCookies(sites, profileIds);
    setBusy(false);
    if (!r.ok) { if (r.error !== "cancelled") setErr(r.error || "That did not work"); return; }
    if (kind === "forget") {
      const done = r as { removed?: number; profiles?: number };
      // The profile count is said out loud when there is more than one. "Removed
      // 12 cookies" reads as complete either way, and the whole point of this
      // change is that it was not.
      const where = (done.profiles ?? 1) > 1 ? ` across ${done.profiles} profiles` : "";
      setNote(`Removed ${done.removed ?? 0} cookies for ${sites.length} site${sites.length === 1 ? "" : "s"}${where}.`);
      return;
    }
    const res = r as CookieImportReply;
    const failed = res.failed?.length ?? 0;
    /*
     * The history comes with the logins, not as a second button.
     *
     * They are the same decision — "make this browser feel like mine" — and
     * splitting them into two steps means the address bar stays empty for
     * everybody who did the first one and never noticed the second. Failing to
     * read it is not failing to import: the cookies are already in.
     */
    let pages = 0;
    if (wantHistory || wantBookmarks) {
      try {
        const found = await browserPlaces(pick);
        const keep = pickImportRows(found, wantHistory, wantBookmarks);
        if (keep.length) pages = (await api.saveBrowserPlaces(pick, keep)).saved ?? 0;
      } catch { /* the logins are in; the history is a bonus */ }
    }
    setNote(`Brought in ${res.set ?? 0} cookies for ${sites.length} site${sites.length === 1 ? "" : "s"}.`
      + (failed ? ` ${failed} were refused by the browser.` : "")
      + (pages ? ` And ${pages.toLocaleString()} pages of history, so the address bar can complete them.` : "")
      + " Open the browser and you should be signed in.");
  };

  const Bulk = ({ text, onClick, off }: { text: string; onClick: () => void; off?: boolean }) => (
    <Button size="compact" onClick={onClick} disabled={off}>{text}</Button>
  );
  const sourceHint = sources === null
    ? "Looking at your browsers…"
    : !sources.length
      ? "No other browser profiles found on this machine."
      : "The browser profile the logins are read from.";

  return (
    <SettingsCard title="Bring your logins" icon={<LinkIcon size={ICON.sm} />}
      desc="Copies sessions from another browser. Nothing leaves this machine."
      actions={current?.readable && showSites ? (
        <>
          <Button onClick={() => void run("forget")} disabled={busy || !chosen.size}
            title="Remove these sites' cookies from agentglass's browser. Your own browser is untouched.">
            Forget them again
          </Button>
          <Button tone="primary" onClick={() => void run("import")} disabled={!chosen.size} pending={busy}>
            {busy ? "Bringing them in…" : `Bring in ${chosen.size} site${chosen.size === 1 ? "" : "s"}`}
          </Button>
        </>
      ) : undefined}>
      <div className="agx-table-head" aria-hidden><span>Profile</span><span>Sites</span></div>
      {!sources?.length && <SettingRow agentExempt label="Import from" hint={sourceHint} />}
      {sources?.filter(reachable).map((src, i) => (
        <SettingRow key={src.id} agentExempt
          label={src.label}
          hint={src.readable ? (src.kind === "firefox" ? "Firefox profile" : "Chrome-family profile") : "Sealed with a key this cannot reach."}
          below={!src.readable ? <div className="text-[12px]" role="note" style={{ color: "var(--warning-ink)" }}>{lockedWhy(src)}</div> : undefined}
          status={<span className="t-dim text-[12px] tabular-nums">{src.readable ? `${src.sites.length} signed in` : "locked"}</span>}
          actions={<span className="flex items-center gap-2">
            {src.readable && src.sites.length > 0 && (
              <Button size="compact" aria-expanded={showSites && pick === src.id} onClick={() => { setPick(src.id); setShowSites(pick !== src.id || !showSites); }}>
                {showSites && pick === src.id ? "Hide sites" : "Choose sites"}
              </Button>
            )}
            <Button tone={i === 0 && src.readable ? "primary" : undefined} disabled={!src.readable || busy || !src.sites.length}
              onClick={() => { setPick(src.id); void run("import", src, allSites(src.sites)); }}>Import</Button>
          </span>} />
      ))}
      <SettingRow agentExempt label="Why cookies, and what comes across" hint="A password manager cannot run in this browser."
        detail={{
          summary: "Details",
          body: <>
            Electron has no place to put a password manager's popup, so the way pages behind a login work here is bringing the
            cookies over. Chrome, Firefox, Zen, Brave and Chromium, including the Chrome-family ones whose values are sealed:
            their key is asked of your desktop keyring. Import brings every site of a profile; "Choose sites" lets you untick what
            you would rather leave behind. Anyone who can use this window, including an agent driving it, will be signed in to
            whatever comes across.
          </>,
        }} />

      {current?.readable && showSites && (
        <SettingRow agentExempt label={`Sites in ${current.label}`}
          hint={`${chosen.size} of ${total} chosen. Everything is chosen to start with; untick what you would rather leave behind.`}
          control={<span className="flex gap-2 justify-end">
            <Bulk text="All" onClick={() => setChosen(allSites(current.sites))} off={chosen.size === total} />
            <Bulk text="None" onClick={() => setChosen(new Set())} off={!chosen.size} />
          </span>}
          below={
            <div className="flex flex-col gap-2">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sites…" aria-label="Filter sites"
                className={`w-full ${INPUT}`}
                style={INPUT_STYLE} />
              {!!filter.trim() && (
                <div className="flex gap-2">
                  <Bulk text={`These ${view.matched.length}`} onClick={() => setChosen(addVisible(chosen, view))} />
                  <Bulk text="Not these" onClick={() => setChosen(dropVisible(chosen, view))} />
                </div>
              )}
              <div className="agx-scroll flex flex-col gap-0.5 overflow-y-auto" style={{ maxHeight: 220 }}>
                {view.rows.map((s) => {
                  const on = chosen.has(s.site);
                  return (
                    <button key={s.site} onClick={() => setChosen((c) => { const n = new Set(c); if (on) n.delete(s.site); else n.add(s.site); return n; })}
                      role="checkbox" aria-checked={on}
                      className="agx-btn agx-hover w-full text-left px-2 rounded flex items-center gap-2 text-[12px]"
                      style={{ minHeight: HIT, color: "var(--text)" }}>
                      <span className="flex" style={{ color: on ? "var(--primary-ink)" : "var(--text4)" }}><CheckboxIcon size={ICON.sm} checked={on} /></span>
                      <span className="flex-1 break-all">{s.site}</span>
                      <span className="t-dim2 tabular-nums text-[11px]">{s.cookies}</span>
                    </button>
                  );
                })}
                {/* Not a truncation somebody has to notice: the rows past here are
                    chosen exactly like the ones above, and the number is the same
                    information as the wall would have been. */}
                {view.hidden > 0 && (
                  <div className="text-[12px] t-dim2 px-2 py-1.5">
                    and {view.hidden} more site{view.hidden === 1 ? "" : "s"} — they come across too. Filter to find one.
                  </div>
                )}
                {!view.rows.length && <div className="text-[12px] t-dim2 px-2 py-1.5">Nothing matches that.</div>}
              </div>
            </div>
          } />
      )}

      {current?.readable && (
        <>
          <Toggle on={wantHistory} onClick={() => { const next = !wantHistory; setWantHistory(next); setImportHistory(next); }}
            agentNever="imports the owner's cookies and history from another browser: credentials"
            label="Bring browsing history"
            hint="So the address bar completes what you type." />
          <Toggle on={wantBookmarks} onClick={() => { const next = !wantBookmarks; setWantBookmarks(next); setImportBookmarks(next); }}
            agentNever="imports the owner's cookies and history from another browser: credentials"
            label="Bring bookmarks"
            hint="Ranked first in the address bar." />
        </>
      )}

      {err && <EmptyState><span role="alert" style={{ color: "var(--error-ink)" }}>{err}</span></EmptyState>}
      {note && <EmptyState><span role="status">{note}</span></EmptyState>}
    </SettingsCard>
  );
}

/** Where a .dmg install keeps the CLIs: electron-builder copies `bin/` into the
 *  bundle's Resources (electron/package.json "build.extraResources"), and
 *  /Applications is where a dragged .dmg lands. */
const MAC_BUNDLE_BIN = "/Applications/agentglass.app/Contents/Resources/bin";

function AgentBrowserPane({ open }: { open: boolean }) {
  const [st, setSt] = useState<BrowserUseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useReportSaving("hooks", busy);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api.browserUseStatus().then(setSt).catch(() => setSt(null));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);

  const install = async () => {
    setBusy(true); setErr(null); setNote(null);
    const r = await api.browserUseInstall().catch(() => ({ ok: false, backup: undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Could not install the skill"); return; }
    setNote(r.backup ? `Installed. Your previous copy is beside it as ${r.backup.split("/").pop()}.` : "Installed.");
    load();
  };

  if (!st) return <SettingsCard title="Browser access" icon={<BrowserIcon size={ICON.sm} />}><EmptyState>Reading…</EmptyState></SettingsCard>;

  const mono = { color: "var(--text)" };
  /* A Mac has no installer to reinstall: the .dmg carries the CLI inside the
     bundle, and "reinstall the app to get it" sent people round a loop that
     ends where it started. Agents the app seats already find it — the shell
     puts that directory on the sidecar's PATH — so this line is for the
     person's own terminal, and it names the two ways to get there. */
  const cliSays =
    st.cli.state === "installed" ? `On your PATH at ${st.cli.path}`
      : st.cli.state === "dangling" ? `${st.cli.path} points at ${st.cli.target ?? "nothing"}, which is not there — every call an agent makes fails while the command still resolves`
        : IS_MAC_DESKTOP
          ? `Not on your PATH. The app carries it at ${MAC_BUNDLE_BIN}/agentglass-browser — add ${MAC_BUNDLE_BIN} to your PATH, or run: ln -s ${MAC_BUNDLE_BIN}/agentglass-browser ${st.cli.path}`
          : `Not on your PATH. The installer puts it at ${st.cli.path}; reinstall the app to get it.`;
  const skillSays =
    st.skill.state === "current" ? `Installed at ${st.skill.path}`
      : st.skill.state === "stale" ? `Installed at ${st.skill.path}, but this build ships a newer one`
        : st.skill.state === "missing" ? "Not installed — agents have no way to know the browser can be driven"
          : "This build does not carry the skill file, so there is nothing to install";

  return (
    /* Three independent things, so a checklist rather than a paragraph: the
       count says how far off you are before you have read a word, and each
       line carries the button that fixes that line. The argument for the
       feature is read once, by somebody deciding whether to bother, so it
       comes after the verdict. */
    <SetupCard
      title="Browser access" icon={<BrowserIcon size={ICON.sm} />}
      error={err}
      note={note}
      actions={<Button onClick={load} disabled={busy}>Check again</Button>}
      steps={[
        { title: "The command", done: st.cli.state === "installed",
          detail: <><span className="t-mono text-[11px]" style={mono}>agentglass-browser</span>. {cliSays}</> },
        { title: "The skill", done: st.skill.state === "current",
          detail: <>What tells an agent the command exists. {skillSays}</>,
          action: (st.skill.state === "missing" || st.skill.state === "stale")
            ? { label: st.skill.state === "stale" ? "Update" : "Install", onClick: () => void install(), busy }
            : undefined },
        { title: "A window that can answer", done: st.windows > 0, says: { done: "Open", todo: "Not open", todoTone: "off" },
          detail: st.windows > 0
            ? "The browser view is open in this window."
            : "The browser view is not open yet. The command opens it itself on first use; until then there is nothing to drive." },
      ]}>
      <SettingRow label="Why an agent needs this rather than curl"
        hint="An agent fetching a URL from its shell gets the signed-out version of everything that matters, because the session lives in a browser. This one has your sessions in it. Three things have to be true for an agent to use it, and they break independently." />
      {/* Something to paste, because "it is installed" and "I know what to say
          to it" are different problems and only the first one is solved by a
          green line. */}
      <SettingRow label="Try it"
        hint="Something to say to an agent once it can drive the browser."
        detail={{
          summary: "Three lines to paste into an agent",
          body: <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
            {[
              "Using agentglass-browser, open my dashboard and tell me what is on it.",
              "With agentglass-browser, go to the staging app, log in with my session, and check the checkout flow.",
              "Take a screenshot of the open PR page with agentglass-browser and tell me what is failing.",
            ].map((p) => (
              <li key={p} className="text-[12px] px-2 py-1 rounded" style={{ color: "var(--text2)", background: "var(--surface-inset)" }}>{p}</li>
            ))}
          </ul>,
        }} />
    </SetupCard>
  );
}

/** The Agents page: the hooks and the gate beside it, the cards the modal hands
 *  in (new chats, browser, card skills), the worker roles, and one danger zone
 *  that holds both ways back — which is why the hooks state lives here and not
 *  in the card, and why the cards come in as slots: the flow fills columns in
 *  order, so the danger zone has to be drawn after every card it follows. */
function AgentsPage({ open, chats, panes, browser, skills }: {
  open: boolean; chats: React.ReactNode; panes: React.ReactNode; browser: React.ReactNode; skills: React.ReactNode;
}) {
  const [resetTick, setResetTick] = useState(0);
  const [armed, setArmed] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [st, setSt] = useState<HookSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useReportSaving("hooks", busy);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.hooksStatus()
      .then((r) => { if (live) setSt(r); })
      .catch(() => { if (live) setSt(null); });
    return () => { live = false; };
  }, [open]);

  /*
   * THE GATE IS ITS OWN SWITCH, and the copy has to say why.
   *
   * The forwarder streams what happened. The gate HOLDS a tool call until
   * somebody decides, and an outward one — a push, a pull request, a comment,
   * a review, a merge, a ticket, a message in a channel — is held closed. Two
   * different bargains, so two different buttons: nobody should acquire a
   * thing that can stop their agents by asking for telemetry.
   */
  const gate = async (on: boolean) => {
    setBusy(true); setErr(null); setNote(null);
    const r = await api.hooksGate(on)
      .catch(() => ({ ok: false, installed: false, changed: false, settingsPath: "", error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Could not update the gate"); return; }
    setSt((cur) => (cur ? { ...cur, gate: on } : cur));
    setNote(!r.changed
      ? (on ? "The gate was already on." : "The gate was already off.")
      : on
        ? "The gate is on. Start a new Claude Code session for it to take effect."
        : "The gate is off. Sessions already running keep it until they restart.");
  };

  const act = async (kind: "install" | "uninstall") => {
    setBusy(true); setErr(null); setNote(null);
    const r = await (kind === "install" ? api.hooksInstall() : api.hooksUninstall())
      .catch(() => ({ ok: false, installed: false, changed: false, settingsPath: "", error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Could not update the hooks"); return; }
    setSt((s) => (s ? { ...s, installed: r.installed } : s));
    setNote(
      !r.changed
        ? (r.installed ? "Already enabled — nothing to change." : "Already off — nothing to change.")
        : r.installed
          ? "Enabled. Start a new Claude Code session for it to take effect."
          : "Disabled. Existing sessions keep the old hooks until they restart.",
    );
  };

  const hooksIcon = <PlugIcon size={ICON.sm} />;
  /* The pieces that do not depend on the hooks being readable: the cards of the
     page are the same whatever the hooks say, so a failed read does not blank
     the page, only the card that read it. */
  const resetRoles = async () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false); setResetNote(null);
    const rs = await Promise.all(WORKER_ROLES.map((r) =>
      api.workerRoleSave(r.id, r.default.provider, r.default.model).then((x) => x.ok).catch(() => false)));
    setResetNote(rs.every(Boolean) ? "Every role is back on its default." : "Could not reset every role.");
    setResetTick((n) => n + 1);
  };

  const hooksCards = !st ? (
    <SettingsCard title="Claude Code hooks" icon={hooksIcon}><EmptyState>Reading hook state…</EmptyState></SettingsCard>
  ) : !st.bundled ? (
    <SettingsCard title="Claude Code hooks" icon={hooksIcon}>
      <SettingRow label="The hook scripts are not in this build"
        hint={<>This build does not carry the hook scripts, so there is nothing to wire. Install from a Release, or run <span className="t-mono">bun run setup</span> in a checkout.</>}
        status={<StatusBadge tone="warn">Not included</StatusBadge>} />
    </SettingsCard>
  ) : (
    <>
      {/* The last step is one only you can take, and there is no way from
          here to see whether you have. It says so and stays out of the count,
          rather than sitting there permanently unticked. */}
      <SetupCard
        title="Claude Code hooks" icon={hooksIcon}
        desc="Lets agentglass see what your sessions are doing."
        chip={<StatusBadge tone={st.installed ? "ok" : "warn"}>{st.installed ? "Wired" : "Not wired"}</StatusBadge>}
        error={err}
        note={note}
        steps={[
          { title: "Hook scripts in this build", done: st.bundled, says: { done: "Included" },
            detail: "Shipped with the app — nothing to fetch." },
          { title: "Wired into Claude Code", done: st.installed, says: { done: "Wired", todo: "Not wired" },
            detail: <>Written to <span className="t-mono text-[11px]">{tilde(st.settingsPath)}</span>, run under <span className="t-mono text-[11px]">{st.python}</span>.</>,
            /* What the checklist is FOR, read once, so it sits behind "Details". */
            more: {
              summary: "Details",
              body: <>
                Every Claude Code session streams here live — what ran, what it
                cost, when it stopped for you. It watches; it never stops a tool
                call, and its command ends in <span className="t-mono text-[11px]">|| exit 0</span> so that stays true
                even if the script goes missing. Holding calls is the gate below, which is a separate switch.
                It edits <span className="t-mono text-[11px]" style={{ color: "var(--text)" }}>{st.settingsPath}</span>,
                backing it up first, and leaves your other hooks untouched.
              </>,
            },
            action: st.installed ? undefined : { label: busy ? "Enabling…" : "Enable", onClick: () => void act("install"), busy } },
          { title: "Start a fresh session", done: null,
            detail: "Sessions already running keep the hooks they started with." },
        ]}>
        {/* The forwarder is a python script; the install writes the command
            but cannot make an interpreter appear. Said up front rather than
            left to a session that streams nothing and no error anywhere. */}
        <SettingRow label="Python on your PATH"
          hint={<>Hooks run under <span className="t-mono">{st.python}</span>; they load at startup.</>}
          detail={{ summary: "Details", body: <>The forwarder is a python script, so <span className="t-mono">{st.python}</span> has to be on your PATH for events to arrive. A change takes effect on the next Claude Code session.</> }}
          status={st.pythonVersion === undefined ? undefined
            : st.pythonVersion ? <StatusBadge tone="ok">python {st.pythonVersion}</StatusBadge> : <StatusBadge tone="warn">Not found</StatusBadge>} />
      </SetupCard>

      {/* The gate. Its own card, below the forwarder, because it is the
          stronger thing and read second for the same reason. */}
      <GateCard st={st} busy={busy} open={open} onGate={(on) => void gate(on)} />
    </>
  );

  return (
    <>
      {hooksCards}
      {chats}
      {panes}
      {browser}
      {skills}
      <WorkerRolesCard open={open} resetTick={resetTick} onEngines={() => openSettings("engines")} />
      {/* Both ways back, together and apart from everything that sets
          something: the hooks come out of the person's own Claude Code
          settings, the roles go back to the table in shared/workerRoles.ts.
          Outline buttons, and neither deletes anything that cannot be put back. */}
      <SettingsCard title="Danger zone" tone="danger" icon={<WarningIcon size={ICON.sm} />}
          desc="Reversible, but they change what every session does.">
          {st?.bundled && st.installed && (
            <SettingRow label="Take the hooks back out"
              hint="Removes the entries above; running sessions keep them until they end."
              detail={{ summary: "Details", body: <>Also <span className="t-mono">python3 hooks/install_hooks.py --uninstall</span> in a checkout. Global (<span className="t-mono">~/.claude</span>), so it covers every project.</> }}
              actions={<Button tone="danger" pending={busy} onClick={() => void act("uninstall")}>{busy ? "Disabling…" : "Disable hooks"}</Button>} />
          )}
          <SettingRow label="Forget worker roles"
            hint={resetNote ?? (armed ? "Press again to put every role back on its default CLI and model." : "Back to “every role on its default CLI and model”.")}
            actions={<Button tone="danger" onClick={() => void resetRoles()}>{armed ? "Reset roles?" : "Reset roles"}</Button>} />
        </SettingsCard>
    </>
  );
}

/**
 * Every agent this app can connect, not only the one it ships hooks for.
 *
 * Beside the Claude Code section rather than in a tab of its own: they are the
 * same act — wiring an agent so it reports here — and splitting them would put
 * the answer to "can I use my other CLI with this" one tab further away than
 * the question that prompts it.
 */
/**
 * THE LANTERN REMINDER — the one setting the Lantern has.
 *
 * Translated from Herdr's Lantern: its board is full because every agent it
 * seats is handed a rule to narrate what it is working toward. Here the ask
 * rides the hook every session already runs — on a prompt, the server may
 * answer with one line asking the session to `POST /agents/status`, and the
 * session reads it the way it reads the memory-save reminder. This is where
 * that is switched and paced. Two controls and no more: whether, and how often
 * one session may be asked again.
 */
function LanternSection({ open }: { open: boolean }) {
  const [seatWake, setSeatWake] = useState(4);
  useEffect(() => { if (open) void api.seatWake().then((r) => { if (r.ok) setSeatWake(r.hours); }).catch(() => {}); }, [open]);
  const [nudge, setNudge] = useState(true);
  const [minutes, setMinutes] = useState(20);
  const [watch, setWatch] = useState(true);
  const [watchMinutes, setWatchMinutes] = useState(15);
  const [cacheTtl, setCacheTtl] = useState(5);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const take = (r: { nudge?: boolean; minutes?: number; watch?: boolean; watchMinutes?: number; cacheTtlMinutes?: number }) => {
    if (typeof r.nudge === "boolean") setNudge(r.nudge);
    if (typeof r.minutes === "number") setMinutes(r.minutes);
    if (typeof r.watch === "boolean") setWatch(r.watch);
    if (typeof r.watchMinutes === "number") setWatchMinutes(r.watchMinutes);
    if (typeof r.cacheTtlMinutes === "number") setCacheTtl(r.cacheTtlMinutes);
  };
  const load = () => api.lanternSettings()
    .then((r) => { take(r); setErr(null); })
    .catch(() => setErr("Could not reach the server — the Lantern settings are unavailable."));
  useEffect(() => { if (open) void load(); }, [open]);
  const save = (f: { nudge?: boolean; minutes?: number; watch?: boolean; watchMinutes?: number; cacheTtlMinutes?: number }) => {
    setNote(null);
    api.lanternSettingsSave(f)
      .then((r) => {
        if (!r.ok) { setNote(r.error ?? "Could not save."); return; }
        take(r);
        setNote(f.watch !== undefined || f.watchMinutes !== undefined
          ? "Saved. The next look is one interval from now."
          : "Saved. Applies to the next prompt in every hooked session.");
      })
      .catch(() => setNote("Could not save."));
  };
  const STEPS = [10, 20, 45, 90] as const;
  const near = String(STEPS.find((m) => m >= minutes) ?? 90);
  const WATCH_STEPS = [5, 10, 15, 30, 60] as const;
  const nearWatch = String(WATCH_STEPS.find((m) => m >= watchMinutes) ?? 60);
  const ic = <LanternIcon size={ICON.sm} />;
  /* Two cards, split by what they act on: the board and what it asks of a
     session, and the one seat it wakes. The picture of the board is in the
     side slot, and its watch line and cache clock follow the controls. */
  return (
    <div className="agx-split-page">
      <div className="agx-split-main">
        <SettingsCard title="Lantern" icon={ic}
          desc="The board that watches every agent, and how often it taps you on the shoulder."
          status={<StatusBadge tone={watch ? "ok" : "off"}>{watch ? "Watching" : "Not watching"}</StatusBadge>}>
          {err && <div role="alert" className="agx-settings-x pt-2 pb-3 text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
          <Toggle on={watch} onClick={() => save({ watch: !watch })}
            label="Watch the agents and notify me"
            hint="One notification per look at most, while something needs you."
            detail={{ summary: "Details", body: <>Every few minutes the agents are re-read. One notification goes out — the app's bell, the phone when paired, the desktop otherwise — if somebody is still stopped on you, a worker's window vanished, or claimed work has gone quiet for an hour. The instant alerts stay either way; this is the sweep behind them. It never starts, stops or queues anything.</> }} />
          <Choice label="How often it looks" value={nearWatch}
            hint="How long between two looks at the board."
            options={WATCH_STEPS.map((m) => ({ v: String(m), label: `${m} min` }))}
            onPick={(m) => save({ watchMinutes: Number(m) })} disabled={!watch}
            disabledHint="Nothing is looked at while the watch is off." />
          <Toggle on={nudge} onClick={() => save({ nudge: !nudge })}
            label="Ask sessions what they are working on"
            hint="Names a bare session after what it is doing."
            detail={{ summary: "Details", body: <>On a prompt, a hooked session may be handed one line asking it to post its task (<span className="t-mono">POST /agents/status</span>). Off, and the Lantern lists sessions by name and pane only.</> }} />
          <Choice select wide={false} label="How often one session may be asked again" value={near}
            hint="A session that answered is left alone for this long."
            options={STEPS.map((m) => ({ v: String(m), label: `${m} min` }))}
            onPick={(m) => save({ minutes: Number(m) })} disabled={!nudge}
            disabledHint="Nothing is asked while the reminder is off." />
        </SettingsCard>
        <SettingsCard title="The orchestrator" icon={<AgentIcon size={ICON.sm} />}>
          {/* The seat's floor lives here because it rides the same look: the watch
              re-reads the field, and the orchestrator is prompted only when what
              it found CHANGED. This is how long a quiet field may stay quiet
              before it gets a line anyway. */}
          <Choice select wide={false} label="Wake the orchestrator at least every" value={String(seatWake)}
            hint="How long a quiet field may stay quiet before the seat gets a line anyway."
            detail={{ summary: "Details", body: <>The seat is woken when the field changes. This is the floor under that, so a quiet day still gets a line rather than a silence you cannot tell from a dead agent.</> }}
            options={[1, 2, 4, 8, 12, 24].map((h) => ({ v: String(h), label: h === 1 ? "1 hour" : `${h} hours` }))}
            onPick={(h) => { void api.seatWakeSave(Number(h)).then(() => setSeatWake(Number(h))); }} />
          <Choice label="How long the prompt cache stays warm" value={String(cacheTtl === 60 ? 60 : 5)}
            hint="A turn sent while it is warm is the cheap one."
            detail={{ summary: "Details", body: <>Each card counts it down from the session's last turn. Five minutes on most plans; an hour on some.</> }}
            options={[{ v: "5", label: "5 min" }, { v: "60", label: "1 hour" }]}
            onPick={(m) => save({ cacheTtlMinutes: Number(m) })} />
        </SettingsCard>
        {note && <div role="status" className="agx-settings-x text-[11px]" style={{ color: "var(--text3)" }}>{note}</div>}
      </div>
      <aside className="agx-split-side">
        <PreviewCard id="lantern" title="The real Lantern card">
          <LanternPreview watch={watch} everyMin={watchMinutes} wakeMin={cacheTtl} />
        </PreviewCard>
      </aside>
    </div>
  );
}

/**
 * The notification diet — what the fleet is ALLOWED to push at you, and on
 * which channel. See shared/notifyPrefs.ts.
 *
 * Everything here defaults quiet on purpose: only `blocked` (an agent truly
 * stopped on a gate or a permission prompt) and `reminders` (an alarm the
 * person set themselves) reach for them out of the box. The rest — an agent
 * merely idle, a stall, a tool error, the understudy needing a look, a usage
 * limit — still show wherever they already live (the fleet card, the bell's
 * history list); a switch here is what lets one of them additionally push.
 *
 * `None` sits above both groups rather than inside either: it silences every
 * kind on every channel at once, and the "What" and "Where" rows go disabled
 * under it so the state they represent is not lost, only overridden — turning
 * `None` back off returns to whatever was chosen before.
 */
/** A switch that is one control among several in its row, so the row itself
 *  cannot be the button (a Select inside a button is invalid HTML). */
function SwitchButton({ on, onClick, disabled, busy, label }: { on: boolean; onClick: () => void; disabled?: boolean; busy?: boolean; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled}
      className="shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
      <Switch on={on} busy={busy} />
    </button>
  );
}

/** Voice picker plus Play, as a row's control rather than a row of its own. */
function VoicePicker({ voices, value, onPick, label }: {
  voices: Voice[]; value: string; onPick: (v: string) => void; label: string;
}) {
  const voice = findVoice(voices, value);
  return (
    <span className="flex items-center gap-2 shrink-0">
      <Select value={value} onChange={onPick} title={voice.hint} style={{ minWidth: 132 }}
        options={voices.map((v) => ({ value: v.id, label: v.label, hint: v.hint }))} />
      <Button onClick={() => playVoice(voice)} disabled={voice.id === "none"}
        aria-label={`Play ${label}`}
        title={voice.id === "none" ? "Nothing to play" : `Play ${voice.label}`}>Play</Button>
    </span>
  );
}

/*
 * Four cards, in the order of the questions: what may interrupt, how it gets
 * through, what about pull requests, and what is mirrored from other apps.
 *
 * Three sound gates stay three, on purpose, and none shares a key: the server
 * channel "sound" (per kind), the session chime `sound`/`onSound` (not
 * persisted, off at every start) and the notifications voice
 * (`agentglass.notifyVoice`, the card behind the bell). They sit next to each
 * other so the difference can be read, not merged.
 *
 * "agentglass's own notifications" is in card 1: it decides which of agentglass's
 * own events interrupt at all, the same question as the kind rows above it.
 */
function NotificationsSection(p: {
  sound: boolean; onSound: () => void;
  quiet: boolean; mutedList: string[]; own: boolean;
  notifyVoice: string; onNotifyVoice: (v: string) => void;
  alarmVoice: string; onAlarmVoice: (v: string) => void;
  ciApproved: boolean; onCiApproved: () => void;
  reviewGate: boolean; onReviewGate: () => void;
  talkMode: TalkNotify; onTalkMode: (v: TalkNotify) => void;
  sysNotify: SysNotifyMode; notifyCap: NotifyCapability | null;
}) {
  const { quiet, mutedList, own } = p;
  useEffect(() => { setPageFact("volume", quiet ? "Quiet" : own ? "Loud" : "Normal"); }, [quiet, own]);
  const prefs = useSyncExternalStore(subscribeNotifyPrefs, getNotifyPrefs, getNotifyPrefs);
  const [err, setErr] = useState<string | null>(null);
  const save = (next: typeof prefs) => {
    setErr(null);
    saveNotifyPrefs(next).catch(() => setErr("Could not save."));
  };
  const setKind = (k: NotifyKind, on: boolean) => save({ ...prefs, kinds: { ...prefs.kinds, [k]: on } });
  const setChannel = (c: NotifyChannel, on: boolean) => save({ ...prefs, channels: { ...prefs.channels, [c]: on } });
  /* The phone is a channel the server keeps (`phone.alerts`), not this window's: read when the page opens. */
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api.phoneAlerts().then((r) => { if (live && r.ok && typeof r.value === "boolean") setPhone(r.value); }).catch(() => { /* the row stays disabled */ });
    return () => { live = false; };
  }, []);
  const flipPhone = () => {
    if (phone === null) return;
    const next = !phone;
    setPhone(next);
    setErr(null);
    api.settingsDoorSet("phone.alerts", next)
      .then((r) => { if (!r.ok) throw new Error(r.error); })
      .catch(() => { setPhone(!next); setErr("Could not save."); });
  };
  const alarmPicker = (
    <VoicePicker label="Reminder alarm" voices={ALARM_VOICES} value={p.alarmVoice} onPick={p.onAlarmVoice} />
  );
  return (
    <>
      <SettingsCard title="Interrupt me for" icon={<BellIcon size={ICON.sm} />}
        desc="Whatever is off still shows quietly on the fleet card."
        status={err ? <StatusBadge tone="err">{err}</StatusBadge> : undefined}
        actions={<span className="flex items-center gap-2 text-[11px] t-dim">Silence all
          <SwitchButton on={prefs.none} label="Silence all"
            onClick={() => save({ ...prefs, none: !prefs.none })} /></span>}>
        {NOTIFY_KINDS.map((k) => (
          <Fragment key={k}>
            <Toggle on={prefs.kinds[k]} disabled={prefs.none}
              onClick={() => setKind(k, !prefs.kinds[k])}
              agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
              label={NOTIFY_KIND_LABEL[k].label} hint={NOTIFY_KIND_LABEL[k].desc} />
            {k === "reminders" && (
              <SettingRow agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
                label="Alarm voice" hint="Spoken when a reminder rings."
                control={alarmPicker} />
            )}
          </Fragment>
        ))}
      </SettingsCard>

      <SettingsCard title="How it reaches you" icon={<BellIcon size={ICON.sm} />}
        status={<StatusBadge tone={prefs.none ? "off" : quiet ? "info" : "ok"}>{prefs.none ? "Silenced" : quiet ? "Quiet" : own ? "Loud" : "Normal"}</StatusBadge>}>
        {/* Three words for two switches: Quiet is the quiet switch; with it off, agentglass's own
            notices interrupt (Loud) or keep landing in the bell (Normal). */}
        <Choice<"quiet" | "normal" | "loud">
          settingId="notifications.volume" wide label="Volume"
          hint="Quiet lets through only what is stopped."
          detail={{ summary: "What each level lets through", body: <>
            Quiet: an approval, an agent blocked on a question, a red check on a pull request about to merge still pop and ring;
            everything else collects in the bell without a sound. Normal: the same, and agentglass's own notices (chats finishing,
            branches falling behind, checks going red) still only land in the bell. Loud: those interrupt too.
          </> }}
          value={quiet ? "quiet" : own ? "loud" : "normal"} modified={!quiet}
          onPick={(v) => { if (v === "quiet") setting("notifications.quiet").set(true); else setting("notifications.volume").set(v); }}
          options={[{ v: "quiet", label: "Quiet" }, { v: "normal", label: "Normal" }, { v: "loud", label: "Loud" }]} />
        {NOTIFY_CHANNELS.map((c) => (
          <Fragment key={c}>
            <Toggle on={prefs.channels[c]} disabled={prefs.none}
              onClick={() => setChannel(c, !prefs.channels[c])}
              agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
              label={NOTIFY_CHANNEL_LABEL[c].label} hint={NOTIFY_CHANNEL_LABEL[c].desc} />
            {c === "sound" && (
              <>
                <SettingRow agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
                  label="Notification sound" hint="Which sound notifications make."
                  control={<VoicePicker label="Notifications" voices={NOTIFY_VOICES} value={p.notifyVoice} onPick={p.onNotifyVoice} />} />
                <Toggle on={p.sound} onClick={p.onSound}
                  agentExempt label="Chime this session"
                  hint="Only this window, until you quit."
                  detail={{ summary: "About the chime", body: <>A chime when a session errors or needs you. It is off at every start; the speaker in the header flips it too.</> }} />
              </>
            )}
          </Fragment>
        ))}
        <Toggle on={phone === true} disabled={phone === null} onClick={flipPhone}
          settingId="phone.alerts" label="Paired phones"
          hint={phone === null ? "Checking…" : phone ? "A paired phone raises its own notification for the pull requests you watch and your cards." : "Paired phones stay quiet about watches and cards."}
          detail={{ summary: "What it covers", body: <>Only what you asked for: a rule on a pull request's bell, or a card you follow. One switch for every paired phone; each phone also needs its own permission in Android. Nothing is sent through anyone's server, so a phone hears it while the app is open or kept connected.</> }} />
        {mutedList.length > 0 && (
          <SettingRow agentExempt label="Muted sources"
            hint="A muted source is not collected."
            detail={{ summary: "Muting and unmuting", body: <>Mute a source from its row in the bell or from a desktop card; unmute it here or from the bell's footer.</> }}
            below={
              <span className="flex flex-wrap gap-1">
                {mutedList.map((src) => (
                  <button key={src} className="chip text-[11px] gap-1" onClick={() => setMuted(src, false)}
                    title={`Unmute ${sourceLabel(src)}`} aria-label={`Unmute ${sourceLabel(src)}`}>
                    <MuteGlyph />{sourceLabel(src)}
                  </button>
                ))}
              </span>
            } />
        )}
      </SettingsCard>

      <SettingsCard title="Pull requests" icon={<ReviewIcon size={ICON.sm} />}>
        <Toggle on={p.ciApproved} onClick={p.onCiApproved}
          settingId="notifications.ciOnlyApproved" label="Checks: only when the pull request is approved"
          hint={p.ciApproved ? "Only once the pull request is approved." : "Every verdict, on every pull request of yours."}
          detail={{ summary: "Why approved only", body: <>A suite finishing on something half-written is a status line; on something approved it is the last thing before merging. Off: every verdict, including on pull requests nobody has looked at yet.</> }} />
        <Toggle on={p.reviewGate} onClick={p.onReviewGate}
          agentNever="decides whether a reviewer's findings hold a pull request out of the green lane: an agent that could switch it off could clear its own findings from the board"
          label="Review findings block merge-ready pull requests"
          hint={p.reviewGate ? "Blocks merge-ready pull requests." : "The board files pull requests by GitHub's facts only."}
          detail={{ summary: "What blocking does", body: p.reviewGate
            ? <>A pull request with open critical or high findings from a local review of its CURRENT head moves from “Green, ready to land” to Blocked, with the reason on the card. Resolve or dismiss them, or push and review again, and it moves back. A review of an older head never blocks.</>
            : <>Off: the board files pull requests by GitHub's own facts only. A card with open critical or high findings still shows “Not ready” as a chip and stays where it is.</> }} />
        <Choice<TalkNotify>
          settingId="notifications.talk" label="Conversation: when somebody says something"
          hint={p.talkMode === "everything" ? "A comment or a review the moment it lands."
            : p.talkMode === "reviews" ? "Only a review coming back."
            : "Nothing interrupts; the board still marks it."}
          detail={{ summary: "What each choice does", body: <>Comments and reviews: a comment from a person, and a review the moment it is submitted, named as what it is (approved, changes requested, or a remark). Reviews only: comments stay to be found on the board, which marks them either way. Off: the board still marks what has been said since you last looked; it just will not interrupt you.</> }}
          value={p.talkMode}
          options={[
            { v: "everything", label: "Comments and reviews" },
            { v: "reviews", label: "Reviews only" },
            { v: "off", label: "Off" },
          ]}
          onPick={p.onTalkMode} />
      </SettingsCard>

      <SettingsCard title="Asked for, and what became of it" icon={<ChecklistIcon size={ICON.sm} />}
        desc="The notifications you armed, newest first. Quiet: nothing here interrupts.">
        <AskedAlertLog />
      </SettingsCard>

      <SettingsCard title="From other apps" icon={<PhoneIcon size={ICON.sm} />}>
        <Toggle
          agentNever="reads other applications' notifications into this app: what they say is theirs"
         
          on={p.sysNotify !== "off"}
          // Disabled only on a verdict: "could not reach the server to ask" is
          // not one, and greying the switch for a startup race reads as a
          // machine that cannot do this at all.
          disabled={p.notifyCap ? !p.notifyCap.supported && !p.notifyCap.transient : true}
          onClick={() => setSysNotifyOn(p.sysNotify === "off")}
          label="Mirror this machine's notifications"
          hint={p.notifyCap && !p.notifyCap.supported
            ? (p.notifyCap.transient
              ? `Checking — ${p.notifyCap.reason}`
              : `Unavailable — ${p.notifyCap.reason}`)
            : "Shows other apps' notifications on the fleet card."}
          detail={{ summary: "What is mirrored", body: <>Slack, mail, calendar: whatever pops up behind agentglass while it is covering your screen. A copy, never an interception: your desktop still shows its own.</> }} />
        {p.sysNotify !== "off" && (
          <Choice<SysNotifyMode>
            agentNever="reads other applications' notifications into this app: what they say is theirs"
            label="How much of the message"
            hint="Full shows the text; Who shows only who it was from."
            value={p.sysNotify}
            onPick={setSysNotifyMode}
            options={[
              { v: "titles", label: "Who" },
              { v: "full", label: "Full" },
            ]} />
        )}
      </SettingsCard>
    </>
  );
}

/**
 * What agentglass needs from the machine, and what it found.
 *
 * The panels have always said this one tool at a time, in the panel that needs
 * it, and only once you opened that panel. Two of them never said it at all:
 * python3 and setsid fail quietly, which is exactly the failure worth a list.
 *
 * Guidance is deliberately generic. There is one macOS, one Windows and an
 * unbounded number of Linux distributions, so a package-manager line would be
 * wrong for most readers. Each row names the tool, says what it costs to be
 * without it, and links the project's own page. Nothing here installs anything.
 */
const STATUS_LABEL: Record<DepStatus, string> = {
  ok: "Ready",
  attention: "Needs setup",
  missing: "Not installed",
  unsupported: "Not used here",
};

function statusColor(d: DepReport): string {
  if (d.status === "ok") return "var(--success)";
  if (d.status === "attention") return "var(--warning)";
  if (d.status === "unsupported") return "var(--text3)";
  return d.required ? "var(--error)" : "var(--text3)";
}

/** Worst first: what is broken, then what is merely unconfigured, then the
 *  rest. Someone opening this pane is looking for the problem, not the list. */
const RANK: Record<DepStatus, number> = { missing: 0, attention: 1, ok: 2, unsupported: 3 };
const byUrgency = (a: DepReport, b: DepReport) =>
  (RANK[a.status] - RANK[b.status]) || (Number(b.required) - Number(a.required));

/**
 * The ones that are fine, at the size "fine" deserves.
 *
 * A tool that is ready has exactly two things to say — its name and that it is
 * ready — and a full row spends four lines saying them. Twelve of those is the
 * page nobody could scan. Here the dot carries the state and the name carries
 * the identity, and twelve of them fit in four lines. The `what` sentence is
 * not lost: it is in the title attribute, which is where a sentence you only
 * want occasionally belongs.
 */
function DepGrid({ deps, muted }: { deps: DepReport[]; muted?: boolean }) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", opacity: muted ? 0.6 : 1 }}>
      {deps.map((d) => (
        <span key={d.id} title={`${d.title} — ${d.what}`}
          className="flex items-center gap-2 px-2 py-1 rounded-lg min-w-0"
          style={{ border: EDGE, background: "color-mix(in srgb, var(--surface-inset) 50%, transparent)" }}>
          <span className="shrink-0 rounded-full" aria-hidden style={{ width: 6, height: 6, background: statusColor(d) }} />
          <span className="t-mono text-[11px] truncate" style={{ color: "var(--text2)" }}>{d.bin}</span>
        </span>
      ))}
    </div>
  );
}

/** A dependency's verdict as a badge. Not installed is neutral unless the app
 *  cannot work without it; "needs setup" is the person's turn. */
function depTone(d: DepReport): StatusTone {
  if (d.status === "ok") return "ok";
  if (d.status === "attention") return "warn";
  if (d.status === "missing" && d.required) return "err";
  return "off";
}

/** The page's two section labels ("On this machine", "Services"): a plain line of type between tiles, not a card. */
function FlowLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="m-0 mt-2 mb-3 text-[11px] uppercase tracking-wider" style={{ color: "var(--text3)", columnSpan: "all" }}>{children}</h3>;
}

/** A tile's mark: the first letter of what it is, in the page's hue. */
const Initial = ({ name }: { name: string }) => <span aria-hidden className="text-[12px] font-semibold">{name.charAt(0).toUpperCase()}</span>;

/** The first sentence: what a tile says at a glance, the rest being behind its Details. */
const firstSentence = (t: string) => t.split(/(?<=[.!?])\s/)[0] ?? t;

function DepRow({ d, home }: { d: DepReport; home: string }) {
  const href = externalUrl(d.url);
  const [console, setConsole] = useState(false);
  // Offered only where there is something to do AND a line worth typing. A tool
  // that is already there needs no console, and one whose install is a
  // repository rather than a package has no honest one-liner — those keep the
  // guide link they always had. See shared/deps.ts.
  // Not conditioned on having a root. An empty one is a perfectly good answer —
  // the server refuses a path it does not like and opens the shell somewhere of
  // its own choosing — and requiring one hid the button entirely from anyone who
  // had never opened the terminal panel, which is most people the first time
  // they read this page.
  const canType = !!d.install && d.status !== "ok" && d.status !== "unsupported";
  const guide = !!href && d.status !== "unsupported" && d.status !== "ok";
  const tone = depTone(d);
  const mark: "ok" | "warn" | "err" | "off" = tone === "warn" ? "warn" : tone === "err" ? "err" : tone === "ok" ? "ok" : "off";
  const more = !!(d.note && d.status !== "ok" && d.status !== "unsupported") || (canType && guide) || (d.status === "ok" && d.what);
  return (
    /* A tile per tool: its version under the name, then a line per fact. One action in its head: Install opens
       a shell with the command typed in, which finishes the job; when there is no
       honest one-liner the guide is the action instead, and where there are both
       the guide is a link in the details, so a tile never carries two buttons for one
       job. The console opens under the lines. Amber edge only while the person is
       needed (warn or err), never for a tool that is merely absent. */
    <SettingsCard icon={<Initial name={d.title} />} title={d.title}
      desc={d.status === "ok" ? d.detail : firstSentence(d.what)}
      tone={tone === "warn" || tone === "err" ? "decision" : "default"}
      status={<StatusBadge tone={tone}>{d.status === "missing" && d.required ? "Needed, not installed" : STATUS_LABEL[d.status]}</StatusBadge>}
      actions={canType
        ? <Button aria-expanded={console} onClick={() => setConsole((v) => !v)}
            title="Open a shell here with the command typed in — you press Enter">
            {console ? "Close shell" : "Install"}
          </Button>
        : guide
          ? <LinkButton href={href!}>Install guide</LinkButton>
          : undefined}>
      {/* "Needs setup" is a tool that IS here and cannot be used yet (gh with no login, docker with no daemon). */}
      <CheckRow tone={d.status === "ok" || d.status === "attention" ? "ok" : "off"} label="Installed"
        value={d.status === "ok" || d.status === "attention" ? <code className="t-mono">{d.bin}</code> : d.status === "unsupported" ? "not used here" : <>not on your PATH <span className="t-mono">({d.bin})</span></>} />
      {d.detail && d.status === "attention" && <CheckRow tone={mark} label="Needs" value={d.detail} />}
      {more && (
        <div className="agx-chk-more">
          <Disclosure summary={`More about ${d.title}`}>
            <p className="m-0">{d.what}</p>
            {d.note && d.status !== "ok" && d.status !== "unsupported" && <p className="m-0 mt-1">{d.note}</p>}
            {canType && guide && <p className="m-0 mt-1"><a href={href} target="_blank" rel="noreferrer noopener" className="agx-textlink">Install guide ↗</a></p>}
          </Disclosure>
        </div>
      )}
      {console && canType && <div className="agx-chk-more"><ShellConsole command={d.install!} cwd={home} onClose={() => setConsole(false)} /></div>}
    </SettingsCard>
  );
}

/*
 * Integrations: the services agentglass can be connected to.
 *
 * The Requirements pane next door answers "is this tool installed"; this one
 * answers "is this service connected". Same shape, different question, and
 * deliberately not the same component — a dependency has an install command and
 * a provider has a credential, and the two cards diverge the moment either
 * grows anything.
 *
 * One rule here, and it is the reason this pane can exist at all: a token is
 * typed in and never read back. There is no field showing what is stored,
 * because there is nothing to show — the server holds it and answers with who
 * you are.
 */
/**
 * What is left of GitHub's hourly budget.
 *
 * This app is made of `gh` calls — every pull-request list, every check, every
 * "which PRs mention this card" — against a budget that is invisible until it
 * runs out. When it does, nothing says "rate limited": the list is simply a
 * minute stale, twice, and then wrong.
 *
 * Three pots rather than one, because the small one is the one that bites:
 * Search is 30 a MINUTE against REST's 5,000 an hour, and searching is exactly
 * what looking up a card's pull requests does.
 */
function GhBudget({ open }: { open: boolean }) {
  const [state, setState] = useState<{ ok: boolean; error?: string; budgets?: { id: string; label: string; limit: number; remaining: number; reset: number }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try { setState(await api.ghRateLimit()); }
    catch { setState({ ok: false, error: "Could not reach the server" }); }
    finally { setBusy(false); }
  }, []);
  // On opening the pane, and never on a timer: a budget nobody is looking at is
  // a subprocess for nothing.
  useEffect(() => { if (open) void load(); }, [open, load]);

  return (
    <SettingsCard title="GitHub allowance" icon={<LinkIcon size={ICON.sm} />} desc="The API allowance this app spends, and what is left of it.">
      <SettingRow
        label="How much of your GitHub allowance is left"
        hint="Every pull request, check and search this app shows spends one."
        detail={{ summary: "Details", body: <>GitHub refills them on a rolling window — 5,000 an hour for REST and GraphQL, 30 a minute for Search, which is the one that runs out first because looking up a card's pull requests is a search.</> }}
        below={<>
        {state && !state.ok && (
          <p className="mt-2 text-[12px]" style={{ color: "var(--text3)" }}><Ticks>{state.error}</Ticks></p>
        )}
        {/* Three bars, the size the three real ones will be. `gh api` is a
            subprocess and a network round trip; without these the section is a
            heading over nothing until it answers, and then everything below it
            jumps down by 76 pixels. */}
        {!state && ["REST", "Search", "GraphQL"].map((label) => (
          <div key={label} className="mt-2" aria-hidden>
            <div className="agx-skeleton rounded" style={{ height: 14, width: label === "Search" ? 150 : 170 }} />
            <div className="agx-skeleton mt-1 rounded-full" style={{ height: 4 }} />
          </div>
        ))}
        {state?.budgets?.map((b) => {
          const left = b.limit ? b.remaining / b.limit : 0;
          // Amber under a quarter, red under a tenth: the point of the bar is
          // to be ignorable until it is not.
          const tint = left < 0.1 ? "var(--error)" : left < 0.25 ? "var(--warning)" : "var(--success)";
          const ink = left < 0.1 ? "var(--error-ink)" : left < 0.25 ? "var(--warning-ink)" : "var(--success-ink)";
          const mins = Math.max(0, Math.round((b.reset * 1000 - Date.now()) / 60_000));
          return (
            <div key={b.id} className="mt-2">
              {/* "5,000 of 5,000" next to a full bar reads as "you have used
                  all 5,000" — the number and the bar are both ambiguous about
                  which direction they run, and between them they cancel out.
                  The word `left` fixes both at once: it says what the number
                  is, and it makes a full bar mean a full tank. */}
              <div className="flex items-baseline gap-2 text-[12px]">
                <span style={{ color: "var(--text2)" }}>{b.label}</span>
                <span className="tabular-nums" style={{ color: ink }}>{b.remaining.toLocaleString()} left</span>
                <span className="tabular-nums t-dim">of {b.limit.toLocaleString()}</span>
                <span className="flex-1" />
                <span className="t-dim">{b.remaining >= b.limit ? "full" : `back to ${b.limit.toLocaleString()} in ${mins}m`}</span>
              </div>
              <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <div style={{ width: `${Math.round(left * 100)}%`, height: "100%", background: tint }} />
              </div>
            </div>
          );
        })}
        </>}
      />
      <SettingRow label="Refresh the GitHub budget" hint="Read on opening this page, never on a timer."
        control={<RefreshButton onRefresh={() => void load()} busy={busy} title="Refresh the GitHub budget" />} />
    </SettingsCard>
  );
}

/**
 * Where everything is, and what leaves.
 *
 * This page exists because "it is all local" is a claim, and a claim is worth
 * less than a path somebody can go and look at. So it names the three files,
 * says how long history is kept, and — the part these pages usually skip — is
 * specific about the traffic that DOES leave, which is not none.
 *
 * There is nothing to switch off about what leaves the machine, and that is the
 * finding rather than an omission: no analytics, no crash reporting, no
 * phone-home. A toggle that turned off something that was never running would be
 * theatre. The one switch here is about where tokens rest on disk (the keyring).
 */
function PrivacyPane({ open }: { open: boolean }) {
  const [d, setD] = useState<PrivacyFacts | null>(null);
  const [recent, setRecent] = useState<ActionRecord[] | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [erasing, setErasing] = useState<"ask" | "busy" | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  /* The keyring row: what the server says, the value a move is heading to while it runs, and why a move did not happen. */
  const [kr, setKr] = useState<KeyringState | null>(null);
  const [moving, setMoving] = useState<boolean | null>(null);
  const [krErr, setKrErr] = useState<string | null>(null);
  const [checkingAgain, setCheckingAgain] = useState(false);
  const load = useCallback(() => { void api.privacy().then(setD).catch(() => setD(null)); }, []);
  const loadKeyring = useCallback(() => {
    void api.keyring().then(setKr).catch(() => setKr({ enabled: false, state: "unavailable", why: "the server did not answer", held: 0 }));
  }, []);
  useEffect(() => {
    if (!open) return;
    load();
    loadKeyring();
    void api.actions(3).then((r) => setRecent(r.actions)).catch(() => setRecent([]));
  }, [open, load, loadKeyring]);

  /* A move rewrites every stored token, so it is one request that either finishes or leaves both copies where they were. */
  const toggleKeyring = async () => {
    if (!kr) return;
    const to = !kr.enabled;
    setMoving(to); setKrErr(null);
    const r = await api.keyringToggle(to).catch(() => null);
    setMoving(null);
    if (!r?.ok) setKrErr(moveFailed(r?.error));
    loadKeyring();
  };
  const checkKeyringAgain = async () => {
    setCheckingAgain(true);
    await api.keyringRehydrate().catch(() => null);
    setCheckingAgain(false);
    loadKeyring();
  };
  const kv = keyringRow(kr, moving);

  /* The history kept, and how long: a shorter time deletes what is older at the next hourly sweep, so it asks first. */
  const RETENTION_CHOICES = [{ v: 8, label: "8 days" }, { v: 30, label: "30 days" }, { v: 90, label: "90 days" }, { v: 365, label: "1 year" }, { v: 0, label: "Keep everything" }];
  const choices = d && !RETENTION_CHOICES.some((c) => c.v === d.retentionDays) ? [...RETENTION_CHOICES, { v: d.retentionDays, label: `${d.retentionDays} days` }] : RETENTION_CHOICES;
  const shorter = (days: number) => !!d && days !== 0 && (d.retentionDays === 0 || days < d.retentionDays);
  const chooseRetention = async (days: number) => {
    if (!d || days === d.retentionDays) return;
    if (shorter(days)) { setAsking(days); return; }
    const r = await api.privacyRetention(days).catch(() => null);
    setNote(r?.ok ? { ok: true, text: days === 0 ? "History is kept for ever from now on." : `History is kept ${days} days.` } : { ok: false, text: r?.error ?? "That did not save." });
    load();
  };
  const confirmRetention = async () => {
    if (asking === null) return;
    const days = asking;
    setAsking(null);
    const r = await api.privacyRetention(days).catch(() => null);
    setNote(r?.ok ? { ok: true, text: `History is kept ${days} days. Anything older goes at the next sweep, within the hour.` } : { ok: false, text: r?.error ?? "That did not save." });
    load();
  };
  const erase = async () => {
    setErasing("busy");
    const r = await api.privacyErase().catch(() => null);
    setErasing(null);
    setNote(r?.ok ? { ok: true, text: `Erased ${r.events ?? 0} events and ${r.sessions ?? 0} sessions.` } : { ok: false, text: r?.error ?? "That did not work. Nothing was erased." });
    load();
  };

  const timeOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const size = (n: number | null | undefined) => (n === null || n === undefined ? "unknown size" : humanBytes(n));
  const timer = IS_DESKTOP && autoCheckUpdates();
  const DL = <IconLabel icon={<DownloadIcon size={ICON.xs} />}>Download</IconLabel>;
  useReportSaving("privacy", erasing === "busy" || moving !== null);

  return (
    <>
      <SettingsCard title="Nothing is sent anywhere" icon={<ShieldIcon />} status={<StatusBadge tone="ok">Local only</StatusBadge>}
        desc="No analytics, no crash reporting, no phone-home.">
        {/* The headline answer is one line and stays open, because it is the
            claim this page exists to make. The enumeration behind it is the
            evidence, and evidence is read when it is doubted. */}
        <SettingRow
          label="What does leave this machine"
          hint="Only the calls you asked for."
          detail={{
            summary: "Which calls, exactly",
            body: <>
              {d && d.pairedDevices > 0
                ? `${d.pairedDevices} paired device${d.pairedDevices === 1 ? " can" : "s can"} reach this server — see Remote. `
                : "No device is paired, so nothing can reach this server from outside. "}
              GitHub through <code>gh</code>, {d?.clickup ? "ClickUp through its API, " : ""}{d?.jira ? "Jira through its API, " : ""}and whatever an agent you started
              decides to do. Avatars are fetched from GitHub. Nothing else leaves, and nothing at all is
              sent to us — there is no endpoint of ours for it to go to.
            </>,
          }}
        />
        <SettingRow label="Code hosting" hint="pull requests, checks, comments, through gh"
          status={<StatusBadge tone="info">When you open them</StatusBadge>} />
        {d?.clickup && <SettingRow label="ClickUp API" hint="cards, statuses" status={<StatusBadge tone="info">When you open them</StatusBadge>} />}
        {d?.jira && <SettingRow label="Jira API" hint="cards, statuses" status={<StatusBadge tone="info">When you open them</StatusBadge>} />}
        <SettingRow label="Update check" hint="release feed"
          status={timer ? <StatusBadge tone="info">Every 6 hours</StatusBadge> : <StatusBadge tone="off">Only on request</StatusBadge>} />
      </SettingsCard>

      <SettingsCard title="What is on disk" icon={<ServerIcon />} desc="Everything lives in your home folder."
        status={note ? <StatusBadge tone={note.ok ? "ok" : "err"}>{note.ok ? "Saved" : "Not saved"}</StatusBadge> : undefined}>
        <SettingRow label="History" hint="events and sessions"
          control={<span className="tabular-nums text-[13px]" style={{ color: "var(--text2)" }}>{size(d?.dbBytes)}</span>}
          detail={{ summary: "Where it is, and what it holds", body: <>Every event, prompt, tool call and file change, in SQLite, written owner-only: it holds prompts and command output in cleartext.<span className="block mt-1 t-mono break-all">{d?.db || "—"}</span></> }} />
        <SettingRow label="Settings" hint="this window"
          control={<span className="tabular-nums text-[13px]" style={{ color: "var(--text2)" }}>{size(d?.configBytes)}</span>}
          detail={{ summary: "Where it is, and what it holds", body: <>Your preferences, budgets and the boards you have added.<span className="block mt-1 t-mono break-all">{d?.config || "—"}</span></> }} />
        <SettingRow label="Credentials" hint="tokens of the services you connected"
          control={<span className="text-[13px]" style={{ color: "var(--text2)" }}>{credentialsWhere(kr)}</span>}
          detail={{ summary: "Where it is, and who reads it", body: <>Tokens for the services you connected, mode 0600. The server uses them and never sends them to the browser.<span className="block mt-1 t-mono break-all">{d?.credentials || "—"}</span></> }} />
        {/* The badge sits before the switch and "Check again" drops under the words, so the switch is in the same place in every state. */}
        <SettingRow settingId="secrets.keyring" label="Keep secrets in the system keyring" hint={kv.hint}
          disabled={kr?.state === "unavailable"}
          status={kv.badge ? <StatusBadge tone="info">{kv.badge}</StatusBadge> : undefined}
          actions={<SwitchButton on={kv.on} busy={moving !== null} disabled={kv.disabled} label="Keep secrets in the system keyring" onClick={() => void toggleKeyring()} />}
          detail={{ summary: "What moves, and what does not", body: <>Turning it on moves the tokens of the services you connected and your plugin keys into the Secret Service (GNOME Keyring, KWallet). Each one is read back and compared before the file copy is blanked. If anything fails, both copies stay where they were. Tokens that other tools own (gh, Claude) are not touched. This protects a copied disk or backup, not a program on this computer: an unlocked keyring hands any secret to any program running as you. What keeps plugins away from your secrets is their box. Linux only. While it is locked, a feature that needs a token says so and waits.</> }}
          below={kv.checkAgain || krErr ? (
            <span className="flex flex-wrap items-center gap-2">
              {kv.checkAgain && <Button pending={checkingAgain} onClick={() => void checkKeyringAgain()}>Check again</Button>}
              {krErr && <span role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{krErr}</span>}
            </span>
          ) : undefined} />
        {d && (
          <SettingRow settingId="privacy.retentionDays" label="Retention"
            hint={d.retentionFromEnv ? "Set by AGENTGLASS_RETENTION_DAYS where the server started: it wins over this page." : "How long history stays before the daily totals replace it."}
            detail={{ summary: "What a shorter time does", body: <>Raw events older than the time you choose are folded into the daily totals and deleted at the next hourly sweep. Choosing a longer time keeps what is still there; it brings nothing back. Deleting the history file deletes all of it.</> }}
            control={<Select align="right" style={SELECT_BOX} value={String(d.retentionDays)} disabled={d.retentionFromEnv} title="How long history is kept"
              onChange={(v) => void chooseRetention(Number(v))} options={choices.map((c) => ({ value: String(c.v), label: c.label }))} />}
            below={asking !== null ? (
              <div className="flex items-center gap-2 flex-wrap text-[12px]" role="alert" style={{ color: "var(--warning-ink)" }}>
                <span className="flex-1 min-w-0">Keep {asking} days? History older than that is deleted within the hour.</span>
                <Button onClick={() => setAsking(null)}>Cancel</Button>
                <Button tone="danger" onClick={() => void confirmRetention()}>Keep {asking} days</Button>
              </div>
            ) : note && !note.ok ? <span role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{note.text}</span> : undefined} />
        )}
      </SettingsCard>

      <SettingsCard title="Activity log" icon={<ChecklistIcon />} desc="What the app itself has been doing.">
        {/* Activity has no nav entry; this card and the palette are its ways in. */}
        {(recent ?? []).map((a) => (
          <SettingRow key={a.id} agentExempt label={<>{verb(a.action)}{a.target && <span className="t-dim"> {a.target}</span>}</>}
            control={<span className="tabular-nums text-[12px] t-dim">{timeOf(a.at)}</span>} />
        ))}
        <SettingRow label="Activity log" hint="Every change this dashboard made, newest first." onClick={() => openSettings("log")} />
      </SettingsCard>

      <SettingsCard title="Take your data out" icon={<DownloadIcon />}
        desc="Everything this app has recorded, in a format something else can read.">
        {/* Scoped like everything else: with a project open these
            carry that project's rows, not the whole machine's. */}
        <SettingRow agentExempt label="Events — CSV" hint="One row per event, for a spreadsheet" actions={<DownloadButton href={api.exportUrl("csv")} download="agentglass-events.csv">{DL}</DownloadButton>} />
        <SettingRow agentExempt label="Events — JSON" hint="Full payloads, for scripting" actions={<DownloadButton href={api.exportUrl("json")} download="agentglass-events.json">{DL}</DownloadButton>} />
        {/* The only export that outlives retention: it reads the daily rollup as well as the live events, so a month that has already been pruned still comes out. */}
        <SettingRow agentExempt label="Daily totals — CSV" hint="One row per day, back past the retention window" actions={<DownloadButton href={api.exportUrl("csv", "daily")} download="agentglass-daily.csv">{DL}</DownloadButton>} />
        <SettingRow agentExempt label="Daily totals — JSON" hint="The same series, with where the retention seam falls" actions={<DownloadButton href={api.exportUrl("json", "daily")} download="agentglass-daily.json">{DL}</DownloadButton>} />
        <SettingRow agentExempt label="Skills catalog — Markdown" hint="Every skill the fleet has available" actions={<DownloadButton href={api.skillsExportUrl()} download="agentglass-skills.md">{DL}</DownloadButton>} />
      </SettingsCard>

      {/* Reversible only from a backup: the one red thing on the page, apart from everything that only reads. */}
      <SettingsCard title="Danger zone" tone="danger" icon={<WarningIcon size={ICON.sm} />} desc="Reversible only from a backup.">
        <SettingRow agentNever="erases the person's history for good: only the person at the window decides what it is worth" label="Erase local history"
          hint="Removes events, sessions, the daily totals and finished orchestrator and understudy history. Settings and tokens stay."
          actions={erasing === "ask" ? (
            <>
              <Button tone="danger" onClick={() => void erase()}>Erase for good</Button>
              <Button onClick={() => setErasing(null)}>Keep it</Button>
            </>
          ) : <Button tone="danger" pending={erasing === "busy"} onClick={() => setErasing("ask")}>Erase history</Button>}
          below={note?.ok && note.text.startsWith("Erased") ? <span role="status" className="text-[12px]" style={{ color: "var(--success-ink)" }}>{note.text}</span> : undefined} />
      </SettingsCard>
    </>
  );
}

type ToolsFilter = "all" | "ready" | "needs";
type ToolsCount = { total: number; ready: number; needs: number; busy: boolean };

function IntegrationsPane({ open, filter, nonce, onCount }: { open: boolean; filter: ToolsFilter; nonce: number; onCount: (c: ToolsCount) => void }) {
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.providers();
      setStatus(r.providers); setErr(null);
    } catch { setErr("Could not read the integrations"); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => { if (open && nonce) void load(); }, [nonce]);
  useReportProblem("connections", err ? { chip: "Not read", title: err } : null, load);

  /*
   * Come back for the slow half.
   *
   * The statuses answer in under half a second because ClickUp's task count —
   * ten seconds of ClickUp's own latency — is left for the server to fetch
   * behind the answer. Something has to come back for it, or the row says
   * "counting your tasks…" until you close the dialog and open it again, which
   * is an ellipsis that never resolves. Stops the moment nothing is pending, so
   * a page left open is not a poller.
   */
  const pending = !!status?.some((s) => s.pending);
  useEffect(() => {
    if (!open || !pending) return;
    const t = setTimeout(() => { void load(); }, 3000);
    return () => clearTimeout(t);
  }, [open, pending, status, load]);

  const statusOf = (id: string) => status?.find((x) => x.id === id) ?? null;

  /* One tile per provider under one verdict and one recheck. The provider list
     is a constant (shared/providers.ts), so every tile draws at once and only
     the badges wait for the answer. */
  const all = status?.filter((x) => PROVIDERS.some((p) => p.id === x.id)) ?? null;
  const ok = all?.filter((x) => x.state === "connected").length ?? 0;
  const bad = all?.filter((x) => x.state === "error").length ?? 0;
  const readyN = ok, needsN = bad;
  useEffect(() => { onCount({ total: PROVIDERS.length, ready: readyN, needs: needsN, busy }); }, [readyN, needsN, busy]);
  const shown = (id: string) => {
    const st = statusOf(id)?.state;
    return filter === "all" || (filter === "ready" ? st === "connected" : st === "error");
  };
  return (
    <>
      {filter === "all" && <FlowLabel>Services</FlowLabel>}
      {err && (
        <SettingsCard title="Services" icon={<PlugIcon size={ICON.sm} />} tone="error" wide>
          <ProblemNote title={err} action={<Button pending={busy} onClick={() => void load()}>Try again</Button>}>The local server did not answer, so no service could be checked.</ProblemNote>
        </SettingsCard>
      )}
      {PROVIDERS.filter((p) => shown(p.id)).map((p) => (
        <ProviderCard key={p.id} spec={p} status={statusOf(p.id)} checking={!status && !err} onChanged={load} />
      ))}
    </>
  );
}

/** Four states, four sentences. A boolean here would flatten "installed but
 *  logged out" into "broken", and those need different buttons. */
const STATE_LOOK: Record<ProviderState, { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "ok" },
  /* Neutral, not a warning: an optional service nobody has connected is not
     a problem, and amber on every unconnected row is a page that cries wolf. */
  "needs-auth": { label: "Not connected", tone: "off" },
  "missing-tool": { label: "Not installed", tone: "off" },
  error: { label: "Needs attention", tone: "err" },
};

/*
 * How tall each card was last time.
 *
 * A skeleton whose job is to stop the page moving has to be the size of the
 * thing it stands in for, and these are not one size: measured, the four cards
 * settle at 111, 135, 151 and 218 pixels, because one has a note, one has a
 * token field and one has two buttons — and which of those appear depends on
 * the very answer we are waiting for. There is no number to hard-code.
 *
 * So each card remembers its own. The first time you ever open the page it
 * still jumps; every time after that it does not, and a card that changes
 * shape corrects itself on the next open. Kept in localStorage rather than in
 * memory because "the first open" would otherwise mean the first open of every
 * session, which is most of them.
 */
const CARD_H_KEY = "agx.settings.providerCardH";

function rememberedHeights(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(CARD_H_KEY) || "{}") as Record<string, number>; }
  catch { return {}; }
}

function rememberHeight(id: string, px: number): void {
  // Rounded to 4px so a one-pixel reflow does not write on every render.
  const h = Math.round(px / 4) * 4;
  const all = rememberedHeights();
  if (all[id] === h || h < 40) return;
  try { localStorage.setItem(CARD_H_KEY, JSON.stringify({ ...all, [id]: h })); } catch { /* private mode */ }
}

function ProviderCard({ spec, status, checking, onChanged }: {
  spec: ProviderSpec; status: ProviderStatus | null;
  /** Nothing is known about this one yet. Different from `status === null`
   *  after a failed load, and very different from "not connected" — which is
   *  what the badge used to claim for a card that had simply not answered. */
  checking?: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<{ id: string; name: string }[] | null>(null);
  /* Disconnecting ClickUp asks one question first: the saved boards are the
     person's own list and survive by default. Other providers have nothing to
     ask, so they go straight through as they always did. */
  const [confirming, setConfirming] = useState(false);
  const [forgetBoards, setForgetBoards] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const waiting = !!checking && !status;
  // Measured after the answer has landed and the card is its real size — never
  // while it is standing in for itself, which would freeze the placeholder's
  // own height in as the truth.
  useEffect(() => {
    if (waiting || !box.current) return;
    // The card's body: what the placeholder row stands in for.
    const card = box.current.closest(".agx-scard");
    const head = card?.querySelector(".agx-scard-head");
    if (card && head) rememberHeight(spec.id, card.getBoundingClientRect().height - head.getBoundingClientRect().height);
  });

  // A card with no answer yet must not claim one. Showing "Not connected"
  // while the check is still running is a wrong answer that then corrects
  // itself, which is worse than no answer at all — somebody reads it, believes
  // it, and starts pasting a token they did not need.
  const look: { label: string; tone: StatusTone } = waiting
    ? { label: "Checking", tone: "checking" }
    : STATE_LOOK[status?.state ?? "needs-auth"];
  const connected = status?.state === "connected";
  /* Jira has a page of its own (JiraPane) where it connects and disconnects: here it is a verdict and a way in. */
  const isJira = spec.id === "jira";
  const wantsToken = spec.auth === "token" && !isJira;
  /* Empty while the check is still out: a row that has not answered yet has
     nothing to be stale about, and "Checked at 14:32" beside "Checking" is a
     contradiction on one line. */
  const checked = waiting ? "" : checkedLine(status?.at);

  const ready = !!token.trim();
  const connect = async () => {
    if (!ready) return;
    setBusy(true);
    const r = await api.providerConnect(spec.id, token.trim());
    setBusy(false);
    if (!r.ok) { setNote(r.error ?? "That did not work"); return; }
    // Cleared on success and only on success: a refused token is usually one
    // that was pasted short, and retyping it is a chore nobody needs.
    setToken(""); setNote(null);
    if (spec.id === "clickup") { __forgetClickupSetup(); __forgetClickupPrefs(); __forgetClickupSpaces(); }
    await onChanged();
  };
  const changeWorkspace = async () => {
    const r = await api.providerWorkspaces(spec.id);
    if (!r.ok) { setNote(r.error ?? "Could not read the workspaces"); return; }
    setSpaces(r.workspaces ?? []);
  };

  const ids = `prov-${spec.id}`;
  // The form: stacked fields, labelled, with the one Connect at the end and
  // the refusal under it.
  const form = wantsToken && !connected && !waiting ? (
    <SettingsForm label={`Connect ${spec.title}`} onSubmit={() => void connect()}>
      {/* `type=password`, and there is nothing to reveal: the value here is
          what you are typing, never what is stored. */}
      <Field label="Personal API token"
        htmlFor={`${ids}-token`}
        link={spec.help ? { href: spec.help, text: "How to get one" } : undefined}
        help={spec.id === "clickup" ? "In ClickUp: your avatar, Settings, Apps. It starts with pk_." : undefined}>
        <input id={`${ids}-token`} type="password" value={token} onChange={(e) => setToken(e.target.value)}
          placeholder="Paste the token" spellCheck={false} autoComplete="off"
          aria-describedby={helpIdFor(`${ids}-token`)}
          className={`w-full ${INPUT}`} style={INPUT_STYLE} />
      </Field>
      <div className="agx-field">
        <div className="agx-sform-actions">
          <Button type="submit" tone="primary" pending={busy} disabled={!ready}>Connect</Button>
        </div>
        {note && <div role="alert" className="agx-field-e">{note}</div>}
      </div>
    </SettingsForm>
  ) : null;

  /* Disconnecting ClickUp asks first, in the place the action was. */
  const confirm = spec.id === "clickup" && connected && confirming ? (
    <div className="flex items-center gap-3 flex-wrap text-[12px] rounded-lg" style={{ color: "var(--text2)" }}>
      <label className="inline-flex items-center gap-2 cursor-pointer">
        <SwitchButton on={forgetBoards} onClick={() => setForgetBoards((v) => !v)} label="Forget saved boards too" />
        <span>Forget saved boards too</span>
      </label>
      <span className="flex-1" />
      <Button disabled={busy} onClick={() => { setConfirming(false); setForgetBoards(false); }}>Cancel</Button>
      <Button tone="danger" pending={busy}
        onClick={async () => {
          setBusy(true); await api.providerDisconnect(spec.id, { forgetBoards }); setBusy(false);
          // The sidebar's copies of "connected" and of each card are held for a minute.
          __forgetClickupSetup(); __forgetClickupPrefs(); __forgetClickupSpaces(); forgetCards();
          setConfirming(false); setForgetBoards(false); setSpaces(null); await onChanged();
        }}>
        Disconnect ClickUp
      </Button>
    </div>
  ) : null;

  const workspaces = spaces ? (
    <div className="flex flex-col gap-0.5 rounded-lg p-1" role="list" aria-label="Workspaces" style={{ background: "var(--surface-inset)", border: LINE }}>
      {!spaces.length && <div className="text-[12px] px-2 py-1 t-dim2">This token can see no workspaces.</div>}
      {spaces.map((w) => (
        <button key={w.id} type="button" role="listitem"
          onClick={async () => { await api.providerWorkspace(spec.id, w.id, w.name); if (spec.id === "clickup") { __forgetClickupSetup(); __forgetClickupSpaces(); } setSpaces(null); await onChanged(); }}
          className="agx-hover text-left text-[12px] px-2 rounded-md" style={{ color: "var(--text2)", minHeight: HIT }}>
          {w.name}
        </button>
      ))}
    </div>
  ) : null;

  const below = form || confirm || workspaces || (connected && note)
    ? <div className="flex flex-col gap-3">
        {form}
        {confirm}
        {workspaces}
        {connected && note && <div role="alert" className="agx-field-e">{note}</div>}
      </div>
    : undefined;

  return (
    /*
     * One tile per provider. The badge is in the head in every state and so is
     * the one action (Manage, or Disconnect once connected); everything
     * conditional (the form, the confirmation, the workspace list) is the
     * body's stacked slot, so a tile with nothing to add is one row, and one
     * that grows does it under itself. Amber edge only while the person is
     * needed: a refused token, never an optional service nobody connected.
     */
    <SettingsCard icon={<Initial name={spec.title} />} title={spec.title} desc={spec.what}
      tone={look.tone === "err" ? "decision" : "default"}
      status={<StatusBadge tone={look.tone}>{look.label}</StatusBadge>}
      actions={isJira && !waiting
        ? <Button onClick={() => openSettings("jira")}>{connected ? "Manage" : "Set up"}</Button>
        : !waiting && connected && wantsToken
        ? <Button tone="danger" aria-expanded={spec.id === "clickup" ? confirming : undefined}
            disabled={busy || confirming}
            onClick={async () => {
              if (spec.id === "clickup") { setConfirming(true); return; }
              setBusy(true); await api.providerDisconnect(spec.id); setBusy(false); setSpaces(null); await onChanged();
            }}>
            Disconnect
          </Button>
        : undefined}>
      {waiting ? (
        <SettingRow agentExempt rowRef={box} minHeight={rememberedHeights()[spec.id] ?? 56} label="Checking…"
          hint={<span className="agx-skeleton block mt-1 rounded" style={{ height: 13, maxWidth: 240 }} aria-hidden />} />
      ) : (
        <>
          {/* The verdict's own words: who you are signed in as, what is wrong, what is left to do. */}
          <CheckRow tone={connected ? "ok" : look.tone === "err" ? "err" : "off"} label={connected ? "Account" : look.label}
            value={status?.detail ?? (connected ? undefined : "no token yet")} />
          {/* When that verdict was actually taken. The row above is read from a
              cache — deliberately, because asking ClickUp live costs ten
              seconds of its latency for a question the token answers — and a
              cached verdict drawn with no date claims to be a live one. */}
          {checked && <CheckRow tone="off" label="Checked" value={checked.replace(/^Checked\s*/i, "")} />}
          {/* Half of a provider can be down while the other half looks fine —
              the ClickUp card bell fails on its own six-minute timer. Warning
              ink and its own line, because it qualifies the verdict instead
              of being it: a connected row with a broken bell is still connected. */}
          {status?.notice && <CheckRow tone="warn" label="Notice" value={status.notice} />}
          {connected && spec.id === "clickup" && (
            <div className="agx-chk-more">
              <button type="button" className="agx-textlink" onClick={() => void changeWorkspace()}>Change workspace</button>
              {" · "}
              <button type="button" className="agx-textlink" onClick={() => openSettings("clickup")}>Workflow and boards</button>
            </div>
          )}
          {/* The standing caveat about a provider — true whether or not you ever
              connect it, and read once — behind a summary that says what it is. */}
          {spec.note && !connected && !isJira && (
            <div className="agx-chk-more"><Disclosure summary={spec.noteTitle ?? "About the credential"}>{spec.note}</Disclosure></div>
          )}
          {below && <div className="agx-chk-more">{below}</div>}
          <div ref={box} hidden />
        </>
      )}
    </SettingsCard>
  );
}

function RequirementsPane({ open, filter, nonce, onCount }: { open: boolean; filter: ToolsFilter; nonce: number; onCount: (c: ToolsCount) => void }) {
  /**
   * Where the install shell opens.
   *
   * The terminal panel's own remembered checkout, and it does not really
   * matter: a system package install behaves the same from anywhere — the
   * literal command is deliberately not written here, since a package-manager
   * line living in a component is exactly what deps.test.ts forbids, and being
   * a comment does not make it age any better. What matters
   * is that the server VETS it — a root that is not a repository in scope is
   * refused and replaced with its own fallback — so this passes the path the
   * user already has a shell in rather than inventing one and pushing on the
   * boundary that exists to stop exactly that.
   */
  // Through TerminalPanel's own reader, not the raw key. A literal here is a
  // second copy of somebody else's storage schema, and it would have gone on
  // reading a key that had quietly stopped being written.
  const shellRoot = lastTerminalRoot();

  /* These two belong to this pane and had come adrift: they were sitting at the
     top level of the module, between the pane above and SettingsModal. A hook
     at module scope runs when the file is IMPORTED, where React has no
     dispatcher — so `useState` read `null.useState`, the renderer threw before
     it drew anything, and the window stayed on "loading the interface…". */
  const [deps, setDeps] = useState<DepReport[] | null>(null);
  const [platform, setPlatform] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (force: boolean) => {
    setBusy(true); setErr(null);
    return api.dependencies(force)
      .then((r) => { setDeps(r.deps); setPlatform(r.platform); })
      .catch(() => setErr("Could not reach the server, so nothing could be checked."))
      .finally(() => setBusy(false));
  };

  // Probed on open rather than at startup: it costs a handful of PATH lookups
  // plus two cached subprocess answers, and nothing outside this pane wants it.
  useEffect(() => { if (open) void load(false); }, [open]);
  useEffect(() => { if (open && nonce) void load(true); }, [nonce]);
  useReportProblem("connections", err ? { chip: "Not checked", title: err } : null, () => void load(true));
  useEffect(() => {
    const live = (deps ?? []).filter((d) => d.status !== "unsupported");
    onCount({ total: live.length, ready: live.filter((d) => d.status === "ok").length, busy,
      needs: live.filter((d) => d.status === "attention" || (d.status === "missing" && d.required)).length });
  }, [deps, busy]);

  const recheck = <Button pending={busy} onClick={() => void load(true)}>Recheck</Button>;
  const desc = <>
    agentglass drives the tools you already have instead of bundling its own
    {platform && platform !== "demo" ? <> (<span className="t-mono text-[11px]">{platform}</span>)</> : null}.
    Install what is missing the way you usually install software here, then recheck.
  </>;
  /* The card, its verdict and the recheck are on screen in every state —
     checking, failed, answered — so nothing moves when the answer lands and
     the button is always where it was. */
  if (err || !deps) {
    return (
      <SettingsCard title="On this machine" icon={<ServerIcon size={ICON.sm} />} desc={desc} tone={err ? "error" : "default"}
        status={<StatusBadge tone={err ? "err" : "checking"}>{err ? "Not checked" : "Checking"}</StatusBadge>}
        actions={recheck}>
        {err
          ? <ProblemNote title="Nothing could be checked">{err} Recheck to try again.</ProblemNote>
          : <EmptyState>Checking this machine…</EmptyState>}
      </SettingsCard>
    );
  }

  const live = deps.filter((d) => d.status !== "unsupported");
  const idle = deps.filter((d) => d.status === "unsupported");
  // Split by whether it wants something, not by whether it is required: a
  // required tool that is present has nothing to say, and an optional one that
  // is missing is the whole reason somebody opened this page.
  const wants = live.filter((d) => d.status !== "ok").sort(byUrgency);
  const ready = live.filter((d) => d.status === "ok").sort((a, b) => a.title.localeCompare(b.title));

  /* Needs you is what the person must act on: a needed tool missing, a tool that is there and not usable.
     An optional tool nobody installed is neutral: it is in All, under its own tile. */
  const needs = (d: DepReport) => d.status === "attention" || (d.status === "missing" && d.required);
  const tiles = filter === "ready" ? [] : filter === "needs" ? wants.filter(needs) : wants;
  return (
    /* Only what wants something gets a tile (the status, the lines, the install); the ones that
       are ready collapse into one card, where a name and a dot are enough. */
    <>
      {filter === "all" && <FlowLabel>On this machine</FlowLabel>}
      {tiles.map((d) => <DepRow key={d.id} d={d} home={shellRoot} />)}

      {filter !== "needs" && (ready.length > 0 || idle.length > 0) && (
        <SettingsCard title={wants.length ? "Ready" : "Everything found"} icon={<ServerIcon size={ICON.sm} />}
          status={<StatusBadge tone="ok">{ready.length} ready</StatusBadge>}>
          {ready.length > 0 && (
            <Fold label={wants.length ? `${ready.length} more ready` : `${ready.length} ready`} defaultOpen={filter === "ready"}
              hint="Everything else agentglass looks for, and found.">
              <DepGrid deps={ready} />
            </Fold>
          )}

          {idle.length > 0 && (
            <Fold label={`${idle.length} not used on ${platform}`}
              hint="This platform never asks for these, so there is nothing to install.">
              <DepGrid deps={idle} muted />
            </Fold>
          )}
        </SettingsCard>
      )}
    </>
  );
}

/** Tools & services: what this machine has and what the services say, under one filter and one Recheck. */
function ToolsPane({ open }: { open: boolean }) {
  const [filter, setFilter] = useState<ToolsFilter>("all");
  const [nonce, setNonce] = useState(0);
  const [deps, setDeps] = useState<ToolsCount>({ total: 0, ready: 0, needs: 0, busy: false });
  const [provs, setProvs] = useState<ToolsCount>({ total: 0, ready: 0, needs: 0, busy: false });
  const ready = deps.ready + provs.ready, needs = deps.needs + provs.needs, total = deps.total + provs.total;
  useReportHead("connections", total ? { chips: [{ tone: "ok", text: `${ready} ready` }, ...(needs ? [{ tone: "warn" as const, text: `${needs} need you` }] : [])] } : null);
  return (
    <>
      <div className="agx-tools-bar">
        <SegControl<ToolsFilter> label="Show" value={filter} onPick={setFilter}
          options={[{ v: "all", label: `All ${total}` }, { v: "ready", label: `Ready ${ready}` }, { v: "needs", label: `Needs you ${needs}` }]} />
        <span className="flex-1" />
        <Button pending={deps.busy || provs.busy} onClick={() => setNonce((n) => n + 1)}>
          <IconLabel icon={<RefreshIcon size={ICON.xs} />}>Recheck</IconLabel>
        </Button>
      </div>
      <RequirementsPane open={open} filter={filter} nonce={nonce} onCount={setDeps} />
      <IntegrationsPane open={open} filter={filter} nonce={nonce} onCount={setProvs} />
    </>
  );
}

/**
 * The pane engine's tmux: which binary, what config, and the reboot restore.
 *
 * Everything tmux's own bar used to own — tabs, splits, the status line — is
 * the agentglass UI's job now, so this pane is about the engine itself: where
 * the binary comes from, whether the generated config is healthy (and can be
 * reset when it is not), and how much of the layout survives a reboot.
 */
/**
 * The keys people actually move the prefix to, in tmux's spelling.
 *
 * C-a because screen used it and half the world's fingers still expect it, C-f
 * and C-space because they are the two chords least likely to be taken by a
 * shell or an editor. Anything else goes through "Custom" — the server refuses
 * a value that is not a key name, since it lands in a config file tmux runs.
 */
const PREFIXES: { value: string; label: string }[] = [
  { value: "", label: "C-b (tmux default)" },
  { value: "C-a", label: "C-a (screen)" },
  { value: "C-f", label: "C-f" },
  { value: "C-Space", label: "C-Space" },
];

/** "Terminal runs on", moved here from the tmux page: it decides what the
 *  Terminal view does, and nobody looking for it thinks of tmux first. Same
 *  call and same server key as before. */
/**
 * Launch permissions: the mode and the deny list every terminal the app opens
 * starts its agent with (server/src/launchperm.ts). Held by the server, and
 * `agentNever`: loosening it is an escalation for every agent started after,
 * so an agent reads it (GET /launch-permissions) and never writes it.
 */
function LaunchPermissionsCard({ open }: { open: boolean }) {
  const [mode, setMode] = useState<LaunchMode>("default");
  const [deny, setDeny] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    api.launchPermissions().then((r) => {
      setMode(r.mode); setDeny(r.deny.join("\n")); setSaved(r.deny.join("\n")); setErr(null);
      setLaunchPermissions({ mode: r.mode, deny: r.deny });
    }).catch(() => setErr("Could not reach the server — this setting is unavailable."));
  }, [open]);
  const phase = useSavePhase("terminal", busy, !!err);
  const save = (p: { mode?: LaunchMode; deny?: string }) => {
    setBusy(true); setNote(null); setErr(null);
    api.launchPermissionsSave(p)
      .then((r) => {
        if (!r.ok) { setErr(r.error ?? "Could not save that."); return; }
        setMode(r.mode); setDeny(r.deny.join("\n")); setSaved(r.deny.join("\n"));
        setLaunchPermissions({ mode: r.mode, deny: r.deny });
        setNote("Saved. The next terminal the app opens starts this way; the ones already open keep how they started.");
      })
      .catch(() => setErr("Could not save — server unreachable."))
      .finally(() => setBusy(false));
  };
  const bad = parseDenyRules(deny).bad;
  useEffect(() => { setPageFact("unsavedRules", deny !== saved ? 1 : 0); return () => setPageFact("unsavedRules", 0); }, [deny, saved]);
  return (
    <SettingsCard title="Launch permissions" icon={<ShieldIcon size={ICON.sm} />} status={<SaveChip phase={phase} />} desc="What an agent may do when a terminal starts it. A rule here beats a tab's own permission mode.">
      <SettingRow
        agentNever="the permission mode every agent the app starts runs in: loosening it is an escalation, so only the owner changes it"
        label="Permission mode"
        hint="Applies to every terminal that starts an agent."
        detail={{
          summary: "What each mode does",
          body: <>This covers Review with Claude, a hand-off, an issue, a resumed session and a Command that runs claude; a review prompt or a Command can choose its own in its editor. Ask is Claude Code's own default: it asks before a tool it has not been allowed. Auto lets it decide what is safe to run. Accept edits runs file edits without asking. Bypass runs everything without asking — a tab in another mode than your other agents holds what is sent to it until somebody answers in it.</>,
        }}
        wide
        control={<SegControl label="Permission mode" value={mode} disabled={busy}
          onPick={(v) => { if (isLaunchMode(v)) { setMode(v); save({ mode: v }); } }}
          options={LAUNCH_MODES.map((m) => ({ v: m, label: LAUNCH_MODE_LABEL[m] }))} />}
      />
      <SettingRow
        agentNever="what every agent the app starts may never do: an agent does not edit its own leash"
        label="Always deny"
        hint="One pattern per line, refused in every terminal."
        detail={{ summary: "Details", body: <>Each line is passed as <span className="t-mono text-[11px]">--disallowedTools</span> on every launch, whatever the mode. The next terminal the app opens starts with the saved list; the ones already open keep how they started.</> }}
        below={<div className="flex flex-col gap-2">
          <textarea aria-label="Always deny" value={deny} onChange={(e) => setDeny(e.target.value)} rows={Math.max(4, deny.split("\n").length + 1)}
            spellCheck={false} disabled={busy}
            className="w-full text-[12px] px-2.5 py-2 rounded-lg outline-none font-mono bg-[var(--surface-inset)] text-[var(--text)]"
            style={{ ...INPUT_STYLE, resize: "vertical" }} />
          {bad.length > 0 && <span className="text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>Not a rule: {bad[0]}</span>}
          {(err || note) && (
            <div className="text-[12px]" role={err ? "alert" : "status"}
              style={{ color: err ? "var(--error-ink)" : "var(--success-ink)" }}>{err ?? note}</div>
          )}
        </div>}
      />
      <SaveBar dirty={deny !== saved} canSave={bad.length === 0} busy={busy} onSave={() => save({ deny })} onCancel={() => setDeny(saved)} />
    </SettingsCard>
  );
}

function TerminalRunsOn({ open }: { open: boolean }) {
  const [terminal, setTerminal] = useState("engine");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const phase = useSavePhase("terminal", busy, !!err);
  const load = () => api.tmuxStatus().then((r) => { setTerminal(r.terminal || "engine"); setErr(null); })
    .catch(() => setErr("Could not reach the server — this setting is unavailable."));
  useEffect(() => { if (open) void load(); }, [open]);
  const saveTerminal = (mode: string) => {
    setTerminal(mode);
    setBusy(true); setNote(null); setErr(null);
    api.tmuxSettingsSave({ terminal: mode })
      .then((r) => {
        if (r.ok) setNote(mode === "engine"
          ? "New terminals open on the engine. The ones already open stay where they are."
          : "New terminals resume the tmux on this machine.");
        else setErr(r.error ?? "Could not save that.");
        void load();
      })
      .catch(() => setErr("Could not save — server unreachable."))
      .finally(() => setBusy(false));
  };

  return (
    <SettingsCard title="Terminal runs on" icon={<TerminalIcon size={ICON.sm} />} status={<SaveChip phase={phase} />} desc="The shell a Terminal view starts.">
      <SettingRow
        agentNever="which tmux a shell runs in, held by the server: it changes what runs a shell, so the owner chooses it"
        label="Terminal runs on"
        hint="On the pane engine (tmux), tabs survive a restart."
        detail={{
          summary: "What each choice does",
          body: <>"The engine" gives it the pane engine — agentglass draws the tabs and splits, the prefix set under Pane engine (tmux) applies, and Restore there can bring it back after a reboot; one session per checkout. "This machine's tmux" resumes the session you left in your own tmux, with your own <span className="t-mono text-[11px]">~/.tmux.conf</span>. They are separate servers: switching moves nothing and loses nothing, and whichever you are not using keeps running.</>,
        }}
        wide
        control={<SegControl label="Terminal runs on" value={terminal as "engine" | "desk"} onPick={saveTerminal} disabled={busy}
          options={[{ v: "engine", label: "Pane engine" }, { v: "desk", label: "My own tmux" }]} />}
        below={(err || note) ? (
          <div className="text-[12px]" role={err ? "alert" : "status"}
            style={{ color: err ? "var(--error-ink)" : "var(--success-ink)" }}>{err ?? note}</div>
        ) : undefined}
      />
    </SettingsCard>
  );
}

function TmuxPane({ open, onGoTerminal }: { open: boolean; onGoTerminal: () => void }) {
  /* The app's own dialog, not the browser's — see no-native-dialogs.test.ts.
     The `window.confirm` this replaces was invisible to that lint twice over:
     its lookbehind skipped `window.`, and an apostrophe in prose forty lines
     up had swallowed the whole region before the scan reached it. */
  const { ask, dialog } = useDialogs();
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.tmuxStatus>> | null>(null);
  const [prefix, setPrefix] = useState("");
  /** Sticky, so typing a custom key does not fold the box the moment the text
   *  stops matching a listed one. */
  const [prefixCustom, setPrefixCustom] = useState(false);
  const [source, setSource] = useState("auto");
  const [path, setPath] = useState("");
  const [confMode, setConfMode] = useState("append");
  const [override, setOverride] = useState("");
  const [restore, setRestore] = useState(false);
  const [resume, setResume] = useState("lazy");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The card the last action belongs to, so its answer appears under it and not at the foot of the page. */
  const [noteAt, setNoteAt] = useState<"engine" | "prefix" | "config" | "restore">("engine");
  const [busy, setBusy] = useState(false);
  useReportSaving("tmux", busy);
  /** A failed Restore / Resume save. Not `err`: that one replaces the whole page. */
  const [saveFail, setSaveFail] = useState<string | null>(null);

  const load = () => {
    setBusy(true);
    return api.tmuxStatus()
      .then((r) => {
        setSt(r);
        setSource(r.source);
        setPath(r.bin.path || "");
        setConfMode(r.confMode);
        setOverride(r.override);
        setRestore(r.restoreEnabled);
        setResume(r.resumeMode);
        setPrefix(r.prefix || "");
        setPrefixCustom(!!r.prefix && !PREFIXES.some((p) => p.value === r.prefix));
        setErr(null);
      })
      .catch(() => setErr("Could not reach the server — the tmux settings are unavailable."))
      .finally(() => setBusy(false));
  };
  useEffect(() => { if (open) void load(); }, [open]);
  useEffect(() => { setPageFact("tmuxVersion", st?.bin.version?.replace(/^tmux\s+/i, "") || undefined); }, [st?.bin.version]);

  const saveSettings = () => {
    setBusy(true); setNote(null); setNoteAt("engine");
    api.tmuxSettingsSave({ source, path: source === "custom" ? path : undefined })
      .then((r) => { setNote(r.ok ? "Saved. The binary choice applies to new panes." : r.error ?? "Could not save."); void load(); })
      .catch(() => setErr("Could not save — server unreachable."))
      .finally(() => setBusy(false));
  };

  /** Restore and Resume mode save the moment they change: show the new value
   *  at once, put the old one back and say so if the save fails. */
  const savePaneField = (field: { restore: boolean } | { resume: "lazy" | "all" }, what: string) => {
    const prev = { restore, resume };
    if ("restore" in field) setRestore(field.restore); else setResume(field.resume);
    setNote(null); setSaveFail(null);
    void paneFieldSave(api.tmuxSettingsSave, field, what).then((r) => {
      if (r.ok) { void load(); return; }
      setRestore(prev.restore); setResume(prev.resume);
      setSaveFail(r.error);
    });
  };

  const savePrefix = () => {
    setBusy(true); setNote(null); setErr(null); setNoteAt("prefix");
    api.tmuxSettingsSave({ prefix })
      .then((r) => {
        if (r.ok) setNote(r.appliedNow
          ? (prefix ? `Prefix is ${prefix} — live, in the panes already open.` : "Prefix back to tmux's own C-b — live.")
          : (prefix ? `Prefix is ${prefix}. It applies when the engine next starts.` : "Prefix back to tmux's own C-b, when the engine next starts."));
        else setErr(r.error ?? "Could not save that key.");
        void load();
      })
      .catch(() => setErr("Could not save — server unreachable."))
      .finally(() => setBusy(false));
  };

  const saveConf = () => {
    setBusy(true); setNote(null); setNoteAt("config");
    api.tmuxConfSave(confMode, override)
      .then((r) => {
        if (r.ok) { setNote(r.appliedNow ? "Config accepted by tmux, and applied to the running engine." : "Config accepted by tmux. It applies when the engine next starts."); }
        else setErr(r.error ?? "tmux rejected the config.");
        void load();
      })
      .catch(() => setErr("Could not save — server unreachable."))
      .finally(() => setBusy(false));
  };

  const resetAll = async () => {
    if (!(await ask({
      title: "Reset the tmux engine to defaults?",
      body: "Your override config is cleared and the engine's own tmux server restarts.\nChat conversations are unaffected.",
      confirmLabel: "Reset engine",
      danger: true,
    }))) return;
    setBusy(true); setNote(null); setNoteAt("config");
    api.tmuxReset()
      .then((r) => { setNote(r.ok ? "Reset to defaults." : r.error ?? "Reset failed."); void load(); })
      .catch(() => setErr("Could not reset — server unreachable."))
      .finally(() => setBusy(false));
  };

  const restoreAction = (action: "capture" | "restore" | "clear") => {
    setBusy(true); setNote(null); setNoteAt("restore");
    api.tmuxRestoreAction(action, resume as "lazy" | "all")
      .then((r) => {
        if (r.ok && action === "restore") setNote(restoredNote(r.restored ?? 0));
        else if (r.ok && action === "capture") setNote("Layout captured.");
        else if (r.ok) setNote("Restore state cleared.");
        else setErr(r.error ?? "That did not work.");
        void load();
      })
      .catch(() => setErr("Could not reach the server."))
      .finally(() => setBusy(false));
  };

  if (err) return (
    <SettingsCard title="Pane engine">
      <SettingRow label="The tmux settings are unavailable" status={<StatusBadge tone="err">Not read</StatusBadge>} hint={err} />
    </SettingsCard>
  );

  const cap = st?.capability;
  const prefixListed = PREFIXES.some((p) => p.value === prefix);
  const saidHere = (at: typeof noteAt) => note && noteAt === at
    ? <SettingRow label={<span style={{ color: "var(--success-ink)" }}>{note}</span>} />
    : null;
  const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() - t) / 60_000)); return m < 1 ? "just now" : m < 60 ? `${m} ${m === 1 ? "minute" : "minutes"} ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const engineDirty = !!st && (source !== st.source || (source === "custom" && path !== (st.bin.path || "")));
  const prefixDirty = !!st && prefix !== (st.prefix || "");
  const confDirty = !!st && (confMode !== st.confMode || override !== st.override);
  return (
    <>
    <SettingsCard title="Pane engine" icon={<PanesIcon size={ICON.sm} />}
      desc="Tabs and panes run on tmux, so they outlive a restart."
      status={!st
        ? <StatusBadge tone="checking">Checking</StatusBadge>
        : cap?.available
          ? <StatusBadge tone="ok">Ready</StatusBadge>
          : <StatusBadge tone="err">Unavailable</StatusBadge>}
      >
      <SettingRow agentExempt
        label={cap && !cap.available ? "Pane engine unavailable" : "Pane engine ready"}
        hint={cap && !cap.available ? cap.reason
          : st?.bin.version ? `${st.bin.version}${st.bin.source === "bundled" ? " · bundled with this build" : ""}` : "Checking…"}
        detail={{ summary: "Details", body: <>The engine runs its own tmux server: its own socket, its own config. Your <span className="t-mono text-[11px]">~/.tmux.conf</span> is never loaded, and neither is your tmux touched.
          {st?.bin.path ? <> Currently <span className="t-mono text-[11px] break-all">{st.bin.path}</span>{st.bin.source === "env" ? " (AGENTGLASS_TMUX_PATH override)" : null}.</> : null}
          {st?.broken ? <> <b style={{ color: "var(--error-ink)" }}>{st.brokenReason}</b></> : null}</> }}
        control={st && cap?.available ? <StatusBadge tone="ok">Ready</StatusBadge> : undefined} />
      <SettingRow
        label="tmux binary"
        hint="Use the bundled one unless you need your own."
        detail={{ summary: "Details", body: <>"Auto" prefers the bundled static tmux and falls back to the system one; "Custom" points at your own binary (e.g. a newer tmux). Tabs, splits and status are drawn by agentglass either way.</> }}
        wide
        control={<SegControl label="tmux binary" value={source as "auto" | "bundled" | "system" | "custom"} disabled={busy} onPick={setSource}
          options={[{ v: "auto", label: "Auto" }, { v: "bundled", label: "Bundled" }, { v: "system", label: "System" }, { v: "custom", label: "Custom" }]} />}
      />
      <SettingRow
        label="Path to the binary" hint="Only read when Custom is picked." disabled={source !== "custom"}
        below={<input id="tmux-bin-path" aria-label="Path to the binary" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/tmux"
          disabled={source !== "custom" || busy} spellCheck={false} className={`t-mono w-full ${INPUT}`} style={INPUT_STYLE}
          onKeyDown={(e) => { if (e.key === "Enter") saveSettings(); }} />}
      />
      {/* The choice itself lives under Terminal, beside the other things that
          decide what a Terminal does; one row here so somebody who came for the
          engine still finds where a shell opens. */}
      <SettingRow
        label="Where a Terminal opens a shell"
        hint="Set under Terminal: on this engine, or on your own tmux."
        actions={<Button onClick={onGoTerminal}>Open Terminal settings</Button>}
      />
      {saidHere("engine")}
      <SaveBar dirty={engineDirty} busy={busy} onSave={saveSettings} onCancel={() => { setSource(st?.source ?? "auto"); setPath(st?.bin.path || ""); }} />
    </SettingsCard>

    {/* The one binding everybody changes, as a choice rather than as three
        lines of tmux to remember: `set -g prefix` alone leaves C-b working,
        and without `send-prefix` the new key cannot be typed through to a
        program inside the pane. The generator writes all three. */}
    <SettingsCard title="Prefix key" icon={<KeyboardIcon size={ICON.sm} />}>
      <SettingRow
        label="Prefix key"
        hint="The key you press before a tmux command."
        detail={{ summary: "Details", body: <>The engine's own prefix, not your tmux's. tmux's default is <span className="t-mono text-[11px]">C-b</span>; pick another if that is taken by something you use. Saving hands it to the running engine, so it applies to the panes already open, with no restart.</> }}
        control={<Select value={prefixListed ? prefix : "custom"} disabled={busy} align="right" style={SELECT_BOX}
          onChange={(v) => { setPrefixCustom(v === "custom"); if (v !== "custom") setPrefix(v); }}
          options={[...PREFIXES.map((p) => ({ value: p.value, label: p.label })), { value: "custom", label: "Custom…" }]} />}
      />
      <SettingRow
        label="Custom prefix key" hint="In tmux's spelling: C-a, M-Space, F5." disabled={prefixListed && !prefixCustom}
        below={<input id="tmux-prefix" aria-label="Custom prefix key" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="C-a" spellCheck={false}
          disabled={(prefixListed && !prefixCustom) || busy} className={`t-mono w-full ${INPUT}`} style={INPUT_STYLE}
          onKeyDown={(e) => { if (e.key === "Enter") savePrefix(); }} />}
      />
      {saidHere("prefix")}
      <SaveBar dirty={prefixDirty} busy={busy} saveLabel="Save & apply" onSave={savePrefix} onCancel={() => { setPrefix(st?.prefix || ""); setPrefixCustom(!!st?.prefix && !PREFIXES.some((x) => x.value === st.prefix)); }} />
    </SettingsCard>

    <SettingsCard title="Engine config" icon={<SlidersIcon size={ICON.sm} />}
      desc="Extra tmux lines for the engine's own server, checked by tmux before they apply.">
      <SettingRow
        label="Mode"
        hint="Append keeps the shipped config; Replace is only yours."
        detail={{ summary: "Details", body: <>"Append" runs your lines after the generated base (the UI's status bar stays off: that line is re-asserted after yours); "Replace" makes your text the whole config. A rejected config leaves the engine off and chat unaffected, and Reset brings it back.</> }}
        wide
        control={<SegControl label="Mode" value={confMode as "append" | "replace"} disabled={busy} onPick={setConfMode}
          options={[{ v: "append", label: "Append" }, { v: "replace", label: "Replace" }]} />}
      />
      <SettingRow
        label="Override config"
        hint="tmux commands, applied after the shipped ones."
        detail={{ summary: "Details", body: <>Plain tmux commands, one per line. Your ~/.tmux.conf is never read. Plugins work by adding their own <span className="t-mono text-[11px]">run-shell</span> line.</> }}
        below={<textarea id="tmux-override" aria-label="Override config" value={override} onChange={(e) => setOverride(e.target.value)} spellCheck={false} rows={5} disabled={busy}
          placeholder={"# set -g mouse on\n# set -g history-limit 50000"}
          className={`t-mono w-full ${INPUT}`} style={{ ...INPUT_STYLE, height: "auto", resize: "vertical" }} />}
      />
      {saidHere("config")}
      <SaveBar dirty={confDirty} busy={busy} saveLabel="Validate & apply" onSave={saveConf} onCancel={() => { setConfMode(st?.confMode ?? "append"); setOverride(st?.override ?? ""); }}
        extra={st ? <Button tone="danger" onClick={resetAll} disabled={busy}>Reset tmux to defaults</Button> : undefined} />
    </SettingsCard>

    <SettingsCard title="Restore after reboot" icon={<PanesIcon size={ICON.sm} />}
      desc="After the PC restarts the panes come back where they were."
      status={st ? <StatusBadge tone={restore ? "ok" : "off"}>{restore ? "On" : "Off"}</StatusBadge> : undefined}>
      <SettingRow
        label="Restore the layout"
        role="switch" ariaChecked={restore}
        onClick={busy ? undefined : () => savePaneField({ restore: !restore }, "Restore")}
        hint="Windows, panes and their folders."
        detail={{ summary: "Details", body: "When the host reboots, the engine's tmux dies with it. This photographs the layout (sessions, tabs, splits, each pane's directory and start command; not what scrolled past) and rebuilds it at the next boot. Nothing here touches your own tmux or its resurrect saves." }}
        control={<Switch on={restore} busy={busy} />}
      />
      <SettingRow
        label="Resume mode"
        hint="What an agent pane does when it comes back."
        detail={{ summary: "Details", body: <>"Lazy" restores the tree and resumes each agent when you reopen its chat; "All" relaunches every recorded CLI, resuming each conversation.</> }}
        control={<Select value={resume} onChange={(v) => savePaneField({ resume: v === "all" ? "all" : "lazy" }, "Resume mode")} disabled={busy || !restore} align="right" style={SELECT_BOX}
          options={[
            { value: "lazy", label: "Lazy resume" },
            { value: "all", label: "Resume all" },
          ]} />}
      />
      {saveFail && (
        <SettingRow label={<span style={{ color: "var(--error-ink)" }}>{saveFail}</span>} />
      )}
      {st?.crashLoop && (
        <SettingRow
          label="Layout left alone"
          status={<StatusBadge tone="warn">Skipped</StatusBadge>}
          hint="This start neither restored nor captured."
          detail={{ summary: "Details", body: `${st.crashLoop.launches} launches in ten minutes looked like a crash loop. Restore it by hand below once the app is stable, or delete ${st.crashLoop.file} to clear this.` }}
        />
      )}
      {st?.lastCaptureAt ? (
        <SettingRow
          label="Last layout capture"
          hint="The restore rebuilds from this."
          status={<StatusBadge tone="ok">{ago(st.lastCaptureAt)}</StatusBadge>}
          detail={{ summary: "Details", body: `Taken ${new Date(st.lastCaptureAt).toLocaleString()}. Captures run every minute while the engine is on.` }}
          below={<span className="flex flex-wrap items-center gap-2">
            <Button onClick={() => restoreAction("capture")} disabled={busy}>Capture now</Button>
            <Button onClick={() => restoreAction("restore")} disabled={busy}>Restore now</Button>
            <Button onClick={() => restoreAction("clear")} disabled={busy}>Clear</Button>
          </span>}
        />
      ) : (
        <SettingRow
          label="Restore state"
          hint="Nothing captured yet. Turn on Restore and the next sweep photographs the layout."
        />
      )}
      {saidHere("restore")}
    </SettingsCard>
    {dialog}
    </>
  );
}

/**
 * Which tracker each repository's cards live in. Only drawn when both ClickUp
 * and Jira are connected: with one, there is nothing to choose and no setting
 * to show. "Auto" reads the id's prefix (see trackerFor); the buttons are for
 * the repository where that cannot tell.
 */
function CardTrackerSection() {
  const setup = useTrackerSetup();
  const both = !!setup?.clickup && !!setup?.jira;
  const [rows, setRows] = useState<{ repos: string[]; chosen: Record<string, Exclude<TrackerChoice, "auto">> } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!both) return;
    let live = true;
    void api.trackerProjects(true).then((r) => {
      if (!live || !r.ok) return;
      const chosen = r.projects ?? {};
      setRows({ repos: [...new Set([...(r.repos ?? []), ...Object.keys(chosen)])].sort(), chosen });
    }).catch(() => { /* the section stays empty rather than guessing */ });
    return () => { live = false; };
  }, [both]);
  const pick = async (repo: string, v: TrackerChoice) => {
    const r = await api.setTrackerProject(repo, v);
    if (!r.ok) { setNote(r.error ?? "Could not save that"); return; }
    setNote("");
    rememberTrackerChoices(r.projects ?? {});
    setRows((cur) => cur && { ...cur, chosen: r.projects ?? {} });
  };
  const only = setup?.jira ? "Jira" : setup?.clickup ? "ClickUp" : null;
  return (
    <SettingsCard title="Card tracker" icon={<ChecklistIcon size={ICON.sm} />}
      desc={<>Where a card id in a branch or pull request is looked up.
        {note && <span className="block mt-1" role="alert" style={{ color: "var(--error-ink)" }}>{note}</span>}</>}>
      {both ? (<>
        {!rows?.repos.length && <EmptyState>No repositories to choose for yet.</EmptyState>}
        {rows?.repos.map((repo) => (
          <Choice<TrackerChoice> key={repo} label={repo} hint="Auto reads the id's prefix."
            value={rows.chosen[repo.toLowerCase()] ?? "auto"} onPick={(v) => void pick(repo, v)}
            options={[{ v: "auto", label: "Auto" }, { v: "clickup", label: "ClickUp" }, { v: "jira", label: "Jira" }]} />
        ))}
      </>) : (
        <SettingRow agentExempt label="Look it up in"
          hint={only ? "The one tracker connected." : "No tracker connected, so no card is looked up."}
          detail={only ? undefined : { summary: "Details", body: "Connect ClickUp or Jira under Tools & services and a card id in a branch or pull request is found on its board." }}
          status={<StatusBadge tone={only ? "ok" : "off"}>{only ?? "None"}</StatusBadge>} />
      )}
      <SettingRow agentExempt label="Card id rule" hint="A key like ORBIT-1042 in a branch or title."
        detail={{ summary: "Details", body: <>A card id is letters, a dash and two to seven digits (<span className="t-mono text-[11px]">ORBIT-1042</span>), found anywhere in a branch name or pull request title. A Jira key must also match a project of the connected site. The rule is built in; it is not editable.</> }} />
      <TryBranch prefixes={setup?.jira?.prefixes ?? []} clickupPrefix={setup?.clickup?.prefix} />
    </SettingsCard>
  );
}

/** Types a branch name and shows what the app would read as its card: the same function the pull request list uses. */
function TryBranch({ prefixes, clickupPrefix }: { prefixes: readonly string[]; clickupPrefix?: string }) {
  const [text, setText] = useState("feat/ORBIT-1042-retry");
  const id = cardIdIn(text);
  const prefix = id?.split("-")[0]?.toLowerCase();
  const tracker = !id ? "" : prefixes.some((x) => x.toLowerCase() === prefix) ? " · Jira" : clickupPrefix && clickupPrefix.toLowerCase() === prefix ? " · ClickUp" : "";
  return (
    <SettingRow agentExempt label="Try a branch" hint="See what the rule finds."
      below={<div className="flex items-center gap-3">
        <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Branch name to try"
          className={`t-mono min-w-0 flex-1 ${INPUT}`} style={INPUT_STYLE} />
        <span data-try-branch><StatusBadge tone={id ? "ok" : "off"}>{id ? `${id.toUpperCase()}${tracker}` : "No card id"}</StatusBadge></span>
      </div>} />
  );
}

export function SettingsModal({ open, onClose, sound, onSound, scale, onZoom, theme, onTheme, jump }: {
  open: boolean; onClose: () => void; sound: boolean; onSound: () => void;
  /** Somebody asked for a pane and maybe a row on it — see openSettings(pane,
   *  row) in lib/openSettings.ts. `n` is a nonce: it changes on every request,
   *  so an identical request made from inside the open modal still navigates. */
  jump?: { pane: string | null; row: string | null; n: number } | null;
  scale: number; onZoom: (dir: 1 | -1 | 0) => void;
  theme: string; onTheme: (id: string) => void;
}) {
  // Launch-at-login belongs to the installed app, so the row exists only in the
  // desktop window — and only once the shell has confirmed the current state,
  // rather than showing a switch that might be lying about it.
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  // Read once on open rather than tracked live: the window can also be put
  // fullscreen by the OS (a window-manager shortcut), and a toggle that lied
  // about the current state would be worse than one that is merely a moment
  // stale.
  const [fullscreen, setFullscreenState] = useState(false);
  /* Say that something is covering the app.
     The browser's inspector is a view the SHELL floats over the window at a
     rectangle the panel reports; it knows nothing about our DOM and sat
     cheerfully on top of this modal. Now it gets out of the way. */
  useEffect(() => (open ? overlayOpen("settings") : undefined), [open]);
  useEffect(() => { if (open) autostartEnabled().then(setAutostartState); }, [open]);
  useEffect(() => { if (open) void isFullscreen().then(setFullscreenState); }, [open]);

  const [h24, setH24] = useState<boolean>(() => clock24());
  const [splash, setSplash] = useState<boolean>(() => splashOn());
  const [usageRefresh, setUsageRefreshState] = useState<boolean>(() => usageRefreshOn());
  // Re-read when an agent or an undo changes it, not only when this row is pressed.
  const diskWarn = useSyncExternalStore(subscribeSettings, diskWarnPct, () => DISK_WARN_DEFAULT);
  const [renderer, setRenderer] = useState<RendererPref>(() => rendererPref());
  const [keys, setKeys] = useState(() => bindings());
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  // The Shortcuts page reads chordFor, which now answers out of the rail: move
  // a view between groups on the Rail page and every number on this one shifts.
  // Without this the two pages sit side by side disagreeing.
  const railLayout = useSyncExternalStore(subscribeRail, loadRail, () => SHIPPED_RAIL);
  /**
   * Which page is showing — remembered across opens.
   *
   * It used to be hardcoded to "prefs" regardless of the list order, so the
   * dialog always opened on the second item for no reason anybody could see.
   * Settings is a place you come back to for the same thing twice, so it now
   * lands where you left it, defaulting to the first page on a fresh install.
   */
  /*
   * NO PAGE PER PLUGIN IN THIS NAV, and that is the fix rather than the gap.
   *
   * There was one, added at run time from the same `/plugins` read the Plugins
   * page makes. Two things were wrong with it and both showed up in
   * use: removing a plugin left its page in the sidebar until
   * Settings was closed and opened again — the list is read once, and nothing
   * told it the plugin had gone — and a person with a hundred plugins would
   * have a hundred entries in a nav that has nineteen of its own.
   *
   * A plugin's settings now open inside the Plugins page, which is the one
   * place that already knows what is installed and redraws when that changes.
   * `openSettings("plugin:<name>")` still works: it lands on Plugins with that
   * plugin's page open, so every link that pointed at one still points at one.
   */
  const [pane, setPane] = useState<Pane>(() => {
    try {
      const saved = localStorage.getItem(LAST_PANE_KEY);
      // A plugin page is kept even before the list of plugins has loaded; if
      // the plugin is gone its page says so rather than silently moving you.
      const at = saved ? resolvePane(saved) : null;
      if (at && (TABS.some((t) => t.id === at) || at.startsWith("plugin:"))) return at as Pane;
    } catch { /* private mode */ }
    return TABS[0]!.id;
  });
  useEffect(() => { try { localStorage.setItem(LAST_PANE_KEY, pane); } catch { /* ignore */ } }, [pane]);
  // Somebody asked for a specific pane. Overrides the remembered one for this
  // opening only — the next plain open still lands where you left it.
  useEffect(() => {
    const at = jump?.pane ? resolvePane(jump.pane) : null;
    if (open && at && (TABS.some((t) => t.id === at) || at.startsWith("plugin:"))) {
      setPane(at as Pane);
      // A page that was asked for must be the page on screen: while the search
      // box has text the results view replaces every page, so the jump moved
      // only the sidebar highlight and the screen did not change.
      setQ("");
    }
  }, [open, jump]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /*
   * What each page would tell you if you opened it.
   *
   * The nav is a list of twenty-one places and, until you visit one, no
   * indication that any of them wants you. So three cheap summaries are asked
   * for once when the dialog opens — the tools on this machine, the services,
   * and whether a phone is attached — and the pages that have something to say
   * say it on their own line.
   *
   * Not awaited, and not blocking: the nav draws instantly and the marks land
   * when they land. That is the lesson from Integrations, where waiting for one
   * slow answer cost the whole page ten seconds. The three go out together for
   * the same reason.
   */
  const [badges, setBadges] = useState<{ connections?: number; remote?: "live" | "idle" | null }>({});
  const [logDigest, setLogDigest] = useState<LogDigest | "failed" | null>(null);
  /** The three onboarding steps, read from the same state Connections and
   *  Agents already show — this owns no state of its own, so it cannot say
   *  "done" about something those pages would call unfinished. `null` until
   *  the reads land, which keeps the pinned row off the nav rather than
   *  flashing it and pulling it back a second later. */
  const [onboarding, setOnboarding] = useState<{ hook: boolean; provider: boolean; paneEngine: boolean } | null>(null);
  /** Facts only the nav's marks and the page header's chips read. `null` is a
   *  read that has not landed or that failed: it draws no mark rather than a
   *  guess. Read with the batch above, once per open. */
  const [facts, setFacts] = useState<Pick<NavFacts, "hooksWired" | "gateOff" | "tmuxOk" | "jiraConnected" | "lanternWatching" | "updateAvailable" | "notificationsOn" | "pluginsRunning" | "pluginsNeed">>({
    hooksWired: null, gateOff: null, tmuxOk: null, jiraConnected: null, lanternWatching: null, updateAvailable: null, notificationsOn: null,
    pluginsRunning: null, pluginsNeed: null,
  });
  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all([
      api.dependencies().then((r) => r.deps).catch(() => null),
      api.providers().then((r) => r.providers).catch(() => null),
      api.remoteStatus().then((r) => (r.clients.liveCount > 0 ? ("live" as const) : ("idle" as const))).catch(() => null),
      api.hooksStatus().then((r) => ({ installed: r.installed, gateOff: r.gateBundled && !r.gate })).catch(() => null),
      api.logDigest().catch(() => "failed" as const),
      api.jiraStatus().then((r) => r.connected).catch(() => null),
      api.lanternSettings().then((r) => (r.ok && typeof r.watch === "boolean" ? r.watch : null)).catch(() => null),
      api.updateStatus().then((r) => isUpdateAvailable(r)).catch(() => null),
      api.notifyPrefs().then((r) => (r.ok ? !r.prefs.none : null)).catch(() => null),
      api.plugins().then((r) => r.plugins).catch(() => null),
    ]).then(([deps, provs, remote, hookState, digest, jira, lanternWatching, updateAvailable, notificationsOn, plugs]) => {
      if (!live) return;
      setBadges({
        connections: connectionsNeeding(deps ?? [], provs ?? []),
        remote,
      });
      setLogDigest(digest);
      setOnboarding({
        hook: hookState?.installed === true,
        provider: (provs ?? []).some((p) => p.state === "connected"),
        paneEngine: (deps ?? []).some((d) => d.id === "tmux" && d.status === "ok"),
      });
      setFacts({
        hooksWired: hookState === null ? null : hookState.installed,
        gateOff: hookState?.gateOff ?? null,
        tmuxOk: deps === null ? null : deps.some((d) => d.id === "tmux" && d.status === "ok"),
        jiraConnected: jira, lanternWatching, updateAvailable, notificationsOn,
        pluginsRunning: plugs === null ? null : plugs.filter((x) => x.running).length,
        pluginsNeed: plugs === null ? null : plugs.filter((x) => x.approvedFingerprint !== x.fingerprint).length,
      });
    });
    return () => { live = false; };
  }, [open]);
  const onboardingDone = onboarding !== null && onboarding.hook && onboarding.provider && onboarding.paneEngine;

  const [q, setQ] = useState(""); // settings search — narrows the nav, then the rows
  const ql = q.trim().toLowerCase();
  /*
   * How many rows on the page answered the query.
   *
   * Counted during the render itself — every row reports through the context —
   * and read back in an effect, because a parent cannot know what its children
   * say about themselves until they have said it. The reset happens here, in
   * the parent's render body, which React runs before any child's.
   *
   * It settles in one extra pass, and it fails in the safe direction: the pass
   * where the count is not in yet shows MORE than it will, never less.
   */
  const tally = useRef(0);
  tally.current = 0;
  const seen = useCallback((matched: boolean) => { if (matched) tally.current++; }, []);
  const [rowHits, setRowHits] = useState(0);
  useEffect(() => { setRowHits(tally.current); });
  const filtering = ql.length > 0 && rowHits > 0;
  const filter = useMemo(() => ({ on: filtering, q: ql, seen }), [filtering, ql, seen]);
  /*
   * The pages a query answers, ranked, capped at 5.
   *
   * This replaces the effect that used to jump the CURRENT page to whichever
   * one scored best the moment it stopped matching — a page silently
   * changing under you while you are still typing was the thing that made
   * "did I lose my place" worth asking. The results view below takes that
   * job instead: every matching page renders in place, at once, so there is
   * nothing to jump to.
   */
  /* Is there a ClickUp here? Read from the local store (no call leaves the machine)
     whenever the modal opens or the page changes, which is when connecting or
     disconnecting in Tools & services has just happened. null is "not known
     yet", and reads as no: the ClickUp page never flashes in and away. */
  const [cuConnected, setCuConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void clickupSetup().then((c) => {
      if (!live) return;
      setCuConnected(c.connected);
      setPane((p) => paneWhenClickupKnown(p, c.connected) as Pane);
    });
    return () => { live = false; };
  }, [open, pane]);
  const cu = cuConnected === true;
  const tabs = useMemo(() => TABS.filter((t) => t.id !== "clickup" || cu), [cu]);
  /* The way off a ClickUp page that is not there is decided by the read above,
     not by the last value of `cuConnected`: right after connecting that value
     is still the old `false`, and an effect on it undid a jump to the page
     before the fresh read could say the page exists. */
  const matches = useMemo(() => (
    ql ? tabs.map((t) => ({ id: t.id, s: pageScore(t as SettingsPage, ql) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5)
    : []
  ), [ql, tabs]);
  const matchIds = useMemo(() => new Set<string>(matches.map((m) => m.id)), [matches]);
  /** Gates a page's content: the current page with no query running, or —
   *  while searching — whichever pages the query actually answers. Plain
   *  string identity, not `pane === id`, is what every `{show("x") && …}`
   *  block used to test; every one of those becomes `{show("x") && …}`. */
  const show = useCallback((id: string): boolean => (ql ? matchIds.has(id) : pane === id), [ql, matchIds, pane]);
  const absentHit = ql ? absentFor(ql) : null;
  /** "Names + help" reads hints and sections as well as a row's own name. */
  const [matchIn, setMatchIn] = useState<MatchIn>("help");
  /** The search panel's model: pages, each with the rows that answered, in
   *  rank order. It is the settings index's own ranking, only grouped. */
  const searchModel = useMemo(() => groupSearch(ql, tabs, matchIn), [ql, tabs, matchIn]);
  /*
   * The row to land on, once the page above has actually mounted.
   *
   * `flashRow` is armed from three places — a fresh `jump` request, Enter
   * on a highlighted search result, and a click on a search result row
   * itself — and disarmed by the effect below, which waits for the query to
   * actually be empty (so it flashes the row on the settled page, not a row
   * still standing among a stack of OTHER matching pages) before it goes
   * looking for `[data-row=…]` in the DOM.
   */
  const [flashRow, setFlashRow] = useState<string | null>(null);
  useEffect(() => { if (open && jump?.row) setFlashRow(jump.row); }, [open, jump]);
  const filterCtx = useMemo(() => ({ ...filter, flash: flashRow }), [filter, flashRow]);
  useEffect(() => {
    if (!flashRow || ql) return;
    const id = flashRow;
    const raf = requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
      if (el) {
        const reduce = reducedMotion();
        el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
        el.classList.add("agx-row-flash");
        window.setTimeout(() => el.classList.remove("agx-row-flash"), 1200);
      }
      setFlashRow(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [flashRow, ql, pane]);
  /** Enter on the selected result, or a click on one: land on it. Clearing
   *  the query first is what makes `flashRow`'s effect (above) wait for the
   *  single settled page to mount before it goes looking for the row. */
  const landOnResult = useCallback((r: { pane: string; row: string }) => {
    setPane(r.pane as Pane);
    setQ("");
    if (r.row) setFlashRow(r.row);
  }, []);
  const [termFont, setTermFontState] = useState(() => currentTermFont());
  const [termSize, setTermSizeState] = useState(() => currentTermSize());
  const [termLine, setTermLineState] = useState(() => currentTermLineHeight());
  const [termCursor, setTermCursorState] = useState<CursorStyle>(() => currentTermCursor());
  const [ffm, setFfm] = useState(() => focusFollowsMouse());
  const [groupsOn, setGroupsOn] = useState(() => tabGroupsOn());
  const [groupRules, setGroupRules] = useState(() => tabGroupRulesText());
  const [paneActs, setPaneActs] = useState<PaneActionsMode>(() => paneActionsMode());
  const [scrollback, setScrollbackState] = useState(() => currentScrollback());
  const [wordSep, setWordSepState] = useState(() => currentWordSeparators());
  const [copySel, setCopySel] = useState(() => copyOnSelect());
  const [rcPaste, setRcPaste] = useState(() => rightClickPaste());
  const [noteEd, setNoteEd] = useState<NoteEditor>(() => currentNoteEditor());
  const [dSplit, setDSplitState] = useState(() => diffSplit());
  const [dTheme, setDThemeState] = useState(() => diffThemePref());
  const [dWrap, setDWrapState] = useState(() => diffWrap());
  const [accent, setAccentState] = useState(() => currentAccent());
  // Remounts the appearance rows after a reset: they hold their own copy of
  // the accent and would go on showing the one that was just cleared.
  const [appearanceNonce, setAppearanceNonce] = useState(0);
  /* The screen the live preview of Window & startup and of Appearance shows. */
  const [liveView, setLiveView] = useState<LiveView>("settings");
  /* "Saved" beside a page's title for a moment after a control on it wrote: the pages
     that write at once (no Save button) say so, so a change is never silent. */
  const [savedPages, setSavedPages] = useState<ReadonlySet<string>>(() => new Set());
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const flashSaved = useCallback((page: string) => {
    setSavedPages((cur) => (cur.has(page) ? cur : new Set(cur).add(page)));
    clearTimeout(savedTimers.current[page]);
    savedTimers.current[page] = setTimeout(() => setSavedPages((cur) => { const n = new Set(cur); n.delete(page); return n; }), SAVED_MS);
  }, []);
  useEffect(() => subscribeSettings((c) => flashSaved(c.id.split(".")[0] ?? "")), [flashSaved]);
  useEffect(() => () => { for (const t of Object.values(savedTimers.current)) clearTimeout(t); }, []);
  // The modal lives as long as the app. The diff toolbars and Ctrl +/- over a
  // terminal write these stores behind its back, so the dot and Reset would be
  // decided on a value from app start. Re-read them whenever it opens.
  const reread = useCallback(() => {
    setRenderer(rendererPref());
    setTermFontState(currentTermFont());
    setTermSizeState(currentTermSize());
    setTermLineState(currentTermLineHeight());
    setTermCursorState(currentTermCursor());
    setDSplitState(diffSplit());
    setDThemeState(diffThemePref());
    setDWrapState(diffWrap());
    setAccentState(currentAccent());
    setFfm(focusFollowsMouse());
    setGroupsOn(tabGroupsOn());
    setGroupRules(tabGroupRulesText());
    setPaneActs(paneActionsMode());
    setScrollbackState(currentScrollback());
    setWordSepState(currentWordSeparators());
    setCopySel(copyOnSelect());
    setNoteEd(currentNoteEditor());
    setLandingState(taskLanding());
    setSourceTick((n) => n + 1);
    setCiApproved(ciOnlyApproved());
    setReviewGateState(reviewGateOn());
    setTalkMode(talkNotify());
  }, []);
  useEffect(() => { if (open) reread(); }, [open, reread]);
  // An agent's change (or the undo of one) lands while the dialog may be up.
  // The rows keep their own copy of each value, so tell them to read again; the
  // appearance rows hold two more copies (mode, accent) and are remounted. A
  // row's own change is not an event here: it set its state when it called.
  useEffect(() => subscribeSettings((c) => {
    if (c.by === "row") return;
    reread();
    if (c.id.startsWith("appearance.")) setAppearanceNonce((n) => n + 1);
  }), [reread]);

  /*
   * What "modified" means, page by page, and what "Reset page" does.
   *
   * Each entry is a row's own comparison against the default its store
   * already exports (DEFAULT_* or the shape of its getter), and the setter
   * that puts it back — no key, no value and no default is new here.
   *
   * The ceiling: only these four pages are wired. The rest keep their state
   * in a server or a shell (notifications, remote, hooks, tmux), or have no
   * default to compare against (the clock follows the locale, theme mode
   * follows the machine on a first run, fullscreen and launch-at-login are
   * the window system's state, not a stored preference), so a dot there
   * would be a guess.
   *
   * Free text the user typed is left out of Terminal on purpose (tab-group
   * rules, word separators): "Reset page" is one unconfirmed click and there
   * is no undo, so it only puts back settings that are a choice among
   * defaults. The ceiling: those two rows have no dot and no reset until a
   * confirm step exists for them.
   */
  // Re-read when the rail or a count badge moves, so the header's reset follows it.
  useSyncExternalStore(subscribeRail, railCustomised, railCustomised);
  useSyncExternalStore(subscribeRailBadges, railBadgesKey, railBadgesKey);
  const railLaidOut = railCustomised() || railBadgesCustomised();
  const pageDirty: Partial<Record<Pane, { modified: boolean; reset: () => void }[]>> = {
    prefs: [
      { modified: !splash, reset: () => { setSplashOn(true); setSplash(true); } },
      ...(IS_DESKTOP ? [{ modified: scale !== DEFAULT_SCALE, reset: () => onZoom(0) }] : []),
    ],
    appearance: [
      { modified: accent !== "", reset: () => { setAccentPref(""); applyTheme(theme); setAccentState(""); setAppearanceNonce((n) => n + 1); } },
      { modified: densityPref() !== DEFAULT_DENSITY, reset: () => { setDensityPref(DEFAULT_DENSITY); setAppearanceNonce((n) => n + 1); } },
      { modified: uiFontPref() !== DEFAULT_UI_FONT, reset: () => { setUiFontPref(DEFAULT_UI_FONT); setAppearanceNonce((n) => n + 1); } },
      { modified: translucentPref(), reset: () => { setTranslucentPref(false); setAppearanceNonce((n) => n + 1); } },
      { modified: reduceMotionChoice() !== null, reset: () => { resetReduceMotion(); setAppearanceNonce((n) => n + 1); } },
    ],
    terminal: [
      { modified: renderer !== "auto", reset: () => { setRendererPref("auto"); setRenderer("auto"); } },
      { modified: termFont !== "", reset: () => { setTermFont(""); setTermFontState(""); } },
      { modified: termSize !== DEFAULT_SIZE, reset: () => { setTermSize(DEFAULT_SIZE); setTermSizeState(DEFAULT_SIZE); } },
      { modified: termLine !== DEFAULT_LINE_HEIGHT, reset: () => { setTermLineHeight(DEFAULT_LINE_HEIGHT); setTermLineState(DEFAULT_LINE_HEIGHT); } },
      { modified: termCursor !== "block", reset: () => { setTermCursor("block"); setTermCursorState("block"); } },
      { modified: ffm, reset: () => { setFocusFollowsMouse(false); setFfm(false); } },
      { modified: paneActs !== "hover", reset: () => { setPaneActionsMode("hover"); setPaneActs("hover"); } },
      { modified: !copySel, reset: () => { setCopyOnSelect(true); setCopySel(true); } },
      { modified: rcPaste, reset: () => { setRightClickPaste(false); setRcPaste(false); } },
      { modified: !groupsOn, reset: () => { setTabGroupsOn(true); setGroupsOn(true); } },
      { modified: scrollback !== DEFAULT_SCROLLBACK, reset: () => { setScrollback(DEFAULT_SCROLLBACK); setScrollbackState(DEFAULT_SCROLLBACK); } },
    ],
    rail: [
      { modified: railLaidOut, reset: () => { resetRail(); resetRailBadges(); } },
    ],
    diff: [
      { modified: dSplit !== DEFAULT_SPLIT, reset: () => { setDiffSplit(DEFAULT_SPLIT); setDSplitState(DEFAULT_SPLIT); } },
      { modified: dWrap !== DEFAULT_WRAP, reset: () => { setDiffWrap(DEFAULT_WRAP); setDWrapState(DEFAULT_WRAP); } },
    ],
  };
  const pageModified = (p: Pane) => resetShown((pageDirty[p] ?? []).map((d) => d.modified));
  const resetPage = (p: Pane) => { for (const d of pageDirty[p] ?? []) if (d.modified) d.reset(); };
  /* The source list is read straight from the store on each render; this only
     exists to ask for that render. `sourceOrder` is read the same way, so a
     move is on screen before the write has settled. */
  const [, setSourceTick] = useState(0);
  const sourceOrder = orderedTaskSources();
  const trackerSetup = useTrackerSetup();
  const shownSources = shownTaskSources().length;
  useEffect(() => { setPageFact("taskSources", shownSources); }, [shownSources]);
  const [landing, setLandingState] = useState<TaskLanding>(() => taskLanding());
  const [keyError, setKeyError] = useState<{ id: ActionId; msg: string } | null>(null);
  useEffect(() => subscribeBindings(() => setKeys({ ...bindings() })), []);

  // While capturing, this window handler runs first and swallows the key, so
  // rebinding "t" cannot also trigger whatever "t" is currently bound to.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); setKeyError(null); return; }
      // Modifiers alone are not a binding; wait for the real key.
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const r = setting(`keys.binding.${capturing}`).set(e.key);
      if (r.ok) { setCapturing(null); setKeyError(null); }
      else setKeyError({ id: capturing, msg: r.error });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  // The same capture, for the modified key. Held apart from `capturing` so the
  // two chips on one row cannot both be listening at once.
  const [capturingChord, setCapturingChord] = useState<ViewId | null>(null);
  useEffect(() => {
    if (!capturingChord) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturingChord(null); setKeyError(null); return; }
      // The whole combination, exactly as held: Ctrl+Alt+J binds Ctrl+Alt+J.
      // Recording only the letter and implying the modifier meant Alt could
      // never be part of a binding at all.
      const chord = chordFromEvent(e);
      if (!chord) return; // modifiers alone, or a bare key — keep listening
      const r = rebindChord(capturingChord, chord);
      if (r.ok) { setCapturingChord(null); setKeyError(null); }
      else setKeyError({ id: `view.${capturingChord}`, msg: r.error });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingChord]);

  /*
   * And the same again for an app action — the finder.
   *
   * A third capture rather than a branch inside the second, for the reason the
   * comment above gives about the first two: while one of these is listening it
   * owns every keystroke in the app, so two that could be armed at once is one
   * that swallows the other's key.
   */
  // Read once into state rather than on every render: it lives in localStorage
  // and the row has to reflect a press immediately.
  const [ciApproved, setCiApproved] = useState(ciOnlyApproved);
  const [reviewGate, setReviewGateState] = useState(reviewGateOn);
  const [talkMode, setTalkMode] = useState(talkNotify);
  /* Read once and held in state: both live in localStorage, which is not a
     store anything can subscribe to, and the row has to redraw the moment it is
     picked so the Play button previews what is now selected. */
  const [notifyVoice, setNotifyVoiceState] = useState(notifyVoiceId);
  const [alarmVoice, setAlarmVoiceState] = useState(alarmVoiceId);
  const [capturingApp, setCapturingApp] = useState<AppChordId | null>(null);
  // Its own error slot. keyError is keyed by ActionId and these are not
  // actions — borrowing a row's id would print "already opens Git" under
  // Search, which is a worse answer than none.
  const [appKeyError, setAppKeyError] = useState<{ id: AppChordId; msg: string } | null>(null);
  useEffect(() => {
    if (!capturingApp) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturingApp(null); setAppKeyError(null); return; }
      const chord = chordFromEvent(e);
      if (!chord) return; // modifiers alone, or a bare key — keep listening
      const r = rebindAppChord(capturingApp, chord);
      if (r.ok) { setCapturingApp(null); setAppKeyError(null); setKeys({ ...bindings() }); }
      else setAppKeyError({ id: capturingApp, msg: r.error });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingApp]);

  // Closing the modal mid-capture has to drop the capture. This component stays
  // mounted with `open` merely toggled (Portal/AnimatePresence own the exit), so
  // neither capture effect above unmounts on close, and while `capturing` /
  // `capturingChord` stay set their window-level, capture-phase keydown listener
  // stays attached to a dialog that is no longer on screen — swallowing the next
  // keystroke anywhere in the app into a rebind nobody is doing. Clearing the
  // capture state re-runs those effects, and their cleanup is where the listener
  // actually comes off.
  useEffect(() => { if (!open) { setCapturing(null); setCapturingChord(null); setCapturingApp(null); setKeyError(null); setAppKeyError(null); } }, [open]);

  // Read from the stores, not copied into local state. This modal is mounted for
  // the life of the app, so a `useState` seeded at startup is seeded once and
  // never again — and these three switches have another surface now: the bell's
  // empty state can turn mirroring on, and Settings then sat there showing it
  // off, with a toggle whose first click did nothing visible. Measured, not
  // reasoned: the probe clicked the bell's button and this row still read false.
  const sysNotify = useSyncExternalStore(subscribeSysNotifyMode, sysNotifyMode, () => "off" as SysNotifyMode);
  const quiet = useSyncExternalStore(subscribeNotifyQuiet, notifyQuiet, () => true);
  const muted = useSyncExternalStore(subscribeMuted, mutedSources, mutedSources);
  const mutedList = [...muted].sort();
  const own = useSyncExternalStore(subscribeAppNotify, appNotify, () => true);
  const [notifyCap, setNotifyCap] = useState<NotifyCapability | null>(null);
  // Asked while the modal is open, and asked AGAIN while the answer is "we could
  // not ask". The desktop shell starts its server a beat after the window, so a
  // probe that lands in that gap used to leave this row reading "Unavailable —
  // server unreachable" over a server that had been up for an hour.
  useEffect(() => {
    if (!open) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = () => void notifyCapability().then((c) => {
      if (dead) return;
      setNotifyCap(c);
      if (c.transient) timer = setTimeout(ask, 2000);
    });
    ask();
    return () => { dead = true; if (timer) clearTimeout(timer); };
  }, [open]);
  const [enginePref, setEnginePref] = useState<ChatEnginePref>(() => chatEnginePref());
  // Asked while the modal is open rather than at startup: it is a subprocess
  // probe on the server, and nothing outside this row needs the answer.
  const [tmuxEngine, setTmuxEngine] = useState<TmuxEngineInfo | null>(null);
  useEffect(() => {
    if (!open) return;
    void api.chatEnabled()
      .then((r) => setTmuxEngine(r.tmuxEngine ?? { available: false, reason: "this server is too old to run chats in panes", defaultOn: false }))
      .catch(() => setTmuxEngine({ available: false, reason: "the agentglass server did not answer", defaultOn: false }));
  }, [open]);

  /*
   * ESCAPE ONCE SAYS SO, ESCAPE AGAIN LEAVES.
   *
   * One press used to close it. That is right for something hovering over your
   * work and wrong for somewhere you went: the same key dismisses a popover, so
   * the press meant to close a dropdown threw away the whole page and the
   * scroll position with it. The first press arms and says what the second one
   * does; the arming lapses on its own, so a stray Escape does not leave a
   * loaded trigger behind for a keystroke a minute later.
   */
  const [escArmed, setEscArmed] = useState(false);
  /* The handler reads the armed state from a ref: two presses closer than a render reached it with the
     first press's closure and re-armed instead of leaving (measured from the empty search box). */
  const escRef = useRef(false);
  escRef.current = escArmed;
  const dialog = useModalDialog(open, "Settings");
  useEffect(() => { if (!open) setEscArmed(false); }, [open]);

  /*
   * The search box has the caret the moment this opens, and Ctrl+F puts it
   * back.
   *
   * Twenty-four pages is past the count where reading the nav beats naming the
   * thing you want, so typing is the primary way in and the caret should
   * already be where typing goes. Nothing else on this screen wants the first
   * keystroke: there is no form to fill and no destructive control to fumble.
   *
   * A frame late, deliberately. The panel mounts inside an AnimatePresence and
   * focusing during the enter transition is focusing an element the compositor
   * is still moving — Chromium scrolls the ancestor to it and the whole page
   * jumps a few pixels on open. This is the same one-frame wait the file
   * palette needed for the same reason.
   *
   * preventScroll for the belt: the nav is a scroller and a focus inside it
   * can pull it, which on a narrow window shows as the group headings sliding
   * up as the screen appears.
   */
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!open) return;
    // Not in the icon-rail layout: focus there opens the field over the page, which nobody asked for on open.
    if (window.matchMedia?.("(max-width: 1100px)").matches) return;
    const id = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onFind = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (!e.ctrlKey && !e.metaKey) return;
      /* The browser's own find is what this replaces, and on a page whose
         rows hide themselves under a filter it is the worse of the two: it
         highlights text inside whatever happens to be mounted and says
         nothing about the twenty-three pages that are not. */
      e.preventDefault();
      searchRef.current?.focus({ preventScroll: true });
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, [open]);
  useEffect(() => {
    if (!escArmed) return;
    const t = setTimeout(() => setEscArmed(false), ESC_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [escArmed]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escRef.current) { escRef.current = false; setEscArmed(false); onClose(); return; }
      escRef.current = true;
      setEscArmed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /** The page on screen as the nav knows it: a plugin's own page is the Plugins page. */
  const navPane = pane.startsWith("plugin:") ? "plugins" : pane;
  const navTab = TABS.find((x) => x.id === navPane);
  const colRef = useRef<HTMLDivElement | null>(null);
  useStableFlow(colRef, [open, pane, q]);
  const tabIcons = useMemo(() => new Map(tabs.map((t) => [t.id as string, t.icon])), [tabs]);
  /* What a page says about itself after it opened: it failed to read what it shows, or a write is out.
     The facts above are one read per open; these are the pages' own, so they turn the nav dot and the
     header chip without the shell knowing a thing about Jira or an engine scan. */
  const [problems, setProblems] = useState<Record<string, PageProblem>>({});
  const [needsBy, setNeedsBy] = useState<Record<string, PageNeed>>({});
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  // The page's own verdict beside its title (Orchestration names the setup in force); the pane publishes it.
  const [pageChip, setPageChip] = useState<HeaderChip | null>(null);
  const retries = useRef<Record<string, () => void>>({});
  const [heads, setHeads] = useState<Record<string, PageHead>>({});
  const headRuns = useRef<Record<string, () => void>>({});
  const pageState = useMemo<PageStateSink>(() => ({
    problem: (page, p, retry) => {
      if (p && retry) retries.current[page] = retry;
      setProblems((cur) => applyProblem(cur, page, p));
    },
    needs: (page, n) => setNeedsBy((cur) => {
      if (n ? cur[page]?.count === n.count && cur[page]?.title === n.title : !(page in cur)) return cur;
      const next = { ...cur };
      if (n) next[page] = n; else delete next[page];
      return next;
    }),
    head: (page, h, run) => {
      if (h && run) headRuns.current[page] = run;
      setHeads((cur) => {
        if (!h) { if (!(page in cur)) return cur; const { [page]: _gone, ...rest } = cur; return rest; }
        return { ...cur, [page]: h };
      });
    },
    saving: (page, on) => setSaving((cur) => {
      if (cur.has(page) === on) return cur;
      const next = new Set(cur);
      if (on) next.add(page); else next.delete(page);
      return next;
    }),
  }), []);
  const pageFacts = usePageFacts();
  const marks = useMemo(() => withProblems(withNeeds(navMarks({
    ...NO_FACTS, ...facts,
    connectionsNeed: badges.connections ?? null,
    remoteLive: badges.remote ? badges.remote === "live" : null,
    clickupConnected: cuConnected,
  }), needsBy), problems), [facts, badges, logDigest, cuConnected, problems, needsBy]);

  return (
    /* Everything this dialog opens — a confirm, a menu, a picker — is a portal
       of its own, and a portal's floor is 9999 unless it is told otherwise.
       Under a dialog that sits at LAYER.settings they were drawn BEHIND it:
       measured with the plugin approval, which answered a click by showing
       nothing at all. Inside here the floor is this dialog's own layer. */
    <PortalFloor.Provider value={LAYER.settings + 1}>
    <Portal z={LAYER.settings} find>
      <AnimatePresence>
        {open && (
          /*
           * A PAGE, not a dialog.
           *
           * It was a 1010px card floating on a scrim, and the width was always
           * a compromise: wide enough for the Remote page's QR code and list of
           * devices, narrow enough to still read as a dialog. A settings screen
           * is somewhere you go — so it takes the window, the scrim goes, and
           * the width stops being a decision at all. The nav gets 280px and
           * the content gets the rest of whatever screen he is on.
           *
           * Still a Portal at LAYER.settings: what is underneath must not be
           * reachable, and a popover opened from a row still has to land above
           * it.
           */
          <motion.div
            {...dialog}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="agx-settings-shell fixed inset-0 flex pointer-events-auto"
            style={{ zIndex: 10000, background: "var(--bg)" }}>

            {/* Back to app and the search box sit OUTSIDE the scrolling list, so a
                long nav can never push either off the top. The nav paints its
                OWN tone (--surface-nav) at a full-strength seam: it shared --bg
                with the page, so two regions that do entirely different jobs —
                twenty-four places you can go, and the one you are in — were the
                same surface with a 25%-alpha hairline between them. */}
            <SettingsNav
              pages={tabs} marks={marks} current={navPane}
              onGo={(id) => setPane(id as Pane)} onClose={onClose}
              pinned={onboarding && !onboardingDone && !ql
                ? { done: [onboarding.hook, onboarding.provider, onboarding.paneEngine].filter(Boolean).length, total: 3, active: pane === "onboarding" }
                : null}
              search={
                <SettingsSearchPanel q={q} onQ={setQ} mode={matchIn} onMode={setMatchIn} model={searchModel}
                  absent={absentHit?.say ?? null} onLand={landOnResult} inputRef={searchRef} icons={tabIcons} />
              } />

                  {/* The COLUMN is capped, and everything in it ends together.
                      Capping the ROW was the first attempt and it left every
                      divider stopping in mid-air with a third of the dialog
                      empty beside it — because the pane title and the section
                      eyebrows went on reaching the full width, so the rules
                      were the only thing that stopped. Cap the container and
                      the title, the eyebrows, the dividers and the rows share
                      one right edge, which is a page margin rather than a
                      severed rule. Left, not centred: centring leaves 127px of
                      channel each side, two thirds of the nav's own width, and
                      moves the left reading edge every time a wide pane opts
                      out. See .agx-settings-col. */}
                  {/* The reading edge sits well clear of the nav. In the dialog this was
                px-5 because there were only 780px to spend and every one of
                them was measure; on a page the column is capped at 1120 and sits on the nav side,
                so the slack is free and the gap is what stops the title reading
                as an extension of the nav it sits beside. */}
            <div ref={contentRef} tabIndex={-1} className="agx-settings-main agx-scroll flex-1 min-w-0 overflow-y-auto">
              {/* The header stays while the cards scroll under it. It names the
                  page on screen even while a query is stacking other pages
                  below it: those carry their own heading (PageMatchHeading). */}
              {navTab && (
                <SettingsPageHeader
                  label={navTab.label} group={groupByName(navTab.group) ?? null} icon={navTab.icon} what={navTab.what}
                  chips={pageChips(navTab.id, headerChips(navTab.id, marks[navTab.id] ?? NO_MARK, saving.has(navTab.id), savedPages.has(navTab.id), heads[navTab.id]?.chips), pageFacts).concat(navTab.id === "orchestration" && pageChip ? [pageChip] : [])}
                  primary={problems[navTab.id] ? <Button tone="primary" onClick={() => retries.current[navTab.id]?.()}>Try again</Button>
                    : heads[navTab.id]?.action ? <Button tone="primary" onClick={() => headRuns.current[navTab.id]?.()}>{heads[navTab.id]!.action!.plain ? heads[navTab.id]!.action!.label : <IconLabel icon={<PlusIcon size={ICON.xs} />}>{heads[navTab.id]!.action!.label}</IconLabel>}</Button> : undefined}
                  reset={pageModified(navTab.id) || ALWAYS_RESET.has(navTab.id) ? <Button disabled={!pageModified(navTab.id)} onClick={() => resetPage(navTab.id)}>{RESET_WORD[navTab.id] ?? "Reset page"}</Button> : undefined} />
              )}
              {/* The page's hue (its group's) tints every card's icon chip; a board's width
                  is set here, on the ancestor of both the grid that reads it and the
                  column, because a property inherits downward only. */}
              <div className="agx-settings-page"
                style={{
                  "--hue": hueVar(groupByName(navTab?.group ?? "")?.id ?? "system"),
                  ...(WIDE_PANES.has(pane) ? { "--agx-settings-col": WIDE_PANES.get(pane) } : null),
                } as React.CSSProperties}>
                {!ql && !NO_TOC.has(navPane) && <SettingsToc scope={colRef} scroller={contentRef} page={navPane} />}
                <div className="agx-settings-content">
                  {/*
                    A BOARD (WIDE_PANES) is one column at the width it chose,
                    not the card flow: its content is a grid or a map of its
                    own, and two flow columns would cut it to 365px cards, the
                    width that produced the 359x596 letterbox nobody could
                    look at. The width is set on the page above, because a
                    custom property inherits downward only.
                  */}
                  <div ref={colRef} className="agx-settings-col" data-flow={WIDE_PANES.has(pane) ? "single" : undefined}>
                  <PageState.Provider value={pageState}>
                  <Filter.Provider value={filterCtx}>
                  {ql && show("appearance") && <PageMatchHeading id="appearance" onOpen={() => { setPane("appearance" as Pane); setQ(""); }} />}
                  {show("appearance") && (
                  <AppearancePane key={appearanceNonce} current={theme} onChange={onTheme} onAccent={setAccentState} />
                  )}
                  {ql && show("terminal") && <PageMatchHeading id="terminal" onOpen={() => { setPane("terminal" as Pane); setQ(""); }} />}
                  {show("terminal") && (<>
                  <TerminalRunsOn open={open} />
                  <LaunchPermissionsCard open={open} />
                  {/* THREE groups, and it was one. Eleven rows in a single
                      unnamed box is a page you have to read end to end to find
                      out whether the thing you came for is on it — the renderer
                      and the word separators are not the same subject and were
                      drawn as though they were. Named groups turn "read the
                      page" into "read three headings". */}
                  <SettingsCard title="How it draws" icon={<SlidersIcon size={ICON.sm} />}
                    desc="The renderer, the face, and the size of a cell.">
                    {/* GPU (WebGL) is fastest but blanks white on some Linux
                        GPU/compositor stacks; Canvas is the same drawing minus
                        the GPU — fast, and no context to lose — so Auto uses GPU
                        everywhere except Linux, where it uses Canvas. DOM is the
                        last resort, and the slow one. All apply to new shells. */}
                    <Choice<RendererPref>
                      settingId="terminal.renderer"
                      label="Terminal renderer"
                      hint="GPU is fastest; Canvas never blanks; DOM is the slow fallback."
                      detail={{ summary: "Details", body: <>GPU is fastest; Canvas is nearly as fast and never blanks; DOM is the slow fallback. A change applies to newly opened shells.</> }}
                      value={renderer} modified={renderer !== "auto"}
                      onPick={(v) => { setting("terminal.renderer").set(v); setRenderer(v); }}
                      options={[
                        { v: "auto", label: "Auto" },
                        { v: "gpu", label: "GPU" },
                        { v: "canvas", label: "Canvas" },
                        { v: "dom", label: "Compatibility" },
                      ]} />

                    {/*
                      * A face, chosen by looking at it.
                      *
                      * The grid did render each name in its own font, which is
                      * better than nothing and still not the question: what
                      * separates one monospace face from another is `0Oo l1I`
                      * and whether the arrows and pipes line up, and no face
                      * shows you that by spelling its own name. So the choice
                      * is one row like every other, and under it is the line
                      * you are actually choosing between, in the face you are
                      * choosing. The unavailable ones are named rather than
                      * listed: a menu entry that refuses to be picked is worse
                      * than a sentence saying why.
                      */}
                    <SettingRow
                      settingId="terminal.font"
                      label="Font" modified={termFont !== ""}
                      hint="These faces ship with agentglass."
                      detail={{ summary: "Details", body: <>No install needed, and they render the same on any machine.
                        {TERM_FONTS.filter((f) => !(f.bundled || fontAvailable(f.family))).length > 0 && (
                          <> Not on this machine: {TERM_FONTS.filter((f) => !(f.bundled || fontAvailable(f.family))).map((f) => f.name).join(", ")}.</>
                        )}</> }}
                      control={<span className="flex justify-end"><Select
                        align="right"
                        value={termFont}
                        onChange={(v) => { setting("terminal.font").set(v); setTermFontState(v); }}
                        options={TERM_FONTS
                          .filter((f) => f.bundled || fontAvailable(f.family))
                          .map((f) => ({ value: f.id, label: f.name }))}
                      /></span>}
                      below={
                        <div className="rounded-lg px-3 py-2 whitespace-pre overflow-x-auto"
                          aria-label="How the chosen face looks"
                          style={{
                            background: "color-mix(in srgb, var(--bg) 70%, transparent)",
                            fontFamily: TERM_FONTS.find((f) => f.id === termFont)?.stack || undefined,
                            fontSize: `${termSize}px`, lineHeight: 1.35, color: "var(--text)",
                          }}>
                          {"$ git rebase --continue\n"}
                          <span style={{ color: "var(--success-ink)" }}>{"+ 0Oo l1I |¦ <>= != -> =~ {}[]()\n"}</span>
                          <span style={{ color: "var(--text3)" }}>{"  1234567890  .,;:'\"`  ~^*&%$#@"}</span>
                        </div>
                      }
                    />
                    <Stepper
                      settingId="terminal.fontSize"
                      label="Font size"
                      hint="Applies live to every open terminal."
                      detail={{ summary: "Details", body: `Remembered between launches. ${MOD_KEY}+ / ${MOD_KEY}− with the pointer over a terminal does the same without touching the window.` }}
                      value={`${termSize}px`} modified={termSize !== DEFAULT_SIZE}
                      onDec={() => { const n = Math.max(SIZE_MIN, termSize - 1); setting("terminal.fontSize").set(n); setTermSizeState(n); }}
                      onInc={() => { const n = Math.min(SIZE_MAX, termSize + 1); setting("terminal.fontSize").set(n); setTermSizeState(n); }}
                      canDec={termSize > SIZE_MIN} canInc={termSize < SIZE_MAX} />
                    {/* The warning is the point of exposing this at all. Air
                        between rows is a real preference, and above 1 it is
                        paid for in broken box rules on the DOM renderer —
                        which is the default on Linux. Better said here than
                        discovered as "the terminal looks wrong". */}
                    <Stepper
                      settingId="terminal.lineHeight"
                      label="Line height"
                      hint="Space between rows."
                      detail={{ summary: "Details", body: termLine > LINE_HEIGHT_MIN
                        ? "Above 1, box-drawing rules — the divider between tmux panes, the frames around an agent's output — are drawn with a gap on every row wherever the GPU renderer is off (the default on Linux). 1 keeps them solid."
                        : "1 keeps box-drawing rules solid, which is what a terminal is normally set to. Above 1, they are drawn with a gap on every row wherever the GPU renderer is off (the default on Linux)." }}
                      value={termLine.toFixed(2).replace(/0$/, "")} modified={termLine !== DEFAULT_LINE_HEIGHT}
                      onDec={() => { const n = Math.max(LINE_HEIGHT_MIN, Math.round((termLine - 0.05) * 100) / 100); setting("terminal.lineHeight").set(n); setTermLineState(n); }}
                      onInc={() => { const n = Math.min(LINE_HEIGHT_MAX, Math.round((termLine + 0.05) * 100) / 100); setting("terminal.lineHeight").set(n); setTermLineState(n); }}
                      canDec={termLine > LINE_HEIGHT_MIN} canInc={termLine < LINE_HEIGHT_MAX} />
                    <Choice<CursorStyle>
                      settingId="terminal.cursor"
                      label="Cursor"
                      hint="The shape that marks where you're typing."
                      value={termCursor} modified={termCursor !== "block"}
                      onPick={(v) => { setting("terminal.cursor").set(v); setTermCursorState(v); }}
                      options={CURSORS} />
                  </SettingsCard>

                  <SettingsCard title="Mouse and clipboard" icon={<TerminalIcon size={ICON.sm} />}
                    desc="What pointing at a pane does, and what a selection does.">
                    {/* Off by default: focus that moves on its own is the one
                        terminal habit people either keep for life or cannot
                        stand, and a machine that has never been asked expects
                        the click. */}
                    <Toggle on={ffm} modified={ffm} onClick={() => { const v = !ffm; setting("terminal.focusFollowsMouse").set(v); setFfm(v); }}
                      settingId="terminal.focusFollowsMouse" label="Focus follows mouse"
                      hint="A pane takes focus when the pointer enters it. Only terminals." />
                    {/* On by default, because it is what this terminal has
                        always done — the switch is for the machine where the
                        clipboard is shared with something that reacts to it. */}
                    {/* The bar a pane keeps under its own bottom edge — the
                        worktree, the changes, the pull request and the card of
                        THAT pane. On by default: with six panes open it is how
                        you reach the bottom one without dragging the pointer
                        across the others, and it is not on screen until the
                        pointer is on the seam at the pane's foot. */}
                    <Toggle on={paneActs !== "off"} modified={paneActs !== "hover"}
                      onClick={() => { const v = paneActs === "off" ? "hover" : "off"; setting("terminal.paneBar").set(v === "hover"); setPaneActs(v); }}
                      settingId="terminal.paneBar" label="Bar on a pane"
                      hint="Point at a pane's bottom edge: branch, changes, PR and card."  />
                    <Toggle on={copySel} modified={!copySel} onClick={() => { const v = !copySel; setting("terminal.copyOnSelect").set(v); setCopySel(v); }}
                      settingId="terminal.copyOnSelect" label="Copy on select"
                      hint="A selection is on the clipboard at once, as in tmux." />
                    <Toggle on={rcPaste} modified={rcPaste} onClick={() => { const v = !rcPaste; setRightClickPaste(v); setRcPaste(v); }}
                      agentNever="a click then types the clipboard into a live shell: not something an agent switches on for the owner"
                      label="Right-click to paste"
                      hint="Right-click pastes; Ctrl+right-click opens the menu." />
                  </SettingsCard>

                  <SettingsCard title="Tab groups" icon={<ColumnsIcon size={ICON.sm} />}
                    desc="Tabs grouped by the project each window is working in.">
                    <Toggle on={groupsOn} modified={!groupsOn} onClick={() => { const v = !groupsOn; setting("terminal.tabGroups").set(v); setGroupsOn(v); }}
                      settingId="terminal.tabGroups" label="Group tabs by project"
                      hint="Off draws every tab in one row, in tmux's order."
                      detail={{ summary: "Details", body: "The group you are in is open; the others fold into a chip that still shows what their agents are doing. Right-click a tab to pin it first in its group or move it to another; drag it onto a group to do the same." }} />
                    {/* The tie-break for a window whose folder is not its
                        project. None ship: a rule is a guess about how
                        somebody names things, and the folder is right for
                        everyone else. */}
                    <SettingRow
                      settingId="terminal.tabGroupRules" label="Group by name" modified={groupRules !== ""}
                      hint={parseRules(groupRules).length
                        ? `${parseRules(groupRules).length} ${parseRules(groupRules).length === 1 ? "rule" : "rules"} in use. One per line: prefix=group.`
                        : "None yet: windows are grouped by their folder. One per line: prefix=group."}
                      detail={{ summary: "Details", body: <>A window whose name starts with a prefix goes to that group, whatever folder it runs in, like <span className="t-mono text-[11px]">agx=agentglass</span>.</> }}
                      below={
                        <textarea value={groupRules} onChange={(e) => setGroupRules(e.target.value)} rows={3}
                          onBlur={() => { setting("terminal.tabGroupRules").set(groupRules); }}
                          placeholder={"agx=agentglass\nops=infra"} spellCheck={false} aria-label="Group-by-name rules"
                          className={`t-mono w-full ${INPUT}`}
                          style={{ ...INPUT_STYLE, height: "auto", resize: "vertical" }} />
                      } />
                  </SettingsCard>

                  <SettingsCard title="History and selection" icon={<ClockIcon size={ICON.sm} />}
                    desc="How far back a shell remembers, and what a double-click takes.">
                    {/* Sizes rather than a number box: the cost is memory PER
                        SHELL and this app holds several open at once, so the
                        step from 4k to 50k is one somebody should take on
                        purpose. */}
                    <Choice<string>
                      settingId="terminal.scrollback" label="Scrollback"
                      hint="Lines kept per shell."
                      detail={{ summary: "Details", body: scrollback > DEFAULT_SCROLLBACK
                        ? `${scrollback.toLocaleString()} lines are kept per shell. Every line is cell data held in memory and reflowed on every resize — with several shells open, that is where a drag starts to stutter.`
                        : "Applies live. The larger sizes cost memory per shell and make resizing slower." }}
                      value={String(scrollback)} modified={scrollback !== DEFAULT_SCROLLBACK}
                      onPick={(v) => { const n = Number(v); setting("terminal.scrollback").set(n); setScrollbackState(n); }}
                      options={SCROLLBACK_SIZES.map((n) => ({ v: String(n), label: n >= 1000 ? `${n / 1000}k` : String(n) }))} />
                    <SettingRow
                      settingId="terminal.wordSeparators" label="Word separators"
                      modified={wordSep !== DEFAULT_WORD_SEPARATORS}
                      hint="Characters a double-click stops at. Empty takes the line."
                      control={
                        <span className="flex justify-end">
                          <Button onClick={() => { setting("terminal.wordSeparators").set(DEFAULT_WORD_SEPARATORS); setWordSepState(DEFAULT_WORD_SEPARATORS); }}
                            disabled={wordSep === DEFAULT_WORD_SEPARATORS}>
                            Reset
                          </Button>
                        </span>
                      }
                      below={
                        <input value={wordSep} spellCheck={false} maxLength={200} aria-label="Word separators"
                          onChange={(e) => { setWordSepState(e.target.value); setting("terminal.wordSeparators").set(e.target.value); }}
                          className={`w-full ${INPUT}`}
                          style={{ ...INPUT_STYLE, fontFamily: "ui-monospace, monospace" }} />
                      } />
                  </SettingsCard>

                  <SettingsCard title="Bench note" icon={<EditIcon size={ICON.sm} />}
                    desc="The note tab of the floating bench.">
                    <Choice<NoteEditor> settingId="terminal.noteEditor" label="Note editor" value={noteEd} modified={noteEd !== "builtin"}
                      hint="Neovim needs nvim installed; else the built-in one."
                      options={NOTE_EDITORS} onPick={(v) => { setting("terminal.noteEditor").set(v); setNoteEd(v); }} />
                  </SettingsCard>
                  </>)}
                  {ql && show("diff") && <PageMatchHeading id="diff" onOpen={() => { setPane("diff" as Pane); setQ(""); }} />}
                  {show("diff") && (
                  <WithPreview preview={<PreviewCard id="diff" title="The real Diff view"><DiffPreview split={dSplit} wrap={dWrap} syntaxTheme={dTheme} /></PreviewCard>}>
                  <SettingsCard title="How a diff opens" icon={<DiffIcon size={ICON.sm} />}
                    desc="The view you land on, and what happens to a long line.">
                    {/* Defaults, not the live state: the toggle in each panel
                        still wins while you are looking at that diff. Changing
                        your mind about one file is not a preference. */}
                    <Choice<"split" | "inline">
                      settingId="diff.split" wide
                      label="Default view"
                      hint="The view you land on."
                      detail={{ summary: "Details", body: "How file changes, source control and pull requests open a diff. The toggle in each panel still overrides it for that diff." }}
                      value={dSplit ? "split" : "inline"} modified={dSplit !== DEFAULT_SPLIT}
                      onPick={(v) => { setting("diff.split").set(v); setDSplitState(v === "split"); }}
                      options={[{ v: "split", label: "Split" }, { v: "inline", label: "Inline" }]} />
                    <Toggle on={dWrap} modified={dWrap !== DEFAULT_WRAP} onClick={() => { const v = !dWrap; setting("diff.wrap").set(v); setDWrapState(v); }}
                      settingId="diff.wrap"
                      label="Wrap long lines"
                      hint="Off scrolls sideways instead."
                      detail={{ summary: "Details", body: "Off keeps the columns aligned, which is what makes a code diff scannable; on is what a markdown or prose diff wants." }} />
                    <SettingRow
                      settingId="diff.syntaxTheme"
                      label="Diff syntax theme"
                      hint="Colours for code inside a diff."
                      detail={{ summary: "Details", body: "Auto follows the app's light or dark; the toolbar in a diff changes the same setting." }}
                      control={<span className="flex justify-end"><Select align="right" value={dTheme}
                        onChange={(v) => { setting("diff.syntaxTheme").set(v); setDThemeState(v); }}
                        options={[
                          { value: "auto", label: "Auto (app theme)" },
                          ...THEMES.map((t) => ({ value: t.id, label: t.label, hint: t.dark ? "Dark" : "Light" })),
                        ]} /></span>} />
                  </SettingsCard>
                  </WithPreview>
                  )}
                  {ql && show("tasks") && <PageMatchHeading id="tasks" onOpen={() => { setPane("tasks" as Pane); setQ(""); }} />}
                  {show("tasks") && (
                  <>
                  <SettingsCard title="Opens on" icon={<ChecklistIcon size={ICON.sm} />} desc="Where the Tasks view starts.">
                    {/* There was no setting here before and no default either:
                        the tab was component state initialised to "all", so
                        every visit started over — on the one view that does not
                        include your ClickUp cards. See taskLanding.ts. */}
                    <SettingRow
                      settingId="tasks.landing" label="Tasks view opens on"
                      hint="Where the view lands when you come back."
                      detail={{ summary: "Details", body: "“Last used” picks up where you left off; naming a source pins it there whatever you did last. Following a card link from a pull request never changes this." }}
                      control={<span className="flex justify-end"><Select align="right" value={landing}
                        onChange={(v) => { setting("tasks.landing").set(v); setLandingState(v as TaskLanding); }}
                        options={[
                          { value: "last", label: "Last used" },
                          { value: "all", label: "All" },
                          ...TASK_SOURCES.map((s) => ({ value: s.id, label: s.label })),
                        ]} /></span>} />
                  </SettingsCard>
                  <SettingsCard title="Task sources" icon={<ColumnsIcon size={ICON.sm} />}
                    desc="Every source adds its cards to the same board."
                    actions={<Button onClick={() => { resetTaskSourceOrder(); setSourceTick((n) => n + 1); }}>Reset order</Button>}>
                    {/* Order is the row's own, and the arrows move a source
                        through the FULL list rather than the visible one — see
                        moveTaskSource. Arrows rather than dragging: this pane's
                        every other control works from a keyboard, and a drop
                        target would be the one that does not. */}
                    {sourceOrder.map((id, i) => (
                      <SourceRow key={id} id={id} i={i} n={sourceOrder.length}
                        onChanged={() => setSourceTick((n) => n + 1)}
                        state={id === "clickup" ? (trackerSetup?.clickup ? "connected" : "off") : id === "jira" ? (trackerSetup?.jira ? "connected" : "off") : undefined} />
                    ))}
                    <SettingRow agentExempt label="How sources are chosen" hint="One has to stay on."
                      detail={{ summary: "Details", body: "A source you have not set up is left off by itself, until none is set up, when all of them show, because the bar is then the only place to find them. Connect them under Tools & services." }} />
                  </SettingsCard>
                  <CardTrackerSection />
                  </>
                  )}
                  {ql && show("privacy") && <PageMatchHeading id="privacy" onOpen={() => { setPane("privacy" as Pane); setQ(""); }} />}
                  {show("privacy") && <PrivacyPane open={open} />}
                  {ql && show("recipes") && <PageMatchHeading id="recipes" onOpen={() => { setPane("recipes" as Pane); setQ(""); }} />}
                  {show("recipes") && <RecipesPane open={open} />}
                  {ql && show("review-prompts") && <PageMatchHeading id="review-prompts" onOpen={() => { setPane("review-prompts" as Pane); setQ(""); }} />}
                  {show("review-prompts") && <ReviewPromptsPane open={open} />}
                  {ql && show("saved-replies") && <PageMatchHeading id="saved-replies" onOpen={() => { setPane("saved-replies" as Pane); setQ(""); }} />}
                  {show("saved-replies") && <SavedRepliesPane open={open} />}
                  {ql && show("prefs") && <PageMatchHeading id="prefs" onOpen={() => { setPane("prefs" as Pane); setQ(""); }} />}
                  {show("prefs") && (
                  <WithPreview preview={<PreviewCard id="prefs" title="This window on your desktop" actions={<LiveTabs view={liveView} onView={setLiveView} />}>
                    {/* No on/off for the clock: the top bar shows it in fullscreen whatever the 12h/24h choice. */}
                    <WindowPreview zoomPct={Math.round(scale * 100)} fullscreen={fullscreen} startAtLogin={autostart === true} launchAnimation={splash}
                      showClock codexQuota={usageRefresh} view={liveView} rail={railItems(railLayout)} /></PreviewCard>}>
                  <SettingsCard title="Size and startup" icon={<PanesIcon size={ICON.sm} />}>
                    {/* Desktop only, like launch-at-login: in a browser tab the
                        browser's own zoom already does this, and better. The
                        four common sizes sit under the words, as one choice. */}
                    {IS_DESKTOP && (
                      <SettingRow label="Display size" modified={scale !== DEFAULT_SCALE}
                        hint="How big everything inside the window is."
                        detail={{ summary: "Details", body: `Remembered between launches. ${MOD_KEY}+ / ${MOD_KEY}− anywhere, ${MOD_KEY}0 to reset — except over a terminal, where the same keys size the terminal instead and leave the window alone.` }}
                        below={<ScaleControl scale={scale} onZoom={(d) => { onZoom(d); flashSaved("prefs"); }} />} />
                    )}
                    <Toggle on={fullscreen} onClick={async () => { setFullscreenState(await toggleFullscreen()); flashSaved("prefs"); }}
                      label="Fullscreen"
                      hint="Hide the window frame — F11 anywhere." />
                    {autostart !== null && (
                      <Toggle on={autostart} onClick={async () => {
                        const next = await setAutostart(!autostart);
                        if (next !== null) { setAutostartState(next); flashSaved("prefs"); }
                      }}
                        label="Start at login"
                        hint="Open agentglass automatically when you log in." />
                    )}
                    {/* Read before anything is drawn (web/index.html), so the
                        change shows at the next launch, not this one. */}
                    <Toggle on={splash} modified={!splash} onClick={() => { const v = !splash; setSplashOn(v); setSplash(v); flashSaved("prefs"); }}
                      label="Launch animation"
                      hint="The cover that plays while the app wakes up."
                      detail={{ summary: "Details", body: "Covers the window while the terminal, sessions and git load, then the mark flies to the top bar. Off shows the plain loading screen. Takes effect from the next launch." }} />
                  </SettingsCard>

                  <SettingsCard title="Top bar" icon={<SlidersIcon size={ICON.sm} />}>
                    <Choice<"12" | "24">
                      label="Clock"
                      hint="12 or 24 hours, in fullscreen."
                      detail={{ summary: "Details", body: "The top bar shows the time in fullscreen, where the desktop's own clock is hidden." }}
                      value={h24 ? "24" : "12"}
                      onPick={(v) => { setClock24(v === "24"); setH24(v === "24"); flashSaved("prefs"); }}
                      options={[{ v: "12", label: "12h" }, { v: "24", label: "24h" }]} />
                    {/* The same switch as Keep Codex usage current under Usage & budgets:
                        one setting, shown where the top bar's Codex line is decided. */}
                    <Toggle on={usageRefresh}
                      onClick={() => { setUsageRefreshOn(!usageRefresh); setUsageRefreshState(!usageRefresh); flashSaved("prefs"); }}
                      label="Codex quota"
                      hint="Keep Codex usage current."
                      detail={{ summary: "Details", body: "Runs a minimal Codex turn hourly so the quota reading is not stale. It uses a small amount of the quota it measures. The same switch is under Usage & budgets." }} />
                  </SettingsCard>

                  <SettingsCard title="Disk space" icon={<DiskIcon size={ICON.sm} />}>
                    <Choice<string>
                      settingId="prefs.diskWarn" label="Warn when free disk is under"
                      hint="A quiet badge on the machine panel; nothing pops up."
                      detail={{ summary: "Details", body: "Counted per disk, as a share of its size. Off shows no badge. This only decides when to say so: nothing is deleted by it." }}
                      value={String(diskWarn)} modified={diskWarn !== DISK_WARN_DEFAULT}
                      onPick={(v) => { setting("prefs.diskWarn").set(Number(v)); }}
                      options={DISK_WARN_CHOICES.map((n) => ({ v: String(n), label: n === 0 ? "Off" : `${n} %` }))} />
                  </SettingsCard>

                  {/* Only steps that are true: the cover is listed when it is
                      on, the login step when the app starts with the machine,
                      the Lantern when it is watching. */}
                  <SettingsCard title="What happens at login" icon={<ChecklistIcon size={ICON.sm} />}
                    desc="In this order, and only the steps you left on.">
                    {/* In a wrapper, not directly in the card body: a numbered list is read
                        down the circles, so it has no rule between its steps. */}
                    <div className="agx-steps">
                    {[
                      ...(autostart ? [["agentglass starts", "when you log in to this machine"]] : []),
                      ...(splash ? [["The launch cover plays", "while the terminal, sessions and git load"]] : []),
                      ["agentglass opens", IS_DESKTOP ? `at the size you picked: ${fmtScale(scale)}` : "in its window"],
                      ["Your panes come back", "where they were, from the last layout capture"],
                      ...(facts.lanternWatching ? [["The Lantern starts watching", "one look right away, then on its schedule"]] : []),
                    ].map(([name, what], i) => (
                      <SettingRow key={name} agentExempt hint={what}
                        label={<span className="agx-step"><i aria-hidden>{i + 1}</i>{name}</span>} />
                    ))}
                    </div>
                  </SettingsCard>
                  </WithPreview>
                  )}

                  {/* The engine and the memory it costs, together. Both used to
                      sit under "Preferences", which is where settings go when
                      nobody has decided where they belong — a page that mixes
                      window zoom with how a CLI is spawned is a drawer. */}
                  {ql && show("budgets") && <PageMatchHeading id="budgets" onOpen={() => { setPane("budgets" as Pane); setQ(""); }} />}
                  {show("budgets") && (
                  <>
                    <PacePane />
                    {/* A limit you chose, so the spend insights stop firing on
                        constants — which are noise on a project that genuinely
                        costs that and silence on one where a tenth would be
                        alarming. */}
                    <BudgetsPane open={open} />
                  </>
                  )}
                  {show("budgets") && <GhBudget open={open} />}
                  {show("budgets") && (
                  <SettingsCard title="Codex" icon={<PlugIcon size={ICON.sm} />}>
                    {/* Says what it costs, because it costs something: this
                        spends a little of the quota it is measuring. */}
                    <Toggle on={usageRefresh}
                      onClick={() => { setUsageRefreshOn(!usageRefresh); setUsageRefreshState(!usageRefresh); }}
                      label="Keep Codex usage current"
                      hint="Reads the meter hourly while the window is open."
                      detail={{ summary: "Details", body: <>Runs a minimal Codex turn hourly so the quota reading is not stale. It uses a small amount of the quota it measures.</> }} />
                  </SettingsCard>
                  )}

                  {ql && show("notifications") && <PageMatchHeading id="notifications" onOpen={() => { setPane("notifications" as Pane); setQ(""); }} />}

                  {show("notifications") && (
                  <NotificationsSection
                    sound={sound} onSound={onSound}
                    quiet={quiet} mutedList={mutedList} own={own}
                    notifyVoice={notifyVoice} onNotifyVoice={(v) => { setNotifyVoice(v); setNotifyVoiceState(v); }}
                    alarmVoice={alarmVoice} onAlarmVoice={(v) => { setAlarmVoice(v); setAlarmVoiceState(v); }}
                    ciApproved={ciApproved} onCiApproved={() => { const v = !ciApproved; setting("notifications.ciOnlyApproved").set(v); setCiApproved(v); }}
                    reviewGate={reviewGate} onReviewGate={() => { const v = !reviewGate; setReviewGate(v); setReviewGateState(v); }}
                    talkMode={talkMode} onTalkMode={(v) => { setting("notifications.talk").set(v); setTalkMode(v); }}
                    sysNotify={sysNotify} notifyCap={notifyCap} />
                  )}

                  {ql && show("browser") && <PageMatchHeading id="browser" onOpen={() => { setPane("browser" as Pane); setQ(""); }} />}

                  {show("browser") && <BrowserPane><CookieImport /></BrowserPane>}

                  {ql && show("rail") && <PageMatchHeading id="rail" onOpen={() => { setPane("rail" as Pane); setQ(""); }} />}

                  {show("rail") && <RailPane />}

                  {ql && show("keys") && <PageMatchHeading id="keys" onOpen={() => { setPane("keys" as Pane); setQ(""); }} />}

                  {show("keys") && (() => {
                    const ids = Object.keys(DEFAULTS) as ActionId[];
                    const viewIds = ids.filter((id) => id.startsWith("view.")) as `view.${ViewId}`[];
                    const rest = ids.filter((id) => !id.startsWith("view."));
                    const stop = () => { setKeyError(null); setCapturing(null); setCapturingChord(null); setCapturingApp(null); };
                    return (
                    <>
                      {/*
                        * Grouped by WHERE the key works, as the mockup draws it, and one line a key:
                        * a name, the key as keycaps, Rebind. A view has two bindings because it is
                        * reachable from two places, so it is in two cards, once in each, rather
                        * than two columns of chips in one row (which is what made a 1,300px card
                        * that left two thirds of a wide window empty).
                        */}
                      <SettingsCard title="Anywhere" icon={<KeyboardIcon size={ICON.sm} />}
                        desc="Works in every view, also while a terminal has focus.">
                        {viewIds.map((id) => {
                          const view = id.slice(5) as ViewId;
                          const key = chordFor(view);
                          const cap = capturingChord === view;
                          return (
                            <SettingRow key={id}
                              agentNever="a chord that is delivered while a terminal has the focus, so a binding made for the owner could shadow a key their shell needs"
                              label={<span onClick={() => { stop(); setCapturingChord(view); }} className="cursor-pointer">{keyRowName(id)}</span>}
                              control={<span className="flex items-center gap-1.5 justify-self-end">
                                <KeyCaps text={cap ? "Hold a combo…" : key ? chordLabel(key) : "—"} active={cap} custom={hasCustomChord(view)} faint={!key && !cap}
                                  onClick={() => { stop(); setCapturingChord((c) => (c === view ? null : view)); }}
                                  title={hasCustomChord(view)
                                    ? `${chordLabel(key)} opens this: click to record another`
                                    : key ? `${chordLabel(key)} opens this, from its position in the top group: click to record your own`
                                      : "Only the top group is numbered: click to record a combination for this one"} />
                                {hasCustomChord(view) && !cap && <CloseButton onClick={() => { clearChord(view); setKeys({ ...bindings() }); }} title="Back to its position in the rail" />}
                                <RebindButton capturing={cap} what={keyRowName(id)} onClick={() => { stop(); setCapturingChord((c) => (c === view ? null : view)); }} />
                              </span>} />
                          );
                        })}
                      </SettingsCard>
                      <SettingsCard title="Only on the dashboard" icon={<DashIcon size={ICON.sm} />}
                        desc="Single keys that would type into a shell, so they stay out of terminals.">
                        {[...viewIds, ...rest].map((id) => {
                          const err = keyError?.id === id ? keyError.msg : null;
                          const keyName = keys[id];
                          const cap = capturing === id;
                          const begin = () => { setKeyError(null); setCapturingChord(null); setCapturingApp(null); setCapturing((c) => (c === id ? null : id)); };
                          return (
                            <SettingRow key={id} settingId={`keys.binding.${id}`}
                              label={<span onClick={begin} className="cursor-pointer">{keyRowName(id)}</span>}
                              hint={err ? <span style={{ color: "var(--error-ink)" }}>{err}</span> : id.startsWith("view.") ? undefined : <span className="t-dim">{LABELS[id].hint}</span>}
                              control={<span className="flex items-center gap-1.5 justify-self-end">
                                <KeyCaps text={cap ? "Press a key…" : keyName === " " ? "space" : keyName} active={cap} onClick={begin} />
                                <RebindButton capturing={cap} what={keyRowName(id)} onClick={begin} />
                              </span>} />
                          );
                        })}
                      </SettingsCard>
                      {/*
                        * Its own card, because it is the only binding on this page that keeps working with
                        * the caret inside a running shell — the terminal is told to hand it over rather
                        * than pass it to the PTY. That is also why it is the one most likely to collide
                        * with something you already use, and so the one that most needs to be movable.
                        */}
                      <SettingsCard title="Even inside a shell" icon={<TerminalIcon size={ICON.sm} />}
                        desc={<>A held combination the terminal gives up so it reaches the app. The shipped {chordLabel(APP_CHORD_DEFAULTS["files.palette"])} is free in bash, tmux and vim.</>}>
                        {(Object.keys(APP_CHORD_LABELS) as AppChordId[]).map((id) => {
                          const cap = capturingApp === id;
                          const begin = () => { setKeyError(null); setCapturing(null); setCapturingChord(null); setCapturingApp((c) => (c === id ? null : id)); };
                          const err = appKeyError?.id === id ? appKeyError.msg : null;
                          return (
                            <SettingRow key={id}
                              agentNever="a chord that is delivered while a terminal has the focus, so a binding made for the owner could shadow a key their shell needs"
                              label={<span onClick={begin} className="cursor-pointer">{APP_CHORD_LABELS[id].label}</span>}
                              hint={<span style={{ color: err ? "var(--error-ink)" : undefined }} className={err ? "" : "t-dim"}>{err ?? APP_CHORD_LABELS[id].hint}</span>}
                              control={<span className="flex items-center gap-1.5 justify-self-end">
                                <KeyCaps text={cap ? "Hold a combo…" : chordLabel(appChordFor(id))} active={cap} custom={hasCustomAppChord(id)} onClick={begin}
                                  title={`${chordLabel(appChordFor(id))} opens this: click to record ${hasCustomAppChord(id) ? "another" : "your own"}`} />
                                <RebindButton capturing={cap} what={APP_CHORD_LABELS[id].label} onClick={begin} />
                              </span>} />
                          );
                        })}
                      </SettingsCard>
                      <SettingsCard title="Defaults" icon={<SlidersIcon size={ICON.sm} />}>
                        <SettingRow
                          agentExempt label="Reset to defaults"
                          hint="Puts every key and chord back to the shipped one."
                          control={<Button tone="danger" disabled={!(isCustomised() || chordsCustomised() || appChordsCustomised())}
                            onClick={() => { resetBindings(); resetChords(); resetAppChords(); setKeyError(null); setAppKeyError(null); stop(); }}>
                            Reset to defaults
                          </Button>} />
                        {/* Says why the rest of the keyboard is not on this list.
                            Read once, by somebody wondering why their key was
                            refused — so it waits to be asked. */}
                        <SettingRow agentExempt label="Why some views have two keys"
                          hint="The dashboard uses single letters, everywhere else a chord."
                          detail={{
                            summary: "Anywhere and on the dashboard",
                            body: <>
                              <p className="m-0 mb-2">
                                <b style={{ color: "var(--text)" }}>anywhere</b> — hold any combination you like
                                ({MOD_KEY}J, {MOD_KEY}Alt+J, Alt+Shift+J) and it is recorded as held. Left alone it
                                follows the view's position in the rail, so reordering keeps it true.
                              </p>
                              <p className="m-0">
                                <b style={{ color: "var(--text)" }}>dashboard</b> — a single key, and only on the
                                dashboard: inside the workspace every keystroke belongs to whatever has focus,
                                usually a shell. {MOD_KEY}\\, {MOD_KEY}K and {MOD_KEY}[ / {MOD_KEY}] stay put.
                              </p>
                            </>,
                          }} />
                      </SettingsCard>
                    </>
                    );
                  })()}

                  {ql && show("lantern") && <PageMatchHeading id="lantern" onOpen={() => { setPane("lantern" as Pane); setQ(""); }} />}
                  {show("lantern") && <LanternSection open={open} />}
                  {ql && show("engines") && <PageMatchHeading id="engines" onOpen={() => { setPane("engines" as Pane); setQ(""); }} />}
                  {show("engines") && <EnginesPane />}
                  {ql && show("orchestration") && <PageMatchHeading id="orchestration" onOpen={() => { setPane("orchestration" as Pane); setQ(""); }} />}
                  {show("orchestration") && <OrchestrationPane onChip={setPageChip} />}
                  {ql && show("hooks") && <PageMatchHeading id="hooks" onOpen={() => { setPane("hooks" as Pane); setQ(""); }} />}

                  {show("hooks") && (
                  <AgentsPage open={open}
                    chats={
                    <NewChatsCard open={open} tmuxEngine={tmuxEngine} enginePref={enginePref}
                      onEngine={(next) => { setChatEnginePref(next); setEnginePref(next); }} />
                    }
                    panes={tmuxEngine?.available ? <RunningPanes open={open} /> : null}
                    browser={HAS_BROWSER ? <AgentBrowserPane open={open} /> : null}
                    skills={cu ? (
                      <SettingsCard title="Card skills" icon={<ChecklistIcon size={ICON.sm} />} desc="How agent skills relate to the cards of your tracker.">
                        <CardSkillsRow connected />
                      </SettingsCard>
                    ) : null} />
                  )}

                  {ql && show("tmux") && <PageMatchHeading id="tmux" onOpen={() => { setPane("tmux" as Pane); setQ(""); }} />}

                  {show("tmux") && (
                  <>
                    <TmuxPane open={open} onGoTerminal={() => { setPane("terminal" as Pane); setQ(""); }} />
                  </>
                  )}
                  {ql && show("connections") && <PageMatchHeading id="connections" onOpen={() => { setPane("connections" as Pane); setQ(""); }} />}
                  {show("connections") && <ToolsPane open={open} />}
                  {ql && show("clickup") && cu && <PageMatchHeading id="clickup" onOpen={() => { setPane("clickup" as Pane); setQ(""); }} />}
                  {show("clickup") && cu && <ClickUpPane />}
                  {ql && show("jira") && <PageMatchHeading id="jira" onOpen={() => { setPane("jira" as Pane); setQ(""); }} />}
                  {show("jira") && <JiraPane tracker={<CardTrackerSection />} />}

                  {ql && show("remote") && <PageMatchHeading id="remote" onOpen={() => { setPane("remote" as Pane); setQ(""); }} />}

                  {show("remote") && <RemoteAccessPane open={open} />}
                  {ql && show("plugins") && <PageMatchHeading id="plugins" onOpen={() => { setPane("plugins" as Pane); setQ(""); }} />}
                  {show("plugins") && <PluginsPane open={open} />}
                  {pane.startsWith("plugin:") && <PluginsPane open={open} focus={pane.slice("plugin:".length)} />}

                  {ql && show("log") && <PageMatchHeading id="log" onOpen={() => { setPane("log" as Pane); setQ(""); }} />}

                  {show("log") && <ActivityPane open={open} />}
                  {ql && show("understudy") && <PageMatchHeading id="understudy" onOpen={() => { setPane("understudy" as Pane); setQ(""); }} />}
                  {show("understudy") && <UnderstudyPane open={open} onLeave={onClose} />}
                  {ql && show("onboarding") && <PageMatchHeading id="onboarding" onOpen={() => { setPane("onboarding" as Pane); setQ(""); }} />}
                  {show("onboarding") && onboarding && (
                  <SettingsCard title="What is left to set up"
                    desc="Three things, and then this page goes away.">
                    {/* Rows report state, they do not collect it — nothing here
                        is a checkbox, because a box you tick yourself is a
                        promise the app has no way to check, and this row's
                        whole point is that it only says things it can. */}
                    <SettingRow label="An agent is wired in"
                      hint={onboarding.hook ? "Claude Code is hooked into this app." : "Not yet — Claude Code hasn't been wired in."}
                      onClick={() => setPane("hooks")}
                      status={<OnboardingMark done={onboarding.hook} />} />
                    <SettingRow label="A provider is connected"
                      hint={onboarding.provider ? "At least one of GitHub, GitLab, ClickUp or Taskwarrior is connected." : "Not yet — connect GitHub, GitLab, ClickUp or Taskwarrior."}
                      onClick={() => setPane("connections")}
                      status={<OnboardingMark done={onboarding.provider} />} />
                    <SettingRow label="The pane engine is ready"
                      hint={onboarding.paneEngine ? "tmux is on PATH and working." : "Not yet — tmux isn't on PATH."}
                      onClick={() => setPane("tmux")}
                      status={<OnboardingMark done={onboarding.paneEngine} />} />
                  </SettingsCard>
                  )}
                  {ql && show("about") && <PageMatchHeading id="about" onOpen={() => { setPane("about" as Pane); setQ(""); }} />}
                  {show("about") && <><AboutPane open={open} /><LogDigestSection d={logDigest} /></>}
                  </Filter.Provider>
                  </PageState.Provider>
                  </div>
                </div>
              </div>
            </div>
          {escArmed && (
            /* The hint IS the mechanism. One Escape used to throw the page
               away, which is fine for a popover and wrong for somewhere you
               went — so the first press says what the second one does, and
               says it where the eye already is when it wants out. */
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-[12.5px] pointer-events-none"
              style={{ zIndex: 10002, background: "var(--surface-card)", border: EDGE, color: "var(--text2)", boxShadow: "0 10px 30px -12px rgba(0,0,0,0.7)" }}>
              Press Escape again to leave settings
            </div>
          )}
          </motion.div>
        )}
      </AnimatePresence>
    </Portal>
    </PortalFloor.Provider>
  );
}

