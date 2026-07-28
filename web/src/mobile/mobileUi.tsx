import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfirmSpec } from "../components/ConfirmDialog.tsx";

/**
 * The phone's own visual language, and the few primitives every screen needs.
 *
 * It shares agentglass's palette variables — this has to feel like the same
 * product — but not its density. A cockpit is read at arm's length with a
 * mouse; this is read at half that with a thumb, so targets are 44px and up,
 * surfaces are rounder, and figures are set as display type because figures
 * are what this app is made of.
 *
 * The CSS lives here as a string rather than in a stylesheet for the same
 * reason `MD_CSS` does in the pull request panel: the rules are meaningless
 * without the components below, and splitting them across two files is how
 * they drift.
 */
export const MOBILE_CSS = `
.mb{
  --tap:44px;
  --nav:64px;
  --mb-line:color-mix(in srgb,var(--border) 34%,transparent);
  --mb-card:color-mix(in srgb,var(--bg2) 70%,transparent);
  /* A raised surface catches light along its top edge and drops a shadow
     under it. Two declarations, and nothing looks like a flat rectangle. */
  --mb-edge:inset 0 1px 0 color-mix(in srgb,var(--primary-hover) 15%,transparent);
  --mb-drop:0 12px 28px -18px rgba(0,0,0,.9);
}
/* One fixed wash, so the app has a horizon instead of a flat backdrop. */
.mb-sky{position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(120% 55% at 50% -12%,color-mix(in srgb,var(--primary) 13%,transparent),transparent 62%),
    radial-gradient(80% 40% at 100% 100%,color-mix(in srgb,var(--border) 18%,transparent),transparent 60%)}

.mb-fig{font-variant-numeric:tabular-nums;font-weight:700;letter-spacing:-.045em;line-height:1}
.mb-tnum{font-variant-numeric:tabular-nums}
.mb-eyebrow{font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);font-weight:600}

/* Every press answers inside one frame. */
.mb-press{transition:transform .09s cubic-bezier(.2,.9,.3,1),background .14s,border-color .14s,opacity .14s}
.mb-press:active:not(:disabled){transform:scale(.972)}
.mb-press:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.mb-press:disabled{opacity:.38}

.mb-btn{min-height:46px;padding:0 16px;border-radius:13px;font-size:13px;display:inline-flex;align-items:center;
  justify-content:center;gap:7px;border:1px solid color-mix(in srgb,var(--border) 50%,transparent);color:var(--text2);
  background:transparent}
.mb-btn.sm{min-height:42px;padding:0 13px;font-size:11.5px;border-radius:11px}
.mb-btn.acc{background:var(--primary-hover);border-color:var(--primary-hover);color:var(--bg);font-weight:700;
  box-shadow:0 6px 20px -8px var(--primary)}
.mb-btn.ok{background:var(--success);border-color:var(--success);color:#06231a;font-weight:700}
.mb-btn.no{color:var(--error);background:color-mix(in srgb,var(--error) 12%,transparent);
  border-color:color-mix(in srgb,var(--error) 42%,transparent)}
.mb-btn.dang{color:var(--error);border-color:color-mix(in srgb,var(--error) 45%,transparent)}

.mb-card{border-radius:16px;background:var(--mb-card);
  border:1px solid color-mix(in srgb,var(--border) 38%,transparent);box-shadow:var(--mb-edge)}
.mb-row{display:flex;align-items:center;gap:12px;width:100%;padding:13px;border-radius:15px;min-height:58px;
  background:var(--mb-card);border:1px solid color-mix(in srgb,var(--border) 32%,transparent);
  box-shadow:var(--mb-edge);text-align:left}
.mb-row .i{min-width:0;flex:1}
.mb-row .i b{display:block;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mb-row .i span{display:block;font-size:10.5px;color:var(--text3);margin-top:3px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mb-row .r{flex:none;font-size:11px;color:var(--text3);text-align:right}

.mb-dot{width:8px;height:8px;border-radius:50%;flex:none}
.mb-dot.pulse{animation:mb-dp 2s ease-out infinite}
@keyframes mb-dp{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 55%,transparent)}100%{box-shadow:0 0 0 8px transparent}}
.mb-chip{font-size:10px;padding:2px 8px;border-radius:20px;border:1px solid currentColor;white-space:nowrap}

.mb-seg{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none}
.mb-seg::-webkit-scrollbar{display:none}
.mb-seg button{flex:none;min-height:40px;padding:0 15px;border-radius:22px;font-size:12px;color:var(--text3);
  border:1px solid color-mix(in srgb,var(--border) 36%,transparent);display:flex;align-items:center;gap:6px;
  transition:all .2s cubic-bezier(.3,1.2,.5,1);background:transparent}
.mb-seg button[aria-pressed="true"]{color:var(--bg);background:var(--primary-hover);border-color:var(--primary-hover);
  font-weight:700;box-shadow:0 4px 16px -6px var(--primary)}
/* The sections stay reachable however far down a long list you are. */
.mb-sticky{position:sticky;top:0;z-index:5;margin:0 -15px 13px;padding:9px 15px;
  background:color-mix(in srgb,var(--bg) 84%,transparent);backdrop-filter:blur(14px);
  border-bottom:1px solid color-mix(in srgb,var(--border) 24%,transparent)}

.mb-empty{border-radius:20px;padding:40px 22px;text-align:center;
  border:1px dashed color-mix(in srgb,var(--border) 45%,transparent);
  background:color-mix(in srgb,var(--bg2) 40%,transparent)}
.mb-empty .g{font-size:25px;opacity:.7;margin-bottom:9px}
.mb-empty b{display:block;font-size:15px;font-weight:600}
.mb-empty span{display:block;font-size:12px;color:var(--text2);margin-top:7px;line-height:1.6}

/* A switch, not a tick: viewed and staged are states you keep for the length
   of a review, and a checkbox does not say that. */
/* Drawn 42x25 and hit at 44px tall: a switch this size is comfortable to read
   and uncomfortable to hit, so the target grows without the shape growing. */
.mb-sw{position:relative;width:42px;height:25px;border-radius:14px;flex:none;
  background:color-mix(in srgb,var(--border) 52%,transparent);transition:background .2s;
  box-sizing:content-box;border-top:10px solid transparent;border-bottom:9px solid transparent;
  background-clip:padding-box}
.mb-sw::after{content:"";position:absolute;top:3px;left:3px;width:19px;height:19px;border-radius:50%;
  background:var(--text3);transition:transform .24s cubic-bezier(.3,1.5,.5,1),background .2s}
.mb-sw[data-on="1"]{background:color-mix(in srgb,var(--success) 58%,transparent)}
.mb-sw[data-on="1"]::after{transform:translateX(17px);background:var(--success)}

/* ── screens ──────────────────────────────────────────────────────── */
.mb-screen{position:fixed;inset:0;z-index:60;background:var(--bg);display:flex;flex-direction:column;
  transform:translateX(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);will-change:transform}
.mb-screen.on{transform:none}
.mb-screen .hd{display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top) + 11px) 13px 10px;
  border-bottom:1px solid var(--mb-line);background:color-mix(in srgb,var(--bg) 84%,transparent);backdrop-filter:blur(16px)}
.mb-screen .hd .back{min-height:42px;min-width:42px;display:grid;place-items:center;font-size:20px;
  color:var(--primary-hover);margin-left:-6px;background:transparent}
.mb-screen .hd .t{min-width:0;flex:1}
.mb-screen .hd .t b{display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mb-screen .hd .t span{display:block;font-size:10.5px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mb-screen .bd{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;
  padding:14px 15px calc(env(safe-area-inset-bottom) + 20px)}
.mb-screen .ft{border-top:1px solid var(--mb-line);background:color-mix(in srgb,var(--bg2) 88%,transparent);
  backdrop-filter:blur(16px);padding:11px 15px calc(env(safe-area-inset-bottom) + 11px);
  display:flex;gap:9px;align-items:center}

/* ── conversation ─────────────────────────────────────────────────── */
/* A chat screen, sized to the viewport that is actually visible.
   inset:0 measures the LARGE viewport, the one that assumes the browser's URL
   bar is hidden — so on Chrome for Android, whose bar sits at the bottom and
   comes back on every upward scroll, the composer spent half its life
   underneath it. 100dvh is the viewport as it stands right now, which also
   means the keyboard opening shortens the thread rather than pushing the
   composer off the screen. */
.mb-chat{bottom:auto;height:100dvh}
/* The thread is the only thing that scrolls, and it is chained: flicking past
   the last message must not start dragging the page behind it. */
.mb-chat .bd{display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain;
  padding:14px 15px 10px}
.mb-jump{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom) + 84px);
  z-index:2;font-size:11.5px;font-weight:600;padding:7px 14px;border-radius:999px;
  color:#150c28;background:color-mix(in srgb,var(--primary) 90%,#000);
  box-shadow:0 8px 20px -10px #000;border:none}

/* ── sheet ────────────────────────────────────────────────────────── */
.mb-scrim{position:fixed;inset:0;z-index:70;background:rgba(4,1,10,.66);opacity:0;pointer-events:none;
  transition:opacity .24s;backdrop-filter:blur(3px)}
.mb-scrim.on{opacity:1;pointer-events:auto}
.mb-sheet{position:fixed;left:0;right:0;bottom:0;z-index:71;border-radius:24px 24px 0 0;
  background:linear-gradient(180deg,color-mix(in srgb,var(--bg3) 50%,var(--bg2)),var(--bg2));
  border-top:1px solid color-mix(in srgb,var(--primary) 38%,transparent);transform:translateY(100%);
  transition:transform .3s cubic-bezier(.32,.72,0,1);max-height:88dvh;display:flex;flex-direction:column;
  box-shadow:0 -20px 50px -20px #000}
.mb-sheet.on{transform:none}
.mb-sheet .grab{width:40px;height:4px;border-radius:3px;flex:none;margin:10px auto 5px;
  background:color-mix(in srgb,var(--border) 72%,transparent)}
/* min-height:0 is what lets this scroll. A flex child will not shrink below its
   content without it, so the sheet grew past its own max-height instead of
   scrolling inside it — and the last rows were simply unreachable, which is
   most obvious in landscape where there is half the height to work with.
   The cap is dvh, not vh: vh measures the viewport as if the browser's URL bar
   were hidden, which it usually is not. */
.mb-sheet .in{padding:7px 16px calc(env(safe-area-inset-bottom) + 18px);overflow-y:auto;
  min-height:0;flex:1;overscroll-behavior:contain}
.mb-sheet h3{font-size:16px;font-weight:600}

/* ── toasts ───────────────────────────────────────────────────────── */
.mb-toasts{position:fixed;left:14px;right:14px;z-index:90;display:flex;flex-direction:column;gap:9px;
  pointer-events:none;bottom:calc(var(--nav) + env(safe-area-inset-bottom) + 14px)}
.mb-toasts.raised{bottom:calc(env(safe-area-inset-bottom) + 112px)}
.mb-toast{border-radius:14px;padding:12px 15px;font-size:12.5px;display:flex;align-items:center;gap:10px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--bg3) 80%,var(--bg2)),var(--bg2));
  border:1px solid color-mix(in srgb,var(--primary) 46%,transparent);
  box-shadow:0 16px 40px -16px #000,var(--mb-edge);animation:mb-tin .3s cubic-bezier(.2,1.2,.3,1)}
.mb-toast .g{font-weight:700;font-size:14px;flex:none;color:var(--success)}
.mb-toast.bad .g{color:var(--error)}
@keyframes mb-tin{from{transform:translateY(18px) scale(.94);opacity:0}}

.mb-spin{width:13px;height:13px;border-radius:50%;flex:none;
  border:1.8px solid color-mix(in srgb,currentColor 26%,transparent);border-top-color:currentColor;
  animation:mb-sp .6s linear infinite}
@keyframes mb-sp{to{transform:rotate(360deg)}}

@media(prefers-reduced-motion:reduce){
  .mb *,.mb-screen,.mb-sheet,.mb-scrim,.mb-toast{animation-duration:.01ms !important;
    animation-iteration-count:1 !important;transition-duration:.01ms !important}
}
`;

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------

