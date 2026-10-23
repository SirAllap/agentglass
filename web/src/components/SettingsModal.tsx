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
import { PluginSettingsPane } from "./plugins/PluginSettingsPane.tsx";
import { Fragment, createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RecipesPane } from "./RecipesPane.tsx";
import { ReviewPromptsPane } from "./ReviewPromptsPane.tsx";
import { SavedRepliesPane } from "./SavedRepliesPane.tsx";
import { lastTerminalRoot } from "./TerminalPanel.tsx";
import { Filter, Fold, SettingRow, Toggle, Switch } from "./SettingRow.tsx";
import { resetShown } from "../lib/settingsModified.ts";
import { pageScore, searchSettings, absentFor, expandWord, rowId, type SettingsPage } from "../lib/settingsIndex.ts";
import { motion, AnimatePresence } from "motion/react";
import { Portal, PortalFloor } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { api } from "../lib/api.ts";
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
import type { ActionRecord, GateRecord, UnderstudyClassRow } from "../../../shared/types.ts";
import { mergeActivity, gateLine, actorLabel, activityDays, type ActivityRow, type ActivityRun } from "../lib/activity.ts";
import { ingestUpdate } from "../lib/updateStore.ts";
import { ReleaseNotesModal } from "./ReleaseNotesModal.tsx";
import { installedNotes, type NotesTarget } from "../lib/whatsNew.ts";
import { autostartEnabled, setAutostart, isFullscreen, toggleFullscreen, IS_DESKTOP, IS_MAC_DESKTOP, HAS_BROWSER } from "../lib/desktop.ts";
import { overlayOpen } from "../lib/overlays.ts";
import { Select } from "./Select.tsx";
import { WORKER_ROLES } from "../../../shared/workerRoles.ts";
import { ALARM_VOICES, NOTIFY_VOICES, findVoice, playVoice, type Voice } from "../lib/sounds.ts";
import { alarmVoiceId, setAlarmVoice } from "../lib/alarm.ts";
import { SEARCH_ENGINE_LABELS, type SearchEngine } from "../lib/browserUrl.ts";
import { homePageRaw, setHomePage, searchEngine, importHistory, setImportHistory, importBookmarks, setImportBookmarks, pickImportRows } from "../lib/browserPrefs.ts";
import { RemoteAccessPane } from "./RemoteAccessPane.tsx";
import { NOTIFY_KINDS, NOTIFY_CHANNELS, NOTIFY_KIND_LABEL, NOTIFY_CHANNEL_LABEL, type NotifyKind, type NotifyChannel } from "../../../shared/notifyPrefs.ts";
import { getNotifyPrefs, subscribeNotifyPrefs, saveNotifyPrefs } from "../lib/notifyPrefsStore.ts";
import { PluginsPane } from "./PluginsPane.tsx";
import { TerminalIcon, DiffIcon, BrowserIcon, UnderstudyIcon, LanternIcon } from "./workspace/icons.tsx";
import {
  SlidersIcon, ThemeIcon, BellIcon, SidebarIcon, KeyboardIcon, BudgetIcon, PulseIcon,
  CommandIcon, ReviewIcon, QuoteIcon, PanesIcon, PlugIcon, ServerIcon, PhoneIcon,
  PuzzleIcon, ShieldIcon, InfoIcon, ChecklistIcon,
} from "./settingsNavIcons.tsx";
import { resolvePane, openSettings, paneWhenClickupKnown } from "../lib/openSettings.ts";
import { RunningPanes } from "./RunningPanes.tsx";
import { THEMES } from "../lib/highlight.ts";
import { BudgetsPane } from "./BudgetsPane.tsx";
import { EnginesPane } from "./engines/EnginesPane.tsx";
import { rendererPref, setRendererPref, type RendererPref } from "../lib/termRenderer.ts";
import { TERM_FONTS, CURSORS, fontAvailable, currentTermFont, currentTermSize, currentTermCursor, currentTermLineHeight, setTermFont, setTermSize, setTermCursor, setTermLineHeight, SIZE_MIN, SIZE_MAX, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_SIZE, DEFAULT_LINE_HEIGHT, type CursorStyle } from "../lib/termPrefs.ts";
import { focusFollowsMouse, setFocusFollowsMouse } from "../lib/termFocusPref.ts";
import { parseRules, setTabGroupsOn, tabGroupRulesText, tabGroupsOn } from "../lib/tabGroups.ts";
import { paneActionsMode, setPaneActionsMode, type PaneActionsMode } from "../lib/paneActionsPref.ts";
import { diffThemePref, setDiffThemePref, diffSplit, diffWrap, setDiffSplit, setDiffWrap, DEFAULT_SPLIT, DEFAULT_WRAP } from "../lib/diffPrefs.ts";
import {
  TASK_SOURCES, taskSourceShown,
  orderedTaskSources, moveTaskSource, resetTaskSourceOrder, type TaskSourceId,
} from "../lib/taskSources.ts";
import { taskLanding, type TaskLanding } from "../lib/taskLanding.ts";
import {
  SCROLLBACK_SIZES, DEFAULT_SCROLLBACK, DEFAULT_WORD_SEPARATORS,
  currentScrollback, currentWordSeparators, copyOnSelect, rightClickPaste, currentNoteEditor, NOTE_EDITORS, type NoteEditor,
  setScrollback, setCopyOnSelect, setRightClickPaste,
} from "../lib/termPrefs.ts";
import { canZoomIn, canZoomOut, fmtScale, DEFAULT_SCALE } from "../lib/uiScale.ts";
import { currentAccent, setAccentPref } from "../lib/accent.ts";
import { applyTheme } from "../lib/themes.ts";
import { setting, subscribeSettings } from "../lib/settingsRegistry.ts";
import { MOD_KEY } from "../lib/format.ts";
import { externalUrl } from "../lib/externalUrl.ts";
import type { UpdateStatus, ReleaseNotes, HookSetupStatus, BrowserUseStatus, LogDigest } from "../../../shared/types.ts";
import {
  sysNotifyMode, setSysNotifyMode, setSysNotifyOn, subscribeSysNotifyMode,
  notifyVoiceId, setNotifyVoice,
  notifyCapability, notifyQuiet, subscribeNotifyQuiet,
  appNotify, setAppNotify, subscribeAppNotify,
  type SysNotifyMode, type NotifyCapability,
} from "../lib/sysNotify.ts";
import { chatEnginePref, setChatEnginePref, type ChatEnginePref } from "../lib/chatEnginePref.ts";
import type { TmuxEngineInfo } from "../../../shared/types.ts";
import type { DepReport, DepStatus } from "../../../shared/deps.ts";
import { clock24, setClock24 } from "../lib/clockPref.ts";
import { setSplashOn, splashOn } from "../lib/splashPref.ts";
import { usageRefreshOn, setUsageRefreshOn } from "../lib/usageRefreshPref.ts";
import { paceConfig, setPaceConfig, subscribePaceConfig } from "../lib/paceConfig.ts";
import { hourLabel, type PaceConfig } from "../../../shared/pace.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { bindings, resetBindings, subscribeBindings, isCustomised, LABELS, DEFAULTS, type ActionId,
         chordFor, hasCustomChord, rebindChord, clearChord, resetChords, chordsCustomised, chordFromEvent, chordLabel,
         appChordFor, hasCustomAppChord, rebindAppChord, resetAppChords, appChordsCustomised,
         APP_CHORD_LABELS, APP_CHORD_DEFAULTS, type AppChordId } from "../lib/keybindings.ts";
import {
  loadRail, subscribeRail, moveView, resetRail, railIds, railCustomised, SHIPPED_RAIL,
  type RailPlace, type ViewId,
} from "./workspace/views.ts";
import { AppearancePane } from "./ThemePicker.tsx";
import { ShellConsole } from "./ShellConsole.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { HIT, ICON } from "../lib/iconSize.ts";
import { CheckboxIcon, ClockIcon, CrossIcon } from "../lib/glyphIcons.tsx";
import { ciOnlyApproved } from "../lib/ciNotifyPref.ts";
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
import { SELECT_BOX, EmptyState, Field, LinkButton, SettingsCard, SettingsForm, StatusBadge, helpIdFor, type StatusTone } from "./SettingsKit.tsx";
import { restoredNote } from "../lib/restoredNote.ts";

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

/**
 * A checklist as one card: a row per step, its verdict as a badge, the button
 * that fixes that step beside the badge, and "N of M done" at the head. Rows
 * that are not steps (a notice, a way back) go in as children.
 */
