/*
 * The banners for notifications the person asked for (a PR watch they armed).
 *
 * Top centre, under the bar: the top-right belongs to the usage indicator and
 * the middle of the bar to the toast lane, so this sits below both and never
 * covers either. Not modal — the wrapper takes no pointer events, only the
 * banners do — so the rest of the window keeps working underneath.
 *
 * It has no timer. What was asked for waits: the primary action opens the target
 * in the app, Escape on a focused banner closes it, and so does the ×. At most
 * three are drawn — the newest as a card, the older two as one compact row each —
 * and the rest fold into "+N more alerts" (see askedBanners.ts).
 *
 * The card is the verdict's colour and nothing else is: a rail down the left, a
 * round icon, the verdict word in its ink, a soft halo and the primary button's
 * fill. Every colour is a house token, so it follows the theme, light or dark.
 * The button is filled with the INK, not the raw state colour, and its label is
 * the page background: measured over all 37 themes the pair never drops under
 * 4.99:1, where the raw `--success` under a white label was 2.5:1 on "light".
 */
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Portal } from "./Portal.tsx";
import { TOP_BAR_H } from "./TopBar.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { ICON, HIT } from "../lib/iconSize.ts";
import { EDGE } from "./workspace/Chrome.tsx";
import { actionTarget, primaryAction, secondaryAction, type AskedAlert, type NotifyAction } from "../../../shared/notifyPayload.ts";
import { openTarget } from "../lib/sysNotify.ts";
import { api } from "../lib/api.ts";
import { minutesAgo } from "../lib/format.ts";
import { closeAsked, layoutBanners, useAskedBanners } from "../lib/askedBanners.ts";

/** A check mark or a cross on the 24-box grid the rest of the icons share. */
/** Height of an older alert's row. With the card, two rows and the "+N" pill the whole stack stays under ~260px. */
const ROW_H = 36;

function Verdict({ ok, size = ICON.lg }: { ok: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ok ? <path d="M5 12.5l4.5 4.5L19 7" /> : <path d="M6 6l12 12M18 6L6 18" />}
    </svg>
  );
}

/** "CI passed · acme/orbit #1042": the verdict word is coloured, the object after it is plain text. */
function splitTitle(title: string): { verdict: string; object: string } {
  const cut = title.indexOf(" · ");
  return cut < 0 ? { verdict: title, object: "" } : { verdict: title.slice(0, cut), object: title.slice(cut) };
}

/** Rises on arrival and leaves the way it came; shared by the card and the compact row. */
const MOTION = {
  initial: { opacity: 0, y: -12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12, transition: { duration: 0.16 } },
  transition: { type: "spring" as const, stiffness: 420, damping: 34 },
};

/**
 * An older alert, folded to one row: icon, verdict and object, Open, close.
 *
 * Only the newest alert is a full card. Three of them stacked were ~400px tall
 * and sat over the view's own toolbar for as long as they persisted, so the
 * older ones keep what is needed to act (what it was and one press to its
 * target) and give back the rest. The facts and the re-run are on the card, not here.
 */
function Row({ a }: { a: AskedAlert }) {
  const tone = a.ok ? "var(--success)" : "var(--error)";
  const ink = a.ok ? "var(--success-ink)" : "var(--error-ink)";
  const first = primaryAction(a.payload);
  const to = first ? actionTarget(first) : null;
  const { verdict, object } = splitTitle(a.payload.title);
  return (
    <motion.div
      layout
      role="alert"
      tabIndex={0}
      {...MOTION}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeAsked(a.id, false); } }}
      className="flex items-center gap-2 rounded-lg w-full pl-3 pr-1.5"
      style={{
        pointerEvents: "auto", height: ROW_H,
        background: "var(--surface-card)",
        borderWidth: 1, borderStyle: "solid", borderColor: `color-mix(in srgb, ${tone} 45%, var(--border))`,
        boxShadow: "0 10px 24px -16px var(--shadow)",
      }}
    >
      <span className="shrink-0" style={{ color: ink }}><Verdict ok={a.ok} size={ICON.sm} /></span>
      <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>
        <span style={{ color: ink }}>{verdict}</span>{object}
      </span>
      {to && (
        <button type="button" className="rounded-md px-2.5 text-[11.5px] font-semibold whitespace-nowrap"
          style={{ height: HIT - 2, background: ink, color: "var(--bg)", cursor: "pointer" }}
          onClick={() => { closeAsked(a.id, true); openTarget(to); }}>Open</button>
      )}
      <CloseButton onClick={() => closeAsked(a.id, false)} title="Close" className="agx-note-btn agx-note-icon shrink-0" />
    </motion.div>
  );
}

