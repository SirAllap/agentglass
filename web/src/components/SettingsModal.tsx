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
import { Fragment, createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RecipesPane } from "./RecipesPane.tsx";
import { lastTerminalRoot } from "./TerminalPanel.tsx";
import { Filter, Fold, SettingRow } from "./SettingRow.tsx";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { api } from "../lib/api.ts";
import { browserPlaces, CAN_IMPORT_COOKIES, cookieSources, importCookies, forgetCookies, type CookieSource, type CookieImportReply } from "../lib/desktop.ts";
import { loadProfiles } from "../lib/browserProfiles.ts";
import { addVisible, allSites, bestSource, dropVisible, lockedWhy, reachable, siteView } from "../lib/cookiePick.ts";
import { PROVIDERS, type ProviderSpec, type ProviderStatus, type ProviderState } from "../../../shared/providers.ts";
import { fmtAgo } from "../lib/format.ts";
import type { ActionRecord, GateRecord } from "../../../shared/types.ts";
import { mergeActivity, gateLine, actorLabel, type ActivityRow } from "../lib/activity.ts";
import { ingestUpdate } from "../lib/updateStore.ts";
import { ReleaseNotesModal } from "./ReleaseNotesModal.tsx";
import { installedNotes, type NotesTarget } from "../lib/whatsNew.ts";
import { autostartEnabled, setAutostart, isFullscreen, toggleFullscreen, IS_DESKTOP, HAS_BROWSER } from "../lib/desktop.ts";
import { Select } from "./Select.tsx";
import { SEARCH_ENGINE_LABELS, type SearchEngine } from "../lib/browserUrl.ts";
import { homePageRaw, setHomePage, searchEngine, setSearchEngine, importHistory, setImportHistory, importBookmarks, setImportBookmarks, pickImportRows } from "../lib/browserPrefs.ts";
import { RemoteAccessPane } from "./RemoteAccessPane.tsx";
import { RunningPanes } from "./RunningPanes.tsx";
import { BudgetsPane } from "./BudgetsPane.tsx";
import { AgentsPane } from "./AgentsPane.tsx";
import { rendererPref, setRendererPref, type RendererPref } from "../lib/termRenderer.ts";
import { TERM_FONTS, CURSORS, fontAvailable, currentTermFont, currentTermSize, currentTermCursor, currentTermLineHeight, setTermFont, setTermSize, setTermCursor, setTermLineHeight, SIZE_MIN, SIZE_MAX, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, type CursorStyle } from "../lib/termPrefs.ts";
import { focusFollowsMouse, setFocusFollowsMouse } from "../lib/termFocusPref.ts";
import { diffSplit, diffWrap, setDiffSplit, setDiffWrap } from "../lib/diffPrefs.ts";
import {
  TASK_SOURCES, taskSourceShown, setTaskSourceShown,
  orderedTaskSources, moveTaskSource, resetTaskSourceOrder, type TaskSourceId,
} from "../lib/taskSources.ts";
import { taskLanding, setTaskLanding, type TaskLanding } from "../lib/taskLanding.ts";
import {
  SCROLLBACK_SIZES, DEFAULT_SCROLLBACK, DEFAULT_WORD_SEPARATORS,
  currentScrollback, currentWordSeparators, copyOnSelect, rightClickPaste,
  setScrollback, setWordSeparators, setCopyOnSelect, setRightClickPaste,
} from "../lib/termPrefs.ts";
import { canZoomIn, canZoomOut, fmtScale } from "../lib/uiScale.ts";
import { MOD_KEY } from "../lib/format.ts";
import { externalUrl } from "../lib/externalUrl.ts";
import type { UpdateStatus, ReleaseNotes, HookSetupStatus, BrowserUseStatus } from "../../../shared/types.ts";
import {
  sysNotifyMode, setSysNotifyMode, setSysNotifyOn, subscribeSysNotifyMode,
  notifyCapability, notifyQuiet, setNotifyQuiet, subscribeNotifyQuiet,
  appNotify, setAppNotify, subscribeAppNotify,
  type SysNotifyMode, type NotifyCapability,
} from "../lib/sysNotify.ts";
import { chatEnginePref, setChatEnginePref, type ChatEnginePref } from "../lib/chatEnginePref.ts";
import type { TmuxEngineInfo } from "../../../shared/types.ts";
import type { DepReport, DepStatus } from "../../../shared/deps.ts";
import { clock24, setClock24 } from "../lib/clockPref.ts";
import { usageRefreshOn, setUsageRefreshOn } from "../lib/usageRefreshPref.ts";
import { bindings, rebind, resetBindings, subscribeBindings, isCustomised, LABELS, DEFAULTS, type ActionId,
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
import { ICON } from "../lib/iconSize.ts";
import { ciOnlyApproved, setCiOnlyApproved } from "../lib/ciNotifyPref.ts";

/** A heading inside a Section, for a pane that answers the same question about
 *  two different sources. Without it "Quiet" and "Alert sounds" sit in one flat
 *  list and you have to read every hint to work out which switch is about your
 *  machine and which is about this app. */
function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-2.5 pb-0.5">
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
  action?: { label: string; onClick: () => void; busy?: boolean };
}

