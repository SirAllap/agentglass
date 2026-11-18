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
import { NO_DRAG } from "../lib/dragRegion.ts";
import { BoardSkeleton } from "./tasks/BoardState.tsx";
import { useModalDialog } from "../lib/focusTrap.ts";
import { PluginSettingsPane } from "./plugins/PluginSettingsPane.tsx";
import {
  DEFAULT_DENSITY, DEFAULT_UI_FONT, densityPref, setDensityPref, uiFontPref, setUiFontPref, translucentPref, setTranslucentPref,
  reduceMotionChoice, resetReduceMotion,
} from "../lib/lookPrefs.ts";
import { Fragment, createContext, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RecipesPane } from "./RecipesPane.tsx";
import { ReviewPromptsPane } from "./ReviewPromptsPane.tsx";
import { SavedRepliesPane } from "./SavedRepliesPane.tsx";
import { lastTerminalRoot } from "./TerminalPanel.tsx";
import { openTutorial, TUTORIAL_CARDS, seenCards } from "../lib/setupTutorial.ts";
import { runSetupAgain } from "../lib/setupState.ts";
import { autoCheckHint } from "../lib/aboutRules.ts";
import { Filter, Fold, SettingRow, choiceIsWide, Toggle, Switch, type RowDetail } from "./SettingRow.tsx";
import { resetShown } from "../lib/settingsModified.ts";
import { pageScore, absentFor, rowId, type SettingsPage } from "../lib/settingsIndex.ts";
import { motion, AnimatePresence } from "motion/react";
import { Portal, PortalFloor } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { api, serverIsTokenless, type PrivacyFacts } from "../lib/api.ts";
import { terminalRelayNote } from "../lib/terminalRelayNote.ts";
import { savePaneField as paneFieldSave } from "../lib/paneEngineSave.ts";
import { remoteAccessEnabled, browserPlaces, CAN_IMPORT_COOKIES, cookieSources, importCookies, forgetCookies, type CookieSource, type CookieImportReply } from "../lib/desktop.ts";
import { loadProfiles } from "../lib/browserProfiles.ts";
import { addVisible, allSites, bestSource, dropVisible, lockedWhy, reachable, siteView } from "../lib/cookiePick.ts";
import { PROVIDERS, type ProviderSpec, type ProviderStatus, type ProviderState, type TrackerChoice } from "../../../shared/providers.ts";
import { useTrackerSetup } from "../lib/trackerSetup.ts";
import { rememberClickupWrites, rememberTrackerChoices, trackerRows } from "../lib/trackerView.ts";
import { __forgetClickupPrefs } from "../lib/clickupPrefs.ts";
import { __forgetClickupSpaces } from "../lib/clickupSpaces.ts";
import { CardSkillsCard } from "./ClickUpPane.tsx";
import { __forgetClickupSetup, clickupSetup } from "../lib/clickupSetup.ts";
import { forgetCards } from "../lib/prCardStore.ts";
import { checkedLine } from "../lib/providerFreshness.ts";
import { fmtAgo, minutesAgo } from "../lib/format.ts";
import type { ActionRecord, GateRecord, UnderstudyClassRow, UnderstudyFrame } from "../../../shared/types.ts";
import { mergeActivity, gateLine, actorLabel, activityDays, filterActivity, type ActivityFilter, type ActivityRow, type ActivityRun } from "../lib/activity.ts";
import { Ticks } from "./Ticks.tsx";
import { ingestUpdate, isUpdateAvailable } from "../lib/updateStore.ts";
import { ReleaseNotesModal } from "./ReleaseNotesModal.tsx";
import { V1Badge } from "./V1Badge.tsx";
import { installedNotes, type NotesTarget } from "../lib/whatsNew.ts";
import { autostartEnabled, setAutostart, isFullscreen, toggleFullscreen, IS_DESKTOP, IS_MAC_DESKTOP, HAS_BROWSER } from "../lib/desktop.ts";
import { overlayOpen } from "../lib/overlays.ts";
import { Select } from "./Select.tsx";
import { Choice } from "./SettingChoice.tsx";

export { Choice };
import { noteOpen } from "../lib/usageOpens.ts";
import { useResetRoles } from "../lib/useResetRoles.ts";
import { WORKER_VERB_GROUPS } from "../../../shared/browserLimits.ts";
import { BROWSER_ENGINES, BROWSER_ROLES, SEAT_ROW_LABEL, CARD_TABS_ROW_LABEL, groupFlowRoleRows, type BrowserWorkers, type FlowRoleCardRow } from "../../../shared/browserWorkers.ts";
import { ALARM_VOICES, NOTIFY_VOICES, findVoice, playVoice, type Voice } from "../lib/sounds.ts";
import { alarmVoiceId, setAlarmVoice } from "../lib/alarm.ts";
import { SEARCH_ENGINE_LABELS, type SearchEngine } from "../lib/browserUrl.ts";
import { homePageRaw, setHomePage, searchEngine, importHistory, setImportHistory, importBookmarks, setImportBookmarks, pickImportRows } from "../lib/browserPrefs.ts";
import { NOTIFY_KINDS, NOTIFY_CHANNELS, NOTIFY_KIND_LABEL, NOTIFY_CHANNEL_LABEL, type NotifyKind, type NotifyChannel } from "../../../shared/notifyPrefs.ts";
import { getNotifyPrefs, subscribeNotifyPrefs, saveNotifyPrefs } from "../lib/notifyPrefsStore.ts";
import { PluginsPane } from "./PluginsPane.tsx";
import { MemoryReserveCard } from "./MemoryReserveCard.tsx";
import { TerminalIcon, DiffIcon, BrowserIcon, UnderstudyIcon, DashIcon } from "./workspace/icons.tsx";
import {
  SlidersIcon, ThemeIcon, BellIcon, SidebarIcon, KeyboardIcon, BudgetIcon, PulseIcon,
  CommandIcon, ReviewIcon, QuoteIcon, PanesIcon, PlugIcon, ServerIcon, PhoneIcon,
  PuzzleIcon, ShieldIcon, InfoIcon, ChecklistIcon, DownloadIcon, ColumnsIcon, ChipIcon, DiamondIcon, FlowIcon, LayersIcon, ChevronRightIcon } from "./settingsNavIcons.tsx";
