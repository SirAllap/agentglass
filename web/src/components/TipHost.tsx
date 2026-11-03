/*
 * The one tooltip. Elements on the pull-request view carry `data-tip` (see
 * lib/tip.ts for the attribute and the rules); this host listens once, on the
 * document, and draws the dark card for whichever one the pointer or the
 * keyboard is on. It closes on leave, blur, click, scroll and Escape, and it is
 * never the browser's own: the elements it serves have no `title`.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { Portal } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { ICON } from "../lib/iconSize.ts";
import { CrossIcon, DoneIcon, TagIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { placeTip, readTip, tipDelay, TIP_DELAY_MS, TIP_QUICK_MS, type TipSpec } from "../lib/tip.ts";
import type { ChainTip } from "../lib/chainTip.ts";

const SELECTOR = "[data-tip]";

export function TipBody({ spec }: { spec: TipSpec }) {
  return (
    <>
      <div className="agx-tip-1">
        <b data-mono={spec.mono ? "1" : undefined}>{spec.name}</b>
        {spec.detail && <span className="agx-tip-m">{spec.detail}</span>}
        {spec.tag && <span className="agx-tip-tg">{spec.tag}</span>}
        {/* A number is measured or estimated. "Proposed" is a note about the
            engine, not a fact about the reading, and it belongs in the plan
            rather than on the card. */}
        {spec.trust && spec.trust !== "proposed" && <span className="agx-tip-tr" data-trust={spec.trust}>{spec.trust}</span>}
      </div>
      {spec.chain && <ChainTipBody tip={spec.chain} />}
      {(spec.from || spec.how || spec.caveat) && (
        <dl className="agx-tip-dl">
          {spec.from && <><dt>From</dt><dd>{spec.from}</dd></>}
          {spec.how && <><dt>How</dt><dd>{spec.how}</dd></>}
          {spec.caveat && <><dt>Caveat</dt><dd>{spec.caveat}</dd></>}
        </dl>
      )}
      {spec.rows && spec.rows.length > 0 && (
        <dl className="agx-tip-dl" data-rows="1">{spec.rows.map((r) => <Fragment key={r.k}><dt>{r.k}</dt><dd>{r.v}</dd></Fragment>)}</dl>
      )}
      {spec.text && (
        <div className="agx-tip-2">
          {spec.dot && <i className="agx-tip-dot" style={{ background: spec.dot }} />}{spec.text}
        </div>
      )}
      {spec.pills && spec.pills.length > 0 && (
        <div className="agx-tip-pl">{spec.pills.map((l) => <span key={l}><TagIcon size={ICON.xs} />{l}</span>)}</div>
      )}
      {spec.hint && (
        <div className="agx-tip-3">
          {spec.hint.key && <kbd>{spec.hint.key}</kbd>}{spec.hint.text}
          {spec.hint.right && <span className="agx-tip-r">{spec.hint.right}</span>}
        </div>
      )}
    </>
  );
}

export function ChainTipBody({ tip }: { tip: ChainTip }) {
  return (
    <>
      <div className="agx-tip-sec">In this order</div>
      <div className="agx-tip-ladder" data-scroll={tip.scrolls ? "1" : undefined}>
        {tip.steps.map((s, i) => (
          <Fragment key={s.n}>
            {i > 0 && <div className="agx-tip-gap">{i === 1 ? tip.gap : tip.gapThen}</div>}
            <div className="agx-tip-step" data-now={s.now ? "1" : undefined}>
              <span className="agx-tip-num" aria-hidden="true">{s.n}</span>
              <span className="agx-tip-eg" aria-hidden="true">{s.engine.slice(0, 1)}</span>
              <span className="agx-tip-mdl"><small>{s.engine}{s.main ? " · Main" : ""}</small><span>{s.model}</span></span>
              <span className="agx-tip-tag" data-kind={s.now ? "now" : s.main ? "main" : "fb"}>{s.tag}</span>
            </div>
          </Fragment>
        ))}
      </div>
      {tip.noFallback && <p className="agx-tip-why" data-kind="none">{tip.noFallback}</p>}
      {tip.why && <p className="agx-tip-why"><WarningIcon size={ICON.xs} /><span>{tip.why}</span></p>}
      {tip.rounds && (
        <>
          <div className="agx-tip-sec">Rounds</div>
          <div className="agx-tip-tries">
            {tip.rounds.dots.map((on, i) => <i key={i} data-on={on ? "1" : undefined} />)}
            <span>{tip.rounds.word}</span>
          </div>
        </>
      )}
      <div className="agx-tip-sec">Then</div>
      <div className="agx-tip-after">
        <span data-kind="pass"><DoneIcon size={ICON.xs} />passes to {tip.pass}</span>
        <span data-kind="fail"><CrossIcon size={ICON.xs} />fails to {tip.fail}</span>
      </div>
      <div className="agx-tip-sec">Settings</div>
      <div className="agx-tip-switch">
        <span>Ask when it runs</span>
        <span data-on={tip.ask ? "1" : undefined}><i aria-hidden="true" />{tip.askWord}</span>
      </div>
      <div className="agx-tip-foot">{tip.footer}</div>
    </>
  );
}

