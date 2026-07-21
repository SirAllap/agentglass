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
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { autostartEnabled, setAutostart, isFullscreen, toggleFullscreen, IS_DESKTOP } from "../lib/desktop.ts";
import { canZoomIn, canZoomOut, fmtScale } from "../lib/uiScale.ts";
import { MOD_KEY } from "../lib/format.ts";
import { sysNotifyMode, setSysNotifyMode, notifyCapability, type SysNotifyMode, type NotifyCapability } from "../lib/sysNotify.ts";
import { clock24, setClock24 } from "../lib/clockPref.ts";
import { bindings, rebind, resetBindings, subscribeBindings, isCustomised, LABELS, DEFAULTS, type ActionId,
         chordFor, rebindChord, clearChord, resetChords, chordsCustomised, chordFromEvent, chordLabel } from "../lib/keybindings.ts";
import { loadViewOrder, type ViewId } from "./workspace/views.ts";

function Toggle({ on, onClick, label, hint }: { on: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5">
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

type Pane = "prefs" | "keys" | "open" | "export";
const TABS: { id: Pane; label: string }[] = [
  { id: "prefs", label: "Preferences" },
  { id: "keys", label: "Shortcuts" },
  { id: "open", label: "Open" },
  { id: "export", label: "Export" },
];

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
            title={chord.custom
              ? `${chordLabel(chord.key)} opens this — click to record another, ✕ to go back to its rail position`
              : `${chordLabel(chord.key)} opens this, from its position in the rail — click to record your own`}
            className="chip text-[10px] tabular-nums min-w-[74px] text-center"
            style={chord.capturing
              ? { color: "var(--primary-hover)", borderColor: "color-mix(in srgb, var(--primary) 60%, transparent)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }
              : chord.custom
                ? { color: "var(--primary-hover)" }
                : { color: "var(--text2)", opacity: 0.6 }}>
            {chord.capturing ? "hold a combo…" : chordLabel(chord.key)}
          </button>
          <span className="w-3 shrink-0">
            {chord.custom && !chord.capturing && (
              <button onClick={chord.onClear} title="back to its position in the rail"
                className="text-[11px] px-0.5 t-dim2 hover:opacity-70" aria-label="reset this shortcut">✕</button>
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
          {capturing ? "press a key…" : keyName === " " ? "space" : keyName}
        </button>
      </span>
    </div>
  );
}

export function SettingsModal({ open, onClose, sound, onSound, scale, onZoom, onOpenStats, onOpenHelp }: {
  open: boolean; onClose: () => void; sound: boolean; onSound: () => void;
  scale: number; onZoom: (dir: 1 | -1 | 0) => void;
  onOpenStats: () => void; onOpenHelp: () => void;
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
  const [keys, setKeys] = useState(() => bindings());
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [pane, setPane] = useState<Pane>("prefs");
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
      const r = rebindChord(capturingChord, chord, loadViewOrder().map((v) => v.id));
      if (r.ok) { setCapturingChord(null); setKeyError(null); }
      else setKeyError({ id: `view.${capturingChord}`, msg: r.error });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingChord]);
  const [sysNotify, setSysNotifyState] = useState<SysNotifyMode>(() => sysNotifyMode());
  const [notifyCap, setNotifyCap] = useState<NotifyCapability | null>(null);
  useEffect(() => { if (open) void notifyCapability().then(setNotifyCap); }, [open]);

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
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ type: "spring", stiffness: 340, damping: 30 }}
                className="w-[820px] max-w-[95vw] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
                // Fixed, not max: with tabs the pane's height would otherwise
                // change with whichever section you picked, and a dialog that
                // resizes under the cursor is disorienting in a way a little
                // empty space never is.
                                style={{ height: "min(78vh, 620px)", background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>

                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Settings</span>
                  <button onClick={onClose} className="ml-auto text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                </div>

                <div className="flex-1 min-h-0 flex">
                  {/* One page per concern instead of one long scroll: four
                      sections stacked vertically meant the shortcuts, the part
                      you come here to change, were always below the fold. */}
                  <div className="shrink-0 w-[168px] py-2 px-2 flex flex-col gap-0.5 border-r" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                    {TABS.map((t) => (
                      <button key={t.id} onClick={() => setPane(t.id)}
                        className="w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] flex items-center gap-2"
                        style={pane === t.id
                          ? { background: "color-mix(in srgb, var(--primary) 15%, transparent)", color: "var(--text)" }
                          : { color: "var(--text3)" }}>
                        {t.label}
                      </button>
                    ))}
                  </div>

                  <div className="agx-scroll flex-1 min-w-0 overflow-y-auto">
                  {pane === "prefs" && (
                  <Section title="Preferences">
                    {/* Desktop only, like launch-at-login: in a browser tab the
                        browser's own zoom already does this, and better. */}
                    {IS_DESKTOP && (
                      <Stepper
                        label="Display size"
                        hint={`Scales the whole window — ${MOD_KEY}+ / ${MOD_KEY}− anywhere, ${MOD_KEY}0 to reset`}
                        value={fmtScale(scale)}
                        onDec={() => onZoom(-1)} onInc={() => onZoom(1)}
                        canDec={canZoomOut()} canInc={canZoomIn()} />
                    )}
                    <Toggle on={fullscreen} onClick={async () => setFullscreenState(await toggleFullscreen())}
                      label="Fullscreen"
                      hint="Hide the window frame — F11 anywhere" />
                    <Toggle on={sound} onClick={onSound}
                      label="Alert sounds"
                      hint="A chime when a session errors or needs you" />
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
                      hint="How the workspace strip shows the time"
                      value={h24 ? "24" : "12"}
                      onPick={(v) => { setClock24(v === "24"); setH24(v === "24"); }}
                      options={[{ v: "12", label: "12h" }, { v: "24", label: "24h" }]} />
                    <Choice<SysNotifyMode>
                      label="Desktop notifications on the notch"
                      hint="Slack and the rest, mirrored onto the strip you can still see in fullscreen"
                      disabled={notifyCap ? !notifyCap.supported : true}
                      disabledHint={notifyCap ? `Unavailable — ${notifyCap.reason}` : "Checking…"}
                      value={sysNotify}
                      onPick={(m) => { setSysNotifyMode(m); setSysNotifyState(m); }}
                      options={[
                        { v: "off", label: "Off" },
                        { v: "titles", label: "Who" },
                        { v: "full", label: "Full" },
                      ]} />
                  </Section>
                  )}

                  {pane === "keys" && (
                  <Section title="Shortcuts">
                    {(Object.keys(DEFAULTS) as ActionId[]).map((id) => {
                      const view = id.startsWith("view.") ? (id.slice(5) as ViewId) : null;
                      const order = loadViewOrder().map((v) => v.id);
                      return (
                        <KeyRow key={id} id={id} keyName={keys[id]}
                          capturing={capturing === id}
                          error={keyError?.id === id ? keyError.msg : null}
                          onCapture={() => { setKeyError(null); setCapturingChord(null); setCapturing((c) => (c === id ? null : id)); }}
                          chord={view ? {
                            key: chordFor(view, order),
                            custom: chordFor(view, order) !== `mod+${order.indexOf(view) + 1}`,
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
                          reset to defaults
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
                    <Row label="Skills catalog — Markdown" hint="Every skill the fleet has available"
                      href={api.skillsExportUrl()} download="agentglass-skills.md" />
                  </Section>
                  )}
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