import { SETTINGS_TREE_PAGES as NEW_PAGES } from "../../../shared/uiActions.ts";
import { OLD_LABELS, FOLDED_INTO, restorePane, foldMarks, resolvePane, openSettings, closeSettings, paneWhenClickupKnown } from "../lib/openSettings.ts";
import { jumpTarget, pendingJumpReady, keepPendingJump, needsDirectScroll } from "./settings/shell/shellRules.ts";
import { jumpToSection, PIN_ROW_EVENT } from "./settings/shell/PageRail.tsx";
import { SettingsNav } from "./SettingsNav.tsx";
import { AppearancePage } from "./settings/pages/AppearancePage.tsx";
import { TerminalPage } from "./settings/pages/TerminalPage.tsx";
import { FilesPage } from "./settings/pages/FilesPage.tsx";
import { DiffsPage } from "./settings/pages/DiffsPage.tsx";
import { BrowserPage } from "./settings/pages/BrowserPage.tsx";
import { GitPage } from "./settings/pages/GitPage.tsx";
import { RemoteDevicesPage } from "./settings/pages/RemoteDevicesPage.tsx";
import { ClickUpPage } from "./settings/pages/ClickUpPage.tsx";
import { JiraPage } from "./settings/pages/JiraPage.tsx";
import { TasksPage } from "./settings/pages/TasksPage.tsx";
import { NotificationsPage } from "./settings/pages/NotificationsPage.tsx";
import { ShortcutsPage } from "./settings/pages/ShortcutsPage.tsx";
import { AboutSettingsPage } from "./settings/pages/AboutPage.tsx";
import { CommandsSettingsPage } from "./settings/pages/CommandsPage.tsx";
import { PluginsSettingsPage } from "./settings/pages/PluginsPage.tsx";
import { UnderstudySettingsPage } from "./settings/pages/UnderstudyPage.tsx";
import { ActivitySettingsPage } from "./settings/pages/ActivityPage.tsx";
import { DataSettingsPage } from "./settings/pages/DataPage.tsx";
import { WorkersSettingsPage, FlightPlanSettingsPage, TrackerSettingsPage } from "./settings/pages/later.tsx";
import { EnginesUsagePage } from "./settings/pages/EnginesUsagePage.tsx";
import { WatchingPage } from "./settings/pages/WatchingPage.tsx";
import { MACHINE_PAGES, MACHINE_SCOPE } from "./settings/scope/scopeModel.ts";
import { PermissionsPage } from "./settings/pages/PermissionsPage.tsx";
import { AdvancedSettingsPage } from "./settings/pages/advanced.tsx";
import { InspectSettingsPage } from "./settings/pages/inspect.tsx";
import type { PageCtx } from "./settings/pages/ctx.ts";
import { SettingsSearchPanel } from "./SettingsSearchPanel.tsx";
import { SettingsPageHeader } from "./SettingsPageHeader.tsx";
import { SettingsPage as PageShell, type PageSection } from "./settings/shell/SettingsPage.tsx";
import { PageLoad, PageSkeleton, PageSlot, hasReads, prefetchPage, type PageLoadSink } from "./settings/shell/pageLoad.tsx";
const LAYERS = ["a", "b"] as const;
import { backPane, layerRole, otherLayer, pageReady, shouldPrefetch, switchPhase, CAP_MS, HOLD_MS, type Layer, type SwitchPhase } from "../lib/settingsReady.ts";
import { Section } from "./settings/shell/Section.tsx";
import { pluginNavNeed, pluginTallyStore, tallyInstalled, type PluginTally } from "../lib/pluginList.ts";
import { NO_FACTS, NO_MARK, groupByName, groupSearch, headerChips, hueVar, connectionsNeeding, navMarks, withNeeds, withProblems, type HeaderChip, type MatchIn, type NavFacts, type PageNeed, type PageProblem } from "../lib/settingsNav.ts";
import { applyProblem, SAVED_MS } from "../lib/settingsStates.ts";
import { PageState, useReportHead, useReportProblem, useReportSaving, useSavePhase, type PageHead, type PageStateSink } from "./SettingsPageState.tsx";
import { THEMES } from "../lib/highlight.ts";
import { BudgetsPane } from "./BudgetsPane.tsx";
import { OrchestrationPane } from "./orchestration/OrchestrationPane.tsx";
import { GapsPane } from "./orchestration/GapsPane.tsx";
import { PolarisPage } from "./settings/pages/PolarisPage.tsx";
import { PolarisPrsPage } from "./settings/pages/PolarisPrsPage.tsx";
import { FlightPlanLink } from "./flightPlan/FlightPlanLink.tsx";
import { rendererPref, setRendererPref, type RendererPref } from "../lib/termRenderer.ts";
import { TERM_FONTS, CURSORS, fontAvailable, currentTermFont, currentTermSize, currentTermCursor, currentTermLineHeight, setTermFont, setTermSize, setTermCursor, setTermLineHeight, SIZE_MIN, SIZE_MAX, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_SIZE, DEFAULT_LINE_HEIGHT, type CursorStyle } from "../lib/termPrefs.ts";
import { focusFollowsMouse, setFocusFollowsMouse } from "../lib/termFocusPref.ts";
import { parseRules, setTabGroupsOn, tabGroupRulesText, tabGroupsOn } from "../lib/tabGroups.ts";
import { paneActionsMode, setPaneActionsMode, paneMarker, setPaneMarker, type PaneActionsMode, type PaneMarker } from "../lib/paneActionsPref.ts";
import { PaneBarPicker } from "./PaneBarPicker.tsx";
import { diffThemePref, setDiffThemePref, diffSplit, diffWrap, setDiffSplit, setDiffWrap, DEFAULT_SPLIT, DEFAULT_WRAP } from "../lib/diffPrefs.ts";
import {
  TASK_SOURCES, taskSourceShown, shownTaskSources,
  orderedTaskSources, moveTaskSource, resetTaskSourceOrder, type TaskSourceId,
} from "../lib/taskSources.ts";
import { taskLanding, type TaskLanding } from "../lib/taskLanding.ts";
import {
  SCROLLBACK_SIZES, DEFAULT_SCROLLBACK, DEFAULT_WORD_SEPARATORS,
  currentScrollback, currentWordSeparators, copyOnSelect, benchLinks, setBenchLinks, otherLinks, OTHER_LINKS, type OtherLinks, rightClickPaste, currentNoteEditor, NOTE_EDITORS, type NoteEditor,
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
import type { UpdateStatus, ReleaseNotes, HookSetupStatus, BrowserUseStatus, LogDigest, UsageOpens } from "../../../shared/types.ts";
import {
  sysNotifyMode, setSysNotifyMode, setSysNotifyOn, subscribeSysNotifyMode,
  notifyVoiceId, setNotifyVoice,
  notifyCapability, notifyQuiet, subscribeNotifyQuiet,
  appNotify, subscribeAppNotify,
  type SysNotifyMode, type NotifyCapability,
} from "../lib/sysNotify.ts";
import { levelFor, needsYou, type DepReport, type DepStatus } from "../../../shared/deps.ts";
import { installedFact, readyGroup, servicesCoveredByTools } from "../lib/toolsView.ts";
import { pickedAgent } from "../lib/newWindow.ts";
import { clock24, setClock24 } from "../lib/clockPref.ts";
import { setSplashOn, splashOn } from "../lib/splashPref.ts";
import { usageRefreshOn, setUsageRefreshOn } from "../lib/usageRefreshPref.ts";
import { barSwitches, everSeen, type UsageBarProvider } from "../lib/usageBarPref.ts";
import { OpenCodeGoCard } from "./engines/UsageKeyCard.tsx";
import { paceConfig, setPaceConfig, subscribePaceConfig } from "../lib/paceConfig.ts";
import { PACE_MIN_MINUTES, type PaceConfig } from "../../../shared/pace.ts";
import { longWindowUsed, providerUsage, subscribeProviderUsage } from "../lib/usageStore.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { benchState, subscribeBench, setBenchFabMode, type FabMode } from "../lib/benchStore.ts";
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
import { AgentIcon, CheckboxIcon, ClockIcon, CrossIcon, DiskIcon, EditIcon, EyeIcon, IconLabel, LinkIcon, MergeIcon, PlusIcon, RefreshIcon, SparkleIcon, StarIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { ciOnlyApproved } from "../lib/ciNotifyPref.ts";
import { reviewGateOn, setReviewGate } from "../lib/reviewGatePref.ts";
import { AskedAlertLog } from "./AskedAlertLog.tsx";
import { talkNotify, type TalkNotify } from "../lib/talkNotify.ts";
import { RETENTION, setUnderstudyEnabled, useUnderstudy } from "./understudy/UnderstudyPanel.tsx";
import { Teach } from "./understudy/Teach.tsx";
import { emitControl } from "../lib/controlBus.ts";
import { refreshUnderstudy } from "../lib/understudyStore.ts";
import { mutedSources, setMuted, sourceLabel, subscribeMuted } from "../lib/notePolicy.ts";
import { MuteGlyph } from "./TopBarNotes.tsx";
import { Button, RefreshButton, INPUT, INPUT_STYLE, EDGE, LINE, Segmented } from "./workspace/Chrome.tsx";
import { LAUNCH_MODES, LAUNCH_MODE_LABEL, isLaunchMode, parseDenyRules, type LaunchMode } from "../../../shared/launchModes.ts";
import { setLaunchPermissions } from "../lib/launchMode.ts";
import { CheckRow, Disclosure, DownloadButton, SELECT_BOX, EmptyState, Field, LinkButton, ProblemNote, SaveBar, SaveChip, SettingsCard, SettingsForm, StatusBadge, helpIdFor, type StatusTone } from "./SettingsKit.tsx";
import { PreviewCard, WithPreview } from "./settings/PreviewCard.tsx";
import { WindowPreview, SidebarPreview, DiffPreview, LanternPreview, BrowserPreview, LiveTabs, type LiveView } from "./settings/previews/index.ts";
import { railItems } from "./settings/previews/MiniApp.tsx";
import { restoredNote } from "../lib/restoredNote.ts";
import { cardIdIn } from "../../../shared/cardRef.ts";
import { pageChips, setPageFact, usePageFacts } from "../lib/pageFacts.ts";
import { COUNTED_VIEWS, railBadgeOn, railBadgesCustomised, railBadgesKey, resetRailBadges, subscribeRailBadges } from "../lib/railBadges.ts";

/** A heading inside a settings card, for a pane that answers the same question about
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
export function SourceRow({ id, i, n, onChanged, state }: {
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

/** A −/value/+ stepper. A slider would imply the value is continuous and let
 *  you drag the window into a size the cockpit grid can't lay out; the ladder
 *  is short and every rung is one that works, so buttons say more. */
export function Stepper({ label, hint, detail, value, onDec, onInc, canDec, canInc, modified, settingId, agentExempt, agentNever }: {
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
    <SettingRow label={label} hint={hint} detail={detail} modified={modified} settingId={settingId} agentExempt={agentExempt} agentNever={agentNever}
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
export function ScaleControl({ scale, onZoom }: { scale: number; onZoom: (dir: 1 | -1 | 0) => void }) {
  // The zoom API only nudges one rung at a time; walking to a rung is repeated nudges.
  const goTo = (v: number) => {
    const d = SCALES.indexOf(v) - SCALES.indexOf(scale);
    for (let n = 0; n < Math.abs(d); n++) onZoom(d > 0 ? 1 : -1);
  };
  const quick = SCALE_QUICK.includes(scale);
  return (
    <span className="flex items-center gap-2 flex-wrap justify-start">
      <Segmented track label="Display size" value={quick ? String(scale) : undefined}
        options={SCALE_QUICK.map((v) => ({ id: String(v), label: fmtScale(v) }))}
        onChange={(v) => goTo(Number(v))} />
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
export function OnboardingMark({ done }: { done: boolean }) {
  return done
    ? <StatusBadge tone="ok">Done</StatusBadge>
    : <StatusBadge tone="off">Not yet</StatusBadge>;
}

export type Pane = "finder" | "perm" | "permMain" | "permWorkers" | "permBrowser" | "permOut" | "workers" | "fplan" | "tracker" | "devices" | "recipes" | "review-prompts" | "saved-replies" | "appearance" | "prefs" | "terminal" | "diff" | "tasks" | "git" | "privacy" | "notifications" | "browser" | "rail" | "keys" | "lantern" | "log" | "budgets" | "hooks" | "connections" | "engines" | "orchestration" | "gaps" | "polaris" | "polarisPrs" | "clickup" | "jira" | "tmux" | "remote" | "plugins" | "understudy" | "about" | "onboarding" | "advanced" | "inspect"
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
type TabGroup = "General" | "Workspace" | "Agents" | "Library" | "Connections" | "System" | "Advanced" | "Get started" | "";
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
const LINK_ONLY: Pane[] = ["gaps"];
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

const TAB_DEFS: { id: Pane; label: string; group: TabGroup; kw: string; what?: string; status?: boolean; sub?: string; icon: (p: { size?: number }) => React.ReactElement }[] = [
  // "sound" removed: it named the Notifications rows, not anything on this
  // page, and once pageScore reads a page's own rows a stray word in `kw`
  // only wins ties it should lose — "notification sound" now reaches
  // Notifications on the strength of its OWN rows, so Window does not need
  // to keep claiming a word it has nothing behind.
  { id: "prefs", label: "Window & startup", group: "", kw: "display size zoom clock fullscreen start login launch animation splash preferences", what: "How big the window is and what it does when the machine boots.", icon: SlidersIcon },
  { id: "appearance", label: "Appearance", group: "General", kw: "theme accent colour color dark light mode palette density compact roomy translucent transparent blur reduce motion animation", what: "How the window looks. Every change shows on the right as you make it.", icon: ThemeIcon },
  { id: "notifications", label: "Notifications", group: "General", kw: "notifications sound alert desktop notify quiet chime ping alert sounds message mirror this machine approved reminder alarm somebody says collect without interrupting only when pull request something much them agentglass keep what stopped interrupts muted mute unmute lantern silence none all", what: "What may interrupt you, how loudly, and what became of the ones you asked for.", icon: BellIcon },
  // Next to Shortcuts on purpose: which drawer a view sits in is what decides
  // whether it has a number, so the two pages answer one question between them.
  { id: "rail", label: "Sidebar", group: "", kw: "rail sidebar views order icons hide show reorder tabs drawer group arrange", what: "Which views get an icon on the rail, and whether they sit at the top or the bottom of it.", icon: SidebarIcon },
  { id: "keys", label: "Shortcuts", group: "General", kw: "keyboard keys bindings shortcut chord rebind reset to defaults columns some others", what: "Every key and chord, by where it works. Rebind one and the app warns before it takes a key twice.", icon: KeyboardIcon },
  { id: "terminal", label: "Terminal", group: "Workspace", kw: "terminal launch permissions permission mode ask auto accept edits bypass yolo deny disallowed tools font size cursor typography monospace face renderer gpu focus follows mouse hover pane sloppy scrollback copy on select right-click paste line height tab tabs group groups grouping project name rules prefix runs on engine own tmux shell", what: "How terminals draw, what pointing does, and what an agent may do the moment a terminal launches it.", icon: TerminalIcon },
  /* Its own page, not a block inside Tools & services: it is the engine
     every pane runs on, with a binary, a config and a restore of
     its own — three settings deep is not a row in a list of "is it installed".
     Filed beside Terminal, the view that runs on it. */
  { id: "tmux", label: "Terminal engine", group: "", kw: "tmux panes engine pane prefix key binary bundled config override restore reboot layout resume socket status bar warm cli claude", what: "The engine under every terminal tab: which tmux, how it is configured, and what survives a reboot.", icon: PanesIcon },
  { id: "finder", label: "Files", group: "Workspace", kw: "finder files folders browse sort thumbnails text size density custom actions machine panel", what: "How the Finder browses, sorts and looks.", icon: ColumnsIcon },
  { id: "diff", label: "Diffs", group: "Workspace", kw: "diff split side by side inline unified wrap word wrap changes review default view wrap long lines syntax theme colours", what: "The view you land on, and what happens to a long line.", icon: DiffIcon },
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
  { id: "git", label: "Git & PRs", group: "Workspace", kw: "git pull request pr merged merge cleanup clean up leftovers worktree branch docker stash notes tab automatic ask off older days include safety blocks", what: "What happens to the local leftovers of a PR once it is merged.", icon: MergeIcon },
  { id: "tasks", label: "Tasks", group: "Connections", kw: "tasks sources github issues local taskwarrior clickup hide show providers view opens on", what: "Where the Tasks view starts, which trackers feed it, and how a branch finds its card.", icon: ChecklistIcon },
  { id: "perm", label: "Permissions", group: "Agents", kw: "permissions who may do what allow deny trust", what: "Who may do what: the agent, its workers, the browser and anything that leaves this machine.", icon: ShieldIcon },
  { id: "permMain", label: "Main agent", group: "", kw: "permissions main agent permission mode always deny disallowed tools engine flags trust settings without asking orchestrator edit flow delegation guard subagent", what: "What the agent you talk to may do.", icon: ShieldIcon },
  { id: "permWorkers", label: "Workers", group: "", kw: "permissions workers level cautious balanced open commands commit network docker worktree fixed refused sudo sandbox sockets git internals planner write skills mcp", what: "What a worker may run, and what it can never.", icon: ShieldIcon },
  { id: "permBrowser", label: "Browser access", group: "", kw: "permissions browser drive sites origins profiles verbs workers reach", what: "Who may drive the browser, which sites and which verbs.", icon: ShieldIcon },
  { id: "permOut", label: "Changes outside", group: "", kw: "permissions gate ask before leaving machine jira clickup writes changes move comment link assign", what: "What may leave this machine: the Gate, Jira, ClickUp.", icon: ShieldIcon },
  { id: "engines", label: "Engines & usage", group: "Agents", kw: "engine engines provider hermes opencode codex gemini antigravity claude model version minimum signed in sign-in login orchestrator worker role ready test recheck installed update reporting connect events", what: "Every agent CLI on this machine, what it can do inside agentglass, and what is left to wire.", icon: ChipIcon },
  { id: "hooks", label: "Watching", group: "Agents", kw: "agents hooks claude code install setup gate who answers nobody answers browser agent skill drive lantern reminder status what doing needs you ask sessions working on interval orchestrator seat wake floor chair post watching notify look cache warm", what: "Everything agentglass does with the agents on this machine: what watches them, what it asks them, when the orchestrator wakes, and what may leave.", icon: PlugIcon },
  { id: "budgets", label: "Usage & budgets", group: "", kw: "usage pace plan budget spend cost limit money threshold codex usage current quota github api rate limit search remaining", what: "Budgets, plan pace, the Codex usage refresh and the GitHub API budget.", icon: BudgetIcon },
  { id: "orchestration", label: "Flow & review", group: "Agents", kw: "orchestration orchestrator main agent chair policy rule rules worker workers scout builder verifier engine model fallback chain ask when it runs usage weekly 5h plan hours budget ceiling envelope network commit write limits retries minutes per turn project override prompt cache warm wake floor", what: "Edit the flow on the canvas: engines, who reviews, rounds, rules. This page holds only what is the same for every block.", icon: FlowIcon },
  { id: "workers", label: "Workers", group: "Agents", kw: "worker roles", what: "The roles your workers play.", icon: LayersIcon },
  { id: "polaris", label: "Polaris", group: "Agents", kw: "polaris watch watching signals landing automatic doors preset guided autopilot merge dock cards labels approvals limits hours pull request review replies beacon sessions cleanup course guardrails", what: "What Polaris watches, what it may do without asking, and the limits under every stage.", icon: StarIcon },
  { id: "polarisPrs", label: "Polaris pull requests", group: "Agents", kw: "polaris pull requests prs watcher list open needs you cleared to land relaunch beacon", what: "Every open pull request Polaris watches, with why and its next step.", icon: MergeIcon },
  { id: "fplan", label: "Flight plan", group: "Agents", kw: "flight plan flight preflight go no-go pilot manual copilot autopilot builders flying worktree base mockup style guide reviews second look budget daily weekly cost cap held strong model", what: "The plan an agent writes before it builds.", icon: PanesIcon },
  { id: "recipes", label: "Commands & replies", group: "Library", kw: "commands recipes custom script make run shortcut alias task saved own", what: "Commands you keep, with the parts that change asked for when you run them.", icon: CommandIcon },
  /* Filed under the work rather than under the pull-request panel: these are
     prompts an agent is given, and the panel is only where the button happens
     to be. */
  { id: "review-prompts", label: "Review prompts", group: "", kw: "review prompts pr pull request claude menu skill re-review reviewer wording edit", what: "What the review menu offers, and the words it sends.", icon: ReviewIcon },
  { id: "saved-replies", label: "Saved replies & views", group: "", kw: "saved replies canned comment pr pull request review wording snippet template", what: "The sentences you write over and over on other people's pull requests.", icon: QuoteIcon },
  /* Filed with what you keep and reuse, last in Library: a plugin is
     someone else's code holding a scoped credential to this server — install,
     review what it declares, grant it, take it back. It is not an agent and it
     renders nothing of its own; see the note at the top of server/src/plugins.ts. */
  { id: "plugins", label: "Plugins", group: "Library", kw: "plugins install extension manifest scope review approve enable disable remove entrypoint publisher source running pid re-consent reconsent", what: "Add-ons that read what the app knows. Nothing runs until you have read what it declares and switched it on.", icon: PuzzleIcon },

  /* Filed beside Agents rather than under System, and the two readings are
     both defensible: it is a store of what you did, and it is a thing that
     watches agents work. It is here because the question people arrive with is
     "what is that face in the rail", and the face is about the work. */
  { id: "understudy", label: "Understudy", group: "Library", kw: "knowledge clone learn sources teach precedents decisions bank recall exclusions never see private terms consent scorecard watch score", what: "Where the orchestrator learns how you decide — what it may read, and what it must never see.", status: true, icon: UnderstudyIcon },
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
  { id: "connections", label: "Services & tools", group: "", kw: "requirements dependencies deps tmux git docker install integrations providers connect github gitlab clickup taskwarrior token api credentials account rate limit budget quota", what: "The tools and services this app leans on, and whether they are ready.", status: true, icon: ServerIcon },
  /* Only while ClickUp is connected (see `tabs` in the modal): before that there is no
     workspace for a status to mean anything in, and a page for it would be a dead end. */
  { id: "clickup", label: "ClickUp", group: "Connections", kw: "clickup workflow map steps statuses cards tracker hand off qa review menu merge dialog note assigned people sprint swatch spaces subtasks pull request link", what: "How agentglass uses your ClickUp: the steps you add, tied to your own statuses.", icon: LayersIcon },
  /* Always there, unlike ClickUp's: the form that connects Jira lives on this page. */
  { id: "jira", label: "Jira", group: "Connections", kw: "jira atlassian cloud data center site token email personal access token writes changes projects keys prefixes hand off qa assignee status saved views folders board filter tracker connect disconnect", what: "Your Jira site, what agentglass may change there, and the steps a pull request can run on a card.", icon: DiamondIcon },
  { id: "tracker", label: "Card tracker", group: "", kw: "card tracker look it up in card id rule branch jira clickup", what: "Where a card id is looked up.", icon: ChecklistIcon },
  { id: "remote", label: "Remote & devices", group: "Connections", kw: "remote access pair phone tailscale token device", what: "Reach this machine from your phone.", icon: PhoneIcon },
  { id: "devices", label: "Paired devices", group: "", kw: "paired devices phones pair token tailscale remote", what: "Phones and other devices paired with this machine.", icon: PhoneIcon },
  { id: "privacy", label: "Data & privacy", group: "System", kw: "export download data json csv daily totals markdown events skills catalog take out privacy telemetry data local storage retention database credentials tokens tracking analytics who sees", what: "Where your data is, what leaves this machine, and how to take it out.", icon: ShieldIcon },
  { id: "log", label: "Activity", group: "System", kw: "activity log history events feed", what: "What the app itself has been doing.", status: true, icon: PulseIcon },
  { id: "about", label: "About", group: "System", kw: "about version update release notes changelog credit attribution licence license", what: "Version, release notes, updates and the third-party licences this build carries.", icon: InfoIcon },
  /* Three things, not the eight a checklist usually lists, because three is
     what the app can actually tell without asking you to swear to it: an
     agent wired in, a provider connected, and the pane engine on PATH are
     each one read away (a settings file, a token, a binary). Whether you
     have opened a project, run an agent, or read the docs are not — those are
     either true the moment the app can run at all, or true only if you say
     so, and a step nobody can fail is not a step. Eight-minus-three lies
     would have been worse than three honest ones. */
  { id: "onboarding", label: "Get started", group: "", kw: "get started setup onboarding checklist new agent provider pane engine wired connected ready", what: "Three things this app can tell are done — nothing here to check off yourself.", icon: ChecklistIcon },
  /* The foot of the nav: machine settings and read-outs. Pages are built in plan step 4; until then each says so. */
  { id: "advanced", label: "Advanced", group: "Advanced", kw: "advanced machine settings debug env ops knob kill switch limits when you would touch this", what: "Machine settings, each with when you would touch it.", icon: SlidersIcon },
  { id: "inspect", label: "Inspect", group: "Advanced", kw: "inspect read-only read out state values facts copy", what: "What the app reports about itself. Nothing here is editable.", icon: InfoIcon },
  { id: "gaps", label: "Gaps and additions", group: "", kw: "gaps additions missing redesign parity reference what changed before after decisions added worker editor conditions presets team rail", what: "What the orchestration redesign adds, where each piece lives, and the decisions behind it.", icon: ChecklistIcon },
];

/** The nav tree: the new pages in their order, then the folded old pages (group "", never drawn in the nav, still
 *  searchable). A page's `kw` also carries the labels the old pages had, so the search box finds them where they went. */
const TABS = TAB_DEFS.map((t) => ({ ...t, kw: `${t.kw} ${OLD_LABELS[t.id] ?? ""}`.trim() }))
  .sort((a, b) => { const r = (id: string) => { const i = (NEW_PAGES as readonly string[]).indexOf(id); return i < 0 ? 999 : i; }; return r(a.id) - r(b.id); });

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
/** The Browser view is outside Settings, so the card that describes it offers the way there. */
export function showBrowserView() {
  emitControl({ cmd: "view", to: "browser" });
  emitControl({ cmd: "esc" });
  closeSettings();
}

const AGENT_BROWSER_LINES = [
  "Using agentglass-browser, open my dashboard and tell me what is on it.",
  "With agentglass-browser, go to the staging app, log in with my session, and check the checkout flow.",
  "Take a screenshot of the open PR page with agentglass-browser and tell me what is failing.",
];

const PLACE_LABEL: Record<RailPlace, string> = { work: "Top of the rail", utility: "Bottom of the rail", hidden: "Not on the rail" };
/** The counts the preview wears while a view's count badge is on: invented, one to a view. */
const DEMO_COUNT: Record<string, number> = { lantern: 1, tasks: 3 };

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
export function RailPane() {
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
                  <span className="shrink-0 select-none" style={{ color: "var(--text4)" }} aria-hidden data-tip="Drag to reorder">⠿</span>
                  <span className="shrink-0 grid place-items-center w-5" style={{ color: "var(--text2)" }}><Icon size={ICON.md} /></span>
                  <span className="min-w-0">{x.label}</span>
                </span>}
                control={<span className="flex items-center gap-2.5 justify-self-end">
                  <span className="agx-keycaps" data-tip={`${x.label} answers to ${k} on the dashboard`}><kbd>{k === " " ? "space" : k}</kbd></span>
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

/** The chip alone gave no sign that it records: an explicit verb beside it. The
 *  chip stays a target too. A row with two chips (a view with its chord) has
 *  no room for a third control, so it keeps labelled chips only. */
/** A key or chord as keycaps: `Ctrl+Alt+T` draws as Ctrl + Alt + T, one cap each. The whole group is the
 *  button that starts recording, so a click anywhere on it does what Rebind does. */
export function KeyCaps({ text, active, custom, faint, onClick, title }: {
  text: string; active?: boolean; custom?: boolean; faint?: boolean; onClick: () => void; title?: string;
}) {
  // A held combination reads as caps joined by "+"; a lone key (or the arrows) is one cap.
  const parts = active || text === "—" || text.length < 2 || !/\w\+./.test(text) ? [text] : text.split("+");
  return (
    <button type="button" onClick={onClick} data-tip={title} aria-label={active ? text : `Recorded: ${text}. Click to record another`}
      className="agx-keycaps" data-active={active ? "" : undefined} data-custom={custom ? "" : undefined} data-faint={faint ? "" : undefined}>
      {parts.map((k, i) => (
        <Fragment key={i}>{i > 0 && <span className="agx-keycaps-plus" aria-hidden>+</span>}<kbd>{k}</kbd></Fragment>
      ))}
    </button>
  );
}

export function RebindButton({ capturing, onClick, what }: { capturing: boolean; onClick: () => void; what: string }) {
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
export function ActivityPane({ open }: { open: boolean }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [older, setOlder] = useState(false);
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
      {activityDays(filterActivity(rows, filter)).filter((_, i) => older || i < 2).map(({ day, runs }) => (
        <SettingsCard key={day} title={day}>
          {runs.map((run) => (
            run.kind === "gate"
              ? <GateLine key={run.key} g={run.row} />
              : <ActionLine key={run.key} a={run.row} times={run.times} />
          ))}
        </SettingsCard>
      ))}
      {!older && activityDays(filterActivity(rows, filter)).length > 2 && (
        <SettingsCard title="Older entries">
          <SettingRow agentExempt label="Earlier days" hint="Kept indefinitely; shown on request." actions={<Button onClick={() => setOlder(true)}>Show</Button>} />
        </SettingsCard>
      )}
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
      data-tip={new Date(at).toLocaleString()}>
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
        {times > 1 && <span className="t-dim tabular-nums" data-tip={`${times} of these in a row, newest first`}> ×{times}</span>}
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
  "/git/stash-partial": "stashed files", "/git/stash-apply-overwrite": "applied stash over", "/git/stash-put-back": "put the tree back",
  "/git/bisect-start": "started a bisect", "/git/bisect-mark": "marked a bisect step", "/git/bisect-reset": "reset the bisect",
  "/git/tag-create": "created tag", "/git/tag-delete": "deleted tag", "/git/tag-push": "pushed tag", "/git/tag-delete-remote": "deleted remote tag",
  "/git/apply-hunk": "staged a hunk", "/git/undo-merge": "undid the merge",
  "/git/worktree-add": "added worktree", "/git/worktree-remove": "removed worktree",
  "/docker/start": "started container", "/docker/stop": "stopped container",
  "/docker/restart": "restarted container", "/docker/rm": "removed container",
  "/prs/merge": "merged pull request", "/prs/close": "closed pull request",
  "/prs/unstick-close": "closed (unstick) pull request", "/prs/unstick-reopen": "reopened (unstick) pull request",
  "/prs/review": "reviewed", "/prs/comment": "commented on",
  "/prs/rerun": "re-ran the checks on", "/prs/approve-runs": "approved the workflows on", "/prs/draft": "changed draft state of",
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
 * Small on purpose: the one switch, the score card and the facts about storage.
 */
/** The score, by kind of decision: how often the clone would have answered as the person did. Only decisions the
 *  person typed or clicked are scored (see UnderstudyClassRow.n), and a kind with none is said once, not drawn. */
export function ScoreCard({ frame }: { frame: UnderstudyFrame | null }) {
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
    </>
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

export function LogDigestSection({ d }: { d: LogDigest | "failed" | null }) {
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

/** How often each door of the app was opened on this machine (lib/usageOpens.ts): a table, local only. */
export function OpensSection({ open }: { open: boolean }) {
  const [d, setD] = useState<UsageOpens | "failed" | null>(null);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.usageOpens().then((r) => { if (live) setD(r); }).catch(() => { if (live) setD("failed"); });
    return () => { live = false; };
  }, [open]);
  const note = (text: string) => <SettingRow label={text} />;
  const rows = d && d !== "failed" ? d.opens.slice(0, 40) : [];
  return (
    <SettingsCard title="What you open" icon={<ChecklistIcon />}
      desc="How often each view, Settings page and modal was opened on this machine, to see what is never used. It is counted here and never leaves it."
      fold={{ open: folded, onToggle: setFolded }}>
      {d === "failed" ? note("Could not read the count.")
        : !d ? note("Reading…")
        : !rows.length ? note("Nothing counted yet.")
        : (
          <>
            {note(`Counting since ${d.since}.`)}
            {rows.map((o) => <SettingRow key={o.id} label={o.id} hint={`last opened ${o.last}`} status={<StatusBadge tone="off">{o.count}×</StatusBadge>} />)}
          </>
        )}
    </SettingsCard>
  );
}

export function AboutPane({ open, onDocs }: { open: boolean; onDocs?: () => void }) {
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
            data-tip={dirty
              ? `built from an uncommitted tree — ${st.info.dirtyCount} packaged file(s) differ from ${st.info.commit.slice(0, 7)}`
              : st.info.commit}
            style={dirty ? { color: "var(--warning-ink)", fontWeight: 600 } : undefined}>
            commit {short}
          </span>
          {st.info.builtAt && <> · built {new Date(st.info.builtAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })}</>}
        </>}
        control={
          <span className="flex items-center gap-2">
            <span className="t-mono text-[13px] font-semibold">{st.info.version}</span>
            <V1Badge version={st.info.version} />
          </span>
        }
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

      <SettingRow agentExempt label="Updates"
        hint={checkedAt ? `Checked ${minutesAgo(checkedAt)}. Changed in the row below.` : "Checked when this page opened."}
        actions={<Button pending={checking} onClick={() => void recheck()}>Check for updates</Button>} />
      <Toggle settingId="about.autoCheck" on={auto}
        onClick={() => { setting("about.autoCheck").set(!auto); setAuto(!auto); }}
        label="Look for a newer release by itself"
        hint={autoCheckHint(auto)}
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
    {onDocs && (
      <SettingsCard title="Documents" icon={<InfoIcon />} desc="Longer reading about how the app is put together.">
        <SettingRow agentExempt label="Gaps and additions" hint="What the orchestration redesign adds, and the decisions behind it." onClick={onDocs} />
      </SettingsCard>
    )}
    </>
  );
}

/** The packages this build is made of, with the licence each declares. */
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
/** Where a .dmg install keeps the CLIs: electron-builder copies `bin/` into the
 *  bundle's Resources (electron/package.json "build.extraResources"), and
 *  /Applications is where a dragged .dmg lands. */
const MAC_BUNDLE_BIN = "/Applications/agentglass.app/Contents/Resources/bin";

export function AgentBrowserPane({ open, bare }: { open: boolean; bare?: boolean }) {
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

  if (!st) return bare
    ? <BoardSkeleton label="Reading browser access…" widths={[70, 50]} dots={false} />
    : <SettingsCard title="Browser access" icon={<BrowserIcon size={ICON.sm} />}><BoardSkeleton label="Reading browser access…" widths={[70, 50]} dots={false} /></SettingsCard>;

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

  /* Three independent things, so a checklist rather than a paragraph: the
     count says how far off you are before you have read a word, and each
     line carries the button that fixes that line. The argument for the
     feature is read once, by somebody deciding whether to bother, so it
     comes after the verdict. */
  const steps: SetupStep[] = [
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
  ];
  const known = steps.filter((x) => x.done !== null);
  const done = known.filter((x) => x.done).length;
  const rows = (
    <>
      {steps.map((x) => (
        <SettingRow key={x.title} label={x.title} hint={x.detail}
          status={x.done === true
            ? <StatusBadge tone="ok">{x.says?.done ?? "Done"}</StatusBadge>
            : x.done === false
              ? <StatusBadge tone={x.says?.todoTone ?? "warn"}>{x.says?.todo ?? "To do"}</StatusBadge>
              : <StatusBadge tone="off">Your step</StatusBadge>}
          actions={x.action
            ? <Button pending={x.action.busy} onClick={x.action.onClick}>{x.action.label}</Button>
            : undefined} />
      ))}
      {(err || note) && (
        <div role={err ? "alert" : "status"} className="agx-settings-x px-4 py-2 text-[12px]"
          style={{ color: err ? "var(--error-ink)" : "var(--text2)" }}>{err || note}</div>
      )}
      <SettingRow label="Why a window and not curl"
        hint="An agent fetching a URL from its shell gets the signed-out version of everything that matters, because the session lives in a browser. This one has your sessions in it. Three things have to be true for an agent to use it, and they break independently." />
      <SettingRow label="Three lines to paste into an agent"
        hint="Something to say to an agent once it can drive the browser."
        detail={{
          summary: "Three lines to paste into an agent",
          body: <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
            {AGENT_BROWSER_LINES.map((p) => (
              <li key={p} className="text-[12px] px-2 py-1 rounded" style={{ color: "var(--text2)", background: "var(--surface-inset)" }}>{p}</li>
            ))}
          </ul>,
        }} />
    </>
  );
  if (bare) return rows;
  return (
    <SettingsCard title="Browser access" icon={<BrowserIcon size={ICON.sm} />}
      desc="One wire from this app to a browser an agent can drive."
      status={<StatusBadge tone={done === known.length ? "ok" : "off"}>{done} of {known.length} done</StatusBadge>}
      actions={<Button onClick={load} disabled={busy}>Check again</Button>}>
      {rows}
    </SettingsCard>
  );
}

/** The Agents page: the hooks and the gate beside it, the cards the modal hands
 *  in (browser, card skills), a pointer to the worker roles in Orchestration,
 *  and one danger zone that holds both ways back — which is why the hooks state
 *  lives here and not in the card, and why the cards come in as slots: the flow
 *  fills columns in order, so the danger zone has to be drawn after every card
 *  it follows. */
export function AgentsPage({ open, browser, skills }: {
  open: boolean; browser: React.ReactNode; skills: React.ReactNode;
}) {
  const { armed, note: resetNote, press: resetRoles } = useResetRoles();
  const [st, setSt] = useState<HookSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useReportSaving("hooks", busy);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /* The Lantern's own state, read with the hooks: one page means one open. */
  const [ask, setAsk] = useState(true);
  const [askMinutes, setAskMinutes] = useState(20);
  const [watch, setWatch] = useState(true);
  const [watchMinutes, setWatchMinutes] = useState(15);
  const [cacheTtl, setCacheTtl] = useState(5);
  const [watchErr, setWatchErr] = useState<string | null>(null);
  const [watchNote, setWatchNote] = useState<string | null>(null);
  /* Unknown until the read lands (and unknown again if it fails): the chip and
     the card say so rather than reporting a default as the stored value. */
  const [watchRead, setWatchRead] = useState<"reading" | "ok" | "failed">("reading");
  const [watchTry, setWatchTry] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setWatchRead("reading");
    api.hooksStatus()
      .then((r) => { if (live) setSt(r); })
      .catch(() => { if (live) setSt(null); });
    api.lanternSettings()
      .then((r) => {
        if (!live) return;
        if (typeof r.nudge === "boolean") setAsk(r.nudge);
        if (typeof r.minutes === "number") setAskMinutes(r.minutes);
        if (typeof r.watch === "boolean") setWatch(r.watch);
        if (typeof r.watchMinutes === "number") setWatchMinutes(r.watchMinutes);
        if (typeof r.cacheTtlMinutes === "number") setCacheTtl(r.cacheTtlMinutes);
        setWatchErr(null);
        setWatchRead("ok");
      })
      .catch(() => {
        if (!live) return;
        setWatchErr("Could not reach the server — the watching settings are unavailable.");
        setWatchRead("failed");
      });
    return () => { live = false; };
  }, [open, watchTry]);

  /* The gate is its own switch. The forwarder streams what happened; the gate
     waits on an outward action until somebody answers, and an outward one — a
     push, a pull request, a comment, a review, a merge, a ticket, a message in
     a channel — waits with it. Two different bargains, so two different
     switches: nobody should acquire a thing that can stop their agents by
     asking for telemetry. */
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

  const saveWatch = (f: { nudge?: boolean; minutes?: number; watch?: boolean; watchMinutes?: number; cacheTtlMinutes?: number }) => {
    setWatchNote(null);
    api.lanternSettingsSave(f)
      .then((r) => {
        if (!r.ok) { setWatchNote(r.error ?? "Could not save."); return; }
        if (typeof r.nudge === "boolean") setAsk(r.nudge);
        if (typeof r.minutes === "number") setAskMinutes(r.minutes);
        if (typeof r.watch === "boolean") setWatch(r.watch);
        if (typeof r.watchMinutes === "number") setWatchMinutes(r.watchMinutes);
        if (typeof r.cacheTtlMinutes === "number") setCacheTtl(r.cacheTtlMinutes);
        setWatchRead("ok");
        setWatchNote(f.watch !== undefined || f.watchMinutes !== undefined
          ? "Saved. The next look is one interval from now."
          : "Saved. Applies to the next prompt in every hooked session.");
      })
      .catch(() => setWatchNote("Could not save."));
  };

  /* The chips say the three things this page answers, before any card is read:
     whether the hooks report, whether the gate is on, and whether the board
     watches. The nav mark still carries the one that needs a person. */
  useReportHead("hooks", st ? {
    chips: [
      { tone: st.installed ? "ok" : "off", text: st.installed ? "Hooks wired" : "Hooks not wired" },
      ...(st.gateBundled ? [{ tone: st.gate ? "ok" as const : "warn" as const, text: st.gate ? "Gate on" : "Gate off" }] : []),
      watchRead === "reading"
        ? { tone: "off" as const, text: "Reading the watch" }
        : watchRead === "failed"
          ? { tone: "warn" as const, text: "Watch unknown" }
          : { tone: watch ? "ok" as const : "off" as const, text: watch ? "Watching" : "Not watching" },
    ],
  } : null);

  const hooksIcon = <PlugIcon size={ICON.sm} />;
  /* The pieces that do not depend on the hooks being readable: the cards of the
     page are the same whatever the hooks say, so a failed read does not blank
     the page, only the part that read it. */

  const SHOW_AGENTS = "The Agents view opens here, on the Lantern board.";
  const showAgents = () => {
    emitControl({ cmd: "view", to: "agents" });
    emitControl({ cmd: "esc" });
    closeSettings();
  };

  const ASK_STEPS = [10, 20, 45, 90] as const;
  const nearAsk = String(ASK_STEPS.find((m) => m >= askMinutes) ?? 90);
  const WATCH_STEPS = [5, 10, 15, 30, 60] as const;
  const nearWatch = String(WATCH_STEPS.find((m) => m >= watchMinutes) ?? 60);

  const hooksPanel = !st ? (
    <BoardSkeleton label="Reading hook state…" widths={[70, 50]} dots={false} />
  ) : !st.bundled ? (
    <SettingRow label="The hook scripts are not in this build"
      hint={<>This build does not carry the hook scripts, so there is nothing to wire. Install from a Release, or run <span className="t-mono">bun run setup</span> in a checkout.</>}
      status={<StatusBadge tone="warn">Not included</StatusBadge>} />
  ) : (
    <>
      <SettingRow label="Hook scripts in this build" hint="Shipped with the app — nothing to fetch."
        status={<StatusBadge tone={st.bundled ? "ok" : "warn"}>{st.bundled ? "Included" : "Not included"}</StatusBadge>} />
      <SettingRow label="Wired into Claude Code"
        hint={<span className="t-mono text-[11px]">{tilde(st.settingsPath)}</span>}
        detail={{
          summary: "What the hooks see, and never do",
          body: <>Every Claude Code session streams here live — what ran, what it cost, when it stopped for you. It watches; it never stops a tool call, and its command ends in <span className="t-mono text-[11px]">|| exit 0</span> so that stays true even if the script goes missing. Stopping an outward action is the gate below, a separate switch. It edits <span className="t-mono text-[11px]" style={{ color: "var(--text)" }}>{st.settingsPath}</span>, backing it up first, and leaves your other hooks untouched.</>,
        }}
        status={<StatusBadge tone={st.installed ? "ok" : "warn"}>{st.installed ? "Wired" : "Not wired"}</StatusBadge>}
        actions={st.installed ? undefined : <Button pending={busy} onClick={() => void act("install")}>{busy ? "Enabling…" : "Enable"}</Button>} />
      <SettingRow label="Start a fresh session" hint="Sessions already running keep the hooks they started with."
        status={<StatusBadge tone="off">Your step</StatusBadge>} />
      <SettingRow label="Python on your PATH"
        hint={<>Hooks run under <span className="t-mono">{st.python}</span>; they load at startup.</>}
        detail={{ summary: "Details", body: <>The forwarder is a python script, so <span className="t-mono">{st.python}</span> has to be on your PATH for events to arrive. A change takes effect on the next Claude Code session.</> }}
        status={st.pythonVersion === undefined ? undefined
          : st.pythonVersion ? <StatusBadge tone="ok">python {st.pythonVersion}</StatusBadge> : <StatusBadge tone="warn">Not found</StatusBadge>} />
      {(err || note) && (
        <div role={err ? "alert" : "status"} className="agx-settings-x px-4 py-2 text-[12px]" style={{ color: err ? "var(--error-ink)" : "var(--text2)" }}>
          {err || note}
        </div>
      )}
    </>
  );

  /* Nothing here is reported before the read lands, and a failed read is said
     rather than covered by the defaults: writing then would derive a value the
     server never stored. */
  const watchKnown = watchRead === "ok";
  const watchStatus = watchRead === "reading" ? "…"
    : watchRead === "failed" ? "Not read"
      : watch ? `On · ${watchMinutes} min` : "Off";
  const watchHint = watchKnown
    ? "One notification per look at most, and only while something needs you."
    : watchRead === "reading" ? "Reading the saved value." : "The saved value could not be read — try again above.";

  return (
    <div className="agx-agents-page">
      <div className="agx-split-page agx-agents-hero">
        <SettingsCard title="Watching" icon={<EyeIcon size={ICON.sm} />}
          desc="The board that watches every session. It looks on a schedule, and tells you only while something needs you."
          status={<StatusBadge tone={watchKnown && watch ? "ok" : "off"}>{watchStatus}</StatusBadge>}>
          {watchErr && (
            <div role="alert" className="agx-settings-x flex items-center gap-2 px-4 py-2 text-[11px]" style={{ color: "var(--error-ink)" }}>
              <span className="flex-1">{watchErr}</span>
              <Button onClick={() => setWatchTry((n) => n + 1)}>Try again</Button>
            </div>
          )}
          <Toggle on={watch} settingId="lantern.watch" onClick={() => saveWatch({ watch: !watch })} disabled={!watchKnown}
            label="Watch the agents and notify me"
            hint={watchHint}
            detail={{ summary: "Details", body: <>A look re-reads every session’s state. A notification goes out only if somebody is stopped on a permission or a question, a window vanished, or claimed work has gone quiet for an hour. The instant alerts stay either way; this is the sweep behind them. It never starts, stops or queues anything.</> }} />
          <Choice settingId="lantern.watchMinutes" label="How often it looks" value={nearWatch}
            hint="How long between two looks at the board."
            options={WATCH_STEPS.map((m) => ({ v: String(m), label: `${m} min` }))}
            onPick={(m) => saveWatch({ watchMinutes: Number(m) })} disabled={!watch || !watchKnown}
            disabledHint={watchKnown ? "Nothing is looked at while the watch is off." : "The saved value could not be read."} />
          <Choice settingId="lantern.cacheTtlMinutes" label="How long the prompt cache stays warm" value={String(cacheTtl === 60 ? 60 : 5)}
            hint="A turn sent while it is warm is the cheap one."
            detail={{ summary: "Details", body: <>Each card counts it down from the session’s last turn. Five minutes on most plans; an hour on some.</> }}
            options={[{ v: "5", label: "5 min" }, { v: "60", label: "1 hour" }]}
            onPick={(m) => saveWatch({ cacheTtlMinutes: Number(m) })} disabled={!watchKnown} />
          <SettingRow agentExempt label="Where a notification goes"
            hint="The bell, the desktop when the app is closed, and your phone when it is paired."
            actions={<Button onClick={() => openSettings("notifications")}>Open Notifications</Button>} />
          <div className="agx-agents-foot">
            <ClockIcon size={ICON.sm} />
            <span>A look re-reads every session; <b>instant alerts stay either way</b>.</span>
          </div>
        </SettingsCard>
        <aside className="agx-split-side">
          <PreviewCard id="lantern" title="The Lantern card" actions={<StatusBadge tone="info">Live preview</StatusBadge>}>
            <LanternPreview watch={watch} everyMin={watchMinutes} wakeMin={cacheTtl} />
            <div className="agx-preview-out">
              <span>Opens the Agents view, outside Settings.</span>
              <Button onClick={showAgents} title={SHOW_AGENTS}>Show it</Button>
            </div>
          </PreviewCard>
        </aside>
      </div>

      <div className="agx-agents-pair">
        <SettingsCard title="Session check-ins" icon={<SparkleIcon size={ICON.sm} />}
          desc="What a session is doing, in its own words, so the board names the job and not just the window."
          status={<StatusBadge tone={ask ? "ok" : "off"}>{ask ? "Asking" : "Off"}</StatusBadge>}>
          <Toggle on={ask} settingId="lantern.nudge" onClick={() => saveWatch({ nudge: !ask })}
            label="Ask sessions what they are working on"
            hint="On a prompt, a session may be asked to post its task in one line."
            detail={{ summary: "Details", body: <>A hooked session may be handed one line asking it to post its task (<span className="t-mono">POST /agents/status</span>). Off, and the board lists sessions by name and pane only.</> }} />
          <Choice settingId="lantern.nudgeMinutes" label="How often one session may be asked again" value={nearAsk}
            hint="A session that answered is left alone for this long."
            options={ASK_STEPS.map((m) => ({ v: String(m), label: `${m} min` }))}
            onPick={(m) => saveWatch({ minutes: Number(m) })} disabled={!ask}
            disabledHint="Nothing is asked while the reminder is off." />
        </SettingsCard>
      </div>

      <SettingsCard title="Hooks" icon={hooksIcon} wide
        desc="The two wires between this app and an agent: one reports what a session does, one lets it drive a browser.">
        <div className="agx-connect-grid" data-panels={browser ? undefined : "1"}>
          <div className="agx-connect-panel">
            <div className="agx-connect-head"><span className="agx-connect-ic" aria-hidden>{hooksIcon}</span><b>Claude Code hooks</b></div>
            {hooksPanel}
          </div>
          {browser ? (
            <div className="agx-connect-panel">
              <div className="agx-connect-head"><span className="agx-connect-ic" aria-hidden><BrowserIcon size={ICON.sm} /></span><b>Browser access</b></div>
              {browser}
            </div>
          ) : null}
        </div>
      </SettingsCard>

      <SettingsCard title="Gate" icon={<ShieldIcon size={ICON.sm} />} desc="What may leave this machine, and what happens if nobody answers.">
        <SettingRow agentExempt label="Ask me before anything leaves this machine" hint="Permissions › Changes outside" onClick={() => openSettings("permOut")} />
      </SettingsCard>

      {skills}

      {watchNote && <p role="status" className="agx-settings-x m-0 text-[11px]" style={{ color: "var(--text3)" }}>{watchNote}</p>}

      <SettingsCard title="Danger zone" tone="danger" icon={<WarningIcon size={ICON.sm} />}
        desc="Two ways back. Both are reversible.">
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
    </div>
  );
}

function SwitchButton({ on, onClick, disabled, busy, label }: { on: boolean; onClick: () => void; disabled?: boolean; busy?: boolean; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled}
      className="shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
      <Switch on={on} busy={busy} />
    </button>
  );
}

/** Voice picker plus Play, as a row's control rather than a row of its own. */
export function VoicePicker({ voices, value, onPick, label }: {
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

/** Which pull requests count as ready, and when to be told: the rows that sat on Notifications, now on the Git page. */
export function MergeReadinessCard(p: {
  ciApproved: boolean; onCiApproved: () => void;
  reviewGate: boolean; onReviewGate: () => void;
  talkMode: TalkNotify; onTalkMode: (v: TalkNotify) => void;
}) {
  return (
    <>
    <SettingsCard title="Merge readiness" icon={<ReviewIcon size={ICON.sm} />}>
      <Toggle on={p.reviewGate} onClick={p.onReviewGate}
        agentNever="decides whether a reviewer's findings hold a pull request out of the green lane: an agent that could switch it off could clear its own findings from the board"
        label="Review findings block merge-ready pull requests"
        hint={p.reviewGate ? "Blocks merge-ready pull requests." : "The board files pull requests by GitHub's facts only."}
        detail={{ summary: "What blocking does", body: p.reviewGate
          ? <>A pull request with open critical or high findings from a local review of its CURRENT head moves from “Green, ready to land” to Blocked, with the reason on the card. Resolve or dismiss them, or push and review again, and it moves back. A review of an older head never blocks.</>
          : <>Off: the board files pull requests by GitHub's own facts only. A card with open critical or high findings still shows “Not ready” as a chip and stays where it is.</> }} />
    </SettingsCard>
    <SettingsCard title="Watching" icon={<ReviewIcon size={ICON.sm} />} desc="The PR watch menu keeps per-PR switches and links here.">
      <Toggle on={p.ciApproved} onClick={p.onCiApproved}
        settingId="notifications.ciOnlyApproved" label="Checks fail"
        hint={p.ciApproved ? "Only once the pull request is approved." : "Every verdict, on every pull request of yours."}
        detail={{ summary: "Why approved only", body: <>A suite finishing on something half-written is a status line; on something approved it is the last thing before merging. Off: every verdict, including on pull requests nobody has looked at yet.</> }} />
      <Choice<TalkNotify>
        settingId="notifications.talk" label="Conversation"
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
    </>
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
export function NotificationsSection(p: {
  sound: boolean; onSound: () => void;
  quiet: boolean; mutedList: string[]; own: boolean;
  notifyVoice: string; onNotifyVoice: (v: string) => void;
  alarmVoice: string; onAlarmVoice: (v: string) => void;
  sysNotify: SysNotifyMode; notifyCap: NotifyCapability | null;
}) {
  const { quiet, mutedList, own } = p;
  useEffect(() => { setPageFact("news", quiet ? "off" : "on"); }, [quiet]);
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
      <SettingsCard title="How it reaches you" icon={<BellIcon size={ICON.sm} />}
        status={err ? <StatusBadge tone="err">{err}</StatusBadge> : <StatusBadge tone={prefs.none ? "off" : quiet ? "info" : "ok"}>{prefs.none ? "Silenced" : quiet ? "Quiet" : own ? "Loud" : "Normal"}</StatusBadge>}
        actions={<span className="flex items-center gap-2 text-[11px] t-dim">Silence all
          <SwitchButton on={prefs.none} label="Silence all"
            onClick={() => save({ ...prefs, none: !prefs.none })} /></span>}>
        {NOTIFY_CHANNELS.filter((c) => c !== "sound").map((c) => (
          <Toggle key={c} on={prefs.channels[c]} disabled={prefs.none}
            onClick={() => setChannel(c, !prefs.channels[c])}
            agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
            label={NOTIFY_CHANNEL_LABEL[c].label} hint={NOTIFY_CHANNEL_LABEL[c].desc} />
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
                    data-tip={`Unmute ${sourceLabel(src)}`} aria-label={`Unmute ${sourceLabel(src)}`}>
                    <MuteGlyph />{sourceLabel(src)}
                  </button>
                ))}
              </span>
            } />
        )}
      </SettingsCard>

      <SettingsCard title="Sound and voice" icon={<BellIcon size={ICON.sm} />}>
        {/* Three words for two switches: Quiet is the quiet switch; with it off, agentglass's own
            notices interrupt (Loud) or keep landing in the bell (Normal). */}
        <Choice<"off" | "quiet" | "normal" | "loud">
          settingId="notifications.volume" wide label="Volume"
          hint="Quiet lets through only what is stopped. Off is Silence all."
          detail={{ summary: "What each level lets through", body: <>
            Off: nothing pops or rings; the same switch as Silence all.
            Quiet: an approval, an agent blocked on a question, a red check on a pull request about to merge still pop and ring;
            everything else collects in the bell without a sound. Normal: the same, and agentglass's own notices (branches falling
            behind, checks going red) still only land in the bell. Loud: those interrupt too.
          </> }}
          value={prefs.none ? "off" : quiet ? "quiet" : own ? "loud" : "normal"} modified={prefs.none || !quiet}
          onPick={(v) => { if (v === "quiet") { setting("notifications.quiet").set(true); if (prefs.none) setting("notifications.volume").set("quiet"); } else setting("notifications.volume").set(v); }}
          options={[{ v: "off", label: "Off" }, { v: "quiet", label: "Quiet" }, { v: "normal", label: "Normal" }, { v: "loud", label: "Loud" }]} />
        <Toggle on={prefs.channels.sound} disabled={prefs.none}
          onClick={() => setChannel("sound", !prefs.channels.sound)}
          agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
          label={NOTIFY_CHANNEL_LABEL.sound.label} hint={NOTIFY_CHANNEL_LABEL.sound.desc} />
        <SettingRow agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
          label="Notification sound" hint="Which sound notifications make."
          control={<VoicePicker label="Notifications" voices={NOTIFY_VOICES} value={p.notifyVoice} onPick={p.onNotifyVoice} />} />
        <Toggle on={p.sound} onClick={p.onSound}
          agentExempt label="Chime this session"
          hint="Only this window, until you quit."
          detail={{ summary: "About the chime", body: <>A chime when a session errors or needs you. It is off at every start; the speaker in the header flips it too.</> }} />
        <SettingRow agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
          label="Alarm voice" hint="Spoken when a reminder rings."
          control={alarmPicker} />
      </SettingsCard>

      <SettingsCard title="Interrupt me for" icon={<BellIcon size={ICON.sm} />}
        desc="Whatever is off still shows quietly on the fleet card.">
        {NOTIFY_KINDS.map((k) => (
          <Toggle key={k} on={prefs.kinds[k]} disabled={prefs.none}
            onClick={() => setKind(k, !prefs.kinds[k])}
            agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
            label={NOTIFY_KIND_LABEL[k].label} hint={NOTIFY_KIND_LABEL[k].desc} />
        ))}
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
  return levelFor(d, pickedAgent()) === "needed" ? "var(--error)" : "var(--text3)";
}

/** Worst first: what is broken, then what is merely unconfigured, then the
 *  rest. Someone opening this pane is looking for the problem, not the list. */
const RANK: Record<DepStatus, number> = { missing: 0, attention: 1, ok: 2, unsupported: 3 };
const LEVEL_RANK = { needed: 0, recommended: 1, optional: 2 } as const;
const byUrgency = (a: DepReport, b: DepReport) =>
  (RANK[a.status] - RANK[b.status])
  || (LEVEL_RANK[levelFor(a, pickedAgent())] - LEVEL_RANK[levelFor(b, pickedAgent())]);

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
        <span key={d.id} data-tip={`${d.title} — ${d.what}`}
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
  if (d.status === "missing" && levelFor(d, pickedAgent()) === "needed") return "err";
  return "off";
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
  // Only a missing tool is an install. An installed-but-unusable one has a
  // sign-in or a first run, and an Install button there was the clean-install
  // bug: gh, docker and task all offered one.
  const canType = d.status === "missing" && !!d.install;
  const guide = !!href && d.status !== "unsupported" && d.status !== "ok";
  const tone = depTone(d);
  const mark: "ok" | "warn" | "err" | "off" = tone === "warn" ? "warn" : tone === "err" ? "err" : tone === "ok" ? "ok" : "off";
  const fact = installedFact(d.status);
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
      status={<StatusBadge tone={tone}>{d.status === "missing" && levelFor(d, pickedAgent()) === "needed" ? "Needed, not installed" : STATUS_LABEL[d.status]}</StatusBadge>}
      actions={canType
        ? <Button aria-expanded={console} onClick={() => setConsole((v) => !v)}
            title="Open a shell here with the command typed in — you press Enter">
            {console ? "Close shell" : "Install"}
          </Button>
        : guide
          ? <LinkButton href={href!}>Install guide</LinkButton>
          : undefined}>
      {/* "Needs setup" is a tool that IS here and cannot be used yet (gh with no login, docker with no daemon). */}
      <CheckRow tone={fact.tone} label={fact.label}
        value={fact.value === "bin" ? <code className="t-mono">{d.bin}</code> : fact.value === "unused" ? undefined : <><span className="t-mono">{d.bin}</span> is not on your PATH</>} />
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
/** A door-backed number row drawn with a literal label/settingId, so the
 *  settings-index generator (which reads JSX text, not values) can bind it:
 *  privacy and hooks pages are the ones settings-rows-bound.test.ts checks
 *  every server setting is reached from, and a DoorCard's `spec.id` is
 *  invisible to that scan. */
function useNumberDoor(id: string) {
  const [value, setValue] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.settingAt(id, "").then((r) => { if (live && r.ok) { setValue(r.value as number); setDraft(String(r.value)); } });
    return () => { live = false; };
  }, [id]);
  const commit = async () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 0) { setErr("A whole number of days, 0 or more"); return; }
    setBusy(true); setErr(null);
    const r = await api.settingAtSet(id, n, "").catch(() => ({ ok: false, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "That did not save."); return; }
    setValue(n); setDraft(String(n));
  };
  return { value, draft, setDraft, busy, err, commit };
}

/** The field a `useNumberDoor` row draws: its own component, not inline JSX
 *  in a `control={…}` prop, so settings-page-rules.test.ts's "inline-input"
 *  sweep (migrated pages carry none) does not read it as a hand-built form. */
function NumberDoorField({ label, state }: { label: string; state: ReturnType<typeof useNumberDoor> }) {
  return (
    <span className="inline-flex items-start gap-2">
      <input value={state.draft} onChange={(e) => state.setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void state.commit(); }}
        disabled={state.busy} inputMode="numeric" aria-label={label} className={INPUT} style={INPUT_STYLE} />
      <Button disabled={state.busy || state.draft === String(state.value ?? "")} onClick={() => void state.commit()}>Save</Button>
    </span>
  );
}

export function PrivacyPane({ open }: { open: boolean }) {
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
  const diskWarn = useSyncExternalStore(subscribeSettings, diskWarnPct, () => DISK_WARN_DEFAULT);
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
  const clickupDays = useNumberDoor("privacy.clickupCardDays");
  const ledgerDays = useNumberDoor("privacy.ledgerStubDays");
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

      <SettingsCard title="Disk space" icon={<DiskIcon size={ICON.sm} />}>
        <Choice<string>
          settingId="prefs.diskWarn" label="Warn when free disk is under"
          hint="A quiet badge on the machine panel; nothing pops up."
          detail={{ summary: "Details", body: "Counted per disk, as a share of its size. Off shows no badge. This only decides when to say so: nothing is deleted by it." }}
          value={String(diskWarn)} modified={diskWarn !== DISK_WARN_DEFAULT}
          onPick={(v) => { setting("prefs.diskWarn").set(Number(v)); }}
          options={DISK_WARN_CHOICES.map((n) => ({ v: String(n), label: n === 0 ? "Off" : `${n} %` }))} />
      </SettingsCard>

      <SettingsCard title="Other local caches">
        <SettingRow settingId="privacy.clickupCardDays" label="ClickUp card cache"
          hint="How long a card stays in the local index after it was last seen. 0 keeps everything."
          control={<NumberDoorField label="ClickUp card cache" state={clickupDays} />}
          below={clickupDays.err ? <span role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{clickupDays.err}</span> : undefined} />
        <SettingRow settingId="privacy.ledgerStubDays" label="Understudy ledger"
          hint="How long the understudy ledger keeps a bare write record. 0 keeps everything."
          control={<NumberDoorField label="Understudy ledger" state={ledgerDays} />}
          below={ledgerDays.err ? <span role="alert" className="text-[12px]" style={{ color: "var(--error-ink)" }}>{ledgerDays.err}</span> : undefined} />
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
  const covered = servicesCoveredByTools(status);
  const listed = PROVIDERS.filter((p) => !covered.has(p.id));
  const all = status?.filter((x) => listed.some((p) => p.id === x.id)) ?? null;
  const ok = all?.filter((x) => x.state === "connected").length ?? 0;
  const bad = all?.filter((x) => x.state === "error").length ?? 0;
  const readyN = ok, needsN = bad;
  useEffect(() => { onCount({ total: listed.length, ready: readyN, needs: needsN, busy }); }, [listed.length, readyN, needsN, busy]);
  const shown = (id: string) => {
    const st = statusOf(id)?.state;
    return filter === "all" || (filter === "ready" ? st === "connected" : st === "error");
  };
  return (
    <>
      {err && (
        <SettingsCard label="Services" tone="error" wide>
          <ProblemNote title={err} action={<Button pending={busy} onClick={() => void load()}>Try again</Button>}>The local server did not answer, so no service could be checked.</ProblemNote>
        </SettingsCard>
      )}
      {listed.filter((p) => shown(p.id)).map((p) => (
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
      needs: live.filter((d) => needsYou(d, pickedAgent())).length });
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
      <SettingsCard label="Tools on this machine" desc={desc} tone={err ? "error" : "default"}
        status={<StatusBadge tone={err ? "err" : "checking"}>{err ? "Not checked" : "Checking"}</StatusBadge>}
        actions={recheck}>
        {err
          ? <ProblemNote title="Nothing could be checked">{err} Recheck to try again.</ProblemNote>
          : <BoardSkeleton label="Checking this machine…" widths={[70, 50]} dots={false} />}
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
  const needs = (d: DepReport) => needsYou(d, pickedAgent());
  const tiles = filter === "ready" ? [] : filter === "needs" ? wants.filter(needs) : wants;
  const group = readyGroup(ready.length, wants.length);
  return (
    /* Only what wants something gets a tile (the status, the lines, the install); the ones that
       are ready collapse into one card, where a name and a dot are enough. */
    <>
      {tiles.map((d) => <DepRow key={d.id} d={d} home={shellRoot} />)}

      {filter !== "needs" && (ready.length > 0 || idle.length > 0) && (
        <SettingsCard title={group.title} icon={<ServerIcon size={ICON.sm} />}
          status={<StatusBadge tone="ok">{group.badge}</StatusBadge>}>
          {ready.length > 0 && (
            <Fold label={group.fold} defaultOpen={filter === "ready"}
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
function useToolsSections(open: boolean, barOnHeading = false): { bar: React.ReactNode; sections: PageSection[] } {
  const [filter, setFilter] = useState<ToolsFilter>("all");
  const [nonce, setNonce] = useState(0);
  const [deps, setDeps] = useState<ToolsCount>({ total: 0, ready: 0, needs: 0, busy: false });
  const [provs, setProvs] = useState<ToolsCount>({ total: 0, ready: 0, needs: 0, busy: false });
  const ready = deps.ready + provs.ready, needs = deps.needs + provs.needs, total = deps.total + provs.total;
  useReportHead("connections", total ? { chips: [{ tone: "ok", text: `${ready} ready` }, ...(needs ? [{ tone: "warn" as const, text: `${needs} need you` }] : [])] } : null);
  const bar = (
    <div className="agx-tools-bar">
      <Segmented<ToolsFilter> track label="Show" value={filter} onChange={setFilter}
        options={[{ id: "all", label: `All ${total}` }, { id: "ready", label: `Ready ${ready}` }, { id: "needs", label: `Needs you ${needs}` }]} />
      <span className="flex-1" />
      <Button pending={deps.busy || provs.busy} onClick={() => setNonce((n) => n + 1)}>
        <IconLabel icon={<RefreshIcon size={ICON.xs} />}>Recheck</IconLabel>
      </Button>
    </div>
  );
  const sections: PageSection[] = [
    { id: "tools", title: "Tools on this machine", kind: "normal", body: <Section id="tools" title="Tools on this machine" action={barOnHeading ? bar : undefined}><RequirementsPane open={open} filter={filter} nonce={nonce} onCount={setDeps} /></Section> },
    { id: "services", title: "Services", kind: "normal", body: <Section id="services" title="Services"><IntegrationsPane open={open} filter={filter} nonce={nonce} onCount={setProvs} /></Section> },
  ];
  return { bar, sections };
}

/** Tools & services as its own page: a search hit stacks it under the other results. */
function ToolsPane({ open }: { open: boolean }) {
  const { bar, sections } = useToolsSections(open);
  return <PageShell title="Tools & services" purpose="What this machine has and what the services say." scopeSlot={bar} sections={sections} />;
}

/**
 * Tools & services' two sections, drawn inside the Tasks page so Tasks stays ONE page with one rail.
 * Drawn as a second page stacked under Tasks, each rail was sticky only inside its own page: the Tasks
 * rail scrolled away under the Tools rail (83 rail positions measured at 2540x900), and a click on
 * Card tracker left the visible rail on another entry. The filter and Recheck act on the tools and
 * services only, so they sit on that section's heading. The rail reads both headings from the DOM.
 */
function ToolsSections({ open }: { open: boolean }) {
  const { sections } = useToolsSections(open, true);
  return <>{sections.map((s) => <Fragment key={s.id}>{s.body}</Fragment>)}</>;
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
export function LaunchPermissionsCard({ open }: { open: boolean }) {
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
          body: <>This covers the Review menu, a hand-off, an issue, a resumed session and a Command that runs claude; a review prompt or a Command can choose its own in its editor. Ask is Claude Code's own default: it asks before a tool it has not been allowed. Auto lets it decide what is safe to run. Accept edits runs file edits without asking. Bypass runs everything without asking — a tab in another mode than your other agents holds what is sent to it until somebody answers in it.</>,
        }}
        wide
        control={<Segmented track label="Permission mode" value={mode} disabled={busy}
          onChange={(v) => { if (isLaunchMode(v)) { setMode(v); save({ mode: v }); } }}
          options={LAUNCH_MODES.map((m) => ({ id: m, label: LAUNCH_MODE_LABEL[m] }))} />}
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

/**
 * Which tracker each repository's cards live in. Only drawn when both ClickUp
 * and Jira are connected: with one, there is nothing to choose and no setting
 * to show. "Auto" reads the id's prefix (see trackerFor); the buttons are for
 * the repository where that cannot tell.
 */
export function CardTrackerSection({ onGo }: { onGo?: (pane: Pane) => void } = {}) {
  const setup = useTrackerSetup();
  const both = !!setup?.clickup && !!setup?.jira;
  const [rows, setRows] = useState<{ repos: string[]; chosen: Record<string, Exclude<TrackerChoice, "auto">>; writes: Record<string, true> } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!both) return;
    let live = true;
    void api.trackerProjects(true).then((r) => {
      if (!live || !r.ok) return;
      const chosen = r.projects ?? {};
      const writes = r.clickupWrites ?? {};
      /* The server's order — the open project's own repository first — and a
         stored choice the sweep did not find still gets its row. */
      setRows({ repos: [...(r.repos ?? []), ...Object.keys(chosen)], chosen, writes });
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
  /* The old tracker stays writable only where the person says so: an old pull
     request's card is read, not moved, by somebody whose work moved on. */
  const allow = async (repo: string, on: boolean) => {
    const r = await api.setClickupWrites(repo, on);
    if (!r.ok) { setNote(r.error ?? "Could not save that"); return; }
    setNote("");
    rememberClickupWrites(r.writes ?? {});
    setRows((cur) => cur && { ...cur, writes: r.writes ?? {} });
  };
  const list = useMemo(() => (rows ? trackerRows(rows.repos, rows.chosen, rows.writes) : []), [rows]);
  const only = setup?.jira ? "Jira" : setup?.clickup ? "ClickUp" : null;
  return (
    <>
    <SettingsCard label="Card tracker"
      desc={<>Where a card id in a branch or pull request is looked up.
        {note && <span className="block mt-1" role="alert" style={{ color: "var(--error-ink)" }}>{note}</span>}</>}>
      {both ? (<>
        {!list.length && <EmptyState>No repositories to choose for yet.</EmptyState>}
        {list.map((row) => (
          /* Both decisions for the repository on one row: which tracker owns the
             card, and whether the old one may still be written to. The value in
             force is drawn even when it is the default, so nothing looks unset. */
          <SettingRow key={row.repo} wide label={row.repo}
            hint="Auto reads the id's prefix."
            control={
              <span className="flex items-center gap-3 flex-wrap">
                <Segmented<TrackerChoice> track label={`${row.repo}: which tracker`} value={row.tracker}
                  onChange={(v) => void pick(row.repo, v)}
                  options={[{ id: "auto", label: "Auto" }, { id: "clickup", label: "ClickUp" }, { id: "jira", label: "Jira" }]} />
              </span>
            } />
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
    <SettingsCard title="Writes" icon={<ChecklistIcon size={ICON.sm} />}>
      <SettingRow agentExempt label="Changes in ClickUp" hint="Same switch as the Tasks panel." onClick={onGo ? () => onGo("clickup") : undefined} />
      <SettingRow agentExempt label="Changes in Jira" hint="Same switch as the Tasks panel." onClick={onGo ? () => onGo("jira") : undefined} />
      {both && list.map((row) => (
        <SettingRow key={row.repo} wide label={`${row.repo}: ClickUp changes`}
          hint="Read-only until allowed. An old pull request's card is read, not moved."
          control={<Segmented<"off" | "on"> track label={`${row.repo}: ClickUp changes`} value={row.writesOn ? "on" : "off"}
            onChange={(v) => void allow(row.repo, v === "on")}
            options={[{ id: "off", label: "Read-only" }, { id: "on", label: "Allow" }]} />} />
      ))}
    </SettingsCard>
    </>
  );
}

/** Types a branch name and shows what the app would read as its card: the same function the pull request list uses. */
function TryBranch({ prefixes, clickupPrefix }: { prefixes: readonly string[]; clickupPrefix?: string }) {
  const [text, setText] = useState("feat/ORBIT-1042-retry");
  const id = cardIdIn(text);
  const prefix = id?.split("-")[0]?.toLowerCase();
  const tracker = !id ? "" : prefixes.some((x) => x.toLowerCase() === prefix) ? " · Jira" : clickupPrefix && clickupPrefix.toLowerCase() === prefix ? " · ClickUp" : "";
  return (
    <>
    <SettingRow agentExempt label="Test a branch name" hint="See what the rule finds."
      below={<input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Branch name to test"
          className={`t-mono min-w-0 w-full ${INPUT}`} style={INPUT_STYLE} />} />
    <SettingRow agentExempt label="Result"
      control={<span data-try-branch><StatusBadge tone={id ? "ok" : "off"}>{id ? `${id.toUpperCase()}${tracker}` : "No card id"}</StatusBadge></span>} />
    </>
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
  const [barShown, setBarShown] = useState<Record<UsageBarProvider, boolean>>(barSwitches);
  // The switches used to keep the answer read when the modal mounted, which is
  // before the first poll has recorded what this machine has seen — so a
  // provider with a chip in the bar drew as off here. Re-read the same
  // `showInBar` the strip asks whenever a reading lands.
  const usageSnapshot = useSyncExternalStore(subscribeProviderUsage, providerUsage, () => null);
  useEffect(() => {
    setBarShown(barSwitches());
  }, [usageSnapshot]);
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
  const [pane, setPaneRaw] = useState<Pane>(() => {
    try {
      // Through the alias map: a page remembered under an old id opens the page it is part of now, and an id
      // that names nothing opens Appearance. A plugin page is kept even before the list of plugins has loaded;
      // if the plugin is gone its page says so rather than silently moving you.
      return restorePane(localStorage.getItem(LAST_PANE_KEY)) as Pane;
    } catch { /* private mode */ }
    return restorePane(null) as Pane;
  });
  /** Every way onto a page goes through the map, so a folded id (a search hit on an old page, a pinned row)
   *  lands on the page that holds it now. */
  const setPane = useCallback((v: Pane | ((p: Pane) => Pane)) => setPaneRaw((p) => resolvePane(typeof v === "function" ? v(p) : v) as Pane), []);
  useEffect(() => { try { localStorage.setItem(LAST_PANE_KEY, pane); } catch { /* ignore */ } }, [pane]);
  // Each time a page is on screen, once (lib/usageOpens.ts). A plugin's page is one id: its name is not ours to record.
  useEffect(() => { if (open) noteOpen(`settings:${pane.startsWith("plugin:") ? "plugin" : pane}`); }, [open, pane]);
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
  const [badges, setBadges] = useState<{ connections?: number; remoteLiveCount?: number | null; remotePaired?: number | null; remoteOn?: boolean | null }>({});
  const [logDigest, setLogDigest] = useState<LogDigest | "failed" | null>(null);
  /** The three onboarding steps, read from the same state Connections and
   *  Agents already show — this owns no state of its own, so it cannot say
   *  "done" about something those pages would call unfinished. `null` until
   *  the reads land, which keeps the pinned row off the nav rather than
   *  flashing it and pulling it back a second later. */
  const [onboarding, setOnboarding] = useState<{ hook: boolean; provider: boolean; paneEngine: boolean } | null>(null);
  /** The tutorial's seen list, so this page lists what is still unread. */
  const [tutorialSeen, setTutorialSeen] = useState("");
  /** Facts only the nav's marks and the page header's chips read. `null` is a
   *  read that has not landed or that failed: it draws no mark rather than a
   *  guess. Read with the batch above, once per open. */
  const [facts, setFacts] = useState<Pick<NavFacts, "hooksWired" | "gateOff" | "tmuxOk" | "jiraConnected" | "lanternWatching" | "updateAvailable" | "notificationsOn" | "pluginsRunning" | "pluginsNeed" | "pluginsNeedTitle">>({
    hooksWired: null, gateOff: null, tmuxOk: null, jiraConnected: null, lanternWatching: null, updateAvailable: null, notificationsOn: null,
    pluginsRunning: null, pluginsNeed: null,
  });
  useEffect(() => {
    if (!open) return;
    // A fresh read below; the Plugins page's tally from an earlier open is stale now.
    pluginTallyStore.set(null);
    let live = true;
    void Promise.all([
      api.dependencies().then((r) => r.deps).catch(() => null),
      api.providers().then((r) => r.providers).catch(() => null),
      api.remoteStatus().then((r) => r.clients.liveCount).catch(() => null),
      api.pairState("").then((r) => r.devices.filter((d) => !d.revokedAt).length).catch(() => null),
      api.hooksStatus().then((r) => ({ installed: r.installed, gateOff: r.gateBundled && !r.gate })).catch(() => null),
      api.logDigest().catch(() => "failed" as const),
      api.jiraStatus().then((r) => r.connected).catch(() => null),
      api.lanternSettings().then((r) => (r.ok && typeof r.watch === "boolean" ? r.watch : null)).catch(() => null),
      api.updateStatus().then((r) => isUpdateAvailable(r)).catch(() => null),
      api.notifyPrefs().then((r) => (r.ok ? !r.prefs.none : null)).catch(() => null),
      api.plugins().then((r) => r.plugins).catch(() => null),
      api.setupState().catch(() => null),
      remoteAccessEnabled().catch(() => null),
    ]).then(([deps, provs, remoteLiveCount, remotePaired, hookState, digest, jira, lanternWatching, updateAvailable, notificationsOn, plugs, setupState, remoteOn]) => {
      if (!live) return;
      setBadges({
        connections: connectionsNeeding(deps ?? [], provs ?? []),
        remoteLiveCount,
        remotePaired,
        remoteOn,
      });
      setLogDigest(digest);
      setTutorialSeen(setupState?.tutorialSeen ?? "");
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
        ...pluginFacts(plugs === null ? null : tallyInstalled(plugs, () => false)),
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
  /* The page on screen (`shown`) and the page asked for (`pane`) differ for a moment: the one asked for
     mounts out of sight and is swapped in whole once every read it declared has answered, so nothing on
     screen grows or moves while it loads. lib/settingsReady.ts has the rules. */
  /* Two layers, keyed "a" and "b", that trade places: the front one is on screen, the other mounts the
     page asked for out of sight. Trading which is in front (never moving a page between them) is what
     keeps a page mounted, with its state and reads, when it is swapped in. */
  const [front, setFront] = useState<{ layer: Layer; pane: string | null }>({ layer: "a", pane: null });
  const back = backPane(front.pane, pane, !!ql);
  const [phaseNow, setPhaseNow] = useState<SwitchPhase>("swap");
  const [loadTick, setLoadTick] = useState(0);
  const pendingLoads = useRef(new Map<string, Set<string>>());
  const loadSink = useMemo<PageLoadSink>(() => ({
    report: (owner, key, on) => {
      const m = pendingLoads.current;
      const set = m.get(owner) ?? m.set(owner, new Set()).get(owner)!;
      if (on) set.add(key); else set.delete(key);
      setLoadTick((t) => t + 1);
    },
  }), []);
  /** Gates a page's content in one layer: that layer's page with no query running, or — while
   *  searching — whichever pages the query actually answers. */
  const showIn = useCallback((p: string | null) => (id: string): boolean => (ql ? matchIds.has(id) : p !== null && (p === id || !!FOLDED_INTO[p]?.includes(id))), [ql, matchIds]);
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
  /* Keyed by the page it was asked for: `front.pane === pane` is also true for the page that was open
     BEFORE the switch, so a row id with no page would be applied to that page and then dropped. */
  const [pendingJump, setPendingJump] = useState<{ page: string | null; row: string } | null>(null);
  const flashRow = pendingJump?.row ?? null;
  useEffect(() => { if (open && jump?.row) setPendingJump({ page: jump.pane ? resolvePane(jump.pane) : null, row: jump.row }); }, [open, jump]);
  useEffect(() => {
    if (pendingJump && !keepPendingJump(open, pendingJump.page, (p) => TABS.some((t) => t.id === p) || p.startsWith("plugin:"))) setPendingJump(null);
  }, [open, pendingJump]);
  const filterCtx = useMemo(() => ({ ...filter, flash: flashRow }), [filter, flashRow]);
  useEffect(() => {
    if (!pendingJump || ql || !pendingJumpReady(pendingJump.page, front.pane, pane)) return;
    const id = pendingJump.row;
    const raf = requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"], [data-setting-id="${CSS.escape(id)}"]`);
      const root = contentRef.current;
      const attr = (sel: string, a: string) => [...(root?.querySelectorAll<HTMLElement>(sel) ?? [])].map((n) => n.getAttribute(a) ?? "");
      const kind = jumpTarget(id, [...attr("[data-row]", "data-row"), ...attr("[data-setting-id]", "data-setting-id")], attr("[data-section]", "data-section"));
      if (kind === "section") {
        // A section id: the rail entry's own click scrolls to it, flashes it and marks it in "On this page".
        const entry = root?.querySelector<HTMLElement>(`[data-rail-entry="${CSS.escape(id)}"]`);
        if (entry) entry.click(); else jumpToSection(root, id);
      } else if (el) {
        // Pinned like a section jump: the page grows after this frame (late reads), so the rail keeps the row centered until input or a still page.
        const notHandled = el.dispatchEvent(new CustomEvent(PIN_ROW_EVENT, { bubbles: true, cancelable: true, detail: { row: id, section: el.closest<HTMLElement>("[data-section]")?.dataset.section ?? null } }));
        // A page without a rail has no listener: scroll directly.
        if (needsDirectScroll(notHandled)) el.scrollIntoView({ block: "center" });
        el.classList.add("agx-row-flash");
        window.setTimeout(() => el.classList.remove("agx-row-flash"), 1200);
      }
      setPendingJump(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingJump, ql, pane, front.pane]);
  /** Enter on the selected result, or a click on one: land on it. Clearing
   *  the query first is what makes `flashRow`'s effect (above) wait for the
   *  single settled page to mount before it goes looking for the row. */
  const landOnResult = useCallback((r: { pane: string; row: string }) => {
    setPane(r.pane as Pane);
    setQ("");
    if (r.row) setPendingJump({ page: resolvePane(r.pane), row: r.row });
  }, []);
  const [termFont, setTermFontState] = useState(() => currentTermFont());
  const [termSize, setTermSizeState] = useState(() => currentTermSize());
  const [termLine, setTermLineState] = useState(() => currentTermLineHeight());
  const [termCursor, setTermCursorState] = useState<CursorStyle>(() => currentTermCursor());
  const [ffm, setFfm] = useState(() => focusFollowsMouse());
  const [groupsOn, setGroupsOn] = useState(() => tabGroupsOn());
  const [groupRules, setGroupRules] = useState(() => tabGroupRulesText());
  const [paneActs, setPaneActs] = useState<PaneActionsMode>(() => paneActionsMode());
  const [paneMark, setPaneMark] = useState<PaneMarker>(() => paneMarker());
  const [scrollback, setScrollbackState] = useState(() => currentScrollback());
  const [wordSep, setWordSepState] = useState(() => currentWordSeparators());
  const [copySel, setCopySel] = useState(() => copyOnSelect());
  const [benchLnk, setBenchLnk] = useState(() => benchLinks());
  const [otherLnk, setOtherLnk] = useState<OtherLinks>(() => otherLinks());
  const [rcPaste, setRcPaste] = useState(() => rightClickPaste());
  const benchFab = useSyncExternalStore(subscribeBench, () => benchState().fabMode);
  const [noteEd, setNoteEd] = useState<NoteEditor>(() => currentNoteEditor());
  const [dSplit, setDSplitState] = useState(() => diffSplit());
  const [dTheme, setDThemeState] = useState(() => diffThemePref());
  const [dWrap, setDWrapState] = useState(() => diffWrap());
  const [accent, setAccentState] = useState(() => currentAccent());
  // Remounts the appearance rows after a reset: they hold their own copy of
  // the accent and would go on showing the one that was just cleared.
  const [appearanceNonce, setAppearanceNonce] = useState(0);
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
    setPaneMark(paneMarker());
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
      { modified: benchState().fabMode !== "always", reset: () => setBenchFabMode("always") },
      { modified: renderer !== "auto", reset: () => { setRendererPref("auto"); setRenderer("auto"); } },
      { modified: termFont !== "", reset: () => { setTermFont(""); setTermFontState(""); } },
      { modified: termSize !== DEFAULT_SIZE, reset: () => { setTermSize(DEFAULT_SIZE); setTermSizeState(DEFAULT_SIZE); } },
      { modified: termLine !== DEFAULT_LINE_HEIGHT, reset: () => { setTermLineHeight(DEFAULT_LINE_HEIGHT); setTermLineState(DEFAULT_LINE_HEIGHT); } },
      { modified: termCursor !== "block", reset: () => { setTermCursor("block"); setTermCursorState("block"); } },
      { modified: ffm, reset: () => { setFocusFollowsMouse(false); setFfm(false); } },
      { modified: paneActs !== "summary" || paneMark !== "line", reset: () => { setPaneActionsMode("summary"); setPaneActs("summary"); setPaneMarker("line"); setPaneMark("line"); } },
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

  /** The page on screen as the nav knows it: a plugin's own page is the Plugins page. The header and the
   *  scroller follow the page on screen (it stays up while the one asked for loads); the nav marks the
   *  one asked for at once. */
  const asNav = (p: string) => (p.startsWith("plugin:") ? "plugins" : p);
  const navPane = asNav(front.pane ?? pane);
  /* One scroller is shared by every page: a page change opens at the top. A row jump scrolls itself afterwards (flashRow). */
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [navPane]);
  const navTab = TABS.find((x) => x.id === navPane);
  const colRef = useRef<HTMLDivElement | null>(null);
  const switchAt = useRef(0);
  /** Each page's height the last time it left the screen: the skeleton holds it, so the swap moves nothing. */
  const heights = useRef(new Map<string, number>());
  useLayoutEffect(() => { switchAt.current = performance.now(); }, [pane]);
  const settled = back === null;
  // The two moments the phase can change with no read answering: the hold runs out, and the cap.
  useEffect(() => {
    if (settled || ql || !open) return;
    const t1 = setTimeout(() => setLoadTick((t) => t + 1), HOLD_MS);
    const t2 = setTimeout(() => setLoadTick((t) => t + 1), CAP_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- timed from the click, not from the skeleton
  }, [pane, settled, ql, open]);
  /* Decided before paint, after the page asked for has mounted and its reads have reported: a page with
     nothing to read, or all of it cached, swaps in this same frame. One scroller is shared by every page,
     so the swap is also where a page change opens at the top (a row jump scrolls itself afterwards, flashRow). */
  useLayoutEffect(() => {
    if (!open) { if (front.pane !== null) setFront((f) => ({ ...f, pane: null })); return; }
    // A query stacks its matches in the front layer at once: search results are never held back.
    if (ql) { if (front.pane !== pane) setFront((f) => ({ ...f, pane })); return; }
    if (settled) { if (phaseNow !== "swap") setPhaseNow("swap"); return; }
    const leave = () => { if (front.pane && colRef.current) heights.current.set(front.pane, colRef.current.offsetHeight); };
    const ph = switchPhase(pageReady(true, pendingLoads.current.get(pane)), performance.now() - switchAt.current);
    if (ph === "swap") {
      leave();
      setFront((f) => ({ layer: otherLayer(f.layer), pane }));
    } else if (ph === "skeleton" && phaseNow !== "skeleton") {
      leave();
      setFront((f) => ({ ...f, pane: null }));
      setPhaseNow("skeleton");
    } else if (ph === "hold" && phaseNow !== "hold") setPhaseNow("hold");
  }, [open, ql, pane, front.pane, settled, loadTick, phaseNow]);
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
  // The Plugins page's own tally (updates included), once it has reported: the same tally the page's chips read.
  const pageTally = useSyncExternalStore(pluginTallyStore.subscribe, pluginTallyStore.get, () => null);
  const marks = useMemo(() => foldMarks(withProblems(withNeeds(navMarks({
    ...NO_FACTS, ...facts, ...(pageTally ? pluginFacts(pageTally) : {}),
    connectionsNeed: badges.connections ?? null,
    remoteLive: badges.remoteLiveCount == null ? null : badges.remoteLiveCount > 0,
    remotePaired: badges.remotePaired ?? null,
    remoteLiveCount: badges.remoteLiveCount ?? null,
    remoteOn: badges.remoteOn ?? null,
    clickupConnected: cuConnected,
  }), needsBy), problems)), [facts, badges, logDigest, cuConnected, problems, needsBy, pageTally]);

  /* What Tasks draws of the pages folded into it; a search draws those as their own hits instead. */
  const tasksFold = ql ? undefined : <ToolsSections open={open} />;
  const pageCtx: PageCtx = { open, onClose, sound, onSound, scale, onZoom, theme, onTheme, alarmVoice, appKeyError, appearanceNonce, autostart, barShown, benchFab, benchLnk, otherLnk, setOtherLnk, capturing, capturingApp, capturingChord, ciApproved, copySel, cu, dSplit, dTheme, dWrap, diskWarn, facts, ffm, flashSaved, fullscreen, groupRules, groupsOn, h24, keyError, keys, landing, logDigest, mutedList, noteEd, notifyCap, notifyVoice, onboarding, own, paneActs, paneMark, quiet, railLayout, rcPaste, renderer, reviewGate, scrollback, setAccentState, setAlarmVoiceState, setAppKeyError, setAutostartState, setBarShown, setBenchLnk, setCapturing, setCapturingApp, setCapturingChord, setCiApproved, setCopySel, setDSplitState, setDThemeState, setDWrapState, setFfm, setFullscreenState, setGroupRules, setGroupsOn, setH24, setKeyError, setKeys, setLandingState, setNoteEd, setNotifyVoiceState, setPageChip, setPane, setPaneActs, setPaneMark, setQ, setRcPaste, setRenderer, setReviewGateState, setScrollbackState, setSourceTick, setSplash, setTalkMode, setTermCursorState, setTermFontState, setTermLineState, setTermSizeState, setUsageRefreshState, setWordSepState, sourceOrder, splash, sysNotify, talkMode, termCursor, termFont, termLine, termSize, trackerSetup, tutorialSeen, usageRefresh, wordSep };
  /** Every page's blocks, for one layer: `show` gates them to that layer's page (or the query's matches)
   *  and `pane` is that layer's page, so the two layers draw two different pages from the same lines. */
  const pageBlocks = (show: (id: string) => boolean, pane: string) => (
    <>
                  {ql && show("appearance") && <PageMatchHeading id="appearance" onOpen={() => { setPane("appearance" as Pane); setQ(""); }} />}
                  {show("appearance") && <AppearancePage c={pageCtx} />}
                  {ql && show("terminal") && <PageMatchHeading id="terminal" onOpen={() => { setPane("terminal" as Pane); setQ(""); }} />}
                  {show("terminal") && <TerminalPage c={pageCtx} />}
                  {ql && show("diff") && <PageMatchHeading id="diff" onOpen={() => { setPane("diff" as Pane); setQ(""); }} />}
                  {show("diff") && <DiffsPage c={pageCtx} />}
                  {ql && show("tasks") && <PageMatchHeading id="tasks" onOpen={() => { setPane("tasks" as Pane); setQ(""); }} />}
                  {/* Off a search, Tasks draws Tools & services inside its own page (ToolsSections) and has its own
                      Card tracker section, so the folded pages are drawn only as search hits: stacked, each page had
                      its own sticky rail. */}
                  {show("tasks") && <TasksPage c={pageCtx} folded={tasksFold} />}
                  {ql && show("privacy") && <PageMatchHeading id="privacy" onOpen={() => { setPane("privacy" as Pane); setQ(""); }} />}
                  {show("privacy") && <DataSettingsPage c={pageCtx} />}
                  {ql && show("recipes") && <PageMatchHeading id="recipes" onOpen={() => { setPane("recipes" as Pane); setQ(""); }} />}
                  {ql && show("review-prompts") && <PageMatchHeading id="review-prompts" onOpen={() => { setPane("review-prompts" as Pane); setQ(""); }} />}
                  {ql && show("saved-replies") && <PageMatchHeading id="saved-replies" onOpen={() => { setPane("saved-replies" as Pane); setQ(""); }} />}
                  {show("recipes") && <CommandsSettingsPage c={pageCtx} />}

                  {/* The engine and the memory it costs, together. Both used to
                      sit under "Preferences", which is where settings go when
                      nobody has decided where they belong — a page that mixes
                      window zoom with how a CLI is spawned is a drawer. */}
                  
                  
                  
                  

                  {ql && show("notifications") && <PageMatchHeading id="notifications" onOpen={() => { setPane("notifications" as Pane); setQ(""); }} />}

                  {show("notifications") && <NotificationsPage c={pageCtx} />}

                  {ql && show("browser") && <PageMatchHeading id="browser" onOpen={() => { setPane("browser" as Pane); setQ(""); }} />}

                  {show("browser") && <BrowserPage c={pageCtx} />}


                  {ql && show("keys") && <PageMatchHeading id="keys" onOpen={() => { setPane("keys" as Pane); setQ(""); }} />}

                  {show("keys") && <ShortcutsPage c={pageCtx} />}

                  {ql && show("git") && <PageMatchHeading id="git" onOpen={() => { setPane("git" as Pane); setQ(""); }} />}
                  {show("git") && <GitPage c={pageCtx} />}
                  {ql && show("engines") && <PageMatchHeading id="engines" onOpen={() => { setPane("engines" as Pane); setQ(""); }} />}
                  {show("engines") && <EnginesUsagePage c={pageCtx} />}
                  {ql && show("orchestration") && <PageMatchHeading id="orchestration" onOpen={() => { setPane("orchestration" as Pane); setQ(""); }} />}
                  {show("orchestration") && <OrchestrationPane onChip={setPageChip} lead={(root) => <FlightPlanLink root={root} onGo={onClose} />} />}
                  {ql && show("advanced") && <PageMatchHeading id="advanced" onOpen={() => { setPane("advanced" as Pane); setQ(""); }} />}
                  {show("advanced") && <AdvancedSettingsPage c={pageCtx} />}
                  {ql && show("inspect") && <PageMatchHeading id="inspect" onOpen={() => { setPane("inspect" as Pane); setQ(""); }} />}
                  {show("inspect") && <InspectSettingsPage />}
                  {ql && show("gaps") && <PageMatchHeading id="gaps" onOpen={() => { setPane("gaps" as Pane); setQ(""); }} />}
                  {show("gaps") && <GapsPane />}
                  {ql && show("polaris") && <PageMatchHeading id="polaris" onOpen={() => { setPane("polaris" as Pane); setQ(""); }} />}
                  {show("polaris") && <PolarisPage />}
                  {ql && show("polarisPrs") && <PageMatchHeading id="polarisPrs" onOpen={() => { setPane("polarisPrs" as Pane); setQ(""); }} />}
                  {show("polarisPrs") && <PolarisPrsPage />}
                  {ql && show("hooks") && <PageMatchHeading id="hooks" onOpen={() => { setPane("hooks" as Pane); setQ(""); }} />}

                  {show("hooks") && <WatchingPage c={pageCtx} />}

                  {ql && show("connections") && <PageMatchHeading id="connections" onOpen={() => { setPane("connections" as Pane); setQ(""); }} />}
                  {show("connections") && (ql || pane !== "tasks") && <ToolsPane open={open} />}
                  {ql && show("clickup") && cu && <PageMatchHeading id="clickup" onOpen={() => { setPane("clickup" as Pane); setQ(""); }} />}
                  {show("clickup") && cu && <ClickUpPage />}
                  {ql && show("jira") && <PageMatchHeading id="jira" onOpen={() => { setPane("jira" as Pane); setQ(""); }} />}
                  {show("jira") && <JiraPage c={pageCtx} />}

                  {ql && show("remote") && <PageMatchHeading id="remote" onOpen={() => { setPane("remote" as Pane); setQ(""); }} />}

                  {show("remote") && <RemoteDevicesPage open={open} />}
                  {ql && show("plugins") && <PageMatchHeading id="plugins" onOpen={() => { setPane("plugins" as Pane); setQ(""); }} />}
                  {show("plugins") && <PluginsSettingsPage c={pageCtx} />}
                  {pane.startsWith("plugin:") && <PluginsSettingsPage c={pageCtx} focus={pane.slice("plugin:".length)} />}

                  {ql && show("log") && <PageMatchHeading id="log" onOpen={() => { setPane("log" as Pane); setQ(""); }} />}

                  {show("log") && <ActivitySettingsPage c={pageCtx} />}
                  {ql && show("understudy") && <PageMatchHeading id="understudy" onOpen={() => { setPane("understudy" as Pane); setQ(""); }} />}
                  {show("understudy") && <UnderstudySettingsPage c={pageCtx} />}
                  {ql && show("onboarding") && <PageMatchHeading id="onboarding" onOpen={() => { setPane("onboarding" as Pane); setQ(""); }} />}
                  {ql && show("finder") && <PageMatchHeading id="finder" onOpen={() => { setPane("finder" as Pane); setQ(""); }} />}
                  {show("finder") && <FilesPage c={pageCtx} />}
                  {ql && show("perm") && <PageMatchHeading id="perm" onOpen={() => { setPane("perm" as Pane); setQ(""); }} />}
                  {show("perm") && <PermissionsPage c={pageCtx} />}
                  {ql && show("workers") && <PageMatchHeading id="workers" onOpen={() => { setPane("workers" as Pane); setQ(""); }} />}
                  {show("workers") && <WorkersSettingsPage c={pageCtx} />}
                  {ql && show("fplan") && <PageMatchHeading id="fplan" onOpen={() => { setPane("fplan" as Pane); setQ(""); }} />}
                  {show("fplan") && <FlightPlanSettingsPage c={pageCtx} />}
                  {ql && show("tracker") && <PageMatchHeading id="tracker" onOpen={() => { setPane("tracker" as Pane); setQ(""); }} />}
                  {show("tracker") && (ql || pane !== "tasks") && <TrackerSettingsPage />}
                  
                  {ql && show("about") && <PageMatchHeading id="about" onOpen={() => { setPane("about" as Pane); setQ(""); }} />}
                  {show("about") && <AboutSettingsPage c={pageCtx} />}
    </>
  );
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
            style={{ zIndex: 10000, background: "var(--bg)", ...NO_DRAG }}>

            {/* Back to app and the search box sit OUTSIDE the scrolling list, so a
                long nav can never push either off the top. The nav paints its
                OWN tone (--surface-nav) at a full-strength seam: it shared --bg
                with the page, so two regions that do entirely different jobs —
                twenty-four places you can go, and the one you are in — were the
                same surface with a 25%-alpha hairline between them. */}
            <SettingsNav
              pages={tabs} marks={marks} current={asNav(pane)}
              onGo={(id) => setPane(id as Pane)} onClose={onClose}
              onIntent={(id) => { if (shouldPrefetch(id, asNav(pane), hasReads(id))) prefetchPage(id); }}
              pinned={onboarding && !onboardingDone && !ql
                ? { done: [onboarding.hook, onboarding.provider, onboarding.paneEngine].filter(Boolean).length, total: 3, active: pane === "about" }
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
            <div className="agx-settings-main flex-1 min-w-0 min-h-0 flex flex-col">
              {/* The header sits above the one scroll region, not inside it. It
                  names the page on screen even while a query is stacking other
                  pages below it: those carry their own heading. */}
              {navTab && (
                <SettingsPageHeader
                  label={navTab.label} group={groupByName(navTab.group) ?? null} icon={navTab.icon} what={navTab.what}
                  scope={MACHINE_PAGES.has(navTab.id) ? (
                    <>
                      <span className="agx-ph-scope-k">{MACHINE_SCOPE.key}</span>
                      <span className="agx-ph-scope-pill"><ChipIcon size={ICON.sm} />{MACHINE_SCOPE.pill}</span>
                      <span className="agx-ph-scope-note">{MACHINE_SCOPE.note}</span>
                    </>
                  ) : undefined}
                  chips={pageChips(navTab.id, headerChips(navTab.id, marks[navTab.id] ?? NO_MARK, saving.has(navTab.id), savedPages.has(navTab.id), heads[navTab.id]?.chips), pageFacts).concat((navTab.id === "orchestration" || navTab.id === "git") && pageChip ? [pageChip] : [])}
                  primary={problems[navTab.id] ? <Button tone="primary" onClick={() => retries.current[navTab.id]?.()}>Try again</Button>
                    : heads[navTab.id]?.action?.flow ? (
                      // The Flow editor is the page's one way in, so it is the biggest button on it: HIT (26) is the page's other buttons, 40 is the next step up
                      // (no CTRL_H rung is taller than 32), with the flow glyph before the label and a chevron after.
                      <Button tone="primary" data-open-flow onClick={() => headRuns.current[navTab.id]?.()}
                        style={{ height: 40, padding: "0 16px", fontWeight: 700, fontSize: 13, gap: 8, boxShadow: "0 4px 14px color-mix(in srgb, var(--accent, var(--primary)) 35%, transparent)" }}>
                        <FlowIcon size={ICON.md} />{heads[navTab.id]!.action!.label}<ChevronRightIcon size={ICON.sm} />
                      </Button>
                    ) : heads[navTab.id]?.action ? <Button tone="primary" onClick={() => headRuns.current[navTab.id]?.()}>{heads[navTab.id]!.action!.plain ? heads[navTab.id]!.action!.label : <IconLabel icon={<PlusIcon size={ICON.xs} />}>{heads[navTab.id]!.action!.label}</IconLabel>}</Button> : undefined}
                  reset={pageModified(navTab.id) || ALWAYS_RESET.has(navTab.id) ? <Button disabled={!pageModified(navTab.id)} onClick={() => resetPage(navTab.id)}>{RESET_WORD[navTab.id] ?? "Reset page"}</Button> : undefined} />
              )}
              {/* The one scroll region, and the only element in Settings that owns
                  a scrollbar: what sticks inside it (the scope bar, the index)
                  is offset from its top edge, never from the header's. */}
              <div ref={contentRef} tabIndex={-1} data-settings-scroll className="agx-settings-scroll agx-scroll flex-1 min-h-0 min-w-0">
              <div className="agx-settings-page"
                style={{ "--hue": hueVar(groupByName(navTab?.group ?? "")?.id ?? "system") } as React.CSSProperties}>
                                <div className="agx-settings-content">
                  <div ref={colRef} className="agx-settings-col" style={{ position: "relative" }}>
                  {!ql && !settled && phaseNow === "skeleton" && <PageSkeleton height={heights.current.get(pane)} />}
                  <PageLoad.Provider value={loadSink}>
                  <PageState.Provider value={pageState}>
                  <Filter.Provider value={filterCtx}>
                  {LAYERS.map((k) => {
                    const p = k === front.layer ? front.pane : back;
                    return (
                      <PageSlot key={k} role={layerRole(k === front.layer, p, !!ql)} owner={p ?? ""}>
                        {(ql ? k === front.layer : p !== null) && pageBlocks(showIn(p), ql ? pane : p!)}
                      </PageSlot>
                    );
                  })}
                  </Filter.Provider>
                  </PageState.Provider>
                  </PageLoad.Provider>
                  </div>
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


/** The nav facts for plugins, from the one tally the Plugins page reads. At open the market is not read,
 *  so updates count only once the page has reported (pluginTallyStore). */
function pluginFacts(t: PluginTally | null): Pick<NavFacts, "pluginsRunning" | "pluginsNeed" | "pluginsNeedTitle"> {
  if (!t) return { pluginsRunning: null, pluginsNeed: null, pluginsNeedTitle: null };
  const need = pluginNavNeed(t);
  return { pluginsRunning: t.running, pluginsNeed: need?.count ?? 0, pluginsNeedTitle: need?.title ?? null };
}