export function TipHost() {
  const [shown, setShown] = useState<{ spec: TipSpec; rect: DOMRect; instant: boolean } | null>(null);
  const [at, setAt] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const state = useRef({ timer: 0, open: false, closedAt: 0, el: null as Element | null, muted: null as Element | null });

  useEffect(() => {
    const s = state.current;
    const hide = () => {
      window.clearTimeout(s.timer);
      if (s.open) s.closedAt = Date.now();
      s.open = false;
      setShown(null);
      setAt(null);
    };
    /* A tip for a whole panel is drawn at the pointer: above a 600 px panel it landed on the neighbours, far from where the person was looking. */
    const BIG = 180;
    const arm = (el: Element, ms: number, at?: { x: number; y: number }) => {
      window.clearTimeout(s.timer);
      if (el === s.muted) return;
      s.timer = window.setTimeout(() => {
        const attr = el.getAttribute("data-tip");
        if (s.el !== el || s.open || !attr) return;
        s.open = true;
        setAt(null);
        const box = el.getBoundingClientRect();
        const rect = at && (box.height > BIG || box.width > BIG * 3) ? new DOMRect(at.x, at.y, 1, 1) : box;
        setShown({ spec: readTip(attr), rect, instant: ms <= TIP_QUICK_MS });
      }, ms);
    };
    const enter = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.(SELECTOR);
      /* Crossing into a child of the target it is already on never restarts it. */
      if (!el || el === s.el) return;
      hide();
      s.el = el;
      s.muted = null;
      arm(el, tipDelay(e.type === "focusin", Date.now() - s.closedAt), e instanceof MouseEvent ? { x: e.clientX, y: e.clientY } : undefined);
    };
    const leave = (e: MouseEvent) => {
      if (!s.el || (e.relatedTarget instanceof Node && s.el.contains(e.relatedTarget))) return;
      hide();
      s.el = null;
      s.muted = null;
    };
    const rest = () => { if (s.el && !s.open) arm(s.el, TIP_DELAY_MS); };
    /* Closed by a click, a scroll or Escape: it stays closed until the pointer leaves and comes back. */
    const dismiss = () => { hide(); s.muted = s.el; };
    /* Only a scroll that moves the target closes it: the live feed scrolls itself on every event, and closed every card on the screen. */
    const scrolled = (e: Event) => { const t = e.target; if (s.el && t instanceof Node && t !== document && !t.contains(s.el)) return; dismiss(); };
    const blur = () => { hide(); s.el = null; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    document.addEventListener("mouseover", enter);
    document.addEventListener("focusin", enter);
    document.addEventListener("mouseout", leave);
    document.addEventListener("focusout", blur);
    document.addEventListener("mousemove", rest);
    document.addEventListener("click", dismiss, true);
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("keydown", esc);
    return () => {
      window.clearTimeout(s.timer);
      document.removeEventListener("mouseover", enter);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("mouseout", leave);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("mousemove", rest);
      document.removeEventListener("click", dismiss, true);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("keydown", esc);
    };
  }, []);

  /* Measured once the card exists AND is in the document: its height depends on what it says. A layout effect ran before
     the Portal had appended its element to the body, so the card measured 0 x 0 and every tip sat at its target's centre,
     past the window edge. Portal's own effect is a child's and runs first, so this one (a parent's) sees the real size. */
  useEffect(() => {
    if (!shown || !card.current) return;
    const r = shown.rect;
    setAt(placeTip({ left: r.left, top: r.top, width: r.width, height: r.height }, { w: card.current.offsetWidth, h: card.current.offsetHeight }, window.innerWidth, window.innerHeight));
  }, [shown]);

  if (!shown) return null;
  return (
    <Portal z={LAYER.menu}>
      <div ref={card} role="tooltip" className="agx-tip" data-chain={shown.spec.chain ? "1" : undefined} data-on={at ? "1" : undefined} data-instant={shown.instant ? "1" : undefined}
        style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? "visible" : "hidden" }}>
        <TipBody spec={shown.spec} />
      </div>
    </Portal>
  );
}