function SetupCard({ title, steps, note, error, actions, children }: {
  title: string; steps: SetupStep[]; note?: string | null; error?: string | null;
  actions?: React.ReactNode; children?: React.ReactNode;
}) {
  const known = steps.filter((s) => s.done !== null);
  const done = known.filter((s) => s.done).length;
  const all = known.length > 0 && done === known.length;
  return (
    <SettingsCard title={title} actions={actions}
      status={<StatusBadge tone={all ? "ok" : "off"}>{done} of {known.length} done</StatusBadge>}>
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
function SourceRow({ id, i, n, onChanged }: {
  id: TaskSourceId; i: number; n: number; onChanged: () => void;
}) {
  const s = TASK_SOURCES.find((x) => x.id === id);
  if (!s) return null;
  const on = taskSourceShown(id);
  return (
    <SettingRow settingId={`tasks.source.${id}`} label={s.label} hint={s.what}
      control={
        <span className="flex items-center gap-2.5 justify-self-end">
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
function Choice<T extends string>({ label, hint, value, options, onPick, disabled, disabledHint, modified, settingId }: {
  /** See SettingRow. */
  settingId?: string; agentExempt?: boolean; agentNever?: string;
  label: string; hint: string; value: T; options: { v: T; label: string }[];
  onPick: (v: T) => void; disabled?: boolean; disabledHint?: string; modified?: boolean;
}) {
  return (
    <SettingRow label={label} hint={disabled ? disabledHint ?? hint : hint} disabled={disabled} modified={modified} settingId={settingId}
      control={
        <span className="flex flex-wrap items-center gap-1 rounded-lg p-0.5 justify-self-end max-w-full"
          style={{ background: "color-mix(in srgb, var(--border) 28%, transparent)" }}>
          {options.map((o) => (
            <button key={o.v} onClick={() => onPick(o.v)} disabled={disabled}
              aria-pressed={value === o.v}
              className="text-[12px] px-2 h-6 inline-flex items-center rounded-md transition-colors disabled:cursor-not-allowed whitespace-nowrap"
              style={value === o.v
                ? { background: "var(--primary)", color: "var(--on-primary)" }
                : { color: "var(--text3)" }}>
              {o.label}
            </button>
          ))}
        </span>
      } />
  );
}

/** A −/value/+ stepper. A slider would imply the value is continuous and let
 *  you drag the window into a size the cockpit grid can't lay out; the ladder
 *  is short and every rung is one that works, so buttons say more. */
function Stepper({ label, hint, value, onDec, onInc, canDec, canInc, modified, settingId }: {
  /** See SettingRow. */
  settingId?: string; agentExempt?: boolean; agentNever?: string;
  label: string; hint: string; value: string; onDec: () => void; onInc: () => void; canDec: boolean; canInc: boolean;
  modified?: boolean;
}) {
  const btn = "w-7 h-7 rounded-md text-[14px] leading-none flex items-center justify-center disabled:opacity-30 enabled:hover:bg-white/10";
  const border = EDGE;
  return (
    <SettingRow label={label} hint={hint} modified={modified} settingId={settingId}
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

type Pane = "recipes" | "review-prompts" | "saved-replies" | "appearance" | "prefs" | "terminal" | "diff" | "tasks" | "privacy" | "notifications" | "browser" | "rail" | "keys" | "lantern" | "log" | "budgets" | "hooks" | "connections" | "engines" | "clickup" | "jira" | "tmux" | "remote" | "plugins" | "understudy" | "about" | "onboarding"
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
// Rendered in this order; a group with no matching tab is dropped, so search
// collapses to just the sections that still have something in them.
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
const TABS: { id: Pane; label: string; group: TabGroup; kw: string; what?: string; status?: boolean; icon: (p: { size?: number }) => React.ReactElement }[] = [
  // "sound" removed: it named the Notifications rows, not anything on this
  // page, and once pageScore reads a page's own rows a stray word in `kw`
  // only wins ties it should lose — "notification sound" now reaches
  // Notifications on the strength of its OWN rows, so Window does not need
  // to keep claiming a word it has nothing behind.
  { id: "prefs", label: "Window & startup", group: "General", kw: "display size zoom clock fullscreen start login launch animation splash preferences", what: "The window itself — size, fullscreen, the clock, and how it starts.", icon: SlidersIcon },
  { id: "appearance", label: "Appearance", group: "General", kw: "theme accent colour color font dark light mode palette", what: "Theme, accent and how dense the app is drawn.", icon: ThemeIcon },
  { id: "notifications", label: "Notifications", group: "General", kw: "notifications sound alert desktop notify quiet chime ping alert sounds message mirror this machine approved reminder alarm somebody says collect without interrupting only when pull request something much them agentglass keep what stopped interrupts muted mute unmute lantern silence none all", what: "What is allowed to interrupt you, and how.", icon: BellIcon },
  // Next to Shortcuts on purpose: which drawer a view sits in is what decides
  // whether it has a number, so the two pages answer one question between them.
  { id: "rail", label: "Sidebar", group: "General", kw: "rail sidebar views order icons hide show reorder tabs drawer group arrange", what: "Which views are on the sidebar, in which drawer, and in what order.", icon: SidebarIcon },
  { id: "keys", label: "Shortcuts", group: "General", kw: "keyboard keys bindings shortcut chord rebind reset to defaults columns some others", what: "Every binding, rebindable.", icon: KeyboardIcon },
  { id: "terminal", label: "Terminal", group: "Workspace", kw: "terminal font size cursor typography monospace face renderer gpu focus follows mouse hover pane sloppy scrollback copy on select right-click paste line height tab tabs group groups grouping project name rules prefix runs on engine own tmux shell", what: "Type, renderer, mouse, tab groups, how much scrollback each shell keeps, and what a Terminal opens on.", icon: TerminalIcon },
  { id: "diff", label: "Diff", group: "Workspace", kw: "diff split side by side inline unified wrap word wrap changes review default view wrap long lines syntax theme colours", what: "How a diff opens, everywhere the app shows one.", icon: DiffIcon },
  // Only where there is a browser to configure. A settings tab for something
  // that is not there reads as a broken feature rather than one that doesn't apply.
  // ONE browser page.
  //
  // This was two — "Browser" for the home page and "Agent browser" for
  // everything else, including the login importer. Nobody looking for their
  // logins looks under a heading about agents, and the browser's own menu sent
  // people to the wrong one of the two because I picked the obvious name. A
  // setting is filed under the thing it configures.
  ...(HAS_BROWSER ? [{ id: "browser" as const, label: "Browser", group: "Workspace" as const, kw: "browser web page zoom login cookies import chrome firefox zen profile home search engine", what: "The built-in browser: how it opens, and the logins it borrows.", icon: BrowserIcon }] : []),
  { id: "tasks", label: "Tasks", group: "Workspace", kw: "tasks sources github issues local taskwarrior clickup hide show providers view opens on", what: "Which sources the Tasks view offers you.", icon: ChecklistIcon },
  { id: "hooks", label: "Agents", group: "Agents", kw: "agents hooks claude code install setup worker roles scout builder verifier lock model opencode qwen how new chats run warm panes browser agent skill drive", what: "Wire Claude Code into this app, how new chats run, whether an agent can drive the browser, what else is installed, and which CLI each worker role runs on.", icon: PlugIcon },
  { id: "engines", label: "Agent engines", group: "Agents", kw: "engine engines provider hermes opencode codex gemini antigravity claude model version minimum signed in sign-in login orchestrator worker role ready test recheck installed update reporting connect events", what: "Which agent CLIs this computer has, whether each is recent enough and signed in, and what each can do here.", icon: PlugIcon },
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
  { id: "clickup", label: "ClickUp", group: "Connections", kw: "clickup workflow map steps statuses cards tracker hand off qa review menu merge dialog note assigned people sprint swatch spaces subtasks pull request link", what: "How agentglass uses your ClickUp: the steps you add, tied to your own statuses.", icon: ChecklistIcon },
  /* Always there, unlike ClickUp's: the form that connects Jira lives on this page. */
  { id: "jira", label: "Jira", group: "Connections", kw: "jira atlassian cloud data center site token email personal access token writes changes projects keys prefixes hand off qa assignee status saved views folders board filter tracker connect disconnect", what: "Your Jira site, what agentglass may change there, and the hand-off to QA.", icon: ChecklistIcon },
  { id: "remote", label: "Remote", group: "Connections", kw: "remote access pair phone tailscale token device", what: "Reach this machine from your phone.", icon: PhoneIcon },
  /* Filed beside Remote rather than under Agents: a plugin is
     someone else's code holding a scoped credential to this server, the
     same trust shape a paired device has — install, review what it
     declares, grant it, take it back. It is not an agent and it renders
     nothing of its own; see the note at the top of server/src/plugins.ts. */
  { id: "plugins", label: "Plugins", group: "Connections", kw: "plugins install extension manifest scope review approve enable disable remove entrypoint publisher source running pid re-consent reconsent", what: "Install, review and switch on someone else's code — and see whether it is actually running.", icon: PuzzleIcon },
  /* Its own section, not a block inside Tools & services: it is the engine
     every pane and every chat runs on, with a binary, a config and a restore of
     its own — three settings deep is not a row in a list of "is it installed". */
  { id: "tmux", label: "Pane engine (tmux)", group: "System", kw: "tmux panes engine pane prefix key binary bundled config override restore reboot layout resume socket status bar chat warm cli claude", what: "What a pane runs on — the tmux binary, its config and prefix, and restore.", icon: PanesIcon },
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
function BrowserPane() {
  const [home, setHome] = useState(homePageRaw);
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
    setBad(false);
    setSaved(true);
  };

  return (
    <SettingsCard title="Where it opens"
      desc="The pages the browser view opens on its own. Everything else — what you have logged into, what you have open — belongs to the page, not to a setting.">
      <SettingRow
        agentNever="a page the browser opens by itself, with the owner's signed-in sessions: not something an agent points elsewhere"
        label="Home page"
        hint="Where the view opens, and where Home goes. Leave it empty for a blank page."
        below={<>
          <div className="flex items-center gap-2 max-w-[480px]">
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
  );
}

const PLACE_LABEL: Record<RailPlace, string> = { work: "Top group", utility: "Bottom group", hidden: "Hidden" };
const PLACE_NOTE: Record<RailPlace, string> = {
  work: "Where you work. The only group the numbers count through — ⌘1 to ⌘9, in this order.",
  utility: "What you go and look at, down with settings and ports. No numbers here; record a combination on the Shortcuts page if one of these needs a key.",
  hidden: "Off the rail. Nothing is lost — put one back from here, or from the + at the foot of the rail.",
};

/**
 * The rail's layout, in a list.
 *
 * The rail itself is the fast way to do this — pick an icon up and drop it
 * where you want it — but a drag is a poor way to say "and this one I never
 * want to see again", it is unavailable to anyone not using a mouse, and it
 * cannot show you the thing that actually changes when you move a view between
 * groups: its number. So the same three drawers, spelled out, with the key each
 * row currently answers to written next to it.
 */
function RailPane() {
  const rail = useSyncExternalStore(subscribeRail, loadRail, () => SHIPPED_RAIL);
  /** Which view is being dragged, and where it would land. Held here rather
   *  than per row: a drop target has to know what is coming. */
  const [drag, setDrag] = useState<{ id: ViewId; from: RailPlace } | null>(null);

  return (
    <>
      {/* The page's own words first, then one card per drawer. The drawers were
          eyebrows inside one card, each with a line either side of it; a card
          each gives the three of them a name and an edge, and the divider
          falls only between two views. */}
      <SettingsCard title="What is on the rail"
        desc="Which views get an icon, and whether they sit at the top or the bottom of it.">
        <SettingRow
          agentExempt
          label="On the rail itself"
          hint={<><b style={{ color: "var(--text2)" }}>Drag</b> an icon between the groups — a gap opens where it will land — or drop it on the dashed square at the bottom to put it away. <b style={{ color: "var(--text2)" }}>Right-click</b> any icon for the same moves, and <b style={{ color: "var(--text2)" }}>Alt+↑/↓</b> does it from the keyboard.</>}
          actions={railCustomised() ? <Button onClick={resetRail}>Reset the rail</Button> : undefined}
        />
      </SettingsCard>

      {/* Twenty views, three drawers, a few controls each: the one thing that
          makes this readable is that the controls of every view land on the
          same lines, and that is what the row grid is for. The icon rides in
          the label — a column of its own for 20px is how this page ended up
          drawing to a different left edge than the rest of the dialog. */}
      {(Object.keys(PLACE_LABEL) as RailPlace[]).map((place) => (
        <SettingsCard key={place} title={PLACE_LABEL[place]} desc={PLACE_NOTE[place]}>
          {rail[place].length === 0 ? (
            <EmptyState>
              {place === "hidden" ? "Nothing put away." : "Empty — drag something here, or use the buttons on the right."}
            </EmptyState>
          ) : rail[place].map((v, i) => {
            const Icon = v.icon;
            const chord = chordFor(v.id);
            return (
              /*
               * Drag to reorder, a select for the drawer.
               *
               * The arrows are still here and still work — they are the only
               * way to do this from a keyboard — but they no longer occupy the
               * row when nobody is looking at it. Hover or focus brings them
               * back, which is the trade the design was drawn with.
               *
               * The drag handlers ride on the row itself (`rowProps`), not on
               * a div around it: a wrapper takes the row out of the card body
               * and its divider with it.
               */
              <SettingRow key={v.id}
                rowProps={{
                  draggable: true,
                  onDragStart: (e) => { setDrag({ id: v.id, from: place }); e.dataTransfer.effectAllowed = "move"; },
                  onDragEnd: () => setDrag(null),
                  onDragOver: (e) => { if (drag && drag.id !== v.id) e.preventDefault(); },
                  onDrop: (e) => {
                    e.preventDefault();
                    if (!drag || drag.id === v.id) return;
                    // Dropped ONTO a row means "take its place", which is the
                    // only reading that needs no insertion line to explain it.
                    moveView(drag.id, place, i);
                    setDrag(null);
                  },
                  style: { opacity: drag?.id === v.id ? 0.4 : 1, cursor: "grab" },
                }}
                settingId={`rail.place.${v.id}`}
                label={<span className="flex items-center gap-2.5 min-w-0">
                  <span className="shrink-0 select-none" style={{ color: "var(--text4)" }} aria-hidden title="Drag to reorder">⠿</span>
                  <span className="shrink-0 grid place-items-center w-5" style={{ color: "var(--text2)" }}><Icon size={ICON.md} /></span>
                  <span className="min-w-0">{v.label}</span>
                </span>}
                hint={<span className="block pl-[30px]">{v.hint}</span>}
                /*
                 * Two controls, not five.
                 *
                 * Eleven views times a chord, two arrows and a three-way chip
                 * is fifty-five things to hit on one page. The drawer is a
                 * choice between three named places, which is what a select is
                 * for; the arrows stay, because reordering is the other half of
                 * the page and a select cannot express "one higher".
                 */
                control={<span className="flex items-center gap-2">
                  {/* A link, not a second recorder: the chord is rebound on the
                      Shortcuts page, and this lands on that view's row. */}
                  <button type="button" onClick={() => openSettings("keys", rowId(LABELS[`view.${v.id}`].label))}
                    title="Change this shortcut on the Shortcuts page"
                    className="text-[11px] tabular-nums w-[52px] text-right hover:underline"
                    style={{ color: chord ? "var(--text2)" : undefined, opacity: chord ? 0.75 : 0.35 }}>
                    {chord ? chordLabel(chord) : "—"}
                  </button>
                  {/* Order only matters where the rail draws it, and in the top
                      group it also decides which number you get. Kept out of
                      sight until wanted: `agx-reveal` is opacity-only, so the
                      row does not change width when they appear. */}
                  <span className="agx-reveal flex items-center gap-0.5 w-[54px]">
                    {place !== "hidden" && (
                      <>
                        <MiniBtn agentExempt label="Move up" disabled={i === 0} onClick={() => moveView(v.id, place, i - 1)}>↑</MiniBtn>
                        <MiniBtn agentExempt label="Move down" disabled={i === rail[place].length - 1} onClick={() => moveView(v.id, place, i + 1)}>↓</MiniBtn>
                      </>
                    )}
                  </span>
                  <Select
                    align="right"
                    value={place}
                    onChange={(p) => setting(`rail.place.${v.id}`).set(p)}
                    options={(Object.keys(PLACE_LABEL) as RailPlace[]).map((p) => ({
                      value: p,
                      label: p === "work" ? "Top" : p === "utility" ? "Bottom" : "Hidden",
                      hint: PLACE_LABEL[p],
                    }))}
                  />
                </span>}
              />
            );
          })}
        </SettingsCard>
      ))}
    </>
  );
}

function MiniBtn({ label, disabled, onClick, children }: { settingId?: string; agentExempt?: boolean; label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className="grid place-items-center rounded-md text-[11px] hover:bg-white/10"
      style={{ width: HIT, height: HIT, color: "var(--text2)", opacity: disabled ? 0.25 : 0.8 }}>
      {children}
    </button>
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
/** Panes whose content is a grid of cards, not a column of rows. */
const WIDE_PANES = new Map<string, string>([
  ["plugins", "1180px"],
  /* The workflow map is a column of step cards beside a column of statuses, with the lines running between them; this is the width that keeps a card's header on two lines. */
  ["clickup", "1100px"],
]);

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The hours a plan's weekly budget is spread over. See shared/pace.ts. */
function PacePane() {
  const cfg = useSyncExternalStore(subscribePaceConfig, paceConfig, paceConfig);
  const working = cfg.spread === "working";
  return (
    <SettingsCard title="Plan pace">
      <Choice<PaceConfig["spread"]>
        label="Spread the week's budget over"
        hint="Working hours earn the budget, so the pace marker holds still overnight and at weekends. Every hour is a straight line across the week."
        value={cfg.spread}
        onPick={(spread) => setPaceConfig({ spread })}
        options={[{ v: "working", label: "Working hours" }, { v: "all", label: "Every hour" }]} />
      <SettingRow label="Working days" disabled={!working}
        hint={working && !cfg.workDays.some(Boolean) ? "None ticked: every hour counts, as if Every hour were chosen." : "Days that earn budget."}
        control={
          <span className="flex flex-wrap items-center gap-1 justify-self-end max-w-full">
            {DAY_NAMES.map((d, i) => (
              <button key={d} disabled={!working} aria-pressed={cfg.workDays[i]}
                onClick={() => setPaceConfig({ workDays: cfg.workDays.map((x, j) => (j === i ? !x : x)) })}
                className="text-[11px] px-1.5 py-1 rounded-md disabled:cursor-not-allowed"
                style={cfg.workDays[i]
                  ? { background: "var(--primary)", color: "var(--on-primary)" }
                  : { color: "var(--text3)" }}>
                {d}
              </button>
            ))}
          </span>
        } />
      <Stepper label="Work starts" hint="Hour the day begins earning budget"
        value={hourLabel(cfg.workStart)} canDec={working && cfg.workStart > 0} canInc={working && cfg.workStart < cfg.workEnd - 1}
        onDec={() => setPaceConfig({ workStart: cfg.workStart - 1 })} onInc={() => setPaceConfig({ workStart: cfg.workStart + 1 })} />
      <Stepper label="Work ends" hint="Hour it stops"
        value={hourLabel(cfg.workEnd)} canDec={working && cfg.workEnd > cfg.workStart + 1} canInc={working && cfg.workEnd < 24}
        onDec={() => setPaceConfig({ workEnd: cfg.workEnd - 1 })} onInc={() => setPaceConfig({ workEnd: cfg.workEnd + 1 })} />
      <Toggle on={cfg.rollover} onClick={() => setPaceConfig({ rollover: !cfg.rollover })}
        label="Roll unused share forward"
        hint="Room left over from earlier today may be spent later, up to one extra day's share. Off, a day's share is a hard cap." />
      <Choice<"1" | "3" | "6">
        label="Recent burn looks back"
        hint="How far back the runs-out projection measures your speed"
        value={String(cfg.burnWindowHours) as "1" | "3" | "6"}
        onPick={(v) => setPaceConfig({ burnWindowHours: Number(v) })}
        options={[{ v: "1", label: "1h" }, { v: "3", label: "3h" }, { v: "6", label: "6h" }]} />
      <Choice<"80" | "90" | "95">
        label="Alert when a weekly window reaches"
        hint="One notification per window, and only while Usage is on under Notifications (off by default)"
        value={String(cfg.alertAt) as "80" | "90" | "95"}
        onPick={(v) => setPaceConfig({ alertAt: Number(v) })}
        options={[{ v: "80", label: "80%" }, { v: "90", label: "90%" }, { v: "95", label: "95%" }]} />
    </SettingsCard>
  );
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

/**
 * One rebindable shortcut.
 *
 * Capturing is a mode rather than a text field: you press the key you want,
 * which is the only input method that cannot disagree with what will actually
 * fire. `keydown` on the window during capture, so the key never reaches the
 * app's own handler and rebinding `t` does not also open the terminal.
 */
function KeyRow({ id, keyName, capturing, onCapture, error, chord }: {
  id: ActionId; keyName: string; capturing: boolean; onCapture: () => void; error: string | null;
  /** Present only for workspace views, which are the ones reachable from
   *  inside the workspace and so the ones that need a modified key too. */
  chord?: { key: string; custom: boolean; capturing: boolean; onCapture: () => void; onClear: () => void };
}) {
  const { label, hint } = LABELS[id];
  return (
    <SettingRow settingId={`keys.binding.${id}`}
      /* Its own track: this row's control is genuinely two controls, each with
         its own label. 300 rather than the shared 210 — and because the row
         still ends at the column's edge, the chips line up with every other
         pane's control anyway, which is the 288px jump this used to have. */
      label={<span onClick={onCapture} className="cursor-pointer">{label}</span>}
      hint={<span style={{ color: error ? "var(--error)" : undefined }} className={error ? "" : "t-dim"}>{error ?? hint}</span>}
      control={<span className="flex items-center gap-1.5 justify-self-end">
      {/* Two keys, labelled, because they answer different questions and the
          unlabelled pair read as one shortcut written twice. */}
      {chord && (
        <span className="shrink-0 flex items-center gap-1.5">
          <span className="text-[11px] t-dim w-[52px] text-right">anywhere</span>
          <button onClick={chord.onCapture}
            // An empty key is a view outside the top group, where numbers do
            // not reach. Still clickable: recording one is exactly how you give
            // a bottom-drawer or hidden view a key of its own.
            title={chord.custom
              ? `${chordLabel(chord.key)} opens this — click to record another, or the cross to go back to its rail position`
              : chord.key
                ? `${chordLabel(chord.key)} opens this, from its position in the top group — click to record your own`
                : "Only the top group is numbered — click to record a combination for this one"}
            className="chip h-[22px] justify-center text-[11px] tabular-nums min-w-[74px] text-center"
            style={chord.capturing
              ? { color: "var(--primary-hover)", borderColor: "color-mix(in srgb, var(--primary) 60%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }
              : chord.custom
                ? { color: "var(--primary-hover)" }
                : { color: "var(--text2)", opacity: 0.6 }}>
            {chord.capturing ? "Hold a combo…" : chord.key ? chordLabel(chord.key) : "—"}
          </button>
          <span className="w-3 shrink-0">
            {chord.custom && !chord.capturing && (
              <CloseButton onClick={chord.onClear} title="Back to its position in the rail" />
            )}
          </span>
        </span>
      )}
      <span className="shrink-0 flex items-center gap-1.5">
        <span className="text-[11px] t-dim w-[62px] text-right">{chord ? "dashboard" : "press"}</span>
        <button onClick={onCapture} className="chip h-[22px] justify-center text-[11px] tabular-nums min-w-[74px] text-center"
          style={capturing
            ? { color: "var(--primary-hover)", borderColor: "color-mix(in srgb, var(--primary) 60%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }
            : { color: "var(--text2)" }}>
          {capturing ? "Press a key…" : keyName === " " ? "space" : keyName}
        </button>
      </span>
      </span>} />
  );
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
        <SettingRow label="Nothing yet"
          hint="Every write this dashboard performs — staging, discarding, pushing, merging, container actions, gate decisions — is recorded here as it happens." />
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
          hint="These are the changes you made, not telemetry. Held tool calls appear here whoever resolved them, including the ones the timeout decided while nobody was looking." />
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
      {activityDays(rows).map(({ day, runs }) => (
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
function UnderstudyPane({ open, onLeave }: { open: boolean; onLeave: () => void }) {
  const frame = useUnderstudy();
  const [err, setErr] = useState<string | null>(null);

  // The switch has to show the server's answer, not this dialog's guess: it is
  // refused outright when the server has no auth token (there would be no
  // principal to hold the understudy to its allowlist), and a toggle that
  // flipped anyway would be lying about the only thing it says.
  useEffect(() => { if (open) void refreshUnderstudy(); }, [open]);

  const on = !!frame?.enabled;
  return (
    <>
      {/*
       * WHAT IT LEARNS FROM, first — because that is what this page is for now.
       *
       * This used to be the Clone's settings page, under the Clone's view, and
       * the consent list lived in the view rather than here. The view is gone
       * and the bank it filled became the orchestrator's memory, so the thing
       * that decides what the orchestrator knows about you belongs on a
       * settings page and not behind a tab in a scoreboard.
       */}
      <Teach active={open} />
      <SettingsCard title="Keeping score">
        <Toggle
          label="Let the clone watch"
          hint={frame?.halted
            ? "Halted — it is enabled and stopped. Switching it on again is what lowers the fence; there is no timer."
            : "Separate from the knowledge above, and off is a reasonable answer: this writes down what a stand-in would have done and scores it against what you did. Reading the bank does not depend on it — the orchestrator remembers you either way."}
          on={on}
          onClick={() => {
            void setUnderstudyEnabled(!on).then((r) => {
              setErr(r.ok ? null : r.error ?? "that did not work");
              void refreshUnderstudy();
            });
          }} />
        {err && <div role="alert" className="agx-settings-x pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
      </SettingsCard>
      <UnderstudyLook classes={frame?.classes ?? []} />
      <SettingsCard title="What it keeps">
        <Row label={`Sealed situations — ${RETENTION.snapshotDays} days`}
          hint="The material it read, kept only long enough to check a prediction against it. Swept on a fixed window of its own, deliberately not on the events retention you set: turning that off must not silently turn this off too." />
        <Row label={`The fact of a write — ${RETENTION.stubDays} days`}
          hint="Route, method and how it answered. Never the request body — there is no column for one." />
        <Row label="The score — kept"
          hint="Decisions and refusals do not expire. They are the score, and a score with holes in it is not a score." />
      </SettingsCard>
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
  return (
    <SettingsCard title="Server log" desc={desc} fold={{ open, onToggle: setOpen }}>
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
      .then((r) => { ingestUpdate(r); if (live) { setSt(r); setStErr(null); } })
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

  if (stErr) return (
    <SettingsCard title="This build"
      desc="Which version is running, and whether a newer one is out.">
      <SettingRow label="Could not read this build's version"
        status={<StatusBadge tone="err">Unavailable</StatusBadge>}
        hint={<span className="break-all">{stErr}</span>} />
    </SettingsCard>
  );
  if (!st) return (
    <SettingsCard title="This build" desc="Which version is running, and whether a newer one is out.">
      <SettingRow label="Reading version…" status={<StatusBadge tone="checking">Checking</StatusBadge>} />
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
  return (
    <>
    <SettingsCard title="This build"
      desc="Which version is running, and whether a newer one is out.">
      {/* The build you are running, as a row like any other: what it is on the
          left, and the one thing you can do about it on the right. The notes
          used to appear once, on the launch after an update, and were
          unreachable ever after — dismiss it, or update before it existed, and
          the only copy was on the release page. */}
      <SettingRow
        label={`agentglass ${st.info.version}`}
        hint={<>
          <span
            className="tabular-nums"
            title={dirty
              ? `built from an uncommitted tree — ${st.info.dirtyCount} packaged file(s) differ from ${st.info.commit.slice(0, 7)}`
              : st.info.commit}
            style={dirty ? { color: "var(--warning-ink)", fontWeight: 600 } : undefined}>
            {short}
          </span>
          {st.info.builtAt && <> · built {new Date(st.info.builtAt).toLocaleString()}</>}
        </>}
        actions={mine
          ? <Button tone="primary" onClick={() => setWant(mine)}>Release notes</Button>
          : undefined}
      />

      {/* Said in words, because the stamp alone is only obvious once you know
          the convention. The file list is the answer to the question that had
          no answer today — "whose uncommitted work is in the app I am running"
          — and it is absent outside the desktop shell on purpose. */}
      {dirty && (
        <SettingRow
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
        <SettingRow
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
        <SettingRow label="Updating"
          status={<StatusBadge tone="checking">In progress</StatusBadge>}
          hint="The app will close and reopen on its own — this window going away is the update working, not crashing." />
      ) : st.blocked ? (
        <SettingRow label="Updating is blocked"
          status={<StatusBadge tone="warn">Blocked</StatusBadge>}
          hint={st.blocked} />
      ) : st.behind === 0 ? (
        <SettingRow label="Up to date"
          status={<StatusBadge tone="ok">Current</StatusBadge>}
          hint={st.branch ? `${st.branch} is the newest release.` : undefined} />
      ) : (
        <>
          <SettingRow
            label={`${st.branch} is available`}
            status={<StatusBadge tone="warn">Update available</StatusBadge>}
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
          <SettingRow
            label="Built on your machine from source"
            hint={<>Needs <span style={{ color: "var(--warning-ink)" }}>git</span> and <span style={{ color: "var(--warning-ink)" }}>bun</span> installed, and is Linux-only for now.</>}
            detail={{
              summary: "How the update is built",
              body: "Compiles the tagged release in its own clone under ~/.cache, then reinstalls and restarts. Your working checkout is never touched, and only published tags are ever offered — commits pushed after a tag stay out until you tag them.",
            }}
          />
        </>
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
  return (
    <SettingsCard title="Credits">
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
  const [filter, setFilter] = useState("");
  // What rides along with the cookies. Read from the stored prefs so a choice
  // sticks between imports; default ON, so leaving them alone brings everything
  // as it always did.
  const [wantHistory, setWantHistory] = useState(importHistory());
  const [wantBookmarks, setWantBookmarks] = useState(importBookmarks());

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

  if (!CAN_IMPORT_COOKIES) return null;

  const view = siteView(current?.sites ?? [], filter);
  const total = current?.sites.length ?? 0;

  const run = async (kind: "import" | "forget") => {
    const sites = [...chosen];
    if (!sites.length) return;
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
    <SettingsCard title="Your logins"
      desc="Bring the cookies over from another browser, so pages behind a login work here."
      actions={current?.readable ? (
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
      <SettingRow agentExempt label="Import from" hint={sourceHint}
        detail={{
          summary: "Why cookies, and what comes across",
          body: <>
            A password manager cannot run in this browser (Electron has no place to put its popup), so the way pages
            behind a login work here is bringing the cookies over. Chrome, Firefox, Zen, Brave and Chromium, including
            the Chrome-family ones whose values are sealed: their key is asked of your desktop keyring. Everything is
            chosen to start with; untick what you would rather leave behind. Anyone who can use this window —
            including an agent driving it — will be signed in to whatever comes across.
          </>,
        }}
        control={sources?.length ? (
          <span className="flex justify-end">
            <Select align="right" value={pick} onChange={setPick}
              options={sources.filter(reachable).map((s) => ({ value: s.id, label: `${s.label}${s.readable ? ` · ${s.sites.length}` : " · locked"}` }))} />
          </span>
        ) : undefined}
        below={current && !current.readable ? (
          <div className="text-[12px]" role="note" style={{ color: "var(--warning-ink)" }}>{lockedWhy(current)}</div>
        ) : undefined} />

      {current?.readable && (
        <SettingRow agentExempt label="Sites"
          hint={`${chosen.size} of ${total} chosen. Everything is chosen to start with; untick what you would rather leave behind.`}
          control={<span className="flex gap-2 justify-end">
            <Bulk text="All" onClick={() => setChosen(allSites(current.sites))} off={chosen.size === total} />
            <Bulk text="None" onClick={() => setChosen(new Set())} off={!chosen.size} />
          </span>}
          below={
            <div className="flex flex-col gap-2">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sites…" aria-label="Filter sites"
                className={`w-full max-w-[480px] ${INPUT}`}
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
            hint="The pages you bookmarked, ranked first in the address bar. Cookies are chosen per site above." />
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

  if (!st) return <SettingsCard title="Agent browser use"><EmptyState>Reading…</EmptyState></SettingsCard>;

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
      title="Agent browser use"
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

function HooksPane({ open }: { open: boolean }) {
  const [st, setSt] = useState<HookSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
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

  if (!st) return <SettingsCard title="Claude Code hooks"><EmptyState>Reading hook state…</EmptyState></SettingsCard>;

  if (!st.bundled) {
    return (
      <SettingsCard title="Claude Code hooks">
        <SettingRow label="The hook scripts are not in this build"
          hint={<>This build does not carry the hook scripts, so there is nothing to wire. Install from a Release, or run <span className="t-mono">bun run setup</span> in a checkout.</>}
          status={<StatusBadge tone="warn">Not included</StatusBadge>} />
      </SettingsCard>
    );
  }

  return (
    <>
      {/* The last step is one only you can take, and there is no way from
          here to see whether you have. It says so and stays out of the count,
          rather than sitting there permanently unticked. */}
      <SetupCard
        title="Claude Code hooks"
        error={err}
        note={note}
        steps={[
          { title: "Hook scripts in this build", done: st.bundled, says: { done: "Included" },
            detail: "Shipped with the app — nothing to fetch." },
          { title: "Wired into Claude Code", done: st.installed, says: { done: "Wired", todo: "Not wired" },
            detail: <>Written to <span className="t-mono text-[11px]" style={{ color: "var(--text)" }}>{st.settingsPath}</span>, run under <span className="t-mono text-[11px]">{st.python}</span>.</>,
            /* What the checklist is FOR, read once, so it sits behind a
               summary that says what it holds. */
            more: {
              summary: "What wiring this changes",
              body: <>
                Every Claude Code session streams here live — what ran, what it
                cost, when it stopped for you. It watches; it never stops a tool
                call, and its command ends in <span className="t-mono text-[11px]">|| exit 0</span> so that stays true
                even if the script goes missing. Holding calls is the gate below, which is a separate switch.
                It edits <span className="t-mono text-[11px]" style={{ color: "var(--text)" }}>{st.settingsPath}</span>,
                backing it up first, and leaves your other hooks untouched.
              </>,
            },
            action: st.installed
              ? { label: busy ? "Disabling…" : "Disable hooks", onClick: () => void act("uninstall"), busy, tone: "danger" }
              : { label: busy ? "Enabling…" : "Enable", onClick: () => void act("install"), busy } },
          { title: "Start a fresh Claude Code session", done: null,
            detail: "Sessions already running keep the hooks they started with." },
        ]}>
        {/* The forwarder is a python script; the install writes the command
            but cannot make an interpreter appear. Said up front rather than
            left to a session that streams nothing and no error anywhere. */}
        <SettingRow label="Python on your PATH"
          hint={<>The hooks run under <span className="t-mono">{st.python}</span> — it has to be on your PATH for events to arrive. Takes effect on the next Claude Code session; hooks load at startup.</>} />
        <SettingRow label="Taking it back out"
          hint={<>Reversible any time from here, or with <span className="t-mono">python3 hooks/install_hooks.py --uninstall</span> in a checkout. Global (<span className="t-mono">~/.claude</span>), so it covers every project.</>} />
      </SetupCard>

      {/* The gate. Its own card, below the forwarder, because it is the
          stronger thing and read second for the same reason. */}
      <SettingsCard title="Gate" desc="Holds an outward action until somebody decides. A separate switch from the hooks above.">
        <SettingRow label="Hold what leaves this machine"
          hint={<>
            A push, a pull request, a comment, a review, a merge, a ticket or a message in a channel
            waits here with the text it would send, and nobody answering means it does not happen.
            Everything local — writing code, running tests, cutting a worktree — is never held.
            <span className="block mt-1">Until you turn this on, that line is held by each agent remembering it.</span>
          </>}
          status={<StatusBadge tone={!st.gateBundled ? "off" : st.gate ? "ok" : "off"}>{!st.gateBundled ? "Not in this build" : st.gate ? "On" : "Off"}</StatusBadge>}
          actions={st.gateBundled
            ? <Button tone={st.gate ? "danger" : "primary"} disabled={busy} onClick={() => void gate(!st.gate)}>
                {busy ? "Working…" : st.gate ? "Turn the gate off" : "Turn the gate on"}
              </Button>
            : undefined} />
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
  return (
    <SettingsCard title="Lantern"
      desc="What the Lantern (the rail's lantern icon) may ask of a session. It never starts, stops or queues anything; this is the one thing it says to an agent.">
      {err && <div role="alert" className="agx-settings-x pt-2 pb-3 text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
      <Toggle on={nudge} onClick={() => save({ nudge: !nudge })}
        label="Ask sessions what they are working on"
        hint="On a prompt, a hooked session may be handed one line asking it to post its task (POST /agents/status). Off, and the Lantern lists sessions by name and pane only." />
      <Choice label="How often one session may be asked again" value={near}
        hint="A session that has already answered is left alone for this long, whatever name it chose."
        options={STEPS.map((m) => ({ v: String(m), label: `${m} min` }))}
        onPick={(m) => save({ minutes: Number(m) })} disabled={!nudge}
        disabledHint="Nothing is asked while the reminder is off." />
      <Toggle on={watch} onClick={() => save({ watch: !watch })}
        label="Watch the agents and notify me"
        hint="Every few minutes the agents are re-read and one notification goes out — the app's bell, the phone when paired, the desktop otherwise — if somebody is still stopped on you, a worker's window vanished, or work that was claimed has gone quiet for an hour. The instant alerts stay either way; this is the sweep behind them." />
      <Choice label="How often it looks" value={nearWatch}
        hint="One notification per look at most, while something needs you."
        options={WATCH_STEPS.map((m) => ({ v: String(m), label: `${m} min` }))}
        onPick={(m) => save({ watchMinutes: Number(m) })} disabled={!watch}
        disabledHint="Nothing is looked at while the watch is off." />
      {/* The seat's floor lives here because it rides the same look: the watch
          re-reads the field, and the orchestrator is prompted only when what
          it found CHANGED. This is how long a quiet field may stay quiet
          before it gets a line anyway. */}
      <Choice label="Wake the orchestrator at least every" value={String(seatWake)}
        hint="The seat is woken when the field changes. This is the floor under that, so a quiet day still gets a line rather than a silence you cannot tell from a dead agent."
        options={[1, 2, 4, 8, 12, 24].map((h) => ({ v: String(h), label: h === 1 ? "1 hour" : `${h} hours` }))}
        onPick={(h) => { void api.seatWakeSave(Number(h)).then(() => setSeatWake(Number(h))); }} />
      <Choice label="How long the prompt cache stays warm" value={String(cacheTtl === 60 ? 60 : 5)}
        hint="Each card counts it down from the session's last turn: a turn sent while it is warm is the cheap one. Five minutes on most plans; an hour on some."
        options={[{ v: "5", label: "5 min" }, { v: "60", label: "1 hour" }]}
        onPick={(m) => save({ cacheTtlMinutes: Number(m) })} />
      {note && <div role="status" className="agx-settings-x pt-2 pb-3 text-[11px]" style={{ color: "var(--text3)" }}>{note}</div>}
    </SettingsCard>
  );
}

/**
 * WORKER ROLES — which CLI and model each context-diet role runs on.
 *
 * One row per role: the CLI (only the ones with a lock, since a role on any
 * other would be refused at start) and a model handed to it as it is. A CLI
 * that is offered but not installed says so rather than disappearing, so a
 * choice made on another machine still reads.
 */
function WorkerRolesSection({ open }: { open: boolean }) {
  type Choice = { provider: string; model: string };
  const [roles, setRoles] = useState<Record<string, Choice>>({});
  const [clis, setClis] = useState<{ id: string; title: string; installed: boolean }[]>([]);
  const [models, setModels] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const take = (r: { roles?: Record<string, Choice> }) => {
    if (!r.roles) return;
    setRoles(r.roles);
    setModels(Object.fromEntries(Object.entries(r.roles).map(([k, v]) => [k, v.model])));
  };
  useEffect(() => {
    if (!open) return;
    void api.workerRoles().then((r) => { take(r); setClis(r.providers ?? []); })
      .catch(() => setNote("Could not reach the server — the worker roles are unavailable."));
  }, [open]);
  const save = (role: string, c: Choice) => {
    setNote(null);
    void api.workerRoleSave(role, c.provider, c.model)
      .then((r) => { if (!r.ok) setNote(r.error ?? "Could not save."); else { take(r); setNote("Saved. Applies to the next worker started in that role."); } })
      .catch(() => setNote("Could not save."));
  };
  return (
    <SettingsCard title="Worker roles"
      desc="Which CLI and model a worker started in a role runs on (agentglass-agent start --role). Every role is locked against push, commit, merge and the network clients, in a layer the project's own config cannot loosen (OpenCode's is checked against the project's config at each start, and refused if loosened); a CLI with no such lock is not offered.">
      {WORKER_ROLES.map((r) => {
        const c = roles[r.id];
        if (!c) return null;
        const mid = `role-model-${r.id}`;
        return (
          <SettingRow key={r.id} label={r.title}
            hint={`${r.what}${r.readOnly ? " File edits are refused too." : ""} Default: ${r.default.provider}, ${r.default.model}.`}
            control={
              <Select value={c.provider} align="right"
                className="rounded-lg px-2 py-1 text-[11px] outline-none w-[128px] justify-between"
                options={clis.map((p) => ({ value: p.id, label: p.installed ? p.title : `${p.title} (not installed)` }))}
                onChange={(v) => save(r.id, { provider: v, model: "" })} />}
            /* The model is a text field, so it stacks under the description
               rather than sharing the control column with the CLI choice. */
            below={
              <div className="agx-sform">
                <Field label="Model" htmlFor={mid} help="Handed to the CLI as typed. Empty runs its default model.">
                  <input id={mid}
                    value={models[r.id] ?? ""}
                    onChange={(e) => setModels((m) => ({ ...m, [r.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(r.id, { provider: c.provider, model: models[r.id] ?? "" }); } }}
                    onBlur={() => { if ((models[r.id] ?? "") !== c.model) save(r.id, { provider: c.provider, model: models[r.id] ?? "" }); }}
                    placeholder="default model"
                    aria-describedby={helpIdFor(mid)}
                    spellCheck={false}
                    className={`t-mono w-full ${INPUT}`}
                    style={INPUT_STYLE} />
                </Field>
              </div>} />
        );
      })}
      {note && <div role="status" className="agx-settings-x pt-2 pb-3 text-[11px]" style={{ color: "var(--text3)" }}>{note}</div>}
    </SettingsCard>
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
function SwitchButton({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled}
      className="shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
      <Switch on={on} />
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
  talkMode: TalkNotify; onTalkMode: (v: TalkNotify) => void;
  sysNotify: SysNotifyMode; notifyCap: NotifyCapability | null;
}) {
  const { quiet, mutedList, own } = p;
  const prefs = useSyncExternalStore(subscribeNotifyPrefs, getNotifyPrefs, getNotifyPrefs);
  const [err, setErr] = useState<string | null>(null);
  const save = (next: typeof prefs) => {
    setErr(null);
    saveNotifyPrefs(next).catch(() => setErr("Could not save."));
  };
  const setKind = (k: NotifyKind, on: boolean) => save({ ...prefs, kinds: { ...prefs.kinds, [k]: on } });
  const setChannel = (c: NotifyChannel, on: boolean) => save({ ...prefs, channels: { ...prefs.channels, [c]: on } });
  const alarmPicker = (
    <VoicePicker label="Reminder alarm" voices={ALARM_VOICES} value={p.alarmVoice} onPick={p.onAlarmVoice} />
  );
  return (
    <>
      <SettingsCard title="Interrupt me for"
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
                label="Alarm voice" hint="A reminder you set takes the screen and rings until it is answered."
                control={alarmPicker} />
            )}
          </Fragment>
        ))}
        <Toggle on={own} onClick={() => setAppNotify(!own)}
          agentNever="turning it on asks the browser for permission, which needs the owner's own gesture, and turning it off silences the app's own notices"
          label="agentglass's own notifications"
          hint="Chats finishing, branches falling behind, checks going red. With Quiet on, only what is stopped interrupts either way; this switch decides the rest once Quiet is off. Everything keeps landing in the bell." />
      </SettingsCard>

      <SettingsCard title="How it reaches you">
        {NOTIFY_CHANNELS.map((c) => (
          <Fragment key={c}>
            <Toggle on={prefs.channels[c]} disabled={prefs.none}
              onClick={() => setChannel(c, !prefs.channels[c])}
              agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
              label={NOTIFY_CHANNEL_LABEL[c].label} hint={NOTIFY_CHANNEL_LABEL[c].desc} />
            {c === "sound" && (
              <>
                <SettingRow agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence"
                  label="Notification sound" hint="Which sound notifications make. Play tries it."
                  control={<VoicePicker label="Notifications" voices={NOTIFY_VOICES} value={p.notifyVoice} onPick={p.onNotifyVoice} />} />
                <Toggle on={p.sound} onClick={p.onSound}
                  agentExempt label="Chime this session"
                  hint="A chime when a session errors or needs you. Off at every start; the speaker in the header flips it too." />
              </>
            )}
          </Fragment>
        ))}
        {/* Quiet and the muted sources used to sit behind a fold named for
            both. A switch that decides what interrupts is a setting to find,
            not a drawer to open, and a fold's rows could not sit on the
            card's own divider. */}
        <Toggle on={quiet} onClick={() => setting("notifications.quiet").set(!quiet)}
          settingId="notifications.quiet" label="Quiet — only what is stopped interrupts"
          hint="An approval, an agent blocked on a question, a red check on a pull request about to merge: those still pop and ring. Everything else collects in the bell without a sound." />
        {mutedList.length > 0 && (
          <SettingRow agentExempt label="Muted"
            hint="Not collected. Mute a source from its row in the bell or from a desktop card; unmute it here or from the bell's footer."
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

      <SettingsCard title="Pull requests">
        <Toggle on={p.ciApproved} onClick={p.onCiApproved}
          settingId="notifications.ciOnlyApproved" label="Checks: only when the pull request is approved"
          hint={p.ciApproved
            ? "A suite finishing on something half-written is a status line; on something approved it is the last thing before merging."
            : "Every verdict, on every pull request of yours — including the ones nobody has looked at yet."} />
        <Choice<TalkNotify>
          settingId="notifications.talk" label="Conversation: when somebody says something"
          hint={p.talkMode === "everything"
            ? "A comment from a person, and a review the moment it is submitted — named as what it is: approved, changes requested, or a remark."
            : p.talkMode === "reviews"
            ? "Only a review coming back. Comments on the conversation stay to be found on the board, which marks them either way."
            : "Nothing. The board still marks what has been said since you last looked; it just will not interrupt you."}
          value={p.talkMode}
          options={[
            { v: "everything", label: "Comments and reviews" },
            { v: "reviews", label: "Reviews only" },
            { v: "off", label: "Off" },
          ]}
          onPick={p.onTalkMode} />
      </SettingsCard>

      <SettingsCard title="Asked for, and what became of it"
        desc="The notifications you armed, newest first. Quiet: nothing here interrupts.">
        <AskedAlertLog />
      </SettingsCard>

      <SettingsCard title="From other apps">
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
            : "Slack, mail, calendar — whatever pops up behind agentglass while it is covering your screen. A copy, never an interception: your desktop still shows its own."} />
        {p.sysNotify !== "off" && (
          <Choice<SysNotifyMode>
            agentNever="reads other applications' notifications into this app: what they say is theirs"
            label="How much of the message"
            hint="Full shows the text on the card; Who shows only who it was from"
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

function AgentsSection() {
  return (
    <SettingsCard title="Agent engines">
      <SettingRow label="Which engines this computer has"
        hint="Version, sign-in, what each can do, and whether it reports to this app: one card per engine, with its Connect button."
        onClick={() => openSettings("engines")} />
    </SettingsCard>
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
  return (
    /* One action per row. Install opens a shell with the command typed in,
       which finishes the job; when there is no honest one-liner the guide is
       the action instead. Where there are both, the guide is a link in the
       description, so the row never carries two buttons for one job. The
       console opens under the row, which stays on screen above it. */
    <SettingRow
      label={<span className="inline-flex items-baseline gap-2 flex-wrap">
        <span>{d.title}</span>
        <code className="text-[11px] t-mono t-dim">{d.bin}</code>
      </span>}
      hint={<>
        {d.what}
        {d.detail && d.status !== "ok" && <span className="block mt-1">{d.detail}</span>}
        {d.note && d.status !== "ok" && d.status !== "unsupported" && <span className="block mt-1">{d.note}</span>}
        {canType && guide && (
          <span className="block mt-1">
            <a href={href} target="_blank" rel="noreferrer noopener" className="agx-textlink">Install guide ↗</a>
          </span>
        )}
      </>}
      status={<StatusBadge tone={depTone(d)}>{d.status === "missing" && d.required ? "Needed, not installed" : STATUS_LABEL[d.status]}</StatusBadge>}
      actions={canType
        ? <Button aria-expanded={console} onClick={() => setConsole((v) => !v)}
            title="Open a shell here with the command typed in — you press Enter">
            {console ? "Close shell" : "Install"}
          </Button>
        : guide
          ? <LinkButton href={href!}>Install guide</LinkButton>
          : undefined}
      below={console && canType ? <ShellConsole command={d.install!} cwd={home} onClose={() => setConsole(false)} /> : undefined}
    />
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

  /* Closed until asked for, like the fold it replaces; a search or a deep link
     opens it, because a result inside a closed card has nothing to land on. */
  const { on, flash } = useContext(Filter);
  const [folded, setFolded] = useState(false);
  return (
    <SettingsCard title="GitHub" desc="The API allowance this app spends, and what is left of it."
      fold={{ open: folded || on || !!flash, onToggle: setFolded }}>
      <SettingRow
        label="How much of your GitHub allowance is left"
        hint="Every pull request, check and search this app shows spends one. GitHub refills them on a rolling window — 5,000 an hour for REST and GraphQL, 30 a minute for Search, which is the one that runs out first because looking up a card's pull requests is a search."
        control={<RefreshButton onRefresh={() => void load()} busy={busy} title="Refresh the GitHub budget" />}
        below={<>
        {state && !state.ok && (
          <p className="mt-2 text-[12px]" style={{ color: "var(--text3)" }}>{state.error}</p>
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
 * There is nothing to switch off here, and that is the finding rather than an
 * omission: no analytics, no crash reporting, no phone-home. A toggle that
 * turned off something that was never running would be theatre.
 */
function PrivacyPane({ open }: { open: boolean }) {
  const [d, setD] = useState<{ db: string; config: string; credentials: string; retentionDays: number; pairedDevices: number; clickup: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    void api.privacy().then(setD).catch(() => setD(null));
  }, [open]);

  /* A row, not a block of its own: what it holds on the left where every other
     label is, and the path underneath it. The path is not a control — it is 70
     characters of monospace that would take the whole control column and still
     wrap — so it goes in the hint, where wrapping is what hints do. */
  const Path = ({ label, value, note }: { label: string; value: string; note: string }) => (
    <SettingRow label={label} hint={<>
      {note}
      <span className="block mt-1 break-all" style={{ fontFamily: "ui-monospace, monospace", color: "var(--text2)" }}>
        {value || "—"}
      </span>
    </>} />
  );

  return (
    <>
      <SettingsCard title="Nothing is sent anywhere">
        <SettingRow label="No analytics, no crash reporting, no phone-home"
          hint="There is nothing to turn off here. What this app does with your data, it does on this machine." />
      </SettingsCard>
      <SettingsCard title="What is on disk">
        <Path label="History" value={d?.db ?? ""}
          note="Every event, prompt, tool call and file change, in SQLite. Written owner-only — it holds prompts and command output in cleartext." />
        <Path label="Settings" value={d?.config ?? ""}
          note="Your preferences, budgets and the boards you have added." />
        <Path label="Credentials" value={d?.credentials ?? ""}
          note="Tokens for the services you connected, mode 0600. They are used by the server and never sent to the browser." />
        {d && (
          <SettingRow label="Retention"
            hint={<>
              History older than {d.retentionDays === 0 ? "— nothing is pruned" : `${d.retentionDays} days is pruned automatically`}.
              Deleting the history file deletes all of it.
            </>} />
        )}
      </SettingsCard>
      <SettingsCard title="Activity">
        {/* Activity has no nav entry; this row and the palette are its ways in. */}
        <SettingRow label="Activity log" hint="What the app itself has been doing." onClick={() => openSettings("log")} />
      </SettingsCard>
      <SettingsCard title="What does leave this machine">
        {/* The headline answer is one line and stays open, because it is the
            claim this page exists to make. The enumeration behind it is the
            evidence, and evidence is read when it is doubted. */}
        <SettingRow
          label="Only the calls you asked for"
          hint={d && d.pairedDevices > 0
            ? `${d.pairedDevices} paired device${d.pairedDevices === 1 ? " can" : "s can"} reach this server — see Remote.`
            : "No device is paired, so nothing can reach this server from outside."}
          detail={{
            summary: "Which calls, exactly",
            body: <>
              GitHub through <code>gh</code>, {d?.clickup ? "ClickUp through its API, " : ""}and whatever an agent you started
              decides to do. Avatars are fetched from GitHub. Nothing else leaves, and nothing at all is
              sent to us — there is no endpoint of ours for it to go to.
            </>,
          }}
        />
      </SettingsCard>
    </>
  );
}

function IntegrationsPane({ open }: { open: boolean }) {
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

  /* One card per kind, and each carries its own verdict and the recheck at
     its top right. It was one "Services" card with two eyebrow headings
     inside it, which is a group heading drawn as a line of small caps with
     rules above and below — the shape the settings sweep counted on every
     page. The provider list is a constant (shared/providers.ts), so both
     cards draw at once and only the badges wait for the answer. */
  return (
    <>
      {(["review", "task"] as const).map((kind) => {
        const specs = PROVIDERS.filter((p) => p.kind === kind);
        const mine = status?.filter((x) => specs.some((p) => p.id === x.id)) ?? null;
        const ok = mine?.filter((x) => x.state === "connected").length ?? 0;
        const bad = mine?.filter((x) => x.state === "error").length ?? 0;
        const verdict = !mine
          ? <StatusBadge tone={err ? "err" : "checking"}>{err ? "Not read" : "Checking"}</StatusBadge>
          : bad
            ? <StatusBadge tone="err">{bad} {bad === 1 ? "needs" : "need"} attention</StatusBadge>
            : <StatusBadge tone={ok === mine.length && ok > 0 ? "ok" : "off"}>{ok} of {mine.length} connected</StatusBadge>;
        return (
          <SettingsCard key={kind}
            title={kind === "review" ? "Review providers" : "Task providers"}
            desc={kind === "review"
              ? "Pull requests, checks and review state."
              : "Where the things you owe come from. Each one you connect becomes a tab in Tasks."}
            status={verdict}
            actions={<Button pending={busy} onClick={() => void load()}>Recheck</Button>}>
            {err && <SettingRow label={err} hint="Recheck to try again." />}
            {specs.map((p) => (
              <ProviderCard key={p.id} spec={p} status={statusOf(p.id)} checking={!status && !err} onChanged={load} />
            ))}
          </SettingsCard>
        );
      })}
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
    rememberHeight(spec.id, box.current.getBoundingClientRect().height);
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
     * One row per provider, in one card per kind: the badges form a column you
     * can read down in one movement. Everything conditional — the form, the
     * confirmation, the workspace list — is the row's stacked slot, so a row
     * with nothing to add is one line of name and one of description, and a
     * row that grows does it under itself.
     *
     * The badge stays first in the control column in every state, and
     * Disconnect after it; the confirmation that replaces Disconnect opens
     * under the row, where the question is asked.
     */
    <SettingRow
      rowRef={box}
      /* Still remembered, still for the same reason: the row grows a detail
         line and, when it is not connected, a form under it. Measured after
         the card became a row, the page still moved 145px without this. */
      minHeight={waiting ? rememberedHeights()[spec.id] ?? 56 : undefined}
      label={spec.title}
      hint={<>
        <span className="block">{spec.what}</span>
        {status?.detail && <span className="block mt-1">{status.detail}</span>}
        {/* When that verdict was actually taken. The row above is read from a
            cache — deliberately, because asking ClickUp live costs ten
            seconds of its latency for a question the token answers — and a
            cached verdict drawn with no date claims to be a live one. */}
        {checked && <span className="block mt-1">{checked}</span>}
        {/* Half of a provider can be down while the other half looks fine —
            the ClickUp card bell fails on its own six-minute timer. Warning
            ink and UNDER the detail, because it qualifies the verdict instead
            of being it: a connected row with a broken bell is still connected. */}
        {status?.notice && <span className="block mt-1" style={{ color: "var(--warning-ink)" }}>{status.notice}</span>}
        {connected && spec.id === "clickup" && (
          <span className="block mt-1">
            <button type="button" className="agx-textlink" onClick={() => void changeWorkspace()}>Change workspace</button>
            {" · "}
            <button type="button" className="agx-textlink" onClick={() => openSettings("clickup")}>Workflow and boards</button>
          </span>
        )}
        {waiting && <span className="agx-skeleton block mt-1 rounded" style={{ height: 13, maxWidth: 240 }} aria-hidden />}
      </>}
      /* The standing caveat about a provider — true whether or not you ever
         connect it, and read once — behind a summary that says what it is. */
      detail={spec.note && !connected && !waiting && !isJira ? { summary: spec.noteTitle ?? "About the credential", body: spec.note } : undefined}
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
        : undefined}
      below={below}
    />
  );
}

function RequirementsPane({ open }: { open: boolean }) {
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
      <SettingsCard title="On this machine" desc={desc}
        status={<StatusBadge tone={err ? "err" : "checking"}>{err ? "Not checked" : "Checking"}</StatusBadge>}
        actions={recheck}>
        <SettingRow label={err ? err : "Checking this machine…"} hint={err ? "Recheck to try again." : undefined} />
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
  const broken = live.filter((d) => d.status === "missing" && d.required).length;
  const wanting = live.filter((d) => d.status === "attention" || (d.status === "missing" && !d.required)).length;

  return (
    /* The verdict is the card's badge and the recheck is its one action, at
       the top right. Only what wants something gets a row — the status, the
       detail, the install — and the ones that are ready collapse behind one
       line, where a name and a dot are enough. */
    <SettingsCard title="On this machine" desc={desc}
      status={broken
        ? <StatusBadge tone="err">{broken} needed {broken === 1 ? "tool" : "tools"} missing</StatusBadge>
        : wanting
          ? <StatusBadge tone="warn">{wanting} optional {wanting === 1 ? "feature" : "features"} off</StatusBadge>
          : <StatusBadge tone="ok">Everything is here</StatusBadge>}
      actions={recheck}>
      {wants.map((d) => <DepRow key={d.id} d={d} home={shellRoot} />)}

      {ready.length > 0 && (
        <Fold label={wants.length ? `${ready.length} more ready` : `${ready.length} ready`}
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
function TerminalRunsOn({ open }: { open: boolean }) {
  const [terminal, setTerminal] = useState("engine");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
    <SettingsCard title="Terminal runs on" desc="The shell a Terminal view starts.">
      <SettingRow
        agentNever="which tmux a shell runs in, held by the server: it changes what runs a shell, so the owner chooses it"
        label="Terminal runs on"
        hint="Where the Terminal view opens a shell: on the pane engine, or on the tmux you already run on this machine."
        detail={{
          summary: "What each choice does",
          body: <>"The engine" gives it the pane engine — agentglass draws the tabs and splits, the prefix set under Pane engine (tmux) applies, and Restore there can bring it back after a reboot; one session per checkout. "This machine's tmux" resumes the session you left in your own tmux, with your own <span className="t-mono text-[11px]">~/.tmux.conf</span>. They are separate servers: switching moves nothing and loses nothing, and whichever you are not using keeps running.</>,
        }}
        control={<span className="flex justify-end"><Select align="right" value={terminal} onChange={saveTerminal} disabled={busy}
          options={[{ value: "engine", label: "The engine" }, { value: "desk", label: "This machine's tmux" }]} /></span>}
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
  const [noteAt, setNoteAt] = useState<"engine" | "config" | "restore">("engine");
  const [busy, setBusy] = useState(false);
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
    setBusy(true); setNote(null); setErr(null); setNoteAt("engine");
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
    setBusy(true); setNote(null); setNoteAt("engine");
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
  return (
    <>
    <SettingsCard title="Pane engine"
      desc="The engine runs its own tmux server — its own socket, its own config. Your ~/.tmux.conf is never loaded, and neither is your tmux touched."
      status={!st
        ? <StatusBadge tone="checking">Checking</StatusBadge>
        : cap?.available
          ? <StatusBadge tone="ok">Pane engine ready</StatusBadge>
          : <StatusBadge tone="err">Pane engine unavailable</StatusBadge>}
      actions={st ? <Button onClick={resetAll} disabled={busy}>Reset tmux to defaults</Button> : undefined}>
      <SettingRow
        label="tmux binary"
        hint={<>
          <span className="block">Which executable the engine spawns. "Auto" prefers the bundled static tmux and falls back to the system one; "Custom" points at your own binary (e.g. a newer tmux). Tabs, splits and status are drawn by agentglass either way.</span>
          {(st?.bin.path || st?.bin.version || (cap && !cap.available) || st?.broken) && (
            <span className="block mt-1">
              {st?.bin.path ? <>Currently <span className="t-mono text-[11px] break-all">{st.bin.path}</span></> : null}
              {st?.bin.version ? <> — {st.bin.version}</> : null}
              {st?.bin.source === "env" ? " (AGENTGLASS_TMUX_PATH override)" : null}
              {cap && !cap.available ? <> — {cap.reason}</> : null}
              {st?.broken ? <> <b style={{ color: "var(--error-ink)" }}>{st.brokenReason}</b></> : null}
            </span>
          )}
        </>}
        control={<Select value={source} onChange={setSource} disabled={busy} align="right" style={SELECT_BOX}
          options={[
            { value: "auto", label: "Auto (bundled first)" },
            { value: "bundled", label: "Bundled" },
            { value: "system", label: "System" },
            { value: "custom", label: "Custom…" },
          ]} />}
        actions={<Button onClick={saveSettings} disabled={busy}>Save</Button>}
        below={source === "custom" ? (
          <SettingsForm label="Custom tmux binary" onSubmit={saveSettings}>
            <Field label="Path to the binary" htmlFor="tmux-bin-path">
              <input id="tmux-bin-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/tmux"
                className={`t-mono ${INPUT}`} style={INPUT_STYLE} />
            </Field>
          </SettingsForm>
        ) : undefined}
      />

      {/* The choice itself lives under Terminal, beside the other things that
          decide what a Terminal does; one row here so somebody who came for the
          engine still finds where a shell opens. */}
      <SettingRow
        label="Where a Terminal opens a shell"
        hint="Set under Terminal: on this engine, or on your own tmux."
        actions={<Button onClick={onGoTerminal}>Open Terminal settings</Button>}
      />

      {/* The one binding everybody changes, as a choice rather than as three
          lines of tmux to remember: `set -g prefix` alone leaves C-b working,
          and without `send-prefix` the new key cannot be typed through to a
          program inside the pane. The generator writes all three. */}
      <SettingRow
        label="Prefix key"
        hint={<>The chord that starts every tmux command in these panes — the engine's own, not your tmux's. tmux's default is <span className="t-mono text-[11px]">C-b</span>; pick another if that is taken by something you use. "Custom" takes tmux's spelling: <span className="t-mono text-[11px]">C-a</span>, <span className="t-mono text-[11px]">M-Space</span>, <span className="t-mono text-[11px]">F5</span>. Saving hands it to the running engine, so it applies to the panes already open — no restart.</>}
        control={<Select value={prefixListed ? prefix : "custom"} disabled={busy} align="right" style={SELECT_BOX}
          onChange={(v) => { setPrefixCustom(v === "custom"); if (v !== "custom") setPrefix(v); }}
          options={[...PREFIXES.map((p) => ({ value: p.value, label: p.label })), { value: "custom", label: "Custom…" }]} />}
        /* It reloads as well as saves, and a button that only says "Save"
           over a change that lands immediately is a button people press
           twice. */
        actions={<Button onClick={savePrefix} disabled={busy}>Save &amp; apply</Button>}
        below={(prefixCustom || !prefixListed) ? (
          <SettingsForm label="Custom prefix key" onSubmit={savePrefix}>
            <Field label="Prefix key, in tmux's spelling" htmlFor="tmux-prefix">
              <input id="tmux-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="C-a" spellCheck={false}
                className={`t-mono ${INPUT}`} style={INPUT_STYLE} />
            </Field>
          </SettingsForm>
        ) : undefined}
      />
      {saidHere("engine")}
    </SettingsCard>

    <SettingsCard title="Engine config"
      desc="Extra config lines for the engine's own server, validated by tmux before they apply. A rejected config leaves the engine off and chat unaffected, and Reset brings it back.">
      <SettingRow
        label="Mode"
        hint={<>"Append" runs your lines after the generated base (the UI's status bar stays off — that line is re-asserted after yours); "Replace" makes your text the whole config.</>}
        control={<Select value={confMode} onChange={setConfMode} disabled={busy} align="right" style={SELECT_BOX}
          options={[
            { value: "append", label: "Append to base" },
            { value: "replace", label: "Replace everything" },
          ]} />}
      />
      <SettingRow
        label="Override config"
        hint={<>Plain tmux commands, one per line. Your ~/.tmux.conf is never read. Plugins work by adding their own <span className="t-mono text-[11px]">run-shell</span> line.</>}
        below={
          <SettingsForm label="Override config" onSubmit={saveConf}>
            <Field label="tmux commands" htmlFor="tmux-override">
              <textarea id="tmux-override" value={override} onChange={(e) => setOverride(e.target.value)} spellCheck={false} rows={6} disabled={busy}
                placeholder={"set -g prefix C-b\nbind-key v split-window -h"}
                className="text-[11px] t-mono px-2 py-1.5 rounded-lg bg-transparent w-full resize-y"
                style={{ color: "var(--text2)", border: EDGE }} />
            </Field>
            <div><Button type="submit" disabled={busy}>Validate &amp; apply</Button></div>
          </SettingsForm>
        }
      />
      {saidHere("config")}
    </SettingsCard>

    <SettingsCard title="Restore after reboot">
      <SettingRow
        label="Restore the layout"
        role="switch" ariaChecked={restore}
        onClick={busy ? undefined : () => savePaneField({ restore: !restore }, "Restore")}
        hint="When the host reboots, the engine's tmux dies with it — this photographs the layout (sessions, tabs, splits, each pane's directory and start command; not what scrolled past) and rebuilds it at the next boot. Nothing here touches your own tmux or its resurrect saves."
        control={<Switch on={restore} busy={busy} />}
      />
      <SettingRow
        label="Resume mode"
        hint={<>"Lazy" restores the tree and resumes each agent when you reopen its chat; "All" relaunches every recorded CLI, resuming each conversation.</>}
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
          hint={`${st.crashLoop.launches} launches in ten minutes looked like a crash loop, so this start neither restored nor re-captured. Restore it by hand below once the app is stable, or delete ${st.crashLoop.file} to clear this.`}
        />
      )}
      {st?.lastCaptureAt ? (
        <SettingRow
          label="Last layout capture"
          hint={`Taken ${new Date(st.lastCaptureAt).toLocaleString()}. Captures run every minute while the engine is on.`}
          below={<span className="flex flex-wrap items-center gap-2">
            <Button onClick={() => restoreAction("capture")} disabled={busy}>Capture now</Button>
            <Button onClick={() => restoreAction("restore")} disabled={busy}>Restore now</Button>
            <Button onClick={() => restoreAction("clear")} disabled={busy}>Clear</Button>
          </span>}
        />
      ) : (
        <SettingRow
          label="Restore state"
          hint="Nothing captured yet — enable Restore and the next sweep photographs the layout."
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
  if (!both) return null;
  const pick = async (repo: string, v: TrackerChoice) => {
    const r = await api.setTrackerProject(repo, v);
    if (!r.ok) { setNote(r.error ?? "Could not save that"); return; }
    setNote("");
    rememberTrackerChoices(r.projects ?? {});
    setRows((cur) => cur && { ...cur, chosen: r.projects ?? {} });
  };
  return (
    <SettingsCard title="Card tracker"
      desc={<>Which tracker a repository's cards live in. Auto reads the id's prefix.
        {note && <span className="block mt-1" role="alert" style={{ color: "var(--error-ink)" }}>{note}</span>}</>}>
      {!rows?.repos.length && <EmptyState>No repositories to choose for yet.</EmptyState>}
      {rows?.repos.map((repo) => (
        <Choice<TrackerChoice> key={repo} label={repo} hint="Where a card id in this repository's branches and pull requests is looked up."
          value={rows.chosen[repo.toLowerCase()] ?? "auto"} onPick={(v) => void pick(repo, v)}
          options={[{ v: "auto", label: "Auto" }, { v: "clickup", label: "ClickUp" }, { v: "jira", label: "Jira" }]} />
      ))}
    </SettingsCard>
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
  const [renderer, setRenderer] = useState<RendererPref>(() => rendererPref());
  const [keys, setKeys] = useState(() => bindings());
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  // The Shortcuts page reads chordFor, which now answers out of the rail: move
  // a view between groups on the Rail page and every number on this one shifts.
  // Without this the two pages sit side by side disagreeing.
  useSyncExternalStore(subscribeRail, loadRail, () => SHIPPED_RAIL);
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
  const [badges, setBadges] = useState<{ connections?: number; remote?: "live" | null }>({});
  const [logDigest, setLogDigest] = useState<LogDigest | "failed" | null>(null);
  /** The three onboarding steps, read from the same state Connections and
   *  Agents already show — this owns no state of its own, so it cannot say
   *  "done" about something those pages would call unfinished. `null` until
   *  the reads land, which keeps the pinned row off the nav rather than
   *  flashing it and pulling it back a second later. */
  const [onboarding, setOnboarding] = useState<{ hook: boolean; provider: boolean; paneEngine: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all([
      api.dependencies().then((r) => r.deps).catch(() => [] as DepReport[]),
      api.providers().then((r) => r.providers).catch(() => [] as ProviderStatus[]),
      api.remoteStatus().then((r) => (r.clients.liveCount > 0 ? ("live" as const) : null)).catch(() => null),
      api.hooksStatus().then((r) => r.installed).catch(() => false),
      api.logDigest().catch(() => "failed" as const),
    ]).then(([deps, provs, remote, hookInstalled, digest]) => {
      if (!live) return;
      setBadges({
        connections: deps.filter((d) => d.status !== "ok" && d.status !== "unsupported").length
          + provs.filter((p) => p.state === "error" || p.state === "needs-auth").length,
        remote,
      });
      setLogDigest(digest);
      setOnboarding({
        hook: hookInstalled,
        provider: provs.some((p) => p.state === "connected"),
        paneEngine: deps.some((d) => d.id === "tmux" && d.status === "ok"),
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
  const rowResults = useMemo(() => (ql ? searchSettings(ql, tabs as SettingsPage[]) : []), [ql, tabs]);
  /** The rows actually on screen — the ones on a page that made the cap-5
   *  cut — in the same rank order the header counts. This, not `rowResults`
   *  itself, is what up/down cycles through: a result you cannot see is not
   *  one you can land on with Enter. */
  const visibleResults = useMemo(() => rowResults.filter((r) => matchIds.has(r.pane)), [rowResults, matchIds]);
  /** Words a hit above only reached through a synonym — shown once, in the
   *  "· also: …" clause, so typing "chime" is told it found "sound" rather
   *  than silently substituting one word for the other. */
  const synonymsUsed = useMemo(() => {
    if (!ql) return [] as string[];
    const words = ql.split(/\s+/).filter(Boolean);
    const hitTexts = visibleResults.map((r) => (r.label + " " + r.section).toLowerCase());
    const used = new Set<string>();
    for (const w of words) for (const e of expandWord(w)) {
      if (e.synonym && hitTexts.some((t) => t.includes(e.word))) used.add(e.word);
    }
    return [...used];
  }, [ql, visibleResults]);
  const [highlight, setHighlight] = useState(0);
  useEffect(() => { setHighlight(0); }, [ql]);
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
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
        el.classList.add("agx-row-flash");
        window.setTimeout(() => el.classList.remove("agx-row-flash"), 1200);
      }
      setFlashRow(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [flashRow, ql, pane]);
  /** Enter on a highlighted result, or a click on one: land on it. Clearing
   *  the query first is what makes `flashRow`'s effect (above) wait for the
   *  single settled page to mount before it goes looking for the row. */
  const landOnResult = useCallback((r: { pane: string; row: string }) => {
    setPane(r.pane as Pane);
    setQ("");
    if (r.row) setFlashRow(r.row);
  }, []);
  /*
   * Marks and keeps on screen the highlighted result as the arrow keys move
   * it — a class on the row's own DOM node (a `data-row` lookup, the same
   * one the flash uses), not the flash class itself: the flash means "this
   * is the one you picked", and every row up/down passes through on the way
   * there would light up the same way a landing does.
   *
   * `highlightedEl` is a ref, not state — the element the LAST render marked,
   * so this can remove the class from it before adding it to (or nowhere,
   * once the query clears) the next one, without re-scanning every row in
   * the DOM to find whichever one happens to be wearing it.
   */
  const highlightedEl = useRef<HTMLElement | null>(null);
  useEffect(() => {
    highlightedEl.current?.classList.remove("agx-row-current");
    highlightedEl.current = null;
    if (!ql || !visibleResults.length) return;
    const r = visibleResults[Math.min(highlight, visibleResults.length - 1)];
    if (!r?.row) return;
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(r.row)}"]`);
    if (!el) return;
    el.classList.add("agx-row-current");
    el.scrollIntoView({ block: "nearest" });
    highlightedEl.current = el;
  }, [highlight, ql, visibleResults]);
  const onSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!ql || !visibleResults.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, visibleResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); landOnResult(visibleResults[Math.min(highlight, visibleResults.length - 1)]!); }
  }, [ql, visibleResults, highlight, landOnResult]);
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
  const pageDirty: Partial<Record<Pane, { modified: boolean; reset: () => void }[]>> = {
    prefs: [
      { modified: !splash, reset: () => { setSplashOn(true); setSplash(true); } },
      ...(IS_DESKTOP ? [{ modified: scale !== DEFAULT_SCALE, reset: () => onZoom(0) }] : []),
    ],
    appearance: [
      { modified: accent !== "", reset: () => { setAccentPref(""); applyTheme(theme); setAccentState(""); setAppearanceNonce((n) => n + 1); } },
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
   * And the same again for an app action — the file palette.
   *
   * A third capture rather than a branch inside the second, for the reason the
   * comment above gives about the first two: while one of these is listening it
   * owns every keystroke in the app, so two that could be armed at once is one
   * that swallows the other's key.
   */
  // Read once into state rather than on every render: it lives in localStorage
  // and the row has to reflect a press immediately.
  const [ciApproved, setCiApproved] = useState(ciOnlyApproved);
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
      if (escArmed) { setEscArmed(false); onClose(); return; }
      setEscArmed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, escArmed]);

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
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="fixed inset-0 flex pointer-events-auto"
            style={{ zIndex: 10000, background: "var(--bg)" }}>

            {/* Three strips and a scroller, and the order is the point: the two
                things you always want — the way out, and the way to find a
                setting by name — sit OUTSIDE the scroll container, so neither
                can be pushed off the top by a long nav. */}
            {/* The nav paints its OWN tone. It shared --bg with the page, so
                two regions that do entirely different jobs — twenty-four
                places you can go, and the one you are in — were the same
                surface with a 25%-alpha hairline between them, and the
                complaint that "the sidebar and the view look like the same
                thing" was a literal description of the colour values. The
                border is at full --surface-line now for the same reason: a
                seam this important is not a suggestion. */}
            <aside className="agx-settings-nav shrink-0 flex flex-col border-r"
              style={{ background: "var(--surface-nav)", borderColor: "var(--surface-line)" }}>
              {/* Leaving is a button you press, not an x you hunt for in a
                  corner — and it says where it takes you, because after ten
                  minutes in here that is the thing you have to be told.
                *
                  The row IS the button. It was a button the size of its text
                  inside a padded bar, so the bar looked like the control and
                  only the arrow and the words answered the pointer; a press on
                  the rest of the row landed on nothing. Full width, no padding
                  around it, and the only things that change on hover and press
                  are its fill and its ink, so nothing under the pointer moves. */}
              <button onClick={onClose} type="button"
                className="agx-navback shrink-0 w-full flex items-center gap-2 px-5 border-b text-[13px] text-left"
                style={{ color: "var(--text3)", borderColor: "var(--surface-line)", minHeight: 56 }}>
                <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
                </svg>
                <span>Back to app</span>
              </button>

              <div className="shrink-0 px-3 py-3 border-b" style={{ borderColor: "var(--surface-line)" }}>
                {/* --bg, not --bg2. The box used the raised tone, which was
                    right when the nav under it was --bg and inverts now that
                    the nav leans toward --bg2 itself: a field has to sit IN
                    its surface, and painted at the surface's own tone it was
                    a rectangle of border with nothing behind it.
                  *
                    Focused on open and on Ctrl+F, and the shortcut is printed
                    on the box. Typing is what you came here to do — twenty-four
                    pages is past the count where hunting the nav beats naming
                    the thing — and a shortcut nobody is told about is one
                    nobody uses. */}
                <div className="relative">
                  <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKeyDown} placeholder="Search settings"
                    aria-keyshortcuts="Control+F"
                    className={`w-full pr-14 ${INPUT}`}
                    style={INPUT_STYLE} />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[10.5px] tabular-nums"
                    style={{ color: "var(--text4)" }}>Ctrl F</span>
                </div>
              </div>

              {/* px-2.5, not px-2, and the 2px is the point: every nav item is a
                  button with its own px-2.5, so the container's padding plus
                  the button's decides where the TEXT lands. */}
              <div className="min-h-0 flex-1 agx-scroll overflow-y-auto overflow-x-hidden py-2 px-2.5 flex flex-col gap-0.5">
                {/* Pinned above every ring, not filed into one, and gone the
                    moment `onboardingDone` — no "you're all set" row left
                    behind for it to become. Held back on a search too: it
                    answers "what's left", not "what's Terminal", so it has
                    no business in a query for the latter. */}
                {onboarding && !onboardingDone && !ql && (
                  <button onClick={() => setPane("onboarding")}
                    aria-current={pane === "onboarding" ? "page" : undefined}
                    className="w-full text-left px-2.5 py-1.5 mb-1.5 rounded-lg text-[13px] flex items-center gap-2"
                    style={pane === "onboarding"
                      ? { background: "color-mix(in srgb, var(--primary) 15%, transparent)", color: "var(--text)" }
                      : { color: "var(--text2)", border: EDGE }}>
                    <span className="min-w-0 truncate">Get started</span>
                    <span className="ml-auto shrink-0 text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }}>
                      {[onboarding.hook, onboarding.provider, onboarding.paneEngine].filter(Boolean).length}/3
                    </span>
                  </button>
                )}
                {(() => {
                  const hit = (t: typeof TABS[number]) => !ql || pageScore(t as SettingsPage, ql) > 0;
                  const groups = TAB_GROUPS
                    .map((g) => ({ g, tabs: tabs.filter((t) => t.group === g && hit(t)) }))
                    .filter((x) => x.tabs.length);
                  if (!groups.length) return <div className="px-2.5 py-3 text-[12.5px]" style={{ color: "var(--text4)" }}>No settings match “{q.trim()}”.</div>;
                  return groups.map(({ g, tabs }) => (
                    <div key={g} className="flex flex-col gap-0.5">
                      {/* A group heading gets more room ABOVE it than its
                          items get between them — measured at 42px either
                          side before this, which is why "Agents"
                          read as belonging to the row above rather than to
                          the rows below. The rule is in tailwind.config.js
                          beside the scale, because it is about meaning
                          rather than size: a heading hugs what it names. */}
                      <div className="px-2.5 pt-4 pb-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>{g}</div>
                      {tabs.map((t) => (
                        <button key={t.id} onClick={() => setPane(t.id)}
                          aria-current={pane === t.id ? "page" : undefined}
                          className="w-full text-left px-2.5 py-2 rounded-lg text-[13px] flex items-center gap-2.5"
                          style={pane === t.id
                            ? { background: "color-mix(in srgb, var(--primary) 15%, transparent)", color: "var(--text)" }
                            : { color: "var(--text3)" }}>
                          {/* The icon is what turns a page of prose into a
                              shape you can scan — a nav of twenty-four
                              identical text rows was the thing that read as
                              "nothing invites you in". Dimmed to `--text4`
                              when the row isn't active so the active row's
                              full-color icon is still the one your eye lands
                              on first, the same job the highlight pill does. */}
                          <span className="shrink-0 flex" style={{ color: pane === t.id ? "var(--text)" : "var(--text4)" }}>
                            <t.icon size={ICON.md} />
                          </span>
                          <span className="min-w-0 truncate">{t.label}</span>
                          {/* A count when something wants you, a dot when
                              something is simply happening. Different marks
                              because they are different facts: one is a
                              chore, the other is a phone on the sofa. */}
                          {t.id === "connections" && !!badges.connections && (
                            <span className="ml-auto shrink-0 text-[10.5px] tabular-nums px-1.5 rounded-full"
                              style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 16%, transparent)" }}
                              title={`${badges.connections} ${badges.connections === 1 ? "thing wants" : "things want"} something`}>
                              {badges.connections}
                            </span>
                          )}
                          {t.id === "about" && logDigest && logDigest !== "failed" && !logDigest.quiet && (
                            <span className="ml-auto shrink-0 text-[10.5px] tabular-nums px-1.5 rounded-full"
                              style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 16%, transparent)" }}
                              title="The server log has a crash loop or a spike worth a look">
                              log {logDigest.crashLoops.length + logDigest.spikes.length}
                            </span>
                          )}
                          {t.id === "remote" && badges.remote === "live" && (
                            <span className="ml-auto shrink-0 rounded-full" aria-label="a device is connected"
                              title="A device is connected right now"
                              style={{ width: 6, height: 6, background: "var(--success)" }} />
                          )}
                          {/* A word, not a 6px ring — the ring was the first
                              draft here, and it failed its own house rule the
                              moment it was screenshotted: a dot that needs a
                              tooltip to explain itself is exactly the "icon
                              too small to read" complaint this pass exists to
                              fix. "State" says outright that the page reports
                              rather than sets, at a size a mouse can actually
                              land on. Held back when the page already carries
                              its own live mark above (Tools & services' count)
                              so nobody reads two unrelated marks on one row. */}
                          {t.status && !(t.id === "connections" && !!badges.connections) && (
                            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-full"
                              aria-label="reports state, not a setting"
                              title="Reports what is already happening — not a switch."
                              style={{ color: "var(--text4)", border: "1px solid color-mix(in srgb, var(--text4) 55%, transparent)" }}>
                              State
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            </aside>

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
                them was measure; on a page the column is capped at 760 anyway,
                so the slack is free and the gap is what stops the title reading
                as an extension of the nav it sits beside. */}
            <div ref={contentRef} className="agx-settings-main agx-scroll flex-1 min-w-0 overflow-y-auto pt-8 pb-10">
                  {/*
                    A WIDER COLUMN on the panes that are BOARDS rather than
                    reading.
                  *
                    760px is the measure for rows of prose and it is the wrong
                    number for a grid of cards: two cards inside it come out at
                    365px each, which is exactly the width that produced the
                    359x596 letterbox nobody could look at. Set HERE and not on
                    the pane, because a custom property inherits downward —
                    declared by a child of this element it can never reach the
                    `max-width` that reads it, which is why the first attempt
                    changed nothing at all.
                  */}
                  <div className="agx-settings-col"
                    style={WIDE_PANES.has(pane) ? ({ "--agx-settings-col": WIDE_PANES.get(pane) } as React.CSSProperties) : undefined}>
                  <Filter.Provider value={filterCtx}>
                  {/*
                   * The results header.
                   *
                   * Replaces the old "Showing the N settings on this page
                   * that match…" banner, which named ONE page because there
                   * was only ever one page on screen at a time. Now that a
                   * query can put more than one page's content on screen at
                   * once (see `matches`/`show` above), the count has to be
                   * the total across all of them, and "also:" has to say
                   * which typed word found a hit only because a synonym
                   * carried it there — a search that quietly substitutes a
                   * word is a search that lies about what you asked for.
                   */}
                  {ql && (
                    <div className="agx-settings-row mb-3 rounded-lg" style={{ background: "color-mix(in srgb, var(--primary) 9%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 25%, transparent)" }}>
                      <span className="text-[12.5px]" style={{ color: "var(--text2)" }}>
                        {/* visibleResults, not rowResults: the count on this line has to be
                            the count of rows actually rendered below. rowResults holds every
                            page's matches before the cap-5 truncation, so on a query wide
                            enough to reach a 6th page it said "14 settings match" over a
                            screen that showed 9 of them — a number nothing on screen backed. */}
                        {absentHit ? absentHit.say : visibleResults.length === 0
                          ? `No setting matches “${q.trim()}”.`
                          : (
                            <>
                              <span className="tabular-nums" style={{ color: "var(--text)" }}>{visibleResults.length}</span>
                              {" "}setting{visibleResults.length === 1 ? "" : "s"} match “{q.trim()}”
                              {synonymsUsed.length > 0 && (
                                <span style={{ color: "var(--text4)" }}> · also: {synonymsUsed.join(", ")}</span>
                              )}
                            </>
                          )}
                      </span>
                      <Button className="justify-self-end" onClick={() => setQ("")}>Show all</Button>
                    </div>
                  )}
                  {!ql && (() => {
                    const t = TABS.find((x) => x.id === pane);
                    return t ? (
                      /* px-1 rather than px-4: the cards below carry their
                         own 18px of inner padding, so a title indented to the
                         old row padding sat a clear step to the RIGHT of every
                         heading it governs. It leads the column now.
                       *
                       * 22px, and no rule under it: the 24px of space before
                       * the first card is the chapter break. The rule that was
                       * here was one more line beside a heading, counted on
                       * every page by the settings sweep. Reset page sits on
                       * the title's line, at the right, on the pages that can
                       * have it — a plain button, because it changes nothing
                       * until it is pressed and what it resets is named. */
                      <div className="mb-6 px-1">
                        <div className="flex items-center justify-between gap-4">
                          <h2 className="m-0 text-[22px] font-semibold tracking-[-0.015em]" style={{ color: "var(--text)" }}>{t.label}</h2>
                          {pageModified(t.id) && (
                            <Button onClick={() => resetPage(t.id)}>Reset page</Button>
                          )}
                        </div>
                        {/* No measure cap of its own — the column is the cap. At 62ch this broke
                            to two lines with a single word on the second while 300px of the
                            card below it sat empty, which reads as a layout fault rather
                            than as a sentence. */}
                        {t.what && <div className="text-[13px] mt-2" style={{ color: "var(--text3)" }}>{t.what}</div>}
                      </div>
                    ) : null;
                  })()}
                  {ql && show("appearance") && <PageMatchHeading id="appearance" onOpen={() => { setPane("appearance" as Pane); setQ(""); }} />}
                  {show("appearance") && (
                  <AppearancePane key={appearanceNonce} current={theme} onChange={onTheme} onAccent={setAccentState} />
                  )}
                  {ql && show("terminal") && <PageMatchHeading id="terminal" onOpen={() => { setPane("terminal" as Pane); setQ(""); }} />}
                  {show("terminal") && (<>
                  {/* THREE groups, and it was one. Eleven rows in a single
                      unnamed box is a page you have to read end to end to find
                      out whether the thing you came for is on it — the renderer
                      and the word separators are not the same subject and were
                      drawn as though they were. Named groups turn "read the
                      page" into "read three headings". */}
                  <SettingsCard title="How it draws"
                    desc="The renderer, the face, and the size of a cell.">
                    {/* GPU (WebGL) is fastest but blanks white on some Linux
                        GPU/compositor stacks; Canvas is the same drawing minus
                        the GPU — fast, and no context to lose — so Auto uses GPU
                        everywhere except Linux, where it uses Canvas. DOM is the
                        last resort, and the slow one. All apply to new shells. */}
                    <Choice<RendererPref>
                      settingId="terminal.renderer"
                      label="Terminal renderer"
                      hint="GPU is fastest; Canvas is nearly as fast and never blanks; DOM is the slow fallback. Applies to newly opened shells."
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
                      hint={<>
                        These faces ship with agentglass — no install needed, and they render the same on
                        any machine.
                        {TERM_FONTS.filter((f) => !(f.bundled || fontAvailable(f.family))).length > 0 && (
                          <span className="block mt-0.5">
                            Not on this machine:{" "}
                            {TERM_FONTS.filter((f) => !(f.bundled || fontAvailable(f.family))).map((f) => f.name).join(", ")}.
                          </span>
                        )}
                      </>}
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
                      hint={`Applies live to every open terminal, and is remembered. ${MOD_KEY}+ / ${MOD_KEY}− with the pointer over a terminal does the same without touching the window.`}
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
                      hint={termLine > LINE_HEIGHT_MIN
                        ? "Above 1, box-drawing rules — the divider between tmux panes, the frames around an agent's output — are drawn with a gap on every row wherever the GPU renderer is off (the default on Linux). 1 keeps them solid."
                        : "Space between rows. 1 keeps box-drawing rules solid, which is what a terminal is normally set to."}
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

                  <SettingsCard title="Mouse and clipboard"
                    desc="What pointing at a pane does, and what a selection does.">
                    {/* Off by default: focus that moves on its own is the one
                        terminal habit people either keep for life or cannot
                        stand, and a machine that has never been asked expects
                        the click. */}
                    <Toggle on={ffm} modified={ffm} onClick={() => { const v = !ffm; setting("terminal.focusFollowsMouse").set(v); setFfm(v); }}
                      settingId="terminal.focusFollowsMouse" label="Focus follows mouse"
                      hint="Hovering a terminal pane types into it, without a click first. Only terminals — the rest of the app still waits to be clicked." />
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
                      hint="Point at the seam along a pane's bottom edge and its branch, changes, pull request and card rise out of it." />
                    <Toggle on={copySel} modified={!copySel} onClick={() => { const v = !copySel; setting("terminal.copyOnSelect").set(v); setCopySel(v); }}
                      settingId="terminal.copyOnSelect" label="Copy on select"
                      hint="A selection is on the clipboard the instant you make it, the way tmux does it — no Ctrl+Shift+C." />
                    <Toggle on={rcPaste} modified={rcPaste} onClick={() => { const v = !rcPaste; setRightClickPaste(v); setRcPaste(v); }}
                      agentNever="a click then types the clipboard into a live shell: not something an agent switches on for the owner"
                      label="Right-click to paste"
                      hint="Right-click pastes the clipboard into the shell instead of opening the menu. Ctrl+right-click still opens it." />
                  </SettingsCard>

                  <SettingsCard title="Bench note"
                    desc="The note tab of the floating bench.">
                    <Choice<NoteEditor> settingId="terminal.noteEditor" label="Note editor" value={noteEd} modified={noteEd !== "builtin"}
                      hint="Neovim opens the same note file in a terminal on the bench. Without nvim installed the built-in editor is used."
                      options={NOTE_EDITORS} onPick={(v) => { setting("terminal.noteEditor").set(v); setNoteEd(v); }} />
                  </SettingsCard>

                  <SettingsCard title="Tab groups"
                    desc="With tmux, the tabs are grouped by the project each window is working in. The group you are in is open; the others fold into a chip that still shows what their agents are doing.">
                    <Toggle on={groupsOn} modified={!groupsOn} onClick={() => { const v = !groupsOn; setting("terminal.tabGroups").set(v); setGroupsOn(v); }}
                      settingId="terminal.tabGroups" label="Group tabs by project"
                      hint="Off draws every tab in one row, in tmux's order. Right-click a tab to pin it first in its group or move it to another; drag it onto a group to do the same." />
                    {/* The tie-break for a window whose folder is not its
                        project. None ship: a rule is a guess about how
                        somebody names things, and the folder is right for
                        everyone else. */}
                    <SettingRow
                      settingId="terminal.tabGroupRules" label="Group by name" modified={groupRules !== ""}
                      hint={<>A window whose name starts with a prefix goes to that group, whatever folder it runs in. Pairs like <span className="t-mono text-[11px]">agx=agentglass, ops=infra</span>. {parseRules(groupRules).length
                        ? `${parseRules(groupRules).length} ${parseRules(groupRules).length === 1 ? "rule" : "rules"} in use.`
                        : "None yet — windows are grouped by their folder."}</>}
                      below={
                        <input value={groupRules} onChange={(e) => setGroupRules(e.target.value)}
                          onBlur={() => { setting("terminal.tabGroupRules").set(groupRules); }}
                          onKeyDown={(e) => { if (e.key === "Enter") setting("terminal.tabGroupRules").set(groupRules); }}
                          placeholder="agx=agentglass" spellCheck={false} aria-label="Group-by-name rules"
                          className={`t-mono w-full max-w-[480px] ${INPUT}`}
                          style={INPUT_STYLE} />
                      } />
                  </SettingsCard>

                  <SettingsCard title="History and selection"
                    desc="How far back a shell remembers, and what a double-click takes.">
                    {/* Sizes rather than a number box: the cost is memory PER
                        SHELL and this app holds several open at once, so the
                        step from 4k to 50k is one somebody should take on
                        purpose. */}
                    <Choice<string>
                      settingId="terminal.scrollback" label="Scrollback"
                      hint={scrollback > DEFAULT_SCROLLBACK
                        ? `${scrollback.toLocaleString()} lines are kept per shell. Every line is cell data held in memory and reflowed on every resize — with several shells open, that is where a drag starts to stutter.`
                        : "How many lines each shell keeps. Applies live; the larger sizes cost memory per shell and make resizing slower."}
                      value={String(scrollback)} modified={scrollback !== DEFAULT_SCROLLBACK}
                      onPick={(v) => { const n = Number(v); setting("terminal.scrollback").set(n); setScrollbackState(n); }}
                      options={SCROLLBACK_SIZES.map((n) => ({ v: String(n), label: n >= 1000 ? `${n / 1000}k` : String(n) }))} />
                    <SettingRow
                      settingId="terminal.wordSeparators" label="Word separators"
                      modified={wordSep !== DEFAULT_WORD_SEPARATORS}
                      hint={<>
                        What a double-click stops at. Take out <code>/</code> — it is not there by default — and a path
                        selects whole; leave the box empty and a double-click takes the line.
                      </>}
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
                          className={`w-full max-w-[480px] ${INPUT}`}
                          style={{ ...INPUT_STYLE, fontFamily: "ui-monospace, monospace" }} />
                      } />
                  </SettingsCard>
                  <TerminalRunsOn open={open} />
                  </>)}
                  {ql && show("diff") && <PageMatchHeading id="diff" onOpen={() => { setPane("diff" as Pane); setQ(""); }} />}
                  {show("diff") && (
                  <SettingsCard title="How a diff opens"
                    desc="The view you land on, and what happens to a long line.">
                    {/* Defaults, not the live state: the toggle in each panel
                        still wins while you are looking at that diff. Changing
                        your mind about one file is not a preference. */}
                    <Choice<"split" | "inline">
                      settingId="diff.split"
                      label="Default view"
                      hint="How file changes, source control and pull requests open a diff. The toggle in each panel still overrides it for that diff."
                      value={dSplit ? "split" : "inline"} modified={dSplit !== DEFAULT_SPLIT}
                      onPick={(v) => { setting("diff.split").set(v); setDSplitState(v === "split"); }}
                      options={[{ v: "split", label: "Side by side" }, { v: "inline", label: "Inline" }]} />
                    <Toggle on={dWrap} modified={dWrap !== DEFAULT_WRAP} onClick={() => { const v = !dWrap; setting("diff.wrap").set(v); setDWrapState(v); }}
                      settingId="diff.wrap"
                      label="Wrap long lines"
                      hint="Wrap instead of scrolling sideways. Off keeps the columns aligned, which is what makes a code diff scannable; on is what a markdown or prose diff wants." />
                    <SettingRow
                      settingId="diff.syntaxTheme"
                      label="Diff syntax theme"
                      hint="The colours code takes in a diff. Auto follows the app's light or dark; the toolbar in a diff changes the same setting."
                      control={<span className="flex justify-end"><Select align="right" value={dTheme}
                        onChange={(v) => { setting("diff.syntaxTheme").set(v); setDThemeState(v); }}
                        options={[
                          { value: "auto", label: "Auto (app theme)" },
                          ...THEMES.map((t) => ({ value: t.id, label: t.label, hint: t.dark ? "Dark" : "Light" })),
                        ]} /></span>} />
                  </SettingsCard>
                  )}
                  {ql && show("tasks") && <PageMatchHeading id="tasks" onOpen={() => { setPane("tasks" as Pane); setQ(""); }} />}
                  {show("tasks") && (
                  <>
                  <SettingsCard title="Opens on" desc="Where the Tasks view starts.">
                    {/* There was no setting here before and no default either:
                        the tab was component state initialised to "all", so
                        every visit started over — on the one view that does not
                        include your ClickUp cards. See taskLanding.ts. */}
                    <SettingRow
                      settingId="tasks.landing" label="Tasks view opens on"
                      hint="Where the Tasks view lands when you come back to it. “Last used” picks up where you left off; naming a source pins it there whatever you did last. Following a card link from a pull request never changes this."
                      control={<span className="flex justify-end"><Select align="right" value={landing}
                        onChange={(v) => { setting("tasks.landing").set(v); setLandingState(v as TaskLanding); }}
                        options={[
                          { value: "last", label: "Last used" },
                          { value: "all", label: "All" },
                          ...TASK_SOURCES.map((s) => ({ value: s.id, label: s.label })),
                        ]} /></span>} />
                  </SettingsCard>
                  <SettingsCard title="Task sources"
                    desc="Which sources the bar offers, and in what order. One has to stay on, and a source you have not set up is left off by itself — until none is set up, when all of them show, because the bar is then the only place to find them. Connect them under Tools & services."
                    actions={<Button onClick={() => { resetTaskSourceOrder(); setSourceTick((n) => n + 1); }}>Reset order</Button>}>
                    {/* Order is the row's own, and the arrows move a source
                        through the FULL list rather than the visible one — see
                        moveTaskSource. Arrows rather than dragging: this pane's
                        every other control works from a keyboard, and a drop
                        target would be the one that does not. */}
                    {sourceOrder.map((id, i) => (
                      <SourceRow key={id} id={id} i={i} n={sourceOrder.length}
                        onChanged={() => setSourceTick((n) => n + 1)} />
                    ))}
                  </SettingsCard>
                  <CardTrackerSection />
                  </>
                  )}
                  {ql && show("privacy") && <PageMatchHeading id="privacy" onOpen={() => { setPane("privacy" as Pane); setQ(""); }} />}
                  {show("privacy") && <PrivacyPane open={open} />}
                  {show("privacy") && (
                  <SettingsCard title="Take your data out"
                    desc="Everything this app has recorded, in a format something else can read.">
                    {/* Scoped like everything else: with a project open these
                        carry that project's rows, not the whole machine's. */}
                    <Row label="Events — CSV" hint="One row per event, for a spreadsheet"
                      href={api.exportUrl("csv")} download="agentglass-events.csv" />
                    <Row label="Events — JSON" hint="Full payloads, for scripting"
                      href={api.exportUrl("json")} download="agentglass-events.json" />
                    {/* The only export that outlives retention: it reads the
                        daily rollup as well as the live events, so a month
                        that has already been pruned still comes out. */}
                    <Row label="Daily totals — CSV" hint="One row per day, back past the retention window"
                      href={api.exportUrl("csv", "daily")} download="agentglass-daily.csv" />
                    <Row label="Daily totals — JSON" hint="The same series, with where the retention seam falls"
                      href={api.exportUrl("json", "daily")} download="agentglass-daily.json" />
                    <Row label="Skills catalog — Markdown" hint="Every skill the fleet has available"
                      href={api.skillsExportUrl()} download="agentglass-skills.md" />
                  </SettingsCard>
                  )}
                  {ql && show("recipes") && <PageMatchHeading id="recipes" onOpen={() => { setPane("recipes" as Pane); setQ(""); }} />}
                  {show("recipes") && <RecipesPane open={open} />}
                  {ql && show("review-prompts") && <PageMatchHeading id="review-prompts" onOpen={() => { setPane("review-prompts" as Pane); setQ(""); }} />}
                  {show("review-prompts") && <ReviewPromptsPane open={open} />}
                  {ql && show("saved-replies") && <PageMatchHeading id="saved-replies" onOpen={() => { setPane("saved-replies" as Pane); setQ(""); }} />}
                  {show("saved-replies") && <SavedRepliesPane open={open} />}
                  {ql && show("prefs") && <PageMatchHeading id="prefs" onOpen={() => { setPane("prefs" as Pane); setQ(""); }} />}
                  {show("prefs") && (
                  <SettingsCard title="Size and startup"
                    desc="How big the window is, and what it does when the machine boots.">
                    {/* Desktop only, like launch-at-login: in a browser tab the
                        browser's own zoom already does this, and better. */}
                    {IS_DESKTOP && (
                      <Stepper
                        label="Display size"
                        hint={`Scales the whole window, and is remembered. ${MOD_KEY}+ / ${MOD_KEY}− anywhere, ${MOD_KEY}0 to reset — except over a terminal, where the same keys size the terminal instead and leave the window alone.`}
                        value={fmtScale(scale)} modified={scale !== DEFAULT_SCALE}
                        onDec={() => onZoom(-1)} onInc={() => onZoom(1)}
                        canDec={canZoomOut()} canInc={canZoomIn()} />
                    )}
                    <Toggle on={fullscreen} onClick={async () => setFullscreenState(await toggleFullscreen())}
                      label="Fullscreen"
                      hint="Hide the window frame — F11 anywhere" />
                    {autostart !== null && (
                      <Toggle on={autostart} onClick={async () => {
                        const next = await setAutostart(!autostart);
                        if (next !== null) setAutostartState(next);
                      }}
                        label="Start at login"
                        hint="Open agentglass automatically when you log in" />
                    )}
                    {/* Read before anything is drawn (web/index.html), so the
                        change shows at the next launch, not this one. */}
                    <Toggle on={splash} modified={!splash} onClick={() => { const v = !splash; setSplashOn(v); setSplash(v); }}
                      label="Launch animation"
                      hint="Covers the window while the terminal, sessions and git load, then the mark flies to the top bar. Off shows the plain loading screen. From the next launch" />
                    {/* Off is the default and off means nothing is watching:
                        with no client subscribed the server never starts the
                        D-Bus monitor at all. On a machine that cannot do this
                        the row stays but says why, rather than vanishing and
                        leaving you wondering whether you imagined it. */}
                    <Choice<"12" | "24">
                      label="Clock"
                      hint="The top bar shows the time in fullscreen, where the desktop's own clock is hidden"
                      value={h24 ? "24" : "12"}
                      onPick={(v) => { setClock24(v === "24"); setH24(v === "24"); }}
                      options={[{ v: "12", label: "12h" }, { v: "24", label: "24h" }]} />
                  </SettingsCard>
                  )}

                  {/* The engine and the memory it costs, together. Both used to
                      sit under "Preferences", which is where settings go when
                      nobody has decided where they belong — a page that mixes
                      window zoom with how a CLI is spawned is a drawer. */}
                  {ql && show("budgets") && <PageMatchHeading id="budgets" onOpen={() => { setPane("budgets" as Pane); setQ(""); }} />}
                  {show("budgets") && (
                  <>
                    {/* A limit you chose, so the spend insights stop firing on
                        constants — which are noise on a project that genuinely
                        costs that and silence on one where a tenth would be
                        alarming. */}
                    <BudgetsPane open={open} />
                    <PacePane />
                  </>
                  )}
                  {show("budgets") && <GhBudget open={open} />}
                  {show("budgets") && (
                  <SettingsCard title="Codex quota">
                    {/* Says what it costs, because it costs something: this
                        spends a little of the quota it is measuring. */}
                    <Toggle on={usageRefresh}
                      onClick={() => { setUsageRefreshOn(!usageRefresh); setUsageRefreshState(!usageRefresh); }}
                      label="Keep Codex usage current"
                      hint="Runs a minimal Codex turn hourly so the quota reading is not stale — uses a small amount of the quota it measures" />
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
                    talkMode={talkMode} onTalkMode={(v) => { setting("notifications.talk").set(v); setTalkMode(v); }}
                    sysNotify={sysNotify} notifyCap={notifyCap} />
                  )}

                  {ql && show("browser") && <PageMatchHeading id="browser" onOpen={() => { setPane("browser" as Pane); setQ(""); }} />}

                  {show("browser") && <><BrowserPane /><CookieImport /></>}

                  {ql && show("rail") && <PageMatchHeading id="rail" onOpen={() => { setPane("rail" as Pane); setQ(""); }} />}

                  {show("rail") && <RailPane />}

                  {ql && show("keys") && <PageMatchHeading id="keys" onOpen={() => { setPane("keys" as Pane); setQ(""); }} />}

                  {show("keys") && (
                  <>
                    {/*
                      * Grouped by WHERE the key works, not listed flat.
                      *
                      * Fourteen identical rows hid the only rule on the page —
                      * a view has two bindings because it is reachable from two
                      * places, and everything else has one because it is not.
                      * Two eyebrows say that without a paragraph, and the
                      * paragraph that used to say it is now a fold nobody has
                      * to read.
                      */}
                    {(() => {
                      const ids = Object.keys(DEFAULTS) as ActionId[];
                      const viewIds = ids.filter((id) => id.startsWith("view."));
                      const rest = ids.filter((id) => !id.startsWith("view."));
                      const row = (id: ActionId) => {
                        const view = id.startsWith("view.") ? (id.slice(5) as ViewId) : null;
                        return (
                          <KeyRow key={id} id={id} keyName={keys[id]}
                            capturing={capturing === id}
                            error={keyError?.id === id ? keyError.msg : null}
                            onCapture={() => { setKeyError(null); setCapturingChord(null); setCapturing((c) => (c === id ? null : id)); }}
                            chord={view ? {
                              key: chordFor(view),
                              custom: hasCustomChord(view),
                              capturing: capturingChord === view,
                              onCapture: () => { setKeyError(null); setCapturing(null); setCapturingChord((c) => (c === view ? null : view)); },
                              onClear: () => { clearChord(view); setKeys({ ...bindings() }); },
                            } : undefined} />
                        );
                      };
                      return (
                        <>
                          {/*
                            * Its own group, above the rest, because it is the
                            * only binding on this page that keeps working with
                            * the caret inside a running shell — the terminal is
                            * told to hand it over rather than pass it to the
                            * PTY. That is also why it is the one most likely to
                            * collide with something you already use, and so the
                            * one that most needs to be movable.
                            */}
                          <SettingsCard title="Even inside a shell"
                            desc={<>The terminal gives this one up so it reaches the app. Pick something your
                            shell does not want — the shipped {chordLabel(APP_CHORD_DEFAULTS["files.palette"])} is
                            free in bash, tmux and vim; plain Ctrl+P is not.</>}>
                          {(Object.keys(APP_CHORD_LABELS) as AppChordId[]).map((id) => (
                            <SettingRow key={id}
                              label={<span onClick={() => { setKeyError(null); setCapturing(null); setCapturingChord(null); setCapturingApp((c) => (c === id ? null : id)); }}
                                className="cursor-pointer">{APP_CHORD_LABELS[id].label}</span>}
                              hint={<span style={{ color: appKeyError?.id === id ? "var(--error)" : undefined }}
                                className={appKeyError?.id === id ? "" : "t-dim"}>
                                {appKeyError?.id === id ? appKeyError.msg : APP_CHORD_LABELS[id].hint}
                              </span>}
                              control={<span className="flex items-center gap-1.5 justify-self-end">
                                <button onClick={() => { setKeyError(null); setCapturing(null); setCapturingChord(null); setCapturingApp((c) => (c === id ? null : id)); }}
                                  title={hasCustomAppChord(id)
                                    ? `${chordLabel(appChordFor(id))} opens this — click to record another`
                                    : `${chordLabel(appChordFor(id))} opens this — click to record your own`}
                                  className="chip h-[22px] justify-center text-[11px] tabular-nums min-w-[110px] text-center"
                                  style={capturingApp === id
                                    ? { color: "var(--primary-hover)", borderColor: "color-mix(in srgb, var(--primary) 60%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }
                                    : hasCustomAppChord(id) ? { color: "var(--primary-hover)" } : { color: "var(--text2)" }}>
                                  {capturingApp === id ? "Hold a combo…" : chordLabel(appChordFor(id))}
                                </button>
                              </span>} />
                          ))}
                          </SettingsCard>
                          {rest.length > 0 && (
                            <SettingsCard title="Anywhere"
                              desc="A held combination, so it cannot be swallowed by whatever has focus.">
                              {rest.map(row)}
                            </SettingsCard>
                          )}
                          {viewIds.length > 0 && (
                            <SettingsCard title="Only on the dashboard"
                              desc="A single key each — inside the workspace every keystroke belongs to a shell. The second column is the chord that reaches them from in there.">
                              {viewIds.map(row)}
                              {/* Says why the rest of the keyboard is not on this list.
                                  Read once, by somebody wondering why their key was
                                  refused — so it waits to be asked. */}
                              <SettingRow agentExempt label="Anywhere and dashboard"
                                hint="Why some views have two keys and the rest one."
                                detail={{
                                  summary: "Why some keys are two columns and others one",
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
                          )}
                        </>
                      );
                    })()}
                    {(isCustomised() || chordsCustomised() || appChordsCustomised()) && (
                      <SettingsCard title="Defaults">
                        <SettingRow
                          agentExempt label="Reset to defaults"
                          hint="Puts every key and every chord back to the shipped one."
                          actions={<Button onClick={() => { resetBindings(); resetChords(); resetAppChords(); setKeyError(null); setAppKeyError(null); setCapturing(null); setCapturingChord(null); setCapturingApp(null); }}>
                            Reset
                          </Button>}
                        />
                      </SettingsCard>
                    )}
                  </>
                  )}

                  {ql && show("lantern") && <PageMatchHeading id="lantern" onOpen={() => { setPane("lantern" as Pane); setQ(""); }} />}
                  {show("lantern") && <LanternSection open={open} />}
                  {ql && show("engines") && <PageMatchHeading id="engines" onOpen={() => { setPane("engines" as Pane); setQ(""); }} />}
                  {show("engines") && <EnginesPane />}
                  {ql && show("hooks") && <PageMatchHeading id="hooks" onOpen={() => { setPane("hooks" as Pane); setQ(""); }} />}

                  {show("hooks") && <>
                    <HooksPane open={open} />
                    {cu && (
                      <SettingsCard title="Cards" desc="How agent skills relate to the cards of your tracker.">
                        <CardSkillsRow connected />
                      </SettingsCard>
                    )}
                    <SettingsCard title="New chats"
                      desc="What a chat gets when it starts.">
                      {/* Merged from a separate "Chat" page: this and the tmux
                          binary above answer the same question — what a pane
                          actually runs on — and a person who came here to
                          change the prefix key is the same person who wants
                          to know whether a new chat gets one of these. */}
                      <Choice<"server" | "process" | "tmux">
                        label="How new chats run"
                        hint={
                          tmuxEngine && !tmuxEngine.available
                            ? `tmux panes unavailable: ${tmuxEngine.reason}. Chats still run, one process per turn. See Requirements for how to add tmux.`
                            : "Panes keep a warm claude per chat: faster turns, and you can attach from your terminal. Separate takes longer per turn and leaves nothing running."
                        }
                        disabled={tmuxEngine ? !tmuxEngine.available : true}
                        disabledHint={tmuxEngine ? `Unavailable: ${tmuxEngine.reason}` : "Checking…"}
                        value={enginePref ?? "server"}
                        onPick={(v) => {
                          const next = v === "server" ? null : v;
                          setChatEnginePref(next);
                          setEnginePref(next);
                        }}
                        options={[
                          { v: "server", label: tmuxEngine?.defaultOn ? "Default (panes)" : "Default (separate)" },
                          { v: "process", label: "Separate" },
                          { v: "tmux", label: "tmux panes" },
                        ]} />
                    </SettingsCard>
                    {tmuxEngine?.available && <RunningPanes open={open} />}
                    {HAS_BROWSER && <AgentBrowserPane open={open} />}
                    <AgentsSection /><WorkerRolesSection open={open} />
                  </>}

                  {ql && show("tmux") && <PageMatchHeading id="tmux" onOpen={() => { setPane("tmux" as Pane); setQ(""); }} />}

                  {show("tmux") && (
                  <>
                    <TmuxPane open={open} onGoTerminal={() => { setPane("terminal" as Pane); setQ(""); }} />
                  </>
                  )}
                  {ql && show("connections") && <PageMatchHeading id="connections" onOpen={() => { setPane("connections" as Pane); setQ(""); }} />}
                  {show("connections") && <><RequirementsPane open={open} /><IntegrationsPane open={open} /></>}
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

