/*
 * The tutorial, and the toast that offers it.
 *
 * A centred card over the dimmed app: five cards listed left, the open one
 * right, and three ways out. A card is written as seen when it is LEFT, never
 * when it is shown; `×`, Escape and `Not now` write nothing, so the offer
 * returns at the next finish. Focus starts inside and Escape closes this one.
 */
import { useEffect, useRef, useState } from "react";
import { ICON } from "../../lib/iconSize.ts";
import { DoneIcon } from "../../lib/glyphIcons.tsx";
import { LAYER } from "../../lib/layers.ts";
import {
  TUTORIAL_CARDS, cardAfter, markAllSeen, markSeen, saveSeen, seenCards,
  closeTutorial, subscribeTutorial, tutorialOpen,
} from "../../lib/setupTutorial.ts";

export function Tutorial({ seen, onSeen }: {
  seen: string;
  /** What the app should remember after a write, so Get started agrees. */
  onSeen: (list: string) => void;
}) {
  const [open, setOpen] = useState(() => tutorialOpen());
  const read = useRef(seen);
  read.current = seen;
  const [current, setCurrent] = useState(() => TUTORIAL_CARDS[0]!.id);
  const next = useRef<HTMLButtonElement | null>(null);

  useEffect(() => subscribeTutorial(() => {
    setOpen(tutorialOpen());
    if (tutorialOpen()) {
      const first = TUTORIAL_CARDS.find((c) => !seenCards(read.current).includes(c.id)) ?? TUTORIAL_CARDS[0]!;
      setCurrent(first.id);
    }
  }), []);

  const shut = () => closeTutorial();

  useEffect(() => {
    if (!open) return;
    next.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // The innermost thing open: this dialog, before anything behind it.
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      shut();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const card = TUTORIAL_CARDS.find((c) => c.id === current) ?? TUTORIAL_CARDS[0]!;
  const at = TUTORIAL_CARDS.findIndex((c) => c.id === card.id);
  const seenNow = seenCards(seen);
  const n = seenNow.length;

  const leave = (to: string | null) => {
    const list = markSeen(seen, card.id);
    saveSeen(list);
    onSeen(list);
    if (to) setCurrent(to);
    else shut();
  };
  const allSeen = () => {
    const list = markAllSeen();
    saveSeen(list);
    onSeen(list);
    shut();
  };

  return (
    <div className="tut-scrim" style={{ zIndex: LAYER.settings + 5 }} onMouseDown={(e) => { if (e.target === e.currentTarget) shut(); }}>
      <div className="tut" role="dialog" aria-modal="true" aria-label="Tutorial">
        <div className="tut-head">
          <span className="tut-title">Tutorial</span>
          <span className="tut-where">card {at + 1} of {TUTORIAL_CARDS.length} · two minutes</span>
          <span className="setup-grow" />
          <button type="button" className="setup-btn setup-btn-quiet setup-btn-xs" onClick={allSeen}>
            Skip tutorial
          </button>
          <button type="button" className="setup-icon-btn" aria-label="Close" onClick={shut}><X /></button>
        </div>
        <div className="tut-body">
          <div className="tut-list" role="tablist" aria-label="The five cards" aria-orientation="vertical">
            {TUTORIAL_CARDS.map((c, i) => {
              const state = c.id === card.id ? "on" : seenNow.includes(c.id) ? "done" : "next";
              return (
                <button type="button" key={c.id} className="tut-item" role="tab" data-state={state}
                  aria-selected={c.id === card.id} onClick={() => { if (c.id !== card.id) leave(c.id); }}>
                  <span className="tut-n" aria-hidden="true">{state === "done" ? <DoneIcon size={ICON.xs} /> : i + 1}</span>
                  {c.title}
                </button>
              );
            })}
          </div>
          <div className="tut-detail">
            <div className="setup-eyebrow">Card {at + 1} of {TUTORIAL_CARDS.length}</div>
            <h2 className="tut-h2">{card.title}</h2>
            {card.body.map((p) => <p key={p}>{p}</p>)}
            <TutorialArt id={card.id} />
          </div>
        </div>
        <div className="tut-foot">
          <button type="button" className="setup-btn setup-btn-quiet" onClick={allSeen}>I have seen these before</button>
          <span className="setup-grow" />
          <span className="setup-hint tut-said">{n} of {TUTORIAL_CARDS.length} read. Leaving here keeps the card in Get started.</span>
          <button type="button" ref={next} className="setup-btn setup-btn-secondary"
            onClick={() => (at === TUTORIAL_CARDS.length - 1 ? leave(null) : leave(cardAfter(card.id)))}>
            {at === TUTORIAL_CARDS.length - 1 ? "Done" : "Next card"} <Arrow />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The offer after a finish. `left` is the count the server's seen list gives. */
export function SetupOffer({ left, onShow, onDismiss }: {
  left: number;
  onShow: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="setup-offer" role="status">
      <div className="setup-offer-title">Setup finished · {left} {left === 1 ? "card" : "cards"} left</div>
      <div className="setup-offer-body">
        The terminal, pull requests, tasks, agents and Polaris. Two minutes, and it closes where you left it.
      </div>
      <div className="setup-offer-acts">
        <button type="button" className="setup-btn setup-btn-primary setup-btn-xs" onClick={onShow}>Show me</button>
        <button type="button" className="setup-btn setup-btn-secondary setup-btn-xs" onClick={onDismiss}>Not now</button>
      </div>
    </div>
  );
}

function TutorialArt({ id }: { id: string }) {
  if (id === "terminal") {
    return (
      <div className="tut-art setup-preview" aria-hidden="true">
        <div className="setup-preview-bar"><Term /> acme/orbit · main <span className="setup-grow" />
          <span className="setup-badge setup-badge-ok">agent working</span></div>
        <div className="setup-preview-screen">
          <div className="setup-preview-dim">~/code/acme/orbit  main ~ $ claude</div>
          <div className="setup-preview-dim">✻ reading src/orbit/route.ts</div>
          <div className="setup-preview-ok"><DoneIcon size={ICON.xs} /> 2 files changed</div>
          <div className="setup-preview-blue">&gt; <span className="setup-preview-cursor" /></div>
        </div>
      </div>
    );
  }
  if (id === "pull-requests") {
    return (
      <div className="tut-art tut-art-card" aria-hidden="true">
        <div className="tut-art-head"><b>acme/orbit #412</b><span>Review requested</span><span className="setup-badge setup-badge-ok">checks 6/6</span></div>
        <div className="tut-art-body">ORBIT-1042 · Carry the leg's window into the route summary</div>
      </div>
    );
  }
  if (id === "tasks") {
    return (
      <div className="tut-art tut-art-card" aria-hidden="true">
        <div className="tut-art-head"><b>ORBIT-1042</b><span>In progress</span><span className="setup-badge setup-badge-off">acme/orbit</span></div>
        <div className="tut-art-body">Carry the leg's window into the route summary. Hand-off: branch <code>orbit/1042</code>, agent Claude Code.</div>
      </div>
    );
  }
  if (id === "agents") {
    return (
      <div className="tut-art tut-art-card" aria-hidden="true">
        {[
          { n: "main · acme/orbit", s: "Claude Code", l: "writing" },
          { n: "worker 1 · ORBIT-1042", s: "OpenCode", l: "waiting on you" },
          { n: "worker 2 · #412", s: "Claude Code", l: "idle" },
        ].map((a) => (
          <div className="tut-art-row" key={a.n}>
            <span className="tut-art-tile">{a.s[0]}</span>
            <span><span className="tut-art-name">{a.n}</span><span className="tut-art-sub">{a.s} · {a.l}</span></span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="tut-art tut-art-card" aria-hidden="true">
      <div className="tut-art-row">
        <span className="tut-art-tile" data-tone="warn">P</span>
        <span><span className="tut-art-name">Polaris is off</span>
          <span className="tut-art-sub">Watching nothing. When on, it reads and never writes without asking.</span></span>
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
function Arrow() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.8 8h10" /><path d="M9 4.2 12.8 8 9 11.8" />
    </svg>
  );
}
function Term() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.4 4.4 6 8l-3.6 3.6" /><path d="M8 11.6h5.6" />
    </svg>
  );
}