export type Toast = { id: number; msg: string; bad?: boolean };

/** Says what happened, in the past tense, after it happened. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const toast = useCallback((msg: string, bad = false) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, msg, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);
  return { toasts, toast };
}

export function Toasts({ toasts, raised }: { toasts: Toast[]; raised?: boolean }) {
  return (
    <div className={`mb-toasts${raised ? " raised" : ""}`} aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`mb-toast${t.bad ? " bad" : ""}`}>
          <span className="g">{t.bad ? "✕" : "✓"}</span><span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------

/**
 * Makes the phone's own back gesture close whatever is on top.
 *
 * Without it, back leaves agentglass entirely from a diff three levels deep,
 * which is the fastest way to make a companion feel broken.
 */
/**
 * One stack for every screen, and one history entry that serves whichever is
 * on top.
 *
 * The first version of this gave each screen its own entry, and closing one by
 * button called `history.back()` to tidy that entry up. `history.back()` fires
 * a popstate, and every *other* open screen was listening for popstate as its
 * own cue to close. Opening a diff from the repo screen therefore did this:
 * the repo screen's `open` went false (its condition excludes an open diff), it
 * called back(), and the popstate landed on the diff that had just opened,
 * which closed itself immediately. The file you tapped flashed and vanished,
 * every time, and the app looked like it could not load a diff at all.
 *
 * So: the screens form a stack, only the top one answers a back gesture, and
 * the entry a programmatic close consumes is ignored by everyone rather than
 * broadcast to all of them.
 */
