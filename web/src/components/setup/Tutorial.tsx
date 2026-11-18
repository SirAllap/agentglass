/*
 * The tour, and the toast that offers it.
 *
 * Five steps on the real app. Each one switches to its view when that view is
 * not on screen, cuts a hole in the dim around the real control and sets a
 * coach card beside it. A step is written as seen when it is LEFT, never when
 * it is shown; `Skip tour`, `×` and Escape write nothing new, so Resume opens
 * the first step not seen. Focus starts on Next and Escape closes this one.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ICON } from "../../lib/iconSize.ts";
import { LAYER } from "../../lib/layers.ts";
import { api } from "../../lib/api.ts";
import { closeSettings, openSettings } from "../../lib/openSettings.ts";
import { VIEWS, isVisibleView, type ViewId } from "../workspace/views.ts";
import {
  cardAfter, markSeen, resumeIndex, saveSeen, seenCards, stepPlan, tourSteps, tutorialOffer,
  closeTutorial, subscribeTutorial, tutorialOpen, tutorialStart,
} from "../../lib/setupTutorial.ts";

/** The Browser view is on this build and on the rail; the tour never moves the rail. */
const browserOn = () => VIEWS.some((v) => v.id === "browser") && isVisibleView("browser");

/** The Finish offer for the steps this tour will really show: App and SetupOffer both ask this, so the
 *  count that hides the finish note is the count the offer draws. */
/** The steps whose view the rail still draws: the one list App, Settings and the tour agree on. */
export const tourNow = () => tourSteps({ browser: browserOn(), shown: isVisibleView });

export const setupOfferNow = (seen: string) => tutorialOffer(seen, tourNow());

