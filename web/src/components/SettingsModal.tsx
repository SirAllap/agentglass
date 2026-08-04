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
import { useEffect, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import type { ActionRecord, GateRecord } from "../../../shared/types.ts";
import { mergeActivity, gateLine, actorLabel, type ActivityRow } from "../lib/activity.ts";
import { ingestUpdate } from "../lib/updateStore.ts";
import { ReleaseNotesModal } from "./ReleaseNotesModal.tsx";
import { installedNotes, type NotesTarget } from "../lib/whatsNew.ts";
import { autostartEnabled, setAutostart, isFullscreen, toggleFullscreen, IS_DESKTOP, HAS_BROWSER } from "../lib/desktop.ts";
import { Select } from "./Select.tsx";
import { SEARCH_ENGINE_LABELS, type SearchEngine } from "../lib/browserUrl.ts";
import { homePageRaw, setHomePage, searchEngine, setSearchEngine } from "../lib/browserPrefs.ts";
import { RemoteAccessPane } from "./RemoteAccessPane.tsx";
import { RunningPanes } from "./RunningPanes.tsx";
import { BudgetsPane } from "./BudgetsPane.tsx";
import { AgentsPane } from "./AgentsPane.tsx";
import { rendererPref, setRendererPref, type RendererPref } from "../lib/termRenderer.ts";
import { TERM_FONTS, CURSORS, fontAvailable, currentTermFont, currentTermSize, currentTermCursor, currentTermLineHeight, setTermFont, setTermSize, setTermCursor, setTermLineHeight, SIZE_MIN, SIZE_MAX, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, type CursorStyle } from "../lib/termPrefs.ts";
import { canZoomIn, canZoomOut, fmtScale } from "../lib/uiScale.ts";
import { MOD_KEY } from "../lib/format.ts";
import { externalUrl } from "../lib/externalUrl.ts";
import type { UpdateStatus, ReleaseNotes, HookSetupStatus } from "../../../shared/types.ts";
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
import { bindings, rebind, resetBindings, subscribeBindings, isCustomised, LABELS, DEFAULTS, type ActionId,
         chordFor, hasCustomChord, rebindChord, clearChord, resetChords, chordsCustomised, chordFromEvent, chordLabel } from "../lib/keybindings.ts";
import {
  loadRail, subscribeRail, moveView, resetRail, railIds, railCustomised, SHIPPED_RAIL,
  type RailPlace, type ViewId,
} from "./workspace/views.ts";
import { AppearancePane } from "./ThemePicker.tsx";
import { ShellConsole } from "./ShellConsole.tsx";

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

function Toggle({ on, onClick, label, hint, disabled }: {
  on: boolean; onClick: () => void; label: string; hint: string;
  /** A host that cannot do this at all — the row stays, greyed, saying why in
   *  its hint, because a switch that vanishes reads as a feature you imagined. */
  disabled?: boolean;
}) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on} disabled={disabled}
      style={disabled ? { opacity: 0.55 } : undefined}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5 disabled:cursor-not-allowed">
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>{label}</span>
        <span className="block text-[10.5px] t-dim2 mt-0.5">{hint}</span>
      </span>
      {/* A real switch: position carries the state, so it reads at a glance
          instead of having to be parsed. */}
      <span className="shrink-0 relative rounded-full transition-colors" style={{
        width: 34, height: 19,
        background: on ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)",
      }}>
        <span className="absolute rounded-full transition-transform" style={{
          width: 15, height: 15, top: 2, left: 2,
          transform: on ? "translateX(15px)" : "translateX(0)",
          background: on ? "var(--primary-hover)" : "var(--text3)",
        }} />
      </span>
    </button>
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
    <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left" style={{ opacity: disabled ? 0.55 : 1 }}>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>{label}</span>
        <span className="block text-[10.5px] t-dim2 mt-0.5">{disabled ? disabledHint ?? hint : hint}</span>
      </span>
      <span className="shrink-0 flex items-center gap-1 rounded-lg p-0.5"
        style={{ background: "color-mix(in srgb, var(--border) 28%, transparent)" }}>
        {options.map((o) => (
          <button key={o.v} onClick={() => onPick(o.v)} disabled={disabled}
            aria-pressed={value === o.v}
            className="text-[10.5px] px-2 py-1 rounded-md transition-colors disabled:cursor-not-allowed"
            style={value === o.v
              ? { background: "color-mix(in srgb, var(--primary) 55%, transparent)", color: "var(--text)" }
              : { color: "var(--text3)" }}>
            {o.label}
          </button>
        ))}
      </span>
    </div>
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
    <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left">
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>{label}</span>
        <span className="block text-[10.5px] t-dim2 mt-0.5">{hint}</span>
      </span>
      <span className="shrink-0 flex items-center gap-1">
        <button onClick={onDec} disabled={!canDec} className={btn} style={{ border, color: "var(--text2)" }} aria-label="Smaller">−</button>
        {/* Tabular width so stepping 100% → 125% doesn't shuffle the buttons. */}
        <span className="text-[11.5px] tabular-nums text-center w-[42px]" style={{ color: "var(--text)" }}>{value}</span>
        <button onClick={onInc} disabled={!canInc} className={btn} style={{ border, color: "var(--text2)" }} aria-label="Bigger">+</button>
      </span>
    </div>
  );
}