type ScreenEntry = { close: () => void };
const screenStack: ScreenEntry[] = [];
let entryOwned = false;
let ignoreNextPop = false;

function ensureEntry() {
  if (entryOwned || typeof history === "undefined") return;
  history.pushState({ mbScreen: true }, "");
  entryOwned = true;
}

function onPopState() {
  // Our own tidy-up, not a person pressing back.
  if (ignoreNextPop) { ignoreNextPop = false; return; }
  entryOwned = false;
  const top = screenStack.pop();
  top?.close();
  // Still somewhere below the surface: keep an entry so the next press closes
  // the next screen instead of leaving the app.
  if (screenStack.length) ensureEntry();
}

if (typeof window !== "undefined") window.addEventListener("popstate", onPopState);

export function useBackClose(open: boolean, close: () => void) {
  // The latest close, without re-registering the entry on every render.
  const latest = useRef(close);
  latest.current = close;

  useEffect(() => {
    if (!open) return;
    const entry: ScreenEntry = { close: () => latest.current() };
    screenStack.push(entry);
    ensureEntry();
    return () => {
      const at = screenStack.lastIndexOf(entry);
      if (at >= 0) screenStack.splice(at, 1);
      // Only when nothing is left is the entry ours to give back, and the
      // popstate it causes is ours to swallow.
      if (!screenStack.length && entryOwned) {
        ignoreNextPop = true;
        entryOwned = false;
        history.back();
      }
    };
  }, [open]);
}