function SetupCard({ title, steps, note, error }: {
  title: string; steps: SetupStep[]; note?: string | null; error?: string | null;
}) {
  const known = steps.filter((s) => s.done !== null);
  const done = known.filter((s) => s.done).length;
  const all = known.length > 0 && done === known.length;
  return (
    <div className="mb-5 rounded-xl overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", background: "var(--bg2)" }}>
      <div className="flex items-center gap-3 px-4 py-2.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
        <span className="text-[13.5px] font-medium" style={{ color: "var(--text)" }}>{title}</span>
        <span className="ml-auto text-[11.5px] tabular-nums px-2 py-0.5 rounded-full"
          style={all
            ? { color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)" }
            : { color: "var(--text3)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>
          {done} of {known.length} done
        </span>
      </div>
      <ol className="flex flex-col">
        {steps.map((st, i) => (
          <li key={st.title} className="grid items-start gap-x-3 px-4 py-3"
            style={{ gridTemplateColumns: "20px minmax(0,1fr) auto", borderTop: i === 0 ? undefined : "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
            <span className="mt-[1px] w-5 h-5 rounded-full grid place-items-center text-[10.5px] tabular-nums shrink-0"
              style={st.done === true
                ? { color: "var(--success)", background: "color-mix(in srgb, var(--success) 16%, transparent)" }
                : st.done === false
                  ? { color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 16%, transparent)" }
                  : { color: "var(--text4)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>
              {st.done === true ? "✓" : i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px]" style={{ color: "var(--text)" }}>{st.title}</span>
              {st.detail && <span className="block text-[12px] t-dim mt-0.5">{st.detail}</span>}
            </span>
            <span className="justify-self-end">
              {st.action
                ? <button onClick={st.action.onClick} disabled={st.action.busy}
                    className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
                    style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)", opacity: st.action.busy ? 0.5 : 1 }}>
                    {st.action.label}
                  </button>
                : st.done === null
                  ? <span className="text-[11.5px]" style={{ color: "var(--text4)" }}>your turn</span>
                  : null}
            </span>
          </li>
        ))}
      </ol>
      {(error || note) && (
        <div className="px-4 py-2 text-[12px]" style={{ color: error ? "var(--error)" : "var(--text2)", borderTop: "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
          {error || note}
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onClick, label, hint, disabled }: {
  on: boolean; onClick: () => void; label: string; hint: string;
  /** A host that cannot do this at all — the row stays, greyed, saying why in
   *  its hint, because a switch that vanishes reads as a feature you imagined. */
  disabled?: boolean;
}) {
  return (
    <SettingRow label={label} hint={hint} onClick={onClick} disabled={disabled}
      role="switch" ariaChecked={on}
      /* A real switch: position carries the state, so it reads at a glance
         instead of having to be parsed. */
      control={<Switch on={on} />} />
  );
}

/** The switch itself, without the row around it. Split out because the task
 *  sources need one inside a row that is NOT a button — see SourceRow. */
function Switch({ on }: { on: boolean }) {
  return (
    <span className="relative rounded-full transition-colors block" style={{
      width: 34, height: 19,
      background: on ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)",
    }}>
      <span className="absolute rounded-full transition-transform" style={{
        width: 15, height: 15, top: 2, left: 2,
        transform: on ? "translateX(15px)" : "translateX(0)",
        background: on ? "var(--primary-hover)" : "var(--text3)",
      }} />
    </span>
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
    <SettingRow label={s.label} hint={s.what}
      control={
        <span className="flex items-center gap-2.5 justify-self-end">
          <span className="flex flex-col shrink-0" style={{ gap: 1 }}>
            {([-1, 1] as const).map((by) => (
              <button key={by}
                onClick={() => { moveTaskSource(id, by); onChanged(); }}
                disabled={by === -1 ? i === 0 : i === n - 1}
                aria-label={`Move ${s.label} ${by === -1 ? "earlier" : "later"}`}
                className="agx-btn leading-none px-1 rounded disabled:opacity-25"
                style={{ color: "var(--text3)", fontSize: 7 }}>
                {by === -1 ? "▲" : "▼"}
              </button>
            ))}
          </span>
          <button role="switch" aria-checked={on} aria-label={s.label}
            onClick={() => { setTaskSourceShown(id, !on); onChanged(); }}
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
function Choice<T extends string>({ label, hint, value, options, onPick, disabled, disabledHint }: {
  label: string; hint: string; value: T; options: { v: T; label: string }[];
  onPick: (v: T) => void; disabled?: boolean; disabledHint?: string;
}) {
  return (
    <SettingRow label={label} hint={disabled ? disabledHint ?? hint : hint} disabled={disabled}
      control={
        <span className="flex items-center gap-1 rounded-lg p-0.5 justify-self-end"
          style={{ background: "color-mix(in srgb, var(--border) 28%, transparent)" }}>
          {options.map((o) => (
            <button key={o.v} onClick={() => onPick(o.v)} disabled={disabled}
              aria-pressed={value === o.v}
              className="text-[12px] px-2 py-1 rounded-md transition-colors disabled:cursor-not-allowed whitespace-nowrap"
              style={value === o.v
                ? { background: "color-mix(in srgb, var(--primary) 55%, transparent)", color: "var(--text)" }
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
function Stepper({ label, hint, value, onDec, onInc, canDec, canInc }: {
  label: string; hint: string; value: string; onDec: () => void; onInc: () => void; canDec: boolean; canInc: boolean;
}) {
  const btn = "w-7 h-7 rounded-md text-[14px] leading-none flex items-center justify-center disabled:opacity-30 enabled:hover:bg-white/10";
  const border = "1px solid color-mix(in srgb, var(--border) 55%, transparent)";
  return (
    <SettingRow label={label} hint={hint}
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

function Row({ label, hint, kbd, href, download, onClick }: { label: string; hint: string; kbd?: string; href?: string; download?: string; onClick?: () => void }) {
  return (
    <SettingRow label={label} hint={hint} href={href} download={download} onClick={href ? undefined : onClick}
      control={kbd ? <kbd className="chip text-[11px] t-dim justify-self-end">{kbd}</kbd> : undefined} />
  );
}

type Pane = "recipes" | "appearance" | "prefs" | "terminal" | "diff" | "tasks" | "privacy" | "chat" | "notifications" | "browser" | "rail" | "keys" | "open" | "export" | "log" | "budgets" | "hooks" | "connections" | "remote" | "about";
/** "" is the ungrouped tail: a heading over one item is a rule that separates
 *  nothing, so About sits alone at the foot of the nav. */
type TabGroup = "Interface" | "Agents & work" | "Connections" | "Your data" | "";
// Rendered in this order; a group with no matching tab is dropped, so search
// collapses to just the sections that still have something in them.
/*
 * Four rings, outward from you.
 *
 * "Data" was a junk drawer and it is worth naming why, because the failure has
 * a name: NN/g calls a group defined by what its members are NOT — "More",
 * "Tools", "Data" — a bucket with low information scent, and says it comes
 * from having a list of features and nowhere to put them. Ours held a view
 * filter (Tasks), a money policy (Budgets), a log (Activity), a launcher
 * (Open), an authoring surface (Commands) and five download links (Export).
 * They shared nothing except not being Interface and not being Setup.
 *
 * The rings are: what you look at, what works for you, what it reaches out to,
 * and what it keeps. A pane is filed under the OBJECT it configures, never
 * under how often it is opened — frequency is personal and it moves, objects
 * do not.
 *
 * Privacy and About were groups of one. A header over a single item is a rule
 * that separates nothing, so they join the ring they belong to; that takes the
 * nav from 5 headers over 21 items to 4 over 21.
 */
const TAB_GROUPS: TabGroup[] = ["Interface", "Agents & work", "Connections", "Your data", ""];
// `kw` are the words the search box also matches — the things people call a
// setting that aren't in its label ("keyboard" for Shortcuts, "theme" for
// Appearance), so the box finds a page by what it does, not just its name.
const LAST_PANE_KEY = "agentglass.settings.pane";

/**
 * One line per page, above whatever it holds.
 *
 * Sections say what a group of rows is; nothing said what the PAGE was. On a
 * list of twenty that is the difference between reading the title and knowing
 * whether you are in the right place — and it is where a page can be honest
 * about its own scope ("only terminals", "paths, not contents") without
 * repeating it in every hint underneath.
 */
const TABS: { id: Pane; label: string; group: TabGroup; kw: string; what?: string }[] = [
  { id: "prefs", label: "Preferences", group: "Interface", kw: "display size zoom sound clock fullscreen start login", what: "The window itself — size, sound, and how it starts." },
  { id: "appearance", label: "Appearance", group: "Interface", kw: "theme accent colour color font dark light mode palette", what: "Theme, accent and how dense the app is drawn." },
  { id: "terminal", label: "Terminal", group: "Interface", kw: "terminal font size cursor typography monospace face renderer gpu focus follows mouse hover pane sloppy", what: "Type, renderer, mouse and how much scrollback each shell keeps." },
  { id: "chat", label: "Chat", group: "Agents & work", kw: "chat engine tmux panes warm cli claude how new chats run", what: "How a new chat runs, and where." },
  { id: "diff", label: "Diff", group: "Interface", kw: "diff split side by side inline unified wrap word wrap changes review default view", what: "How a diff opens, everywhere the app shows one." },
  { id: "tasks", label: "Tasks", group: "Agents & work", kw: "tasks sources github issues local taskwarrior clickup hide show providers", what: "Which sources the Tasks view offers you." },
  // Only where there is a browser to configure. A settings tab for something
  // that is not there reads as a broken feature rather than one that doesn't apply.
  // ONE browser page.
  //
  // This was two — "Browser" for the home page and "Agent browser" for
  // everything else, including the login importer. Nobody looking for their
  // logins looks under a heading about agents, and the browser's own menu sent
  // people to the wrong one of the two because I picked the obvious name. A
  // setting is filed under the thing it configures.
  ...(HAS_BROWSER ? [{ id: "browser" as const, label: "Browser", group: "Interface" as const, kw: "browser web page zoom agent cli skill automation drive login cookies import chrome firefox zen profile", what: "The built-in browser: how it opens, your logins, and whether an agent can drive it." }] : []),
  { id: "notifications", label: "Notifications", group: "Interface", kw: "notifications sound alert desktop notify quiet chime ping", what: "What is allowed to interrupt you, and how." },
  // Next to Shortcuts on purpose: which drawer a view sits in is what decides
  // whether it has a number, so the two pages answer one question between them.
  { id: "rail", label: "Rail", group: "Interface", kw: "rail sidebar views order icons hide show reorder tabs drawer group arrange", what: "Which views are on the rail, in which drawer, and in what order." },
  { id: "keys", label: "Shortcuts", group: "Interface", kw: "keyboard keys bindings shortcut chord rebind", what: "Every binding, rebindable." },
  { id: "budgets", label: "Budgets", group: "Agents & work", kw: "budget spend cost limit money threshold", what: "What the fleet may spend before it says something." },
  { id: "log", label: "Activity", group: "Your data", kw: "activity log history events feed", what: "What the app itself has been doing." },
  { id: "open", label: "Opening files", group: "Interface", kw: "open external editor file reveal", what: "What opens a file when you ask for it outside the app." },
  { id: "recipes", label: "Commands", group: "Agents & work", kw: "commands recipes custom script make run shortcut alias task saved own", what: "Commands you keep, with the parts that change asked for when you run them." },
  { id: "export", label: "Export", group: "Your data", kw: "export download data json csv", what: "Take your data out, in a shape a spreadsheet or a script can read." },
  { id: "hooks", label: "Agents", group: "Agents & work", kw: "agents hooks claude code install setup", what: "Wire Claude Code into this app, and see what else is installed." },
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
  { id: "connections", label: "Tools & services", group: "Connections", kw: "requirements dependencies deps tmux git docker install integrations providers connect github gitlab clickup taskwarrior token api credentials account rate limit budget quota", what: "The tools and services this app leans on, and whether they are ready." },
  { id: "remote", label: "Remote", group: "Connections", kw: "remote access pair phone tailscale token device", what: "Reach this machine from your phone." },
  { id: "privacy", label: "Privacy", group: "Your data", kw: "privacy telemetry data local storage retention database credentials tokens tracking analytics who sees", what: "Where your data is, and what leaves this machine." },
  { id: "about", label: "About", group: "", kw: "about version update release notes changelog", what: "Version, release notes and updates." },
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
    <Section>
      <p className="py-3 text-[12px] t-dim">
        The pages the browser view opens on its own. Everything else — what you have logged into,
        what you have open — belongs to the page, not to a setting.
      </p>

      <SettingRow
        align="start"
        label="Home page"
        hint={<>
          Where the view opens, and where Home goes. Leave it empty for a blank page.
          {bad && (
            <span className="block mt-1" style={{ color: "var(--error)" }}>
              That is not an address this will open — it takes http(s), or nothing at all.
            </span>
          )}
        </>}
        control={<span className="flex items-center gap-1.5">
          <input
            value={home}
            onChange={(e) => { setHome(e.target.value); setBad(false); setSaved(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
            placeholder="https://duckduckgo.com"
            spellCheck={false}
            className="text-[12px] px-2 py-1 rounded outline-none bg-transparent w-[210px]"
            style={{
              color: "var(--text)",
              border: `1px solid color-mix(in srgb, ${bad ? "var(--error) 60%" : "var(--border) 55%"}, transparent)`,
            }}
          />
          <button onClick={save}
            className="agx-btn text-[12px] px-2 py-1 rounded"
            style={{ border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", color: "var(--text2)" }}>
            {saved ? "Saved" : "Save"}
          </button>
        </span>}
      />

      <SettingRow
        label="Search engine"
        hint="Used when what you type in the address bar is words rather than an address."
        control={<Select
          value={engine}
          options={(Object.keys(SEARCH_ENGINE_LABELS) as SearchEngine[]).map((id) => ({ value: id, label: SEARCH_ENGINE_LABELS[id] }))}
          onChange={(v) => { setEngine(v as SearchEngine); setSearchEngine(v as SearchEngine); }}
          align="right"
        />}
      />
    </Section>
  );
}

const PLACE_LABEL: Record<RailPlace, string> = { work: "Top group", utility: "Bottom group", hidden: "Hidden" };
const PLACE_NOTE: Record<RailPlace, string> = {
  work: "Where you work. The only group the numbers count through — ⌘1 to ⌘9, in this order.",
  utility: "What you go and look at, down with settings and ports. No numbers here; record a combination on the Shortcuts page if one of these needs a key.",
  hidden: "Off the rail. Nothing is lost — put one back from here, or from the ＋ at the foot of the rail.",
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
  const ids = railIds(rail);
  /** Which view is being dragged, and where it would land. Held here rather
   *  than per row: a drop target has to know what is coming. */
  const [drag, setDrag] = useState<{ id: ViewId; from: RailPlace } | null>(null);

  return (
    <Section>
      {/* Twenty views, three drawers, five controls each: the one thing that
          makes this readable is that the controls of every view land on the
          same lines, and that is what the row grid is for. The icon rides in
          the label — a column of its own for 20px is how this page ended up
          drawing to a different left edge than the rest of the dialog. */}
      {/* A Fragment, not a div: the column's padding rule applies to the direct
          children of a section, so a wrapper here would indent its rows twice —
          and with five controls on the right, the second indent is enough to
          push them over the words. Measured it doing exactly that. */}
      {(Object.keys(PLACE_LABEL) as RailPlace[]).map((place) => (
        <Fragment key={place}>
          <div className="panel-eyebrow pt-3 pb-1">{PLACE_LABEL[place]}</div>
          <div className="text-[12px] t-dim pb-1.5">{PLACE_NOTE[place]}</div>

          {rail[place].length === 0 ? (
            <div className="py-2 text-[12px] t-dim">
              {place === "hidden" ? "Nothing put away." : "Empty — drag something here, or use the buttons on the right."}
            </div>
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
               */
              <div key={v.id}
                draggable
                onDragStart={(e) => { setDrag({ id: v.id, from: place }); e.dataTransfer.effectAllowed = "move"; }}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => { if (drag && drag.id !== v.id) e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!drag || drag.id === v.id) return;
                  // Dropped ONTO a row means "take its place", which is the
                  // only reading that needs no insertion line to explain it.
                  moveView(drag.id, place, i);
                  setDrag(null);
                }}
                style={{ opacity: drag?.id === v.id ? 0.4 : 1, cursor: "grab" }}>
              <SettingRow
                label={<span className="flex items-center gap-2.5 min-w-0">
                  <span className="shrink-0 select-none" style={{ color: "var(--text4)" }} aria-hidden title="Drag to reorder">⠿</span>
                  <span className="shrink-0 grid place-items-center w-5" style={{ color: "var(--text2)" }}><Icon size={ICON.md} /></span>
                  <span className="truncate">{v.label}</span>
                </span>}
                hint={<span className="block truncate pl-[30px]">{v.hint}</span>}
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
                  <span className="text-[11px] tabular-nums w-[52px] text-right"
                    style={{ color: chord ? "var(--text2)" : undefined, opacity: chord ? 0.75 : 0.35 }}>
                    {chord ? chordLabel(chord) : "—"}
                  </span>
                  {/* Order only matters where the rail draws it, and in the top
                      group it also decides which number you get. Kept out of
                      sight until wanted: `agx-reveal` is opacity-only, so the
                      row does not change width when they appear. */}
                  <span className="agx-reveal flex items-center gap-0.5 w-[46px]">
                    {place !== "hidden" && (
                      <>
                        <MiniBtn label="Move up" disabled={i === 0} onClick={() => moveView(v.id, place, i - 1)}>↑</MiniBtn>
                        <MiniBtn label="Move down" disabled={i === rail[place].length - 1} onClick={() => moveView(v.id, place, i + 1)}>↓</MiniBtn>
                      </>
                    )}
                  </span>
                  <Select
                    align="right"
                    value={place}
                    onChange={(p) => moveView(v.id, p as RailPlace, p === "work" ? ids.work.length : 0)}
                    options={(Object.keys(PLACE_LABEL) as RailPlace[]).map((p) => ({
                      value: p,
                      label: p === "work" ? "Top" : p === "utility" ? "Bottom" : "Hidden",
                      hint: PLACE_LABEL[p],
                    }))}
                  />
                </span>}
              />
              </div>
            );
          })}
        </Fragment>
      ))}

      <SettingRow
        label="On the rail itself"
        hint={<><b style={{ color: "var(--text2)" }}>Drag</b> an icon between the groups — a gap opens where it will land — or drop it on the dashed square at the bottom to put it away. <b style={{ color: "var(--text2)" }}>Right-click</b> any icon for the same moves, and <b style={{ color: "var(--text2)" }}>Alt+↑/↓</b> does it from the keyboard.</>}
        control={railCustomised()
          ? <button onClick={resetRail} className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
              style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
              Reset the rail
            </button>
          : undefined}
      />
    </Section>
  );
}

function MiniBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className="w-[20px] h-[20px] grid place-items-center rounded-md text-[11px] hover:bg-white/10"
      style={{ color: "var(--text2)", opacity: disabled ? 0.25 : 0.8 }}>
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
function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    /* agx-settings-section: when a search has hidden every row inside it, the
       heading goes with them. A lone eyebrow over nothing reads as a section
       whose contents failed to load. */
    <div className="pb-5 agx-settings-section">
      {title && <div className="panel-eyebrow pb-1">{title}</div>}
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
    <SettingRow
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
              ? `${chordLabel(chord.key)} opens this — click to record another, ✕ to go back to its rail position`
              : chord.key
                ? `${chordLabel(chord.key)} opens this, from its position in the top group — click to record your own`
                : "Only the top group is numbered — click to record a combination for this one"}
            className="chip text-[11px] tabular-nums min-w-[74px] text-center"
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
        <button onClick={onCapture} className="chip text-[11px] tabular-nums min-w-[74px] text-center"
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
      api.gateHistory(200).then((r) => r.gates).catch(() => [] as GateRecord[]),
    ]).then(([a, g]) => { if (alive) setRows(mergeActivity(a, g)); });
    return () => { alive = false; };
  }, [open]);

  if (!rows) return <Section><div className="px-3 py-3 text-[11.5px] t-dim2">Loading…</div></Section>;
  if (!rows.length) {
    return (
      <Section>
        <div className="py-3 text-[12.5px] t-dim">
          Nothing yet. Every write this dashboard performs — staging, discarding, pushing,
          merging, container actions, gate decisions — is recorded here as it happens.
        </div>
      </Section>
    );
  }

  return (
    <Section>
      <div className="pb-2 text-[12px] t-dim">
        Newest first. Kept indefinitely — these are the changes you made, not telemetry.
        Held tool calls appear here whoever resolved them, including the ones the timeout
        decided while nobody was looking.
      </div>
      {/* No wrapper: a padded div around the lines would indent them past the
          column's edge, which every other page sits on. */}
      {rows.map((r) => (r.kind === "gate" ? <GateLine key={r.key} g={r.row} /> : <ActionLine key={r.key} a={r.row} />))}
    </Section>
  );
}

/** The right-hand column: who, then how long ago. Shared so a gate line and a
 *  git line cannot drift into two different ways of saying the same thing. */
function Who({ actor, at }: { actor: string; at: number }) {
  return (
    <span className="text-[9.5px] t-dim2 tabular-nums shrink-0 text-right">
      {actor && `${actor} · `}{fmtAgo(at)}
    </span>
  );
}

function ActionLine({ a }: { a: ActionRecord }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 items-baseline py-1.5 rounded-lg agx-hover">
      <span
        className="text-[9.5px] font-semibold tabular-nums shrink-0"
        style={{ color: a.ok ? "var(--text4)" : "var(--error)" }}
        title={a.ok ? "succeeded" : a.detail || "failed"}
      >
        {a.ok ? "·" : "✕"}
      </span>
      <span className="min-w-0">
        <span className="text-[11.5px]" style={{ color: "var(--text)" }}>{verb(a.action)}</span>
        {a.target && <span className="text-[11.5px] t-dim"> {a.target}</span>}
        {!a.ok && a.detail && <span className="block text-[10px] mt-0.5" style={{ color: "var(--error)" }}>{a.detail}</span>}
      </span>
      <Who actor={actorLabel({ kind: "action", at: a.at, key: "", row: a })} at={a.at} />
    </div>
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
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 items-baseline py-1.5 rounded-lg agx-hover">
      <span
        className="text-[9.5px] font-semibold tabular-nums shrink-0"
        style={{ color: nobody ? "var(--warning)" : g.decision === "deny" ? "var(--error)" : "var(--text4)" }}
        title={nobody ? "nobody decided this" : "decided by a person"}
      >
        {nobody ? "⏱" : "·"}
      </span>
      <span className="min-w-0">
        <span className="text-[11.5px]" style={{ color: "var(--text)" }}>{did}</span>
        <span className="text-[11.5px] t-dim"> {g.tool_name}{g.summary ? ` · ${g.summary}` : ""}</span>
        {note && <span className="block text-[10px] mt-0.5" style={{ color: "var(--warning)" }}>{note}</span>}
        {/* The reason a person typed, which lives nowhere else: the agent was
            given it and the action log never carried it. */}
        {g.resolution === "human" && g.reason && (
          <span className="block text-[10px] mt-0.5 t-dim2">“{g.reason}”</span>
        )}
      </span>
      <Who actor={actorLabel({ kind: "gate", at: g.decided_at ?? 0, key: "", row: g })} at={g.decided_at ?? 0} />
    </div>
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
  "/git/apply-hunk": "staged a hunk", "/git/undo-merge": "undid the merge",
  "/git/worktree-add": "added worktree", "/git/worktree-remove": "removed worktree",
  "/docker/start": "started container", "/docker/stop": "stopped container",
  "/docker/restart": "restarted container", "/docker/rm": "removed container",
  "/prs/merge": "merged pull request", "/prs/close": "closed pull request",
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
    <Section>
      <div className="px-3 py-2 text-[11px] flex flex-col gap-1" style={{ color: "var(--text2)" }}>
        <span>Could not read this build's version.</span>
        <span className="text-[10px] t-dim2 break-all">{stErr}</span>
      </div>
    </Section>
  );
  if (!st) return <Section><div className="px-3 py-2 text-[11px] t-dim2">Reading version…</div></Section>;

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
    <Section>
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
            style={dirty ? { color: "var(--warning)", fontWeight: 600 } : undefined}>
            {short}
          </span>
          {st.info.builtAt && <> · built {new Date(st.info.builtAt).toLocaleString()}</>}
        </>}
        control={mine
          ? <button onClick={() => setWant(mine)}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
              style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>
              Release notes
            </button>
          : undefined}
      />

      <div className="px-4 py-2 flex flex-col gap-3">

        {/* Said in words, because the stamp alone is only obvious once you know
            the convention. The file list is the answer to the question that had
            no answer today — "whose uncommitted work is in the app I am running"
            — and it is absent outside the desktop shell on purpose. */}
        {dirty && (
          <div className="text-[10.5px] px-2.5 py-2 rounded-lg"
            style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>
            Built from an uncommitted tree — {st.info.dirtyCount} packaged file(s) differ from{" "}
            <span className="tabular-nums">{st.info.commit.slice(0, 7)}</span>. No commit reproduces this build.
            {st.info.dirtyFiles.length > 0 && (
              <pre className="mt-1 text-[9.5px] whitespace-pre-wrap break-all m-0" style={{ color: "var(--text3)" }}>
                {st.info.dirtyFiles.slice(0, 8).join("\n")}
                {st.info.dirtyFiles.length > 8 ? `\n… and ${st.info.dirtyFiles.length - 8} more` : ""}
              </pre>
            )}
          </div>
        )}

        {/* The outcome of the previous run, which finished after the app it was
            updating had already been stopped — so this is the only place it can
            be reported at all. */}
        {st.last && (
          <div className="text-[10.5px] px-2.5 py-2 rounded-lg"
            style={st.last.ok
              ? { color: "var(--text2)", background: "color-mix(in srgb, var(--success) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)" }
              : { color: "var(--text2)", background: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 35%, transparent)" }}>
            Last update {st.last.ok ? "succeeded" : "failed"} — {new Date(st.last.at).toLocaleString()}
            {!st.last.ok && st.last.tail && (
              <pre className="mt-1 text-[9.5px] whitespace-pre-wrap break-all m-0" style={{ color: "var(--text3)" }}>
                {st.last.tail.split("~").filter(Boolean).slice(-6).join("\n")}
              </pre>
            )}
          </div>
        )}

        {started ? (
          <div className="text-[11px] px-2.5 py-2 rounded-lg" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
            Updating. The app will close and reopen on its own — this window going away is the update working, not crashing.
          </div>
        ) : st.blocked ? (
          <div className="text-[11px] px-2.5 py-2 rounded-lg" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)" }}>
            {st.blocked}
          </div>
        ) : st.behind === 0 ? (
          <div className="text-[12px] t-dim">
            {st.branch ? `Up to date — ${st.branch} is the newest release.` : "Up to date."}
          </div>
        ) : (
          <>
            <div className="text-[13px]" style={{ color: "var(--text)" }}>
              {st.branch} is available{st.behind > 1 ? ` — ${st.behind} releases newer than yours` : ""}
            </div>
            <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto agx-scroll">
              {st.incoming.map((c) => (
                <div key={c.sha} className="flex gap-2 text-[10.5px] min-w-0">
                  <span className="tabular-nums shrink-0" style={{ color: "var(--primary-hover)" }}>{c.sha}</span>
                  {c.subject && <span className="truncate t-dim2" title={c.subject}>{c.subject}</span>}
                </div>
              ))}
            </div>
            {err && <div className="text-[10.5px]" style={{ color: "var(--error)" }}>{err}</div>}
            {/* The install compiles the release on this machine, so the
                toolchain has to be here before it starts — said up front
                rather than left to fail the build and report it in the panel
                above, after the app has already gone down to restart. */}
            <div className="text-[10.5px] px-2.5 py-1.5 rounded-lg" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)" }}>
              Built on your machine from source — needs <span style={{ color: "var(--warning)" }}>git</span> and <span style={{ color: "var(--warning)" }}>bun</span> installed, and is Linux-only for now.
            </div>
            <div className="flex items-center gap-2">
              <button onClick={run} disabled={busy}
                className="text-[11.5px] px-3 py-1.5 rounded-lg font-medium"
                style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)", opacity: busy ? 0.5 : 1 }}>
                {busy ? "Starting…" : `Install ${st.branch} & restart`}
              </button>
              {/* Read before you install, rather than after the app has
                  restarted into it. The tag list above says which releases are
                  coming; this says what is in them. */}
              <button onClick={() => setWant({ tag: st.branch, title: "What's in this update" })}
                className="text-[11.5px] px-3 py-1.5 rounded-lg hover:opacity-80"
                style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>
                What's in {st.branch}
              </button>
            </div>
            <span className="text-[9.5px] t-dim2">
              Compiles the tagged release in its own clone under ~/.cache, then reinstalls and restarts. Your working checkout is never touched, and only published tags are ever offered — commits pushed after a tag stay out until you tag them.
            </span>
          </>
        )}
      </div>

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
    </Section>
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

  const Bulk = ({ label, onClick, off }: { label: string; onClick: () => void; off?: boolean }) => (
    <button onClick={onClick} disabled={off}
      className="agx-btn text-[10px] px-1.5 py-0.5 rounded disabled:opacity-30"
      style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>{label}</button>
  );

  return (
    <div className="px-3 py-2 flex flex-col gap-2 border-t" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
      <div className="text-[11px]" style={{ color: "var(--text2)" }}>
        <b>Your logins</b> — a password manager cannot run in this browser (Electron
        has no place to put its popup), so the way pages behind a login work here is
        bringing the cookies over. Chrome, Firefox, Zen, Brave and Chromium, including
        the Chrome-family ones whose values are sealed: their key is asked of your
        desktop keyring. Everything is chosen to start with; untick what you would
        rather leave behind. Anyone who can use this window — including an agent
        driving it — will be signed in to whatever comes across.
      </div>

      {sources === null && <div className="text-[10.5px] t-dim2">Looking at your browsers…</div>}
      {sources !== null && !sources.length && <div className="text-[10.5px] t-dim2">No other browser profiles found on this machine.</div>}

      {!!sources?.length && (
        <div className="flex items-center gap-2 flex-wrap">
          {/* Locked ones are selectable now. They used to be disabled, which
              left the explanation of the lock attached to a state nobody could
              reach — so the chip said "locked" and nothing ever said why. */}
          {sources.filter(reachable).map((s) => (
            <button key={s.id} onClick={() => setPick(s.id)}
              className="agx-btn text-[10.5px] px-2 py-1 rounded-lg"
              title={s.readable ? `${s.rows} cookies across ${s.sites.length} sites` : "Click to see why this one cannot be read"}
              style={{
                color: s.id === pick ? "var(--primary-hover)" : "var(--text2)",
                background: s.id === pick ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
                border: `1px solid color-mix(in srgb, var(--border) ${s.id === pick ? 55 : 30}%, transparent)`,
                opacity: s.readable ? 1 : 0.6,
              }}>
              {s.label}{s.readable ? ` · ${s.sites.length}` : " · locked"}
            </button>
          ))}
        </div>
      )}

      {current && !current.readable && (
        <div className="text-[10.5px] px-2.5 py-2 rounded-lg leading-relaxed"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 25%, transparent)" }}>
          {lockedWhy(current)}
        </div>
      )}

      {current?.readable && (
        <>
          <div className="flex items-center gap-2">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sites…"
              className="flex-1 px-2.5 py-1.5 rounded-lg text-[11px] outline-none"
              style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
            <Bulk label="All" onClick={() => setChosen(allSites(current.sites))} off={chosen.size === total} />
            <Bulk label="None" onClick={() => setChosen(new Set())} off={!chosen.size} />
            {!!filter.trim() && <Bulk label={`These ${view.matched.length}`} onClick={() => setChosen(addVisible(chosen, view))} />}
            {!!filter.trim() && <Bulk label="Not these" onClick={() => setChosen(dropVisible(chosen, view))} />}
            <span className="text-[10px] t-dim2 tabular-nums shrink-0">{chosen.size} of {total}</span>
          </div>
          <div className="agx-scroll flex flex-col gap-0.5 overflow-y-auto" style={{ maxHeight: 220 }}>
            {view.rows.map((s) => {
              const on = chosen.has(s.site);
              return (
                <button key={s.site} onClick={() => setChosen((c) => { const n = new Set(c); if (on) n.delete(s.site); else n.add(s.site); return n; })}
                  className="agx-btn w-full text-left px-2 py-1 rounded flex items-center gap-2 text-[11px]"
                  style={{ background: on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : "transparent", color: "var(--text)" }}>
                  <span style={{ color: on ? "var(--primary-hover)" : "var(--text4)" }}>{on ? "☑" : "☐"}</span>
                  <span className="flex-1 truncate">{s.site}</span>
                  <span className="t-dim2 tabular-nums text-[10px]">{s.cookies}</span>
                </button>
              );
            })}
            {/* Not a truncation somebody has to notice: the rows past here are
                chosen exactly like the ones above, and the number is the same
                information as the wall would have been. */}
            {view.hidden > 0 && (
              <div className="text-[10.5px] t-dim2 px-2 py-1.5">
                and {view.hidden} more site{view.hidden === 1 ? "" : "s"} — they come across too. Filter to find one.
              </div>
            )}
            {!view.rows.length && <div className="text-[10.5px] t-dim2 px-2 py-1">Nothing matches that.</div>}
          </div>
        </>
      )}

      {err && <div className="text-[10.5px]" style={{ color: "var(--error)" }}>{err}</div>}
      {note && <div className="text-[10.5px]" style={{ color: "var(--text2)" }}>{note}</div>}

      {current?.readable && (
        <div className="flex items-center gap-3 flex-wrap text-[11px]" style={{ color: "var(--text2)" }}>
          <span className="t-dim2">Bring along:</span>
          <button onClick={() => { const next = !wantHistory; setWantHistory(next); setImportHistory(next); }}
            className="agx-btn flex items-center gap-1.5 px-1.5 py-0.5 rounded" title="Your browsing history, so the address bar completes what you type.">
            <span style={{ color: wantHistory ? "var(--primary-hover)" : "var(--text4)" }}>{wantHistory ? "☑" : "☐"}</span>
            <span>browsing history</span>
          </button>
          <button onClick={() => { const next = !wantBookmarks; setWantBookmarks(next); setImportBookmarks(next); }}
            className="agx-btn flex items-center gap-1.5 px-1.5 py-0.5 rounded" title="The pages you bookmarked, ranked first in the address bar.">
            <span style={{ color: wantBookmarks ? "var(--primary-hover)" : "var(--text4)" }}>{wantBookmarks ? "☑" : "☐"}</span>
            <span>bookmarks</span>
          </button>
          <span className="t-dim2 text-[10px]">— cookies are chosen per site above</span>
        </div>
      )}

      {current?.readable && (
        <div className="flex items-center gap-2">
          <button onClick={() => void run("import")} disabled={busy || !chosen.size}
            className="agx-btn text-[11px] px-3 py-1.5 rounded-lg font-medium"
            style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", opacity: chosen.size ? 1 : 0.5 }}>
            {busy ? "Bringing them in…" : `Bring in ${chosen.size} site${chosen.size === 1 ? "" : "s"}`}
          </button>
          <button onClick={() => void run("forget")} disabled={busy || !chosen.size}
            className="agx-btn text-[11px] px-3 py-1.5 rounded-lg"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", opacity: chosen.size ? 1 : 0.5 }}
            title="Remove these sites' cookies from agentglass's browser. Your own browser is untouched.">
            Forget them again
          </button>
        </div>
      )}
    </div>
  );
}

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

  if (!st) return <Section title="Agent browser use"><div className="px-3 py-2 text-[11px] t-dim2">Reading…</div></Section>;

  const mono = { color: "var(--text)" };
  const cliSays =
    st.cli.state === "installed" ? `On your PATH at ${st.cli.path}`
      : st.cli.state === "dangling" ? `${st.cli.path} points at ${st.cli.target ?? "nothing"}, which is not there — every call an agent makes fails while the command still resolves`
        : `Not on your PATH. The installer puts it at ${st.cli.path}; reinstall the app to get it.`;
  const skillSays =
    st.skill.state === "current" ? `Installed at ${st.skill.path}`
      : st.skill.state === "stale" ? `Installed at ${st.skill.path}, but this build ships a newer one`
        : st.skill.state === "missing" ? "Not installed — agents have no way to know the browser can be driven"
          : "This build does not carry the skill file, so there is nothing to install";

  return (
    <Section title="Agent browser use">
      <div className="py-2 flex flex-col gap-2.5">
        {/* The argument for the feature, which is read once and by somebody
            deciding whether to bother. The checklist under it is the part you
            come back to. */}
        <Fold label="Why an agent needs this rather than curl">
          An agent fetching a URL from its shell gets the signed-out version of everything that matters,
          because the session lives in a browser. This one has your sessions in it. Three things have to
          be true for an agent to use it, and they break independently.
        </Fold>

        {/* Three independent things, so a checklist rather than a paragraph:
            the count says how far off you are before you have read a word,
            and each line carries the button that fixes that line. */}
        <SetupCard
          title="Letting an agent drive it"
          error={err}
          note={note}
          steps={[
            { title: "The command", done: st.cli.state === "installed",
              detail: <><span className="t-mono text-[11px]" style={mono}>agentglass-browser</span>. {cliSays}</> },
            { title: "The skill", done: st.skill.state === "current",
              detail: <>What tells an agent the command exists. {skillSays}</>,
              action: (st.skill.state === "missing" || st.skill.state === "stale")
                ? { label: st.skill.state === "stale" ? "Update" : "Install", onClick: () => void install(), busy }
                : undefined },
            { title: "A window that can answer", done: st.windows > 0,
              detail: st.windows > 0
                ? "The browser view is open in this window."
                : "The browser view is not open yet. The command opens it itself on first use; until then there is nothing to drive." },
          ]}
        />

        <div className="flex items-center gap-2">
          <button onClick={load} disabled={busy} className="agx-btn text-[11px] px-3 py-1.5 rounded-lg"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>Check again</button>
        </div>

        <CookieImport />

        {/* Something to paste, because "it is installed" and "I know what to say
            to it" are different problems and only the first one is solved by a
            green line. Folded: useful the first time, in the way every time
            after that. */}
        <Fold label="Try it — three lines to paste into an agent">
          <div className="flex flex-col gap-1">
          {[
            "Using agentglass-browser, open my dashboard and tell me what is on it.",
            "With agentglass-browser, go to the staging app, log in with my session, and check the checkout flow.",
            "Take a screenshot of the open PR page with agentglass-browser and tell me what is failing.",
          ].map((p) => (
            <div key={p} className="text-[12px] px-2 py-1 rounded" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>{p}</div>
          ))}
          </div>
        </Fold>
      </div>
    </Section>
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

  if (!st) return <Section title="Claude Code hooks"><div className="py-2 text-[12px] t-dim">Reading hook state…</div></Section>;

  return (
    <Section title="Claude Code hooks">
      {/* No padding of its own: the column's rule already gives this the left
          edge, and a padded wrapper around rows indents them twice — measured
          as a second label edge at 484 the moment the fold went in. */}
      <div className="py-2 flex flex-col gap-2.5">

        {!st.bundled ? (
          <div className="text-[11px] px-2.5 py-2 rounded-lg" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)" }}>
            This build does not carry the hook scripts, so there is nothing to wire. Install from a Release, or run <span className="t-mono">bun run setup</span> in a checkout.
          </div>
        ) : (
          <>
            {/* The last step is one only you can take, and there is no way from
                here to see whether you have. It says so and stays out of the
                count, rather than sitting there permanently unticked. */}
            <SetupCard
              title="Wiring Claude Code in"
              error={err}
              note={note}
              steps={[
                { title: "Hook scripts in this build", done: st.bundled,
                  detail: "Shipped with the app — nothing to fetch." },
                { title: "Wired into Claude Code", done: st.installed,
                  detail: <>Written to <span className="t-mono text-[11px]" style={{ color: "var(--text)" }}>{st.settingsPath}</span>, run under <span className="t-mono text-[11px]">{st.python}</span>.</>,
                  action: st.installed ? undefined : { label: busy ? "Enabling…" : "Enable", onClick: () => void act("install"), busy } },
                { title: "Start a fresh Claude Code session", done: null,
                  detail: "Sessions already running keep the hooks they started with." },
              ]}
            />
            {/* AFTER the checklist, not before it: the verdict is what you
                came for, and what the feature is for is read once. Putting the
                argument first made the page open on a paragraph. */}
        {/* What the checklist below is FOR, which is read once. The checklist
                itself already names the file it writes to, on its own step. */}
                <Fold label="What wiring this actually changes">
              Every Claude Code session streams here live, and gate approvals
              (<span className="tabular-nums">PreToolUse</span>) reach the app instead of only the terminal.
              It edits <span className="t-mono text-[11px]" style={{ color: "var(--text)" }}>{st.settingsPath}</span>,
              backing it up first, and leaves your other hooks untouched.
                </Fold>
            <div className="flex items-center gap-2">
              {!st.installed ? null : (
                <button onClick={() => act("uninstall")} disabled={busy}
                  className="text-[11.5px] px-3 py-1.5 rounded-lg hover:opacity-80"
                  style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 34%, transparent)", opacity: busy ? 0.5 : 1 }}>
                  {busy ? "Disabling…" : "Disable hooks"}
                </button>
              )}
            </div>
            {/* The forwarder is a python script; the install writes the command
                but cannot make an interpreter appear. Said up front rather than
                left to a session that streams nothing and no error anywhere. */}
            <div className="text-[10.5px] px-2.5 py-1.5 rounded-lg" style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)" }}>
              The hooks run under <span style={{ color: "var(--warning)" }}>{st.python}</span> — it has to be on your PATH for events to arrive. Takes effect on the next Claude Code session; hooks load at startup.
            </div>
            <span className="text-[9.5px] t-dim2">
              Reversible any time from here, or with <span className="t-mono">python3 hooks/install_hooks.py --uninstall</span> in a checkout. Global (<span className="t-mono">~/.claude</span>), so it covers every project.
            </span>
          </>
        )}
      </div>
    </Section>
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
function AgentsSection({ open }: { open: boolean }) {
  return (
    <Section title="Other agents on this machine">
      {/* No wrapper: the column's padding rule applies to the direct children
          of a section, so a padded div around rows indents them twice. Rows go
          straight in. */}
      <AgentsPane open={open} />
    </Section>
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
          style={{ border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", background: "color-mix(in srgb, var(--bg2) 50%, transparent)" }}>
          <span className="shrink-0 rounded-full" aria-hidden style={{ width: 6, height: 6, background: statusColor(d) }} />
          <span className="t-mono text-[11px] truncate" style={{ color: "var(--text2)" }}>{d.bin}</span>
        </span>
      ))}
    </div>
  );
}

function DepRow({ d, home }: { d: DepReport; home: string }) {
  const color = statusColor(d);
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
  return (
    <>
    {/* On the row grid like every other setting, so the install buttons of the
        twelve dependencies land on one line instead of wherever their own
        label happened to end. The status dot rides inside the label rather
        than in a column of its own — a third column for seven pixels is what
        pushed this page off the dialog's left edge in the first place. */}
    <SettingRow
      align="start"
      label={<span className="flex items-center gap-2 flex-wrap">
        <span className="shrink-0 w-[7px] h-[7px] rounded-full" style={{ background: color }} aria-hidden />
        <span>{d.title}</span>
        <code className="text-[11px] t-mono t-dim">{d.bin}</code>
        <span className="text-[11px]" style={{ color }}>{STATUS_LABEL[d.status]}</span>
        {d.status !== "ok" && d.status !== "unsupported" && d.required && (
          <span className="chip text-[11px]" style={{ color: "var(--error)" }}>needed</span>
        )}
      </span>}
      hint={<>
        {d.what}
        {d.detail && d.status !== "ok" && <span className="block mt-0.5" style={{ color }}>{d.detail}</span>}
        {d.note && d.status !== "ok" && d.status !== "unsupported" && <span className="block mt-0.5">{d.note}</span>}
      </>}
      /* Only where there is something to do about it. A row that is already
         ready does not need a link, and a tool this platform never uses has
         nothing to install. The console comes first, because it is the one
         that finishes the job. `>_` rather than "Install": it says a terminal
         is about to open, which is the thing worth knowing before clicking. */
      control={(canType || (href && d.status !== "unsupported" && d.status !== "ok"))
        ? <span className="flex items-center gap-2 justify-end">
            {canType && (
              <button onClick={() => setConsole((v) => !v)}
                className="shrink-0 text-[12px] px-2 py-1 rounded-lg whitespace-nowrap"
                style={console
                  ? { color: "var(--text)", background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }
                  : { color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 34%, transparent)" }}
                title="Open a shell here with the command typed in — you press Enter">
                {">_ Install"}
              </button>
            )}
            {href && d.status !== "unsupported" && d.status !== "ok" && (
              <a href={href} target="_blank" rel="noreferrer noopener"
                className="shrink-0 text-[12px] px-2 py-1 rounded-lg whitespace-nowrap"
                style={{ color: canType ? "var(--text3)" : "var(--primary-hover)", border: `1px solid color-mix(in srgb, var(--${canType ? "border" : "primary"}) 34%, transparent)` }}>
                Install guide
              </a>
            )}
          </span>
        : undefined}
    />
    {/* Expanded in place rather than in a modal: the row you clicked stays on
        screen above it, so what is being installed and why is still readable
        while you decide. */}
    {console && canType && <div className="px-4 pb-2"><ShellConsole command={d.install!} cwd={home} onClose={() => setConsole(false)} /></div>}
    </>
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
    <Section title="GitHub API budget">
      <SettingRow
        label="How much of your GitHub allowance is left"
        hint="Every pull request, check and search this app shows spends one. GitHub refills them on a rolling window — 5,000 an hour for REST and GraphQL, 30 a minute for Search, which is the one that runs out first because looking up a card's pull requests is a search."
        control={<button onClick={() => void load()} disabled={busy}
          className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
          style={{ border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", color: "var(--text3)", opacity: busy ? 0.5 : 1 }}>
          {busy ? "Checking…" : "Refresh"}
        </button>}
      />
      <div className="py-1">
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
                <span className="tabular-nums" style={{ color: tint }}>{b.remaining.toLocaleString()} left</span>
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
      </div>
    </Section>
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
  const [d, setD] = useState<{ db: string; config: string; credentials: string; retentionDays: number; pairedDevices: number } | null>(null);
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
      <Section title="Nothing is sent anywhere">
        <p className="py-3 text-[12.5px]" style={{ color: "var(--text2)" }}>
          There is no analytics, no crash reporting and no phone-home in this app — so there is nothing
          to turn off here. What it does with your data, it does on this machine.
        </p>
      </Section>
      <Section title="What is on disk">
        <Path label="History" value={d?.db ?? ""}
          note="Every event, prompt, tool call and file change, in SQLite. Written owner-only — it holds prompts and command output in cleartext." />
        <Path label="Settings" value={d?.config ?? ""}
          note="Your preferences, budgets and the boards you have added." />
        <Path label="Credentials" value={d?.credentials ?? ""}
          note="Tokens for the services you connected, mode 0600. They are used by the server and never sent to the browser." />
        {d && (
          <p className="pb-3 text-[12px] t-dim">
            History older than {d.retentionDays === 0 ? "— nothing is pruned" : `${d.retentionDays} days is pruned automatically`}.
            Deleting the file above deletes all of it.
          </p>
        )}
      </Section>
      <Section title="What does leave this machine">
        {/* The headline answer is one line and stays open, because it is the
            claim this page exists to make. The enumeration behind it is the
            evidence, and evidence is read when it is doubted. */}
        <SettingRow
          label="Only the calls you asked for"
          hint={d && d.pairedDevices > 0
            ? `${d.pairedDevices} paired device${d.pairedDevices === 1 ? " can" : "s can"} reach this server — see Remote.`
            : "No device is paired, so nothing can reach this server from outside."}
        />
        <Fold label="Which calls, exactly">
          GitHub through <code>gh</code>, ClickUp through its API, and whatever an agent you started
          decides to do. Avatars are fetched from GitHub. Nothing else leaves, and nothing at all is
          sent to us — there is no endpoint of ours for it to go to.
        </Fold>
      </Section>
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

  return (
    <Section title="Services">
      {/* The same verdict shape as the half above it: what the state is, and
          the one button that applies to all of it. Two halves of one page
          answering "what is missing" in one voice. */}
      <SettingRow
        label={status
          ? (() => {
              const ok = status.filter((x) => x.state === "connected").length;
              const bad = status.filter((x) => x.state === "error").length;
              return (
                <span style={{ color: bad ? "var(--error)" : ok === status.length ? "var(--success)" : "var(--text)" }}>
                  {bad
                    ? `${bad} ${bad === 1 ? "service needs" : "services need"} attention`
                    : `${ok} of ${status.length} connected`}
                </span>
              );
            })()
          : "Checking what is connected…"}
        hint="Anything connected here shows up in the panel that uses it — a task provider becomes a tab in Tasks."
        control={<button onClick={() => void load()} disabled={busy}
          className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", opacity: busy ? 0.5 : 1 }}>
          {busy ? "Checking…" : "Recheck"}
        </button>}
      />
      {/* The list of providers is known without asking anyone — it is a
          constant in shared/providers.ts. Only their STATE has to be fetched.
          So the page draws itself immediately and each card fills in, rather
          than showing one line of "Checking what is connected…" over an empty
          pane: what you are waiting for is on screen while you wait for it,
          and the layout does not jump when the answer lands. */}
      <div className="pb-3">
        {err && <div className="text-[12px]" style={{ color: "var(--error)" }}>{err}</div>}

        {(["review", "task"] as const).map((kind) => (
          <Fragment key={kind}>
            {/* An eyebrow, like every other heading inside a page. It used to be
                a bold 11.5px line, which is a fourth level of heading in a
                dialog that already has three. */}
            <div>
              <div className="panel-eyebrow pb-0.5" style={{ paddingLeft: 0, paddingRight: 0 }}>
                {kind === "review" ? "Review providers" : "Task providers"}
              </div>
              <div className="text-[12px] t-dim">
                {kind === "review"
                  ? "Pull requests, checks and review state."
                  : "Where the things you owe come from."}
              </div>
            </div>
            {PROVIDERS.filter((p) => p.kind === kind).map((p) => (
              <ProviderCard key={p.id} spec={p} status={statusOf(p.id)} checking={!status && !err} onChanged={load} />
            ))}
          </Fragment>
        ))}
      </div>
    </Section>
  );
}

/** Four states, four sentences. A boolean here would flatten "installed but
 *  logged out" into "broken", and those need different buttons. */
const STATE_LOOK: Record<ProviderState, { label: string; fg: string }> = {
  connected: { label: "Connected", fg: "var(--success)" },
  "needs-auth": { label: "Not connected", fg: "var(--warning)" },
  "missing-tool": { label: "Not installed", fg: "var(--text3)" },
  error: { label: "Needs attention", fg: "var(--error)" },
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
  const look = waiting
    ? { label: "Checking…", fg: "var(--text3)" }
    : STATE_LOOK[status?.state ?? "needs-auth"];
  const connected = status?.state === "connected";
  const wantsToken = spec.auth === "token";
  const line = "1px solid color-mix(in srgb, var(--border) 40%, transparent)";

  const connect = async () => {
    if (!token.trim()) return;
    setBusy(true);
    const r = await api.providerConnect(spec.id, token.trim());
    setBusy(false);
    if (!r.ok) { setNote(r.error ?? "That did not work"); return; }
    // Cleared on success and only on success: a refused token is usually one
    // that was pasted short, and retyping it is a chore nobody needs.
    setToken(""); setNote(null);
    await onChanged();
  };

  return (
    /*
     * A row, not a card.
     *
     * These four are four answers to one question — is this connected — and a
     * card each meant their four state pills sat at four different heights and
     * four different x. On the dialog's grid the pills form a column you can
     * read down in one movement, which is the only reason a list of four beats
     * a paragraph naming them.
     *
     * Everything conditional — the token field, the workspace list, the caveat
     * — hangs UNDER its row rather than inside a box, so a row that has nothing
     * to add is exactly one line tall.
     */
    <div ref={box} className="agx-provider"
      /* Still remembered, still for the same reason: the row grows a detail
         line and, when it is not connected, a button under it. Measured after
         the card became a row, the page still moved 145px without this. */
      style={waiting ? { minHeight: rememberedHeights()[spec.id] ?? 56 } : undefined}>
      <SettingRow
        align="start"
        label={spec.title}
        hint={<>
          <span className="block">{spec.what}</span>
          {status?.detail && <span className="block mt-0.5" style={{ color: "var(--text2)" }}>{status.detail}</span>}
          {/* Half of a provider can be down while the other half looks fine —
              the ClickUp card bell fails on its own three-minute timer and
              used to do it in total silence (T27). Warning-coloured rather
              than error-coloured and UNDER the detail, because it qualifies
              the verdict instead of being it: a connected row with a broken
              bell is still connected, and a red row for it would send
              somebody to reconnect a token that is fine. */}
          {status?.notice && (
            <span className="block mt-0.5" style={{ color: "var(--warning)" }}>{status.notice}</span>
          )}
          {waiting && <span className="agx-skeleton block mt-1 rounded" style={{ height: 13, maxWidth: 240 }} aria-hidden />}
        </>}
        control={<span className="flex items-center gap-2">
          <span className="text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap"
            style={{ color: look.fg, background: `color-mix(in srgb, ${look.fg} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${look.fg} 35%, transparent)` }}>
            {look.label}
          </span>
          {!waiting && connected && wantsToken && (
            <button onClick={async () => { setBusy(true); await api.providerDisconnect(spec.id); setBusy(false); setSpaces(null); await onChanged(); }}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
              style={{ border: "1px solid color-mix(in srgb, var(--error) 35%, transparent)", color: "var(--error)" }}>
              Disconnect
            </button>
          )}
        </span>}
      />

      {/* Nothing below this is offered while the state is unknown: every one of
          them is an action whose rightness depends on the answer, and offering
          "Connect" to something already connected is worse than offering
          nothing for a third of a second. */}
      {waiting ? null : <div className="pb-2">
      {/* The standing caveat about a provider — true whether or not you ever
          connect it, and read once. On the card rather than in the page's flow,
          so it stays attached to the thing it is about. */}
      {spec.note && !connected && (
        <details className="mt-2 text-[12px]">
          <summary className="cursor-pointer select-none" style={{ color: "var(--text3)" }}>
            About this one
          </summary>
          <div className="mt-1" style={{ color: "var(--text3)" }}>{spec.note}</div>
        </details>
      )}

      {wantsToken && !connected && (
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          {/* `type=password`, and there is nothing to reveal: the value here is
              what you are typing, never what is stored. */}
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
            placeholder="Paste your personal API token" spellCheck={false} autoComplete="off"
            className="flex-1 min-w-[200px] text-[11.5px] px-2.5 py-1.5 rounded-lg outline-none"
            style={{ background: "var(--bg3)", border: line, color: "var(--text)" }} />
          <button onClick={() => void connect()} disabled={busy || !token.trim()}
            className="text-[11.5px] px-3 py-1.5 rounded-lg"
            style={{ background: "color-mix(in srgb, var(--primary) 20%, transparent)",
              border: "1px solid color-mix(in srgb, var(--primary) 48%, transparent)",
              color: "var(--text)", opacity: busy || !token.trim() ? 0.4 : 1 }}>
            {busy ? "Checking…" : "Connect"}
          </button>
        </div>
      )}

      {note && <div className="text-[11px] mt-2" style={{ color: "var(--error)" }}>{note}</div>}

      <div className="flex items-center gap-2 flex-wrap">
        {spec.help && !connected && (
          <a href={spec.help} target="_blank" rel="noreferrer"
            className="text-[12px] px-2 py-1 rounded-lg" style={{ border: line, color: "var(--text2)" }}>
            How to get one ↗
          </a>
        )}
        {connected && wantsToken && (
          <button onClick={async () => {
            const r = await api.providerWorkspaces(spec.id);
            if (!r.ok) { setNote(r.error ?? "Could not read the workspaces"); return; }
            setSpaces(r.workspaces ?? []);
          }} className="text-[12px] px-2 py-1 rounded-lg" style={{ border: line, color: "var(--text2)" }}>
            Change workspace
          </button>
        )}
      </div>

      </div>}

      {spaces && (
        <div className="flex flex-col gap-0.5 mt-2.5 rounded-lg p-1" style={{ background: "var(--bg3)", border: line }}>
          {!spaces.length && <div className="text-[11px] px-2 py-1 t-dim2">This token can see no workspaces.</div>}
          {spaces.map((w) => (
            <button key={w.id}
              onClick={async () => { await api.providerWorkspace(spec.id, w.id, w.name); setSpaces(null); await onChanged(); }}
              className="text-left text-[11.5px] px-2 py-1 rounded hover:bg-white/5" style={{ color: "var(--text2)" }}>
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
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

  if (err) return <Section><div className="py-2 text-[12px]" style={{ color: "var(--error)" }}>{err}</div></Section>;
  if (!deps) return <Section><div className="py-2 text-[12px] t-dim">Checking this machine…</div></Section>;

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
    <Section title="On this machine">
      {/* The verdict is the point of the page, so it is the first row and the
          only one carrying the recheck. It used to be a sentence floated beside
          a button, under a paragraph, neither of them on the dialog's line. */}
      <SettingRow
        label={<span style={{ color: broken ? "var(--error)" : wanting ? "var(--warning)" : "var(--success)" }}>
          {broken
            ? `${broken} needed ${broken === 1 ? "tool is" : "tools are"} missing`
            : wanting
              ? `Everything needed is here — ${wanting} optional ${wanting === 1 ? "feature is" : "features are"} standing down`
              : "Everything agentglass looks for is here"}
        </span>}
        hint={<>
          agentglass drives the tools you already have rather than bundling its own. This is what it looks for
          {platform && platform !== "demo" ? <> on this machine (<span className="t-mono text-[11px]">{platform}</span>)</> : null}.
          Install whatever is missing however you normally install software here, then recheck.
        </>}
        control={<button onClick={() => void load(true)} disabled={busy}
          className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", opacity: busy ? 0.5 : 1 }}>
          {busy ? "Checking…" : "Recheck"}
        </button>}
      />

      {/*
        * Only what wants something from you gets a row.
        *
        * Twelve rows of equal weight to say that one tool is missing: measured
        * at 174 words, of which about 160 were eleven tools reporting that
        * they are fine. A page you scan for the broken one should not make you
        * scan. So the ones that need you keep their full row — the status, the
        * detail, the install button — and the ones that are ready collapse
        * into a grid behind one line, where a name and a dot are enough.
        */}
      {wants.length > 0 && (
        <>
          <div className="panel-eyebrow pt-3 pb-1">
            {wants.length === 1 ? "This one wants something" : "These want something"}
          </div>
          {wants.map((d) => <DepRow key={d.id} d={d} home={shellRoot} />)}
        </>
      )}

      {ready.length > 0 && (
        <Fold label={`${ready.length} ready`}
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
    </Section>
  );
}

export function SettingsModal({ open, onClose, sound, onSound, scale, onZoom, onOpenStats, onOpenHelp, theme, onTheme, jumpTo }: {
  open: boolean; onClose: () => void; sound: boolean; onSound: () => void;
  /** A pane to land on, when Settings was opened by something asking for one. */
  jumpTo?: string | null;
  scale: number; onZoom: (dir: 1 | -1 | 0) => void;
  onOpenStats: () => void; onOpenHelp: () => void;
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
  useEffect(() => { if (open) autostartEnabled().then(setAutostartState); }, [open]);
  useEffect(() => { if (open) void isFullscreen().then(setFullscreenState); }, [open]);

  const [h24, setH24] = useState<boolean>(() => clock24());
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
  const [pane, setPane] = useState<Pane>(() => {
    try {
      const saved = localStorage.getItem(LAST_PANE_KEY);
      if (saved && TABS.some((t) => t.id === saved)) return saved as Pane;
    } catch { /* private mode */ }
    return TABS[0]!.id;
  });
  useEffect(() => { try { localStorage.setItem(LAST_PANE_KEY, pane); } catch { /* ignore */ } }, [pane]);
  // Somebody asked for a specific pane. Overrides the remembered one for this
  // opening only — the next plain open still lands where you left it.
  useEffect(() => {
    if (open && jumpTo && TABS.some((t) => t.id === jumpTo)) setPane(jumpTo as Pane);
  }, [open, jumpTo]);
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
  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all([
      api.dependencies().then((r) => r.deps.filter((d) => d.status !== "ok" && d.status !== "unsupported").length).catch(() => 0),
      api.providers().then((r) => r.providers.filter((p) => p.state === "error" || p.state === "needs-auth").length).catch(() => 0),
      api.remoteStatus().then((r) => (r.clients.liveCount > 0 ? ("live" as const) : null)).catch(() => null),
    ]).then(([deps, provs, remote]) => {
      if (live) setBadges({ connections: deps + provs, remote });
    });
    return () => { live = false; };
  }, [open]);

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
  /* Typing into the box while standing on a page the query does not match used
   * to leave you looking at that page, with the answer one click away in a nav
   * you were not looking at. Now the first matching page comes to you. It only
   * fires when the CURRENT page stops matching, so it never yanks you off a
   * page that is still a legitimate result for what you typed. */
  useEffect(() => {
    if (!ql) return;
    const hits = (t: typeof TABS[number]) => (t.label + " " + t.kw).toLowerCase().includes(ql);
    const here = TABS.find((t) => t.id === pane);
    if (here && hits(here)) return;
    const first = TABS.find(hits);
    if (first) setPane(first.id);
  }, [ql, pane]);
  const [termFont, setTermFontState] = useState(() => currentTermFont());
  const [termSize, setTermSizeState] = useState(() => currentTermSize());
  const [termLine, setTermLineState] = useState(() => currentTermLineHeight());
  const [termCursor, setTermCursorState] = useState<CursorStyle>(() => currentTermCursor());
  const [ffm, setFfm] = useState(() => focusFollowsMouse());
  const [scrollback, setScrollbackState] = useState(() => currentScrollback());
  const [wordSep, setWordSepState] = useState(() => currentWordSeparators());
  const [copySel, setCopySel] = useState(() => copyOnSelect());
  const [rcPaste, setRcPaste] = useState(() => rightClickPaste());
  const [dSplit, setDSplitState] = useState(() => diffSplit());
  const [dWrap, setDWrapState] = useState(() => diffWrap());
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
      const r = rebind(capturing, e.key);
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
  const quiet = useSyncExternalStore(subscribeNotifyQuiet, notifyQuiet, () => false);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <Portal z={LAYER.settings}>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 agx-scrim" style={{ zIndex: 10000 }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ type: "spring", stiffness: 340, damping: 30 }}
                className="w-[1010px] max-w-[96vw] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
                // Fixed, not max: with tabs the pane's height would otherwise
                // change with whichever section you picked, and a dialog that
                // resizes under the cursor is disorienting in a way a little
                // empty space never is.
                //
                // Grown from 820x620 once Remote became a page rather than a
                // paragraph: a QR code, a list of addresses and a row per
                // connected device do not fit a column that narrow without
                // wrapping into something you have to scroll to read. The vh
                // caps keep it a dialog on a laptop screen rather than a
                // full-screen takeover.
                                /* The dialog sits DEEPER than the app, not on top of it.
                                   A settings screen is somewhere you go, not
                                   something that hovers — and the deeper tone
                                   is what lets a control that needs to be
                                   touched (the search box, the selected page)
                                   come forward off it. It also removes the
                                   reason the group cards existed: the surface
                                   is the dialog now, so nothing inside needs
                                   one. */
                                style={{ height: "min(92vh, 1080px)", background: "var(--bg)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>

                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Settings</span>
                  <CloseButton onClick={onClose} className="ml-auto" />
                </div>

                <div className="flex-1 min-h-0 flex">
                  {/* One page per concern instead of one long scroll: four
                      sections stacked vertically meant the shortcuts, the part
                      you come here to change, were always below the fold. */}
                  <div className="shrink-0 w-[186px] py-2 px-2 flex flex-col gap-0.5 border-r agx-scroll overflow-y-auto" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings"
                      className="mb-1 px-2.5 py-1.5 rounded-lg text-[12.5px] outline-none shrink-0"
                      style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                    {(() => {
                      const hit = (t: typeof TABS[number]) => !ql || (t.label + " " + t.kw).toLowerCase().includes(ql);
                      const groups = TAB_GROUPS
                        .map((g) => ({ g, tabs: TABS.filter((t) => t.group === g && hit(t)) }))
                        .filter((x) => x.tabs.length);
                      if (!groups.length) return <div className="px-2.5 py-3 text-[12.5px]" style={{ color: "var(--text4)" }}>No settings match “{q.trim()}”.</div>;
                      return groups.map(({ g, tabs }) => (
                        <div key={g} className={`flex flex-col gap-0.5${g === "" ? " mt-auto pt-2" : ""}`}>
                          {g !== "" && <div className="px-2.5 pt-2 pb-0.5 text-[11px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>{g}</div>}
                          {tabs.map((t) => (
                            <button key={t.id} onClick={() => setPane(t.id)}
                              className="w-full text-left px-2.5 py-1.5 rounded-lg text-[13px] flex items-center gap-2"
                              style={pane === t.id
                                ? { background: "color-mix(in srgb, var(--primary) 15%, transparent)", color: "var(--text)" }
                                : { color: "var(--text3)" }}>
                              <span className="min-w-0 truncate">{t.label}</span>
                              {/* A count when something wants you, a dot when
                                  something is simply happening. Different marks
                                  because they are different facts: one is a
                                  chore, the other is a phone on the sofa. */}
                              {t.id === "connections" && !!badges.connections && (
                                <span className="ml-auto shrink-0 text-[10.5px] tabular-nums px-1.5 rounded-full"
                                  style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 16%, transparent)" }}
                                  title={`${badges.connections} ${badges.connections === 1 ? "thing wants" : "things want"} something`}>
                                  {badges.connections}
                                </span>
                              )}
                              {t.id === "remote" && badges.remote === "live" && (
                                <span className="ml-auto shrink-0 rounded-full" aria-label="a device is connected"
                                  title="A device is connected right now"
                                  style={{ width: 6, height: 6, background: "var(--success)" }} />
                              )}
                            </button>
                          ))}
                        </div>
                      ));
                    })()}
                  </div>

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
                  <div className="agx-scroll flex-1 min-w-0 overflow-y-auto px-5 pt-4 pb-6">
                  <div className="agx-settings-col">
                  <Filter.Provider value={filter}>
                  {filtering && (
                    <div className="agx-settings-row mb-3 rounded-lg" style={{ background: "color-mix(in srgb, var(--primary) 9%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 25%, transparent)" }}>
                      <span className="text-[12.5px]" style={{ color: "var(--text2)" }}>
                        Showing the <span className="tabular-nums" style={{ color: "var(--text)" }}>{rowHits}</span> setting{rowHits === 1 ? "" : "s"} on this page that match{rowHits === 1 ? "es" : ""} “{q.trim()}”.
                      </span>
                      <button onClick={() => setQ("")} className="justify-self-end text-[12px] px-2.5 py-1 rounded-lg"
                        style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>Show all</button>
                    </div>
                  )}
                  {(() => {
                    const t = TABS.find((x) => x.id === pane);
                    return t ? (
                      /* px-4 like every row: the page title is the top of the
                         same line the eye runs down, not a separate one. */
                      <div className="pb-3 px-4">
                        <div className="text-[18px] font-medium" style={{ color: "var(--text)" }}>{t.label}</div>
                        {t.what && <div className="text-[12.5px] mt-0.5" style={{ color: "var(--text3)" }}>{t.what}</div>}
                      </div>
                    ) : null;
                  })()}
                  {pane === "appearance" && (
                  <Section>
                    {/* The theme drives everything — app chrome, the terminal's
                        own palette, and on the desktop it is synced out to tmux
                        and nvim too. It used to live in the masthead; it belongs
                        here, where a control this heavy isn't in the way. */}
                    <p className="py-3 text-[12px] t-dim">One palette for the whole cockpit — chrome, terminal, and (on the desktop) your tmux and nvim follow it.</p>
                    <AppearancePane current={theme} onChange={onTheme} />
                  </Section>
                  )}
                  {pane === "terminal" && (
                  <Section>
                    {/* GPU (WebGL) is fastest but blanks white on some Linux
                        GPU/compositor stacks; Canvas is the same drawing minus
                        the GPU — fast, and no context to lose — so Auto uses GPU
                        everywhere except Linux, where it uses Canvas. DOM is the
                        last resort, and the slow one. All apply to new shells. */}
                    <Choice<RendererPref>
                      label="Terminal renderer"
                      hint="GPU is fastest; Canvas is nearly as fast and never blanks; DOM is the slow fallback. Applies to newly opened shells."
                      value={renderer}
                      onPick={(v) => { setRenderer(v); setRendererPref(v); }}
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
                      label="Font"
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
                      control={<Select
                        align="right"
                        value={termFont}
                        onChange={(v) => { setTermFont(v); setTermFontState(v); }}
                        options={TERM_FONTS
                          .filter((f) => f.bundled || fontAvailable(f.family))
                          .map((f) => ({ value: f.id, label: f.name }))}
                      />}
                    />
                    <div className="pb-3">
                      <div className="panel-eyebrow pb-1" style={{ paddingLeft: 0, paddingRight: 0 }}>How it looks</div>
                      <div className="rounded-lg px-3 py-2 whitespace-pre overflow-x-auto"
                        style={{
                          background: "color-mix(in srgb, var(--bg) 70%, transparent)",
                          border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                          fontFamily: TERM_FONTS.find((f) => f.id === termFont)?.stack || undefined,
                          fontSize: `${termSize}px`, lineHeight: 1.35, color: "var(--text)",
                        }}>
                        {"$ git rebase --continue\n"}
                        <span style={{ color: "var(--success)" }}>{"+ 0Oo l1I |¦ <>= != -> =~ {}[]()\n"}</span>
                        <span style={{ color: "var(--text3)" }}>{"  1234567890  .,;:'\"`  ~^*&%$#@"}</span>
                      </div>
                    </div>
                    <Stepper
                      label="Font size"
                      hint={`Applies live to every open terminal, and is remembered. ${MOD_KEY}+ / ${MOD_KEY}− with the pointer over a terminal does the same without touching the window.`}
                      value={`${termSize}px`}
                      onDec={() => { const n = Math.max(SIZE_MIN, termSize - 1); setTermSize(n); setTermSizeState(n); }}
                      onInc={() => { const n = Math.min(SIZE_MAX, termSize + 1); setTermSize(n); setTermSizeState(n); }}
                      canDec={termSize > SIZE_MIN} canInc={termSize < SIZE_MAX} />
                    {/* The warning is the point of exposing this at all. Air
                        between rows is a real preference, and above 1 it is
                        paid for in broken box rules on the DOM renderer —
                        which is the default on Linux. Better said here than
                        discovered as "the terminal looks wrong". */}
                    <Stepper
                      label="Line height"
                      hint={termLine > LINE_HEIGHT_MIN
                        ? "Above 1, box-drawing rules — the divider between tmux panes, the frames around an agent's output — are drawn with a gap on every row wherever the GPU renderer is off (the default on Linux). 1 keeps them solid."
                        : "Space between rows. 1 keeps box-drawing rules solid, which is what a terminal is normally set to."}
                      value={termLine.toFixed(2).replace(/0$/, "")}
                      onDec={() => { const n = Math.max(LINE_HEIGHT_MIN, Math.round((termLine - 0.05) * 100) / 100); setTermLineHeight(n); setTermLineState(n); }}
                      onInc={() => { const n = Math.min(LINE_HEIGHT_MAX, Math.round((termLine + 0.05) * 100) / 100); setTermLineHeight(n); setTermLineState(n); }}
                      canDec={termLine > LINE_HEIGHT_MIN} canInc={termLine < LINE_HEIGHT_MAX} />
                    <Choice<CursorStyle>
                      label="Cursor"
                      hint="The shape that marks where you're typing."
                      value={termCursor}
                      onPick={(v) => { setTermCursor(v); setTermCursorState(v); }}
                      options={CURSORS} />
                    {/* Off by default: focus that moves on its own is the one
                        terminal habit people either keep for life or cannot
                        stand, and a machine that has never been asked expects
                        the click. */}
                    <Toggle on={ffm} onClick={() => { const v = !ffm; setFocusFollowsMouse(v); setFfm(v); }}
                      label="Focus follows mouse"
                      hint="Hovering a terminal pane types into it, without a click first. Only terminals — the rest of the app still waits to be clicked." />
                    {/* On by default, because it is what this terminal has
                        always done — the switch is for the machine where the
                        clipboard is shared with something that reacts to it. */}
                    <Toggle on={copySel} onClick={() => { const v = !copySel; setCopyOnSelect(v); setCopySel(v); }}
                      label="Copy on select"
                      hint="A selection is on the clipboard the instant you make it, the way tmux does it — no Ctrl+Shift+C." />
                    <Toggle on={rcPaste} onClick={() => { const v = !rcPaste; setRightClickPaste(v); setRcPaste(v); }}
                      label="Right-click to paste"
                      hint="Right-click pastes the clipboard into the shell instead of opening the menu. Ctrl+right-click still opens it." />
                    {/* Sizes rather than a number box: the cost is memory PER
                        SHELL and this app holds several open at once, so the
                        step from 4k to 50k is one somebody should take on
                        purpose. */}
                    <Choice<string>
                      label="Scrollback"
                      hint={scrollback > DEFAULT_SCROLLBACK
                        ? `${scrollback.toLocaleString()} lines are kept per shell. Every line is cell data held in memory and reflowed on every resize — with several shells open, that is where a drag starts to stutter.`
                        : "How many lines each shell keeps. Applies live; the larger sizes cost memory per shell and make resizing slower."}
                      value={String(scrollback)}
                      onPick={(v) => { const n = Number(v); setScrollback(n); setScrollbackState(n); }}
                      options={SCROLLBACK_SIZES.map((n) => ({ v: String(n), label: n >= 1000 ? `${n / 1000}k` : String(n) }))} />
                    <div className="px-3.5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>Word separators</span>
                          <span className="block text-[10.5px] t-dim2 mt-0.5">
                            What a double-click stops at. Take out <code>/</code> — it is not there by default — and a path
                            selects whole; leave the box empty and a double-click takes the line.
                          </span>
                        </span>
                        <button onClick={() => { setWordSeparators(DEFAULT_WORD_SEPARATORS); setWordSepState(DEFAULT_WORD_SEPARATORS); }}
                          disabled={wordSep === DEFAULT_WORD_SEPARATORS}
                          className="shrink-0 text-[10.5px] px-2 py-0.5 rounded-lg"
                          style={{ border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", color: "var(--text3)", opacity: wordSep === DEFAULT_WORD_SEPARATORS ? 0.4 : 1 }}>
                          Reset
                        </button>
                      </div>
                      <input value={wordSep} spellCheck={false}
                        onChange={(e) => { setWordSepState(e.target.value); setWordSeparators(e.target.value); }}
                        className="mt-2 w-full rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                        style={{ fontFamily: "ui-monospace, monospace", background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", color: "var(--text)" }} />
                    </div>
                  </Section>
                  )}
                  {pane === "diff" && (
                  <Section>
                    {/* Defaults, not the live state: the toggle in each panel
                        still wins while you are looking at that diff. Changing
                        your mind about one file is not a preference. */}
                    <Choice<"split" | "inline">
                      label="Default view"
                      hint="How file changes, source control and pull requests open a diff. The toggle in each panel still overrides it for that diff."
                      value={dSplit ? "split" : "inline"}
                      onPick={(v) => { const on = v === "split"; setDiffSplit(on); setDSplitState(on); }}
                      options={[{ v: "split", label: "Side by side" }, { v: "inline", label: "Inline" }]} />
                    <Toggle on={dWrap} onClick={() => { const v = !dWrap; setDiffWrap(v); setDWrapState(v); }}
                      label="Wrap long lines"
                      hint="Wrap instead of scrolling sideways. Off keeps the columns aligned, which is what makes a code diff scannable; on is what a markdown or prose diff wants." />
                  </Section>
                  )}
                  {pane === "tasks" && (
                  <>
                  <Section title="Opens on">
                    {/* There was no setting here before and no default either:
                        the tab was component state initialised to "all", so
                        every visit started over — on the one view that does not
                        include your ClickUp cards. See taskLanding.ts. */}
                    <Choice<TaskLanding>
                      label="Tasks view opens on"
                      hint="Where the Tasks view lands when you come back to it. “Last used” picks up where you left off; naming a source pins it there whatever you did last. Following a card link from a pull request never changes this."
                      value={landing}
                      onPick={(v) => { setTaskLanding(v); setLandingState(v); }}
                      options={[
                        { v: "last", label: "Last used" },
                        { v: "all", label: "All" },
                        ...TASK_SOURCES.map((s) => ({ v: s.id as TaskLanding, label: s.label })),
                      ]} />
                  </Section>
                  <Section title="Task sources">
                    {/* Order is the row's own, and the arrows move a source
                        through the FULL list rather than the visible one — see
                        moveTaskSource. Arrows rather than dragging: this pane's
                        every other control works from a keyboard, and a drop
                        target would be the one that does not. */}
                    {sourceOrder.map((id, i) => (
                      <SourceRow key={id} id={id} i={i} n={sourceOrder.length}
                        onChanged={() => setSourceTick((n) => n + 1)} />
                    ))}
                    <p className="px-3.5 pb-3 -mt-1 text-[10px] t-dim2 max-w-[680px]">
                      One has to stay, and a source you have not set up is left off the bar on its own — until nothing is
                      set up, when all of them show, because that is when the bar is the only place to find them.
                      Connecting them lives in Integrations.{" "}
                      <button onClick={() => { resetTaskSourceOrder(); setSourceTick((n) => n + 1); }}
                        className="agx-btn underline underline-offset-2" style={{ color: "var(--text3)" }}>
                        Reset order
                      </button>
                    </p>
                  </Section>
                  </>
                  )}
                  {pane === "privacy" && <PrivacyPane open={open} />}
                  {pane === "recipes" && <RecipesPane open={open} />}
                  {pane === "prefs" && (
                  <Section>
                    {/* Desktop only, like launch-at-login: in a browser tab the
                        browser's own zoom already does this, and better. */}
                    {IS_DESKTOP && (
                      <Stepper
                        label="Display size"
                        hint={`Scales the whole window, and is remembered. ${MOD_KEY}+ / ${MOD_KEY}− anywhere, ${MOD_KEY}0 to reset — except over a terminal, where the same keys size the terminal instead and leave the window alone.`}
                        value={fmtScale(scale)}
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
                  </Section>
                  )}

                  {/* The engine and the memory it costs, together. Both used to
                      sit under "Preferences", which is where settings go when
                      nobody has decided where they belong — a page that mixes
                      window zoom with how a CLI is spawned is a drawer. */}
                  {pane === "chat" && (
                  <Section>
                    {/* Two genuinely different bargains, so the row names both
                        rather than implying one is simply better. Panes are
                        faster per turn and attachable from a real terminal;
                        they also hold a live CLI (~380MB and growing) for as
                        long as the chat is warm. Applies to new chats only —
                        an open chat's session already lives somewhere. */}
                    <Choice<"server" | "process" | "tmux">
                      label="How new chats run"
                      hint={
                        tmuxEngine && !tmuxEngine.available
                          // A reason on its own leaves "tmux is not installed"
                          // as a dead end inside a settings dialog that has the
                          // install guidance one tab away. Say where it is.
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
                    {tmuxEngine?.available && (
                      <div className="flex flex-col gap-1.5 pt-1">
                        <span className="text-[10px] t-dim2 uppercase tracking-wider">Warm CLIs running now</span>
                        <RunningPanes open={open} />
                      </div>
                    )}
                  </Section>
                  )}

                  {pane === "budgets" && (
                  <Section>
                    {/* A limit you chose, so the spend insights stop firing on
                        constants — which are noise on a project that genuinely
                        costs that and silence on one where a tenth would be
                        alarming. */}
                    {/* .panel-eyebrow, not a hand-rolled 10px uppercase span:
                        there were three different spellings of a section
                        heading in this file and this was the third. */}
                    <div className="panel-eyebrow pt-1 pb-1.5">Spending budgets</div>
                    <BudgetsPane open={open} />
                    {/* The consequence of the setting above, made visible.
                        Panes outlive the app, so "how new chats run" quietly
                        decides how much memory is resident on this machine an
                        hour from now, and until this list existed the only
                        place to see that was a terminal. */}
                  </Section>
                  )}

                  {pane === "notifications" && (
                  <Section>
                    {/* Two sources, two switches. They share one surface — the
                        bell lists both — so "stop interrupting me" has to be
                        answerable about each separately, or turning off the
                        chatter means turning off the fleet you are watching. */}
                    {/* Its own group above the two sources, because it is not
                        about a source at all — it narrows one KIND of thing
                        agentglass raises itself. */}
                    <Group>Pull request checks</Group>
                    <Toggle
                      on={ciApproved}
                      onClick={() => { const v = !ciApproved; setCiOnlyApproved(v); setCiApproved(v); }}
                      label="Only when the pull request is approved"
                      hint={ciApproved
                        ? "A suite finishing on something half-written is a status line; on something approved it is the last thing before merging."
                        : "Every verdict, on every pull request of yours — including the ones nobody has looked at yet."} />

                    <Group>From your desktop</Group>
                    <Toggle
                      on={sysNotify !== "off"}
                      // Disabled only on a verdict. "We could not reach the
                      // server to ask" is not one, and greying the switch out
                      // for it makes a passing startup race look like a machine
                      // that cannot do this at all.
                      disabled={notifyCap ? !notifyCap.supported && !notifyCap.transient : true}
                      onClick={() => setSysNotifyOn(sysNotify === "off")}
                      label="Mirror this machine's notifications"
                      hint={notifyCap && !notifyCap.supported
                        ? (notifyCap.transient
                          ? `Checking — ${notifyCap.reason}`
                          : `Unavailable — ${notifyCap.reason}`)
                        : "Slack, mail, calendar — whatever pops up behind agentglass while it is covering your screen. A copy, never an interception: your desktop still shows its own."} />
                    {sysNotify !== "off" && (
                      <>
                        {/* Not the same question as the switch above. "Tell me
                            someone wrote" and "show me what they said" differ on
                            a shared screen, which is the one place this feature
                            is most useful and least private. */}
                        <Choice<SysNotifyMode>
                          label="How much of the message"
                          hint="Full shows the text on the card; Who shows only who it was from"
                          value={sysNotify}
                          onPick={setSysNotifyMode}
                          options={[
                            { v: "titles", label: "Who" },
                            { v: "full", label: "Full" },
                          ]} />
                        {/* agentglass reads the bus rather than being the daemon,
                            so the desktop's own Do Not Disturb cannot reach what
                            lands here. This is the switch that can. It silences
                            other people's messages only: a gate hold never travels
                            this path, so quiet can't mean an agent blocked and
                            nobody said. */}
                        <Toggle on={quiet} onClick={() => setNotifyQuiet(!quiet)}
                          label="Quiet — collect them without interrupting"
                          hint="No cards; they still land in the bell, so nothing is lost" />
                      </>
                    )}

                    <Group>From agentglass</Group>
                    <Toggle on={own} onClick={() => setAppNotify(!own)}
                      label="agentglass's own notifications"
                      hint="Chats finishing, branches falling behind, checks going red. Anything held waiting on you still speaks — that one cannot be caught up on later — and everything keeps landing in the bell either way." />
                    <Toggle on={sound} onClick={onSound}
                      label="Alert sounds"
                      hint="A chime when a session errors or needs you" />
                    {/* Says what it costs, because it costs something: this
                        spends a little of the quota it is measuring. */}
                    <Toggle on={usageRefresh}
                      onClick={() => { setUsageRefreshOn(!usageRefresh); setUsageRefreshState(!usageRefresh); }}
                      label="Keep Codex usage current"
                      hint="Runs a minimal Codex turn hourly so the quota reading is not stale — uses a small amount of the quota it measures" />
                  </Section>
                  )}

                  {pane === "browser" && <><BrowserPane /><AgentBrowserPane open={open} /></>}

                  {pane === "rail" && <RailPane />}

                  {pane === "keys" && (
                  <Section>
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
                          <div className="panel-eyebrow pb-1">Even inside a shell</div>
                          <div className="text-[12px] t-dim pb-1.5">
                            The terminal gives this one up so it reaches the app. Pick something your
                            shell does not want — the shipped {chordLabel(APP_CHORD_DEFAULTS["files.palette"])} is
                            free in bash, tmux and vim; plain Ctrl+P is not.
                          </div>
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
                                  className="chip text-[11px] tabular-nums min-w-[110px] text-center"
                                  style={capturingApp === id
                                    ? { color: "var(--primary-hover)", borderColor: "color-mix(in srgb, var(--primary) 60%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }
                                    : hasCustomAppChord(id) ? { color: "var(--primary-hover)" } : { color: "var(--text2)" }}>
                                  {capturingApp === id ? "Hold a combo…" : chordLabel(appChordFor(id))}
                                </button>
                              </span>} />
                          ))}
                          {rest.length > 0 && (
                            <>
                              <div className="panel-eyebrow pt-4 pb-1">Anywhere</div>
                              <div className="text-[12px] t-dim pb-1.5">
                                A held combination, so it cannot be swallowed by whatever has focus.
                              </div>
                              {rest.map(row)}
                            </>
                          )}
                          {viewIds.length > 0 && (
                            <>
                              <div className="panel-eyebrow pt-4 pb-1">Only on the dashboard</div>
                              <div className="text-[12px] t-dim pb-1.5">
                                A single key each — inside the workspace every keystroke belongs to a shell.
                                The second column is the chord that reaches them from in there.
                              </div>
                              {viewIds.map(row)}
                            </>
                          )}
                        </>
                      );
                    })()}
                    {/* Says why the rest of the keyboard is not on this list.
                        Read once, by somebody wondering why their key was
                        refused — so it waits to be asked. */}
                    <Fold label="Why some keys are two columns and others one">
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
                    </Fold>
                    {(isCustomised() || chordsCustomised() || appChordsCustomised()) && (
                      <SettingRow
                        label="Reset to defaults"
                        hint="Puts every key and every chord back to the shipped one."
                        control={<button onClick={() => { resetBindings(); resetChords(); resetAppChords(); setKeyError(null); setAppKeyError(null); setCapturing(null); setCapturingChord(null); setCapturingApp(null); }}
                          className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
                          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                          Reset
                        </button>}
                      />
                    )}
                  </Section>
                  )}

                  {pane === "open" && (
                  <Section>
                    <Row label="Statistics" hint="Totals, tool latency and cost breakdowns" kbd="s"
                      onClick={() => { onOpenStats(); onClose(); }} />
                    <Row label="Legend & shortcuts" hint="What the colours mean, and every key binding" kbd="?"
                      onClick={() => { onOpenHelp(); onClose(); }} />
                    <Row label="Command palette" hint="Jump to any panel, filter or session" kbd={`${MOD_KEY}K`}
                      onClick={onClose} />
                  </Section>
                  )}

                  {pane === "export" && (
                  <Section>
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
                  </Section>
                  )}

                  {pane === "hooks" && <><HooksPane open={open} /><AgentsSection open={open} /></>}

                  {pane === "connections" && <><RequirementsPane open={open} /><IntegrationsPane open={open} /><GhBudget open={open} /></>}

                  {pane === "remote" && <RemoteAccessPane open={open} />}

                  {pane === "log" && <ActivityPane open={open} />}
                  {pane === "about" && <AboutPane open={open} />}
                  </Filter.Provider>
                  </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