function Row({ label, hint, kbd, href, download, onClick }: { label: string; hint: string; kbd?: string; href?: string; download?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>{label}</span>
        <span className="block text-[10.5px] t-dim2 mt-0.5">{hint}</span>
      </span>
      {kbd && <kbd className="chip text-[9.5px] t-dim2 shrink-0">{kbd}</kbd>}
    </>
  );
  const cls = "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5";
  return href
    ? <a href={href} download={download} className={cls}>{body}</a>
    : <button onClick={onClick} className={cls}>{body}</button>;
}

type Pane = "appearance" | "prefs" | "terminal" | "chat" | "notifications" | "browser" | "rail" | "keys" | "open" | "export" | "log" | "budgets" | "hooks" | "reqs" | "remote" | "about";
type TabGroup = "Interface" | "Data" | "Setup" | "About";
// Rendered in this order; a group with no matching tab is dropped, so search
// collapses to just the sections that still have something in them.
const TAB_GROUPS: TabGroup[] = ["Interface", "Data", "Setup", "About"];
// `kw` are the words the search box also matches — the things people call a
// setting that aren't in its label ("keyboard" for Shortcuts, "theme" for
// Appearance), so the box finds a page by what it does, not just its name.
const LAST_PANE_KEY = "agentglass.settings.pane";