export function Screen({ open, title, sub, onBack, right, foot, children }: {
  open: boolean; title: string; sub?: string; onBack: () => void;
  right?: React.ReactNode; foot?: React.ReactNode; children: React.ReactNode;
}) {
  useBackClose(open, onBack);
  const body = useRef<HTMLDivElement>(null);
  return (
    <div className={`mb-screen${open ? " on" : ""}`} aria-hidden={!open}>
      <div className="hd">
        <button className="back mb-press" onClick={onBack} aria-label="Back">‹</button>
        <span className="t"><b>{title}</b>{sub && <span>{sub}</span>}</span>
        {right}
      </div>
      <div className="bd" ref={body}>{open && children}</div>
      {foot && <div className="ft">{foot}</div>}
    </div>
  );
}

export function Sheet({ open, title, sub, onClose, children }: {
  open: boolean; title: string; sub?: string; onClose: () => void; children: React.ReactNode;
}) {
  useBackClose(open, onClose);
  return (
    <>
      <div className={`mb-scrim${open ? " on" : ""}`} onClick={onClose} />
      <div className={`mb-sheet${open ? " on" : ""}`} role="dialog" aria-hidden={!open} aria-label={title}>
        <div className="grab" />
        <div className="in">
          <h3>{title}</h3>
          {sub && <div className="text-[11px] mt-1 mb-3" style={{ color: "var(--text3)" }}>{sub}</div>}
          {open && children}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

/**
 * A button that shows its own work.
 *
 * `onAct` returns a message; the button spins until it resolves and the caller
 * toasts what happened. The label stays put while it spins, so the row does not
 * jump under the thumb that pressed it.
 */
export function Act({ children, onAct, kind, small, disabled, title, full }: {
  children: React.ReactNode;
  onAct: () => Promise<string | void> | string | void;
  kind?: "acc" | "ok" | "no" | "dang"; small?: boolean; disabled?: boolean; title?: string; full?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  return (
    <button
      className={`mb-btn mb-press${kind ? " " + kind : ""}${small ? " sm" : ""}`}
      style={full ? { width: "100%" } : undefined}
      disabled={disabled || busy} title={title}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try { await onAct(); } finally { if (alive.current) setBusy(false); }
      }}>
      {busy && <span className="mb-spin" />}
      {children}
    </button>
  );
}

/**
 * The phone's answer to `useDialogs()`.
 *
 * Same contract as the desktop's — `ConfirmSpec` in, `Promise<boolean>` out,
 * render the node it hands back — so a call site reads identically on both:
 *
 *   if (!(await ask({ title: "Discard src/cart.ts?", danger: true }))) return;
 *
 * Different surface, because a centred modal on a phone is the same foreignness
 * `ConfirmDialog` was written to avoid, one layer up: it ignores the back
 * gesture, puts its buttons where nothing else on the screen puts them, and
 * lands nowhere near the thumb. This is the sheet every other question on the
 * phone already arrives in.
 *
 * The title is where the work is. On a phone the thing being acted on is
 * usually not on screen when the button is — the file is behind a diff, the
 * container behind a stats card, the branch not rendered at all — so "Discard?"
 * asks a question the person cannot answer. Naming it is the confirmation.
 */
export function useAsk(): { ask: (spec: ConfirmSpec) => Promise<boolean>; dialog: React.ReactNode } {
  const [pending, setPending] = useState<(ConfirmSpec & { resolve: (v: boolean) => void }) | null>(null);
  const settle = useCallback((v: boolean) => {
    setPending((p) => { p?.resolve(v); return null; });
  }, []);

  const ask = useCallback(
    (spec: ConfirmSpec) => new Promise<boolean>((resolve) => setPending({ ...spec, resolve })),
    [],
  );

  const dialog = (
    // Dismissing by the scrim or the back gesture resolves false, exactly as
    // the desktop's does — a question the person walked away from is a no.
    <Sheet open={!!pending} title={pending?.title ?? ""} sub={pending?.body} onClose={() => settle(false)}>
      {pending && (
        <div className="flex flex-col gap-2">
          <Act full kind={pending.danger ? "dang" : "acc"} onAct={() => settle(true)}>
            {pending.confirmLabel ?? "Confirm"}
          </Act>
          <Act full onAct={() => settle(false)}>{pending.cancelLabel ?? "Cancel"}</Act>
        </div>
      )}
    </Sheet>
  );
  return { ask, dialog };
}

export function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button className="mb-sw mb-press" data-on={on ? "1" : "0"}
      role="switch" aria-checked={on} aria-label={label} onClick={onToggle} />
  );
}