function Banner({ a }: { a: AskedAlert }) {
  const tone = a.ok ? "var(--success)" : "var(--error)";
  const ink = a.ok ? "var(--success-ink)" : "var(--error-ink)";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const primary = primaryAction(a.payload);
  const secondary = secondaryAction(a.payload);
  const { verdict, object } = splitTitle(a.payload.title);

  const act = async (x: NotifyAction) => {
    const to = actionTarget(x);
    if (to) { closeAsked(a.id, true); openTarget(to); return; }
    if (!("run" in x)) return;
    setBusy(true); setErr("");
    const r = await api.prRerun(x.root, x.number).catch((e: unknown) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) closeAsked(a.id, true);
    else setErr(r.error || "GitHub would not re-run the failed checks");
  };

  return (
    <motion.div
      layout
      role="alert"
      tabIndex={0}
      {...MOTION}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeAsked(a.id, false); } }}
      className="flex gap-3 rounded-xl w-full overflow-hidden"
      style={{
        pointerEvents: "auto",
        padding: "14px 10px 14px 0",
        background: "var(--surface-card)",
        // The verdict tints the edge: the one border here that is not the house pair.
        borderWidth: 1, borderStyle: "solid", borderColor: `color-mix(in srgb, ${tone} 45%, var(--border))`,
        boxShadow: `0 14px 34px -14px color-mix(in srgb, ${tone} 55%, transparent), 0 22px 48px -20px var(--shadow)`,
      }}
    >
      <span aria-hidden className="shrink-0 self-stretch" style={{ width: 6, background: tone, borderRadius: "0 4px 4px 0" }} />
      <span className="grid place-items-center rounded-full shrink-0 self-start" aria-hidden
        style={{ width: 34, height: 34, color: ink, background: `color-mix(in srgb, ${tone} 16%, transparent)` }}>
        <Verdict ok={a.ok} />
      </span>
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="text-[16px] font-bold leading-snug" style={{ overflowWrap: "anywhere", color: "var(--text)" }}>
          <span style={{ color: ink }}>{verdict}</span>{object}
        </span>
        {a.payload.line && (
          <span className="text-[13px] leading-snug mt-0.5 truncate" style={{ color: "var(--text2)" }} title={a.payload.line}>{a.payload.line}</span>
        )}
        <span className="flex gap-2.5 flex-wrap mt-1.5 text-[11px]" style={{ color: "var(--text3)" }}>
          {(a.payload.facts ?? []).map((f) => <span key={f}>{f}</span>)}
          <span>{minutesAgo(a.firedAt)}</span>
        </span>
        {(primary || secondary) && (
          <span className="flex items-center gap-2 flex-wrap mt-2.5">
            {primary && (
              <button type="button" className="rounded-md px-3 text-[12px] font-semibold whitespace-nowrap" disabled={busy}
                style={{ height: HIT + 2, background: ink, color: "var(--bg)", cursor: "pointer" }}
                onClick={() => void act(primary)}>{primary.label}</button>
            )}
            {secondary && (
              <button type="button" className="rounded-md px-3 text-[12px] font-semibold whitespace-nowrap" disabled={busy}
                style={{ height: HIT + 2, background: "var(--surface-card)", color: "var(--text)", border: EDGE, cursor: "pointer" }}
                onClick={() => void act(secondary)}>{busy ? "Re-running…" : secondary.label}</button>
            )}
          </span>
        )}
        {err && <span className="text-[11.5px] mt-1.5" style={{ color: "var(--error-ink)" }}>{err}</span>}
      </div>
      <CloseButton onClick={() => closeAsked(a.id, false)} title="Close" className="agx-note-btn agx-note-icon shrink-0 self-start" />
    </motion.div>
  );
}

export function AskedBanners() {
  const list = useAskedBanners();

  // What the server kept while this window was closed is read when the socket opens, and what it raises while
  // open arrives as a frame: both in useLive.ts.
  const { shown, more } = layoutBanners(list);
  if (!shown.length) return null;
  return (
    <Portal z={10045}>
      <div
        className="fixed flex flex-col items-center gap-1.5"
        style={{ top: TOP_BAR_H + 10, left: "50%", transform: "translateX(-50%)", width: "min(620px, calc(100vw - 32px))", pointerEvents: "none" }}
      >
        <AnimatePresence initial={false}>
          {shown.map((a, i) => (i === 0 ? <Banner key={a.id} a={a} /> : <Row key={a.id} a={a} />))}
        </AnimatePresence>
        {more > 0 && (
          <span className="text-[11px] rounded-full px-2.5 py-0.5"
            style={{ pointerEvents: "auto", color: "var(--text3)", background: "var(--surface-card)", border: EDGE }}>
            +{more} more alert{more > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </Portal>
  );
}