const TABS: { id: Pane; label: string; group: TabGroup; kw: string }[] = [
  { id: "prefs", label: "Preferences", group: "Interface", kw: "display size zoom sound clock fullscreen start login" },
  { id: "appearance", label: "Appearance", group: "Interface", kw: "theme accent colour color font dark light mode palette" },
  { id: "terminal", label: "Terminal", group: "Interface", kw: "terminal font size cursor typography monospace face renderer gpu" },
  { id: "chat", label: "Chat", group: "Interface", kw: "chat engine tmux panes warm cli claude how new chats run" },
  // Only where there is a browser to configure. A settings tab for something
  // that is not there reads as a broken feature rather than one that doesn't apply.
  ...(HAS_BROWSER ? [{ id: "browser" as const, label: "Browser", group: "Interface" as const, kw: "browser web page zoom" }] : []),
  { id: "notifications", label: "Notifications", group: "Interface", kw: "notifications sound alert desktop notify quiet chime ping" },
  // Next to Shortcuts on purpose: which drawer a view sits in is what decides
  // whether it has a number, so the two pages answer one question between them.
  { id: "rail", label: "Rail", group: "Interface", kw: "rail sidebar views order icons hide show reorder tabs drawer group arrange" },
  { id: "keys", label: "Shortcuts", group: "Interface", kw: "keyboard keys bindings shortcut chord rebind" },
  { id: "budgets", label: "Budgets", group: "Data", kw: "budget spend cost limit money threshold" },
  { id: "log", label: "Activity", group: "Data", kw: "activity log history events feed" },
  { id: "open", label: "Open", group: "Data", kw: "open external editor file reveal" },
  { id: "export", label: "Export", group: "Data", kw: "export download data json csv" },
  { id: "hooks", label: "Agents", group: "Setup", kw: "agents hooks claude code install setup" },
  { id: "reqs", label: "Requirements", group: "Setup", kw: "requirements dependencies deps tmux git docker install" },
  { id: "remote", label: "Remote", group: "Setup", kw: "remote access pair phone tailscale token device" },
  { id: "about", label: "About", group: "About", kw: "about version update release notes changelog" },
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
    <Section title="Browser">
      <p className="px-3 pb-1 text-[11px] t-dim2">
        The pages the browser view opens on its own. Everything else — what you have logged into,
        what you have open — belongs to the page, not to a setting.
      </p>

      <div className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg">
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>Home page</span>
          <span className="block text-[10.5px] t-dim2 mt-0.5">
            Where the view opens, and where Home goes. Leave it empty for a blank page.
          </span>
          {bad && (
            <span className="block text-[10.5px] mt-1" style={{ color: "var(--error)" }}>
              That is not an address this will open — it takes http(s), or nothing at all.
            </span>
          )}
        </span>
        <span className="shrink-0 flex items-center gap-1.5">
          <input
            value={home}
            onChange={(e) => { setHome(e.target.value); setBad(false); setSaved(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
            placeholder="https://duckduckgo.com"
            spellCheck={false}
            className="text-[11.5px] px-2 py-1 rounded outline-none bg-transparent w-[210px]"
            style={{
              color: "var(--text)",
              border: `1px solid color-mix(in srgb, ${bad ? "var(--error) 60%" : "var(--border) 55%"}, transparent)`,
            }}
          />
          <button onClick={save}
            className="agx-btn text-[11px] px-2 py-1 rounded"
            style={{ border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", color: "var(--text2)" }}>
            {saved ? "Saved" : "Save"}
          </button>
        </span>
      </div>

      <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg">
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>Search engine</span>
          <span className="block text-[10.5px] t-dim2 mt-0.5">
            Used when what you type in the address bar is words rather than an address.
          </span>
        </span>
        <span className="shrink-0">
          <Select
            value={engine}
            options={(Object.keys(SEARCH_ENGINE_LABELS) as SearchEngine[]).map((id) => ({ value: id, label: SEARCH_ENGINE_LABELS[id] }))}
            onChange={(v) => { setEngine(v as SearchEngine); setSearchEngine(v as SearchEngine); }}
            align="right"
          />
        </span>
      </div>
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

  return (
    <Section title="Rail">
      {(Object.keys(PLACE_LABEL) as RailPlace[]).map((place) => (
        <div key={place} className="pb-1">
          <div className="px-3 pt-3 pb-1.5">
            <div className="text-[11.5px]" style={{ color: "var(--text)" }}>{PLACE_LABEL[place]}</div>
            <div className="text-[10px] t-dim2 mt-0.5">{PLACE_NOTE[place]}</div>
          </div>

          {rail[place].length === 0 ? (
            <div className="px-3 py-2 text-[10.5px] t-dim2">
              {place === "hidden" ? "Nothing put away." : "Empty — drag something here, or use the buttons on the right."}
            </div>
          ) : rail[place].map((v, i) => {
            const Icon = v.icon;
            const chord = chordFor(v.id);
            return (
              <div key={v.id} className="w-full flex items-center gap-3 px-3 py-1.5 rounded-lg hover:bg-white/5">
                <span className="shrink-0 grid place-items-center w-5" style={{ color: "var(--text2)" }}><Icon size={15} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] truncate" style={{ color: "var(--text)" }}>{v.label}</span>
                  <span className="block text-[10.5px] t-dim2 truncate">{v.hint}</span>
                </span>
                <span className="shrink-0 text-[10px] tabular-nums w-[52px] text-right"
                  style={{ color: chord ? "var(--text2)" : undefined, opacity: chord ? 0.75 : 0.35 }}>
                  {chord ? chordLabel(chord) : "—"}
                </span>
                {/* Order only matters where the rail draws it, and in the top
                    group it also decides which number you get. */}
                <span className="shrink-0 flex items-center gap-0.5 w-[46px]">
                  {place !== "hidden" && (
                    <>
                      <MiniBtn label="Move up" disabled={i === 0} onClick={() => moveView(v.id, place, i - 1)}>↑</MiniBtn>
                      <MiniBtn label="Move down" disabled={i === rail[place].length - 1} onClick={() => moveView(v.id, place, i + 1)}>↓</MiniBtn>
                    </>
                  )}
                </span>
                <span className="shrink-0 flex items-center gap-1">
                  {(Object.keys(PLACE_LABEL) as RailPlace[]).map((p) => (
                    <button key={p} onClick={() => moveView(v.id, p, p === "work" ? ids.work.length : 0)}
                      disabled={p === place}
                      title={p === place ? `Already in ${PLACE_LABEL[p].toLowerCase()}` : `Move to ${PLACE_LABEL[p].toLowerCase()}`}
                      className="chip text-[10px] px-2 py-0.5"
                      style={p === place
                        ? { color: "var(--primary-hover)", borderColor: "color-mix(in srgb, var(--primary) 55%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)", cursor: "default" }
                        : { color: "var(--text2)", opacity: 0.7 }}>
                      {p === "work" ? "Top" : p === "utility" ? "Bottom" : "Hidden"}
                    </button>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      <div className="px-3 pt-3 pb-1 flex items-center gap-3">
        <span className="text-[10px] t-dim2 flex-1">
          On the rail itself: <b style={{ color: "var(--text2)" }}>drag</b> an icon between the groups — a gap opens where it will land — or drop it on the dashed square at the bottom to put it away. <b style={{ color: "var(--text2)" }}>Right-click</b> any icon for the same moves, and <b style={{ color: "var(--text2)" }}>Alt+↑/↓</b> does it from the keyboard.
        </span>
        {railCustomised() && (
          <button onClick={resetRail} className="text-[10.5px] px-2 py-1 rounded-lg shrink-0"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
            Reset the rail
          </button>
        )}
      </div>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-2 py-2">
      <div className="panel-eyebrow px-3 pb-1">{title}</div>
      {children}
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
    <div className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-white/5">
      <button onClick={onCapture} className="min-w-0 flex-1 text-left">
        <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>{label}</span>
        <span className="block text-[10.5px] mt-0.5" style={{ color: error ? "var(--error)" : undefined }}>
          <span className={error ? "" : "t-dim2"}>{error ?? hint}</span>
        </span>
      </button>
      {/* Two keys, labelled, because they answer different questions and the
          unlabelled pair read as one shortcut written twice. */}
      {chord && (
        <span className="shrink-0 flex items-center gap-1.5">
          <span className="text-[9px] t-dim2 w-[52px] text-right">anywhere</span>
          <button onClick={chord.onCapture}
            // An empty key is a view outside the top group, where numbers do
            // not reach. Still clickable: recording one is exactly how you give
            // a bottom-drawer or hidden view a key of its own.
            title={chord.custom
              ? `${chordLabel(chord.key)} opens this — click to record another, ✕ to go back to its rail position`
              : chord.key
                ? `${chordLabel(chord.key)} opens this, from its position in the top group — click to record your own`
                : "Only the top group is numbered — click to record a combination for this one"}
            className="chip text-[10px] tabular-nums min-w-[74px] text-center"
            style={chord.capturing
              ? { color: "var(--primary-hover)", borderColor: "color-mix(in srgb, var(--primary) 60%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }
              : chord.custom
                ? { color: "var(--primary-hover)" }
                : { color: "var(--text2)", opacity: 0.6 }}>
            {chord.capturing ? "Hold a combo…" : chord.key ? chordLabel(chord.key) : "—"}
          </button>
          <span className="w-3 shrink-0">
            {chord.custom && !chord.capturing && (
              <button onClick={chord.onClear} title="Back to its position in the rail"
                className="text-[11px] px-0.5 t-dim2 hover:opacity-70" aria-label="Reset this shortcut">✕</button>
            )}
          </span>
        </span>
      )}
      <span className="shrink-0 flex items-center gap-1.5">
        <span className="text-[9px] t-dim2 w-[62px] text-right">{chord ? "dashboard" : "press"}</span>
        <button onClick={onCapture} className="chip text-[10px] tabular-nums min-w-[74px] text-center"
          style={capturing
            ? { color: "var(--primary-hover)", borderColor: "color-mix(in srgb, var(--primary) 60%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }
            : { color: "var(--text2)" }}>
          {capturing ? "Press a key…" : keyName === " " ? "space" : keyName}
        </button>
      </span>
    </div>
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

  if (!rows) return <Section title="Activity"><div className="px-3 py-3 text-[11.5px] t-dim2">Loading…</div></Section>;
  if (!rows.length) {
    return (
      <Section title="Activity">
        <div className="px-3 py-3 text-[11.5px] t-dim2">
          Nothing yet. Every write this dashboard performs — staging, discarding, pushing,
          merging, container actions, gate decisions — is recorded here as it happens.
        </div>
      </Section>
    );
  }

  return (
    <Section title="Activity">
      <div className="px-3 pb-2 text-[10.5px] t-dim2">
        Newest first. Kept indefinitely — these are the changes you made, not telemetry.
        Held tool calls appear here whoever resolved them, including the ones the timeout
        decided while nobody was looking.
      </div>
      <div className="flex flex-col">
        {rows.map((r) => (r.kind === "gate" ? <GateLine key={r.key} g={r.row} /> : <ActionLine key={r.key} a={r.row} />))}
      </div>
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
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 items-baseline px-3 py-1.5 rounded-lg hover:bg-white/5">
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
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 items-baseline px-3 py-1.5 rounded-lg hover:bg-white/5">
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
      .then((r) => { ingestUpdate(r); if (live) setSt(r); })
      .catch(() => { if (live) setSt(null); });
    return () => { live = false; };
  }, [open]);

  const run = async () => {
    setBusy(true); setErr(null);
    const r = await api.updateRun().catch(() => ({ ok: false, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Update failed to start"); return; }
    setStarted(true);
  };

  if (!st) return <Section title="About"><div className="px-3 py-2 text-[11px] t-dim2">Reading version…</div></Section>;

  const short = st.info.commit ? st.info.commit.slice(0, 7) : "unknown";
  const mine = installedNotes(st.info.baseTag, st.info.distance, st.branch);
  return (
    <Section title="About">
      <div className="px-3 py-2 flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-[12.5px]" style={{ color: "var(--text)" }}>agentglass {st.info.version}</span>
          <span className="text-[10.5px] t-dim2 tabular-nums" title={st.info.commit}>{short}</span>
          {st.info.builtAt && <span className="text-[10px] t-dim2">Built {new Date(st.info.builtAt).toLocaleString()}</span>}
          {/* The notes used to appear once, on the launch after an update, and
              were unreachable ever after — dismiss it, or update before it
              existed, and the only copy was on the release page. */}
          {mine && (
            <button onClick={() => setWant(mine)}
              className="ml-auto text-[10.5px] px-2 py-0.5 rounded-md hover:opacity-80"
              style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>
              Release notes
            </button>
          )}
        </div>

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
          <div className="text-[11px] t-dim2">
            {st.branch ? `Up to date — ${st.branch} is the newest release.` : "Up to date."}
          </div>
        ) : (
          <>
            <div className="text-[11px]" style={{ color: "var(--text)" }}>
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

  if (!st) return <Section title="Claude Code hooks"><div className="px-3 py-2 text-[11px] t-dim2">Reading hook state…</div></Section>;

  return (
    <Section title="Claude Code hooks">
      <div className="px-3 py-2 flex flex-col gap-2.5">
        <div className="text-[11.5px]" style={{ color: "var(--text2)" }}>
          Wire agentglass into Claude Code so every session streams here live, and gate approvals (<span className="tabular-nums">PreToolUse</span>) reach the app. Edits <span className="t-mono text-[10.5px]" style={{ color: "var(--text)" }}>{st.settingsPath}</span>, backing it up first, and leaves your other hooks untouched.
        </div>

        {!st.bundled ? (
          <div className="text-[11px] px-2.5 py-2 rounded-lg" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)" }}>
            This build does not carry the hook scripts, so there is nothing to wire. Install from a Release, or run <span className="t-mono">bun run setup</span> in a checkout.
          </div>
        ) : (
          <>
            <div className="text-[11px]" style={{ color: st.installed ? "var(--success)" : "var(--text2)" }}>
              {st.installed ? "Enabled — this Claude Code is streaming to agentglass." : "Not wired yet."}
            </div>
            {err && <div className="text-[10.5px]" style={{ color: "var(--error)" }}>{err}</div>}
            {note && <div className="text-[10.5px]" style={{ color: "var(--text2)" }}>{note}</div>}
            <div className="flex items-center gap-2">
              {!st.installed ? (
                <button onClick={() => act("install")} disabled={busy}
                  className="text-[11.5px] px-3 py-1.5 rounded-lg font-medium"
                  style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)", opacity: busy ? 0.5 : 1 }}>
                  {busy ? "Enabling…" : "Enable hooks"}
                </button>
              ) : (
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
      <div className="px-3 py-2">
        <AgentsPane open={open} />
      </div>
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
    <div className="px-3 py-2 rounded-lg hover:bg-white/5">
    <div className="flex items-start gap-2.5">
      <span className="mt-[5px] shrink-0 w-[7px] h-[7px] rounded-full" style={{ background: color }} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-[12.5px]" style={{ color: "var(--text)" }}>{d.title}</span>
          <code className="text-[10px] t-mono t-dim2">{d.bin}</code>
          <span className="text-[10px]" style={{ color }}>{STATUS_LABEL[d.status]}</span>
          {d.status !== "ok" && d.status !== "unsupported" && d.required && (
            <span className="chip text-[9px]" style={{ color: "var(--error)" }}>needed</span>
          )}
        </span>
        <span className="block text-[10.5px] t-dim2 mt-0.5">{d.what}</span>
        {d.detail && d.status !== "ok" && (
          <span className="block text-[10.5px] mt-0.5" style={{ color }}>{d.detail}</span>
        )}
        {d.note && d.status !== "ok" && d.status !== "unsupported" && (
          <span className="block text-[10px] t-dim2 mt-0.5">{d.note}</span>
        )}
      </span>
      {/* Only where there is something to do about it. A row that is already
          ready does not need a link, and a tool this platform never uses has
          nothing to install. */}
      {/* The console comes first, because it is the one that finishes the job.
          `>_` rather than "Install": it says a terminal is about to open, which
          is the thing worth knowing before clicking. */}
      {canType && (
        <button onClick={() => setConsole((v) => !v)}
          className="shrink-0 text-[10.5px] px-2 py-1 rounded-lg whitespace-nowrap"
          style={console
            ? { color: "var(--text)", background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }
            : { color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 34%, transparent)" }}
          title="Open a shell here with the command typed in — you press Enter">
          {">_ Install"}
        </button>
      )}
      {href && d.status !== "unsupported" && d.status !== "ok" && (
        <a href={href} target="_blank" rel="noreferrer noopener"
          className="shrink-0 text-[10.5px] px-2 py-1 rounded-lg"
          style={{ color: canType ? "var(--text3)" : "var(--primary-hover)", border: `1px solid color-mix(in srgb, var(--${canType ? "border" : "primary"}) 34%, transparent)` }}>
          Install guide
        </a>
      )}
    </div>
    {/* Expanded in place rather than in a modal: the row you clicked stays on
        screen above it, so what is being installed and why is still readable
        while you decide. */}
    {console && canType && <ShellConsole command={d.install!} cwd={home} onClose={() => setConsole(false)} />}
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
  const shellRoot = (() => { try { return localStorage.getItem("agentglass.terminalRoot") || ""; } catch { return ""; } })();
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

  if (err) return <Section title="Requirements"><div className="px-3 py-2 text-[11px]" style={{ color: "var(--error)" }}>{err}</div></Section>;
  if (!deps) return <Section title="Requirements"><div className="px-3 py-2 text-[11px] t-dim2">Checking this machine…</div></Section>;

  const live = deps.filter((d) => d.status !== "unsupported");
  const idle = deps.filter((d) => d.status === "unsupported");
  const needed = live.filter((d) => d.required).sort(byUrgency);
  const optional = live.filter((d) => !d.required).sort(byUrgency);
  const broken = live.filter((d) => d.status === "missing" && d.required).length;
  const wanting = live.filter((d) => d.status === "attention" || (d.status === "missing" && !d.required)).length;

  return (
    <Section title="Requirements">
      <div className="px-3 pb-2 flex flex-col gap-2">
        <div className="text-[11.5px]" style={{ color: "var(--text2)" }}>
          agentglass drives the tools you already have rather than bundling its own. This is what it looks for
          {platform && platform !== "demo" ? <> on this machine (<span className="t-mono text-[10.5px]">{platform}</span>)</> : null}, and what stops
          working when one is absent. Install whatever is missing however you normally install software here, then recheck.
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px]" style={{ color: broken ? "var(--error)" : wanting ? "var(--warning)" : "var(--success)" }}>
            {broken
              ? `${broken} needed ${broken === 1 ? "tool is" : "tools are"} missing`
              : wanting
                ? `Everything needed is here. ${wanting} optional ${wanting === 1 ? "feature is" : "features are"} standing down.`
                : "Everything agentglass looks for is here."}
          </span>
          <button onClick={() => void load(true)} disabled={busy}
            className="ml-auto text-[10.5px] px-2.5 py-1 rounded-lg"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", opacity: busy ? 0.5 : 1 }}>
            {busy ? "Checking…" : "Recheck"}
          </button>
        </div>
      </div>

      <div className="panel-eyebrow px-3 pt-1 pb-1">Needed</div>
      {needed.map((d) => <DepRow key={d.id} d={d} home={shellRoot} />)}

      <div className="panel-eyebrow px-3 pt-2 pb-1">Per feature</div>
      {optional.map((d) => <DepRow key={d.id} d={d} home={shellRoot} />)}

      {idle.length > 0 && (
        <>
          <div className="panel-eyebrow px-3 pt-2 pb-1">Not used on {platform}</div>
          <div className="px-3 pb-2 text-[10.5px] t-dim2">
            {idle.map((d) => d.title).join(", ")}. Nothing to do about these here.
          </div>
        </>
      )}
    </Section>
  );
}

export function SettingsModal({ open, onClose, sound, onSound, scale, onZoom, onOpenStats, onOpenHelp, theme, onTheme }: {
  open: boolean; onClose: () => void; sound: boolean; onSound: () => void;
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
  const [q, setQ] = useState(""); // settings search — filters the nav below
  const [termFont, setTermFontState] = useState(() => currentTermFont());
  const [termSize, setTermSizeState] = useState(() => currentTermSize());
  const [termLine, setTermLineState] = useState(() => currentTermLineHeight());
  const [termCursor, setTermCursorState] = useState<CursorStyle>(() => currentTermCursor());
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

  // Closing the modal mid-capture has to drop the capture. This component stays
  // mounted with `open` merely toggled (Portal/AnimatePresence own the exit), so
  // neither capture effect above unmounts on close, and while `capturing` /
  // `capturingChord` stay set their window-level, capture-phase keydown listener
  // stays attached to a dialog that is no longer on screen — swallowing the next
  // keystroke anywhere in the app into a rebind nobody is doing. Clearing the
  // capture state re-runs those effects, and their cleanup is where the listener
  // actually comes off.
  useEffect(() => { if (!open) { setCapturing(null); setCapturingChord(null); setKeyError(null); } }, [open]);

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
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 agx-scrim" style={{ zIndex: 10000 }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ type: "spring", stiffness: 340, damping: 30 }}
                className="w-[1240px] max-w-[96vw] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
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
                                style={{ height: "min(92vh, 900px)", background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>

                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Settings</span>
                  <button onClick={onClose} className="ml-auto text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                </div>

                <div className="flex-1 min-h-0 flex">
                  {/* One page per concern instead of one long scroll: four
                      sections stacked vertically meant the shortcuts, the part
                      you come here to change, were always below the fold. */}
                  <div className="shrink-0 w-[186px] py-2 px-2 flex flex-col gap-0.5 border-r agx-scroll overflow-y-auto" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings"
                      className="mb-1 px-2.5 py-1.5 rounded-lg text-[11px] outline-none shrink-0"
                      style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                    {(() => {
                      const ql = q.trim().toLowerCase();
                      const hit = (t: typeof TABS[number]) => !ql || (t.label + " " + t.kw).toLowerCase().includes(ql);
                      const groups = TAB_GROUPS
                        .map((g) => ({ g, tabs: TABS.filter((t) => t.group === g && hit(t)) }))
                        .filter((x) => x.tabs.length);
                      if (!groups.length) return <div className="px-2.5 py-3 text-[11px]" style={{ color: "var(--text4)" }}>No settings match “{q.trim()}”.</div>;
                      return groups.map(({ g, tabs }) => (
                        <div key={g} className="flex flex-col gap-0.5">
                          <div className="px-2.5 pt-2 pb-0.5 text-[9px] uppercase tracking-[0.16em]" style={{ color: "var(--text4)" }}>{g}</div>
                          {tabs.map((t) => (
                            <button key={t.id} onClick={() => setPane(t.id)}
                              className="w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] flex items-center gap-2"
                              style={pane === t.id
                                ? { background: "color-mix(in srgb, var(--primary) 15%, transparent)", color: "var(--text)" }
                                : { color: "var(--text3)" }}>
                              {t.label}
                            </button>
                          ))}
                        </div>
                      ));
                    })()}
                  </div>

                  <div className="agx-scroll flex-1 min-w-0 overflow-y-auto">
                  {pane === "appearance" && (
                  <Section title="Appearance">
                    {/* The theme drives everything — app chrome, the terminal's
                        own palette, and on the desktop it is synced out to tmux
                        and nvim too. It used to live in the masthead; it belongs
                        here, where a control this heavy isn't in the way. */}
                    <p className="px-3 pb-1 text-[11px] t-dim2">One palette for the whole cockpit — chrome, terminal, and (on the desktop) your tmux and nvim follow it.</p>
                    <AppearancePane current={theme} onChange={onTheme} />
                  </Section>
                  )}
                  {pane === "terminal" && (
                  <Section title="Terminal">
                    {/* GPU (WebGL) is faster on heavy output, but on some Linux
                        GPU/compositor stacks it can leave the terminal blank
                        white — so Auto uses it everywhere except Linux, where it
                        picks Compatibility. Switch to Compatibility by hand if a
                        shell ever goes blank; it applies to newly opened shells. */}
                    <Choice<RendererPref>
                      label="Terminal renderer"
                      hint="GPU is faster; Compatibility is the safe choice if the terminal ever goes blank. Applies to newly opened shells."
                      value={renderer}
                      onPick={(v) => { setRenderer(v); setRendererPref(v); }}
                      options={[
                        { v: "auto", label: "Auto" },
                        { v: "gpu", label: "GPU" },
                        { v: "dom", label: "Compatibility" },
                      ]} />

                    <div className="px-3 pt-1 pb-2">
                      <div className="text-[12px] mb-2" style={{ color: "var(--text)" }}>Font</div>
                      <div className="grid grid-cols-2 gap-1.5">
                        {TERM_FONTS.map((f) => {
                          const avail = f.bundled || fontAvailable(f.family);
                          const on = termFont === f.id;
                          return (
                            <button key={f.id || "sys"} disabled={!avail}
                              onClick={() => { setTermFont(f.id); setTermFontState(f.id); }}
                              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] text-left"
                              style={{
                                background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "color-mix(in srgb, var(--bg3) 30%, transparent)",
                                border: `1px solid ${on ? "var(--primary)" : "transparent"}`,
                                opacity: avail ? 1 : 0.45, cursor: avail ? "pointer" : "not-allowed",
                                fontFamily: f.stack || undefined,
                              }}>
                              <span className="truncate" style={{ color: "var(--text2)" }}>{f.name}</span>
                              {!avail ? <span className="ml-auto text-[9px] shrink-0 t-dim2">not installed</span>
                                : on ? <span className="ml-auto shrink-0" style={{ color: "var(--primary-hover)" }}>✓</span> : null}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[10px] t-dim2 mt-2">These faces ship with agentglass — no install needed, and they render the same on any machine.</p>
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
                  </Section>
                  )}
                  {pane === "prefs" && (
                  <Section title="Preferences">
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
                  <Section title="Chat">
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
                  <Section title="Budgets">
                    {/* A limit you chose, so the spend insights stop firing on
                        constants — which are noise on a project that genuinely
                        costs that and silence on one where a tenth would be
                        alarming. */}
                    <div className="flex flex-col gap-1.5 pt-1">
                      <span className="text-[10px] t-dim2 uppercase tracking-wider">Spending budgets</span>
                      <BudgetsPane open={open} />
                    </div>
                    {/* The consequence of the setting above, made visible.
                        Panes outlive the app, so "how new chats run" quietly
                        decides how much memory is resident on this machine an
                        hour from now, and until this list existed the only
                        place to see that was a terminal. */}
                  </Section>
                  )}

                  {pane === "notifications" && (
                  <Section title="Notifications">
                    {/* Two sources, two switches. They share one surface — the
                        bell lists both — so "stop interrupting me" has to be
                        answerable about each separately, or turning off the
                        chatter means turning off the fleet you are watching. */}
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
                  </Section>
                  )}

                  {pane === "browser" && <BrowserPane />}

                  {pane === "rail" && <RailPane />}

                  {pane === "keys" && (
                  <Section title="Shortcuts">
                    {(Object.keys(DEFAULTS) as ActionId[]).map((id) => {
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
                    })}
                    <div className="px-3 pt-1 pb-1 flex items-center gap-3">
                      <span className="text-[10px] t-dim2 flex-1">
                        {/* Says why the rest of the keyboard is not on this list. */}
                        <b style={{ color: "var(--text2)" }}>anywhere</b> — hold any combination you like ({MOD_KEY}J, {MOD_KEY}Alt+J, Alt+Shift+J) and it is recorded as held. Left alone it follows the view's position in the rail, so reordering keeps it true. <b style={{ color: "var(--text2)" }}>dashboard</b> — a single key, and only on the dashboard: inside the workspace every keystroke belongs to whatever has focus, usually a shell. {MOD_KEY}\\, {MOD_KEY}K and {MOD_KEY}[ / {MOD_KEY}] stay put.
                      </span>
                      {(isCustomised() || chordsCustomised()) && (
                        <button onClick={() => { resetBindings(); resetChords(); setKeyError(null); setCapturing(null); setCapturingChord(null); }}
                          className="text-[10.5px] px-2 py-1 rounded-lg shrink-0"
                          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                          Reset to defaults
                        </button>
                      )}
                    </div>
                  </Section>
                  )}

                  {pane === "open" && (
                  <Section title="Open">
                    <Row label="Statistics" hint="Totals, tool latency and cost breakdowns" kbd="s"
                      onClick={() => { onOpenStats(); onClose(); }} />
                    <Row label="Legend & shortcuts" hint="What the colours mean, and every key binding" kbd="?"
                      onClick={() => { onOpenHelp(); onClose(); }} />
                    <Row label="Command palette" hint="Jump to any panel, filter or session" kbd={`${MOD_KEY}K`}
                      onClick={onClose} />
                  </Section>
                  )}

                  {pane === "export" && (
                  <Section title="Export">
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

                  {pane === "reqs" && <RequirementsPane open={open} />}

                  {pane === "remote" && <RemoteAccessPane open={open} />}

                  {pane === "log" && <ActivityPane open={open} />}
                  {pane === "about" && <AboutPane open={open} />}
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