export function Seg<T extends string>({ value, options, onPick, sticky }: {
  value: T; options: { id: T; label: string; n?: number | null }[]; onPick: (v: T) => void; sticky?: boolean;
}) {
  return (
    <div className={`mb-seg${sticky ? " mb-sticky" : ""}`}>
      {options.map((o) => (
        <button key={o.id} aria-pressed={o.id === value} className="mb-press" onClick={() => onPick(o.id)}>
          {o.label}{o.n != null && <span className="mb-tnum">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ glyph, title, body }: { glyph: string; title: string; body: string }) {
  return (
    <div className="mb-empty">
      <div className="g">{glyph}</div>
      <b>{title}</b><span>{body}</span>
    </div>
  );
}

export function Row({ tint, title, sub, right, onClick, pulse }: {
  tint?: string; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode;
  onClick?: () => void; pulse?: boolean;
}) {
  const inner = (
    <>
      {tint && <span className={`mb-dot${pulse ? " pulse" : ""}`} style={{ background: tint, color: tint }} />}
      <span className="i"><b>{title}</b>{sub && <span>{sub}</span>}</span>
      {right && <span className="r">{right}</span>}
    </>
  );
  return onClick
    ? <button className="mb-row mb-press" onClick={onClick}>{inner}</button>
    : <div className="mb-row">{inner}</div>;
}