export function Tutorial({ seen, onSeen, view, onView }: {
  seen: string;
  /** What the app should remember after a write, so Settings ▸ About agrees. */
  onSeen: (list: string) => void;
  /** The view on screen, and how to switch it. */
  view: ViewId | null;
  onView: (v: ViewId) => void;
}) {
  const [open, setOpen] = useState(() => tutorialOpen());
  const read = useRef(seen);
  read.current = seen;
  const [at, setAt] = useState(0);
  const [jira, setJira] = useState<boolean | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const next = useRef<HTMLButtonElement | null>(null);
  const steps = tourNow();

  useEffect(() => subscribeTutorial(() => {
    setOpen(tutorialOpen());
    if (!tutorialOpen()) return;
    // The tour points at the app itself, so Settings steps aside first.
    closeSettings();
    const want = tutorialStart();
    setAt(want >= 0 ? want : resumeIndex(read.current, tourNow()));
    setJira(null);
    void api.jiraStatus().then((s) => setJira(!!s.connected)).catch(() => setJira(false));
  }), []);

  const shut = () => closeTutorial();

  const card = steps[Math.min(at, steps.length - 1)]!;
  const plan = jira == null ? null : stepPlan(card, { browser: browserOn(), jira, view });

  // Switch first, then find the control. The hole follows it while it moves.
  useEffect(() => {
    if (!open || !plan) return;
    if (plan.switchTo) { onView(plan.switchTo); return; }
    if (!plan.target) { setRect(null); return; }
    let el: HTMLElement | null = null;
    let tries = 0;
    let frame = 0;
    const place = () => { if (el) setRect(el.getBoundingClientRect()); };
    const ro = new ResizeObserver(place);
    const find = () => {
      el = document.querySelector<HTMLElement>(plan.target!);
      if (el) { el.scrollIntoView({ block: "nearest", inline: "nearest" }); place(); ro.observe(el); return; }
      // A view mounts over a few frames; give it about one second, then centre the card.
      if (++tries < 60) frame = requestAnimationFrame(find);
      else setRect(null);
    };
    find();
    window.addEventListener("resize", place);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); window.removeEventListener("resize", place); };
  }, [open, card.id, plan?.switchTo, plan?.target]);

  // Give focus back to what had it before the tour, when the tour shuts.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (before?.isConnected) before.focus(); };
  }, [open]);

  // Next takes focus once the card is drawn: on open the plan waits for Jira's answer.
  const drawn = plan != null;
  useEffect(() => {
    if (!open) return;
    next.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // The innermost thing open: this tour, before anything behind it.
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      shut();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, at, drawn]);

  if (!open || !plan) return null;

  const last = at >= steps.length - 1;
  const leave = (to: number | null) => {
    const list = markSeen(read.current, card.id);
    saveSeen(list);
    onSeen(list);
    if (to == null) shut();
    else setAt(to);
  };
  const after = cardAfter(card.id, steps);
  const seenNow = seenCards(seen);

  return (
    <div className="tour" style={{ zIndex: LAYER.settings + 5 }}>
      {rect
        ? <div className="tour-hole" aria-hidden="true" style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }} />
        : <div className="tour-dim" aria-hidden="true" />}
      <div className="tour-coach" role="dialog" aria-label={`Tour, step ${at + 1} of ${steps.length}`} style={coachAt(rect)}>
        <div className="tour-pips" aria-hidden="true">
          {steps.map((c, i) => <i key={c.id} data-on={i <= at || seenNow.includes(c.id) ? "" : undefined} />)}
        </div>
        <div className="tour-top">
          <b>{card.title}</b>
          <span className="tour-of">{at + 1} of {steps.length}</span>
          <button type="button" className="setup-icon-btn" aria-label="Close tour" onClick={shut}><X /></button>
        </div>
        {plan.body.map((p) => <p key={p}>{p}</p>)}
        <div className="tour-acts">
          {!last && <button type="button" className="setup-btn setup-btn-quiet setup-btn-xs" onClick={shut}>Skip tour</button>}
          {plan.settings && (
            <button type="button" className="setup-btn setup-btn-secondary setup-btn-xs"
              onClick={() => { shut(); openSettings(plan.settings!); }}>Open Connections</button>
          )}
          <span className="setup-grow" />
          {at > 0 && <button type="button" className="setup-btn setup-btn-secondary setup-btn-xs" onClick={() => leave(at - 1)}>Back</button>}
          <button type="button" ref={next} className="setup-btn setup-btn-primary setup-btn-xs"
            onClick={() => leave(last || after == null ? null : at + 1)}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The coach beside the control: right of it when it fits, else below, else centred. */
function coachAt(r: DOMRect | null): CSSProperties {
  const W = 280, GAP = 12, vw = window.innerWidth, vh = window.innerHeight;
  if (!r) return { left: Math.max(16, (vw - W) / 2), top: Math.max(16, vh / 3) };
  const clampTop = (t: number) => Math.min(Math.max(16, t), vh - 200);
  if (r.right + GAP + W <= vw - 16) return { left: r.right + GAP, top: clampTop(r.top) };
  if (r.bottom + GAP + 180 <= vh) return { left: Math.min(Math.max(16, r.left), vw - W - 16), top: r.bottom + GAP };
  return { left: Math.min(Math.max(16, r.left - W - GAP), vw - W - 16), top: clampTop(r.top) };
}

/** The toast after a finish. It reads the seen list, and is absent when nothing is left. */
export function SetupOffer({ seen, onShow, onDismiss }: {
  seen: string;
  onShow: () => void;
  onDismiss: () => void;
}) {
  const offer = setupOfferNow(seen);
  if (!offer) return null;
  return (
    <div className="setup-offer" role="status">
      <div className="setup-offer-title">{offer.title}</div>
      <div className="setup-offer-body">{offer.body}</div>
      <div className="setup-offer-acts">
        <button type="button" className="setup-btn setup-btn-primary setup-btn-xs" onClick={onShow}>Show me</button>
        <button type="button" className="setup-btn setup-btn-secondary setup-btn-xs" onClick={onDismiss}>Not now</button>
      </div>
    </div>
  );
}

function X() {
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
  );
}
